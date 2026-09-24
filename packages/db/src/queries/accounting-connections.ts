import type { Database } from "@db/client";
import { accountingConnections, inbox, workflowJobs } from "@db/schema";
import { and, asc, desc, eq, isNotNull, isNull, or, sql } from "drizzle-orm";

export type AccountingProvider = "xero" | "quickbooks";

/** Any executor a query can run on: the pool or an open transaction. */
type Executor = Pick<Database, "select" | "insert" | "update">;

export function getAccountingConnections(db: Database, teamId: string) {
  return db
    .select()
    .from(accountingConnections)
    .where(eq(accountingConnections.teamId, teamId))
    .orderBy(desc(accountingConnections.connectedAt));
}

export async function getActiveAccountingConnection(
  db: Executor,
  teamId: string,
) {
  const [connection] = await db
    .select()
    .from(accountingConnections)
    .where(
      and(
        eq(accountingConnections.teamId, teamId),
        isNull(accountingConnections.disconnectedAt),
      ),
    )
    .limit(1);
  return connection;
}

export async function getActiveAccountingConnectionByProvider(
  db: Database,
  input: { teamId: string; provider: AccountingProvider },
) {
  const [connection] = await db
    .select()
    .from(accountingConnections)
    .where(
      and(
        eq(accountingConnections.teamId, input.teamId),
        eq(accountingConnections.provider, input.provider),
        isNull(accountingConnections.disconnectedAt),
      ),
    )
    .limit(1);
  return connection;
}

export async function upsertAccountingConnection(
  db: Database,
  input: {
    teamId: string;
    provider: AccountingProvider;
    integrationId: string;
    connectionId: string;
  },
) {
  const now = new Date().toISOString();
  const [connection] = await db
    .insert(accountingConnections)
    .values(input)
    .onConflictDoUpdate({
      target: [accountingConnections.teamId, accountingConnections.provider],
      set: {
        integrationId: input.integrationId,
        connectionId: input.connectionId,
        capabilities: ["draft_bills"],
        connectedAt: now,
        disconnectedAt: null,
        updatedAt: now,
      },
    })
    .returning();
  return connection;
}

export async function disconnectAccountingConnectionRecord(
  db: Database,
  input: { teamId: string; provider: AccountingProvider },
) {
  const now = new Date().toISOString();
  const [connection] = await db
    .update(accountingConnections)
    .set({ disconnectedAt: now, updatedAt: now })
    .where(
      and(
        eq(accountingConnections.teamId, input.teamId),
        eq(accountingConnections.provider, input.provider),
        isNull(accountingConnections.disconnectedAt),
      ),
    )
    .returning();
  return connection;
}

export async function getAccountingPostInvoice(
  db: Database,
  input: { invoiceId: string; teamId: string },
) {
  const [invoice] = await db
    .select({
      id: inbox.id,
      teamId: inbox.teamId,
      fileName: inbox.fileName,
      filePath: inbox.filePath,
      contentType: inbox.contentType,
      extraction: inbox.extraction,
      status: inbox.status,
      processingRevision: inbox.processingRevision,
      accountingRevision: inbox.accountingRevision,
      accountingProvider: inbox.accountingProvider,
      accountingPostStatus: inbox.accountingPostStatus,
      accountingProviderId: inbox.accountingProviderId,
      accountingIdempotencyKey: inbox.accountingIdempotencyKey,
    })
    .from(inbox)
    .where(and(eq(inbox.id, input.invoiceId), eq(inbox.teamId, input.teamId)))
    .limit(1);
  return invoice;
}

export async function recordAccountingPostSuccess(
  db: Database,
  input: {
    invoiceId: string;
    teamId: string;
    provider: AccountingProvider;
    providerId: string;
    idempotencyKey: string;
    duplicate: boolean;
  },
) {
  const [invoice] = await db
    .update(inbox)
    .set({
      accountingProvider: input.provider,
      accountingPostStatus: input.duplicate ? "already_posted" : "posted",
      accountingProviderId: input.providerId,
      accountingIdempotencyKey: input.idempotencyKey,
      accountingPostError: null,
      accountingPostRetryable: null,
      accountingPostedAt: new Date().toISOString(),
    })
    .where(and(eq(inbox.id, input.invoiceId), eq(inbox.teamId, input.teamId)))
    .returning({ id: inbox.id });
  return invoice;
}

export async function recordAccountingAlreadyPosted(
  db: Database,
  input: { invoiceId: string; teamId: string },
) {
  const [invoice] = await db
    .update(inbox)
    .set({ accountingPostStatus: "already_posted" })
    .where(and(eq(inbox.id, input.invoiceId), eq(inbox.teamId, input.teamId)))
    .returning({ id: inbox.id });
  return invoice;
}

/**
 * Records a failed post attempt. A non-final attempt keeps the intent queued
 * with its last error; only a final one is a visible terminal failure. A
 * settled post is never downgraded by a stale worker.
 */
export async function recordAccountingPostFailure(
  db: Database,
  input: {
    invoiceId: string;
    teamId: string;
    provider?: AccountingProvider;
    idempotencyKey?: string;
    error: string;
    final?: boolean;
    retryable?: boolean;
  },
) {
  const final = input.final ?? true;
  const [invoice] = await db
    .update(inbox)
    .set({
      ...(input.provider ? { accountingProvider: input.provider } : {}),
      ...(input.idempotencyKey
        ? { accountingIdempotencyKey: input.idempotencyKey }
        : {}),
      accountingPostStatus: final ? "failed" : "queued",
      accountingPostError: input.error,
      accountingPostRetryable: final ? (input.retryable ?? true) : null,
    })
    .where(
      and(
        eq(inbox.id, input.invoiceId),
        eq(inbox.teamId, input.teamId),
        isNull(inbox.accountingProviderId),
      ),
    )
    .returning({ id: inbox.id });
  return invoice;
}

/**
 * Durable accounting intent for one processing revision. Written in the same
 * transaction that enqueues its workflow job.
 */
export async function recordAccountingPostQueued(
  db: Executor,
  input: {
    invoiceId: string;
    teamId: string;
    revision: number;
    provider: AccountingProvider;
  },
) {
  const [invoice] = await db
    .update(inbox)
    .set({
      accountingProvider: input.provider,
      accountingPostStatus: "queued",
      accountingRevision: input.revision,
      accountingPostError: null,
      accountingPostRetryable: null,
    })
    .where(
      and(
        eq(inbox.id, input.invoiceId),
        eq(inbox.teamId, input.teamId),
        isNull(inbox.accountingProviderId),
      ),
    )
    .returning({ id: inbox.id });
  return invoice;
}

/** Settles a queued post whose connection or invoice is gone, without posting. */
export async function recordAccountingPostCancelled(
  db: Database,
  input: { invoiceId: string; teamId: string; reason: string },
) {
  const [invoice] = await db
    .update(inbox)
    .set({
      accountingPostStatus: "cancelled",
      accountingPostError: input.reason,
      accountingPostRetryable: false,
    })
    .where(
      and(
        eq(inbox.id, input.invoiceId),
        eq(inbox.teamId, input.teamId),
        eq(inbox.accountingPostStatus, "queued"),
      ),
    )
    .returning({ id: inbox.id });
  return invoice;
}

/**
 * Queued accounting intents whose workflow job is missing or has failed
 * without the handler recording an outcome. The job key must match
 * `workflowKey.accounting` in packages/jobs/src/client.ts.
 */
export function listStalledAccountingPosts(
  db: Database,
  input: { teamId?: string; invoiceId?: string; limit: number },
) {
  const conditions = [
    eq(inbox.accountingPostStatus, "queued"),
    isNotNull(inbox.accountingRevision),
    isNotNull(inbox.teamId),
    or(sql`${workflowJobs.id} is null`, eq(workflowJobs.status, "failed")),
  ];
  if (input.teamId) conditions.push(eq(inbox.teamId, input.teamId));
  if (input.invoiceId) conditions.push(eq(inbox.id, input.invoiceId));
  return db
    .select({
      invoiceId: inbox.id,
      teamId: sql<string>`${inbox.teamId}`,
      revision: sql<number>`${inbox.accountingRevision}`,
      jobStatus: workflowJobs.status,
      jobError: workflowJobs.lastError,
    })
    .from(inbox)
    .leftJoin(
      workflowJobs,
      and(
        eq(workflowJobs.name, "post-accounting-draft"),
        eq(
          workflowJobs.idempotencyKey,
          sql`${inbox.teamId}::text || ':' || ${inbox.id}::text || ':r' || ${inbox.accountingRevision}::text`,
        ),
      ),
    )
    .where(and(...conditions))
    .orderBy(asc(inbox.createdAt))
    .limit(input.limit);
}

export async function getInvoiceAccountingStatus(
  db: Database,
  input: { invoiceId: string; teamId: string },
) {
  const [status] = await db
    .select({
      provider: inbox.accountingProvider,
      status: inbox.accountingPostStatus,
      providerId: inbox.accountingProviderId,
      lastError: inbox.accountingPostError,
      retryable: inbox.accountingPostRetryable,
      revision: inbox.accountingRevision,
      postedAt: inbox.accountingPostedAt,
      idempotencyKey: inbox.accountingIdempotencyKey,
    })
    .from(inbox)
    .where(and(eq(inbox.id, input.invoiceId), eq(inbox.teamId, input.teamId)))
    .limit(1);
  return status?.status ? status : null;
}
