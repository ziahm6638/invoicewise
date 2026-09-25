import type { Database } from "@db/client";
import {
  accountingPostClaims,
  inbox,
  invoiceCorrections,
  users,
  workflowJobs,
} from "@db/schema";
import { and, asc, desc, eq, isNotNull, ne, or, sql } from "drizzle-orm";
import { completedInvoiceColumns } from "./inbox";

/**
 * The exception workflow's durable state: user corrections of an invoice,
 * explicit question reruns and in-place updates of a posted bill. Every
 * transition is conditional on the invoice revision the caller saw, so
 * concurrent clicks and replayed jobs settle on one outcome
 * (docs/delivery.md#corrections-reprocessing-and-retries).
 */

type Executor = Pick<Database, "select" | "insert" | "update" | "delete">;

/**
 * Locks an invoice for a user action (correction, question rerun) so it
 * serialises with other actions, retries and finishing workers.
 */
export async function lockInvoiceForAction(
  db: Executor,
  params: { id: string; teamId: string },
) {
  const [row] = await db
    .select({
      id: inbox.id,
      teamId: inbox.teamId,
      status: inbox.status,
      intakeState: inbox.intakeState,
      processingRevision: inbox.processingRevision,
      extraction: inbox.extraction,
      extractionOriginal: inbox.extractionOriginal,
      judgments: inbox.judgments,
      validation: inbox.validation,
      processingError: inbox.processingError,
      accountingProvider: inbox.accountingProvider,
      accountingPostStatus: inbox.accountingPostStatus,
      accountingProviderId: inbox.accountingProviderId,
      accountingIdempotencyKey: inbox.accountingIdempotencyKey,
      accountingPostRetryable: inbox.accountingPostRetryable,
      accountingRevision: inbox.accountingRevision,
      judgmentsRerunStatus: inbox.judgmentsRerunStatus,
      judgmentsRerunRevision: inbox.judgmentsRerunRevision,
    })
    .from(inbox)
    .where(and(eq(inbox.id, params.id), eq(inbox.teamId, params.teamId)))
    .for("update")
    .limit(1);
  return row;
}

export type LockedInvoice = NonNullable<
  Awaited<ReturnType<typeof lockInvoiceForAction>>
>;

/**
 * Commits a user revision of a processed invoice as the next processing
 * revision, but only while it is still the revision the user acted on and
 * the invoice is neither processing nor deleted. Returns null otherwise.
 */
export async function reviseInvoice(
  db: Executor,
  params: {
    id: string;
    teamId: string;
    expectedRevision: number;
    set: Partial<typeof inbox.$inferInsert>;
  },
) {
  const [row] = await db
    .update(inbox)
    .set({
      ...params.set,
      processingRevision: sql`${inbox.processingRevision} + 1`,
    })
    .where(
      and(
        eq(inbox.id, params.id),
        eq(inbox.teamId, params.teamId),
        eq(inbox.processingRevision, params.expectedRevision),
        ne(inbox.status, "processing"),
        ne(inbox.status, "deleted"),
        or(
          sql`${inbox.intakeState} is null`,
          eq(inbox.intakeState, "accepted"),
        ),
      ),
    )
    .returning(completedInvoiceColumns);
  return row;
}

// --- Corrections ---------------------------------------------------------------

export type InvoiceCorrectionOutcome =
  (typeof invoiceCorrections.$inferInsert)["accountingOutcome"];

export async function nextCorrectionVersion(
  db: Executor,
  params: { invoiceId: string; teamId: string },
) {
  const [row] = await db
    .select({
      version: sql<number>`coalesce(max(${invoiceCorrections.version}), 0)::int`,
    })
    .from(invoiceCorrections)
    .where(
      and(
        eq(invoiceCorrections.invoiceId, params.invoiceId),
        eq(invoiceCorrections.teamId, params.teamId),
      ),
    );
  return (row?.version ?? 0) + 1;
}

export async function insertInvoiceCorrection(
  db: Executor,
  values: typeof invoiceCorrections.$inferInsert,
) {
  const [row] = await db.insert(invoiceCorrections).values(values).returning();
  if (!row) throw new Error("Unable to record the correction");
  return row;
}

/** The correction history of one invoice, newest first, with its actor. */
export async function listInvoiceCorrections(
  db: Pick<Database, "select">,
  params: { invoiceId: string; teamId: string },
) {
  return db
    .select({
      id: invoiceCorrections.id,
      version: invoiceCorrections.version,
      baseRevision: invoiceCorrections.baseRevision,
      revision: invoiceCorrections.revision,
      reason: invoiceCorrections.reason,
      changes: invoiceCorrections.changes,
      accountingOutcome: invoiceCorrections.accountingOutcome,
      provider: invoiceCorrections.provider,
      providerId: invoiceCorrections.providerId,
      updateStatus: invoiceCorrections.updateStatus,
      updateError: invoiceCorrections.updateError,
      updateRetryable: invoiceCorrections.updateRetryable,
      updatedAt: invoiceCorrections.updatedAt,
      createdAt: invoiceCorrections.createdAt,
      actor: {
        id: users.id,
        fullName: users.fullName,
        email: users.email,
      },
    })
    .from(invoiceCorrections)
    .leftJoin(users, eq(users.id, invoiceCorrections.actorId))
    .where(
      and(
        eq(invoiceCorrections.invoiceId, params.invoiceId),
        eq(invoiceCorrections.teamId, params.teamId),
      ),
    )
    .orderBy(desc(invoiceCorrections.version));
}

/** The machine reading an invoice's current record was corrected from. */
export async function getInvoiceOriginalExtraction(
  db: Pick<Database, "select">,
  params: { invoiceId: string; teamId: string },
) {
  const [row] = await db
    .select({ extractionOriginal: inbox.extractionOriginal })
    .from(inbox)
    .where(
      and(eq(inbox.id, params.invoiceId), eq(inbox.teamId, params.teamId)),
    );
  return row?.extractionOriginal ?? null;
}

/**
 * Also claims a new document type and number for a posted invoice whose
 * bill is updated to it. The claim it already holds is kept, so neither the
 * old nor the new number can be posted again as a second bill. Returns the
 * invoice holding the new claim.
 */
export async function claimAdditionalPostingKey(
  db: Executor,
  params: { teamId: string; identityKey: string; invoiceId: string },
) {
  await db.insert(accountingPostClaims).values(params).onConflictDoNothing();
  const [claim] = await db
    .select({ invoiceId: accountingPostClaims.invoiceId })
    .from(accountingPostClaims)
    .where(
      and(
        eq(accountingPostClaims.teamId, params.teamId),
        eq(accountingPostClaims.identityKey, params.identityKey),
      ),
    );
  return claim?.invoiceId;
}

// --- Bill updates ------------------------------------------------------------------

/** A bill update that has not settled yet; at most one per invoice. */
export async function getPendingBillUpdate(
  db: Pick<Database, "select">,
  params: { invoiceId: string; teamId: string },
) {
  const [row] = await db
    .select({ id: invoiceCorrections.id, version: invoiceCorrections.version })
    .from(invoiceCorrections)
    .where(
      and(
        eq(invoiceCorrections.invoiceId, params.invoiceId),
        eq(invoiceCorrections.teamId, params.teamId),
        eq(invoiceCorrections.updateStatus, "queued"),
      ),
    )
    .limit(1);
  return row;
}

/** The newest correction that asked for the bill to be updated. */
export async function getLatestBillUpdate(
  db: Pick<Database, "select">,
  params: { invoiceId: string; teamId: string },
) {
  const [row] = await db
    .select()
    .from(invoiceCorrections)
    .where(
      and(
        eq(invoiceCorrections.invoiceId, params.invoiceId),
        eq(invoiceCorrections.teamId, params.teamId),
        isNotNull(invoiceCorrections.updateStatus),
      ),
    )
    .orderBy(desc(invoiceCorrections.version))
    .limit(1);
  return row;
}

export async function getBillUpdate(
  db: Pick<Database, "select">,
  params: { correctionId: string; teamId: string },
) {
  const [row] = await db
    .select({
      correction: invoiceCorrections,
      invoice: {
        id: inbox.id,
        status: inbox.status,
        accountingProvider: inbox.accountingProvider,
        accountingProviderId: inbox.accountingProviderId,
      },
    })
    .from(invoiceCorrections)
    .innerJoin(inbox, eq(inbox.id, invoiceCorrections.invoiceId))
    .where(
      and(
        eq(invoiceCorrections.id, params.correctionId),
        eq(invoiceCorrections.teamId, params.teamId),
      ),
    );
  return row;
}

/** Re-opens a failed or cancelled bill update for another attempt. */
export async function requeueBillUpdate(
  db: Executor,
  params: { correctionId: string; teamId: string },
) {
  const [row] = await db
    .update(invoiceCorrections)
    .set({ updateStatus: "queued", updateError: null, updateRetryable: null })
    .where(
      and(
        eq(invoiceCorrections.id, params.correctionId),
        eq(invoiceCorrections.teamId, params.teamId),
        or(
          eq(invoiceCorrections.updateStatus, "failed"),
          eq(invoiceCorrections.updateStatus, "cancelled"),
        ),
      ),
    )
    .returning({ id: invoiceCorrections.id });
  return row;
}

/**
 * Settles a bill update. Only a queued update changes, so a stale worker
 * cannot overwrite a newer outcome; a non-final failure keeps it queued with
 * the last error.
 */
export async function recordBillUpdateOutcome(
  db: Executor,
  params: {
    correctionId: string;
    teamId: string;
    status: "queued" | "updated" | "failed" | "cancelled";
    error?: string | null;
    retryable?: boolean | null;
  },
) {
  const [row] = await db
    .update(invoiceCorrections)
    .set({
      updateStatus: params.status,
      updateError: params.error ?? null,
      updateRetryable:
        params.status === "failed" || params.status === "cancelled"
          ? (params.retryable ?? null)
          : null,
      ...(params.status === "updated"
        ? { updatedAt: new Date().toISOString() }
        : {}),
    })
    .where(
      and(
        eq(invoiceCorrections.id, params.correctionId),
        eq(invoiceCorrections.teamId, params.teamId),
        eq(invoiceCorrections.updateStatus, "queued"),
      ),
    )
    .returning({ id: invoiceCorrections.id });
  return row;
}

/**
 * Queued bill updates whose job is missing or failed without the handler
 * recording an outcome. The SQL key mirrors `workflowKey.billUpdate`.
 */
export function listStalledBillUpdates(
  db: Pick<Database, "select">,
  params: { teamId?: string; invoiceId?: string; limit: number },
) {
  const conditions = [
    eq(invoiceCorrections.updateStatus, "queued"),
    or(sql`${workflowJobs.id} is null`, eq(workflowJobs.status, "failed")),
  ];
  if (params.teamId)
    conditions.push(eq(invoiceCorrections.teamId, params.teamId));
  if (params.invoiceId)
    conditions.push(eq(invoiceCorrections.invoiceId, params.invoiceId));
  return db
    .select({
      correctionId: invoiceCorrections.id,
      invoiceId: invoiceCorrections.invoiceId,
      teamId: invoiceCorrections.teamId,
      jobStatus: workflowJobs.status,
      jobError: workflowJobs.lastError,
    })
    .from(invoiceCorrections)
    .leftJoin(
      workflowJobs,
      and(
        eq(workflowJobs.name, "update-accounting-bill"),
        eq(
          workflowJobs.idempotencyKey,
          sql`${invoiceCorrections.teamId}::text || ':' || ${invoiceCorrections.invoiceId}::text || ':bill-update:' || ${invoiceCorrections.id}::text`,
        ),
      ),
    )
    .where(and(...conditions))
    .orderBy(asc(invoiceCorrections.createdAt))
    .limit(params.limit);
}

// --- Question reruns ------------------------------------------------------------

export async function markJudgmentsRerunQueued(
  db: Executor,
  params: { id: string; teamId: string; revision: number },
) {
  await db
    .update(inbox)
    .set({
      judgmentsRerunStatus: "queued",
      judgmentsRerunError: null,
      judgmentsRerunRevision: params.revision,
    })
    .where(
      and(
        eq(inbox.id, params.id),
        eq(inbox.teamId, params.teamId),
        eq(inbox.processingRevision, params.revision),
      ),
    );
}

/**
 * Records that a question rerun could not finish. Only the rerun still
 * outstanding for that revision is marked; a later revision supersedes it.
 */
export async function recordJudgmentsRerunFailure(
  db: Executor,
  params: { id: string; teamId: string; revision: number; error: string },
) {
  const [row] = await db
    .update(inbox)
    .set({ judgmentsRerunStatus: "failed", judgmentsRerunError: params.error })
    .where(
      and(
        eq(inbox.id, params.id),
        eq(inbox.teamId, params.teamId),
        eq(inbox.judgmentsRerunStatus, "queued"),
        eq(inbox.judgmentsRerunRevision, params.revision),
      ),
    )
    .returning({ id: inbox.id });
  return row;
}

/** Clears a rerun that no longer applies (the invoice moved on or went away). */
export async function clearJudgmentsRerun(
  db: Executor,
  params: { id: string; teamId: string; revision: number },
) {
  await db
    .update(inbox)
    .set({
      judgmentsRerunStatus: null,
      judgmentsRerunError: null,
      judgmentsRerunRevision: null,
    })
    .where(
      and(
        eq(inbox.id, params.id),
        eq(inbox.teamId, params.teamId),
        eq(inbox.judgmentsRerunRevision, params.revision),
      ),
    );
}

/**
 * Queued question reruns whose job is missing or failed without recording
 * an outcome. The SQL key mirrors `workflowKey.judgments`.
 */
export function listStalledJudgmentReruns(
  db: Pick<Database, "select">,
  params: { teamId?: string; invoiceId?: string; limit: number },
) {
  const conditions = [
    eq(inbox.judgmentsRerunStatus, "queued"),
    isNotNull(inbox.judgmentsRerunRevision),
    isNotNull(inbox.teamId),
    or(sql`${workflowJobs.id} is null`, eq(workflowJobs.status, "failed")),
  ];
  if (params.teamId) conditions.push(eq(inbox.teamId, params.teamId));
  if (params.invoiceId) conditions.push(eq(inbox.id, params.invoiceId));
  return db
    .select({
      invoiceId: inbox.id,
      teamId: sql<string>`${inbox.teamId}`,
      revision: sql<number>`${inbox.judgmentsRerunRevision}`,
      jobStatus: workflowJobs.status,
      jobError: workflowJobs.lastError,
    })
    .from(inbox)
    .leftJoin(
      workflowJobs,
      and(
        eq(workflowJobs.name, "rerun-judgments"),
        eq(
          workflowJobs.idempotencyKey,
          sql`${inbox.teamId}::text || ':' || ${inbox.id}::text || ':judgments:r' || ${inbox.judgmentsRerunRevision}::text`,
        ),
      ),
    )
    .where(and(...conditions))
    .orderBy(asc(inbox.createdAt))
    .limit(params.limit);
}

// --- Stalled processing ----------------------------------------------------------

/**
 * Documents still `processing` whose processing job failed without the
 * handler recording the failure (a lease that expired after the final
 * attempt) and with no processing job pending. Without this they would read
 * as processing for ever and offer no retry.
 */
export function listStalledProcessing(
  db: Pick<Database, "select">,
  params: { teamId?: string; invoiceId?: string; limit: number },
) {
  const conditions = [
    eq(inbox.status, "processing"),
    or(sql`${inbox.intakeState} is null`, eq(inbox.intakeState, "accepted")),
    sql`exists (select 1 from workflow_jobs j
      where j.name = 'process-attachment'
        and j.team_id = ${inbox.teamId}
        and j.payload ->> 'inboxId' = ${inbox.id}::text
        and j.status = 'failed')`,
    sql`not exists (select 1 from workflow_jobs j
      where j.name = 'process-attachment'
        and j.team_id = ${inbox.teamId}
        and j.payload ->> 'inboxId' = ${inbox.id}::text
        and j.status in ('queued', 'running'))`,
  ];
  if (params.teamId) conditions.push(eq(inbox.teamId, params.teamId));
  if (params.invoiceId) conditions.push(eq(inbox.id, params.invoiceId));
  return db
    .select({ id: inbox.id, teamId: sql<string>`${inbox.teamId}` })
    .from(inbox)
    .where(and(...conditions))
    .orderBy(asc(inbox.createdAt))
    .limit(params.limit);
}
