import type { Database } from "@db/client";
import {
  authorizationSourceVersions,
  authorizationSources,
  inbox,
  invoiceReconciliations,
  invoiceSourceAllocations,
  invoiceSourceLinks,
  invoiceSourceMatches,
  suppliers,
  users,
} from "@db/schema";
import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

/**
 * Invoice ↔ authorization-source matching: the invoice as matching reads it,
 * the candidate sources of its own workspace, and the immutable decisions.
 * Every query is scoped by `teamId`; nothing reads another workspace.
 */

/** A live (accepted or legacy), processed invoice; reservations and deleted invoices never match. */
const liveInvoice = (teamId: string, inboxId: string) =>
  and(
    eq(inbox.id, inboxId),
    eq(inbox.teamId, teamId),
    ne(inbox.status, "deleted"),
    or(isNull(inbox.intakeState), eq(inbox.intakeState, "accepted")),
  );

const invoiceSupplier = alias(suppliers, "invoice_supplier");

const matchingInvoiceColumns = {
  id: inbox.id,
  status: inbox.status,
  extraction: inbox.extraction,
  validation: inbox.validation,
  processingRevision: inbox.processingRevision,
  sourceMatchId: inbox.sourceMatchId,
  reconciliationId: inbox.reconciliationId,
  createdAt: inbox.createdAt,
  // The canonical supplier (after merges); null when unresolved.
  supplierId: sql<
    string | null
  >`coalesce(${invoiceSupplier.mergedIntoId}, ${invoiceSupplier.id})`,
};

/** The invoice's extraction, canonical supplier and current decision. */
export async function getInvoiceForMatching(
  db: Database,
  params: { teamId: string; inboxId: string },
) {
  const [row] = await db
    .select(matchingInvoiceColumns)
    .from(inbox)
    .leftJoin(invoiceSupplier, eq(invoiceSupplier.id, inbox.supplierId))
    .where(liveInvoice(params.teamId, params.inboxId))
    .limit(1);
  return row ?? null;
}

/**
 * Locks the invoice row for a new decision, so two decisions for one invoice
 * are numbered and made current one at a time.
 */
export async function lockInvoiceForMatching(
  db: Database,
  params: { teamId: string; inboxId: string },
) {
  const [locked] = await db
    .select({ id: inbox.id })
    .from(inbox)
    .where(liveInvoice(params.teamId, params.inboxId))
    .for("update");
  if (!locked) return null;
  return getInvoiceForMatching(db, params);
}

export async function workspaceHasAuthorizationSources(
  db: Database,
  teamId: string,
) {
  const [row] = await db
    .select({ id: authorizationSources.id })
    .from(authorizationSources)
    .where(eq(authorizationSources.teamId, teamId))
    .limit(1);
  return Boolean(row);
}

/**
 * The workspace's sources an invoice could bill, found three bounded ways:
 * a printed reference (whole, or its number without leading letters), the
 * invoice's supplier, and sources with no linked supplier (compared by their
 * supplied identifiers afterwards). Only this workspace's rows are read.
 */
export async function findMatchCandidateSourceIds(
  db: Database,
  params: {
    teamId: string;
    keys: string[];
    numberKeys: string[];
    supplierId: string | null;
    limits: { supplierSources: number; unlinkedSources: number };
  },
) {
  const byReference =
    params.keys.length || params.numberKeys.length
      ? await db
          .select({ id: authorizationSources.id })
          .from(authorizationSources)
          .where(
            and(
              eq(authorizationSources.teamId, params.teamId),
              or(
                params.keys.length
                  ? inArray(authorizationSources.referenceKey, params.keys)
                  : undefined,
                params.numberKeys.length
                  ? inArray(
                      sql<string>`regexp_replace(${authorizationSources.referenceKey}, '^[A-Z]+', '')`,
                      params.numberKeys,
                    )
                  : undefined,
              ),
            ),
          )
          .limit(50)
      : [];
  const linked = alias(suppliers, "linked_supplier");
  const bySupplier = params.supplierId
    ? await db
        .select({ id: authorizationSources.id })
        .from(authorizationSources)
        .innerJoin(linked, eq(linked.id, authorizationSources.supplierId))
        .where(
          and(
            eq(authorizationSources.teamId, params.teamId),
            ne(authorizationSources.status, "cancelled"),
            sql`coalesce(${linked.mergedIntoId}, ${linked.id}) = ${params.supplierId}`,
          ),
        )
        .orderBy(desc(authorizationSources.updatedAt))
        .limit(params.limits.supplierSources)
    : [];
  const unlinked = await db
    .select({ id: authorizationSources.id })
    .from(authorizationSources)
    .where(
      and(
        eq(authorizationSources.teamId, params.teamId),
        ne(authorizationSources.status, "cancelled"),
        isNull(authorizationSources.supplierId),
      ),
    )
    .orderBy(desc(authorizationSources.updatedAt))
    .limit(params.limits.unlinkedSources);
  return {
    byReference: byReference.map((row) => row.id),
    bySupplier: bySupplier.map((row) => row.id),
    unlinked: unlinked.map((row) => row.id),
  };
}

const linkedSupplier = alias(suppliers, "version_supplier");
const canonicalSupplier = alias(suppliers, "version_canonical_supplier");

const matchVersionColumns = {
  id: authorizationSourceVersions.id,
  sourceId: authorizationSourceVersions.sourceId,
  version: authorizationSourceVersions.version,
  status: authorizationSourceVersions.status,
  title: authorizationSourceVersions.title,
  scope: authorizationSourceVersions.scope,
  supplierName: authorizationSourceVersions.supplierName,
  supplierVatNumber: authorizationSourceVersions.supplierVatNumber,
  supplierCompanyNumber: authorizationSourceVersions.supplierCompanyNumber,
  linkedSupplierId: canonicalSupplier.id,
  linkedSupplierName: canonicalSupplier.name,
  linkedSupplierNameKey: canonicalSupplier.nameKey,
  linkedSupplierVatKey: canonicalSupplier.vatKey,
  linkedSupplierCompanyKey: canonicalSupplier.companyKey,
  currency: authorizationSourceVersions.currency,
  taxBasis: authorizationSourceVersions.taxBasis,
  issuedOn: authorizationSourceVersions.issuedOn,
  startsOn: authorizationSourceVersions.startsOn,
  endsOn: authorizationSourceVersions.endsOn,
  effectiveFrom: authorizationSourceVersions.effectiveFrom,
  authorizedTotal: authorizationSourceVersions.authorizedTotal,
  lineItems: authorizationSourceVersions.lineItems,
};

const selectMatchVersions = (db: Database) =>
  db
    .select(matchVersionColumns)
    .from(authorizationSourceVersions)
    .leftJoin(
      linkedSupplier,
      eq(linkedSupplier.id, authorizationSourceVersions.supplierId),
    )
    .leftJoin(
      canonicalSupplier,
      eq(
        canonicalSupplier.id,
        sql`coalesce(${linkedSupplier.mergedIntoId}, ${linkedSupplier.id})`,
      ),
    )
    .$dynamic();

/**
 * Each source with the version in effect on `on` (as recorded by `asOf`) and
 * its current version, with the linked supplier's identifiers.
 */
export async function getMatchSources(
  db: Database,
  params: { teamId: string; sourceIds: string[]; on: string; asOf: string },
) {
  if (params.sourceIds.length === 0) return [];
  const heads = await db
    .select({
      id: authorizationSources.id,
      type: authorizationSources.sourceType,
      reference: authorizationSources.reference,
      referenceKey: authorizationSources.referenceKey,
      currentVersionId: authorizationSources.currentVersionId,
    })
    .from(authorizationSources)
    .where(
      and(
        eq(authorizationSources.teamId, params.teamId),
        inArray(authorizationSources.id, params.sourceIds),
      ),
    );
  if (heads.length === 0) return [];
  const ids = heads.map((head) => head.id);
  const [current, effective] = await Promise.all([
    selectMatchVersions(db).where(
      and(
        eq(authorizationSourceVersions.teamId, params.teamId),
        inArray(
          authorizationSourceVersions.id,
          heads
            .map((head) => head.currentVersionId)
            .filter((id): id is string => id !== null),
        ),
      ),
    ),
    // The newest version in effect on the date, among those recorded by asOf.
    selectMatchVersions(db).where(
      and(
        eq(authorizationSourceVersions.teamId, params.teamId),
        inArray(authorizationSourceVersions.sourceId, ids),
        lte(authorizationSourceVersions.effectiveFrom, params.on),
        lte(authorizationSourceVersions.createdAt, params.asOf),
        sql`${authorizationSourceVersions.version} = (
          select max(later.version) from ${authorizationSourceVersions} as later
          where later.source_id = ${authorizationSourceVersions.sourceId}
            and later.effective_from <= ${params.on}
            and later.created_at <= ${params.asOf}
        )`,
      ),
    ),
  ]);
  return heads.flatMap((head) => {
    const currentVersion = current.find((row) => row.sourceId === head.id);
    if (!currentVersion) return [];
    return [
      {
        ...head,
        current: currentVersion,
        effective: effective.find((row) => row.sourceId === head.id) ?? null,
      },
    ];
  });
}

/** Specific versions of the workspace's sources, for a manual link. */
export async function getMatchSourceVersions(
  db: Database,
  params: { teamId: string; versionIds: string[] },
) {
  if (params.versionIds.length === 0) return [];
  return selectMatchVersions(db).where(
    and(
      eq(authorizationSourceVersions.teamId, params.teamId),
      inArray(authorizationSourceVersions.id, params.versionIds),
    ),
  );
}

export type MatchSourceVersionRow = Awaited<
  ReturnType<typeof getMatchSourceVersions>
>[number];

// --- Decisions -------------------------------------------------------------------

export type SourceMatchRow = typeof invoiceSourceMatches.$inferSelect;

export async function getSourceMatch(
  db: Database,
  params: { teamId: string; matchId: string },
) {
  const [row] = await db
    .select()
    .from(invoiceSourceMatches)
    .where(
      and(
        eq(invoiceSourceMatches.id, params.matchId),
        eq(invoiceSourceMatches.teamId, params.teamId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Every decision about an invoice, newest first, with who made it. */
export async function listSourceMatchHistory(
  db: Database,
  params: { teamId: string; inboxId: string; limit?: number },
) {
  return db
    .select({
      id: invoiceSourceMatches.id,
      sequence: invoiceSourceMatches.sequence,
      status: invoiceSourceMatches.status,
      origin: invoiceSourceMatches.origin,
      action: invoiceSourceMatches.action,
      method: invoiceSourceMatches.method,
      result: invoiceSourceMatches.result,
      reason: invoiceSourceMatches.reason,
      processingRevision: invoiceSourceMatches.processingRevision,
      rulesVersion: invoiceSourceMatches.rulesVersion,
      actorName: users.fullName,
      createdAt: invoiceSourceMatches.createdAt,
    })
    .from(invoiceSourceMatches)
    .leftJoin(users, eq(users.id, invoiceSourceMatches.actorId))
    .where(
      and(
        eq(invoiceSourceMatches.teamId, params.teamId),
        eq(invoiceSourceMatches.inboxId, params.inboxId),
      ),
    )
    .orderBy(desc(invoiceSourceMatches.sequence))
    .limit(params.limit ?? 50);
}

export type NewSourceMatchLink = {
  sourceId: string;
  versionId: string;
  allocations: {
    sourceLineReference: string | null;
    invoiceLineIndex: number | null;
    amount: string | null;
    currency: string | null;
    basis: string;
  }[];
};

/**
 * Records a decision with its links and allocations and makes it the
 * invoice's current one. Call under `lockInvoiceForMatching`.
 */
export async function recordSourceMatch(
  db: Database,
  params: {
    teamId: string;
    inboxId: string;
    status: string;
    origin: "automatic" | "manual";
    action: string;
    method: string | null;
    result: Record<string, unknown>;
    reason: string | null;
    processingRevision: number | null;
    rulesVersion: number;
    fingerprint: string;
    actorId: string | null;
    links: NewSourceMatchLink[];
  },
) {
  const [last] = await db
    .select({
      sequence: sql<number>`coalesce(max(${invoiceSourceMatches.sequence}), 0)::int`,
    })
    .from(invoiceSourceMatches)
    .where(eq(invoiceSourceMatches.inboxId, params.inboxId));
  const [match] = await db
    .insert(invoiceSourceMatches)
    .values({
      teamId: params.teamId,
      inboxId: params.inboxId,
      sequence: (last?.sequence ?? 0) + 1,
      status: params.status,
      origin: params.origin,
      action: params.action,
      method: params.method,
      result: params.result,
      reason: params.reason,
      processingRevision: params.processingRevision,
      rulesVersion: params.rulesVersion,
      fingerprint: params.fingerprint,
      actorId: params.actorId,
    })
    .returning();
  for (const link of params.links) {
    const [row] = await db
      .insert(invoiceSourceLinks)
      .values({
        teamId: params.teamId,
        matchId: match!.id,
        inboxId: params.inboxId,
        sourceId: link.sourceId,
        versionId: link.versionId,
      })
      .returning({ id: invoiceSourceLinks.id });
    if (link.allocations.length) {
      await db.insert(invoiceSourceAllocations).values(
        link.allocations.map((allocation) => ({
          teamId: params.teamId,
          linkId: row!.id,
          ...allocation,
        })),
      );
    }
  }
  await db
    .update(inbox)
    .set({ sourceMatchId: match!.id })
    .where(and(eq(inbox.id, params.inboxId), eq(inbox.teamId, params.teamId)));
  return match!;
}

/**
 * The invoices currently matched to a source (their current decision links
 * it), newest first, with what each allocates to it.
 */
export async function listSourceInvoiceMatches(
  db: Database,
  params: { teamId: string; sourceId: string; limit?: number },
) {
  const allocated = db
    .select({
      linkId: invoiceSourceAllocations.linkId,
      amount: sql<
        string | null
      >`case when count(*) = count(${invoiceSourceAllocations.amount}) then sum(${invoiceSourceAllocations.amount})::text end`.as(
        "allocated_amount",
      ),
      lines:
        sql<number>`count(${invoiceSourceAllocations.invoiceLineIndex})::int`.as(
          "allocated_lines",
        ),
    })
    .from(invoiceSourceAllocations)
    .where(eq(invoiceSourceAllocations.teamId, params.teamId))
    .groupBy(invoiceSourceAllocations.linkId)
    .as("allocated");
  return db
    .select({
      invoiceId: inbox.id,
      displayName: inbox.displayName,
      invoiceNumber: sql<
        string | null
      >`${inbox.extraction} ->> 'invoiceNumber'`,
      invoiceDate: sql<string | null>`${inbox.extraction} ->> 'invoiceDate'`,
      documentType: sql<string | null>`${inbox.extraction} ->> 'documentType'`,
      amount: inbox.amount,
      currency: inbox.currency,
      matchId: invoiceSourceMatches.id,
      status: invoiceSourceMatches.status,
      origin: invoiceSourceMatches.origin,
      method: invoiceSourceMatches.method,
      needsConfirmation: sql<boolean>`coalesce((${invoiceSourceMatches.result} ->> 'needsConfirmation')::boolean, false)`,
      versionId: invoiceSourceLinks.versionId,
      version: authorizationSourceVersions.version,
      allocatedAmount: allocated.amount,
      allocatedLines: sql<number>`coalesce(${allocated.lines}, 0)`,
      decidedAt: invoiceSourceMatches.createdAt,
      // The invoice's current reconciliation and what it consumes of this
      // source (docs/reconciliation.md); null until reconciled.
      reconciliationStatus: invoiceReconciliations.status,
      consumedAmount: sql<string | null>`(
        select case when count(*) > 0 and count(*) = count(c.amount) then sum(c.amount)::text end
        from invoice_source_consumption c
        where c.reconciliation_id = ${inbox.reconciliationId}
          and c.source_id = ${invoiceSourceLinks.sourceId}
      )`,
    })
    .from(invoiceSourceLinks)
    .innerJoin(
      invoiceSourceMatches,
      eq(invoiceSourceMatches.id, invoiceSourceLinks.matchId),
    )
    .innerJoin(
      inbox,
      and(
        eq(inbox.id, invoiceSourceLinks.inboxId),
        eq(inbox.sourceMatchId, invoiceSourceLinks.matchId),
      ),
    )
    .innerJoin(
      authorizationSourceVersions,
      eq(authorizationSourceVersions.id, invoiceSourceLinks.versionId),
    )
    .leftJoin(allocated, eq(allocated.linkId, invoiceSourceLinks.id))
    .leftJoin(
      invoiceReconciliations,
      eq(invoiceReconciliations.id, inbox.reconciliationId),
    )
    .where(
      and(
        eq(invoiceSourceLinks.teamId, params.teamId),
        eq(invoiceSourceLinks.sourceId, params.sourceId),
        eq(inbox.teamId, params.teamId),
        ne(inbox.status, "deleted"),
        or(isNull(inbox.intakeState), eq(inbox.intakeState, "accepted")),
      ),
    )
    .orderBy(desc(invoiceSourceMatches.createdAt))
    .limit(params.limit ?? 200);
}

/** Every decision in a workspace with its links and allocations, for the owner's export. */
export async function getSourceMatchesForExport(db: Database, teamId: string) {
  const [matches, links, allocations, current] = await Promise.all([
    db
      .select()
      .from(invoiceSourceMatches)
      .where(eq(invoiceSourceMatches.teamId, teamId))
      .orderBy(invoiceSourceMatches.inboxId, invoiceSourceMatches.sequence),
    db
      .select()
      .from(invoiceSourceLinks)
      .where(eq(invoiceSourceLinks.teamId, teamId)),
    db
      .select()
      .from(invoiceSourceAllocations)
      .where(eq(invoiceSourceAllocations.teamId, teamId)),
    db
      .select({ id: inbox.sourceMatchId })
      .from(inbox)
      .where(and(eq(inbox.teamId, teamId), isNotNull(inbox.sourceMatchId))),
  ]);
  return {
    matches,
    links,
    allocations,
    currentIds: new Set(current.map((row) => row.id)),
  };
}
