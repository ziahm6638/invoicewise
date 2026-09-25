import type { Database, PrimaryDatabase } from "@db/client";
import { workflowJobs } from "@db/schema";
import { redactOperationalText } from "@db/utils/redact";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  lte,
  notInArray,
  or,
  sql,
} from "drizzle-orm";

export type WorkflowJob = typeof workflowJobs.$inferSelect;

export type EnqueueWorkflowJobParams = {
  name: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  teamId?: string;
  runAt?: Date;
  maxAttempts?: number;
};

export async function enqueueWorkflowJob(
  db: Database | PrimaryDatabase,
  params: EnqueueWorkflowJobParams,
) {
  const [inserted] = await db
    .insert(workflowJobs)
    .values({
      name: params.name,
      payload: params.payload,
      idempotencyKey: params.idempotencyKey,
      teamId: params.teamId,
      runAt: params.runAt?.toISOString(),
      maxAttempts: params.maxAttempts,
    })
    .onConflictDoNothing({
      target: [workflowJobs.name, workflowJobs.idempotencyKey],
    })
    .returning();

  if (inserted) return { job: inserted, deduplicated: false };

  const [existing] = await db
    .select()
    .from(workflowJobs)
    .where(
      and(
        eq(workflowJobs.name, params.name),
        eq(workflowJobs.idempotencyKey, params.idempotencyKey),
      ),
    )
    .limit(1);

  if (!existing) throw new Error("Unable to enqueue workflow");
  return { job: existing, deduplicated: true };
}

export async function claimWorkflowJobs(
  db: Database,
  params: {
    workerId: string;
    limit: number;
    leaseMs: number;
    /** Workflows left queued this round (for example while a provider budget is spent). */
    excludeNames?: readonly string[];
    /**
     * Most jobs of a workflow claimed in one round, so work that waits on
     * third parties (webhook endpoints) cannot take every slot.
     */
    caps?: readonly { name: string; limit: number }[];
  },
) {
  return db.transaction(async (tx) => {
    const now = new Date();
    const nowIso = now.toISOString();

    await tx
      .update(workflowJobs)
      .set({
        status: "failed",
        finishedAt: nowIso,
        lastError: "Workflow lease expired after its final attempt",
        lockedBy: null,
        lockedAt: null,
        heartbeatAt: null,
        leaseExpiresAt: null,
        updatedAt: nowIso,
      })
      .where(
        and(
          eq(workflowJobs.status, "running"),
          lte(workflowJobs.leaseExpiresAt, nowIso),
          sql`${workflowJobs.attempts} >= ${workflowJobs.maxAttempts}`,
        ),
      );

    const excluded = params.excludeNames ?? [];
    const caps = (params.caps ?? []).filter(
      ({ name }) => !excluded.includes(name),
    );
    const select = (name: string | null, limit: number) =>
      tx
        .select({
          id: workflowJobs.id,
          runAt: workflowJobs.runAt,
          createdAt: workflowJobs.createdAt,
        })
        .from(workflowJobs)
        .where(
          and(
            lt(workflowJobs.attempts, workflowJobs.maxAttempts),
            name === null
              ? excluded.length || caps.length
                ? notInArray(workflowJobs.name, [
                    ...excluded,
                    ...caps.map((cap) => cap.name),
                  ])
                : undefined
              : eq(workflowJobs.name, name),
            or(
              and(
                eq(workflowJobs.status, "queued"),
                lte(workflowJobs.runAt, nowIso),
              ),
              and(
                eq(workflowJobs.status, "running"),
                lte(workflowJobs.leaseExpiresAt, nowIso),
              ),
            ),
          ),
        )
        .orderBy(asc(workflowJobs.runAt), asc(workflowJobs.createdAt))
        .limit(limit)
        .for("update", { skipLocked: true });

    // Candidates are merged in queue order; rows locked here but not claimed
    // are released when the transaction commits.
    const candidates = [await select(null, params.limit)];
    for (const cap of caps) {
      candidates.push(
        await select(cap.name, Math.min(params.limit, Math.max(0, cap.limit))),
      );
    }
    const claimable = candidates
      .flat()
      .sort(
        (a, b) =>
          a.runAt.localeCompare(b.runAt) ||
          a.createdAt.localeCompare(b.createdAt),
      )
      .slice(0, params.limit);

    if (claimable.length === 0) return [];

    return tx
      .update(workflowJobs)
      .set({
        status: "running",
        attempts: sql`${workflowJobs.attempts} + 1`,
        lockedBy: params.workerId,
        lockedAt: nowIso,
        heartbeatAt: nowIso,
        leaseExpiresAt: new Date(now.getTime() + params.leaseMs).toISOString(),
        updatedAt: nowIso,
      })
      .where(
        inArray(
          workflowJobs.id,
          claimable.map(({ id }) => id),
        ),
      )
      .returning();
  });
}

export async function heartbeatWorkflowJob(
  db: Database,
  params: { id: string; workerId: string; leaseMs: number },
) {
  const now = new Date();
  const [job] = await db
    .update(workflowJobs)
    .set({
      heartbeatAt: now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() + params.leaseMs).toISOString(),
      updatedAt: now.toISOString(),
    })
    .where(
      and(
        eq(workflowJobs.id, params.id),
        eq(workflowJobs.status, "running"),
        eq(workflowJobs.lockedBy, params.workerId),
      ),
    )
    .returning({ id: workflowJobs.id });
  return job;
}

/**
 * Hands a claimed job back to the queue when its worker shuts down before the
 * job finished (a deploy or restart). The interrupted attempt is not counted,
 * so a drained job keeps its full retry budget and the next runner claims it
 * at once instead of waiting for the lease to expire.
 */
export async function releaseWorkflowJob(
  db: Database,
  params: { id: string; workerId: string },
) {
  const now = new Date().toISOString();
  const [job] = await db
    .update(workflowJobs)
    .set({
      status: "queued",
      runAt: now,
      attempts: sql`greatest(${workflowJobs.attempts} - 1, 0)`,
      lockedBy: null,
      lockedAt: null,
      heartbeatAt: null,
      leaseExpiresAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(workflowJobs.id, params.id),
        eq(workflowJobs.status, "running"),
        eq(workflowJobs.lockedBy, params.workerId),
      ),
    )
    .returning({ id: workflowJobs.id });
  return job;
}

export async function completeWorkflowJob(
  db: Database,
  params: {
    id: string;
    workerId: string;
    result: Record<string, unknown>;
  },
) {
  const now = new Date().toISOString();
  const [job] = await db
    .update(workflowJobs)
    .set({
      status: "succeeded",
      result: params.result,
      finishedAt: now,
      lockedBy: null,
      lockedAt: null,
      heartbeatAt: null,
      leaseExpiresAt: null,
      lastError: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(workflowJobs.id, params.id),
        eq(workflowJobs.lockedBy, params.workerId),
      ),
    )
    .returning();
  return job;
}

export async function retryWorkflowJob(
  db: Database,
  params: { id: string; workerId: string; error: string; delayMs: number },
) {
  const now = new Date();
  const [job] = await db
    .update(workflowJobs)
    .set({
      status: "queued",
      runAt: new Date(now.getTime() + params.delayMs).toISOString(),
      lockedBy: null,
      lockedAt: null,
      heartbeatAt: null,
      leaseExpiresAt: null,
      // Errors can quote provider responses: stored redacted and bounded.
      lastError: redactOperationalText(params.error),
      updatedAt: now.toISOString(),
    })
    .where(
      and(
        eq(workflowJobs.id, params.id),
        eq(workflowJobs.lockedBy, params.workerId),
      ),
    )
    .returning();
  return job;
}

export async function failWorkflowJob(
  db: Database,
  params: { id: string; workerId: string; error: string },
) {
  const now = new Date().toISOString();
  const [job] = await db
    .update(workflowJobs)
    .set({
      status: "failed",
      finishedAt: now,
      lockedBy: null,
      lockedAt: null,
      heartbeatAt: null,
      leaseExpiresAt: null,
      // Errors can quote provider responses: stored redacted and bounded.
      lastError: redactOperationalText(params.error),
      updatedAt: now,
    })
    .where(
      and(
        eq(workflowJobs.id, params.id),
        eq(workflowJobs.lockedBy, params.workerId),
      ),
    )
    .returning();
  return job;
}

export async function getWorkflowJob(
  db: Database,
  params: { id: string; teamId?: string },
) {
  const [job] = await db
    .select()
    .from(workflowJobs)
    .where(
      and(
        eq(workflowJobs.id, params.id),
        params.teamId
          ? eq(workflowJobs.teamId, params.teamId)
          : isNull(workflowJobs.teamId),
      ),
    )
    .limit(1);
  return job;
}

export async function getWorkflowJobByKey(
  db: Database,
  params: { name: string; idempotencyKey: string; teamId: string },
) {
  const [job] = await db
    .select()
    .from(workflowJobs)
    .where(
      and(
        eq(workflowJobs.name, params.name),
        eq(workflowJobs.idempotencyKey, params.idempotencyKey),
        eq(workflowJobs.teamId, params.teamId),
      ),
    )
    .limit(1);
  return job;
}

/**
 * An already queued or running intake job for one canonical inbox id. Used to
 * make an explicit retry idempotent while work is still pending.
 */
export async function findPendingIntakeJob(
  db: Database | PrimaryDatabase,
  params: { teamId: string; inboxId: string },
) {
  const [job] = await db
    .select()
    .from(workflowJobs)
    .where(
      and(
        eq(workflowJobs.name, "process-attachment"),
        eq(workflowJobs.teamId, params.teamId),
        inArray(workflowJobs.status, ["queued", "running"]),
        sql`${workflowJobs.payload} ->> 'inboxId' = ${params.inboxId}`,
      ),
    )
    .limit(1);
  return job;
}

export async function restartFailedWorkflowJob(
  db: Database,
  params: { id: string; teamId: string },
) {
  const now = new Date().toISOString();
  const [job] = await db
    .update(workflowJobs)
    .set({
      status: "queued",
      attempts: 0,
      runAt: now,
      lockedBy: null,
      lockedAt: null,
      heartbeatAt: null,
      leaseExpiresAt: null,
      finishedAt: null,
      lastError: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(workflowJobs.id, params.id),
        eq(workflowJobs.teamId, params.teamId),
        eq(workflowJobs.status, "failed"),
      ),
    )
    .returning();
  return job;
}

/**
 * Re-runs a finished job under its original idempotency key, so the
 * durable delivery record and its job stay linked. Used by explicit delivery
 * retries; a queued or running job is left alone.
 */
export async function requeueFinishedWorkflowJob(
  db: Pick<Database, "update">,
  params: {
    name: string;
    idempotencyKey: string;
    teamId: string;
    /** Replaces the job's payload for the restarted run. */
    payload?: Record<string, unknown>;
  },
) {
  const now = new Date().toISOString();
  const [job] = await db
    .update(workflowJobs)
    .set({
      ...(params.payload ? { payload: params.payload } : {}),
      status: "queued",
      attempts: 0,
      runAt: now,
      lockedBy: null,
      lockedAt: null,
      heartbeatAt: null,
      leaseExpiresAt: null,
      finishedAt: null,
      lastError: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(workflowJobs.name, params.name),
        eq(workflowJobs.idempotencyKey, params.idempotencyKey),
        eq(workflowJobs.teamId, params.teamId),
        inArray(workflowJobs.status, ["failed", "succeeded"]),
      ),
    )
    .returning();
  return job;
}

export function listWorkflowJobs(db: Database, limit = 50) {
  return db
    .select()
    .from(workflowJobs)
    .orderBy(desc(workflowJobs.createdAt))
    .limit(limit);
}

// --- Operator recovery (docs/operations.md#recovery) ------------------------

/**
 * Payload fields an operator may see: record identifiers only. Payloads can
 * hold invitation codes, email addresses and legacy file paths, so nothing
 * else of a payload ever leaves the queue through an operator surface.
 */
export const OPERATOR_SUBJECT_KEYS = [
  "inboxId",
  "invoiceId",
  "deliveryId",
  "correctionId",
  "runId",
  "exportId",
  "inboundEmailId",
  "deletionId",
  "revision",
] as const;

const subjectColumn = sql<
  Record<string, string | number>
>`jsonb_strip_nulls(jsonb_build_object(${sql.raw(
  OPERATOR_SUBJECT_KEYS.map(
    (key) => `'${key}', "workflow_jobs"."payload" -> '${key}'`,
  ).join(", "),
)}))`;

const operatorJobColumns = {
  id: workflowJobs.id,
  name: workflowJobs.name,
  teamId: workflowJobs.teamId,
  status: workflowJobs.status,
  attempts: workflowJobs.attempts,
  maxAttempts: workflowJobs.maxAttempts,
  runAt: workflowJobs.runAt,
  lockedBy: workflowJobs.lockedBy,
  heartbeatAt: workflowJobs.heartbeatAt,
  leaseExpiresAt: workflowJobs.leaseExpiresAt,
  finishedAt: workflowJobs.finishedAt,
  lastError: workflowJobs.lastError,
  createdAt: workflowJobs.createdAt,
  updatedAt: workflowJobs.updatedAt,
  subject: subjectColumn,
};

export type OperatorJob = Awaited<ReturnType<typeof getOperatorJob>>;

export type OperatorJobFilter =
  | "stuck"
  | "failed"
  | "overdue"
  | "queued"
  | "running";

/**
 * Jobs an operator is looking for, newest first, without their payloads:
 * `stuck` (running, lease expired), `overdue` (queued and due for longer
 * than `overdueMs`), `failed`, or any `queued`/`running` job.
 */
export async function listOperatorJobs(
  db: Pick<Database, "select">,
  params: {
    filter: OperatorJobFilter;
    workflow?: string;
    teamId?: string;
    overdueMs?: number;
    limit?: number;
    now?: Date;
  },
) {
  const now = params.now ?? new Date();
  const nowIso = now.toISOString();
  const state = {
    stuck: and(
      eq(workflowJobs.status, "running"),
      lte(workflowJobs.leaseExpiresAt, nowIso),
    ),
    overdue: and(
      eq(workflowJobs.status, "queued"),
      lte(
        workflowJobs.runAt,
        new Date(
          now.getTime() - (params.overdueMs ?? 15 * 60_000),
        ).toISOString(),
      ),
    ),
    failed: eq(workflowJobs.status, "failed"),
    queued: eq(workflowJobs.status, "queued"),
    running: eq(workflowJobs.status, "running"),
  }[params.filter];
  return db
    .select(operatorJobColumns)
    .from(workflowJobs)
    .where(
      and(
        state,
        params.workflow ? eq(workflowJobs.name, params.workflow) : undefined,
        params.teamId ? eq(workflowJobs.teamId, params.teamId) : undefined,
      ),
    )
    .orderBy(desc(workflowJobs.updatedAt), desc(workflowJobs.id))
    .limit(Math.min(Math.max(params.limit ?? 50, 1), 200));
}

export async function getOperatorJob(
  db: Pick<Database, "select">,
  params: { id: string },
) {
  const [job] = await db
    .select(operatorJobColumns)
    .from(workflowJobs)
    .where(eq(workflowJobs.id, params.id))
    .limit(1);
  return job;
}

/** The subject key a workflow's jobs are about, for "is there a newer job". */
const SUBJECT_KEY_BY_WORKFLOW: Record<string, string> = {
  "process-attachment": "inboxId",
  "post-accounting-draft": "invoiceId",
  "rerun-judgments": "invoiceId",
  "match-invoice": "invoiceId",
  "update-accounting-bill": "correctionId",
  "deliver-webhook": "deliveryId",
  "process-inbound-email": "inboundEmailId",
  "build-data-export": "exportId",
  "purge-deleted-data": "deletionId",
  "rerun-question": "runId",
};

/**
 * Whether a later job of the same workflow exists for the same record, in
 * which case this one is history and an operator retry of it is refused.
 */
export async function hasNewerWorkflowJob(
  db: Pick<Database, "select">,
  job: { id: string; name: string; teamId: string | null; createdAt: string },
) {
  const key = SUBJECT_KEY_BY_WORKFLOW[job.name];
  if (!key) return false;
  const [newer] = await db
    .select({ id: workflowJobs.id })
    .from(workflowJobs)
    .where(
      and(
        eq(workflowJobs.name, job.name),
        job.teamId
          ? eq(workflowJobs.teamId, job.teamId)
          : isNull(workflowJobs.teamId),
        sql`${workflowJobs.payload} ->> ${key} = (select payload ->> ${key} from workflow_jobs where id = ${job.id})`,
        sql`${workflowJobs.createdAt} > ${job.createdAt}`,
      ),
    )
    .limit(1);
  return !!newer;
}

export const OPERATOR_CANCELLED_ERROR = "Cancelled by an operator";

/**
 * Stops a job that no live worker holds: a queued one, or a running one
 * whose lease expired. It is recorded as failed with the operator's reason,
 * and the runner's reconcilers then settle its record the same way as any
 * failed job (a visible, retryable failure the customer can see). A job a
 * live worker holds is left alone. Returns the job, or undefined when it was
 * not in a cancellable state.
 */
export async function cancelWorkflowJobAsOperator(
  db: Pick<Database, "update">,
  params: { id: string; reason: string; now?: Date },
) {
  const now = (params.now ?? new Date()).toISOString();
  const [job] = await db
    .update(workflowJobs)
    .set({
      status: "failed",
      finishedAt: now,
      lastError: redactOperationalText(
        `${OPERATOR_CANCELLED_ERROR}: ${params.reason}`,
      ),
      lockedBy: null,
      lockedAt: null,
      heartbeatAt: null,
      leaseExpiresAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(workflowJobs.id, params.id),
        or(
          eq(workflowJobs.status, "queued"),
          and(
            eq(workflowJobs.status, "running"),
            lte(workflowJobs.leaseExpiresAt, now),
          ),
        ),
      ),
    )
    .returning({ id: workflowJobs.id, status: workflowJobs.status });
  return job;
}
