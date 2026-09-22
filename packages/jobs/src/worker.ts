import { BunRuntime } from "@effect/platform-bun";
import { Effect, Logger } from "effect";
import { WorkflowRuntimeLive, runWorkflows } from "./runner";

runWorkflows.pipe(
  Effect.provide(WorkflowRuntimeLive),
  Effect.provide(Logger.json),
  Effect.scoped,
  BunRuntime.runMain({ disablePrettyLogger: true }),
);
