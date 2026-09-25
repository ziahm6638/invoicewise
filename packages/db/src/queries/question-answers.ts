import type { Database } from "@db/client";
import {
  documentTexts,
  inbox,
  questionAnswers,
  questionRuns,
  userQuestions,
} from "@db/schema";
import { and, desc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";

/** Any executor a query can run on: the pool or an open transaction. */
type Executor = Pick<Database, "select" | "insert" | "update" | "delete">;

// --- Retained source text -----------------------------------------------------------

/**
 * Keeps the text a processing run read, replacing what an earlier revision
 * read. Runs in the completion transaction.
 */
export async function saveDocumentText(
  db: Executor,
  input: {
    inboxId: string;
    teamId: string;
    revision: number;
    text: string;
    chars: number;
    truncated: boolean;
  },
) {
  await db
    .insert(documentTexts)
    .values(input)
    .onConflictDoUpdate({
      target: documentTexts.inboxId,
      set: {
        revision: input.revision,
        text: input.text,
        chars: input.chars,
        truncated: input.truncated,
        createdAt: sql`now()`,
      },
    });
}

export async function getDocumentText(
  db: Pick<Database, "select">,
  input: { teamId: string; inboxId: string },
) {
  const [row] = await db
    .select({
      text: documentTexts.text,
      chars: documentTexts.chars,
      truncated: documentTexts.truncated,
      revision: documentTexts.revision,
    })
    .from(documentTexts)
    .where(
      and(
        eq(documentTexts.inboxId, input.inboxId),
        eq(documentTexts.teamId, input.teamId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** The document's text goes with the document when an invoice is deleted. */
export async function deleteDocumentText(
  db: Pick<Database, "delete">,
  input: { teamId: string; inboxId: string },
) {
  await db
    .delete(documentTexts)
    .where(
      and(
        eq(documentTexts.inboxId, input.inboxId),
        eq(documentTexts.teamId, input.teamId),
      ),
    );
}

// --- Invoices a question can be asked about ---------------------------------------

const questionInvoiceColumns = {
  id: inbox.id,
  teamId: inbox.teamId,
  status: inbox.status,
  displayName: inbox.displayName,
  fileName: inbox.fileName,
  date: inbox.date,
  amount: inbox.amount,
  currency: inbox.currency,
  createdAt: inbox.createdAt,
  extraction: inbox.extraction,
  validation: inbox.validation,
  judgments: inbox.judgments,
  processingRevision: inbox.processingRevision,
};

/** Processed, live invoices of this workspace; anything else is left out. */
const askable = (teamId: string) =>
  and(
    eq(inbox.teamId, teamId),
    isNotNull(inbox.extraction),
    ne(inbox.status, "deleted"),
    ne(inbox.status, "processing"),
  );

/**
 * The selected invoices a question may be previewed or rerun on, in this
 * workspace only. Ids from another workspace, deleted or unprocessed
 * invoices are simply not returned.
 */
export async function getInvoicesForQuestions(
  db: Pick<Database, "select">,
  input: { teamId: string; invoiceIds: readonly string[] },
) {
  if (input.invoiceIds.length === 0) return [];
  return db
    .select(questionInvoiceColumns)
    .from(inbox)
    .where(
      and(askable(input.teamId), inArray(inbox.id, [...input.invoiceIds])),
    );
}

/** Recent processed invoices to choose from when previewing a question. */
export async function listInvoicesForQuestions(
  db: Pick<Database, "select">,
  input: { teamId: string; limit?: number },
) {
  return db
    .select({
      id: inbox.id,
      displayName: inbox.displayName,
      fileName: inbox.fileName,
      date: inbox.date,
      amount: inbox.amount,
      currency: inbox.currency,
      createdAt: inbox.createdAt,
    })
    .from(inbox)
    .where(askable(input.teamId))
    .orderBy(desc(inbox.createdAt))
    .limit(Math.min(input.limit ?? 25, 50));
}

// --- Reruns ------------------------------------------------------------------------

export type QuestionRun = typeof questionRuns.$inferSelect;

export class QuestionRunInProgressError extends Error {
  constructor() {
    super(
      "This question is already being rerun. Wait for that run to finish first.",
    );
  }
}

/**
 * Records a rerun of one question revision over the given invoices. One run
 * per question at a time; the caller enqueues its job in the same
 * transaction.
 */
export async function createQuestionRun(
  db: Pick<Database, "select" | "insert" | "execute">,
  input: {
    teamId: string;
    questionKey: string;
    questionVersionId: string;
    questionVersion: number;
    invoiceIds: readonly string[];
    requestedBy: string;
  },
) {
  // Serializes concurrent requests for the same question.
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`question-run:${input.teamId}:${input.questionKey}`}))`,
  );
  const [active] = await db
    .select({ id: questionRuns.id })
    .from(questionRuns)
    .where(
      and(
        eq(questionRuns.teamId, input.teamId),
        eq(questionRuns.questionKey, input.questionKey),
        inArray(questionRuns.status, ["queued", "running"]),
      ),
    )
    .limit(1);
  if (active) throw new QuestionRunInProgressError();
  const [run] = await db
    .insert(questionRuns)
    .values({
      teamId: input.teamId,
      questionKey: input.questionKey,
      questionVersionId: input.questionVersionId,
      questionVersion: input.questionVersion,
      invoiceIds: [...input.invoiceIds],
      status: "queued",
      requestedBy: input.requestedBy,
    })
    .returning();
  if (!run) throw new Error("Unable to record the question rerun");
  return run;
}

export async function getQuestionRun(
  db: Pick<Database, "select">,
  input: { teamId: string; runId: string },
) {
  const [run] = await db
    .select()
    .from(questionRuns)
    .where(
      and(
        eq(questionRuns.id, input.runId),
        eq(questionRuns.teamId, input.teamId),
      ),
    )
    .limit(1);
  return run ?? null;
}

export async function listQuestionRuns(
  db: Pick<Database, "select">,
  input: { teamId: string; questionKey: string; limit?: number },
) {
  return db
    .select()
    .from(questionRuns)
    .where(
      and(
        eq(questionRuns.teamId, input.teamId),
        eq(questionRuns.questionKey, input.questionKey),
      ),
    )
    .orderBy(desc(questionRuns.createdAt))
    .limit(Math.min(input.limit ?? 10, 50));
}

export async function markQuestionRunRunning(
  db: Pick<Database, "update">,
  input: { teamId: string; runId: string },
) {
  const [run] = await db
    .update(questionRuns)
    .set({ status: "running" })
    .where(
      and(
        eq(questionRuns.id, input.runId),
        eq(questionRuns.teamId, input.teamId),
        inArray(questionRuns.status, ["queued", "running"]),
      ),
    )
    .returning();
  return run ?? null;
}

export async function finishQuestionRun(
  db: Pick<Database, "update">,
  input: {
    teamId: string;
    runId: string;
    status: "completed" | "failed";
    counts?: {
      answered: number;
      unknown: number;
      failed: number;
      skipped: number;
    };
    error?: string | null;
  },
) {
  const [run] = await db
    .update(questionRuns)
    .set({
      status: input.status,
      ...(input.counts ?? {}),
      error: input.error ?? null,
      completedAt: sql`now()`,
    })
    .where(
      and(
        eq(questionRuns.id, input.runId),
        eq(questionRuns.teamId, input.teamId),
        inArray(questionRuns.status, ["queued", "running"]),
      ),
    )
    .returning();
  return run ?? null;
}

/**
 * Runs still `queued` or `running` while no `rerun-question` job for them
 * is queued or running: their job failed on its last attempt or was lost.
 */
export async function listStalledQuestionRuns(
  db: Pick<Database, "execute">,
  limit = 100,
) {
  const rows = await db.execute(sql`
    select r.id as "runId", r.team_id as "teamId",
           j.status as "jobStatus"
      from question_runs r
      left join workflow_jobs j
        on j.name = 'rerun-question'
       and j.idempotency_key = 'question-run:' || r.id::text
     where r.status in ('queued', 'running')
       and (j.id is null or j.status in ('failed', 'succeeded'))
       and r.created_at < now() - interval '1 minute'
     limit ${limit}
  `);
  return rows as unknown as {
    runId: string;
    teamId: string;
    jobStatus: string | null;
  }[];
}

// --- Answers ----------------------------------------------------------------------

type JudgmentRecord = Record<string, unknown> & { questionId?: unknown };

/**
 * Records one rerun answer on an invoice and makes it the question's
 * current answer there, keeping the answer it replaced. Locks the invoice;
 * an invoice deleted, being reprocessed or reprocessed since the answer was
 * made is left alone. A retried job finds its answer already recorded and
 * changes nothing. Must run in a transaction.
 */
export async function recordQuestionAnswer(
  db: Executor,
  input: {
    teamId: string;
    runId: string;
    invoiceId: string;
    questionKey: string;
    questionVersionId: string;
    invoiceRevision: number;
    judgment: Record<string, unknown>;
  },
) {
  const [invoice] = await db
    .select({
      id: inbox.id,
      status: inbox.status,
      judgments: inbox.judgments,
      processingRevision: inbox.processingRevision,
    })
    .from(inbox)
    .where(and(eq(inbox.id, input.invoiceId), eq(inbox.teamId, input.teamId)))
    .for("update");
  if (
    !invoice ||
    invoice.status === "deleted" ||
    invoice.status === "processing" ||
    invoice.processingRevision !== input.invoiceRevision
  ) {
    return { outcome: "skipped" as const };
  }
  const [already] = await db
    .select({ id: questionAnswers.id })
    .from(questionAnswers)
    .where(
      and(
        eq(questionAnswers.runId, input.runId),
        eq(questionAnswers.invoiceId, input.invoiceId),
      ),
    )
    .limit(1);
  if (already) return { outcome: "already_recorded" as const };

  const current = (invoice.judgments ?? []) as JudgmentRecord[];
  const index = current.findIndex(
    (judgment) => judgment.questionId === input.questionKey,
  );
  const previous = index >= 0 ? current[index]! : null;
  const judgments =
    index >= 0
      ? current.map((judgment, position) =>
          position === index ? input.judgment : judgment,
        )
      : [...current, input.judgment];
  await db.insert(questionAnswers).values({
    teamId: input.teamId,
    invoiceId: input.invoiceId,
    runId: input.runId,
    questionKey: input.questionKey,
    questionVersionId: input.questionVersionId,
    invoiceRevision: input.invoiceRevision,
    judgment: input.judgment,
    previous,
  });
  await db
    .update(inbox)
    .set({ judgments })
    .where(and(eq(inbox.id, input.invoiceId), eq(inbox.teamId, input.teamId)));
  return { outcome: "recorded" as const, judgments, previous };
}

/** Every rerun answer recorded on an invoice, newest first. */
export async function listQuestionAnswers(
  db: Pick<Database, "select">,
  input: { teamId: string; invoiceId: string },
) {
  return db
    .select({
      id: questionAnswers.id,
      runId: questionAnswers.runId,
      questionKey: questionAnswers.questionKey,
      questionVersionId: questionAnswers.questionVersionId,
      questionVersion: userQuestions.version,
      invoiceRevision: questionAnswers.invoiceRevision,
      judgment: questionAnswers.judgment,
      previous: questionAnswers.previous,
      createdAt: questionAnswers.createdAt,
    })
    .from(questionAnswers)
    .leftJoin(
      userQuestions,
      eq(userQuestions.id, questionAnswers.questionVersionId),
    )
    .where(
      and(
        eq(questionAnswers.teamId, input.teamId),
        eq(questionAnswers.invoiceId, input.invoiceId),
      ),
    )
    .orderBy(desc(questionAnswers.createdAt))
    .limit(100);
}
