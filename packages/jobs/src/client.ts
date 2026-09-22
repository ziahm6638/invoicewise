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
  attachment: (
    teamId: string,
    filePath: readonly string[],
    referenceId?: string,
  ) => `${teamId}:${referenceId ?? filePath.join("/")}`,
  inboxSetup: (accountId: string) => accountId,
  inboxSync: (accountId: string, occurrence: string) =>
    `${accountId}:${occurrence}`,
  invitations: (teamId: string, identifiers: readonly string[]) =>
    `${teamId}:${[...identifiers].sort().join(",")}`,
  onboarding: (userId: string, stage = "welcome") => `${userId}:${stage}`,
  accounting: (teamId: string, invoiceId: string) => `${teamId}:${invoiceId}`,
  webhook: (eventId: string, endpointId: string) => `${eventId}:${endpointId}`,
};
