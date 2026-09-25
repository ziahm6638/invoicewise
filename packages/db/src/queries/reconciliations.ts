import type { Database } from "@db/client";
import {
  authorizationSources,
  deliveryDecisions,
  inbox,
  invoiceReconciliations,
  invoiceSourceConsumption,
} from "@db/schema";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  notExists,
  or,
  sql,
} from "drizzle-orm";

/**
 * Reconciliation of invoices with their authorization sources
 * (docs/reconciliation.md): the immutable reconciliations, what each
 * consumes of a source, and the source's ledger. Every query is scoped by
 * `teamId`; nothing reads another workspace.
 */

type Executor = Pick<Database, "select" | "insert" | "update" | "delete">;

/**
 * Locks the sources an invoice is reconciled with, in a fixed order, so two
 * invoices billing the same source are reconciled one after the other and
 * each sees what the other consumes. Call after locking the invoice.
 */
export async function lockSourcesForReconciliation(
  db: Executor,
  params: { teamId: string; sourceIds: string[] },
) {
  if (params.sourceIds.length === 0) return [];
  return db
    .select({ id: authorizationSources.id })
    .from(authorizationSources)
    .where(
      and(
        eq(authorizationSources.teamId, params.teamId),
        inArray(authorizationSources.id, params.sourceIds),
      ),
    )
    .orderBy(asc(authorizationSources.id))
    .for("update");
}

/**
 * What the sources' invoices consume now: the rows of each invoice's current
 * reconciliation, when its match is confirmed, the invoice is live, it is
 * not a duplicate of an earlier document and its current revision was not
 * dismissed. `excludeInboxId` leaves out the invoice being reconciled.
 */
export async function listSourceConsumption(
  db: Pick<Database, "select">,
  params: { teamId: string; sourceIds: string[]; excludeInboxId?: string },
) {
  if (params.sourceIds.length === 0) return [];
  return db
    .select({
      sourceId: invoiceSourceConsumption.sourceId,
      inboxId: invoiceSourceConsumption.inboxId,
      sourceLineReference: invoiceSourceConsumption.sourceLineReference,
      amount: sql<string | null>`${invoiceSourceConsumption.amount}::text`,
      quantity: sql<string | null>`${invoiceSourceConsumption.quantity}::text`,
      currency: invoiceSourceConsumption.currency,
      basis: invoiceSourceConsumption.basis,
    })
    .from(invoiceSourceConsumption)
    .innerJoin(
      invoiceReconciliations,
      eq(invoiceReconciliations.id, invoiceSourceConsumption.reconciliationId),
    )
    .innerJoin(
      inbox,
      and(
        eq(inbox.id, invoiceSourceConsumption.inboxId),
        eq(inbox.reconciliationId, invoiceReconciliations.id),
      ),
    )
    .where(
      and(
        eq(invoiceSourceConsumption.teamId, params.teamId),
        inArray(invoiceSourceConsumption.sourceId, params.sourceIds),
        eq(invoiceReconciliations.consumes, true),
        eq(inbox.teamId, params.teamId),
        ne(inbox.status, "deleted"),
        or(isNull(inbox.intakeState), eq(inbox.intakeState, "accepted")),
        sql`(${inbox.validation} -> 'identity' ->> 'duplicateOf') is null`,
        notExists(
          db
            .select({ id: deliveryDecisions.id })
            .from(deliveryDecisions)
            .where(
              and(
                eq(deliveryDecisions.invoiceId, inbox.id),
                eq(deliveryDecisions.revision, inbox.processingRevision),
                eq(deliveryDecisions.resolution, "dismissed"),
              ),
            ),
        ),
        params.excludeInboxId
          ? ne(invoiceSourceConsumption.inboxId, params.excludeInboxId)
          : undefined,
      ),
    );
}

export type ReconciliationRow = typeof invoiceReconciliations.$inferSelect;

/** The reconciliation already recorded for a match at a revision, if any. */
export async function getReconciliationFor(
  db: Pick<Database, "select">,
  params: {
    teamId: string;
    inboxId: string;
    matchId: string;
    processingRevision: number;
  },
) {
  const [row] = await db
    .select()
    .from(invoiceReconciliations)
    .where(
      and(
        eq(invoiceReconciliations.teamId, params.teamId),
        eq(invoiceReconciliations.inboxId, params.inboxId),
        eq(invoiceReconciliations.matchId, params.matchId),
        eq(
          invoiceReconciliations.processingRevision,
          params.processingRevision,
        ),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function getReconciliation(
  db: Pick<Database, "select">,
  params: { teamId: string; id: string },
) {
  const [row] = await db
    .select()
    .from(invoiceReconciliations)
    .where(
      and(
        eq(invoiceReconciliations.id, params.id),
        eq(invoiceReconciliations.teamId, params.teamId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Every reconciliation of an invoice, newest first. */
export async function listReconciliationHistory(
  db: Pick<Database, "select">,
  params: { teamId: string; inboxId: string; limit?: number },
) {
  return db
    .select()
    .from(invoiceReconciliations)
    .where(
      and(
        eq(invoiceReconciliations.teamId, params.teamId),
        eq(invoiceReconciliations.inboxId, params.inboxId),
      ),
    )
    .orderBy(desc(invoiceReconciliations.sequence))
    .limit(params.limit ?? 50);
}

/**
 * Records a reconciliation with what it consumes and makes it the invoice's
 * current one. Call under the invoice's lock and its sources' locks.
 */
export async function recordReconciliation(
  db: Executor,
  params: {
    teamId: string;
    inboxId: string;
    matchId: string;
    processingRevision: number;
    status: "reconciled" | "discrepancy" | "unresolved" | "unmatched";
    consumes: boolean;
    result: Record<string, unknown>;
    rulesVersion: number;
    fingerprint: string;
    consumption: {
      sourceId: string;
      sourceLineReference: string | null;
      amount: string | null;
      quantity: string | null;
      currency: string | null;
      basis: "net" | "gross";
    }[];
  },
) {
  const [last] = await db
    .select({
      sequence: sql<number>`coalesce(max(${invoiceReconciliations.sequence}), 0)::int`,
    })
    .from(invoiceReconciliations)
    .where(eq(invoiceReconciliations.inboxId, params.inboxId));
  const [row] = await db
    .insert(invoiceReconciliations)
    .values({
      teamId: params.teamId,
      inboxId: params.inboxId,
      sequence: (last?.sequence ?? 0) + 1,
      matchId: params.matchId,
      processingRevision: params.processingRevision,
      status: params.status,
      consumes: params.consumes,
      result: params.result,
      rulesVersion: params.rulesVersion,
      fingerprint: params.fingerprint,
    })
    .returning();
  if (params.consumption.length) {
    await db.insert(invoiceSourceConsumption).values(
      params.consumption.map((item) => ({
        teamId: params.teamId,
        reconciliationId: row!.id,
        inboxId: params.inboxId,
        ...item,
      })),
    );
  }
  await db
    .update(inbox)
    .set({ reconciliationId: row!.id })
    .where(and(eq(inbox.id, params.inboxId), eq(inbox.teamId, params.teamId)));
  return row!;
}

/** Every reconciliation in a workspace with what it consumes, for the owner's export. */
export async function getReconciliationsForExport(
  db: Pick<Database, "select">,
  teamId: string,
) {
  const [reconciliations, consumption, current] = await Promise.all([
    db
      .select()
      .from(invoiceReconciliations)
      .where(eq(invoiceReconciliations.teamId, teamId))
      .orderBy(invoiceReconciliations.inboxId, invoiceReconciliations.sequence),
    db
      .select()
      .from(invoiceSourceConsumption)
      .where(eq(invoiceSourceConsumption.teamId, teamId)),
    db
      .select({ id: inbox.reconciliationId })
      .from(inbox)
      .where(and(eq(inbox.teamId, teamId), isNotNull(inbox.reconciliationId))),
  ]);
  return {
    reconciliations,
    consumption,
    currentIds: new Set(current.map((row) => row.id)),
  };
}
