import type { Database, PrimaryDatabase } from "@db/client";
import {
  deletionRequests,
  inbox,
  webhookDeliveries,
  workflowJobs,
} from "@db/schema";
import {
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
  sql,
} from "drizzle-orm";

type Db = Database | PrimaryDatabase;

/**
 * Retention steps. Each one changes at most `limit` rows chosen by a
 * predicate that stops matching once a row has been handled, so a sweep that
 * is interrupted simply resumes with the rows that still match. None of them
 * selects by workspace: they apply the same schedule to every workspace and
 * only ever touch the rows the schedule names.
 */

/**
 * Removes cancelled intake records once their upload is older than the
 * cutoff: uploads that never became documents, and invoices a member deleted
 * (deletion cancels the record and removes its file at once, but keeps the
 * row). Records whose object removal is still pending or ambiguous stay: they
 * are the durable reminder that bytes may remain.
 */
export async function deleteExpiredCancelledIntake(
  db: Db,
  params: { before: Date; limit: number },
) {
  const due = and(
    eq(inbox.intakeState, "cancelled"),
    lt(inbox.createdAt, params.before.toISOString()),
    eq(inbox.objectRemovalPending, false),
    eq(inbox.objectRemovalAmbiguous, false),
  );
  const candidates = db
    .select({ id: inbox.id })
    .from(inbox)
    .where(due)
    .limit(params.limit);

  return db
    .delete(inbox)
    .where(and(inArray(inbox.id, candidates), due))
    .returning({ id: inbox.id, teamId: inbox.teamId });
}

/**
 * Clears the provider message reference captured from a source email once
 * the cutoff has passed. InvoiceWise stores no email body or headers; the
 * reference (message id and attachment name) is the only email-derived
 * content kept beside the invoice itself. Duplicate mail is still recognised
 * afterwards by the document's content hash.
 */
export async function clearExpiredEmailReferences(
  db: Db,
  params: { before: Date; limit: number },
) {
  const due = and(
    isNotNull(inbox.referenceId),
    lt(inbox.createdAt, params.before.toISOString()),
    // A reservation may still be publishing; it is settled first.
    or(isNull(inbox.intakeState), ne(inbox.intakeState, "reserved")),
  );
  const candidates = db
    .select({ id: inbox.id })
    .from(inbox)
    .where(due)
    .limit(params.limit);

  return db
    .update(inbox)
    .set({ referenceId: null })
    .where(and(inArray(inbox.id, candidates), due))
    .returning({ id: inbox.id, teamId: inbox.teamId });
}

const EMPTY_PAYLOAD = sql`'{}'::jsonb`;

/**
 * Empties the payload, result and error of finished workflow jobs. The row
 * (name, status, attempts, times and idempotency key) stays, so finished work
 * is never run again and the queue history remains traceable.
 */
export async function redactFinishedJobPayloads(
  db: Db,
  params: { before: Date; limit: number },
) {
  const due = and(
    inArray(workflowJobs.status, ["succeeded", "failed"]),
    lt(workflowJobs.finishedAt, params.before.toISOString()),
    or(
      sql`${workflowJobs.payload} <> ${EMPTY_PAYLOAD}`,
      isNotNull(workflowJobs.result),
      isNotNull(workflowJobs.lastError),
    ),
  );
  const candidates = db
    .select({ id: workflowJobs.id })
    .from(workflowJobs)
    .where(due)
    .limit(params.limit);

  return db
    .update(workflowJobs)
    .set({ payload: {}, result: null, lastError: null })
    .where(and(inArray(workflowJobs.id, candidates), due))
    .returning({ id: workflowJobs.id, teamId: workflowJobs.teamId });
}

/** Empties the invoice payload of webhook deliveries that have finished. */
export async function redactFinishedWebhookPayloads(
  db: Db,
  params: { before: Date; limit: number },
) {
  const due = and(
    inArray(webhookDeliveries.status, ["succeeded", "failed"]),
    lt(webhookDeliveries.updatedAt, params.before.toISOString()),
    sql`${webhookDeliveries.payload} <> ${EMPTY_PAYLOAD}`,
  );
  const candidates = db
    .select({ id: webhookDeliveries.id })
    .from(webhookDeliveries)
    .where(due)
    .limit(params.limit);

  return db
    .update(webhookDeliveries)
    .set({ payload: {} })
    .where(and(inArray(webhookDeliveries.id, candidates), due))
    .returning({ id: webhookDeliveries.id, teamId: webhookDeliveries.teamId });
}

/**
 * Removes completed deletion requests once no backup taken before the
 * deletion can still exist. Until then the request is what tells an operator
 * which subjects to re-delete after a restore; afterwards nothing is kept
 * that names the deleted workspace or account. Pending and failed requests
 * are never removed.
 */
export async function deleteSettledDeletionRequests(
  db: Db,
  params: { before: Date; limit: number },
) {
  const due = and(
    eq(deletionRequests.status, "completed"),
    lt(deletionRequests.completedAt, params.before.toISOString()),
  );
  const candidates = db
    .select({ id: deletionRequests.id })
    .from(deletionRequests)
    .where(due)
    .limit(params.limit);

  return db
    .delete(deletionRequests)
    .where(and(inArray(deletionRequests.id, candidates), due))
    .returning({ id: deletionRequests.id });
}
