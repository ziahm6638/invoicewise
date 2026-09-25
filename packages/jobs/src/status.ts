import { BunRuntime } from "@effect/platform-bun";
import {
  listDeletionRequests,
  listRecentDataExports,
  listWorkflowJobs,
} from "@invoicewise/db/queries";
import { Effect } from "effect";
import { WorkflowDatabase, WorkflowDatabaseLive } from "./workflows";

Effect.gen(function* () {
  const { db } = yield* WorkflowDatabase;
  const jobs = yield* Effect.promise(() => listWorkflowJobs(db));
  const now = Date.now();
  console.table(
    jobs.map((job) => ({
      id: job.id,
      workflow: job.name,
      status: job.status,
      attempts: `${job.attempts}/${job.maxAttempts}`,
      runAt: job.runAt,
      heartbeatAt: job.heartbeatAt,
      stuck:
        job.status === "running" &&
        !!job.leaseExpiresAt &&
        new Date(job.leaseExpiresAt).getTime() < now,
      error: job.lastError,
    })),
  );

  // Unfinished deletions stay listed until cleanup completes; a `failed` one
  // needs an operator (see docs/offboarding.md) and `bun jobs:resume-deletions`.
  const deletions = yield* Effect.promise(() => listDeletionRequests(db));
  const unfinished = deletions.filter(
    (request) => request.status !== "completed",
  );
  console.log(
    `deletion requests: ${unfinished.length} unfinished of ${deletions.length} recent`,
  );
  if (unfinished.length > 0) {
    console.table(
      unfinished.map((request) => ({
        id: request.id,
        subject: `${request.subject}:${request.subjectId}`,
        status: request.status,
        attempts: request.attempts,
        connectionsRevoked: !!request.connectionsRevokedAt,
        storagePurged: !!request.storagePurgedAt,
        purgeAfter: request.quiesceUntil,
        error: request.lastError,
      })),
    );
  }

  // Exports in progress or failed, and any finished export that still holds
  // an archive past its expiry (the hourly retention run removes those; see
  // docs/data-lifecycle.md).
  const exports = yield* Effect.promise(() => listRecentDataExports(db));
  const attention = exports.filter(
    (item) =>
      item.status === "queued" ||
      item.status === "running" ||
      item.status === "failed" ||
      (item.hasArchive &&
        (item.status !== "ready" ||
          (!!item.expiresAt && new Date(item.expiresAt).getTime() < now))),
  );
  console.log(
    `data exports: ${attention.length} in progress, failed or awaiting removal of ${exports.length} recent`,
  );
  if (attention.length > 0) {
    console.table(
      attention.map((item) => ({
        id: item.id,
        workspace: item.teamId,
        status: item.status,
        attempts: item.attempts,
        documents: `${item.progress.documentsWritten}/${item.progress.documentsTotal}`,
        expiresAt: item.expiresAt,
        archiveStored: item.hasArchive,
        error: item.error,
      })),
    );
  }
}).pipe(
  Effect.provide(WorkflowDatabaseLive),
  Effect.scoped,
  BunRuntime.runMain,
);
