import type { Database, PrimaryDatabase } from "@db/client";
import { auditEvents, users } from "@db/schema";
import { redactOperationalText } from "@db/utils/redact";
import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";

type Db = Database | PrimaryDatabase;

export type AuditEvent = typeof auditEvents.$inferSelect;
export type AuditActorType = AuditEvent["actorType"];
export type AuditSurface = AuditEvent["surface"];
export type AuditCategory = AuditEvent["category"];
export type AuditOutcome = AuditEvent["outcome"];

export type AuditActor = {
  type: AuditActorType;
  userId?: string | null;
  /** API key or OAuth application id, or the operator's name. */
  ref?: string | null;
};

export type AuditEventInput = {
  teamId: string | null;
  actor: AuditActor;
  surface: AuditSurface;
  action: string;
  category: AuditCategory;
  targetType?: string | null;
  targetId?: string | null;
  revision?: number | null;
  detail?: Record<string, unknown> | null;
  purpose?: string | null;
};

const MAX_DETAIL_KEYS = 20;
const MAX_DETAIL_ITEMS = 50;
const MAX_DETAIL_TEXT = 200;

const detailValue = (value: unknown, depth: number): unknown => {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    return redactOperationalText(value, MAX_DETAIL_TEXT);
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_DETAIL_ITEMS)
      .map((item) => detailValue(item, depth + 1))
      .filter((item) => item !== undefined);
  }
  if (typeof value === "object" && depth < 2) {
    return sanitizeAuditDetail(value as Record<string, unknown>, depth + 1);
  }
  return undefined;
};

/**
 * Bounds and redacts an event's detail: at most 20 keys, two levels deep,
 * short strings with secrets and bank identifiers masked. Callers still
 * choose which fields to record; this is the backstop.
 */
export function sanitizeAuditDetail(
  detail: Record<string, unknown> | null | undefined,
  depth = 0,
): Record<string, unknown> | null {
  if (!detail) return null;
  const entries = Object.entries(detail)
    .slice(0, MAX_DETAIL_KEYS)
    .map(([key, value]) => [key, detailValue(value, depth)] as const)
    .filter(([, value]) => value !== undefined);
  return entries.length ? Object.fromEntries(entries) : null;
}

const values = (input: AuditEventInput, outcome: AuditOutcome) => ({
  teamId: input.teamId,
  actorType: input.actor.type,
  actorUserId: input.actor.userId ?? null,
  actorRef: input.actor.ref
    ? redactOperationalText(input.actor.ref, 120)
    : null,
  surface: input.surface,
  action: input.action,
  category: input.category,
  targetType: input.targetType ?? null,
  targetId: input.targetId ?? null,
  revision: input.revision ?? null,
  outcome,
  detail: sanitizeAuditDetail(input.detail),
  purpose: input.purpose ?? null,
});

/**
 * Records an action as `started` before it runs. The caller settles it with
 * `settleAuditEvent`; one that never settles (the process died) keeps
 * reading as attempted with an unknown outcome.
 */
export async function startAuditEvent(db: Db, input: AuditEventInput) {
  const [row] = await db
    .insert(auditEvents)
    .values(values(input, "started"))
    .returning({ id: auditEvents.id });
  if (!row) throw new Error("Unable to record the audit event");
  return row;
}

/** Records an action whose outcome is already known. */
export async function recordAuditEvent(
  db: Db,
  input: AuditEventInput & { outcome: Exclude<AuditOutcome, "started"> },
) {
  const [row] = await db
    .insert(auditEvents)
    .values({ ...values(input, input.outcome), settledAt: sql`now()` })
    .returning({ id: auditEvents.id });
  return row;
}

/**
 * Settles a started event with its outcome. Only a `started` row changes, so
 * an outcome is written once. Target, workspace and revision learned from
 * the result fill in what the request did not name; detail is merged.
 */
export async function settleAuditEvent(
  db: Db,
  params: {
    id: string;
    outcome: Exclude<AuditOutcome, "started">;
    detail?: Record<string, unknown> | null;
    teamId?: string | null;
    targetType?: string | null;
    targetId?: string | null;
    revision?: number | null;
  },
) {
  const detail = sanitizeAuditDetail(params.detail);
  const [row] = await db
    .update(auditEvents)
    .set({
      outcome: params.outcome,
      settledAt: sql`now()`,
      ...(detail
        ? {
            detail: sql`coalesce(${auditEvents.detail}, '{}'::jsonb) || ${JSON.stringify(detail)}::jsonb`,
          }
        : {}),
      ...(params.teamId
        ? {
            teamId: sql`coalesce(${auditEvents.teamId}, ${params.teamId}::uuid)`,
          }
        : {}),
      ...(params.targetType ? { targetType: params.targetType } : {}),
      ...(params.targetId ? { targetId: params.targetId } : {}),
      ...(params.revision != null ? { revision: params.revision } : {}),
    })
    .where(
      and(eq(auditEvents.id, params.id), eq(auditEvents.outcome, "started")),
    )
    .returning({ id: auditEvents.id });
  return row;
}

const listColumns = {
  id: auditEvents.id,
  teamId: auditEvents.teamId,
  actorType: auditEvents.actorType,
  actorRef: auditEvents.actorRef,
  surface: auditEvents.surface,
  action: auditEvents.action,
  category: auditEvents.category,
  targetType: auditEvents.targetType,
  targetId: auditEvents.targetId,
  revision: auditEvents.revision,
  outcome: auditEvents.outcome,
  detail: auditEvents.detail,
  purpose: auditEvents.purpose,
  createdAt: auditEvents.createdAt,
  settledAt: auditEvents.settledAt,
  actor: {
    id: users.id,
    fullName: users.fullName,
    email: users.email,
  },
};

export const AUDIT_PAGE_MAX = 100;

/**
 * The workspace's audit log, newest first, one page at a time. The cursor is
 * the last row's `createdAt` and `id`.
 */
export async function listAuditEvents(
  db: Pick<Database, "select">,
  params: {
    teamId: string;
    categories?: AuditCategory[];
    cursor?: { createdAt: string; id: string } | null;
    limit?: number;
  },
) {
  const limit = Math.min(Math.max(params.limit ?? 50, 1), AUDIT_PAGE_MAX);
  const rows = await db
    .select(listColumns)
    .from(auditEvents)
    .leftJoin(users, eq(users.id, auditEvents.actorUserId))
    .where(
      and(
        eq(auditEvents.teamId, params.teamId),
        params.categories?.length
          ? inArray(auditEvents.category, params.categories)
          : undefined,
        params.cursor
          ? or(
              lt(auditEvents.createdAt, params.cursor.createdAt),
              and(
                eq(auditEvents.createdAt, params.cursor.createdAt),
                lt(auditEvents.id, params.cursor.id),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    data: page,
    nextCursor:
      rows.length > limit && last
        ? { createdAt: last.createdAt, id: last.id }
        : null,
  };
}

/** Audit events about one invoice (at most `limit`, newest first). */
export async function listInvoiceAuditEvents(
  db: Pick<Database, "select">,
  params: { teamId: string; invoiceId: string; limit?: number },
) {
  return db
    .select(listColumns)
    .from(auditEvents)
    .leftJoin(users, eq(users.id, auditEvents.actorUserId))
    .where(
      and(
        eq(auditEvents.teamId, params.teamId),
        eq(auditEvents.targetType, "invoice"),
        eq(auditEvents.targetId, params.invoiceId),
      ),
    )
    .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
    .limit(Math.min(params.limit ?? 100, 200));
}

/** Operator actions, newest first; optionally for one workspace. */
export async function listOperatorAuditEvents(
  db: Pick<Database, "select">,
  params: { teamId?: string; limit?: number },
) {
  return db
    .select(listColumns)
    .from(auditEvents)
    .leftJoin(users, eq(users.id, auditEvents.actorUserId))
    .where(
      and(
        eq(auditEvents.actorType, "operator"),
        params.teamId ? eq(auditEvents.teamId, params.teamId) : undefined,
      ),
    )
    .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
    .limit(Math.min(params.limit ?? 50, AUDIT_PAGE_MAX));
}

/**
 * Retention: deletes audit events older than the cutoff, one batch at a
 * time (docs/data-lifecycle.md#retention-schedule).
 */
export async function deleteExpiredAuditEvents(
  db: Db,
  params: { before: Date; limit: number },
) {
  const due = lt(auditEvents.createdAt, params.before.toISOString());
  const candidates = db
    .select({ id: auditEvents.id })
    .from(auditEvents)
    .where(due)
    .limit(params.limit);
  return db
    .delete(auditEvents)
    .where(and(inArray(auditEvents.id, candidates), due))
    .returning({ id: auditEvents.id, teamId: auditEvents.teamId });
}
