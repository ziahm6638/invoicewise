import type { Database } from "@invoicewise/db/client";
import { enqueueWorkflowJob, getWorkflowJob } from "@invoicewise/db/queries";
import type { WorkflowRequest } from "./schema";

export type EnqueueWorkflowInput = WorkflowRequest & {
  idempotencyKey: string;
  teamId?: string;
  runAt?: Date;
  maxAttempts?: number;
};

export async function enqueueWorkflow(
  db: Database,
  input: EnqueueWorkflowInput,
) {
  const { name, payload, ...options } = input;
  const { job, deduplicated } = await enqueueWorkflowJob(db, {
    ...options,
    name,
    payload: payload as Record<string, unknown>,
  });
  return {
    id: job.id,
    name: job.name,
    status: job.status,
    deduplicated,
  };
}

export async function getWorkflowStatus(
  db: Database,
  input: { id: string; teamId: string },
) {
  const job = await getWorkflowJob(db, input);
  if (!job) return null;
  return {
    id: job.id,
    name: job.name,
    status: job.status,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    runAt: job.runAt,
    heartbeatAt: job.heartbeatAt,
    leaseExpiresAt: job.leaseExpiresAt,
    result: job.result,
    error: job.lastError,
  };
}

export const workflowKey = {
  /**
   * Identity of the processing intent. Mailbox ingestion keeps using the
   * provider reference so a redelivered message is deduplicated; all other
   * callers use the server-owned inbox id.
   */
  attachment: (teamId: string, inboxId: string, referenceId?: string) =>
    `${teamId}:${referenceId ?? inboxId}`,
  /** One processing intent per received message. */
  inboundEmail: (inboundEmailId: string) => inboundEmailId,
  inboxSetup: (accountId: string) => accountId,
  inboxSync: (accountId: string, occurrence: string) =>
    `${accountId}:${occurrence}`,
  invitations: (teamId: string, identifiers: readonly string[]) =>
    `${teamId}:${[...identifiers].sort().join(",")}`,
  onboarding: (userId: string, stage = "welcome") => `${userId}:${stage}`,
  /**
   * One accounting intent per processing revision. The SQL mirror in
   * `listStalledAccountingPosts` (packages/db) must build the same key.
   */
  accounting: (teamId: string, invoiceId: string, revision: number) =>
    `${teamId}:${invoiceId}:r${revision}`,
  /**
   * One separate attachment upload per provider record; a later retry
   * restarts the same job.
   */
  accountingAttachment: (
    teamId: string,
    invoiceId: string,
    providerId: string,
  ) => `${teamId}:${invoiceId}:attach:${providerId}`,
  /**
   * One delivery job per logical event and endpoint. The SQL mirror in
   * `listStalledWebhookDeliveries` (packages/db) must build the same key.
   */
  webhook: (eventId: string, endpointId: string) => `${eventId}:${endpointId}`,
  /**
   * One question rerun per invoice revision, so repeated clicks share it.
   * The SQL mirror in `listStalledJudgmentReruns` (packages/db) must build
   * the same key.
   */
  judgments: (teamId: string, invoiceId: string, revision: number) =>
    `${teamId}:${invoiceId}:judgments:r${revision}`,
  /**
   * One in-place bill update per correction. The SQL mirror in
   * `listStalledBillUpdates` (packages/db) must build the same key.
   */
  billUpdate: (teamId: string, invoiceId: string, correctionId: string) =>
    `${teamId}:${invoiceId}:bill-update:${correctionId}`,
  /** A cleanup run deferred until the deletion's quiesce time. */
  deletionResume: (deletionId: string, resumeAt: string) =>
    `${deletionId}:after:${resumeAt}`,
  /** One retention sweep per hourly slot. */
  retention: (slot: string) => `retention:${slot}`,
  /** Matching of one invoice revision to authorization sources. */
  match: (teamId: string, invoiceId: string, revision: number) =>
    `${teamId}:${invoiceId}:r${revision}`,
  /** Reconciliation of one match decision at one invoice revision. */
  reconcile: (
    teamId: string,
    invoiceId: string,
    matchId: string,
    revision: number,
  ) => `${teamId}:${invoiceId}:${matchId}:r${revision}`,
};
