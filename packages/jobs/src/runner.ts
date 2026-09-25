import {
  type WorkflowJob,
  claimWorkflowJobs,
  completeWorkflowJob,
  countProviderCallsSince,
  failStalledDataExports,
  failWorkflowJob,
  heartbeatWorkflowJob,
  recordProviderUsage,
  releaseWorkflowJob,
  retryWorkflowJob,
} from "@invoicewise/db/queries";
import { redactOperationalText } from "@invoicewise/db/utils/redact";
import { observeTypeSafeCalls } from "@invoicewise/documents";
import {
  Cause,
  Config,
  Context,
  Effect,
  Either,
  FiberSet,
  Layer,
  Queue,
  Schema,
} from "effect";
import { reconcileDeliveries } from "./delivery";
import { reconcileInvoiceOperations } from "./exceptions";
import { reconcileInboundEmails } from "./inbound-email";
import { observeNangoCalls } from "./nango";
import { reconcileQuestionRuns } from "./questions";
import { settleStalledDecisions } from "./reconciliation";
import { publishDeliveryFailureById } from "./webhooks";
import {
  WorkflowDatabase,
  type WorkflowExecutionError,
  WorkflowHandler,
  WorkflowHandlerLive,
  WorkflowInfrastructureLive,
  enqueueNextRetention,
} from "./workflows";

/** The database the runner and its reconciler work against. */
export { WorkflowDatabase } from "./workflows";

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
      excludeNames?: readonly string[],
      caps?: readonly { name: string; limit: number }[],
    ) => Effect.Effect<WorkflowJob[], WorkflowQueueError>;
    /** Returns a job this worker still holds to the queue (shutdown drain). */
    readonly release: (
      id: string,
      workerId: string,
    ) => Effect.Effect<void, WorkflowQueueError>;
    /** Calls recorded for one provider since the start of `since`'s hour. */
    readonly providerCallsSince: (
      provider: string,
      since: Date,
    ) => Effect.Effect<number, WorkflowQueueError>;
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
    /**
     * Makes sure recurring maintenance (the hourly retention run) is queued.
     * Idempotent: every runner calls it at start.
     */
    readonly scheduleMaintenance?: () => Effect.Effect<
      void,
      WorkflowQueueError
    >;
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
    /**
     * TypeSafe calls allowed per UTC day. Once spent, document processing
     * stays queued until the next day (other workflows keep running). Unset
     * or 0 means no ceiling.
     */
    readonly typeSafeDailyCallLimit?: number;
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
      claim: (
        workerId: string,
        limit: number,
        leaseMs: number,
        excludeNames?: readonly string[],
        caps?: readonly { name: string; limit: number }[],
      ) =>
        queueAttempt(
          () =>
            claimWorkflowJobs(db, {
              workerId,
              limit,
              leaseMs,
              excludeNames,
              caps,
            }),
          "Unable to claim workflows",
        ),
      release: (id: string, workerId: string) =>
        queueAttempt(async () => {
          await releaseWorkflowJob(db, { id, workerId });
        }, "Unable to release workflow"),
      providerCallsSince: (provider: string, since: Date) =>
        queueAttempt(
          () => countProviderCallsSince(db, provider, since),
          "Unable to read provider usage",
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
      scheduleMaintenance: () =>
        queueAttempt(
          () => enqueueNextRetention(db).then(() => undefined),
          "Unable to schedule retention",
        ),
    };
  }),
);

/**
 * Periodic safety net for work whose job can end without its handler
 * recording an outcome (for example a lease that expired after the final
 * attempt): it settles delivery intents whose job vanished or failed,
 * inbound messages whose processing job ended the same way, and workspace
 * exports left `queued` or `running` with no live build job.
 */
export class DeliveryReconciler extends Context.Tag(
  "invoicewise/DeliveryReconciler",
)<
  DeliveryReconciler,
  {
    readonly intervalMs: number;
    readonly run: Effect.Effect<
      { rescheduled: number; failed: number; exportsFailed: number },
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
      run: queueAttempt(async () => {
        const deliveries = await reconcileDeliveries(
          db,
          {},
          publishDeliveryFailureById,
        );
        const inbound = await reconcileInboundEmails(db);
        const exports = await failStalledDataExports(db);
        const operations = await reconcileInvoiceOperations(db);
        const questionRuns = await reconcileQuestionRuns(db);
        // Revisions whose decision waited for a reconciliation that will
        // not come (its job was lost or failed for good) are decided now.
        const waiting = await settleStalledDecisions(db);
        return {
          ...deliveries,
          rescheduled:
            deliveries.rescheduled +
            operations.rescheduled +
            questionRuns.rescheduled +
            waiting.decided,
          failed:
            deliveries.failed +
            inbound.failed +
            operations.failed +
            questionRuns.failed,
          exportsFailed: exports.length,
        };
      }, "Unable to reconcile deliveries"),
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
    typeSafeDailyCallLimit: Config.integer("TYPESAFE_DAILY_CALL_LIMIT").pipe(
      Config.withDefault(0),
    ),
  }).pipe(
    Effect.map((config) => ({
      concurrency: Math.max(1, config.concurrency),
      pollMs: Math.max(10, config.pollMs),
      leaseMs: Math.max(3000, config.leaseMs),
      retryBaseMs: Math.max(10, config.retryBaseMs),
      retryMaxMs: Math.max(10, config.retryBaseMs, config.retryMaxMs),
      typeSafeDailyCallLimit: Math.max(0, config.typeSafeDailyCallLimit),
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
              error: redactOperationalText(error.reason),
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
          error: redactOperationalText(error.reason),
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
        error: redactOperationalText(error.reason),
      }),
    );
  }).pipe(
    Effect.scoped,
    // Shutdown (a deploy or restart) interrupts in-flight work: hand the job
    // straight back so the next runner claims it without waiting for the
    // lease to expire and without spending one of its attempts.
    Effect.onInterrupt(() =>
      Effect.gen(function* () {
        const repository = yield* WorkflowRepository;
        const settings = yield* WorkflowRunnerSettings;
        yield* repository.release(job.id, settings.workerId);
        yield* Effect.logWarning("workflow_run_released").pipe(
          Effect.annotateLogs({
            event: "workflow_run_released",
            workflowId: job.id,
            workflow: job.name,
            attempt: job.attempts,
          }),
        );
      }).pipe(
        Effect.catchAll((error) =>
          Effect.logError("workflow_release_failed").pipe(
            Effect.annotateLogs({
              event: "workflow_release_failed",
              workflowId: job.id,
              workflow: job.name,
              error: redactOperationalText(error.reason),
            }),
          ),
        ),
      ),
    ),
  );

/** Workflows that spend TypeSafe calls; held back once the daily budget is spent. */
export const PROVIDER_BUDGETED_WORKFLOWS = [
  "process-attachment",
  "rerun-judgments",
  "rerun-question",
  "match-invoice",
  "reconcile-invoice",
] as const;

let providerBudgetExhausted = false;

const startOfUtcDay = (now: Date) => {
  const day = new Date(now);
  day.setUTCHours(0, 0, 0, 0);
  return day;
};

/**
 * The workflows to leave queued this round. Reading usage fails open: a
 * database error here also fails the claim itself, so nothing is held back
 * on a guess.
 */
const providerBudgetExclusions = Effect.gen(function* () {
  const repository = yield* WorkflowRepository;
  const settings = yield* WorkflowRunnerSettings;
  const limit = settings.typeSafeDailyCallLimit ?? 0;
  if (limit <= 0) return [] as readonly string[];

  const calls = yield* repository
    .providerCallsSince("typesafe", startOfUtcDay(new Date()))
    .pipe(Effect.orElseSucceed(() => 0));
  const exhausted = calls >= limit;
  if (exhausted !== providerBudgetExhausted) {
    providerBudgetExhausted = exhausted;
    yield* (exhausted ? Effect.logWarning : Effect.logInfo)(
      exhausted ? "provider_budget_exhausted" : "provider_budget_available",
    ).pipe(
      Effect.annotateLogs({
        event: exhausted
          ? "provider_budget_exhausted"
          : "provider_budget_available",
        provider: "typesafe",
        calls,
        limit,
      }),
    );
  }
  return exhausted ? PROVIDER_BUDGETED_WORKFLOWS : ([] as readonly string[]);
});

/**
 * Webhook deliveries wait on customer endpoints, so at most half of the
 * runner's slots (at least one) deliver webhooks at once: a slow or hostile
 * endpoint, already bounded by the transport deadline, cannot starve document
 * processing.
 */
export const WEBHOOK_WORKFLOW = "deliver-webhook";
export const webhookSlots = (concurrency: number) =>
  Math.max(1, Math.floor(concurrency / 2));

const claimDueWorkflows = (limit: number, webhookLimit: number) =>
  Effect.gen(function* () {
    const repository = yield* WorkflowRepository;
    const settings = yield* WorkflowRunnerSettings;
    const excludeNames = yield* providerBudgetExclusions;
    return yield* repository.claim(
      settings.workerId,
      limit,
      settings.leaseMs,
      excludeNames,
      [{ name: WEBHOOK_WORKFLOW, limit: webhookLimit }],
    );
  });

const runLoggedWorkflow = (job: WorkflowJob) =>
  runClaimedWorkflow(job).pipe(
    Effect.catchAll((error) =>
      Effect.logError("workflow_queue_update_failed").pipe(
        Effect.annotateLogs({
          event: "workflow_queue_update_failed",
          workflowId: job.id,
          workflow: job.name,
          error: redactOperationalText(error.reason),
        }),
      ),
    ),
    Effect.catchAllCause((cause) =>
      Cause.isInterruptedOnly(cause)
        ? Effect.failCause(cause)
        : Effect.logError("workflow_run_defect").pipe(
            Effect.annotateLogs({
              event: "workflow_run_defect",
              workflowId: job.id,
              workflow: job.name,
              error: redactOperationalText(Cause.pretty(cause), 2000),
            }),
          ),
    ),
  );

/** Claims one batch of due jobs and runs it to completion (tests, verification). */
export const runWorkflowBatch = Effect.gen(function* () {
  const settings = yield* WorkflowRunnerSettings;
  const jobs = yield* claimDueWorkflows(
    settings.concurrency,
    webhookSlots(settings.concurrency),
  );
  yield* Effect.forEach(jobs, runLoggedWorkflow, {
    concurrency: settings.concurrency,
    discard: true,
  });
  return jobs.length;
});

/**
 * Keeps every slot busy: claims only as many jobs as there are free slots and
 * claims again as soon as any job finishes. A runner that waited for its whole
 * batch held a fresh upload queued behind the slowest job in it (a ten-page
 * scan, a slow provider call) while the other slots sat idle; see
 * docs/operations.md#service-and-load-targets.
 */
export const runWorkflowSlots = Effect.scoped(
  Effect.gen(function* () {
    const settings = yield* WorkflowRunnerSettings;
    // Interrupting the runner interrupts every running job, whose own
    // interrupt handler hands it back to the queue.
    const running = yield* FiberSet.make<void, never>();
    const freed = yield* Queue.sliding<void>(1);
    let busy = 0;
    let webhooksBusy = 0;
    const idle = Effect.race(Queue.take(freed), Effect.sleep(settings.pollMs));

    yield* Effect.forever(
      Effect.gen(function* () {
        const free = settings.concurrency - busy;
        if (free <= 0) return yield* idle;
        const jobs = yield* claimDueWorkflows(
          free,
          Math.max(0, webhookSlots(settings.concurrency) - webhooksBusy),
        ).pipe(
          Effect.catchAll((error) =>
            Effect.logError("workflow_queue_poll_failed").pipe(
              Effect.annotateLogs({
                event: "workflow_queue_poll_failed",
                error: redactOperationalText(error.reason),
              }),
              Effect.as([] as WorkflowJob[]),
            ),
          ),
        );
        for (const job of jobs) {
          const webhook = job.name === WEBHOOK_WORKFLOW;
          busy += 1;
          if (webhook) webhooksBusy += 1;
          yield* FiberSet.run(
            running,
            runLoggedWorkflow(job).pipe(
              Effect.ensuring(
                Effect.suspend(() => {
                  busy -= 1;
                  if (webhook) webhooksBusy -= 1;
                  return Queue.offer(freed, undefined);
                }),
              ),
            ),
          );
        }
        // A full claim may have left more work due; otherwise wait for a
        // finished job or the next poll.
        if (jobs.length < free) yield* idle;
      }),
    );
  }),
);

const reconcileForever = Effect.gen(function* () {
  const reconciler = yield* DeliveryReconciler;
  yield* Effect.forever(
    reconciler.run.pipe(
      Effect.tap(({ exportsFailed }) =>
        exportsFailed > 0
          ? Effect.logWarning("data_export_reconciled").pipe(
              Effect.annotateLogs({
                event: "data_export_reconciled",
                failed: exportsFailed,
              }),
            )
          : Effect.void,
      ),
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
            error: redactOperationalText(error.reason),
          }),
        ),
      ),
      Effect.zipRight(Effect.sleep(reconciler.intervalMs)),
    ),
  );
});

export const runWorkflows = Effect.gen(function* () {
  const settings = yield* WorkflowRunnerSettings;
  const repository = yield* WorkflowRepository;
  if (repository.scheduleMaintenance) {
    yield* repository.scheduleMaintenance().pipe(
      Effect.catchAll((error) =>
        Effect.logError("workflow_maintenance_schedule_failed").pipe(
          Effect.annotateLogs({
            event: "workflow_maintenance_schedule_failed",
            error: redactOperationalText(error.reason),
          }),
        ),
      ),
    );
  }
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
  yield* runWorkflowSlots;
});

/**
 * Records every TypeSafe and Nango call this process makes into
 * `provider_usage` (counts, tokens and timings only). A failed write is
 * dropped: metering never blocks or fails the work it measures.
 */
export const ProviderMeteringLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const { db } = yield* WorkflowDatabase;
    const record = (event: Parameters<typeof recordProviderUsage>[1]) => {
      recordProviderUsage(db, event).catch(() => undefined);
    };
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        observeTypeSafeCalls((call) =>
          record({
            provider: "typesafe",
            operation: "systemone",
            outcome: call.outcome,
            durationMs: call.durationMs,
            inputTokens: call.inputTokens,
            outputTokens: call.outputTokens,
          }),
        );
        observeNangoCalls((call) =>
          record({
            provider: "nango",
            operation: call.operation,
            outcome: call.outcome,
            durationMs: call.durationMs,
          }),
        );
      }),
      () =>
        Effect.sync(() => {
          observeTypeSafeCalls(undefined);
          observeNangoCalls(undefined);
        }),
    );
  }),
);

export const WorkflowRuntimeLive = Layer.mergeAll(
  WorkflowRepositoryLive,
  WorkflowHandlerLive,
  WorkflowRunnerSettingsLive,
  DeliveryReconcilerLive,
  ProviderMeteringLive,
).pipe(Layer.provide(WorkflowInfrastructureLive));
