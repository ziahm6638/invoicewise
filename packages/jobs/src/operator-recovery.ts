import type { Database } from "@invoicewise/db/client";
import {
  type OperatorJob,
  cancelWorkflowJobAsOperator,
  getDeliveryDecision,
  getInboundEmailForProcessing,
  getInvoiceForMatching,
  hasNewerWorkflowJob,
  reopenFailedInboundEmail,
  requeueFinishedWorkflowJob,
  resumeDeletionRequests,
} from "@invoicewise/db/queries";
import { releasable } from "@invoicewise/documents/delivery-policy";
import { InvoiceActionError } from "./action-error";
import { HELD_LOCKED_TEXT, HELD_RELEASABLE_TEXT } from "./activity";
import { workflowKey } from "./client";
import {
  reconcileDeliveries,
  redeliverWebhook,
  retryInvoiceDelivery,
} from "./delivery";
import { requestQuestionRerun } from "./exceptions";
import { retryIntakeProcessing } from "./intake";

/**
 * Operator recovery actions on queue jobs (docs/operations.md#recovery).
 *
 * A retry never restarts a job blindly: each workflow is re-driven through
 * the same supported path a customer's own recovery action uses (re-extract,
 * redeliver, retry delivery, rerun questions), so the durable record it
 * belongs to (the invoice, the delivery row, the received message) moves with
 * it and every idempotency guarantee still holds. Workflows without such a
 * path are refused with the action that recovers them instead.
 *
 * A cancel stops a job no live worker holds and records it failed; the
 * runner's reconcilers then settle its record as a visible, retryable failure
 * the customer can see and act on.
 */

export type OperatorRetryResult =
  | { status: "requeued"; action: string; detail: Record<string, unknown> }
  | { status: "not_found" }
  | { status: "not_failed"; jobStatus: string }
  | { status: "superseded" }
  | { status: "not_supported"; guidance: string }
  | { status: "refused"; reason: string };

export type OperatorCancelResult =
  | { status: "cancelled" }
  | { status: "not_found" }
  | { status: "not_cancellable"; jobStatus: string };

/** What recovers a workflow an operator does not retry directly. */
export const OPERATOR_RETRY_GUIDANCE: Record<string, string> = {
  "build-data-export": "The owner requests a new export in Settings → Data.",
  "invite-team-members": "An admin sends the invitation again.",
  "sync-inbox-account":
    "An admin syncs the mailbox from the inbox settings; scheduled syncs continue by themselves.",
  "initial-inbox-setup":
    "An admin reconnects the mailbox from the inbox settings.",
  "rerun-question": "An admin reruns the question from Settings → Questions.",
  "apply-retention": "Retention runs again at the next hourly slot by itself.",
  "onboard-team": "Onboarding mail is not re-sent by operators.",
};

/** Why an accounting retry re-drove nothing, and what recovers it. */
const ACCOUNTING_REFUSAL: Record<string, string> = {
  no_active_connection: "The workspace has no active accounting connection",
  in_progress: "Already being sent",
  already_posted: "The bill is already posted",
  dismissed: "The hold was dismissed: nothing is sent for this revision",
  admin_required: "An owner or admin retries it",
};

const text = (value: unknown) => (typeof value === "string" ? value : null);

const refused = (reason: string): OperatorRetryResult => ({
  status: "refused",
  reason,
});

/** Invoice action refusals (conflict, not found) become operator refusals. */
const asRefusal = (error: unknown) => {
  if (error instanceof InvoiceActionError) return refused(error.message);
  throw error;
};

async function retryFailedJob(
  db: Database,
  job: NonNullable<OperatorJob>,
): Promise<OperatorRetryResult> {
  const teamId = job.teamId;
  const subject = job.subject ?? {};
  switch (job.name) {
    case "process-attachment": {
      const inboxId = text(subject.inboxId);
      if (!teamId || !inboxId) return refused("The job names no invoice");
      const result = await retryIntakeProcessing(db, { teamId, inboxId }).catch(
        asRefusal,
      );
      if (!result) return refused("The invoice was deleted or never accepted");
      if ("status" in result) return result;
      return {
        status: "requeued",
        action: "reextract",
        detail: {
          invoiceId: inboxId,
          jobId: result.jobId,
          deduplicated: result.deduplicated,
        },
      };
    }
    case "rerun-judgments": {
      const invoiceId = text(subject.invoiceId);
      const revision = subject.revision;
      if (!teamId || !invoiceId || typeof revision !== "number") {
        return refused("The job names no invoice revision");
      }
      const result = await requestQuestionRerun(db, {
        invoiceId,
        teamId,
        expectedRevision: revision,
      }).catch(asRefusal);
      if ("status" in result) return result;
      return {
        status: "requeued",
        action: "rerun_questions",
        detail: { invoiceId, revision, deduplicated: result.deduplicated },
      };
    }
    case "deliver-webhook": {
      const deliveryId = text(subject.deliveryId);
      if (!teamId || !deliveryId) return refused("The job names no delivery");
      // Settle the delivery from its failed job first, so it reads failed.
      await reconcileDeliveries(db, { teamId });
      const result = await redeliverWebhook(db, { deliveryId, teamId });
      switch (result.status) {
        case "requeued":
          return {
            status: "requeued",
            action: "redeliver",
            detail: { deliveryId, eventId: result.eventId },
          };
        case "not_found":
          return refused("The delivery no longer exists");
        case "not_failed":
          return refused("The delivery is not failed");
        case "endpoint_disabled":
          return refused("The webhook endpoint is disabled");
        case "payload_expired":
          return refused("Retention removed the event payload");
      }
      return refused("The delivery could not be redriven");
    }
    case "post-accounting-draft":
    case "update-accounting-bill": {
      const invoiceId = text(subject.invoiceId);
      if (!teamId || !invoiceId) return refused("The job names no invoice");
      await reconcileDeliveries(db, { teamId, invoiceId });
      const result = await retryInvoiceDelivery(db, {
        invoiceId,
        teamId,
        teamRole: null,
        operator: true,
      });
      if (!result) return refused("The invoice was deleted");
      const accounting =
        job.name === "post-accounting-draft"
          ? result.accounting
          : result.billUpdate;
      const notRequeued =
        accounting === "held"
          ? `Held by the delivery rules: ${
              releasable(
                (
                  await getDeliveryDecision(db, {
                    invoiceId,
                    teamId,
                    revision: result.revision,
                  })
                )?.reasons ?? [],
              )
                ? HELD_RELEASABLE_TEXT.toLowerCase()
                : HELD_LOCKED_TEXT.toLowerCase()
            }`
          : ACCOUNTING_REFUSAL[accounting];
      const redriven =
        result.accounting === "requeued" ||
        result.billUpdate === "requeued" ||
        result.webhooks.requeued > 0;
      if (!redriven) {
        return refused(notRequeued ?? "Nothing failed to retry");
      }
      return {
        status: "requeued",
        action: "retry_delivery",
        detail: {
          invoiceId,
          revision: result.revision,
          accounting: result.accounting,
          billUpdate: result.billUpdate,
          webhooksRequeued: result.webhooks.requeued,
          ...(accounting !== "requeued" && notRequeued ? { notRequeued } : {}),
        },
      };
    }
    case "match-invoice": {
      const invoiceId = text(subject.invoiceId);
      if (!teamId || !invoiceId) return refused("The job names no invoice");
      const invoice = await getInvoiceForMatching(db, {
        teamId,
        inboxId: invoiceId,
      });
      if (!invoice) return refused("The invoice was deleted");
      const restarted = await requeueFinishedWorkflowJob(db, {
        name: "match-invoice",
        idempotencyKey: workflowKey.match(
          teamId,
          invoiceId,
          invoice.processingRevision,
        ),
        teamId,
      });
      if (!restarted) {
        return refused("The invoice's current revision has no finished match");
      }
      return {
        status: "requeued",
        action: "rematch",
        detail: {
          invoiceId,
          revision: invoice.processingRevision,
          jobId: restarted.id,
        },
      };
    }
    case "reconcile-invoice": {
      // Re-runs the reconciliation of the same match decision at the same
      // revision; a newer reconcile job for the invoice supersedes this one.
      const invoiceId = text(subject.invoiceId);
      const matchId = text(subject.matchId);
      const revision =
        typeof subject.revision === "number" ? subject.revision : null;
      if (!teamId || !invoiceId || !matchId || revision === null) {
        return refused("The job names no reconciliation");
      }
      const restarted = await requeueFinishedWorkflowJob(db, {
        name: "reconcile-invoice",
        idempotencyKey: workflowKey.reconcile(
          teamId,
          invoiceId,
          matchId,
          revision,
        ),
        teamId,
      });
      if (!restarted) return refused("The reconciliation job is not finished");
      return {
        status: "requeued",
        action: "reconcile",
        detail: { invoiceId, matchId, revision, jobId: restarted.id },
      };
    }
    case "process-inbound-email": {
      const inboundEmailId = text(subject.inboundEmailId);
      if (!teamId || !inboundEmailId) {
        return refused("The job names no received message");
      }
      return db.transaction(async (tx) => {
        const executor = tx as unknown as Database;
        const reopened = await reopenFailedInboundEmail(executor, {
          id: inboundEmailId,
          teamId,
        });
        if (!reopened) {
          const email = await getInboundEmailForProcessing(executor, {
            id: inboundEmailId,
            teamId,
          });
          // Still `received`: its failed job has not been settled yet.
          if (email?.status !== "received") {
            return refused(
              "The message was processed, or its source is no longer kept",
            );
          }
        }
        const restarted = await requeueFinishedWorkflowJob(executor, {
          name: "process-inbound-email",
          idempotencyKey: workflowKey.inboundEmail(inboundEmailId),
          teamId,
        });
        if (!restarted) return refused("The message's job is not finished");
        return {
          status: "requeued" as const,
          action: "reprocess_message",
          detail: { inboundEmailId, jobId: restarted.id },
        };
      });
    }
    case "purge-deleted-data": {
      const deletionId = text(subject.deletionId);
      if (!deletionId) return refused("The job names no deletion request");
      const resumed = await resumeDeletionRequests(db, new Date(), [
        deletionId,
      ]);
      if (resumed.length === 0) {
        return refused("The deletion finished or is already running");
      }
      return {
        status: "requeued",
        action: "resume_deletion",
        detail: { deletionId },
      };
    }
    default:
      return {
        status: "not_supported",
        guidance:
          OPERATOR_RETRY_GUIDANCE[job.name] ??
          "This workflow has no operator retry.",
      };
  }
}

/**
 * Retries one failed job through its workflow's supported recovery path.
 * Only a failed job that is the latest of its workflow for its record is
 * retried; a stuck (running, lease expired) job is picked up by the next
 * runner by itself, or cancelled.
 */
export async function retryJobAsOperator(
  db: Database,
  job: OperatorJob | undefined,
): Promise<OperatorRetryResult> {
  if (!job) return { status: "not_found" };
  if (job.status !== "failed") {
    return { status: "not_failed", jobStatus: job.status };
  }
  if (await hasNewerWorkflowJob(db, job)) return { status: "superseded" };
  return retryFailedJob(db, job);
}

/** Cancels one job no live worker holds (queued, or running past its lease). */
export async function cancelJobAsOperator(
  db: Database,
  job: OperatorJob | undefined,
  reason: string,
): Promise<OperatorCancelResult> {
  if (!job) return { status: "not_found" };
  const cancelled = await cancelWorkflowJobAsOperator(db, {
    id: job.id,
    reason,
  });
  if (!cancelled) return { status: "not_cancellable", jobStatus: job.status };
  return { status: "cancelled" };
}
