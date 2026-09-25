/**
 * Question previews and deliberate reruns over invoices already processed.
 *
 * Both ask one stored (or draft) question revision about invoices of one
 * workspace, reading what processing kept: the extraction, the validation,
 * the supplier-scoped history and the document's retained text. A preview
 * stores nothing and sends nothing. A rerun records each new answer as the
 * question's current answer on the invoice, keeps the answer it replaced in
 * `question_answers`, and emits one `invoice.judgments.attached` event per
 * changed invoice; it never touches the processing revision, so it cannot
 * schedule an accounting post or repeat `invoice.processed`. See
 * docs/document-intake.md#questions and docs/delivery.md#question-reruns.
 */
import type { Database } from "@invoicewise/db/client";
import {
  QuestionRunInProgressError,
  countProviderCallsSince,
  createQuestionRun,
  enqueueWorkflowJob,
  finishQuestionRun,
  getDocumentText,
  getInvoicesForQuestions,
  getQuestionRun,
  getUserQuestionRevision,
  listStalledQuestionRuns,
  markQuestionRunRunning,
  recordProviderUsage,
  recordQuestionAnswer,
} from "@invoicewise/db/queries";
import {
  type InvoiceExtraction,
  type InvoiceJudgment,
  type InvoiceJudgmentQuestion,
  type InvoiceValidation,
  QUESTION_LIMITS,
  TypeSafe,
  TypeSafeError,
  TypeSafeLive,
  makeTypeSafe,
  runJudgments,
} from "@invoicewise/documents";
import { Cause, Config, Effect, Exit, Layer, Redacted } from "effect";
import { logicalEventId, scheduleWebhookEvent } from "./delivery";
import { toJudgmentQuestion } from "./process-document";
import { loadJudgmentHistory } from "./suppliers";

export const RERUN_QUESTION_WORKFLOW = "rerun-question";
export const RERUN_QUESTION_MAX_ATTEMPTS = 3;

/** One rerun job per run; the SQL mirror in `listStalledQuestionRuns` builds the same key. */
export const questionRunKey = (runId: string) => `question-run:${runId}`;

/** Provides TypeSafe to a question evaluation. Tests pass a stand-in. */
export type QuestionEvaluator = Layer.Layer<TypeSafe, unknown>;

/** A refusal the person asking can act on; shown to them as is. */
export class QuestionRequestError extends Error {
  override readonly name = "QuestionRequestError";
}

type QuestionInvoice = Awaited<
  ReturnType<typeof getInvoicesForQuestions>
>[number];

const startOfUtcDay = (now: Date) => {
  const day = new Date(now);
  day.setUTCHours(0, 0, 0, 0);
  return day;
};

/**
 * Refuses new TypeSafe work once the daily call ceiling is spent, the same
 * ceiling that holds document processing back (`TYPESAFE_DAILY_CALL_LIMIT`).
 */
export async function assertQuestionBudget(
  db: Database,
  limit = Number(process.env.TYPESAFE_DAILY_CALL_LIMIT ?? 0),
) {
  if (!Number.isFinite(limit) || limit <= 0) return;
  const calls = await countProviderCallsSince(
    db,
    "typesafe",
    startOfUtcDay(new Date()),
  );
  if (calls >= limit) {
    throw new QuestionRequestError(
      "Today's question budget has been used. Previews and reruns are available again after 00:00 UTC.",
    );
  }
}

const reasonOf = (error: unknown) =>
  error instanceof TypeSafeError
    ? error.reason
    : error instanceof Error
      ? error.message
      : "The question could not be evaluated";

/**
 * Asks one question about one stored invoice. The state is built only from
 * this invoice, its workspace supplier's history and its own retained text.
 */
async function askStoredInvoice(
  db: Database,
  input: {
    teamId: string;
    invoice: QuestionInvoice;
    question: InvoiceJudgmentQuestion;
    isDefault: boolean;
    evaluator: QuestionEvaluator;
  },
): Promise<InvoiceJudgment> {
  const extraction = input.invoice.extraction as unknown as InvoiceExtraction;
  const [text, history] = await Promise.all([
    getDocumentText(db, {
      teamId: input.teamId,
      inboxId: input.invoice.id,
    }),
    loadJudgmentHistory(db, {
      teamId: input.teamId,
      documentId: input.invoice.id,
      extraction,
    }),
  ]);
  const exit = await Effect.runPromiseExit(
    runJudgments(
      extraction,
      history.previousInvoices,
      input.isDefault ? [] : [input.question],
      input.isDefault ? [input.question] : [],
      text?.text ?? null,
      input.invoice.validation as unknown as InvoiceValidation | null,
      history.scope,
    ).pipe(Effect.provide(input.evaluator)),
  );
  if (Exit.isFailure(exit)) {
    // Unwrap the typed failure so its retryable flag survives.
    const failure = Cause.failureOption(exit.cause);
    if (failure._tag === "Some" && failure.value instanceof TypeSafeError) {
      throw failure.value;
    }
    throw new TypeSafeError({
      reason:
        failure._tag === "Some"
          ? `TypeSafe is not configured: ${reasonOf(failure.value)}`
          : "The question could not be evaluated",
      retryable: failure._tag === "None",
    });
  }
  const run = exit.value;
  const judgment = run.judgments[0]!;
  if (text?.truncated && judgment.status === "answered") {
    // The retained copy itself was cut; say so rather than look complete.
    return {
      ...judgment,
      certainty: "incomplete_input",
      limits: [
        ...(judgment.limits ?? []),
        "The document's text was longer than InvoiceWise keeps.",
      ],
    };
  }
  return judgment;
}

/** A failed evaluation as an answer: shown, never stored as a rerun result. */
const failedAnswer = (
  question: InvoiceJudgmentQuestion,
  isDefault: boolean,
  error: string,
): InvoiceJudgment => ({
  questionId: question.id,
  questionVersionId: question.versionId,
  questionVersion: question.version,
  label: question.label,
  question: question.question,
  context: question.context,
  source: isDefault ? "default" : "custom",
  status: "failed",
  type: question.type,
  error,
});

/**
 * TypeSafe for previews: the configured client, with each call metered into
 * `provider_usage` as a preview (counts, tokens and timings only).
 */
export const previewEvaluator = (db: Database): QuestionEvaluator =>
  Layer.effect(
    TypeSafe,
    Config.all({
      apiKey: Config.redacted("TYPESAFE_API_KEY"),
      baseUrl: Config.string("TYPESAFE_BASE_URL").pipe(
        Config.withDefault("https://api.typesafe.ai"),
      ),
      model: Config.string("TYPESAFE_MODEL").pipe(
        Config.withDefault("jev-latest"),
      ),
    }).pipe(
      Effect.map((config) =>
        makeTypeSafe({
          apiKey: Redacted.value(config.apiKey),
          baseUrl: config.baseUrl,
          model: config.model,
          onCall: (call) => {
            recordProviderUsage(db, {
              provider: "typesafe",
              operation: "question-preview",
              outcome: call.outcome,
              durationMs: call.durationMs,
              inputTokens: call.inputTokens,
              outputTokens: call.outputTokens,
            }).catch(() => undefined);
          },
        }),
      ),
    ),
  );

export type QuestionPreviewResult = {
  invoiceId: string;
  invoice: {
    displayName: string | null;
    fileName: string | null;
    date: string | null;
    amount: number | null;
    currency: string | null;
  } | null;
  /** The answer the invoice holds now for this question, if any. */
  current: InvoiceJudgment | null;
  /** What the previewed revision answers. */
  preview: InvoiceJudgment | null;
  /** Why nothing was evaluated for this invoice. */
  unavailable?: string;
};

/**
 * Evaluates a question (a saved revision or an unsaved draft) on up to
 * `maxPreviewInvoices` invoices of the workspace and returns the answers
 * next to the current ones. Stores nothing and sends nothing. Bounded in
 * invoices, wall time (`previewTimeoutMs`) and the daily call ceiling.
 */
export async function previewQuestion(
  db: Database,
  input: {
    teamId: string;
    question: InvoiceJudgmentQuestion;
    isDefault: boolean;
    invoiceIds: readonly string[];
    evaluator?: QuestionEvaluator;
    timeoutMs?: number;
  },
): Promise<QuestionPreviewResult[]> {
  const ids = [...new Set(input.invoiceIds)];
  if (ids.length === 0 || ids.length > QUESTION_LIMITS.maxPreviewInvoices) {
    throw new QuestionRequestError(
      `Choose between 1 and ${QUESTION_LIMITS.maxPreviewInvoices} invoices to preview.`,
    );
  }
  await assertQuestionBudget(db);
  const invoices = await getInvoicesForQuestions(db, {
    teamId: input.teamId,
    invoiceIds: ids,
  });
  const evaluator = input.evaluator ?? previewEvaluator(db);
  const deadline = input.timeoutMs ?? QUESTION_LIMITS.previewTimeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), deadline);
  });
  try {
    return await Promise.all(
      ids.map(async (invoiceId): Promise<QuestionPreviewResult> => {
        const invoice = invoices.find(({ id }) => id === invoiceId);
        if (!invoice) {
          return {
            invoiceId,
            invoice: null,
            current: null,
            preview: null,
            unavailable:
              "This invoice is not a processed invoice in this workspace.",
          };
        }
        const current =
          ((invoice.judgments ?? []) as unknown as InvoiceJudgment[]).find(
            (judgment) => judgment.questionId === input.question.id,
          ) ?? null;
        const answer = await Promise.race([
          askStoredInvoice(db, {
            teamId: input.teamId,
            invoice,
            question: input.question,
            isDefault: input.isDefault,
            evaluator,
          }).catch((error: unknown) =>
            failedAnswer(input.question, input.isDefault, reasonOf(error)),
          ),
          timedOut,
        ]);
        return {
          invoiceId,
          invoice: {
            displayName: invoice.displayName,
            fileName: invoice.fileName,
            date: invoice.date,
            amount: invoice.amount,
            currency: invoice.currency,
          },
          current,
          preview:
            answer === "timeout"
              ? failedAnswer(
                  input.question,
                  input.isDefault,
                  `The preview stopped after ${Math.round(deadline / 1000)} seconds before this invoice was answered.`,
                )
              : answer,
        };
      }),
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Records a deliberate rerun of a question's latest revision over the
 * selected invoices and queues its job in the same transaction. Only
 * processed invoices of this workspace are kept; one run per question at a
 * time.
 */
export async function requestQuestionRerun(
  db: Database,
  input: {
    teamId: string;
    userId: string;
    questionKey: string;
    invoiceIds: readonly string[];
  },
) {
  const ids = [...new Set(input.invoiceIds)];
  if (ids.length === 0 || ids.length > QUESTION_LIMITS.maxRerunInvoices) {
    throw new QuestionRequestError(
      `Choose between 1 and ${QUESTION_LIMITS.maxRerunInvoices} invoices to rerun.`,
    );
  }
  const question = await getUserQuestionRevision(db, {
    teamId: input.teamId,
    questionKey: input.questionKey,
  });
  if (!question || question.deletedAt) {
    throw new QuestionRequestError("This question no longer exists.");
  }
  if (!question.enabled) {
    throw new QuestionRequestError("Enable this question before rerunning it.");
  }
  await assertQuestionBudget(db);
  const invoices = await getInvoicesForQuestions(db, {
    teamId: input.teamId,
    invoiceIds: ids,
  });
  if (invoices.length === 0) {
    throw new QuestionRequestError(
      "None of the selected invoices has been processed in this workspace.",
    );
  }
  const invoiceIds = ids.filter((id) =>
    invoices.some((invoice) => invoice.id === id),
  );
  return db.transaction(async (tx) => {
    const executor = tx as unknown as Database;
    const run = await createQuestionRun(executor, {
      teamId: input.teamId,
      questionKey: question.questionKey,
      questionVersionId: question.id,
      questionVersion: question.version,
      invoiceIds,
      requestedBy: input.userId,
    });
    await enqueueWorkflowJob(executor, {
      name: RERUN_QUESTION_WORKFLOW,
      teamId: input.teamId,
      payload: { runId: run.id, teamId: input.teamId },
      idempotencyKey: questionRunKey(run.id),
      maxAttempts: RERUN_QUESTION_MAX_ATTEMPTS,
    });
    return run;
  });
}

/**
 * The `rerun-question` job. Answers the run's question revision on each of
 * its invoices in turn and records each answer in its own transaction with
 * the one event it emits, so a retried job resumes where it stopped: an
 * invoice already answered by this run is not asked again. A temporary
 * TypeSafe failure fails the attempt (retried with backoff); a permanent one
 * is counted as a failed answer and leaves the invoice's current answer as
 * it was. Nothing here changes the processing revision or the accounting
 * post.
 */
export async function runQuestionRerun(
  db: Database,
  input: { runId: string; teamId: string },
  evaluator: QuestionEvaluator = TypeSafeLive,
) {
  const run = await markQuestionRunRunning(db, input);
  if (!run) return { runId: input.runId, finished: true };
  const stored = await getUserQuestionRevision(db, {
    teamId: input.teamId,
    questionKey: run.questionKey,
    versionId: run.questionVersionId,
  });
  if (!stored) {
    await finishQuestionRun(db, {
      ...input,
      status: "failed",
      error: "The question revision no longer exists.",
    });
    return { runId: input.runId, finished: true };
  }
  const question = toJudgmentQuestion(stored);
  const counts = { answered: 0, unknown: 0, failed: 0, skipped: 0 };
  const count = (judgment: Record<string, unknown>) => {
    if (judgment.status === "answered") counts.answered += 1;
    else if (judgment.status === "failed") counts.failed += 1;
    else counts.unknown += 1;
  };

  for (const invoiceId of run.invoiceIds) {
    const [invoice] = await getInvoicesForQuestions(db, {
      teamId: input.teamId,
      invoiceIds: [invoiceId],
    });
    if (!invoice) {
      counts.skipped += 1;
      continue;
    }
    const recorded = (
      (invoice.judgments ?? []) as unknown as InvoiceJudgment[]
    ).find(
      (judgment) =>
        judgment.questionId === question.id && judgment.runId === run.id,
    );
    if (recorded) {
      count(recorded as unknown as Record<string, unknown>);
      continue;
    }
    let judgment: InvoiceJudgment;
    try {
      judgment = await askStoredInvoice(db, {
        teamId: input.teamId,
        invoice,
        question,
        isDefault: stored.isDefault,
        evaluator,
      });
    } catch (error) {
      if (error instanceof TypeSafeError && !error.retryable) {
        counts.failed += 1;
        continue;
      }
      throw error;
    }
    if (judgment.status === "failed") {
      counts.failed += 1;
      continue;
    }
    const answer = { ...judgment, runId: run.id } as unknown as Record<
      string,
      unknown
    >;
    const outcome = await db.transaction(async (tx) => {
      const executor = tx as unknown as Database;
      const result = await recordQuestionAnswer(executor, {
        teamId: input.teamId,
        runId: run.id,
        invoiceId: invoice.id,
        questionKey: question.id,
        questionVersionId: stored.id,
        invoiceRevision: invoice.processingRevision,
        judgment: answer,
      });
      if (result.outcome === "recorded") {
        // One event per invoice per run, with its own id: a new result, not
        // a replay of the processing run's events.
        await scheduleWebhookEvent(executor, {
          id: logicalEventId(
            invoice.id,
            invoice.processingRevision,
            "invoice.judgments.attached",
            questionRunKey(run.id),
          ),
          type: "invoice.judgments.attached",
          createdAt: new Date().toISOString(),
          teamId: input.teamId,
          invoiceId: invoice.id,
          revision: invoice.processingRevision,
          data: {
            id: invoice.id,
            judgments: result.judgments,
            questionRun: {
              id: run.id,
              questionKey: run.questionKey,
              questionVersionId: run.questionVersionId,
              questionVersion: run.questionVersion,
            },
            answer,
            previous: result.previous,
          },
        });
      }
      return result.outcome;
    });
    if (outcome === "skipped") counts.skipped += 1;
    else count(answer);
  }

  await finishQuestionRun(db, { ...input, status: "completed", counts });
  return { runId: run.id, ...counts };
}

/** Recorded on a run whose job failed without recording why. */
export const STALLED_QUESTION_RUN_ERROR =
  "The rerun stopped before it finished. Answers recorded before it stopped are kept; start a new rerun for the rest.";

/**
 * Settles runs whose job disappeared or ended without finishing them, so a
 * run never reads as in progress for ever: a lost job is queued again under
 * its key, a failed one marks the run failed. Run by the runner's
 * reconciler.
 */
export async function reconcileQuestionRuns(db: Database, limit = 100) {
  const stalled = await listStalledQuestionRuns(db, limit);
  let rescheduled = 0;
  let failed = 0;
  for (const run of stalled) {
    if (run.jobStatus === null) {
      await enqueueWorkflowJob(db, {
        name: RERUN_QUESTION_WORKFLOW,
        teamId: run.teamId,
        payload: { runId: run.runId, teamId: run.teamId },
        idempotencyKey: questionRunKey(run.runId),
        maxAttempts: RERUN_QUESTION_MAX_ATTEMPTS,
      });
      rescheduled += 1;
      continue;
    }
    const settled = await finishQuestionRun(db, {
      runId: run.runId,
      teamId: run.teamId,
      status: "failed",
      error: STALLED_QUESTION_RUN_ERROR,
    });
    if (settled) failed += 1;
  }
  return { rescheduled, failed };
}

export { QuestionRunInProgressError, getQuestionRun };
export { QUESTION_LIMITS, QUESTION_NUMBER_UNITS } from "@invoicewise/documents";
export { toJudgmentQuestion } from "./process-document";
