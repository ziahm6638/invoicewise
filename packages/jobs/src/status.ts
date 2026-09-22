import { BunRuntime } from "@effect/platform-bun";
import { listWorkflowJobs } from "@midday/db/queries";
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
}).pipe(
  Effect.provide(WorkflowDatabaseLive),
  Effect.scoped,
  BunRuntime.runMain,
);
