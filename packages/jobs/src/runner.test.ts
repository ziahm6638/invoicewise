import { describe, expect, test } from "bun:test";
import type { WorkflowJob } from "@invoicewise/db/queries";
import { Effect, Layer, LogLevel, Logger } from "effect";
import {
  WorkflowRepository,
  WorkflowRunnerSettings,
  retryDelayMs,
  runWorkflowBatch,
} from "./runner";
import { WorkflowExecutionError, WorkflowHandler } from "./workflows";

const job: WorkflowJob = {
  id: "00000000-0000-0000-0000-000000000001",
  name: "process-attachment",
  teamId: "00000000-0000-0000-0000-000000000002",
  payload: {},
  status: "running",
  attempts: 1,
  maxAttempts: 3,
  runAt: new Date(0).toISOString(),
  lockedBy: "test-worker",
  lockedAt: new Date(0).toISOString(),
  heartbeatAt: new Date(0).toISOString(),
  leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  finishedAt: null,
  result: null,
  lastError: null,
  idempotencyKey: "test",
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};

const settings = Layer.succeed(WorkflowRunnerSettings, {
  workerId: "test-worker",
  concurrency: 1,
  pollMs: 1,
  leaseMs: 60_000,
  retryBaseMs: 100,
  retryMaxMs: 1000,
});

describe("Effect workflow runner", () => {
  test("completes a successful workflow", async () => {
    const completed: Record<string, unknown>[] = [];
    const repository = Layer.succeed(WorkflowRepository, {
      claim: () => Effect.succeed([job]),
      heartbeat: () => Effect.void,
      complete: (_id, _workerId, result) =>
        Effect.sync(() => completed.push(result)).pipe(Effect.asVoid),
      retry: () => Effect.void,
      fail: () => Effect.void,
    });
    const handler = Layer.succeed(WorkflowHandler, {
      handle: () => Effect.succeed({ invoiceId: "invoice-1" }),
    });

    const count = await Effect.runPromise(
      runWorkflowBatch.pipe(
        Effect.provide(Layer.mergeAll(repository, handler, settings)),
        Effect.provide(Logger.minimumLogLevel(LogLevel.None)),
      ),
    );

    expect(count).toBe(1);
    expect(completed).toEqual([{ invoiceId: "invoice-1" }]);
  });

  test("requeues a retryable failure with exponential backoff", async () => {
    const retries: Array<{ error: string; delayMs: number }> = [];
    const repository = Layer.succeed(WorkflowRepository, {
      claim: () => Effect.succeed([job]),
      heartbeat: () => Effect.void,
      complete: () => Effect.void,
      retry: (_id, _workerId, error, delayMs) =>
        Effect.sync(() => retries.push({ error, delayMs })).pipe(Effect.asVoid),
      fail: () => Effect.void,
    });
    const handler = Layer.succeed(WorkflowHandler, {
      handle: () =>
        Effect.fail(
          new WorkflowExecutionError({ reason: "temporary", retryable: true }),
        ),
    });

    await Effect.runPromise(
      runWorkflowBatch.pipe(
        Effect.provide(Layer.mergeAll(repository, handler, settings)),
        Effect.provide(Logger.minimumLogLevel(LogLevel.None)),
      ),
    );

    expect(retries).toEqual([{ error: "temporary", delayMs: 100 }]);
    expect(retryDelayMs(4, 100, 500)).toBe(500);
  });
});
