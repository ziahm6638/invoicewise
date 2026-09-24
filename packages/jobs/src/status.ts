import { BunRuntime } from "@effect/platform-bun";
import {
  listDeletionRequests,
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
}).pipe(
  Effect.provide(WorkflowDatabaseLive),
  Effect.scoped,
  BunRuntime.runMain,
);
