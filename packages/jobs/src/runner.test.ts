import { describe, expect, test } from "bun:test";
import type { WorkflowJob } from "@invoicewise/db/queries";
import {
  Effect,
  Fiber,
  HashMap,
  Layer,
  LogLevel,
  Logger,
  Option,
} from "effect";
import {
  WorkflowRepository,
  WorkflowRunnerSettings,
  retryDelayMs,
  runWorkflowBatch,
  runWorkflowSlots,
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

  test("leaves document processing, question reruns and invoice matching queued once the TypeSafe budget is spent", async () => {
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

    expect(claims).toEqual([
      [],
      ["process-attachment", "rerun-question", "match-invoice"],
      [],
    ]);
  });

  test("claims into a free slot while a slow job still runs", async () => {
    // Production counterfactual (issue #102): a text PDF uploaded two seconds
    // after a ten-page scan waited 24 s for the scan to finish although three
    // of four slots were free.
    const slow = { ...job, id: "00000000-0000-0000-0000-00000000000a" };
    const fast = { ...job, id: "00000000-0000-0000-0000-00000000000b" };
    const due = [[slow], [fast]];
    const completed: string[] = [];
    const released: string[] = [];
    const fastDone = Promise.withResolvers<void>();
    const repository = Layer.succeed(WorkflowRepository, {
      claim: (_workerId, limit) =>
        Effect.sync(() => (due.shift() ?? []).slice(0, limit)),
      heartbeat: () => Effect.void,
      complete: (id) =>
        Effect.sync(() => {
          completed.push(id);
          if (id === fast.id) fastDone.resolve();
        }),
      retry: () => Effect.void,
      fail: () => Effect.void,
      release: (id) => Effect.sync(() => released.push(id)).pipe(Effect.asVoid),
      providerCallsSince: () => Effect.succeed(0),
    });
    const handler = Layer.succeed(WorkflowHandler, {
      handle: (claimed) =>
        claimed.id === slow.id ? Effect.never : Effect.succeed({}),
    });
    const twoSlots = Layer.succeed(WorkflowRunnerSettings, {
      workerId: "test-worker",
      concurrency: 2,
      pollMs: 5,
      leaseMs: 60_000,
      retryBaseMs: 100,
      retryMaxMs: 1000,
    });

    const fiber = Effect.runFork(
      runWorkflowSlots.pipe(
        Effect.provide(Layer.mergeAll(repository, handler, twoSlots)),
        Effect.provide(Logger.minimumLogLevel(LogLevel.None)),
      ),
    );
    const outcome = await Promise.race([
      fastDone.promise.then(() => "fast finished"),
      Bun.sleep(2000).then(() => "fast still queued"),
    ]);
    await Effect.runPromise(Fiber.interrupt(fiber));

    expect(outcome).toBe("fast finished");
    expect(completed).toEqual([fast.id]);
    // Shutdown still hands the unfinished job back to the queue.
    expect(released).toEqual([slow.id]);
  });

  test("slow webhook deliveries never hold more than half the slots", async () => {
    // A flood of hanging webhook endpoints must leave slots for processing.
    const webhooks = Array.from({ length: 8 }, (_, index) => ({
      ...job,
      id: `00000000-0000-0000-0000-0000000001${index.toString().padStart(2, "0")}`,
      name: "deliver-webhook",
    }));
    const processing = { ...job, id: "00000000-0000-0000-0000-0000000002ff" };
    const pending = [...webhooks, processing];
    const webhookLimits: number[] = [];
    const processed = Promise.withResolvers<void>();
    const repository = Layer.succeed(WorkflowRepository, {
      claim: (_workerId, limit, _leaseMs, _excluded, caps) =>
        Effect.sync(() => {
          const webhookLimit =
            caps?.find(({ name }) => name === "deliver-webhook")?.limit ??
            limit;
          webhookLimits.push(webhookLimit);
          const claimed: WorkflowJob[] = [];
          let claimedWebhooks = 0;
          for (const candidate of [...pending]) {
            if (claimed.length >= limit) break;
            if (candidate.name === "deliver-webhook") {
              if (claimedWebhooks >= webhookLimit) continue;
              claimedWebhooks += 1;
            }
            claimed.push(candidate);
            pending.splice(pending.indexOf(candidate), 1);
          }
          return claimed;
        }),
      heartbeat: () => Effect.void,
      complete: (id) =>
        Effect.sync(() => {
          if (id === processing.id) processed.resolve();
        }),
      retry: () => Effect.void,
      fail: () => Effect.void,
      release: () => Effect.void,
      providerCallsSince: () => Effect.succeed(0),
    });
    let runningWebhooks = 0;
    let maxRunningWebhooks = 0;
    const handler = Layer.succeed(WorkflowHandler, {
      handle: (claimed) =>
        claimed.name === "deliver-webhook"
          ? Effect.sync(() => {
              runningWebhooks += 1;
              maxRunningWebhooks = Math.max(
                maxRunningWebhooks,
                runningWebhooks,
              );
            }).pipe(Effect.zipRight(Effect.never))
          : Effect.succeed({}),
    });
    const fourSlots = Layer.succeed(WorkflowRunnerSettings, {
      workerId: "test-worker",
      concurrency: 4,
      pollMs: 5,
      leaseMs: 60_000,
      retryBaseMs: 100,
      retryMaxMs: 1000,
    });

    const fiber = Effect.runFork(
      runWorkflowSlots.pipe(
        Effect.provide(Layer.mergeAll(repository, handler, fourSlots)),
        Effect.provide(Logger.minimumLogLevel(LogLevel.None)),
      ),
    );
    const outcome = await Promise.race([
      processed.promise.then(() => "processed"),
      Bun.sleep(2000).then(() => "starved"),
    ]);
    await Bun.sleep(50);
    await Effect.runPromise(Fiber.interrupt(fiber));

    expect(outcome).toBe("processed");
    expect(maxRunningWebhooks).toBe(2);
    expect(webhookLimits[0]).toBe(2);
    expect(webhookLimits.at(-1)).toBe(0);
  });

  test("logs a dying job and keeps claiming further jobs", async () => {
    const dying = { ...job, id: "00000000-0000-0000-0000-00000000000c" };
    const next = { ...job, id: "00000000-0000-0000-0000-00000000000d" };
    const due = [[dying], [next]];
    const completed: string[] = [];
    const defects: unknown[] = [];
    const nextDone = Promise.withResolvers<void>();
    const repository = Layer.succeed(WorkflowRepository, {
      claim: (_workerId, limit) =>
        Effect.sync(() => (due.shift() ?? []).slice(0, limit)),
      heartbeat: () => Effect.void,
      complete: (id) =>
        Effect.sync(() => {
          completed.push(id);
          if (id === next.id) nextDone.resolve();
        }),
      retry: () => Effect.void,
      fail: () => Effect.void,
      release: () => Effect.void,
      providerCallsSince: () => Effect.succeed(0),
    });
    const handler = Layer.succeed(WorkflowHandler, {
      handle: (claimed) =>
        claimed.id === dying.id
          ? Effect.sync(() => {
              throw new Error("handler bug");
            })
          : Effect.succeed({}),
    });
    const oneSlot = Layer.succeed(WorkflowRunnerSettings, {
      workerId: "test-worker",
      concurrency: 1,
      pollMs: 5,
      leaseMs: 60_000,
      retryBaseMs: 100,
      retryMaxMs: 1000,
    });
    const capture = Logger.replace(
      Logger.defaultLogger,
      Logger.make(({ annotations }) => {
        if (
          HashMap.get(annotations, "event").pipe(Option.getOrUndefined) ===
          "workflow_run_defect"
        ) {
          defects.push(Object.fromEntries(annotations));
        }
      }),
    );

    const fiber = Effect.runFork(
      runWorkflowSlots.pipe(
        Effect.provide(Layer.mergeAll(repository, handler, oneSlot, capture)),
      ),
    );
    const outcome = await Promise.race([
      nextDone.promise.then(() => "next finished"),
      Bun.sleep(2000).then(() => "runner stalled"),
    ]);
    await Effect.runPromise(Fiber.interrupt(fiber));

    expect(outcome).toBe("next finished");
    expect(completed).toEqual([next.id]);
    expect(defects).toEqual([
      expect.objectContaining({
        event: "workflow_run_defect",
        workflowId: dying.id,
        workflow: dying.name,
        error: expect.stringContaining("handler bug"),
      }),
    ]);
  });
});
