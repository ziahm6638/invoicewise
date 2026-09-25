import type { Database } from "@db/client";
import {
  deliveryDecisions,
  inboundEmails,
  inbox,
  inboxRedeliveries,
  invoiceCorrections,
  questionAnswers,
  questionRuns,
  users,
  webhookDeliveries,
  webhookEndpoints,
  workflowJobs,
} from "@db/schema";
import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import { listInvoiceAuditEvents } from "./audit-events";

/** Rows read per source; an invoice's trace is bounded by these. */
export const INVOICE_ACTIVITY_SOURCE_LIMIT = 100;

/**
 * The queue's jobs for one invoice, newest first. Jobs are linked through
 * the identifiers in their payload (the retention job empties it 30 days
 * after a job finished); each link is served by a workflow_jobs expression
 * index on (team_id, payload ->> key), so the read never scans the
 * workspace's whole job history.
 */
export const invoiceJobsQuery = (
  db: Database,
  params: {
    teamId: string;
    invoiceId: string;
    deliveryIds: string[];
    correctionIds: string[];
  },
) =>
  db
    .select({
      id: workflowJobs.id,
      name: workflowJobs.name,
      status: workflowJobs.status,
      attempts: workflowJobs.attempts,
      maxAttempts: workflowJobs.maxAttempts,
      runAt: workflowJobs.runAt,
      leaseExpiresAt: workflowJobs.leaseExpiresAt,
      finishedAt: workflowJobs.finishedAt,
      lastError: workflowJobs.lastError,
      createdAt: workflowJobs.createdAt,
      updatedAt: workflowJobs.updatedAt,
      deliveryId: sql<string | null>`${workflowJobs.payload} ->> 'deliveryId'`,
      correctionId: sql<
        string | null
      >`${workflowJobs.payload} ->> 'correctionId'`,
      revision: sql<
        number | null
      >`(${workflowJobs.payload} ->> 'revision')::int`,
    })
    .from(workflowJobs)
    .where(
      and(
        eq(workflowJobs.teamId, params.teamId),
        or(
          sql`${workflowJobs.payload} ->> 'inboxId' = ${params.invoiceId}`,
          sql`${workflowJobs.payload} ->> 'invoiceId' = ${params.invoiceId}`,
          inArray(
            sql`${workflowJobs.payload} ->> 'deliveryId'`,
            params.deliveryIds,
          ),
          inArray(
            sql`${workflowJobs.payload} ->> 'correctionId'`,
            params.correctionIds,
          ),
        ),
      ),
    )
    .orderBy(desc(workflowJobs.createdAt))
    .limit(INVOICE_ACTIVITY_SOURCE_LIMIT);

/**
 * Everything the invoice activity trace is built from, read for one invoice
 * of one workspace from the existing records: the intake row, the received
 * message, re-deliveries, the queue's jobs for the invoice, webhook
 * deliveries, delivery-rule decisions, corrections, question answers and the
 * audit trail. Nothing is
 * copied into a separate log. Extracted values and document text are never
 * selected. Returns null for an invoice outside the workspace.
 */
export async function getInvoiceActivitySources(
  db: Database,
  params: { teamId: string; invoiceId: string },
) {
  const [invoice] = await db
    .select({
      id: inbox.id,
      createdAt: inbox.createdAt,
      status: inbox.status,
      intakeState: inbox.intakeState,
      contentType: inbox.contentType,
      processingRevision: inbox.processingRevision,
      processingError: inbox.processingError,
      intakeError: inbox.intakeError,
      inboxAccountId: inbox.inboxAccountId,
      inboundEmailId: inbox.inboundEmailId,
      validationStatus: sql<string | null>`${inbox.validation} ->> 'status'`,
      accountingProvider: inbox.accountingProvider,
      accountingPostStatus: inbox.accountingPostStatus,
      accountingProviderId: inbox.accountingProviderId,
      accountingPostError: inbox.accountingPostError,
      accountingPostRetryable: inbox.accountingPostRetryable,
      accountingPostedAt: inbox.accountingPostedAt,
      accountingRevision: inbox.accountingRevision,
      judgmentsRerunStatus: inbox.judgmentsRerunStatus,
      judgmentsRerunError: inbox.judgmentsRerunError,
      judgmentsRerunRevision: inbox.judgmentsRerunRevision,
    })
    .from(inbox)
    .where(and(eq(inbox.id, params.invoiceId), eq(inbox.teamId, params.teamId)))
    .limit(1);
  if (!invoice) return null;

  const scope = { teamId: params.teamId, invoiceId: invoice.id };
  const [deliveryIds, correctionIds] = await Promise.all([
    db
      .select({ id: sql<string>`${webhookDeliveries.id}::text` })
      .from(webhookDeliveries)
      .where(
        and(
          eq(webhookDeliveries.teamId, params.teamId),
          eq(webhookDeliveries.invoiceId, invoice.id),
        ),
      )
      .then((rows) => rows.map((row) => row.id)),
    db
      .select({ id: sql<string>`${invoiceCorrections.id}::text` })
      .from(invoiceCorrections)
      .where(
        and(
          eq(invoiceCorrections.teamId, params.teamId),
          eq(invoiceCorrections.invoiceId, invoice.id),
        ),
      )
      .then((rows) => rows.map((row) => row.id)),
  ]);

  const [
    email,
    redeliveries,
    jobs,
    deliveries,
    decisions,
    corrections,
    answers,
    failedRuns,
    audit,
  ] = await Promise.all([
    invoice.inboundEmailId
      ? db
          .select({
            id: inboundEmails.id,
            createdAt: inboundEmails.createdAt,
            messageId: inboundEmails.messageId,
            sender: inboundEmails.headerFrom,
            status: inboundEmails.status,
            detail: inboundEmails.detail,
          })
          .from(inboundEmails)
          .where(
            and(
              eq(inboundEmails.id, invoice.inboundEmailId),
              eq(inboundEmails.teamId, params.teamId),
            ),
          )
          .limit(1)
          .then(([row]) => row ?? null)
      : null,
    db
      .select({
        id: inboxRedeliveries.id,
        receivedAt: inboxRedeliveries.receivedAt,
        inboxAccountId: inboxRedeliveries.inboxAccountId,
      })
      .from(inboxRedeliveries)
      .where(
        and(
          eq(inboxRedeliveries.teamId, params.teamId),
          eq(inboxRedeliveries.inboxId, invoice.id),
        ),
      )
      .orderBy(asc(inboxRedeliveries.receivedAt))
      .limit(INVOICE_ACTIVITY_SOURCE_LIMIT),
    invoiceJobsQuery(db, {
      teamId: params.teamId,
      invoiceId: invoice.id,
      deliveryIds,
      correctionIds,
    }),
    db
      .select({
        id: webhookDeliveries.id,
        endpointId: webhookDeliveries.endpointId,
        endpointUrl: webhookEndpoints.url,
        event: webhookDeliveries.event,
        eventId: webhookDeliveries.eventId,
        revision: webhookDeliveries.revision,
        status: webhookDeliveries.status,
        attempts: webhookDeliveries.attempts,
        lastError: webhookDeliveries.lastError,
        retryable: webhookDeliveries.retryable,
        deliveredAt: webhookDeliveries.deliveredAt,
        createdAt: webhookDeliveries.createdAt,
        updatedAt: webhookDeliveries.updatedAt,
      })
      .from(webhookDeliveries)
      .innerJoin(
        webhookEndpoints,
        eq(webhookEndpoints.id, webhookDeliveries.endpointId),
      )
      .where(
        and(
          eq(webhookDeliveries.teamId, params.teamId),
          eq(webhookDeliveries.invoiceId, invoice.id),
        ),
      )
      .orderBy(desc(webhookDeliveries.createdAt))
      .limit(INVOICE_ACTIVITY_SOURCE_LIMIT),
    db
      .select({
        id: deliveryDecisions.id,
        revision: deliveryDecisions.revision,
        policyVersion: deliveryDecisions.policyVersion,
        outcome: deliveryDecisions.outcome,
        rules: sql<
          string[]
        >`coalesce((select array_agg(reason ->> 'rule') from jsonb_array_elements(${deliveryDecisions.reasons}) as reason), '{}')`,
        accounting: deliveryDecisions.accounting,
        webhooks: deliveryDecisions.webhooks,
        resolution: deliveryDecisions.resolution,
        resolutionReason: deliveryDecisions.resolutionReason,
        resolvedBy: deliveryDecisions.resolvedBy,
        resolvedByName: sql<
          string | null
        >`coalesce(${users.fullName}, ${users.email})`,
        resolvedAt: deliveryDecisions.resolvedAt,
        createdAt: deliveryDecisions.createdAt,
      })
      .from(deliveryDecisions)
      .leftJoin(users, eq(users.id, deliveryDecisions.resolvedBy))
      .where(
        and(
          eq(deliveryDecisions.teamId, params.teamId),
          eq(deliveryDecisions.invoiceId, invoice.id),
        ),
      )
      .orderBy(desc(deliveryDecisions.revision))
      .limit(INVOICE_ACTIVITY_SOURCE_LIMIT),
    db
      .select({
        id: invoiceCorrections.id,
        version: invoiceCorrections.version,
        baseRevision: invoiceCorrections.baseRevision,
        revision: invoiceCorrections.revision,
        actorId: invoiceCorrections.actorId,
        actorName: sql<
          string | null
        >`coalesce(${users.fullName}, ${users.email})`,
        fields: sql<
          string[]
        >`coalesce((select array_agg(change ->> 'field') from jsonb_array_elements(${invoiceCorrections.changes}) as change), '{}')`,
        accountingOutcome: invoiceCorrections.accountingOutcome,
        provider: invoiceCorrections.provider,
        providerId: invoiceCorrections.providerId,
        updateStatus: invoiceCorrections.updateStatus,
        updateError: invoiceCorrections.updateError,
        updatedAt: invoiceCorrections.updatedAt,
        createdAt: invoiceCorrections.createdAt,
      })
      .from(invoiceCorrections)
      .leftJoin(users, eq(users.id, invoiceCorrections.actorId))
      .where(
        and(
          eq(invoiceCorrections.teamId, params.teamId),
          eq(invoiceCorrections.invoiceId, invoice.id),
        ),
      )
      .orderBy(desc(invoiceCorrections.version))
      .limit(INVOICE_ACTIVITY_SOURCE_LIMIT),
    db
      .select({
        id: questionAnswers.id,
        runId: questionAnswers.runId,
        questionKey: questionAnswers.questionKey,
        invoiceRevision: questionAnswers.invoiceRevision,
        requestedBy: questionRuns.requestedBy,
        requestedByName: sql<
          string | null
        >`coalesce(${users.fullName}, ${users.email})`,
        createdAt: questionAnswers.createdAt,
      })
      .from(questionAnswers)
      .innerJoin(questionRuns, eq(questionRuns.id, questionAnswers.runId))
      .leftJoin(users, eq(users.id, questionRuns.requestedBy))
      .where(
        and(
          eq(questionAnswers.teamId, params.teamId),
          eq(questionAnswers.invoiceId, invoice.id),
        ),
      )
      .orderBy(desc(questionAnswers.createdAt))
      .limit(INVOICE_ACTIVITY_SOURCE_LIMIT),
    db
      .select({
        id: questionRuns.id,
        questionKey: questionRuns.questionKey,
        status: questionRuns.status,
        error: questionRuns.error,
        createdAt: questionRuns.createdAt,
        completedAt: questionRuns.completedAt,
      })
      .from(questionRuns)
      .where(
        and(
          eq(questionRuns.teamId, params.teamId),
          eq(questionRuns.status, "failed"),
          sql`${invoice.id}::uuid = any(${questionRuns.invoiceIds})`,
        ),
      )
      .orderBy(desc(questionRuns.createdAt))
      .limit(INVOICE_ACTIVITY_SOURCE_LIMIT),
    listInvoiceAuditEvents(db, {
      ...scope,
      limit: INVOICE_ACTIVITY_SOURCE_LIMIT,
    }),
  ]);

  return {
    invoice,
    email,
    redeliveries,
    jobs,
    deliveries,
    decisions,
    corrections,
    answers,
    failedRuns,
    audit,
  };
}

export type InvoiceActivitySources = NonNullable<
  Awaited<ReturnType<typeof getInvoiceActivitySources>>
>;
