import type { Database } from "@db/client";
import { accountingConnections, inbox } from "@db/schema";
import { and, desc, eq, isNotNull, isNull, ne, sql } from "drizzle-orm";

export type AccountingProvider = "xero" | "quickbooks";

export function getAccountingConnections(db: Database, teamId: string) {
  return db
    .select()
    .from(accountingConnections)
    .where(eq(accountingConnections.teamId, teamId))
    .orderBy(desc(accountingConnections.connectedAt));
}

export async function getActiveAccountingConnection(
  db: Database,
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
      validation: inbox.validation,
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

/**
 * Another live copy with the same document identity that has already been
 * sent to accounting: this one must not create a second bill.
 */
export async function getDeliveredCopy(
  db: Database,
  input: { invoiceId: string; teamId: string; identityKey: string },
) {
  const [copy] = await db
    .select({ id: inbox.id })
    .from(inbox)
    .where(
      and(
        eq(inbox.teamId, input.teamId),
        ne(inbox.id, input.invoiceId),
        ne(inbox.status, "deleted"),
        isNotNull(inbox.accountingProviderId),
        sql`${inbox.validation} -> 'identity' ->> 'key' = ${input.identityKey}`,
      ),
    )
    .limit(1);
  return copy;
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

export async function recordAccountingPostFailure(
  db: Database,
  input: {
    invoiceId: string;
    teamId: string;
    provider: AccountingProvider;
    idempotencyKey: string;
    error: string;
  },
) {
  const [invoice] = await db
    .update(inbox)
    .set({
      accountingProvider: input.provider,
      accountingPostStatus: "failed",
      accountingIdempotencyKey: input.idempotencyKey,
      accountingPostError: input.error,
    })
    .where(and(eq(inbox.id, input.invoiceId), eq(inbox.teamId, input.teamId)))
    .returning({ id: inbox.id });
  return invoice;
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
      postedAt: inbox.accountingPostedAt,
      idempotencyKey: inbox.accountingIdempotencyKey,
    })
    .from(inbox)
    .where(and(eq(inbox.id, input.invoiceId), eq(inbox.teamId, input.teamId)))
    .limit(1);
  return status?.status ? status : null;
}
