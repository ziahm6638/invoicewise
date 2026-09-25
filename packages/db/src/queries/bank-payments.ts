import type { Database } from "@db/client";
import {
  bankFeedAccounts,
  bankFeedConnections,
  bankFeedTransactions,
  bankPaymentSettings,
  inbox,
  invoicePaymentAllocations,
  invoicePaymentMatches,
  users,
} from "@db/schema";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";

/**
 * Optional bank-payment reconciliation (docs/bank-payments.md): the
 * workspace's setting and provider customer, its bank connections, accounts
 * and transactions, and the immutable decisions about how each invoice was
 * paid. Every query is scoped by `teamId` except the two lookups that
 * attribute a provider callback to a workspace through its own customer.
 */

// --- Settings -------------------------------------------------------------------

export async function getBankPaymentSettings(db: Database, teamId: string) {
  const [row] = await db
    .select()
    .from(bankPaymentSettings)
    .where(eq(bankPaymentSettings.teamId, teamId))
    .limit(1);
  return row ?? null;
}

export async function setBankPaymentsEnabled(
  db: Database,
  params: { teamId: string; enabled: boolean; actorId: string },
) {
  const now = new Date().toISOString();
  const [row] = await db
    .insert(bankPaymentSettings)
    .values({
      teamId: params.teamId,
      enabled: params.enabled,
      changedBy: params.actorId,
      changedAt: now,
    })
    .onConflictDoUpdate({
      target: bankPaymentSettings.teamId,
      set: {
        enabled: params.enabled,
        changedBy: params.actorId,
        changedAt: now,
      },
    })
    .returning();
  return row!;
}

/** Locks the workspace's setting row, creating it (off) when missing. */
export async function lockBankPaymentSettings(db: Database, teamId: string) {
  await db
    .insert(bankPaymentSettings)
    .values({ teamId })
    .onConflictDoNothing();
  const [row] = await db
    .select()
    .from(bankPaymentSettings)
    .where(eq(bankPaymentSettings.teamId, teamId))
    .for("update");
  return row!;
}

export async function setBankPaymentCustomer(
  db: Database,
  params: { teamId: string; customerId: string },
) {
  await db
    .update(bankPaymentSettings)
    .set({ providerCustomerId: params.customerId })
    .where(eq(bankPaymentSettings.teamId, params.teamId));
}

/** The workspace a provider customer belongs to: the only way a callback is attributed. */
export async function findTeamByBankCustomer(
  db: Database,
  params: { provider: string; customerId: string },
) {
  const [row] = await db
    .select({
      teamId: bankPaymentSettings.teamId,
      enabled: bankPaymentSettings.enabled,
    })
    .from(bankPaymentSettings)
    .where(
      and(
        eq(bankPaymentSettings.provider, params.provider),
        eq(bankPaymentSettings.providerCustomerId, params.customerId),
      ),
    )
    .limit(1);
  return row ?? null;
}

// --- Connections ------------------------------------------------------------------

export type BankFeedConnectionRow = typeof bankFeedConnections.$inferSelect;

export async function listBankFeedConnections(db: Database, teamId: string) {
  return db
    .select({
      connection: bankFeedConnections,
      consentGivenByName: users.fullName,
      accounts: sql<number>`(
        select count(*)::int from ${bankFeedAccounts} a
        where a.connection_id = ${bankFeedConnections.id}
      )`,
      transactions: sql<number>`(
        select count(*)::int from ${bankFeedTransactions} t
        where t.connection_id = ${bankFeedConnections.id}
      )`,
    })
    .from(bankFeedConnections)
    .leftJoin(users, eq(users.id, bankFeedConnections.consentGivenBy))
    .where(eq(bankFeedConnections.teamId, teamId))
    .orderBy(desc(bankFeedConnections.createdAt));
}

export async function getBankFeedConnection(
  db: Database,
  params: { teamId: string; connectionId: string; lock?: boolean },
) {
  const query = db
    .select()
    .from(bankFeedConnections)
    .where(
      and(
        eq(bankFeedConnections.id, params.connectionId),
        eq(bankFeedConnections.teamId, params.teamId),
      ),
    )
    .limit(1);
  const [row] = params.lock ? await query.for("update") : await query;
  return row ?? null;
}

export async function getBankFeedConnectionByProviderId(
  db: Database,
  params: { teamId: string; provider: string; providerConnectionId: string },
) {
  const [row] = await db
    .select()
    .from(bankFeedConnections)
    .where(
      and(
        eq(bankFeedConnections.teamId, params.teamId),
        eq(bankFeedConnections.provider, params.provider),
        eq(bankFeedConnections.providerConnectionId, params.providerConnectionId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** The workspace's newest connection still waiting for its first connect. */
export async function getPendingBankFeedConnection(db: Database, teamId: string) {
  const [row] = await db
    .select()
    .from(bankFeedConnections)
    .where(
      and(
        eq(bankFeedConnections.teamId, teamId),
        isNull(bankFeedConnections.providerConnectionId),
        eq(bankFeedConnections.status, "pending"),
      ),
    )
    .orderBy(desc(bankFeedConnections.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * A connect attempt that has not reached the provider yet, by our own id.
 * Only a provider failure callback uses it, to mark that attempt failed.
 */
export async function getUnattachedBankFeedConnection(
  db: Database,
  connectionId: string,
) {
  const [row] = await db
    .select()
    .from(bankFeedConnections)
    .where(
      and(
        eq(bankFeedConnections.id, connectionId),
        eq(bankFeedConnections.status, "pending"),
        isNull(bankFeedConnections.providerConnectionId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function createBankFeedConnection(
  db: Database,
  params: {
    teamId: string;
    provider: string;
    consentPeriodDays: number;
    consentGivenBy: string;
  },
) {
  const now = new Date().toISOString();
  const [row] = await db
    .insert(bankFeedConnections)
    .values({
      teamId: params.teamId,
      provider: params.provider,
      status: "pending",
      consentStatus: "pending",
      consentPeriodDays: params.consentPeriodDays,
      consentGivenBy: params.consentGivenBy,
      consentGivenAt: now,
      attemptStartedAt: now,
    })
    .returning();
  return row!;
}

export async function updateBankFeedConnection(
  db: Database,
  params: {
    teamId: string;
    connectionId: string;
    set: Partial<Omit<BankFeedConnectionRow, "id" | "teamId" | "createdAt">>;
  },
) {
  const [row] = await db
    .update(bankFeedConnections)
    .set({ ...params.set, updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(bankFeedConnections.id, params.connectionId),
        eq(bankFeedConnections.teamId, params.teamId),
      ),
    )
    .returning();
  return row ?? null;
}

/** Connections the scheduled sync keeps pulling. */
export async function listSyncableBankFeedConnections(db: Database, limit = 200) {
  return db
    .select({
      id: bankFeedConnections.id,
      teamId: bankFeedConnections.teamId,
    })
    .from(bankFeedConnections)
    .innerJoin(
      bankPaymentSettings,
      eq(bankPaymentSettings.teamId, bankFeedConnections.teamId),
    )
    .where(
      and(
        eq(bankPaymentSettings.enabled, true),
        eq(bankFeedConnections.status, "active"),
        isNotNull(bankFeedConnections.providerConnectionId),
      ),
    )
    .orderBy(asc(bankFeedConnections.lastSyncFinishedAt))
    .limit(limit);
}

export async function hasActiveBankFeedConnection(db: Database, teamId: string) {
  const [row] = await db
    .select({ id: bankFeedConnections.id })
    .from(bankFeedConnections)
    .where(
      and(
        eq(bankFeedConnections.teamId, teamId),
        eq(bankFeedConnections.status, "active"),
      ),
    )
    .limit(1);
  return Boolean(row);
}

// --- Accounts and transactions ------------------------------------------------------

export async function upsertBankFeedAccount(
  db: Database,
  params: {
    teamId: string;
    connectionId: string;
    providerAccountId: string;
    name: string;
    nature: string | null;
    currency: string;
  },
) {
  const now = new Date().toISOString();
  const [row] = await db
    .insert(bankFeedAccounts)
    .values({ ...params })
    .onConflictDoUpdate({
      target: [bankFeedAccounts.connectionId, bankFeedAccounts.providerAccountId],
      set: {
        name: params.name,
        nature: params.nature,
        currency: params.currency,
        updatedAt: now,
      },
    })
    .returning();
  return row!;
}

export async function updateBankFeedAccountCursor(
  db: Database,
  params: { teamId: string; accountId: string; postedCursor: string | null },
) {
  const now = new Date().toISOString();
  await db
    .update(bankFeedAccounts)
    .set({
      postedCursor: params.postedCursor,
      lastSyncedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(bankFeedAccounts.id, params.accountId),
        eq(bankFeedAccounts.teamId, params.teamId),
      ),
    );
}

export async function listBankFeedAccounts(
  db: Database,
  params: { teamId: string; connectionId?: string },
) {
  return db
    .select()
    .from(bankFeedAccounts)
    .where(
      and(
        eq(bankFeedAccounts.teamId, params.teamId),
        params.connectionId
          ? eq(bankFeedAccounts.connectionId, params.connectionId)
          : undefined,
      ),
    )
    .orderBy(asc(bankFeedAccounts.name));
}

export type BankFeedTransactionRow = typeof bankFeedTransactions.$inferSelect;

export type NewBankFeedTransaction = {
  providerTransactionId: string;
  status: "posted" | "pending";
  duplicated: boolean;
  mode: string;
  madeOn: string;
  amount: string;
  currency: string;
  description: string;
  counterparty: string | null;
  reference: string | null;
  fingerprint: string;
};

/**
 * Inserts or refreshes transactions by their provider id within the account,
 * so a transaction fetched twice is stored once. Returns the ids of rows that
 * were new. A row already superseded or reversed keeps that status.
 */
export async function upsertBankFeedTransactions(
  db: Database,
  params: {
    teamId: string;
    connectionId: string;
    accountId: string;
    transactions: NewBankFeedTransaction[];
  },
) {
  if (params.transactions.length === 0) return { inserted: 0, updated: 0 };
  const now = new Date().toISOString();
  const rows = await db
    .insert(bankFeedTransactions)
    .values(
      params.transactions.map((row) => ({
        teamId: params.teamId,
        connectionId: params.connectionId,
        accountId: params.accountId,
        ...row,
      })),
    )
    .onConflictDoUpdate({
      target: [
        bankFeedTransactions.accountId,
        bankFeedTransactions.providerTransactionId,
      ],
      set: {
        status: sql`case when ${bankFeedTransactions.status} in ('superseded', 'reversed') then ${bankFeedTransactions.status} else excluded.status end`,
        duplicated: sql`excluded.duplicated`,
        mode: sql`excluded.mode`,
        madeOn: sql`excluded.made_on`,
        amount: sql`excluded.amount`,
        description: sql`excluded.description`,
        counterparty: sql`excluded.counterparty`,
        reference: sql`excluded.reference`,
        fingerprint: sql`excluded.fingerprint`,
        lastSeenAt: now,
        updatedAt: now,
      },
    })
    .returning({
      id: bankFeedTransactions.id,
      inserted: sql<boolean>`(xmax = 0)`,
    });
  const inserted = rows.filter((row) => row.inserted).length;
  return { inserted, updated: rows.length - inserted };
}

export async function listAccountTransactions(
  db: Database,
  params: {
    teamId: string;
    accountId: string;
    statuses: string[];
    since?: string;
  },
) {
  return db
    .select()
    .from(bankFeedTransactions)
    .where(
      and(
        eq(bankFeedTransactions.teamId, params.teamId),
        eq(bankFeedTransactions.accountId, params.accountId),
        inArray(bankFeedTransactions.status, params.statuses),
        params.since ? gte(bankFeedTransactions.madeOn, params.since) : undefined,
      ),
    )
    .orderBy(asc(bankFeedTransactions.madeOn), asc(bankFeedTransactions.id));
}

export async function markBankFeedTransaction(
  db: Database,
  params: {
    teamId: string;
    transactionId: string;
    set: Partial<
      Pick<
        BankFeedTransactionRow,
        | "status"
        | "supersededById"
        | "reversedById"
        | "reversal"
        | "providerTransactionId"
        | "lastSeenAt"
      >
    >;
  },
) {
  await db
    .update(bankFeedTransactions)
    .set({ ...params.set, updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(bankFeedTransactions.id, params.transactionId),
        eq(bankFeedTransactions.teamId, params.teamId),
      ),
    );
}

/**
 * Removes a disconnected connection's transactions that no payment decision
 * counts; those some decision counts stay as its evidence.
 */
export async function pruneUncountedBankFeedTransactions(
  db: Database,
  params: { teamId: string; connectionId: string },
) {
  const removed = await db
    .delete(bankFeedTransactions)
    .where(
      and(
        eq(bankFeedTransactions.teamId, params.teamId),
        eq(bankFeedTransactions.connectionId, params.connectionId),
        sql`not exists (
          select 1 from ${invoicePaymentAllocations} a
          where a.transaction_id = ${bankFeedTransactions.id}
        )`,
        // A kept transaction may point at one being removed.
        sql`not exists (
          select 1 from ${bankFeedTransactions} kept
          join ${invoicePaymentAllocations} a on a.transaction_id = kept.id
          where kept.superseded_by_id = ${bankFeedTransactions.id}
             or kept.reversed_by_id = ${bankFeedTransactions.id}
        )`,
      ),
    )
    .returning({ id: bankFeedTransactions.id });
  return removed.length;
}

/** The workspace's transactions for the bank-payments page, newest first. */
export async function listBankFeedTransactions(
  db: Database,
  params: {
    teamId: string;
    connectionId?: string;
    status?: string;
    limit?: number;
    offset?: number;
  },
) {
  return db
    .select({
      id: bankFeedTransactions.id,
      connectionId: bankFeedTransactions.connectionId,
      accountName: bankFeedAccounts.name,
      providerTransactionId: bankFeedTransactions.providerTransactionId,
      status: bankFeedTransactions.status,
      duplicated: bankFeedTransactions.duplicated,
      mode: bankFeedTransactions.mode,
      madeOn: bankFeedTransactions.madeOn,
      amount: bankFeedTransactions.amount,
      currency: bankFeedTransactions.currency,
      description: bankFeedTransactions.description,
      counterparty: bankFeedTransactions.counterparty,
      reference: bankFeedTransactions.reference,
      reversal: bankFeedTransactions.reversal,
      supersededById: bankFeedTransactions.supersededById,
      reversedById: bankFeedTransactions.reversedById,
      firstSeenAt: bankFeedTransactions.firstSeenAt,
      // What current payment decisions count from it, by invoice.
      counted: sql<
        { inboxId: string; kind: string; amount: string }[]
      >`coalesce((
        select jsonb_agg(jsonb_build_object('inboxId', a.inbox_id, 'kind', a.kind, 'amount', a.amount::text))
        from ${invoicePaymentAllocations} a
        join ${inbox} i on i.payment_match_id = a.match_id
        where a.transaction_id = ${bankFeedTransactions.id}
      ), '[]'::jsonb)`,
    })
    .from(bankFeedTransactions)
    .innerJoin(
      bankFeedAccounts,
      eq(bankFeedAccounts.id, bankFeedTransactions.accountId),
    )
    .where(
      and(
        eq(bankFeedTransactions.teamId, params.teamId),
        params.connectionId
          ? eq(bankFeedTransactions.connectionId, params.connectionId)
          : undefined,
        params.status ? eq(bankFeedTransactions.status, params.status) : undefined,
      ),
    )
    .orderBy(desc(bankFeedTransactions.madeOn), desc(bankFeedTransactions.id))
    .limit(params.limit ?? 100)
    .offset(params.offset ?? 0);
}

// --- Payment matching --------------------------------------------------------------

/** A live (accepted or legacy) invoice; reservations and deleted ones never match. */
const liveInvoice = (teamId: string) =>
  and(
    eq(inbox.teamId, teamId),
    ne(inbox.status, "deleted"),
    or(isNull(inbox.intakeState), eq(inbox.intakeState, "accepted")),
  );

const paymentInvoiceColumns = {
  id: inbox.id,
  status: inbox.status,
  extraction: inbox.extraction,
  validation: inbox.validation,
  processingRevision: inbox.processingRevision,
  paymentMatchId: inbox.paymentMatchId,
  createdAt: inbox.createdAt,
};

export type PaymentInvoiceRow = {
  id: string;
  status: string | null;
  extraction: Record<string, unknown> | null;
  validation: Record<string, unknown> | null;
  processingRevision: number;
  paymentMatchId: string | null;
  createdAt: string;
};

/** The workspace's processed invoices, oldest first, bounded. */
export async function listInvoicesForPaymentMatching(
  db: Database,
  params: { teamId: string; limit: number; inboxIds?: string[] },
): Promise<PaymentInvoiceRow[]> {
  return db
    .select(paymentInvoiceColumns)
    .from(inbox)
    .where(
      and(
        liveInvoice(params.teamId),
        isNotNull(inbox.extraction),
        isNotNull(inbox.validation),
        ne(inbox.status, "processing"),
        params.inboxIds ? inArray(inbox.id, params.inboxIds) : undefined,
      ),
    )
    .orderBy(asc(inbox.createdAt), asc(inbox.id))
    .limit(params.limit) as Promise<PaymentInvoiceRow[]>;
}

export async function lockInvoiceForPayment(
  db: Database,
  params: { teamId: string; inboxId: string },
): Promise<PaymentInvoiceRow | null> {
  const [row] = await db
    .select(paymentInvoiceColumns)
    .from(inbox)
    .where(and(liveInvoice(params.teamId), eq(inbox.id, params.inboxId)))
    .for("update");
  return (row as PaymentInvoiceRow | undefined) ?? null;
}

/**
 * Serializes payment decisions within a workspace, so two decisions never
 * count the same part of one transaction. Held until the transaction ends.
 */
export async function lockWorkspacePayments(db: Database, teamId: string) {
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`invoicewise:payments:${teamId}`}))`,
  );
}

/**
 * The workspace's transactions in one currency and date window, with what
 * the current decisions of other invoices already count from each.
 */
export async function listPaymentCandidateTransactions(
  db: Database,
  params: {
    teamId: string;
    currency: string;
    from: string;
    to: string;
    excludeInboxId: string;
    transactionIds?: string[];
  },
) {
  return db
    .select({
      id: bankFeedTransactions.id,
      accountName: bankFeedAccounts.name,
      status: bankFeedTransactions.status,
      duplicated: bankFeedTransactions.duplicated,
      mode: bankFeedTransactions.mode,
      madeOn: bankFeedTransactions.madeOn,
      amount: bankFeedTransactions.amount,
      currency: bankFeedTransactions.currency,
      description: bankFeedTransactions.description,
      counterparty: bankFeedTransactions.counterparty,
      reference: bankFeedTransactions.reference,
      countedElsewhere: sql<string>`coalesce((
        select sum(a.amount) from ${invoicePaymentAllocations} a
        join ${inbox} i on i.payment_match_id = a.match_id
        where a.transaction_id = ${bankFeedTransactions.id}
          and a.inbox_id <> ${params.excludeInboxId}
          and i.team_id = ${params.teamId}
      ), 0)::text`,
    })
    .from(bankFeedTransactions)
    .innerJoin(
      bankFeedAccounts,
      eq(bankFeedAccounts.id, bankFeedTransactions.accountId),
    )
    .where(
      and(
        eq(bankFeedTransactions.teamId, params.teamId),
        params.transactionIds
          ? inArray(bankFeedTransactions.id, params.transactionIds)
          : and(
              eq(bankFeedTransactions.currency, params.currency),
              gte(bankFeedTransactions.madeOn, params.from),
              lte(bankFeedTransactions.madeOn, params.to),
            ),
      ),
    )
    .orderBy(asc(bankFeedTransactions.madeOn), asc(bankFeedTransactions.id))
    .limit(2_000);
}

export type PaymentMatchRow = typeof invoicePaymentMatches.$inferSelect;

export async function getPaymentMatch(
  db: Database,
  params: { teamId: string; matchId: string },
) {
  const [row] = await db
    .select()
    .from(invoicePaymentMatches)
    .where(
      and(
        eq(invoicePaymentMatches.id, params.matchId),
        eq(invoicePaymentMatches.teamId, params.teamId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Every payment decision about an invoice, newest first, with who made it. */
export async function listPaymentMatchHistory(
  db: Database,
  params: { teamId: string; inboxId: string; limit?: number },
) {
  return db
    .select({
      match: invoicePaymentMatches,
      actorName: users.fullName,
    })
    .from(invoicePaymentMatches)
    .leftJoin(users, eq(users.id, invoicePaymentMatches.actorId))
    .where(
      and(
        eq(invoicePaymentMatches.teamId, params.teamId),
        eq(invoicePaymentMatches.inboxId, params.inboxId),
      ),
    )
    .orderBy(desc(invoicePaymentMatches.sequence))
    .limit(params.limit ?? 50);
}

export type NewPaymentAllocation = {
  kind: "payment" | "fee" | "credit";
  transactionId: string | null;
  creditInboxId: string | null;
  amount: string;
  currency: string;
};

export async function recordPaymentMatch(
  db: Database,
  params: {
    teamId: string;
    inboxId: string;
    status: string;
    paymentStatus: string;
    origin: "automatic" | "manual";
    action: string;
    currency: string | null;
    dueAmount: string | null;
    paidAmount: string;
    result: Record<string, unknown>;
    reason: string | null;
    processingRevision: number | null;
    rulesVersion: number;
    fingerprint: string;
    actorId: string | null;
    allocations: NewPaymentAllocation[];
  },
) {
  const [last] = await db
    .select({
      sequence: sql<number>`coalesce(max(${invoicePaymentMatches.sequence}), 0)::int`,
    })
    .from(invoicePaymentMatches)
    .where(eq(invoicePaymentMatches.inboxId, params.inboxId));
  const { allocations, ...values } = params;
  const [match] = await db
    .insert(invoicePaymentMatches)
    .values({ ...values, sequence: (last?.sequence ?? 0) + 1 })
    .returning();
  if (allocations.length) {
    await db.insert(invoicePaymentAllocations).values(
      allocations.map((allocation) => ({
        teamId: params.teamId,
        matchId: match!.id,
        inboxId: params.inboxId,
        ...allocation,
      })),
    );
  }
  await db
    .update(inbox)
    .set({ paymentMatchId: match!.id })
    .where(and(eq(inbox.id, params.inboxId), eq(inbox.teamId, params.teamId)));
  return match!;
}

/** Invoices whose current decision counts any of these transactions. */
export async function listInvoicesCountingTransactions(
  db: Database,
  params: { teamId: string; transactionIds: string[] },
) {
  if (params.transactionIds.length === 0) return [];
  const rows = await db
    .selectDistinct({ inboxId: invoicePaymentAllocations.inboxId })
    .from(invoicePaymentAllocations)
    .innerJoin(inbox, eq(inbox.paymentMatchId, invoicePaymentAllocations.matchId))
    .where(
      and(
        eq(invoicePaymentAllocations.teamId, params.teamId),
        inArray(invoicePaymentAllocations.transactionId, params.transactionIds),
      ),
    );
  return rows.map((row) => row.inboxId);
}

/** Credit notes whose current decision says they were applied, keyed by the invoice they credit. */
export async function listAppliedCredits(
  db: Database,
  params: { teamId: string; excludeCreditIds?: string[] },
) {
  return db
    .select({
      creditInboxId: inbox.id,
      result: invoicePaymentMatches.result,
    })
    .from(inbox)
    .innerJoin(
      invoicePaymentMatches,
      eq(invoicePaymentMatches.id, inbox.paymentMatchId),
    )
    .where(
      and(
        liveInvoice(params.teamId),
        eq(invoicePaymentMatches.paymentStatus, "applied"),
        params.excludeCreditIds?.length
          ? notInArray(inbox.id, params.excludeCreditIds)
          : undefined,
      ),
    );
}

/** For the owner export: every payment decision with its allocations. */
export async function getPaymentMatchesForExport(db: Database, teamId: string) {
  const matches = await db
    .select({
      match: invoicePaymentMatches,
      current: sql<boolean>`${inbox.paymentMatchId} = ${invoicePaymentMatches.id}`,
    })
    .from(invoicePaymentMatches)
    .innerJoin(inbox, eq(inbox.id, invoicePaymentMatches.inboxId))
    .where(eq(invoicePaymentMatches.teamId, teamId))
    .orderBy(asc(invoicePaymentMatches.inboxId), asc(invoicePaymentMatches.sequence));
  const allocations = await db
    .select()
    .from(invoicePaymentAllocations)
    .where(eq(invoicePaymentAllocations.teamId, teamId));
  return { matches, allocations };
}

/** For the owner export: connections (without provider ids), accounts and transactions. */
export async function getBankFeedForExport(db: Database, teamId: string) {
  const [connections, accounts, transactions] = await Promise.all([
    db
      .select({
        id: bankFeedConnections.id,
        provider: bankFeedConnections.provider,
        providerName: bankFeedConnections.providerName,
        status: bankFeedConnections.status,
        consentStatus: bankFeedConnections.consentStatus,
        consentPeriodDays: bankFeedConnections.consentPeriodDays,
        consentGivenBy: bankFeedConnections.consentGivenBy,
        consentGivenAt: bankFeedConnections.consentGivenAt,
        consentExpiresAt: bankFeedConnections.consentExpiresAt,
        connectedAt: bankFeedConnections.connectedAt,
        disconnectedAt: bankFeedConnections.disconnectedAt,
        lastSyncFinishedAt: bankFeedConnections.lastSyncFinishedAt,
        lastSyncStatus: bankFeedConnections.lastSyncStatus,
      })
      .from(bankFeedConnections)
      .where(eq(bankFeedConnections.teamId, teamId))
      .orderBy(asc(bankFeedConnections.createdAt)),
    db
      .select({
        id: bankFeedAccounts.id,
        connectionId: bankFeedAccounts.connectionId,
        name: bankFeedAccounts.name,
        nature: bankFeedAccounts.nature,
        currency: bankFeedAccounts.currency,
      })
      .from(bankFeedAccounts)
      .where(eq(bankFeedAccounts.teamId, teamId)),
    db
      .select({
        id: bankFeedTransactions.id,
        connectionId: bankFeedTransactions.connectionId,
        accountId: bankFeedTransactions.accountId,
        status: bankFeedTransactions.status,
        duplicated: bankFeedTransactions.duplicated,
        mode: bankFeedTransactions.mode,
        madeOn: bankFeedTransactions.madeOn,
        amount: bankFeedTransactions.amount,
        currency: bankFeedTransactions.currency,
        description: bankFeedTransactions.description,
        counterparty: bankFeedTransactions.counterparty,
        reference: bankFeedTransactions.reference,
        reversal: bankFeedTransactions.reversal,
      })
      .from(bankFeedTransactions)
      .where(eq(bankFeedTransactions.teamId, teamId))
      .orderBy(asc(bankFeedTransactions.madeOn)),
  ]);
  return { connections, accounts, transactions };
}
