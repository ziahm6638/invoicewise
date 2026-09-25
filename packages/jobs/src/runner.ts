import {
  type WorkflowJob,
  claimWorkflowJobs,
  completeWorkflowJob,
  failWorkflowJob,
  heartbeatWorkflowJob,
  retryWorkflowJob,
} from "@invoicewise/db/queries";
import { Config, Context, Effect, Either, Layer, Schema } from "effect";
import { reconcileDeliveries } from "./delivery";
import { publishDeliveryFailureById } from "./webhooks";
import {
  WorkflowDatabase,
  type WorkflowExecutionError,
  WorkflowHandler,
  WorkflowHandlerLive,
  WorkflowInfrastructureLive,
} from "./workflows";

export class WorkflowQueueError extends Schema.TaggedError<WorkflowQueueError>()(
  "WorkflowQueueError",
  { reason: Schema.String },
) {}

export class WorkflowRepository extends Context.Tag(
  "invoicewise/WorkflowRepository",
)<
  WorkflowRepository,
  {
    readonly claim: (
      workerId: string,
      limit: number,
      leaseMs: number,
    ) => Effect.Effect<WorkflowJob[], WorkflowQueueError>;
    readonly heartbeat: (
      id: string,
      workerId: string,
      leaseMs: number,
    ) => Effect.Effect<void, WorkflowQueueError>;
    readonly complete: (
      id: string,
      workerId: string,
      result: Record<string, unknown>,
    ) => Effect.Effect<void, WorkflowQueueError>;
    readonly retry: (
      id: string,
      workerId: string,
      error: string,
      delayMs: number,
    ) => Effect.Effect<void, WorkflowQueueError>;
    readonly fail: (
      id: string,
      workerId: string,
      error: string,
    ) => Effect.Effect<void, WorkflowQueueError>;
  }
>() {}

export class WorkflowRunnerSettings extends Context.Tag(
  "invoicewise/WorkflowRunnerSettings",
)<
  WorkflowRunnerSettings,
  {
    readonly workerId: string;
    readonly concurrency: number;
    readonly pollMs: number;
    readonly leaseMs: number;
    readonly retryBaseMs: number;
    readonly retryMaxMs: number;
  }
>() {}

const queueAttempt = <A>(run: () => Promise<A>, fallback: string) =>
  Effect.tryPromise({
    try: run,
    catch: (error) =>
      new WorkflowQueueError({
        reason: error instanceof Error ? error.message : fallback,
      }),
  });

const ownedUpdate = (
  run: () => Promise<{ id: string } | undefined>,
  fallback: string,
) =>
  queueAttempt(async () => {
    if (!(await run())) throw new Error("Workflow lease was lost");
  }, fallback);

export const WorkflowRepositoryLive = Layer.effect(
  WorkflowRepository,
  Effect.gen(function* () {
    const { db } = yield* WorkflowDatabase;
    return {
      claim: (workerId: string, limit: number, leaseMs: number) =>
        queueAttempt(
          () => claimWorkflowJobs(db, { workerId, limit, leaseMs }),
          "Unable to claim workflows",
        ),
      heartbeat: (id: string, workerId: string, leaseMs: number) =>
        ownedUpdate(
          () => heartbeatWorkflowJob(db, { id, workerId, leaseMs }),
          "Unable to heartbeat workflow",
        ),
      complete: (
        id: string,
        workerId: string,
        result: Record<string, unknown>,
      ) =>
        ownedUpdate(
          () => completeWorkflowJob(db, { id, workerId, result }),
          "Unable to complete workflow",
        ),
      retry: (id: string, workerId: string, error: string, delayMs: number) =>
        ownedUpdate(
          () =>
            retryWorkflowJob(db, {
              id,
              workerId,
              error,
              delayMs,
            }),
          "Unable to retry workflow",
        ),
      fail: (id: string, workerId: string, error: string) =>
        ownedUpdate(
          () => failWorkflowJob(db, { id, workerId, error }),
          "Unable to fail workflow",
        ),
    };
  }),
);

/**
 * Periodic safety net for the processing-to-delivery handoff: settles
 * delivery intents whose job vanished or failed without the handler recording
 * an outcome (for example a lease that expired after the final attempt).
 */
export class DeliveryReconciler extends Context.Tag(
  "invoicewise/DeliveryReconciler",
)<
  DeliveryReconciler,
  {
    readonly intervalMs: number;
    readonly run: Effect.Effect<
      { rescheduled: number; failed: number },
      WorkflowQueueError
    >;
  }
>() {}

export const DeliveryReconcilerLive = Layer.effect(
  DeliveryReconciler,
  Effect.gen(function* () {
    const { db } = yield* WorkflowDatabase;
    const intervalMs = yield* Config.integer("WORKFLOW_RECONCILE_MS").pipe(
      Config.withDefault(60_000),
    );
    return {
      intervalMs: Math.max(1000, intervalMs),
      run: queueAttempt(
        () => reconcileDeliveries(db, {}, publishDeliveryFailureById),
        "Unable to reconcile deliveries",
      ),
    };
  }),
);

export const WorkflowRunnerSettingsLive = Layer.effect(
  WorkflowRunnerSettings,
  Config.all({
    concurrency: Config.integer("WORKFLOW_CONCURRENCY").pipe(
      Config.withDefault(4),
    ),
    pollMs: Config.integer("WORKFLOW_POLL_MS").pipe(Config.withDefault(1000)),
    leaseMs: Config.integer("WORKFLOW_LEASE_MS").pipe(
      Config.withDefault(120_000),
    ),
    retryBaseMs: Config.integer("WORKFLOW_RETRY_BASE_MS").pipe(
      Config.withDefault(5000),
    ),
    retryMaxMs: Config.integer("WORKFLOW_RETRY_MAX_MS").pipe(
      Config.withDefault(60_000),
    ),
  }).pipe(
    Effect.map((config) => ({
      concurrency: Math.max(1, config.concurrency),
      pollMs: Math.max(10, config.pollMs),
      leaseMs: Math.max(3000, config.leaseMs),
      retryBaseMs: Math.max(10, config.retryBaseMs),
      retryMaxMs: Math.max(10, config.retryBaseMs, config.retryMaxMs),
      workerId: crypto.randomUUID(),
    })),
  ),
);

export const retryDelayMs = (attempt: number, baseMs: number, maxMs: number) =>
  Math.min(baseMs * 2 ** Math.max(0, attempt - 1), maxMs);

const runClaimedWorkflow = (job: WorkflowJob) =>
  Effect.gen(function* () {
    const repository = yield* WorkflowRepository;
    const handler = yield* WorkflowHandler;
    const settings = yield* WorkflowRunnerSettings;
    const startedAt = Date.now();

    yield* Effect.logInfo("workflow_run_started").pipe(
      Effect.annotateLogs({
        event: "workflow_run_started",
        workflowId: job.id,
        workflow: job.name,
        attempt: job.attempts,
      }),
    );

    yield* Effect.forkScoped(
      Effect.sleep(Math.max(1000, Math.floor(settings.leaseMs / 3))).pipe(
        Effect.zipRight(
          repository.heartbeat(job.id, settings.workerId, settings.leaseMs),
        ),
        Effect.catchAll((error) =>
          Effect.logError("workflow_heartbeat_failed").pipe(
            Effect.annotateLogs({
              event: "workflow_heartbeat_failed",
              workflowId: job.id,
              error: error.reason,
            }),
          ),
        ),
        Effect.forever,
      ),
    );

    const outcome = yield* handler.handle(job).pipe(Effect.either);
    if (Either.isRight(outcome)) {
      yield* repository.complete(job.id, settings.workerId, outcome.right);
      yield* Effect.logInfo("workflow_run_succeeded").pipe(
        Effect.annotateLogs({
          event: "workflow_run_succeeded",
          workflowId: job.id,
          workflow: job.name,
          attempt: job.attempts,
          durationMs: Date.now() - startedAt,
        }),
      );
      return;
    }

    const error: WorkflowExecutionError = outcome.left;
    if (error.retryable && job.attempts < job.maxAttempts) {
      const delayMs = retryDelayMs(
        job.attempts,
        settings.retryBaseMs,
        settings.retryMaxMs,
      );
      yield* repository.retry(job.id, settings.workerId, error.reason, delayMs);
      yield* Effect.logWarning("workflow_run_retrying").pipe(
        Effect.annotateLogs({
          event: "workflow_run_retrying",
          workflowId: job.id,
          workflow: job.name,
          attempt: job.attempts,
          delayMs,
          error: error.reason,
        }),
      );
      return;
    }

    yield* repository.fail(job.id, settings.workerId, error.reason);
    yield* Effect.logError("workflow_run_failed").pipe(
      Effect.annotateLogs({
        event: "workflow_run_failed",
        workflowId: job.id,
        workflow: job.name,
        attempt: job.attempts,
        durationMs: Date.now() - startedAt,
        error: error.reason,
      }),
    );
  }).pipe(Effect.scoped);

export const runWorkflowBatch = Effect.gen(function* () {
  const repository = yield* WorkflowRepository;
  const settings = yield* WorkflowRunnerSettings;
  const jobs = yield* repository.claim(
    settings.workerId,
    settings.concurrency,
    settings.leaseMs,
  );
  yield* Effect.forEach(
    jobs,
    (job) =>
      runClaimedWorkflow(job).pipe(
        Effect.catchAll((error) =>
          Effect.logError("workflow_queue_update_failed").pipe(
            Effect.annotateLogs({
              event: "workflow_queue_update_failed",
              workflowId: job.id,
              workflow: job.name,
              error: error.reason,
            }),
          ),
        ),
      ),
    { concurrency: settings.concurrency, discard: true },
  );
  return jobs.length;
});

const reconcileForever = Effect.gen(function* () {
  const reconciler = yield* DeliveryReconciler;
  yield* Effect.forever(
    reconciler.run.pipe(
      Effect.tap(({ rescheduled, failed }) =>
        rescheduled + failed > 0
          ? Effect.logWarning("delivery_reconciled").pipe(
              Effect.annotateLogs({
                event: "delivery_reconciled",
                rescheduled,
                failed,
              }),
            )
          : Effect.void,
      ),
      Effect.catchAll((error) =>
        Effect.logError("delivery_reconcile_failed").pipe(
          Effect.annotateLogs({
            event: "delivery_reconcile_failed",
            error: error.reason,
          }),
        ),
      ),
      Effect.zipRight(Effect.sleep(reconciler.intervalMs)),
    ),
  );
});

export const runWorkflows = Effect.gen(function* () {
  const settings = yield* WorkflowRunnerSettings;
  // Supervised by this fiber: it stops when the runner stops.
  yield* Effect.fork(reconcileForever);
  yield* Effect.logInfo("workflow_runner_started").pipe(
    Effect.annotateLogs({
      event: "workflow_runner_started",
      workerId: settings.workerId,
      concurrency: settings.concurrency,
      leaseMs: settings.leaseMs,
    }),
  );
  yield* Effect.forever(
    runWorkflowBatch.pipe(
      Effect.flatMap((count) =>
        count === 0 ? Effect.sleep(settings.pollMs) : Effect.void,
      ),
      Effect.catchAll((error) =>
        Effect.logError("workflow_queue_poll_failed").pipe(
          Effect.annotateLogs({
            event: "workflow_queue_poll_failed",
            error: error.reason,
          }),
          Effect.zipRight(Effect.sleep(settings.pollMs)),
        ),
      ),
    ),
  );
});

export const WorkflowRuntimeLive = Layer.mergeAll(
  WorkflowRepositoryLive,
  WorkflowHandlerLive,
  WorkflowRunnerSettingsLive,
  DeliveryReconcilerLive,
).pipe(Layer.provide(WorkflowInfrastructureLive));
