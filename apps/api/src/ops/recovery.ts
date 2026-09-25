import { createHash } from "node:crypto";
import { presentAuditEvent, readInvoiceActivity } from "@api/services/activity";
import type { Database } from "@invoicewise/db/client";
import {
  type AuditEventInput,
  type OperatorJob,
  type OperatorJobFilter,
  getOperatorJob,
  listOperatorAuditEvents,
  listOperatorJobs,
  settleAuditEvent,
  startAuditEvent,
} from "@invoicewise/db/queries";
import { inbox } from "@invoicewise/db/schema";
import { redactOptionalText } from "@invoicewise/db/utils/redact";
import {
  cancelJobAsOperator,
  retryJobAsOperator,
} from "@invoicewise/jobs/operator-recovery";
import { eq } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { isOperatorAuthorized } from "./route";

/**
 * Operator diagnosis and recovery (docs/operations.md#recovery).
 *
 * Operator authority is separate from every customer role: these routes
 * accept only `Authorization: Bearer $OPS_TOKEN` (never a session, API key
 * or OAuth token) and do not exist when no token is configured. Each request
 * names its operator (`X-Operator`), a declared name the shared token does
 * not authenticate, so each record also carries the token's fingerprint; an
 * action or any access to a
 * workspace's records also states a purpose and a reason, and is written to
 * that workspace's audit trail, where its owners and admins see it.
 *
 * Job views carry identifiers, statuses, times and redacted errors only;
 * never a job payload, document contents or extracted values.
 */

const noStore = { "cache-control": "no-store" };

const OPERATOR_NAME = /^[A-Za-z0-9._@-]{2,64}$/;

export const OPERATOR_PURPOSES = ["incident", "support", "security"] as const;

const actionSchema = z.object({
  purpose: z.enum(OPERATOR_PURPOSES),
  reason: z.string().trim().min(5).max(200),
});

const listSchema = z.object({
  filter: z
    .enum(["stuck", "failed", "overdue", "queued", "running"])
    .default("stuck"),
  workflow: z
    .string()
    .regex(/^[a-z-]{2,64}$/)
    .optional(),
  teamId: z.string().uuid().optional(),
  overdueMinutes: z.coerce.number().int().min(1).max(1440).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const uuid = z.string().uuid();

/** The job as an operator sees it: no payload, the error redacted. */
export const presentOperatorJob = (
  job: NonNullable<OperatorJob>,
  now = Date.now(),
) => ({
  id: job.id,
  workflow: job.name,
  teamId: job.teamId,
  status: job.status,
  attempts: job.attempts,
  maxAttempts: job.maxAttempts,
  runAt: job.runAt,
  lockedBy: job.lockedBy,
  heartbeatAt: job.heartbeatAt,
  leaseExpiresAt: job.leaseExpiresAt,
  stuck:
    job.status === "running" &&
    !!job.leaseExpiresAt &&
    new Date(job.leaseExpiresAt).getTime() < now,
  finishedAt: job.finishedAt,
  lastError: redactOptionalText(job.lastError),
  createdAt: job.createdAt,
  updatedAt: job.updatedAt,
  subject: job.subject ?? {},
});

/** What an operator action on a job is about, for the audit trail. */
const jobTarget = (job: NonNullable<OperatorJob>) => {
  const subject = job.subject ?? {};
  const invoiceId = subject.inboxId ?? subject.invoiceId;
  return typeof invoiceId === "string"
    ? { targetType: "invoice", targetId: invoiceId }
    : { targetType: "job", targetId: job.id };
};

const log = (event: Record<string, unknown>) =>
  console.log(JSON.stringify({ event: "ops_action", ...event }));

type Operator = { name: string; tokenFingerprint: string };

/** A non-secret identifier of the operator token: 8 hex of its SHA-256. */
export const operatorTokenFingerprint = (token: string) =>
  createHash("sha256").update(token).digest("hex").slice(0, 8);

export function registerOperatorRoutes(
  app: Hono<any>,
  deps: { db: Database; env?: Record<string, string | undefined> },
) {
  const env = deps.env ?? process.env;

  /**
   * Authorizes an operator request: 404 when operator access is not
   * configured, 401 without the operator token, 400 without an operator
   * name. Customer credentials never pass.
   */
  const authorize = (
    c: Context,
  ): { operator: Operator } | { response: Response } => {
    if (!env.OPS_TOKEN) return { response: c.notFound() as Response };
    if (!isOperatorAuthorized(c.req.header("authorization"), env.OPS_TOKEN)) {
      console.warn(
        JSON.stringify({
          event: "ops_denied",
          method: c.req.method,
          path: c.req.path.replace(/[0-9a-f-]{36}/gi, ":id"),
        }),
      );
      return {
        response: c.json({ error: "Unauthorized" }, 401, noStore),
      };
    }
    const name = c.req.header("x-operator")?.trim() ?? "";
    if (!OPERATOR_NAME.test(name)) {
      return {
        response: c.json(
          {
            error:
              "Name the operator in the X-Operator header (2-64 letters, digits, . _ @ -)",
          },
          400,
          noStore,
        ),
      };
    }
    return {
      operator: {
        name,
        tokenFingerprint: operatorTokenFingerprint(env.OPS_TOKEN),
      },
    };
  };

  const audit = (
    operator: Operator,
    input: Omit<AuditEventInput, "actor" | "surface" | "category">,
  ) =>
    startAuditEvent(deps.db, {
      ...input,
      detail: { ...input.detail, tokenFingerprint: operator.tokenFingerprint },
      actor: { type: "operator", ref: operator.name },
      surface: "ops",
      category: "operator",
    });

  app.get("/ops/jobs", async (c) => {
    const auth = authorize(c);
    if ("response" in auth) return auth.response;
    const query = listSchema.safeParse(c.req.query());
    if (!query.success) {
      return c.json(
        { error: "Invalid filter", issues: query.error.issues },
        400,
        noStore,
      );
    }
    const jobs = await listOperatorJobs(deps.db, {
      filter: query.data.filter as OperatorJobFilter,
      workflow: query.data.workflow,
      teamId: query.data.teamId,
      overdueMs: query.data.overdueMinutes
        ? query.data.overdueMinutes * 60_000
        : undefined,
      limit: query.data.limit,
    });
    const now = Date.now();
    return c.json(
      {
        filter: query.data.filter,
        data: jobs.map((job) => presentOperatorJob(job, now)),
      },
      200,
      noStore,
    );
  });

  app.get("/ops/jobs/:id", async (c) => {
    const auth = authorize(c);
    if ("response" in auth) return auth.response;
    const id = uuid.safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: "Invalid job ID" }, 400, noStore);
    const job = await getOperatorJob(deps.db, { id: id.data });
    return job
      ? c.json(presentOperatorJob(job), 200, noStore)
      : c.json({ error: "Job not found" }, 404, noStore);
  });

  for (const action of ["retry", "cancel"] as const) {
    app.post(`/ops/jobs/:id/${action}`, async (c) => {
      const auth = authorize(c);
      if ("response" in auth) return auth.response;
      const id = uuid.safeParse(c.req.param("id"));
      if (!id.success) return c.json({ error: "Invalid job ID" }, 400, noStore);
      const body = actionSchema.safeParse(await c.req.json().catch(() => null));
      if (!body.success) {
        return c.json(
          {
            error: `State a purpose (${OPERATOR_PURPOSES.join(", ")}) and a reason (5-200 characters)`,
          },
          400,
          noStore,
        );
      }
      const job = await getOperatorJob(deps.db, { id: id.data });
      if (!job) return c.json({ error: "Job not found" }, 404, noStore);

      const started = await audit(auth.operator, {
        teamId: job.teamId,
        action:
          action === "retry" ? "operator.job_retry" : "operator.job_cancel",
        ...jobTarget(job),
        purpose: body.data.purpose,
        detail: {
          jobId: job.id,
          workflow: job.name,
          jobStatus: job.status,
          attempts: job.attempts,
          reason: body.data.reason,
        },
      });

      let result: Awaited<
        ReturnType<typeof retryJobAsOperator | typeof cancelJobAsOperator>
      >;
      try {
        result =
          action === "retry"
            ? await retryJobAsOperator(deps.db, job)
            : await cancelJobAsOperator(deps.db, job, body.data.reason);
      } catch (error) {
        await settleAuditEvent(deps.db, {
          id: started.id,
          outcome: "failed",
        }).catch(() => undefined);
        log({
          operator: auth.operator.name,
          tokenFingerprint: auth.operator.tokenFingerprint,
          action,
          jobId: job.id,
          result: "error",
          error: redactOptionalText(
            error instanceof Error ? error.message : "unknown",
          ),
        });
        return c.json(
          { error: "The action failed", auditEventId: started.id },
          500,
          noStore,
        );
      }
      const done =
        result.status === "requeued" || result.status === "cancelled";
      await settleAuditEvent(deps.db, {
        id: started.id,
        outcome: done ? "succeeded" : "refused",
        detail: {
          result: result.status,
          ...("detail" in result ? result.detail : {}),
          ...("reason" in result ? { error: result.reason } : {}),
          ...("guidance" in result ? { error: result.guidance } : {}),
          ...("jobStatus" in result
            ? { error: `The job is ${result.jobStatus}` }
            : {}),
        },
      });
      log({
        operator: auth.operator.name,
        tokenFingerprint: auth.operator.tokenFingerprint,
        action,
        jobId: job.id,
        workflow: job.name,
        result: result.status,
        auditEventId: started.id,
      });

      const status = done
        ? 202
        : result.status === "not_found"
          ? 404
          : result.status === "not_supported"
            ? 422
            : 409;
      return c.json({ ...result, auditEventId: started.id }, status, noStore);
    });
  }

  /**
   * One invoice's activity trace, for a stated purpose. The access is
   * written to the invoice's workspace audit trail before anything is
   * returned; actor names and the sender address are left out.
   */
  app.get("/ops/invoices/:id/activity", async (c) => {
    const auth = authorize(c);
    if ("response" in auth) return auth.response;
    const id = uuid.safeParse(c.req.param("id"));
    if (!id.success) {
      return c.json({ error: "Invalid invoice ID" }, 400, noStore);
    }
    const access = actionSchema.safeParse({
      purpose: c.req.query("purpose"),
      reason: c.req.query("reason"),
    });
    if (!access.success) {
      return c.json(
        {
          error: `State a purpose (${OPERATOR_PURPOSES.join(", ")}) and a reason (5-200 characters) as query parameters`,
        },
        400,
        noStore,
      );
    }
    const [row] = await deps.db
      .select({ teamId: inbox.teamId })
      .from(inbox)
      .where(eq(inbox.id, id.data))
      .limit(1);
    if (!row?.teamId)
      return c.json({ error: "Invoice not found" }, 404, noStore);

    const started = await audit(auth.operator, {
      teamId: row.teamId,
      action: "operator.invoice_activity_view",
      targetType: "invoice",
      targetId: id.data,
      purpose: access.data.purpose,
      detail: { reason: access.data.reason },
    });
    const activity = await readInvoiceActivity(deps.db, {
      teamId: row.teamId,
      invoiceId: id.data,
      audience: "operator",
    });
    await settleAuditEvent(deps.db, {
      id: started.id,
      outcome: activity ? "succeeded" : "refused",
    });
    log({
      operator: auth.operator.name,
      tokenFingerprint: auth.operator.tokenFingerprint,
      action: "invoice_activity_view",
      invoiceId: id.data,
      auditEventId: started.id,
    });
    return activity
      ? c.json(
          { teamId: row.teamId, auditEventId: started.id, ...activity },
          200,
          noStore,
        )
      : c.json({ error: "Invoice not found" }, 404, noStore);
  });

  /** Operator actions, newest first: who did what, why and with what result. */
  app.get("/ops/audit", async (c) => {
    const auth = authorize(c);
    if ("response" in auth) return auth.response;
    const teamId = c.req.query("teamId");
    if (teamId && !uuid.safeParse(teamId).success) {
      return c.json({ error: "Invalid workspace ID" }, 400, noStore);
    }
    const limit = Number(c.req.query("limit") ?? 50);
    const events = await listOperatorAuditEvents(deps.db, {
      teamId: teamId || undefined,
      limit: Number.isInteger(limit) && limit > 0 ? limit : 50,
    });
    return c.json({ data: events.map(presentAuditEvent) }, 200, noStore);
  });
}
