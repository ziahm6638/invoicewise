import { BunRuntime } from "@effect/platform-bun";
import { resumeDeletionRequests } from "@invoicewise/db/queries";
import { Effect } from "effect";
import { WorkflowDatabase, WorkflowDatabaseLive } from "./workflows";

// Re-queues cleanup for every unfinished deletion request without a live job,
// typically after the cause of a `failed` request has been fixed.
Effect.gen(function* () {
  const { db } = yield* WorkflowDatabase;
  const resumed = yield* Effect.promise(() => resumeDeletionRequests(db));
  console.log(
    resumed.length === 0
      ? "no deletion requests needed resuming"
      : `resumed ${resumed.length} deletion request(s): ${resumed.join(", ")}`,
  );
}).pipe(
  Effect.provide(WorkflowDatabaseLive),
  Effect.scoped,
  BunRuntime.runMain,
);
