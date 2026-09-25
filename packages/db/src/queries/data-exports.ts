import type { Database, PrimaryDatabase } from "@db/client";
import {
  type DataExportSummary,
  accountingConnections,
  dataExports,
  inboundEmails,
  inbox,
  inboxAccounts,
  inboxRedeliveries,
  questionAnswers,
  questionRuns,
  supplierEvents,
  suppliers,
  teams,
  userQuestions,
  users,
  usersOnTeam,
  webhookDeliveries,
  webhookEndpoints,
  workflowJobs,
} from "@db/schema";
import {
  and,
  asc,
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

type Db = Database | PrimaryDatabase;

export type DataExport = typeof dataExports.$inferSelect;

/** Workflow that builds a workspace export archive. */
export const BUILD_DATA_EXPORT_WORKFLOW = "build-data-export";

export const DATA_EXPORT_MAX_ATTEMPTS = 3;

/** Raised when an owner asks for an export while one is still being built. */
export class DataExportInProgressError extends Error {
  readonly code = "CONFLICT" as const;
  constructor() {
    super("An export of this workspace is already being prepared.");
  }
}

/**
 * Records an owner's export request and queues its build in one transaction,
 * so a request is never left without the work that finishes it. One export
 * per workspace is built at a time.
 */
export async function createDataExport(
  db: Db,
  params: { teamId: string; requestedBy: string },
) {
  return db.transaction(async (tx) => {
    // Serialise concurrent requests for the same workspace on its row.
    await tx
      .select({ id: teams.id })
      .from(teams)
      .where(eq(teams.id, params.teamId))
      .for("update");

    const [active] = await tx
      .select({ id: dataExports.id })
      .from(dataExports)
      .where(
        and(
          eq(dataExports.teamId, params.teamId),
          inArray(dataExports.status, ["queued", "running"]),
        ),
      )
      .limit(1);

    if (active) throw new DataExportInProgressError();

    const [request] = await tx
      .insert(dataExports)
      .values({ teamId: params.teamId, requestedBy: params.requestedBy })
      .returning();

    if (!request) throw new Error("Unable to record export request");

    await tx.insert(workflowJobs).values({
      name: BUILD_DATA_EXPORT_WORKFLOW,
      // Workspace-scoped, so deleting the workspace removes queued work and
      // a running build holds the workspace purge back until its lease ends.
      teamId: params.teamId,
      payload: { exportId: request.id, teamId: params.teamId },
      idempotencyKey: request.id,
      maxAttempts: DATA_EXPORT_MAX_ATTEMPTS,
    });

    return request;
  });
}

const publicColumns = {
  id: dataExports.id,
  status: dataExports.status,
  progress: dataExports.progress,
  summary: dataExports.summary,
  fileName: dataExports.fileName,
  size: dataExports.size,
  sha256: dataExports.sha256,
  error: dataExports.error,
  requestedBy: dataExports.requestedBy,
  createdAt: dataExports.createdAt,
  startedAt: dataExports.startedAt,
  completedAt: dataExports.completedAt,
  expiresAt: dataExports.expiresAt,
  expiredAt: dataExports.expiredAt,
};

export function listDataExports(db: Db, teamId: string, limit = 10) {
  return db
    .select(publicColumns)
    .from(dataExports)
    .where(eq(dataExports.teamId, teamId))
    .orderBy(desc(dataExports.createdAt))
    .limit(limit);
}

/** Operator view across workspaces (`bun jobs:status`): ids and state only. */
export function listRecentDataExports(db: Db, limit = 50) {
  return db
    .select({
      id: dataExports.id,
      teamId: dataExports.teamId,
      status: dataExports.status,
      attempts: dataExports.attempts,
      progress: dataExports.progress,
      createdAt: dataExports.createdAt,
      expiresAt: dataExports.expiresAt,
      hasArchive: sql<boolean>`${dataExports.filePath} is not null`,
      error: dataExports.error,
    })
    .from(dataExports)
    .orderBy(desc(dataExports.createdAt))
    .limit(limit);
}

export async function getDataExport(
  db: Db,
  params: { id: string; teamId: string },
) {
  const [row] = await db
    .select()
    .from(dataExports)
    .where(
      and(eq(dataExports.id, params.id), eq(dataExports.teamId, params.teamId)),
    )
    .limit(1);
  return row;
}

/** For the download route, which is authorised by the signed capability. */
export async function getDataExportById(db: Db, id: string) {
  const [row] = await db
    .select()
    .from(dataExports)
    .where(eq(dataExports.id, id))
    .limit(1);
  return row;
}

/** Starts (or restarts after an interruption) a build. */
export async function beginDataExport(
  db: Db,
  params: { id: string; teamId: string },
) {
  const now = new Date().toISOString();
  const [row] = await db
    .update(dataExports)
    .set({
      status: "running",
      attempts: sql`${dataExports.attempts} + 1`,
      startedAt: sql`coalesce(${dataExports.startedAt}, ${now})`,
      progress: { documentsWritten: 0, documentsTotal: 0 },
      error: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(dataExports.id, params.id),
        eq(dataExports.teamId, params.teamId),
        inArray(dataExports.status, ["queued", "running"]),
      ),
    )
    .returning();
  return row;
}

export async function recordDataExportProgress(
  db: Db,
  params: {
    id: string;
    teamId: string;
    documentsWritten: number;
    documentsTotal: number;
  },
) {
  await db
    .update(dataExports)
    .set({
      progress: {
        documentsWritten: params.documentsWritten,
        documentsTotal: params.documentsTotal,
      },
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(dataExports.id, params.id),
        eq(dataExports.teamId, params.teamId),
        eq(dataExports.status, "running"),
      ),
    );
}

/**
 * Records where the archive will be stored before it is written, so an object
 * left by a failed or interrupted build is still found and removed.
 */
export async function recordDataExportObject(
  db: Db,
  params: { id: string; teamId: string; filePath: string[]; fileName: string },
) {
  await db
    .update(dataExports)
    .set({
      filePath: params.filePath,
      fileName: params.fileName,
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(dataExports.id, params.id),
        eq(dataExports.teamId, params.teamId),
        eq(dataExports.status, "running"),
      ),
    );
}

/**
 * Publishes a built archive. Returns nothing when the request is gone or no
 * longer running (the workspace was deleted meanwhile), so the caller removes
 * the archive it wrote instead of leaving it behind.
 */
export async function completeDataExport(
  db: Db,
  params: {
    id: string;
    teamId: string;
    filePath: string[];
    fileName: string;
    size: number;
    sha256: string;
    summary: DataExportSummary;
    expiresAt: Date;
  },
) {
  const now = new Date().toISOString();
  const [row] = await db
    .update(dataExports)
    .set({
      status: "ready",
      filePath: params.filePath,
      fileName: params.fileName,
      size: params.size,
      sha256: params.sha256,
      summary: params.summary,
      progress: {
        documentsWritten: params.summary.documents,
        documentsTotal: params.summary.documents,
      },
      completedAt: now,
      expiresAt: params.expiresAt.toISOString(),
      error: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(dataExports.id, params.id),
        eq(dataExports.teamId, params.teamId),
        eq(dataExports.status, "running"),
      ),
    )
    .returning();
  return row;
}

/** Records why a build stopped; `final` marks the request failed. */
export async function recordDataExportFailure(
  db: Db,
  params: { id: string; teamId: string; error: string; final: boolean },
) {
  const [row] = await db
    .update(dataExports)
    .set({
      error: params.error,
      ...(params.final
        ? { status: "failed" as const, completedAt: new Date().toISOString() }
        : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(dataExports.id, params.id),
        eq(dataExports.teamId, params.teamId),
        inArray(dataExports.status, ["queued", "running"]),
      ),
    )
    .returning();
  return row;
}

/** Shown to the owner when an export's build stopped without recording why. */
export const STALLED_DATA_EXPORT_ERROR =
  "The export stopped before it finished and was not completed. Request a new export.";

/**
 * Settles exports that can no longer finish: still `queued` or `running`
 * while no `build-data-export` job for them is queued or running, because the
 * job failed without the handler recording an outcome (a lease that expired
 * after the final attempt, a crashed worker), ended some other way, or no
 * longer exists. They become `failed`, so the owner
 * sees the failure and can request a new export, and the retention job
 * removes any archive the build recorded. Called by the runner's periodic
 * reconciler; the condition is re-checked in the update, so an export whose
 * job is live is never touched.
 */
export async function failStalledDataExports(db: Db, limit = 100) {
  const now = new Date().toISOString();
  const stalled = sql`not exists (
    select 1 from ${workflowJobs}
    where ${workflowJobs.name} = ${BUILD_DATA_EXPORT_WORKFLOW}
      and ${workflowJobs.idempotencyKey} = ${dataExports.id}::text
      and ${workflowJobs.status} in ('queued', 'running')
  )`;
  const candidates = db
    .select({ id: dataExports.id })
    .from(dataExports)
    .where(and(inArray(dataExports.status, ["queued", "running"]), stalled))
    .limit(limit);

  return db
    .update(dataExports)
    .set({
      status: "failed",
      error: STALLED_DATA_EXPORT_ERROR,
      completedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        inArray(dataExports.id, candidates),
        inArray(dataExports.status, ["queued", "running"]),
        stalled,
      ),
    )
    .returning({ id: dataExports.id, teamId: dataExports.teamId });
}

/**
 * Exports whose archive must go: ready ones past their expiry, and any
 * finished request that still names an object.
 */
export function listExpiredDataExports(db: Db, now: Date, limit = 100) {
  return db
    .select({
      id: dataExports.id,
      teamId: dataExports.teamId,
      status: dataExports.status,
      filePath: dataExports.filePath,
    })
    .from(dataExports)
    .where(
      or(
        and(
          eq(dataExports.status, "ready"),
          lte(dataExports.expiresAt, now.toISOString()),
        ),
        and(
          inArray(dataExports.status, ["failed", "expired"]),
          isNotNull(dataExports.filePath),
        ),
      ),
    )
    .orderBy(asc(dataExports.createdAt))
    .limit(limit);
}

/**
 * Marks an export expired once its archive is removed. Conditional on the
 * path the caller removed, so a concurrent change is never overwritten.
 */
export async function markDataExportExpired(
  db: Db,
  params: { id: string; teamId: string; filePath: string[] | null },
) {
  const now = new Date().toISOString();
  const [row] = await db
    .update(dataExports)
    .set({
      status: sql`case when ${dataExports.status} = 'ready' then 'expired'::data_export_status else ${dataExports.status} end`,
      filePath: null,
      expiredAt: sql`coalesce(${dataExports.expiredAt}, ${now})`,
      updatedAt: now,
    })
    .where(
      and(
        eq(dataExports.id, params.id),
        eq(dataExports.teamId, params.teamId),
        params.filePath
          ? sql`${dataExports.filePath} = array[${sql.join(
              params.filePath.map((part) => sql`${part}`),
              sql`, `,
            )}]::text[]`
          : isNull(dataExports.filePath),
      ),
    )
    .returning({ id: dataExports.id });
  return row;
}

/**
 * Everything an export contains apart from the document bytes, read for one
 * workspace. Secrets (tokens, webhook signing secrets, provider connection
 * references) are never selected.
 */
export async function getWorkspaceExportData(db: Db, teamId: string) {
  const [team] = await db
    .select({
      id: teams.id,
      name: teams.name,
      email: teams.email,
      baseCurrency: teams.baseCurrency,
      countryCode: teams.countryCode,
      createdAt: teams.createdAt,
    })
    .from(teams)
    .where(eq(teams.id, teamId))
    .limit(1);

  if (!team) return null;

  // Only accepted (or legacy) documents: reservations and cancelled uploads
  // never became invoices.
  const exportedInvoice = and(
    eq(inbox.teamId, teamId),
    ne(inbox.status, "deleted"),
    or(isNull(inbox.intakeState), eq(inbox.intakeState, "accepted")),
  );

  const [
    invoices,
    supplierRows,
    supplierEventRows,
    redeliveries,
    questions,
    members,
    mailboxes,
    accounting,
    endpoints,
    deliveries,
    jobs,
    exports,
    receivedEmails,
    questionRunRows,
    questionAnswerRows,
  ] = await Promise.all([
    db
      .select({
        id: inbox.id,
        createdAt: inbox.createdAt,
        fileName: inbox.fileName,
        filePath: inbox.filePath,
        contentType: inbox.contentType,
        size: inbox.size,
        contentHash: inbox.contentHash,
        displayName: inbox.displayName,
        status: inbox.status,
        type: inbox.type,
        amount: inbox.amount,
        currency: inbox.currency,
        taxAmount: inbox.taxAmount,
        taxRate: inbox.taxRate,
        taxType: inbox.taxType,
        date: inbox.date,
        description: inbox.description,
        website: inbox.website,
        extraction: inbox.extraction,
        judgments: inbox.judgments,
        processingError: inbox.processingError,
        intakeState: inbox.intakeState,
        referenceId: inbox.referenceId,
        inboxAccountId: inbox.inboxAccountId,
        accountingProvider: inbox.accountingProvider,
        accountingPostStatus: inbox.accountingPostStatus,
        accountingProviderId: inbox.accountingProviderId,
        accountingPostError: inbox.accountingPostError,
        accountingPostedAt: inbox.accountingPostedAt,
        supplierId: inbox.supplierId,
        supplierResolution: inbox.supplierResolution,
        supplierChecks: inbox.supplierChecks,
      })
      .from(inbox)
      .where(exportedInvoice)
      .orderBy(asc(inbox.createdAt), asc(inbox.id)),
    db
      .select({
        id: suppliers.id,
        name: suppliers.name,
        nameKey: suppliers.nameKey,
        vatKey: suppliers.vatKey,
        companyKey: suppliers.companyKey,
        mergedIntoId: suppliers.mergedIntoId,
        createdAt: suppliers.createdAt,
        updatedAt: suppliers.updatedAt,
      })
      .from(suppliers)
      .where(eq(suppliers.teamId, teamId))
      .orderBy(asc(suppliers.createdAt), asc(suppliers.id)),
    db
      .select({
        id: supplierEvents.id,
        action: supplierEvents.action,
        supplierId: supplierEvents.supplierId,
        targetSupplierId: supplierEvents.targetSupplierId,
        inboxId: supplierEvents.inboxId,
        actorId: supplierEvents.actorId,
        data: supplierEvents.data,
        revertsEventId: supplierEvents.revertsEventId,
        revertedAt: supplierEvents.revertedAt,
        createdAt: supplierEvents.createdAt,
      })
      .from(supplierEvents)
      .where(eq(supplierEvents.teamId, teamId))
      .orderBy(asc(supplierEvents.createdAt), asc(supplierEvents.id)),
    db
      .select({
        id: inboxRedeliveries.id,
        inboxId: inboxRedeliveries.inboxId,
        referenceId: inboxRedeliveries.referenceId,
        inboxAccountId: inboxRedeliveries.inboxAccountId,
        fileName: inboxRedeliveries.fileName,
        receivedAt: inboxRedeliveries.receivedAt,
      })
      .from(inboxRedeliveries)
      .innerJoin(inbox, eq(inbox.id, inboxRedeliveries.inboxId))
      .where(and(eq(inboxRedeliveries.teamId, teamId), exportedInvoice))
      .orderBy(asc(inboxRedeliveries.receivedAt), asc(inboxRedeliveries.id)),
    db
      .select({
        id: userQuestions.id,
        questionKey: userQuestions.questionKey,
        version: userQuestions.version,
        label: userQuestions.label,
        question: userQuestions.question,
        type: userQuestions.type,
        options: userQuestions.options,
        numberFormat: userQuestions.numberFormat,
        context: userQuestions.context,
        enabled: userQuestions.enabled,
        isDefault: userQuestions.isDefault,
        createdAt: userQuestions.createdAt,
        deletedAt: userQuestions.deletedAt,
      })
      .from(userQuestions)
      .where(eq(userQuestions.teamId, teamId))
      .orderBy(asc(userQuestions.questionKey), asc(userQuestions.version)),
    db
      .select({
        userId: usersOnTeam.userId,
        role: usersOnTeam.role,
        email: users.email,
        fullName: users.fullName,
        joinedAt: usersOnTeam.createdAt,
      })
      .from(usersOnTeam)
      .innerJoin(users, eq(users.id, usersOnTeam.userId))
      .where(eq(usersOnTeam.teamId, teamId))
      .orderBy(asc(usersOnTeam.createdAt)),
    db
      .select({
        id: inboxAccounts.id,
        provider: inboxAccounts.provider,
        email: inboxAccounts.email,
        status: inboxAccounts.status,
        createdAt: inboxAccounts.createdAt,
        lastAccessed: inboxAccounts.lastAccessed,
      })
      .from(inboxAccounts)
      .where(eq(inboxAccounts.teamId, teamId)),
    db
      .select({
        id: accountingConnections.id,
        provider: accountingConnections.provider,
        connectedAt: accountingConnections.connectedAt,
        disconnectedAt: accountingConnections.disconnectedAt,
      })
      .from(accountingConnections)
      .where(eq(accountingConnections.teamId, teamId)),
    db
      .select({
        id: webhookEndpoints.id,
        url: webhookEndpoints.url,
        events: webhookEndpoints.events,
        active: webhookEndpoints.active,
        createdAt: webhookEndpoints.createdAt,
      })
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.teamId, teamId)),
    db
      .select({
        id: webhookDeliveries.id,
        endpointId: webhookDeliveries.endpointId,
        invoiceId: webhookDeliveries.invoiceId,
        event: webhookDeliveries.event,
        status: webhookDeliveries.status,
        attempts: webhookDeliveries.attempts,
        deliveredAt: webhookDeliveries.deliveredAt,
        createdAt: webhookDeliveries.createdAt,
      })
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.teamId, teamId))
      .orderBy(asc(webhookDeliveries.createdAt)),
    db
      .select({
        id: workflowJobs.id,
        name: workflowJobs.name,
        status: workflowJobs.status,
        attempts: workflowJobs.attempts,
        createdAt: workflowJobs.createdAt,
        finishedAt: workflowJobs.finishedAt,
      })
      .from(workflowJobs)
      .where(eq(workflowJobs.teamId, teamId))
      .orderBy(asc(workflowJobs.createdAt)),
    db
      .select({
        id: dataExports.id,
        status: dataExports.status,
        requestedBy: dataExports.requestedBy,
        createdAt: dataExports.createdAt,
        completedAt: dataExports.completedAt,
      })
      .from(dataExports)
      .where(eq(dataExports.teamId, teamId))
      .orderBy(asc(dataExports.createdAt)),
    // Never the MIME source.
    db
      .select({
        id: inboundEmails.id,
        createdAt: inboundEmails.createdAt,
        recipient: inboundEmails.recipient,
        envelopeFrom: inboundEmails.envelopeFrom,
        headerFrom: inboundEmails.headerFrom,
        subject: inboundEmails.subject,
        status: inboundEmails.status,
        detail: inboundEmails.detail,
        deliveryCount: inboundEmails.deliveryCount,
        processedAt: inboundEmails.processedAt,
        attachments: inboundEmails.attachments,
      })
      .from(inboundEmails)
      .where(eq(inboundEmails.teamId, teamId))
      .orderBy(asc(inboundEmails.createdAt), asc(inboundEmails.id)),
    db
      .select({
        id: questionRuns.id,
        questionKey: questionRuns.questionKey,
        questionVersionId: questionRuns.questionVersionId,
        questionVersion: questionRuns.questionVersion,
        invoiceIds: questionRuns.invoiceIds,
        status: questionRuns.status,
        answered: questionRuns.answered,
        unknown: questionRuns.unknown,
        failed: questionRuns.failed,
        skipped: questionRuns.skipped,
        error: questionRuns.error,
        requestedBy: questionRuns.requestedBy,
        createdAt: questionRuns.createdAt,
        completedAt: questionRuns.completedAt,
      })
      .from(questionRuns)
      .where(eq(questionRuns.teamId, teamId))
      .orderBy(asc(questionRuns.createdAt), asc(questionRuns.id)),
    // Rerun answers on exported invoices, each with the answer it replaced.
    db
      .select({
        id: questionAnswers.id,
        runId: questionAnswers.runId,
        invoiceId: questionAnswers.invoiceId,
        questionKey: questionAnswers.questionKey,
        questionVersionId: questionAnswers.questionVersionId,
        invoiceRevision: questionAnswers.invoiceRevision,
        judgment: questionAnswers.judgment,
        previous: questionAnswers.previous,
        createdAt: questionAnswers.createdAt,
      })
      .from(questionAnswers)
      .innerJoin(inbox, eq(inbox.id, questionAnswers.invoiceId))
      .where(and(eq(questionAnswers.teamId, teamId), exportedInvoice))
      .orderBy(asc(questionAnswers.createdAt), asc(questionAnswers.id)),
  ]);

  return {
    team,
    invoices,
    suppliers: supplierRows,
    supplierEvents: supplierEventRows,
    redeliveries,
    questions,
    members,
    mailboxes,
    accounting,
    endpoints,
    deliveries,
    jobs,
    exports,
    inboundEmails: receivedEmails,
    questionRuns: questionRunRows,
    questionAnswers: questionAnswerRows,
  };
}

export type WorkspaceExportData = NonNullable<
  Awaited<ReturnType<typeof getWorkspaceExportData>>
>;
