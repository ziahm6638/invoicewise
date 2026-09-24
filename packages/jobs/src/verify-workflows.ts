import { resolve } from "node:path";
import { createDatabaseClient } from "@invoicewise/db/client";
import {
  createInbox,
  createUserQuestion,
  deleteUserQuestion,
  getInboxByFilePath,
  getInboxIntakeBinding,
  getUserQuestions,
  getWorkflowJob,
  updateInboxWithProcessedData,
  updateUserQuestion,
} from "@invoicewise/db/queries";
import { inbox, teams, users, workflowJobs } from "@invoicewise/db/schema";
import { createStorageClientFromEnv } from "@invoicewise/db/storage";
import type { InvoiceExtraction } from "@invoicewise/documents";
import { eq } from "drizzle-orm";
import { Effect, Logger } from "effect";
import { enqueueWorkflow, workflowKey } from "./client";
import { acceptIntakeUpload } from "./intake";
import { WorkflowRuntimeLive, runWorkflowBatch } from "./runner";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

// What a correct model selects for each field of the synthetic fixture. The
// stub can only choose among the candidates the pipeline found in the PDF, so
// the persisted extraction proves the real reading, layout and candidate
// mining end to end.
const extractionValues: Record<string, string | number> = {
  supplier_name: "ACME SUPPLIES LTD",
  supplier_address: "10 Market Street, London, EC1A 1AA",
  supplier_vat_number: "GB123456789",
  invoice_number: "INV-2026-0042",
  invoice_date: "2026-09-01",
  due_date: "2026-09-30",
  currency: "GBP",
  net_amount: 1000,
  vat_amount: 200,
  gross_amount: 1200,
  bank_account_name: "ACME SUPPLIES LTD",
  bank_account_number: "12345678",
  bank_sort_code: "12-34-56",
  bank_iban: "GB12 ACME 1234 5678 9012 34",
  bank_bic: "ACMEGB2L",
  description: "September consulting services",
  purchase_order_reference: "PO-7788",
};

const extractionAnswers = (questions: Record<string, any>) =>
  Object.fromEntries(
    Object.entries(questions).map(([id, question]) => {
      if (id.startsWith("line_item_")) {
        return [id, { type: "noul", noul: 0.99 }];
      }
      const choice =
        Object.entries(question.criteria).find(
          ([, criterion]: [string, any]) =>
            criterion?.value === extractionValues[id],
        )?.[0] ?? "absent";
      return [
        id,
        { type: "choice", choice, probabilities: {}, confidence: 0.99 },
      ];
    }),
  );

const judgmentAnswers = (questions: Record<string, any>) =>
  Object.fromEntries(
    Object.entries(questions).map(([id, question]) => {
      const instructions = JSON.stringify(question.instructions).toLowerCase();
      if (instructions.includes("cost centre")) {
        return [id, { type: "noul", noul: 0.5 }];
      }
      if (question.type === "choice") {
        return [
          id,
          {
            type: "choice",
            choice: "option_0",
            probabilities: { option_0: 0.9, option_1: 0.1 },
            confidence: 0.8,
          },
        ];
      }
      if (question.type === "score") {
        return [
          id,
          {
            type: "score",
            score: 0.8,
            legend: { "0": "Low", "1": "High" },
            probabilities: { "0": 0.2, "1": 0.8 },
            confidence: 0.6,
          },
        ];
      }
      return [id, { type: "noul", noul: 0.94 }];
    }),
  );

const startTypeSafeStub = () =>
  Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as {
        questions: Record<string, any>;
      };
      const isExtraction = Object.keys(body.questions).some(
        (id) =>
          Object.hasOwn(extractionValues, id) || id.startsWith("line_item_"),
      );
      const answers = isExtraction
        ? extractionAnswers(body.questions)
        : judgmentAnswers(body.questions);
      return Response.json({
        model: "verification-stub",
        answers,
        usage: { input_tokens: 0, output_tokens: 0 },
      });
    },
  });

const priorExtraction: InvoiceExtraction = {
  supplierName: "ACME SUPPLIES LTD",
  supplierAddress: "10 Market Street, London, EC1A 1AA",
  supplierVatNumber: "GB123456789",
  invoiceNumber: "INV-2026-0042",
  invoiceDate: "2026-09-01",
  dueDate: "2026-09-30",
  currency: "GBP",
  netAmount: 1000,
  vatAmount: 200,
  grossAmount: 1200,
  lineItems: [
    {
      description: "Consulting services",
      quantity: 2,
      unitPrice: 500,
      total: 1000,
    },
  ],
  bankDetails: {
    accountName: "ACME SUPPLIES LTD",
    accountNumber: "12345678",
    sortCode: "12-34-56",
    iban: "GB12 ACME 1234 5678 9012 34",
    bic: "ACMEGB2L",
  },
  description: "September consulting services",
  purchaseOrderReference: "PO-7788",
  textSource: "text-layer",
};

/** Every field the synthetic PDF prints, as the pipeline must persist it. */
const expectedExtraction: InvoiceExtraction = { ...priorExtraction };

const runBatch = () =>
  Effect.runPromise(
    runWorkflowBatch.pipe(
      Effect.provide(WorkflowRuntimeLive),
      Effect.provide(Logger.json),
      Effect.scoped,
    ),
  );

async function main() {
  process.env.WORKFLOW_RETRY_BASE_MS = "50";
  process.env.WORKFLOW_RETRY_MAX_MS = "50";

  const database = createDatabaseClient({
    primaryUrl: required("DATABASE_PRIMARY_URL"),
    isDevelopment: true,
  });
  const storage = createStorageClientFromEnv();
  const fixture = Bun.file(
    resolve(
      process.cwd(),
      "../documents/src/test/fixtures/synthetic-invoice.pdf",
    ),
  );
  const bytes = Buffer.from(await fixture.arrayBuffer());
  const suffix = crypto.randomUUID();
  const typeSafeStub = startTypeSafeStub();
  process.env.TYPESAFE_API_KEY = "verification-key";
  process.env.TYPESAFE_BASE_URL = `http://127.0.0.1:${typeSafeStub.port}`;
  let teamId: string | undefined;
  let userId: string | undefined;
  const legacyLeftoverPath = ["verification", suffix, "synthetic-invoice.pdf"];
  try {
    const [team] = await database.db
      .insert(teams)
      .values({ name: "InvoiceWise Ltd" })
      .returning({ id: teams.id });
    if (!team) throw new Error("Unable to create verification team");
    teamId = team.id;

    const [user] = await database.db
      .insert(users)
      .values({
        fullName: "Pipeline verifier",
        email: `pipeline-${teamId}@invoicewise.local`,
        teamId,
      })
      .returning({ id: users.id });
    if (!user) throw new Error("Unable to create verification user");
    userId = user.id;

    const approvalQuestion = await createUserQuestion(database.db, {
      teamId,
      userId,
      question: "Is this invoice over our £1,000 director approval threshold?",
      type: "boolean",
      context: "Director approval is required for invoices over £1,000.",
      enabled: true,
    });
    if (!approvalQuestion)
      throw new Error("Unable to create approval question");
    const revisedApproval = await updateUserQuestion(database.db, {
      teamId,
      userId,
      questionKey: approvalQuestion.questionKey,
      question: approvalQuestion.question,
      type: "boolean",
      context:
        "Director approval is required when the gross total exceeds £1,000.",
      enabled: true,
    });
    if (!revisedApproval)
      throw new Error("Unable to version approval question");

    await createUserQuestion(database.db, {
      teamId,
      userId,
      question: "Which cost centre should this invoice use?",
      type: "choice",
      options: ["Operations", "Capital"],
      context: "Use the line-item description to choose the closest centre.",
      enabled: true,
    });

    const temporaryQuestion = await createUserQuestion(database.db, {
      teamId,
      userId,
      question: "Should this temporary check run?",
      type: "boolean",
      enabled: false,
    });
    if (!temporaryQuestion)
      throw new Error("Unable to create temporary question");
    await deleteUserQuestion(database.db, {
      teamId,
      userId,
      questionKey: temporaryQuestion.questionKey,
    });
    const configuredQuestions = await getUserQuestions(database.db, teamId);
    console.log(
      JSON.stringify(
        {
          crud: {
            createdVersion: approvalQuestion.version,
            updatedVersion: revisedApproval.version,
            deletedQuestionHidden: !configuredQuestions.some(
              (question) =>
                question.questionKey === temporaryQuestion.questionKey,
            ),
          },
        },
        null,
        2,
      ),
    );

    const previous = await createInbox(database.db, {
      displayName: "Historical synthetic invoice",
      teamId,
      filePath: [teamId, "inbox", "historical-synthetic-invoice.pdf"],
      fileName: "historical-synthetic-invoice.pdf",
      contentType: "application/pdf",
      size: bytes.length,
      status: "pending",
    });
    if (!previous) throw new Error("Unable to create historical invoice");
    await updateInboxWithProcessedData(database.db, {
      id: previous.id,
      displayName: priorExtraction.supplierName,
      amount: priorExtraction.grossAmount,
      currency: priorExtraction.currency,
      date: priorExtraction.dueDate,
      type: "invoice",
      extraction: priorExtraction,
      judgments: [],
      status: "pending",
    });

    // Intake owns object identity: reserve, store immutably, validate, then
    // queue. The verifier never invents a storage path.
    const accepted = await acceptIntakeUpload(database.db, storage, {
      teamId,
      bytes,
      declaredMimeType: "application/pdf",
      fileName: "synthetic-invoice.pdf",
    });
    if (accepted.status !== "accepted") {
      throw new Error(`Intake validation failed: ${accepted.message}`);
    }
    const filePath = accepted.filePath;
    const [enqueued] = await database.db
      .select()
      .from(workflowJobs)
      .where(
        eq(
          workflowJobs.idempotencyKey,
          workflowKey.attachment(teamId, accepted.inboxId),
        ),
      )
      .limit(1);
    if (!enqueued) throw new Error("Intake did not queue processing");

    // Lose the stored object and prove the worker retries rather than
    // silently succeeding or inventing a record.
    await storage.remove({ bucket: "vault", path: filePath });

    await runBatch();
    const afterFailure = await getWorkflowJob(database.db, {
      id: enqueued.id,
      teamId,
    });
    if (afterFailure?.status !== "queued" || afterFailure.attempts !== 1) {
      throw new Error("Expected the missing attachment to be queued for retry");
    }

    await storage.upload({ bucket: "vault", path: filePath, file: bytes });
    const waitMs = Math.max(
      0,
      new Date(afterFailure.runAt).getTime() - Date.now() + 10,
    );
    await Bun.sleep(waitMs);
    await runBatch();

    const completed = await getWorkflowJob(database.db, {
      id: enqueued.id,
      teamId,
    });
    const invoice = await getInboxIntakeBinding(database.db, {
      id: accepted.inboxId,
      teamId,
    });
    const [persisted] = invoice
      ? await database.db
          .select()
          .from(inbox)
          .where(eq(inbox.id, invoice.id))
          .limit(1)
      : [];
    // Replaying the accepted bytes is idempotent and never stores a second
    // object or second processing intent.
    const repeatedIntake = await acceptIntakeUpload(database.db, storage, {
      teamId,
      bytes,
      declaredMimeType: "application/pdf",
      fileName: "synthetic-invoice.pdf",
    });
    const repeated = await enqueueWorkflow(database.db, {
      name: "process-attachment",
      teamId,
      idempotencyKey: workflowKey.attachment(teamId, accepted.inboxId),
      payload: { inboxId: accepted.inboxId, teamId },
    });
    const judgments = persisted?.judgments ?? [];
    const defaultJudgments = judgments.filter(
      (judgment) => judgment.source === "default",
    );
    const approvalJudgment = judgments.find(
      (judgment) =>
        judgment.questionId === approvalQuestion.questionKey &&
        judgment.status === "answered",
    );
    const failedJudgment = judgments.find(
      (judgment) => judgment.status === "failed",
    );

    if (!Bun.deepEquals(persisted?.extraction, expectedExtraction)) {
      throw new Error(
        `Persisted extraction does not match the invoice: ${JSON.stringify(
          persisted?.extraction ?? null,
        )}`,
      );
    }

    if (
      completed?.status !== "succeeded" ||
      completed.attempts !== 2 ||
      !persisted?.extraction ||
      persisted.status !== "pending" ||
      defaultJudgments.length !== 4 ||
      !approvalJudgment ||
      !failedJudgment ||
      repeatedIntake.status !== "accepted" ||
      !repeatedIntake.deduplicated ||
      repeatedIntake.inboxId !== accepted.inboxId ||
      !repeated.deduplicated ||
      repeated.id !== enqueued.id
    ) {
      throw new Error("Workflow verification did not reach the expected state");
    }

    console.log(
      JSON.stringify({
        event: "workflow_verification_succeeded",
        workflowId: completed.id,
        attempts: completed.attempts,
        persistedInvoiceId: persisted.id,
        extractedSupplier: expectedExtraction.supplierName,
        extractedLineItems: expectedExtraction.lineItems.length,
        judgmentCount: judgments.length,
        defaultJudgmentCount: defaultJudgments.length,
        configuredJudgmentAnswered: true,
        configuredJudgmentFailed: true,
        replayDeduplicated: repeatedIntake.deduplicated,
        idempotentRepeat: repeated.deduplicated,
      }),
    );
  } finally {
    await storage.remove({ bucket: "vault", path: legacyLeftoverPath });
    if (teamId) {
      const cleanup = await database.db
        .select({ filePath: inbox.filePath })
        .from(inbox)
        .where(eq(inbox.teamId, teamId));
      for (const row of cleanup) {
        if (row.filePath?.length) {
          await storage
            .remove({ bucket: "vault", path: row.filePath })
            .catch(() => undefined);
        }
      }
    }
    if (teamId) await database.db.delete(teams).where(eq(teams.id, teamId));
    if (userId) await database.db.delete(users).where(eq(users.id, userId));
    typeSafeStub.stop(true);
    await database.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
