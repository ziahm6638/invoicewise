import { describe, expect, test } from "bun:test";
import type { WorkflowJob } from "@invoicewise/db/queries";
import { Effect, Fiber, Layer, LogLevel, Logger } from "effect";
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
      release: () => Effect.void,
      providerCallsSince: () => Effect.succeed(0),
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
      release: () => Effect.void,
      providerCallsSince: () => Effect.succeed(0),
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

  test("hands an interrupted job back to the queue on shutdown", async () => {
    const released: string[] = [];
    const completed: string[] = [];
    const started = Promise.withResolvers<void>();
    const repository = Layer.succeed(WorkflowRepository, {
      claim: () => Effect.succeed([job]),
      heartbeat: () => Effect.void,
      complete: (id) =>
        Effect.sync(() => completed.push(id)).pipe(Effect.asVoid),
      retry: () => Effect.void,
      fail: () => Effect.void,
      release: (id, workerId) =>
        Effect.sync(() => released.push(`${id}:${workerId}`)).pipe(
          Effect.asVoid,
        ),
      providerCallsSince: () => Effect.succeed(0),
    });
    const handler = Layer.succeed(WorkflowHandler, {
      handle: () =>
        Effect.sync(() => started.resolve()).pipe(
          Effect.zipRight(Effect.never),
        ),
    });

    const fiber = Effect.runFork(
      runWorkflowBatch.pipe(
        Effect.provide(Layer.mergeAll(repository, handler, settings)),
        Effect.provide(Logger.minimumLogLevel(LogLevel.None)),
      ),
    );
    await started.promise;
    await Effect.runPromise(Fiber.interrupt(fiber));

    expect(released).toEqual([`${job.id}:test-worker`]);
    expect(completed).toEqual([]);
  });

  test("leaves document processing queued once the TypeSafe budget is spent", async () => {
    const claims: (readonly string[] | undefined)[] = [];
    const repositoryWith = (calls: number) =>
      Layer.succeed(WorkflowRepository, {
        claim: (_workerId, _limit, _leaseMs, excludeNames) =>
          Effect.sync(() => {
            claims.push(excludeNames);
            return [];
          }),
        heartbeat: () => Effect.void,
        complete: () => Effect.void,
        retry: () => Effect.void,
        fail: () => Effect.void,
        release: () => Effect.void,
        providerCallsSince: (provider) =>
          Effect.succeed(provider === "typesafe" ? calls : 0),
      });
    const handler = Layer.succeed(WorkflowHandler, {
      handle: () => Effect.succeed({}),
    });
    const budgeted = Layer.succeed(WorkflowRunnerSettings, {
      workerId: "test-worker",
      concurrency: 1,
      pollMs: 1,
      leaseMs: 60_000,
      retryBaseMs: 100,
      retryMaxMs: 1000,
      typeSafeDailyCallLimit: 10,
    });
    const run = (calls: number) =>
      Effect.runPromise(
        runWorkflowBatch.pipe(
          Effect.provide(
            Layer.mergeAll(repositoryWith(calls), handler, budgeted),
          ),
          Effect.provide(Logger.minimumLogLevel(LogLevel.None)),
        ),
      );

    await run(9);
    await run(10);
    await run(3);

    expect(claims).toEqual([[], ["process-attachment"], []]);
  });
});
