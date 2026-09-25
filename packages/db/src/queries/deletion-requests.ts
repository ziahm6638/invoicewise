import type { Database, PrimaryDatabase } from "@db/client";
import {
  type DeletionConnection,
  accountingConnections,
  deletionRequests,
  inboxAccounts,
  workflowJobs,
} from "@db/schema";
import { and, desc, eq, inArray, isNull, max, sql } from "drizzle-orm";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export type DeletionRequest = typeof deletionRequests.$inferSelect;

/** Workflow that finishes a deletion outside the database. */
export const PURGE_DELETED_DATA_WORKFLOW = "purge-deleted-data";

/**
 * How long cleanup waits before purging a subject's private objects.
 *
 * A request or job that resolved the workspace just before it was deleted can
 * still be writing an object. Its database write fails on the removed row, but
 * the object would outlive the purge, so the purge runs after this window and
 * after every job lease that was live at deletion time.
 */
export const DELETION_QUIESCE_MS = 10 * 60 * 1000;

/** Cleanup is retried with backoff; exhausting this marks the request failed. */
export const PURGE_MAX_ATTEMPTS = 8;

/**
 * The text an owner must type to delete a workspace: its name, or `DELETE`
 * for a workspace that never had one.
 */
export const workspaceDeletionConfirmation = (name: string | null) =>
  name?.trim() || "DELETE";

/** Provider connections that must be revoked once the workspace rows are gone. */
export async function snapshotWorkspaceConnections(
  tx: Transaction,
  teamId: string,
): Promise<DeletionConnection[]> {
  const accounting = await tx
    .select({
      provider: accountingConnections.provider,
      connectionId: accountingConnections.connectionId,
      integrationId: accountingConnections.integrationId,
    })
    .from(accountingConnections)
    .where(
      and(
        eq(accountingConnections.teamId, teamId),
        isNull(accountingConnections.disconnectedAt),
      ),
    );

  const mailboxes = await tx
    .select({
      id: inboxAccounts.id,
      provider: inboxAccounts.provider,
      refreshToken: inboxAccounts.refreshToken,
    })
    .from(inboxAccounts)
    .where(eq(inboxAccounts.teamId, teamId));

  return [
    ...accounting.map(
      (connection): DeletionConnection => ({
        kind: "accounting",
        provider: connection.provider,
        connectionId: connection.connectionId,
        integrationId: connection.integrationId,
      }),
    ),
    ...mailboxes.map(
      (mailbox): DeletionConnection => ({
        kind: "mailbox",
        provider: mailbox.provider,
        accountId: mailbox.id,
        refreshToken: mailbox.refreshToken || null,
      }),
    ),
  ];
}

/**
 * When the subject's objects may be purged: after the quiesce window and after
 * the lease of every job that was running for the workspace.
 */
export async function workspaceQuiesceUntil(
  tx: Transaction,
  teamId: string,
  now: Date,
) {
  const [row] = await tx
    .select({ leaseExpiresAt: max(workflowJobs.leaseExpiresAt) })
    .from(workflowJobs)
    .where(
      and(eq(workflowJobs.teamId, teamId), eq(workflowJobs.status, "running")),
    );

  const floor = now.getTime() + DELETION_QUIESCE_MS;
  const lease = row?.leaseExpiresAt ? Date.parse(row.leaseExpiresAt) : 0;

  return new Date(Math.max(floor, lease));
}

type RecordDeletionRequestParams = {
  subject: DeletionRequest["subject"];
  subjectId: string;
  requestedBy?: string | null;
  connections?: DeletionConnection[];
  quiesceUntil: Date;
};

/**
 * Records a deletion and queues its cleanup in the caller's transaction, so a
 * committed deletion always has a durable cleanup request behind it.
 */
export async function recordDeletionRequest(
  tx: Transaction,
  params: RecordDeletionRequestParams,
) {
  const [request] = await tx
    .insert(deletionRequests)
    .values({
      subject: params.subject,
      subjectId: params.subjectId,
      requestedBy: params.requestedBy ?? null,
      connections: params.connections ?? [],
      quiesceUntil: params.quiesceUntil.toISOString(),
    })
    .returning();

  if (!request) throw new Error("Unable to record deletion request");

  await tx.insert(workflowJobs).values({
    name: PURGE_DELETED_DATA_WORKFLOW,
    // The subject's rows are gone, so the job is not workspace-scoped; it
    // re-reads everything it needs from the deletion request.
    teamId: null,
    payload: { deletionId: request.id },
    idempotencyKey: request.id,
    maxAttempts: PURGE_MAX_ATTEMPTS,
  });

  return request;
}

export async function getDeletionRequest(
  db: Database | PrimaryDatabase,
  id: string,
) {
  const [request] = await db
    .select()
    .from(deletionRequests)
    .where(eq(deletionRequests.id, id))
    .limit(1);

  return request;
}

/** Counts a cleanup run so operators can see how often it has been tried. */
export async function beginDeletionAttempt(
  db: Database | PrimaryDatabase,
  id: string,
) {
  const [request] = await db
    .update(deletionRequests)
    .set({
      attempts: sql`${deletionRequests.attempts} + 1`,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(deletionRequests.id, id))
    .returning();

  return request;
}

type DeletionProgress = Partial<
  Pick<
    typeof deletionRequests.$inferInsert,
    "connections" | "connectionsRevokedAt" | "storagePurgedAt"
  >
>;

export async function recordDeletionProgress(
  db: Database | PrimaryDatabase,
  id: string,
  progress: DeletionProgress,
) {
  const [request] = await db
    .update(deletionRequests)
    .set({ ...progress, updatedAt: new Date().toISOString() })
    .where(eq(deletionRequests.id, id))
    .returning();

  return request;
}

/**
 * Keeps the request and its progress, records why the run failed, and marks it
 * `failed` once retries are exhausted so it stands out to operators.
 */
export async function recordDeletionFailure(
  db: Database | PrimaryDatabase,
  params: { id: string; error: string; final: boolean },
) {
  const [request] = await db
    .update(deletionRequests)
    .set({
      lastError: params.error,
      ...(params.final ? { status: "failed" as const } : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(deletionRequests.id, params.id),
        inArray(deletionRequests.status, ["pending", "failed"]),
      ),
    )
    .returning();

  return request;
}

/**
 * Completes a request. Only ids and timestamps are kept afterwards: the
 * subject's name and any provider references are cleared.
 */
export async function completeDeletionRequest(
  db: Database | PrimaryDatabase,
  id: string,
) {
  const now = new Date().toISOString();
  const [request] = await db
    .update(deletionRequests)
    .set({
      status: "completed",
      completedAt: now,
      connections: [],
      lastError: null,
      updatedAt: now,
    })
    .where(eq(deletionRequests.id, id))
    .returning();

  return request;
}

export function listDeletionRequests(
  db: Database | PrimaryDatabase,
  limit = 50,
) {
  return db
    .select()
    .from(deletionRequests)
    .orderBy(desc(deletionRequests.createdAt))
    .limit(limit);
}

/**
 * Re-queues cleanup for every unfinished request that has no live job: a
 * request whose retries were exhausted, or whose job was lost. Safe to run
 * repeatedly; a request with a queued or running job is left alone.
 */
export async function resumeDeletionRequests(
  db: Database | PrimaryDatabase,
  now = new Date(),
  /** Only these requests (an operator resuming one); every one when omitted. */
  ids?: readonly string[],
) {
  return db.transaction(async (tx) => {
    const unfinished = await tx
      .select({ id: deletionRequests.id })
      .from(deletionRequests)
      .where(
        and(
          inArray(deletionRequests.status, ["pending", "failed"]),
          ids ? inArray(deletionRequests.id, [...ids]) : undefined,
        ),
      )
      .for("update", { skipLocked: true });

    const resumed: string[] = [];

    for (const { id } of unfinished) {
      const [live] = await tx
        .select({ id: workflowJobs.id })
        .from(workflowJobs)
        .where(
          and(
            eq(workflowJobs.name, PURGE_DELETED_DATA_WORKFLOW),
            inArray(workflowJobs.status, ["queued", "running"]),
            sql`${workflowJobs.payload} ->> 'deletionId' = ${id}`,
          ),
        )
        .limit(1);

      if (live) continue;

      await tx
        .update(deletionRequests)
        .set({ status: "pending", updatedAt: now.toISOString() })
        .where(eq(deletionRequests.id, id));

      await tx.insert(workflowJobs).values({
        name: PURGE_DELETED_DATA_WORKFLOW,
        teamId: null,
        payload: { deletionId: id },
        idempotencyKey: `${id}:resume:${now.toISOString()}`,
        maxAttempts: PURGE_MAX_ATTEMPTS,
      });

      resumed.push(id);
    }

    return resumed;
  });
}
