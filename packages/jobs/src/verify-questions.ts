/**
 * Question revisions, previews and reruns, end to end against Postgres.
 *
 * Two invoices are processed while a custom choice question offers two
 * options; the question is then edited to a third option. The stored
 * answers must keep the revision, options and evaluator they were made
 * with. A preview of the new revision must store and send nothing. A
 * deliberate rerun must record the new revision's answers, keep the ones
 * they replaced, emit exactly one `invoice.judgments.attached` event per
 * invoice and endpoint, and leave the processing revision, `invoice.processed`
 * deliveries and the accounting post untouched, even when the rerun job is
 * replayed. A rerun whose question is deleted before it runs is cancelled
 * without asking or sending anything. Another workspace's invoice is never
 * asked about.
 *
 *   DATABASE_PRIMARY_URL=... bun run verify:questions
 */
import { createDatabaseClient } from "@invoicewise/db/client";
import {
  createUserQuestion,
  createWebhookEndpoint,
  deleteInbox,
  deleteUserQuestion,
  getDocumentText,
  listQuestionAnswers,
  recordQuestionAnswer,
  updateUserQuestion,
  upsertAccountingConnection,
} from "@invoicewise/db/queries";
import {
  inbox,
  questionRuns,
  teams,
  users,
  webhookDeliveries,
  workflowJobs,
} from "@invoicewise/db/schema";
import {
  type InvoiceExtraction,
  type InvoiceJudgment,
  QUESTION_EVALUATOR_VERSION,
  TypeSafe,
  type TypeSafeAnswer,
  retainedSourceText,
  runJudgments,
} from "@invoicewise/documents";
import { and, eq, inArray } from "drizzle-orm";
import { Effect, Layer } from "effect";
import {
  loadJudgmentQuestions,
  saveProcessedDocument,
} from "./process-document";
import {
  QuestionRequestError,
  QUESTION_RUN_DELETED,
  QuestionRunInProgressError,
  RERUN_QUESTION_WORKFLOW,
  STALLED_QUESTION_RUN_ERROR,
  previewQuestion,
  questionRunKey,
  reconcileQuestionRuns,
  requestQuestionRerun,
  runQuestionRerun,
} from "./questions";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const assert = (condition: unknown, message: string, detail?: unknown) => {
  if (!condition) {
    throw new Error(
      `${message}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`,
    );
  }
};

/** TypeSafe stand-in: every choice question picks `choice`; counts calls. */
const evaluatorPicking = (choice: string, calls: { count: number }) =>
  Layer.succeed(TypeSafe, {
    evaluate: ({ questions }) => {
      calls.count += 1;
      return Effect.succeed({
        model: "jev-verify",
        answers: Object.fromEntries(
          Object.entries(questions).map(
            ([id, question]): [string, TypeSafeAnswer] => [
              id,
              question.type === "noul"
                ? { type: "noul", noul: 0.95 }
                : question.type === "choice"
                  ? {
                      type: "choice",
                      choice,
                      probabilities: { [choice]: 0.9 },
                      confidence: 0.9,
                    }
                  : {
                      type: "score",
                      score: 0,
                      legend: {},
                      probabilities: { "0": 1 },
                      confidence: 1,
                    },
            ],
          ),
        ),
        usage: { inputTokens: 100, outputTokens: 0 },
      });
    },
  });

const extractionOf = (invoiceNumber: string): InvoiceExtraction =>
  ({
    documentType: "invoice",
    supplierName: "Question Proof Ltd",
    supplierAddress: null,
    supplierVatNumber: "GB999999973",
    supplierCompanyNumber: null,
    invoiceNumber,
    originalInvoiceNumber: null,
    invoiceDate: "2026-09-01",
    dueDate: null,
    currency: "GBP",
    netAmount: 100,
    discountAmount: null,
    vatAmount: 20,
    taxRate: 20,
    grossAmount: 120,
    amountsIncludeTax: null,
    lineItems: [],
    bankDetails: {
      accountName: null,
      accountNumber: null,
      sortCode: null,
      iban: null,
      bic: null,
    },
    description: "Boiler service",
    purchaseOrderReference: null,
    paymentReference: null,
    textSource: "text-layer",
    pageSources: ["text-layer"],
    evidence: { fields: {}, lineItems: [] },
  }) as InvoiceExtraction;

async function main() {
  const database = createDatabaseClient({
    primaryUrl: required("DATABASE_PRIMARY_URL"),
    isDevelopment: true,
  });
  const db = database.db;
  const teamIds: string[] = [];
  const userIds: string[] = [];

  try {
    const createTeam = async (name: string) => {
      const [team] = await db
        .insert(teams)
        .values({ name })
        .returning({ id: teams.id });
      const [user] = await db
        .insert(users)
        .values({
          fullName: "Question verifier",
          email: `questions-${team!.id}@invoicewise.local`,
          teamId: team!.id,
        })
        .returning({ id: users.id });
      teamIds.push(team!.id);
      userIds.push(user!.id);
      return { teamId: team!.id, userId: user!.id };
    };
    const main = await createTeam("Question verification");
    const other = await createTeam("Question verification neighbour");
    const { teamId, userId } = main;

    const endpoint = await createWebhookEndpoint(db, {
      teamId,
      userId,
      url: "http://127.0.0.1:9/questions",
      events: ["invoice.processed", "invoice.judgments.attached"],
    });
    assert(endpoint, "The webhook endpoint is created");
    await upsertAccountingConnection(db, {
      teamId,
      provider: "xero",
      integrationId: "xero-invoicewise",
      connectionId: "xero-questions",
    });

    // --- Revision 1: two options.
    const v1 = await createUserQuestion(db, {
      teamId,
      userId,
      question: "Which kind of spend is this invoice?",
      type: "choice",
      options: ["Capital", "Operational"],
      context: null,
      enabled: true,
    });
    assert(v1 && v1.version === 1, "Revision 1 is stored", v1);

    const receive = async (forTeam: string, invoiceNumber: string) => {
      const [row] = await db
        .insert(inbox)
        .values({
          teamId: forTeam,
          displayName: invoiceNumber,
          fileName: `${invoiceNumber}.pdf`,
          contentType: "application/pdf",
          type: "invoice",
          status: "processing",
          intakeState: "accepted",
        })
        .returning({ id: inbox.id });
      const extraction = extractionOf(invoiceNumber);
      const text = `Question Proof Ltd\nInvoice ${invoiceNumber}\nBoiler service\nTotal £120.00`;
      const questions = await loadJudgmentQuestions(db, forTeam);
      const { judgments } = await Effect.runPromise(
        runJudgments(
          extraction,
          [],
          questions.customQuestions,
          questions.defaultQuestions,
          text,
        ).pipe(Effect.provide(evaluatorPicking("option_1", { count: 0 }))),
      );
      await saveProcessedDocument(db, {
        id: row!.id,
        teamId: forTeam,
        displayName: invoiceNumber,
        type: "invoice",
        extraction,
        judgments: judgments as unknown as Record<string, unknown>[],
        sourceText: retainedSourceText(text),
      });
      return row!.id;
    };
    const first = await receive(teamId, "QP-001");
    const second = await receive(teamId, "QP-002");
    const foreign = await receive(other.teamId, "QP-900");

    const stateOf = async (id: string) => {
      const [row] = await db
        .select({
          judgments: inbox.judgments,
          revision: inbox.processingRevision,
          accountingRevision: inbox.accountingRevision,
          accountingPostStatus: inbox.accountingPostStatus,
        })
        .from(inbox)
        .where(eq(inbox.id, id));
      const answer = (
        (row!.judgments ?? []) as unknown as InvoiceJudgment[]
      ).find((judgment) => judgment.questionId === v1!.questionKey);
      const deliveries = await db
        .select({
          event: webhookDeliveries.event,
          id: webhookDeliveries.eventId,
        })
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.invoiceId, id));
      const accountingJobs = await db
        .select({ id: workflowJobs.id })
        .from(workflowJobs)
        .where(
          and(
            eq(workflowJobs.teamId, teamId),
            eq(workflowJobs.name, "post-accounting-draft"),
          ),
        );
      return {
        ...row!,
        answer,
        deliveries,
        accountingJobs: accountingJobs.length,
      };
    };

    const processed = await stateOf(first);
    assert(
      processed.answer?.status === "answered" &&
        processed.answer.type === "choice" &&
        processed.answer.answer === "Operational" &&
        processed.answer.questionVersion === 1 &&
        processed.answer.questionVersionId === v1!.id &&
        JSON.stringify(processed.answer.options) ===
          JSON.stringify(["Capital", "Operational"]) &&
        processed.answer.evaluator?.model === "jev-verify" &&
        processed.answer.evaluator.version === QUESTION_EVALUATOR_VERSION,
      "A processed answer names its question revision, options and evaluator",
      processed.answer,
    );
    assert(
      (await getDocumentText(db, { teamId, inboxId: first }))?.text.includes(
        "Boiler service",
      ),
      "The document's text is retained as source evidence",
    );
    assert(
      (await getDocumentText(db, { teamId: other.teamId, inboxId: first })) ===
        null,
      "Another workspace cannot read the retained text",
    );
    const accountingBefore = processed.accountingJobs;
    assert(
      accountingBefore === 2,
      "Processing scheduled one post per invoice",
      {
        accountingBefore,
      },
    );

    // --- Revision 2: the options change after invoices were answered.
    const v2 = await updateUserQuestion(db, {
      teamId,
      userId,
      questionKey: v1!.questionKey,
      question: v1!.question,
      type: "choice",
      options: ["Capital", "Operational", "Maintenance"],
      context: "Servicing existing plant is maintenance.",
      enabled: true,
    });
    assert(v2 && v2.version === 2, "Editing creates revision 2", v2);
    const afterEdit = await stateOf(first);
    assert(
      JSON.stringify(afterEdit.answer) === JSON.stringify(processed.answer),
      "Editing a question does not relabel its past answers",
      afterEdit.answer,
    );

    // --- Preview revision 2: shown, never stored or sent.
    const previewCalls = { count: 0 };
    const preview = await previewQuestion(db, {
      teamId,
      question: {
        id: v2!.questionKey,
        versionId: v2!.id,
        version: 2,
        label: v2!.label,
        question: v2!.question,
        context: v2!.context,
        type: "choice",
        options: v2!.options ?? [],
      },
      isDefault: false,
      invoiceIds: [first, foreign],
      evaluator: evaluatorPicking("option_2", previewCalls),
    });
    assert(
      preview[0]?.preview?.status === "answered" &&
        preview[0].preview.type === "choice" &&
        preview[0].preview.answer === "Maintenance" &&
        preview[0].current?.questionVersion === 1,
      "A preview answers the new revision beside the current answer",
      preview[0],
    );
    assert(
      preview[1]?.preview === null && preview[1]?.unavailable,
      "A preview never reads another workspace's invoice",
      preview[1],
    );
    assert(previewCalls.count === 1, "Only the workspace's invoice was asked", {
      previewCalls,
    });
    const afterPreview = await stateOf(first);
    assert(
      JSON.stringify(afterPreview.answer) ===
        JSON.stringify(processed.answer) &&
        afterPreview.deliveries.length === processed.deliveries.length &&
        (await listQuestionAnswers(db, { teamId, invoiceId: first })).length ===
          0,
      "A preview stores and sends nothing",
    );

    // --- A deliberate rerun of revision 2.
    const run = await requestQuestionRerun(db, {
      teamId,
      userId,
      questionKey: v1!.questionKey,
      invoiceIds: [first, second, foreign],
    });
    assert(
      run.questionVersion === 2 &&
        run.invoiceIds.length === 2 &&
        !run.invoiceIds.includes(foreign),
      "A rerun targets the latest revision and only this workspace's invoices",
      run,
    );
    const concurrent = await requestQuestionRerun(db, {
      teamId,
      userId,
      questionKey: v1!.questionKey,
      invoiceIds: [first],
    }).catch((error: unknown) => error);
    assert(
      concurrent instanceof QuestionRunInProgressError,
      "One rerun per question at a time",
      String(concurrent),
    );
    const tooMany = await requestQuestionRerun(db, {
      teamId,
      userId,
      questionKey: v1!.questionKey,
      invoiceIds: Array.from({ length: 26 }, () => crypto.randomUUID()),
    }).catch((error: unknown) => error);
    assert(
      tooMany instanceof QuestionRequestError,
      "A rerun selection is bounded",
      String(tooMany),
    );

    const rerunCalls = { count: 0 };
    const result = await runQuestionRerun(
      db,
      { runId: run.id, teamId },
      evaluatorPicking("option_2", rerunCalls),
    );
    assert(
      "answered" in result && result.answered === 2 && rerunCalls.count === 2,
      "The rerun answers both invoices",
      result,
    );

    for (const id of [first, second]) {
      const state = await stateOf(id);
      assert(
        state.answer?.status === "answered" &&
          state.answer.type === "choice" &&
          state.answer.answer === "Maintenance" &&
          state.answer.questionVersion === 2 &&
          state.answer.runId === run.id,
        "The invoice's current answer is revision 2's",
        state.answer,
      );
      const history = await listQuestionAnswers(db, { teamId, invoiceId: id });
      assert(
        history.length === 1 &&
          (
            history[0]!.previous as {
              questionVersion?: number;
              answer?: string;
            }
          )?.questionVersion === 1 &&
          (history[0]!.previous as { answer?: string }).answer ===
            "Operational" &&
          history[0]!.questionVersion === 2,
        "The replaced revision-1 answer is kept",
        history,
      );
      const events = state.deliveries.map(({ event }) => event).sort();
      assert(
        JSON.stringify(events) ===
          JSON.stringify([
            "invoice.judgments.attached",
            "invoice.judgments.attached",
            "invoice.processed",
          ]),
        "The rerun adds one judgments event and never repeats invoice.processed",
        events,
      );
      assert(
        state.revision === processed.revision &&
          state.accountingRevision === processed.accountingRevision,
        "The processing and accounting revisions are unchanged",
        state,
      );
      assert(
        state.accountingJobs === accountingBefore,
        "The rerun schedules no accounting post",
        { before: accountingBefore, after: state.accountingJobs },
      );
    }

    // --- Replays: a finished run and an interrupted-then-resumed run.
    const replay = await runQuestionRerun(
      db,
      { runId: run.id, teamId },
      evaluatorPicking("option_0", rerunCalls),
    );
    assert("finished" in replay, "A finished run is not run again", replay);
    await db
      .update(questionRuns)
      .set({ status: "running", completedAt: null })
      .where(eq(questionRuns.id, run.id));
    const resumed = await runQuestionRerun(
      db,
      { runId: run.id, teamId },
      evaluatorPicking("option_0", rerunCalls),
    );
    assert(
      "answered" in resumed && resumed.answered === 2 && rerunCalls.count === 2,
      "A resumed run neither asks again nor changes recorded answers",
      { resumed, rerunCalls },
    );
    const afterReplay = await stateOf(first);
    assert(
      afterReplay.deliveries.length === 3 &&
        afterReplay.answer?.status === "answered" &&
        afterReplay.answer.type === "choice" &&
        afterReplay.answer.answer === "Maintenance",
      "Replays emit no duplicate event",
      afterReplay.deliveries,
    );

    // --- Reconciliation: a lost job is queued again under its key, and a
    // job that failed on its last attempt settles the run as failed.
    const jobFor = async () => {
      const [job] = await db
        .select({ id: workflowJobs.id, status: workflowJobs.status })
        .from(workflowJobs)
        .where(
          and(
            eq(workflowJobs.name, RERUN_QUESTION_WORKFLOW),
            eq(workflowJobs.idempotencyKey, questionRunKey(run.id)),
          ),
        );
      return job;
    };
    const runRow = async () => {
      const [row] = await db
        .select()
        .from(questionRuns)
        .where(eq(questionRuns.id, run.id));
      return row!;
    };
    await db
      .update(questionRuns)
      .set({ status: "running", completedAt: null })
      .where(eq(questionRuns.id, run.id));
    await db
      .delete(workflowJobs)
      .where(eq(workflowJobs.id, (await jobFor())!.id));
    await reconcileQuestionRuns(db, 100, 0);
    const requeued = await jobFor();
    assert(
      requeued?.status === "queued" && (await runRow()).status === "running",
      "A run whose job was lost is queued again",
      requeued,
    );
    await db
      .update(workflowJobs)
      .set({ status: "failed" })
      .where(eq(workflowJobs.id, requeued!.id));
    await reconcileQuestionRuns(db, 100, 0);
    const settled = await runRow();
    assert(
      settled.status === "failed" &&
        settled.error === STALLED_QUESTION_RUN_ERROR &&
        (await stateOf(first)).answer?.runId === run.id,
      "A run whose job failed is settled failed, keeping recorded answers",
      settled,
    );

    // --- An answer made for a revision since reprocessed is not recorded.
    const stale = await db.transaction((tx) =>
      recordQuestionAnswer(tx as unknown as typeof db, {
        teamId,
        runId: run.id,
        invoiceId: second,
        questionKey: v1!.questionKey,
        questionVersionId: v2!.id,
        invoiceRevision: processed.revision - 1,
        judgment: { questionId: v1!.questionKey, status: "answered" },
      }),
    );
    assert(stale.outcome === "skipped", "A stale answer is skipped", stale);

    // --- A question deleted after its rerun was requested cancels the run.
    const beforeDelete = await stateOf(first);
    const answersBeforeDelete = (
      await listQuestionAnswers(db, { teamId, invoiceId: first })
    ).length;
    const orphaned = await requestQuestionRerun(db, {
      teamId,
      userId,
      questionKey: v1!.questionKey,
      invoiceIds: [first],
    });
    await deleteUserQuestion(db, {
      teamId,
      userId,
      questionKey: v1!.questionKey,
    });
    const deletedCalls = { count: 0 };
    const cancelled = await runQuestionRerun(
      db,
      { runId: orphaned.id, teamId },
      evaluatorPicking("option_0", deletedCalls),
    );
    const [cancelledRow] = await db
      .select()
      .from(questionRuns)
      .where(eq(questionRuns.id, orphaned.id));
    const afterDelete = await stateOf(first);
    assert(
      "cancelled" in cancelled &&
        cancelledRow?.status === "cancelled" &&
        cancelledRow.error === QUESTION_RUN_DELETED &&
        deletedCalls.count === 0,
      "A rerun of a question deleted since the request is cancelled unasked",
      { cancelled, cancelledRow, deletedCalls },
    );
    assert(
      JSON.stringify(afterDelete.answer) ===
        JSON.stringify(beforeDelete.answer) &&
        afterDelete.deliveries.length === beforeDelete.deliveries.length &&
        (await listQuestionAnswers(db, { teamId, invoiceId: first })).length ===
          answersBeforeDelete,
      "A cancelled rerun records no answer and sends no event",
      afterDelete,
    );

    // --- Deleting the invoice removes its retained text at once.
    await deleteInbox(db, { id: second, teamId });
    assert(
      (await getDocumentText(db, { teamId, inboxId: second })) === null,
      "A deleted invoice's text is removed at once",
    );

    console.log(
      JSON.stringify({
        ok: true,
        lostRunRequeued: true,
        failedRunSettled: true,
        deletedQuestionRunCancelled: true,
        answersPreserved: true,
        previewStoredNothing: true,
        duplicateDeliveries: 0,
        accountingPostsAdded: 0,
        crossWorkspaceReads: 0,
      }),
    );
  } finally {
    if (teamIds.length > 0) {
      await db
        .delete(workflowJobs)
        .where(inArray(workflowJobs.teamId, teamIds));
      await db.delete(inbox).where(inArray(inbox.teamId, teamIds));
    }
    if (userIds.length > 0) {
      await db.delete(users).where(inArray(users.id, userIds));
    }
    if (teamIds.length > 0) {
      await db.delete(teams).where(inArray(teams.id, teamIds));
    }
    await database.close();
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
