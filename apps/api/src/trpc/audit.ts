import type { Database } from "@invoicewise/db/client";
import {
  type AuditOutcome,
  getTeamRole,
  settleAuditEvent,
  startAuditEvent,
} from "@invoicewise/db/queries";
import { AUDIT_ACTIONS, type AuditAction } from "@invoicewise/jobs/activity";
import { TRPCError } from "@trpc/server";

/**
 * The audit trail for dashboard (tRPC) actions: which procedures are
 * recorded, what they act on and which fields of the request or result are
 * safe to keep. Only named identifiers, counts, roles, field names and
 * statuses are recorded: never extracted values, document contents, email
 * addresses of invitees, keys, tokens or secrets. See
 * docs/operations.md#audit-trail.
 *
 * Every mutation must appear here, either with a spec or as `null` with the
 * reason it is not a workspace change (`audit.test.ts` enforces this).
 */

type Loose = Record<string, unknown> | undefined;

const str = (value: unknown) =>
  typeof value === "string" && value.length <= 200 ? value : null;
const num = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const field = (input: Loose, key: string) =>
  input && typeof input === "object" ? input[key] : undefined;
const asObject = (value: unknown): Loose =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

export type AuditTarget = {
  type: string;
  id: string | null;
  revision?: number | null;
};

export type AuditSpec = {
  action: AuditAction;
  /** What the request acts on. */
  target?: (input: Loose) => AuditTarget | null;
  /** Safe request fields to record. */
  detail?: (input: Loose) => Record<string, unknown>;
  /** What the result adds: the created record, the new revision, a summary. */
  result?: (
    result: unknown,
    input: Loose,
  ) => {
    targetId?: string | null;
    revision?: number | null;
    teamId?: string | null;
    detail?: Record<string, unknown>;
  } | null;
  /**
   * The workspace acted on when it is not the caller's active one (joining,
   * leaving or creating a workspace).
   */
  teamId?: (input: Loose) => string | null;
  /** One event per listed record instead of one per request. */
  each?: (input: Loose) => AuditTarget[];
  /** The per-record outcome of an `each` request. */
  eachResult?: (
    result: unknown,
    target: AuditTarget,
  ) => { outcome: Exclude<AuditOutcome, "started">; error?: string | null };
};

const invoice = (input: Loose): AuditTarget => ({
  type: "invoice",
  id: str(field(input, "id")),
  revision: num(field(input, "revision")),
});

const byId =
  (type: string, key = "id") =>
  (input: Loose) => ({
    type,
    id: str(field(input, key)),
  });

/** The id of the record a mutation created (`id`, or `sourceId` for sources). */
const createdId = () => (result: unknown) => {
  const value = asObject(result);
  return {
    targetId: str(field(value, "id")) ?? str(field(value, "sourceId")),
  };
};

export const TRPC_AUDIT: Record<string, AuditSpec | null> = {
  // Invoices
  "inbox.correct": {
    action: "invoice.correct",
    target: invoice,
    detail: (input) => ({
      // Field names only; the values are kept in the invoice's history.
      fields: Object.keys(asObject(field(input, "changes")) ?? {}),
      accountingOutcome: str(field(input, "accountingOutcome")),
    }),
    result: (result) => {
      const value = asObject(result);
      return {
        revision: num(field(value, "revision")),
        detail: {
          correctionId: str(field(value, "correctionId")),
          version: num(field(value, "version")),
          accounting: str(field(value, "accounting")),
          validationStatus: str(field(value, "validationStatus")),
        },
      };
    },
  },
  "inbox.retry": {
    action: "invoice.reextract",
    target: invoice,
    result: (result) => ({
      detail: {
        jobId: str(field(asObject(result), "jobId")),
        deduplicated: field(asObject(result), "deduplicated") === true,
      },
    }),
  },
  "inbox.rerunQuestions": {
    action: "invoice.rerun_questions",
    target: invoice,
    result: (result) => ({
      revision: num(field(asObject(result), "revision")),
      detail: {
        deduplicated: field(asObject(result), "deduplicated") === true,
      },
    }),
  },
  "inbox.retryDelivery": {
    action: "delivery.retry",
    target: invoice,
    result: (result) => {
      const value = asObject(result);
      return {
        revision: num(field(value, "revision")),
        detail: {
          webhooksRequeued: num(
            field(asObject(field(value, "webhooks")), "requeued"),
          ),
          webhooksSkipped: num(
            field(asObject(field(value, "webhooks")), "skipped"),
          ),
          accounting: str(field(value, "accounting")),
          billUpdate: str(field(value, "billUpdate")),
        },
      };
    },
  },
  "inbox.releaseDelivery": {
    action: "delivery.release",
    target: invoice,
    // The reason is kept with the delivery decision itself.
    detail: (input) => ({ reasonGiven: !!str(field(input, "reason")) }),
  },
  "inbox.dismissDelivery": {
    action: "delivery.dismiss",
    target: invoice,
    detail: (input) => ({ reasonGiven: !!str(field(input, "reason")) }),
  },
  "deliveryRules.update": {
    action: "delivery_rules.update",
    target: () => ({ type: "delivery_policy", id: null }),
    detail: (input) => ({
      expectedVersion: num(field(input, "expectedVersion")),
      settings: Object.keys(asObject(field(input, "policy")) ?? {}),
    }),
    result: (result) => ({
      detail: { version: num(field(asObject(result), "version")) },
    }),
  },
  "inbox.bulkAction": {
    action: "invoice.bulk_action",
    detail: (input) => ({ bulkAction: str(field(input, "action")) }),
    each: (input) => {
      const items = field(input, "items");
      return Array.isArray(items)
        ? items.slice(0, 50).map((item) => invoice(asObject(item)))
        : [];
    },
    eachResult: (result, target) => {
      const results = field(asObject(result), "results");
      const row = Array.isArray(results)
        ? results.map(asObject).find((item) => field(item, "id") === target.id)
        : undefined;
      return field(row, "ok") === true
        ? { outcome: "succeeded" }
        : { outcome: "refused", error: str(field(row, "error")) };
    },
  },
  "inbox.update": {
    action: "invoice.update",
    target: byId("invoice"),
    detail: (input) => ({ status: str(field(input, "status")) }),
  },
  "inbox.delete": { action: "invoice.delete", target: byId("invoice") },

  // Questions
  "questions.create": {
    action: "question.create",
    detail: (input) => ({ type: str(field(input, "type")) }),
    result: (result) => ({
      targetId: str(field(asObject(result), "questionKey")),
      detail: { version: num(field(asObject(result), "version")) },
    }),
    target: () => ({ type: "question", id: null }),
  },
  "questions.update": {
    action: "question.update",
    target: byId("question", "questionKey"),
    result: (result) => ({
      detail: { version: num(field(asObject(result), "version")) },
    }),
  },
  "questions.delete": {
    action: "question.delete",
    target: byId("question", "questionKey"),
  },
  "questions.preview": {
    action: "question.preview",
    target: byId("question", "questionKey"),
    detail: (input) => {
      const ids = field(input, "invoiceIds");
      return {
        draft: !!field(input, "draft"),
        invoices: Array.isArray(ids) ? ids.length : null,
      };
    },
  },
  "questions.rerun": {
    action: "question.rerun",
    target: byId("question", "questionKey"),
    detail: (input) => {
      const ids = field(input, "invoiceIds");
      return {
        invoiceIds: Array.isArray(ids) ? ids.map(str).slice(0, 50) : [],
      };
    },
    result: (result) => ({
      detail: { runId: str(field(asObject(result), "id")) },
    }),
  },

  // Suppliers
  "suppliers.assignInvoice": {
    action: "supplier.assign_invoice",
    target: byId("invoice", "inboxId"),
    detail: (input) => ({
      supplierId: str(field(input, "supplierId")),
      newSupplier: !!field(input, "newSupplierName"),
    }),
  },
  "suppliers.merge": {
    action: "supplier.merge",
    target: byId("supplier", "targetId"),
    detail: (input) => ({ sourceSupplierId: str(field(input, "sourceId")) }),
  },
  "suppliers.revert": {
    action: "supplier.revert",
    target: byId("supplier_event", "eventId"),
    detail: (input) => ({ invoiceId: str(field(input, "inboxId")) }),
  },

  // Authorization sources
  "authorizationSources.create": {
    action: "authorization_source.create",
    target: () => ({ type: "authorization_source", id: null }),
    result: createdId(),
  },
  "authorizationSources.amend": {
    action: "authorization_source.amend",
    target: byId("authorization_source"),
  },
  "authorizationSources.setStatus": {
    action: "authorization_source.set_status",
    target: byId("authorization_source"),
    detail: (input) => ({ status: str(field(input, "status")) }),
  },
  "authorizationSources.linkSupplier": {
    action: "authorization_source.link_supplier",
    target: byId("authorization_source"),
    detail: (input) => ({ supplierId: str(field(input, "supplierId")) }),
  },
  "authorizationSources.import": {
    action: "authorization_source.import",
    detail: (input) => ({ dryRun: field(input, "dryRun") === true }),
  },

  // Invoice-to-source matches; the decision itself is kept in the
  // invoice's match history.
  "sourceMatches.confirm": {
    action: "source_match.confirm",
    target: byId("invoice", "inboxId"),
    detail: (input) => ({
      expectedMatchId: str(field(input, "expectedMatchId")),
    }),
  },
  "sourceMatches.link": {
    action: "source_match.link",
    target: byId("invoice", "inboxId"),
    detail: (input) => {
      const sources = field(input, "sources");
      return {
        expectedMatchId: str(field(input, "expectedMatchId")),
        sourceIds: Array.isArray(sources)
          ? sources.map((source) => str(field(asObject(source), "sourceId")))
          : [],
      };
    },
  },
  "sourceMatches.unlink": {
    action: "source_match.unlink",
    target: byId("invoice", "inboxId"),
    detail: (input) => ({
      expectedMatchId: str(field(input, "expectedMatchId")),
    }),
  },

  // Integrations
  "webhooks.create": {
    action: "webhook.create",
    target: () => ({ type: "webhook_endpoint", id: null }),
    detail: (input) => {
      const events = field(input, "events");
      return {
        // The origin only: a path or query can carry the receiver's token.
        origin: (() => {
          try {
            return new URL(String(field(input, "url"))).origin;
          } catch {
            return null;
          }
        })(),
        events: Array.isArray(events) ? events.map(str) : [],
      };
    },
    result: createdId(),
  },
  "webhooks.disable": {
    action: "webhook.disable",
    target: byId("webhook_endpoint"),
  },
  "webhooks.rotateSecret": {
    action: "webhook.rotate_secret",
    target: byId("webhook_endpoint"),
    detail: (input) => ({
      revokePrevious: field(input, "revokePrevious") === true,
    }),
  },
  "webhooks.sendTest": {
    action: "webhook.test",
    target: byId("webhook_endpoint"),
    result: (result) => ({
      detail: { deliveryId: str(field(asObject(result), "deliveryId")) },
    }),
  },
  "webhooks.redeliver": {
    action: "webhook.redeliver",
    target: byId("webhook_delivery", "deliveryId"),
    detail: (input) => ({ endpointId: str(field(input, "id")) }),
  },
  "accounting.createConnectSession": {
    action: "accounting.connect_start",
    detail: (input) => ({ provider: str(field(input, "provider")) }),
  },
  "accounting.completeConnection": {
    action: "accounting.connect",
    detail: (input) => ({ provider: str(field(input, "provider")) }),
  },
  "accounting.disconnect": {
    action: "accounting.disconnect",
    detail: (input) => ({ provider: str(field(input, "provider")) }),
  },
  "accounting.checkHealth": {
    action: "accounting.health_check",
    result: (result) => ({
      detail: { status: str(field(asObject(result), "healthStatus")) },
    }),
  },
  "accounting.updateSettings": {
    action: "accounting.settings_update",
    detail: (input) => ({
      provider: str(field(input, "provider")),
      autoPost: field(input, "autoPost") === true,
    }),
  },
  "inboxAccounts.connect": {
    action: "mailbox.connect",
    detail: (input) => ({ provider: str(field(input, "provider")) }),
  },
  // A query by transport, but it completes a mailbox connection.
  "inboxAccounts.exchangeCodeForAccount": {
    action: "mailbox.connect",
    result: createdId(),
    target: () => ({ type: "mailbox", id: null }),
  },
  "inboxAccounts.delete": {
    action: "mailbox.disconnect",
    target: byId("mailbox"),
  },
  "inboxAccounts.sync": { action: "mailbox.sync", target: byId("mailbox") },
  "inboundEmail.rotate": { action: "inbound_address.replace" },
  "oauthApplications.create": {
    action: "oauth_app.create",
    target: () => ({ type: "oauth_application", id: null }),
    result: createdId(),
  },
  "oauthApplications.update": {
    action: "oauth_app.update",
    target: byId("oauth_application"),
  },
  "oauthApplications.delete": {
    action: "oauth_app.delete",
    target: byId("oauth_application"),
  },
  "oauthApplications.regenerateSecret": {
    action: "oauth_app.regenerate_secret",
    target: byId("oauth_application"),
  },
  "oauthApplications.updateApprovalStatus": {
    action: "oauth_app.set_approval",
    target: byId("oauth_application"),
    detail: (input) => ({ status: str(field(input, "status")) }),
  },

  // Access: keys, grants and members
  "apiKeys.upsert": {
    action: "api_key.save",
    target: byId("api_key"),
    detail: (input) => {
      const scopes = field(input, "scopes");
      return {
        name: str(field(input, "name")),
        scopes: Array.isArray(scopes) ? scopes.map(str) : [],
      };
    },
    result: (result) => ({
      targetId: str(field(asObject(field(asObject(result), "data")), "id")),
    }),
  },
  "apiKeys.delete": { action: "api_key.delete", target: byId("api_key") },
  "oauthApplications.authorize": {
    action: "oauth.grant",
    target: byId("oauth_application", "clientId"),
    teamId: (input) => str(field(input, "teamId")),
    detail: (input) => {
      const scopes = field(input, "scopes");
      return {
        decision: str(field(input, "decision")),
        scopes: Array.isArray(scopes) ? scopes.map(str) : [],
      };
    },
  },
  "oauthApplications.revokeAccess": {
    action: "oauth.revoke",
    target: byId("oauth_application", "applicationId"),
  },
  "team.invite": {
    action: "member.invite",
    detail: (input) => ({
      count: Array.isArray(input) ? input.length : null,
      roles: Array.isArray(input)
        ? input.map((invite) => str(field(asObject(invite), "role")))
        : [],
    }),
    result: (result) => ({
      detail: {
        sent: num(field(asObject(result), "sent")),
        skipped: num(field(asObject(result), "skipped")),
      },
    }),
  },
  "team.deleteInvite": {
    action: "member.invite_revoke",
    target: byId("invitation"),
  },
  "team.deleteMember": {
    action: "member.remove",
    target: byId("user", "userId"),
  },
  "team.updateMember": {
    action: "member.role_change",
    target: byId("user", "userId"),
    detail: (input) => ({ role: str(field(input, "role")) }),
  },
  "team.acceptInvite": {
    action: "member.join",
    target: byId("invitation"),
    // Recorded in the workspace joined, which the result names.
    teamId: () => null,
    result: (result) => ({
      teamId: str(field(asObject(result), "teamId")),
    }),
  },
  "team.leave": {
    action: "member.leave",
    teamId: (input) => str(field(input, "teamId")),
  },

  // Workspace
  "team.create": {
    action: "workspace.create",
    teamId: () => null,
    result: (result) => ({ teamId: str(result), targetId: str(result) }),
    target: () => ({ type: "workspace", id: null }),
  },
  "team.update": {
    action: "workspace.update",
    detail: (input) => ({
      fields: Object.keys(input ?? {}).filter((key) => key !== "id"),
    }),
  },
  "team.delete": {
    action: "workspace.delete",
    teamId: (input) => str(field(input, "teamId")),
  },
  "data.requestExport": {
    action: "data.export_request",
    target: () => ({ type: "data_export", id: null }),
    result: createdId(),
  },
  "data.exportDownloadUrl": {
    action: "data.export_download",
    target: byId("data_export"),
  },

  // Not workspace changes.
  /** Declining an invitation changes nothing in any workspace. */
  "team.declineInvite": null,
  /** The caller's own profile and locale settings. */
  "user.update": null,
  /** Account deletion; its workspace effects are recorded by offboarding. */
  "user.delete": null,
  /** Reads a billing invoice from the billing provider. */
  "billing.getInvoice": null,
};

/** tRPC error codes as audit outcomes. */
export const auditOutcomeForError = (
  error: unknown,
): Exclude<AuditOutcome, "started" | "succeeded"> => {
  const code = error instanceof TRPCError ? error.code : null;
  if (code === "FORBIDDEN" || code === "UNAUTHORIZED") return "denied";
  if (
    code === "BAD_REQUEST" ||
    code === "CONFLICT" ||
    code === "NOT_FOUND" ||
    code === "PRECONDITION_FAILED" ||
    code === "TOO_MANY_REQUESTS" ||
    code === "PARSE_ERROR" ||
    code === "UNPROCESSABLE_CONTENT"
  ) {
    return "refused";
  }
  return "failed";
};

const errorDetail = (error: unknown) => ({
  code: error instanceof TRPCError ? error.code : "INTERNAL_SERVER_ERROR",
  // Internal errors are not described: their text can quote internals.
  error:
    error instanceof TRPCError && error.code !== "INTERNAL_SERVER_ERROR"
      ? error.message
      : null,
});

type NextResult = { ok: true; data: unknown } | { ok: false; error: unknown };

/**
 * Records an audited procedure around its execution: a `started` event
 * before (the action is refused if that cannot be written, so nothing
 * audited ever runs unrecorded), settled with the outcome after. Role
 * refusals raised inside (admin and owner gates) are recorded as `denied`.
 */
export async function withAuditTrail<T extends NextResult>(opts: {
  path: string;
  type: string;
  db: Database;
  teamId: string | null;
  userId: string;
  getRawInput: () => Promise<unknown>;
  next: () => Promise<T>;
}): Promise<T> {
  const spec = TRPC_AUDIT[opts.path];
  if (!spec) return opts.next();

  const raw = await opts.getRawInput().catch(() => undefined);
  const input = Array.isArray(raw) ? (raw as unknown as Loose) : asObject(raw);
  // A workspace named by the request is only written to for its members,
  // so nobody can add rows to another workspace's audit trail.
  const named = spec.teamId ? spec.teamId(input) : opts.teamId;
  const teamId =
    named && named !== opts.teamId
      ? (await getTeamRole(opts.db, named, opts.userId).catch(() => null))
        ? named
        : null
      : named;
  const targets = spec.each?.(input) ?? [spec.target?.(input) ?? null];
  const base = {
    teamId,
    actor: { type: "user" as const, userId: opts.userId },
    surface: "app" as const,
    action: spec.action,
    category: AUDIT_ACTIONS[spec.action].category,
    detail: spec.detail?.(input) ?? null,
  };

  let started: { id: string; target: AuditTarget | null }[];
  try {
    started = await Promise.all(
      targets.map(async (target) => ({
        target,
        id: (
          await startAuditEvent(opts.db, {
            ...base,
            targetType: target?.type ?? null,
            targetId: target?.id ?? null,
            revision: target?.revision ?? null,
          })
        ).id,
      })),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "audit_start_failed",
        action: spec.action,
        error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
      }),
    );
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "The action could not be recorded, so it was not run.",
    });
  }

  const result = await opts.next();

  const settle = async () => {
    for (const event of started) {
      if (!result.ok) {
        await settleAuditEvent(opts.db, {
          id: event.id,
          outcome: auditOutcomeForError(result.error),
          detail: errorDetail(result.error),
        });
        continue;
      }
      if (spec.each && spec.eachResult && event.target) {
        const item = spec.eachResult(result.data, event.target);
        await settleAuditEvent(opts.db, {
          id: event.id,
          outcome: item.outcome,
          detail: item.error ? { error: item.error } : null,
        });
        continue;
      }
      const learned = spec.result?.(result.data, input) ?? null;
      await settleAuditEvent(opts.db, {
        id: event.id,
        outcome: "succeeded",
        detail: learned?.detail ?? null,
        teamId: learned?.teamId ?? null,
        targetId: learned?.targetId ?? null,
        revision: learned?.revision ?? null,
      });
    }
  };
  // The action already ran: a failure to settle leaves the event `started`
  // (outcome unknown) and is logged, never turned into an error.
  await settle().catch((error) =>
    console.error(
      JSON.stringify({
        event: "audit_settle_failed",
        action: spec.action,
        error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
      }),
    ),
  );
  return result;
}
