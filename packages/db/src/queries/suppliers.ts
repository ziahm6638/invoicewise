import type { Database } from "@db/client";
import {
  inbox,
  inboxRedeliveries,
  supplierEvents,
  suppliers,
  users,
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
  or,
  sql,
} from "drizzle-orm";
import {
  documentNumberKeys,
  documentNumberOf,
  liveDocumentsReceived,
} from "./inbox";

/** The supplier a record now belongs to: the one it was merged into, else itself. */
const canonicalOf = sql<string>`coalesce(${suppliers.mergedIntoId}, ${suppliers.id})`;

export type SupplierIdentityRow = {
  id: string;
  canonicalId: string;
  nameKey: string;
  vatKey: string | null;
  companyKey: string | null;
};

/**
 * Every supplier record in each canonical supplier that carries one of the
 * given identifiers, so resolution sees all of a merged supplier's numbers.
 */
export async function findSupplierCandidates(
  db: Database,
  params: {
    teamId: string;
    nameKey: string;
    vatKey: string;
    companyKey: string;
  },
): Promise<SupplierIdentityRow[]> {
  const matches = [
    params.nameKey ? eq(suppliers.nameKey, params.nameKey) : undefined,
    params.vatKey ? eq(suppliers.vatKey, params.vatKey) : undefined,
    params.companyKey ? eq(suppliers.companyKey, params.companyKey) : undefined,
  ].filter((condition) => condition !== undefined);
  if (matches.length === 0) return [];
  const matched = db
    .select({ id: canonicalOf })
    .from(suppliers)
    .where(and(eq(suppliers.teamId, params.teamId), or(...matches)));
  return db
    .select({
      id: suppliers.id,
      canonicalId: canonicalOf,
      nameKey: suppliers.nameKey,
      vatKey: suppliers.vatKey,
      companyKey: suppliers.companyKey,
    })
    .from(suppliers)
    .where(
      and(eq(suppliers.teamId, params.teamId), inArray(canonicalOf, matched)),
    );
}

export async function createSupplier(
  db: Database,
  params: {
    teamId: string;
    name: string;
    nameKey: string;
    vatKey?: string | null;
    companyKey?: string | null;
  },
) {
  const [row] = await db
    .insert(suppliers)
    .values({
      teamId: params.teamId,
      name: params.name,
      nameKey: params.nameKey,
      vatKey: params.vatKey || null,
      companyKey: params.companyKey || null,
    })
    .returning({ id: suppliers.id });
  return row!.id;
}

/** Records identifiers a supplier did not have yet; a number it already holds is never replaced. */
export async function learnSupplierIdentifiers(
  db: Database,
  params: {
    teamId: string;
    supplierId: string;
    vatKey?: string;
    companyKey?: string;
  },
) {
  if (!params.vatKey && !params.companyKey) return;
  await db
    .update(suppliers)
    .set({
      ...(params.vatKey
        ? { vatKey: sql`coalesce(${suppliers.vatKey}, ${params.vatKey})` }
        : {}),
      ...(params.companyKey
        ? {
            companyKey: sql`coalesce(${suppliers.companyKey}, ${params.companyKey})`,
          }
        : {}),
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(suppliers.id, params.supplierId),
        eq(suppliers.teamId, params.teamId),
      ),
    );
}

/** The canonical supplier of a supplier id in this workspace, or null. */
export async function getCanonicalSupplier(
  db: Database,
  params: { teamId: string; supplierId: string },
) {
  const [row] = await db
    .select({ canonicalId: canonicalOf })
    .from(suppliers)
    .where(
      and(
        eq(suppliers.id, params.supplierId),
        eq(suppliers.teamId, params.teamId),
      ),
    )
    .limit(1);
  if (!row) return null;
  const [canonical] = await db
    .select({
      id: suppliers.id,
      name: suppliers.name,
      vatKey: suppliers.vatKey,
      companyKey: suppliers.companyKey,
    })
    .from(suppliers)
    .where(
      and(
        eq(suppliers.id, row.canonicalId),
        eq(suppliers.teamId, params.teamId),
      ),
    )
    .limit(1);
  return canonical ?? null;
}

/** A document's supplier assignment and what its checks are computed from. */
export async function getInboxSupplierState(
  db: Database,
  params: { teamId: string; inboxId: string },
) {
  const [row] = await db
    .select({
      id: inbox.id,
      extraction: inbox.extraction,
      validation: inbox.validation,
      supplierId: inbox.supplierId,
      supplierResolution: inbox.supplierResolution,
      supplierChecks: inbox.supplierChecks,
      accountingProviderId: inbox.accountingProviderId,
      status: inbox.status,
    })
    .from(inbox)
    .where(and(eq(inbox.id, params.inboxId), eq(inbox.teamId, params.teamId)))
    .limit(1);
  return row ?? null;
}

export async function setInboxSupplier(
  db: Database,
  params: {
    teamId: string;
    inboxId: string;
    supplierId: string | null;
    /** Null leaves the document to be resolved again on its next check. */
    resolution: Record<string, unknown> | null;
  },
) {
  await db
    .update(inbox)
    .set({
      supplierId: params.supplierId,
      supplierResolution: params.resolution,
    })
    .where(and(eq(inbox.id, params.inboxId), eq(inbox.teamId, params.teamId)));
}

export async function setInboxSupplierChecks(
  db: Database,
  params: {
    teamId: string;
    inboxId: string;
    checks: Record<string, unknown>;
  },
) {
  await db
    .update(inbox)
    .set({ supplierChecks: params.checks })
    .where(and(eq(inbox.id, params.inboxId), eq(inbox.teamId, params.teamId)));
}

/**
 * Processed live documents no supplier was resolved for yet (received before
 * supplier identity existed), oldest first, so history is assigned in the
 * order it was received.
 */
export async function listDocumentsWithoutSupplier(
  db: Database,
  params: { teamId: string; excludeId: string; limit: number },
) {
  return db
    .select({ id: inbox.id, extraction: inbox.extraction })
    .from(inbox)
    .where(
      and(
        eq(inbox.teamId, params.teamId),
        ne(inbox.id, params.excludeId),
        ne(inbox.status, "deleted"),
        or(isNull(inbox.intakeState), eq(inbox.intakeState, "accepted")),
        isNotNull(inbox.extraction),
        isNull(inbox.supplierResolution),
      ),
    )
    .orderBy(asc(inbox.createdAt), asc(inbox.id))
    .limit(params.limit);
}

/** Documents assigned to any supplier record of this canonical supplier. */
const ofSupplier = (teamId: string, canonicalId: string) =>
  inArray(
    inbox.supplierId,
    sql`(select ${suppliers.id} from ${suppliers} where ${suppliers.teamId} = ${teamId} and (${suppliers.id} = ${canonicalId} or ${suppliers.mergedIntoId} = ${canonicalId}))`,
  );

const historyColumns = {
  id: inbox.id,
  extraction: inbox.extraction,
  receivedAt: inbox.createdAt,
};

const bankText = (field: string) =>
  sql`coalesce(${inbox.extraction} -> 'bankDetails' ->> ${field}::text, '')`;

export type SupplierHistoryQuery = {
  teamId: string;
  documentId: string;
  /** The canonical supplier. */
  supplierId: string;
  /** Document numbers to look for (its own and the one it credits). */
  numbers: string[];
  grossAmount: number | null;
  invoiceDate: string | null;
  iban: string | null;
  ukAccount: string | null;
  limits: {
    recent: number;
    sameNumber: number;
    sameDateAndTotal: number;
    withBankDetails: number;
    sameBankDetails: number;
  };
};

/**
 * The supplier's earlier documents that its checks need, newest first: its
 * most recent documents, and — however far back — any with the same number,
 * the same date and total, the latest ones with bank details and the first
 * ones with these exact bank details. Each part is bounded and scoped to one
 * workspace and one supplier.
 */
export async function getSupplierHistory(
  db: Database,
  params: SupplierHistoryQuery,
) {
  const base = and(
    liveDocumentsReceived("before", params.teamId, params.documentId),
    ofSupplier(params.teamId, params.supplierId),
  );
  const parts = [
    db
      .select(historyColumns)
      .from(inbox)
      .where(base)
      .orderBy(desc(inbox.createdAt), desc(inbox.id))
      .limit(params.limits.recent),
  ];
  const keys = documentNumberKeys(params.numbers);
  if (keys.length > 0) {
    parts.push(
      db
        .select(historyColumns)
        .from(inbox)
        .where(
          and(
            base,
            or(
              inArray(documentNumberOf("invoiceNumber"), keys),
              inArray(documentNumberOf("originalInvoiceNumber"), keys),
            ),
          ),
        )
        .orderBy(desc(inbox.createdAt), desc(inbox.id))
        .limit(params.limits.sameNumber),
    );
  }
  if (params.grossAmount !== null && params.invoiceDate) {
    const gross = Math.abs(params.grossAmount);
    parts.push(
      db
        .select(historyColumns)
        .from(inbox)
        .where(
          and(
            base,
            sql`${inbox.extraction} ->> 'invoiceDate' = ${params.invoiceDate}`,
            sql`jsonb_typeof(${inbox.extraction} -> 'grossAmount') = 'number'`,
            sql`abs((${inbox.extraction} ->> 'grossAmount')::numeric) = ${gross}`,
          ),
        )
        .orderBy(desc(inbox.createdAt), desc(inbox.id))
        .limit(params.limits.sameDateAndTotal),
    );
  }
  parts.push(
    db
      .select(historyColumns)
      .from(inbox)
      .where(
        and(
          base,
          or(
            sql`${bankText("iban")} <> ''`,
            sql`${bankText("accountNumber")} <> ''`,
          ),
        ),
      )
      .orderBy(desc(inbox.createdAt), desc(inbox.id))
      .limit(params.limits.withBankDetails),
  );
  const sameBank = [
    params.iban
      ? sql`upper(regexp_replace(${bankText("iban")}, '[^A-Za-z0-9]', '', 'g')) = ${params.iban}`
      : undefined,
    params.ukAccount
      ? sql`regexp_replace(${bankText("sortCode")}, '[^0-9]', '', 'g') || ':' || regexp_replace(${bankText("accountNumber")}, '[^0-9]', '', 'g') = ${params.ukAccount}`
      : undefined,
  ].filter((condition) => condition !== undefined);
  if (sameBank.length > 0) {
    parts.push(
      db
        .select(historyColumns)
        .from(inbox)
        .where(and(base, or(...sameBank)))
        .orderBy(asc(inbox.createdAt), asc(inbox.id))
        .limit(params.limits.sameBankDetails),
    );
  }

  const byId = new Map<
    string,
    { id: string; extraction: unknown; receivedAt: string }
  >();
  for (const part of parts) {
    for (const row of await part) byId.set(row.id, row);
  }
  return [...byId.values()].sort((a, b) =>
    a.receivedAt === b.receivedAt
      ? b.id.localeCompare(a.id)
      : b.receivedAt.localeCompare(a.receivedAt),
  );
}

/** How many earlier documents the supplier has, and the first of them. */
export async function getSupplierHistorySummary(
  db: Database,
  params: { teamId: string; documentId: string; supplierId: string },
) {
  const base = and(
    liveDocumentsReceived("before", params.teamId, params.documentId),
    ofSupplier(params.teamId, params.supplierId),
  );
  const [count] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(inbox)
    .where(base);
  const [first] = await db
    .select(historyColumns)
    .from(inbox)
    .where(base)
    .orderBy(asc(inbox.createdAt), asc(inbox.id))
    .limit(1);
  return { count: count?.count ?? 0, first: first ?? null };
}

// --- Reads for the dashboard and API -------------------------------------------

/** Canonical suppliers with how many live documents they hold. */
export async function listSuppliers(db: Database, teamId: string) {
  const [rows, counts] = await Promise.all([
    db
      .select({
        id: suppliers.id,
        name: suppliers.name,
        vatKey: suppliers.vatKey,
        companyKey: suppliers.companyKey,
      })
      .from(suppliers)
      .where(and(eq(suppliers.teamId, teamId), isNull(suppliers.mergedIntoId)))
      .orderBy(asc(suppliers.name), asc(suppliers.id)),
    db
      .select({
        supplierId: canonicalOf,
        count: sql<number>`count(*)::int`,
      })
      .from(inbox)
      .innerJoin(suppliers, eq(suppliers.id, inbox.supplierId))
      .where(and(eq(inbox.teamId, teamId), ne(inbox.status, "deleted")))
      .groupBy(canonicalOf),
  ]);
  const byId = new Map(counts.map((row) => [row.supplierId, row.count]));
  return rows.map((row) => ({ ...row, invoiceCount: byId.get(row.id) ?? 0 }));
}

/** A canonical supplier and the supplier records merged into it. */
export async function getSupplierWithMembers(
  db: Database,
  params: { teamId: string; supplierId: string },
) {
  const canonical = await getCanonicalSupplier(db, params);
  if (!canonical) return null;
  const members = await db
    .select({
      id: suppliers.id,
      name: suppliers.name,
      vatKey: suppliers.vatKey,
      companyKey: suppliers.companyKey,
    })
    .from(suppliers)
    .where(
      and(
        eq(suppliers.teamId, params.teamId),
        eq(suppliers.mergedIntoId, canonical.id),
      ),
    )
    .orderBy(asc(suppliers.name));
  return { ...canonical, members };
}

/** Summaries of earlier documents cited as evidence, for display. */
export async function getInvoiceSummaries(
  db: Database,
  params: { teamId: string; ids: string[] },
) {
  if (params.ids.length === 0) return [];
  return db
    .select({
      id: inbox.id,
      status: inbox.status,
      receivedAt: inbox.createdAt,
      documentType: sql<string | null>`${inbox.extraction} ->> 'documentType'`,
      invoiceNumber: sql<
        string | null
      >`${inbox.extraction} ->> 'invoiceNumber'`,
      invoiceDate: sql<string | null>`${inbox.extraction} ->> 'invoiceDate'`,
      supplierName: sql<string | null>`${inbox.extraction} ->> 'supplierName'`,
      currency: sql<string | null>`${inbox.extraction} ->> 'currency'`,
      grossAmount: sql<
        number | null
      >`case when jsonb_typeof(${inbox.extraction} -> 'grossAmount') = 'number' then (${inbox.extraction} ->> 'grossAmount')::float8 end`,
    })
    .from(inbox)
    .where(and(eq(inbox.teamId, params.teamId), inArray(inbox.id, params.ids)));
}

export async function listSupplierEvents(
  db: Database,
  params: { teamId: string; supplierIds: string[]; inboxId?: string },
) {
  const scope = [
    params.supplierIds.length > 0
      ? inArray(supplierEvents.supplierId, params.supplierIds)
      : undefined,
    params.supplierIds.length > 0
      ? inArray(supplierEvents.targetSupplierId, params.supplierIds)
      : undefined,
    params.inboxId ? eq(supplierEvents.inboxId, params.inboxId) : undefined,
  ].filter((condition) => condition !== undefined);
  if (scope.length === 0) return [];
  return db
    .select({
      id: supplierEvents.id,
      action: supplierEvents.action,
      supplierId: supplierEvents.supplierId,
      targetSupplierId: supplierEvents.targetSupplierId,
      inboxId: supplierEvents.inboxId,
      data: supplierEvents.data,
      revertsEventId: supplierEvents.revertsEventId,
      revertedAt: supplierEvents.revertedAt,
      createdAt: supplierEvents.createdAt,
      actor: { id: users.id, fullName: users.fullName, email: users.email },
    })
    .from(supplierEvents)
    .leftJoin(users, eq(users.id, supplierEvents.actorId))
    .where(and(eq(supplierEvents.teamId, params.teamId), or(...scope)))
    .orderBy(desc(supplierEvents.createdAt))
    .limit(50);
}

// --- Corrections -----------------------------------------------------------------

export async function recordSupplierEvent(
  db: Database,
  params: {
    teamId: string;
    action: "assign_invoice" | "merge" | "revert";
    supplierId?: string | null;
    targetSupplierId?: string | null;
    inboxId?: string | null;
    actorId: string | null;
    data: Record<string, unknown>;
    revertsEventId?: string | null;
  },
) {
  const [row] = await db
    .insert(supplierEvents)
    .values({
      teamId: params.teamId,
      action: params.action,
      supplierId: params.supplierId ?? null,
      targetSupplierId: params.targetSupplierId ?? null,
      inboxId: params.inboxId ?? null,
      actorId: params.actorId,
      data: params.data,
      revertsEventId: params.revertsEventId ?? null,
    })
    .returning({ id: supplierEvents.id, createdAt: supplierEvents.createdAt });
  return row!;
}

export async function getSupplierEventForUpdate(
  db: Database,
  params: { teamId: string; eventId: string },
) {
  const [row] = await db
    .select()
    .from(supplierEvents)
    .where(
      and(
        eq(supplierEvents.id, params.eventId),
        eq(supplierEvents.teamId, params.teamId),
      ),
    )
    .limit(1)
    .for("update");
  return row ?? null;
}

export async function markSupplierEventReverted(
  db: Database,
  params: { teamId: string; eventId: string },
) {
  await db
    .update(supplierEvents)
    .set({ revertedAt: sql`now()` })
    .where(
      and(
        eq(supplierEvents.id, params.eventId),
        eq(supplierEvents.teamId, params.teamId),
      ),
    );
}

/**
 * Merges one canonical supplier into another. Records already merged into
 * the source move with it (and are listed, so an unmerge can restore them).
 */
export async function mergeSupplierRecords(
  db: Database,
  params: { teamId: string; sourceId: string; targetId: string },
) {
  const moved = await db
    .update(suppliers)
    .set({ mergedIntoId: params.targetId, updatedAt: sql`now()` })
    .where(
      and(
        eq(suppliers.teamId, params.teamId),
        eq(suppliers.mergedIntoId, params.sourceId),
      ),
    )
    .returning({ id: suppliers.id });
  await db
    .update(suppliers)
    .set({ mergedIntoId: params.targetId, updatedAt: sql`now()` })
    .where(
      and(
        eq(suppliers.teamId, params.teamId),
        eq(suppliers.id, params.sourceId),
      ),
    );
  return moved.map((row) => row.id);
}

/** Undoes a merge: the source is canonical again and takes back the records it held. */
export async function unmergeSupplierRecords(
  db: Database,
  params: {
    teamId: string;
    sourceId: string;
    targetId: string;
    movedIds: string[];
  },
) {
  await db
    .update(suppliers)
    .set({ mergedIntoId: null, updatedAt: sql`now()` })
    .where(
      and(
        eq(suppliers.teamId, params.teamId),
        eq(suppliers.id, params.sourceId),
        eq(suppliers.mergedIntoId, params.targetId),
      ),
    );
  if (params.movedIds.length > 0) {
    await db
      .update(suppliers)
      .set({ mergedIntoId: params.sourceId, updatedAt: sql`now()` })
      .where(
        and(
          eq(suppliers.teamId, params.teamId),
          inArray(suppliers.id, params.movedIds),
          eq(suppliers.mergedIntoId, params.targetId),
        ),
      );
  }
}

export async function getSupplierRecord(
  db: Database,
  params: { teamId: string; supplierId: string },
) {
  const [row] = await db
    .select()
    .from(suppliers)
    .where(
      and(
        eq(suppliers.id, params.supplierId),
        eq(suppliers.teamId, params.teamId),
      ),
    )
    .limit(1);
  return row ?? null;
}

// --- Re-deliveries -------------------------------------------------------------------

/**
 * Records that an accepted document was received again with identical bytes.
 * Replaying the same provider reference (a mailbox re-sync, a webhook retry)
 * or the document's own reference is not a new occurrence.
 */
export async function recordInboxRedelivery(
  db: Database,
  params: {
    teamId: string;
    inboxId: string;
    referenceId?: string | null;
    inboxAccountId?: string | null;
    fileName?: string | null;
  },
) {
  if (params.referenceId) {
    const [own] = await db
      .select({ id: inbox.id })
      .from(inbox)
      .where(
        and(
          eq(inbox.teamId, params.teamId),
          eq(inbox.referenceId, params.referenceId),
        ),
      )
      .limit(1);
    if (own) return null;
  }
  const [row] = await db
    .insert(inboxRedeliveries)
    .values({
      teamId: params.teamId,
      inboxId: params.inboxId,
      referenceId: params.referenceId ?? null,
      inboxAccountId: params.inboxAccountId ?? null,
      fileName: params.fileName ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: inboxRedeliveries.id });
  return row ?? null;
}

export async function getInboxRedeliveries(
  db: Database,
  params: { teamId: string; inboxId: string },
) {
  return db
    .select({
      id: inboxRedeliveries.id,
      referenceId: inboxRedeliveries.referenceId,
      inboxAccountId: inboxRedeliveries.inboxAccountId,
      fileName: inboxRedeliveries.fileName,
      receivedAt: inboxRedeliveries.receivedAt,
    })
    .from(inboxRedeliveries)
    .where(
      and(
        eq(inboxRedeliveries.teamId, params.teamId),
        eq(inboxRedeliveries.inboxId, params.inboxId),
      ),
    )
    .orderBy(asc(inboxRedeliveries.receivedAt))
    .limit(100);
}
