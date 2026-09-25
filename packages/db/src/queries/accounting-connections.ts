import type { Database } from "@db/client";
import {
  accountingConnections,
  accountingPostClaims,
  inbox,
  workflowJobs,
} from "@db/schema";
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

/**
 * Stores a verified connection. Reconnecting to the same organisation keeps
 * the workspace's settings and its automatic-posting opt-in; a connection to
 * another organisation starts over, so nothing posts to a company the admin
 * has not set up and opted in for. `autoPostOnConnect` opts in at connect
 * (Xero drafts), otherwise an admin opts in later.
 */
export async function upsertAccountingConnection(
  db: Database,
  input: {
    teamId: string;
    provider: AccountingProvider;
    integrationId: string;
    connectionId: string;
    organisationId: string | null;
    organisationName: string | null;
    sandbox: boolean;
    autoPostOnConnect: boolean;
  },
) {
  const now = new Date().toISOString();
  const { autoPostOnConnect, ...values } = input;
  const capabilities =
    input.provider === "xero"
      ? ["draft_bills"]
      : ["open_bills", "vendor_credits"];
  const sameOrganisation = sql`${accountingConnections.organisationId} is not distinct from excluded.organisation_id`;
  const [connection] = await db
    .insert(accountingConnections)
    .values({
      ...values,
      capabilities,
      autoPostEnabledAt: autoPostOnConnect ? now : null,
      healthStatus: "ok",
      healthCheckedAt: now,
    })
    .onConflictDoUpdate({
      target: [accountingConnections.teamId, accountingConnections.provider],
      set: {
        integrationId: input.integrationId,
        connectionId: input.connectionId,
        capabilities,
        organisationId: input.organisationId,
        organisationName: input.organisationName,
        sandbox: input.sandbox,
        settings: sql`case when ${sameOrganisation} then ${accountingConnections.settings} else '{}'::jsonb end`,
        autoPostEnabledAt: sql`case when ${sameOrganisation} and ${accountingConnections.autoPostEnabledAt} is not null then ${accountingConnections.autoPostEnabledAt} else ${autoPostOnConnect ? now : null}::timestamptz end`,
        autoPostEnabledBy: sql`case when ${sameOrganisation} then ${accountingConnections.autoPostEnabledBy} else null end`,
        healthStatus: "ok",
        healthError: null,
        healthCheckedAt: now,
        connectedAt: now,
        disconnectedAt: null,
        updatedAt: now,
      },
    })
    .returning();
  return connection;
}

/**
 * An admin's posting choices for the active connection. `autoPost` records
 * who opted in to automatic creation (kept while it stays on) or clears it.
 */
export async function updateAccountingConnectionSettings(
  db: Database,
  input: {
    teamId: string;
    provider: AccountingProvider;
    settings: Record<string, unknown>;
    autoPost: { enabledBy: string | null } | null;
  },
) {
  const now = new Date().toISOString();
  const [connection] = await db
    .update(accountingConnections)
    .set({
      settings: input.settings,
      autoPostEnabledAt: input.autoPost
        ? sql`coalesce(${accountingConnections.autoPostEnabledAt}, ${now}::timestamptz)`
        : null,
      autoPostEnabledBy: input.autoPost
        ? sql`case when ${accountingConnections.autoPostEnabledAt} is null then ${input.autoPost.enabledBy}::uuid else ${accountingConnections.autoPostEnabledBy} end`
        : null,
      updatedAt: now,
    })
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

/** The outcome of a live health check of the active connection. */
export async function recordAccountingConnectionHealth(
  db: Database,
  input: {
    teamId: string;
    provider: AccountingProvider;
    status: "ok" | "reconnect" | "unavailable";
    error: string | null;
    organisationName?: string | null;
  },
) {
  const now = new Date().toISOString();
  const [connection] = await db
    .update(accountingConnections)
    .set({
      healthStatus: input.status,
      healthError: input.error,
      healthCheckedAt: now,
      ...(input.organisationName
        ? { organisationName: input.organisationName }
        : {}),
      updatedAt: now,
    })
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
      status: inbox.status,
      processingRevision: inbox.processingRevision,
      accountingRevision: inbox.accountingRevision,
      accountingProvider: inbox.accountingProvider,
      accountingPostStatus: inbox.accountingPostStatus,
      accountingProviderId: inbox.accountingProviderId,
      accountingIdempotencyKey: inbox.accountingIdempotencyKey,
      accountingPostReleased: inbox.accountingPostReleased,
      accountingProviderEntity: inbox.accountingProviderEntity,
      accountingAttachmentStatus: inbox.accountingAttachmentStatus,
    })
    .from(inbox)
    .where(and(eq(inbox.id, input.invoiceId), eq(inbox.teamId, input.teamId)))
    .limit(1);
  return invoice;
}

/**
 * Claims the right to post the bill for one document type and number. The insert is
 * its own committed statement, so of two copies posting at once exactly one
 * wins; returns the document holding the claim (possibly this one, when it
 * is retrying its own post), or undefined when it was released meanwhile.
 */
export async function claimAccountingPost(
  db: Database,
  input: { teamId: string; identityKey: string; invoiceId: string },
) {
  await db.insert(accountingPostClaims).values(input).onConflictDoNothing();
  const [claim] = await db
    .select({ invoiceId: accountingPostClaims.invoiceId })
    .from(accountingPostClaims)
    .where(
      and(
        eq(accountingPostClaims.teamId, input.teamId),
        eq(accountingPostClaims.identityKey, input.identityKey),
      ),
    )
    .limit(1);
  return claim?.invoiceId;
}

export async function releaseAccountingPostClaim(
  db: Database,
  input: { teamId: string; identityKey: string; invoiceId: string },
) {
  await db
    .delete(accountingPostClaims)
    .where(
      and(
        eq(accountingPostClaims.teamId, input.teamId),
        eq(accountingPostClaims.identityKey, input.identityKey),
        eq(accountingPostClaims.invoiceId, input.invoiceId),
      ),
    );
}

export async function recordAccountingPostSuccess(
  db: Database,
  input: {
    invoiceId: string;
    teamId: string;
    provider: AccountingProvider;
    providerId: string;
    entity: "bill" | "vendor_credit";
    idempotencyKey: string;
    duplicate: boolean;
    attachment: AccountingAttachmentOutcome;
  },
) {
  const [invoice] = await db
    .update(inbox)
    .set({
      accountingProvider: input.provider,
      accountingPostStatus: input.duplicate ? "already_posted" : "posted",
      accountingProviderId: input.providerId,
      accountingProviderEntity: input.entity,
      accountingAttachmentStatus: input.attachment.status,
      accountingAttachmentError: input.attachment.error,
      accountingIdempotencyKey: input.idempotencyKey,
      accountingPostError: null,
      accountingPostRetryable: null,
      accountingPostedAt: new Date().toISOString(),
    })
    .where(and(eq(inbox.id, input.invoiceId), eq(inbox.teamId, input.teamId)))
    .returning({ id: inbox.id });
  return invoice;
}

/**
 * The source document on a posted record: attached, queued for its own
 * upload retry, failed (with the reason), or null when there is none.
 */
export type AccountingAttachmentOutcome = {
  status: "attached" | "queued" | "failed" | null;
  error: string | null;
};

/** Records the outcome of a separately retried attachment upload. */
export async function recordAccountingAttachment(
  db: Executor,
  input: { invoiceId: string; teamId: string } & AccountingAttachmentOutcome,
) {
  const [invoice] = await db
    .update(inbox)
    .set({
      accountingAttachmentStatus: input.status,
      accountingAttachmentError: input.error,
    })
    .where(
      and(
        eq(inbox.id, input.invoiceId),
        eq(inbox.teamId, input.teamId),
        isNotNull(inbox.accountingProviderId),
      ),
    )
    .returning({ id: inbox.id });
  return invoice;
}

/** A user's release of a post held for review; see `postAccountingDraft`. */
export async function releaseAccountingPostForReview(
  db: Database,
  input: { invoiceId: string; teamId: string },
) {
  await db
    .update(inbox)
    .set({ accountingPostReleased: true })
    .where(
      and(
        eq(inbox.id, input.invoiceId),
        eq(inbox.teamId, input.teamId),
        eq(inbox.accountingPostStatus, "needs_review"),
      ),
    );
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
    /** Terminal status; `needs_review` holds a possible duplicate for a user. */
    status?: "failed" | "needs_review";
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
      accountingPostStatus: final ? (input.status ?? "failed") : "queued",
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
 * Records a terminal failure the accounting handler never saw, such as a job
 * whose lease expired after its final attempt. The invoice row is locked
 * first, so the job state is read after any concurrent explicit retry
 * committed; an intent that moved on or whose job was restarted is left alone.
 */
export async function failStalledAccountingPost(
  db: Database,
  input: { invoiceId: string; teamId: string; revision: number; error: string },
) {
  return db.transaction(async (tx) => {
    await tx
      .select({ id: inbox.id })
      .from(inbox)
      .where(and(eq(inbox.id, input.invoiceId), eq(inbox.teamId, input.teamId)))
      .for("update");
    const [invoice] = await tx
      .update(inbox)
      .set({
        accountingPostStatus: "failed",
        accountingPostError: input.error,
        accountingPostRetryable: true,
      })
      .where(
        and(
          eq(inbox.id, input.invoiceId),
          eq(inbox.teamId, input.teamId),
          eq(inbox.accountingPostStatus, "queued"),
          eq(inbox.accountingRevision, input.revision),
          isNull(inbox.accountingProviderId),
          sql`exists (
            select 1 from ${workflowJobs}
            where ${workflowJobs.name} = 'post-accounting-draft'
              and ${workflowJobs.idempotencyKey} = ${inbox.teamId}::text || ':' || ${inbox.id}::text || ':r' || ${inbox.accountingRevision}::text
              and ${workflowJobs.status} = 'failed'
          )`,
        ),
      )
      .returning({ id: inbox.id });
    return invoice;
  });
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
      entity: inbox.accountingProviderEntity,
      attachmentStatus: inbox.accountingAttachmentStatus,
      attachmentError: inbox.accountingAttachmentError,
    })
    .from(inbox)
    .where(and(eq(inbox.id, input.invoiceId), eq(inbox.teamId, input.teamId)))
    .limit(1);
  return status?.status ? status : null;
}
