import { createHash } from "node:crypto";
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
  recordInboxProcessingFailure,
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
import { TEMPORARY_PROCESSING_FAILURE } from "./workflows";

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

// The same selections for the UK invoice fixture, which the input-matrix
// phase uploads as a text PDF, a scanned PDF, a PNG scan and a JPEG photo.
const ukInvoiceValues: Record<string, string | number> = {
  supplier_name: "Northwind Joinery Ltd",
  supplier_address: "Unit 4, Riverside Trading Estate, Leeds, LS11 5QP",
  supplier_vat_number: "GB293445512",
  invoice_number: "NJ-10457",
  invoice_date: "1 September 2026",
  due_date: "01-Oct-2026",
  currency: "GBP",
  net_amount: 2161,
  vat_amount: 432.2,
  gross_amount: 2593.2,
  bank_account_name: "Northwind Joinery Ltd",
  bank_account_number: "71234598",
  bank_sort_code: "40-11-62",
  bank_iban: "GB29 NWBK 6016 1331 9268 19",
  bank_bic: "NWBKGB2L",
  purchase_order_reference: "PO-55120",
};

/**
 * Which document the stub is reading. A non-invoice gets no selections, so
 * every field is "absent", as a correct model would answer.
 */
const selectionsFor = (state: unknown): Record<string, string | number> => {
  const invoice = JSON.stringify(state);
  if (invoice.includes("Northwind")) {
    return invoice.includes("change of address") ? {} : ukInvoiceValues;
  }
  return extractionValues;
};

const extractionAnswers = (
  questions: Record<string, any>,
  selections: Record<string, string | number>,
) =>
  Object.fromEntries(
    Object.entries(questions).map(([id, question]) => {
      if (id.startsWith("line_item_")) {
        return [id, { type: "noul", noul: 0.99 }];
      }
      const choice =
        Object.entries(question.criteria).find(
          ([, criterion]: [string, any]) => criterion?.value === selections[id],
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
        state: unknown;
        questions: Record<string, any>;
      };
      const isExtraction = Object.keys(body.questions).some(
        (id) =>
          Object.hasOwn(extractionValues, id) || id.startsWith("line_item_"),
      );
      const answers = isExtraction
        ? extractionAnswers(body.questions, selectionsFor(body.state))
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
  pageSources: ["text-layer"],
};

/** Every field the synthetic PDF prints, as the pipeline must persist it. */
const expectedExtraction: InvoiceExtraction = { ...priorExtraction };

/** The UK invoice fixture, as every input format must persist it. */
const ukInvoiceExtraction: InvoiceExtraction = {
  supplierName: "Northwind Joinery Ltd",
  supplierAddress: "Unit 4, Riverside Trading Estate, Leeds, LS11 5QP",
  supplierVatNumber: "GB293445512",
  invoiceNumber: "NJ-10457",
  invoiceDate: "2026-09-01",
  dueDate: "2026-10-01",
  currency: "GBP",
  netAmount: 2161,
  vatAmount: 432.2,
  grossAmount: 2593.2,
  lineItems: [
    {
      description: "Oak skirting board supply and fit",
      quantity: 12,
      unitPrice: 45,
      total: 540,
    },
    {
      description: "Kitchen worktop installation including sealing and edging",
      quantity: 1,
      unitPrice: 850,
      total: 850,
    },
    {
      description: "Bespoke shelving unit",
      quantity: 2,
      unitPrice: 325.5,
      total: 651,
    },
    {
      description: "Site waste disposal",
      quantity: 3,
      unitPrice: 40,
      total: 120,
    },
  ],
  bankDetails: {
    accountName: "Northwind Joinery Ltd",
    accountNumber: "71234598",
    sortCode: "40-11-62",
    iban: "GB29 NWBK 6016 1331 9268 19",
    bic: "NWBKGB2L",
  },
  description: null,
  purchaseOrderReference: "PO-55120",
  textSource: "text-layer",
  pageSources: ["text-layer"],
};

const runBatch = () =>
  Effect.runPromise(
    runWorkflowBatch.pipe(
      Effect.provide(WorkflowRuntimeLive),
      Effect.provide(Logger.json),
      Effect.scoped,
    ),
  );

/** Runs batches until no job is claimable. */
const drain = async () => {
  for (let batch = 0; batch < 20; batch++) {
    if ((await runBatch()) === 0) return;
  }
  throw new Error("Workflow queue did not drain");
};

/** The type of every value, recursively: the shape downstream code sees. */
const shapeOf = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(shapeOf)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value).map(([key, entry]) => [key, shapeOf(entry)]),
        )
      : value === null
        ? "null"
        : typeof value;

const fixturesDir = () =>
  resolve(process.cwd(), "../documents/src/test/fixtures");

/**
 * The input matrix end to end: the same supplier invoice uploaded as a text
 * PDF, a scanned PDF, a PNG scan and a JPEG phone photo, plus a non-invoice
 * attachment, each through intake, the queue, the worker and Postgres. Every
 * invoice must persist the same extracted data and downstream shape with its
 * own source identity; the non-invoice must persist a failure with a reason.
 */
async function verifyInputMatrix(
  database: ReturnType<typeof createDatabaseClient>,
  storage: ReturnType<typeof createStorageClientFromEnv>,
  teamId: string,
) {
  const inputs = [
    { file: "uk-invoice.pdf", type: "application/pdf", read: ["text-layer"] },
    { file: "uk-invoice-scanned.pdf", type: "application/pdf", read: ["ocr"] },
    { file: "uk-invoice-scan.png", type: "image/png", read: ["ocr"] },
    { file: "uk-invoice-photo.jpg", type: "image/jpeg", read: ["ocr"] },
  ];
  const uploads = [];
  for (const input of [
    ...inputs,
    { file: "non-invoice-letter.pdf", type: "application/pdf", read: [] },
  ]) {
    const bytes = new Uint8Array(
      await Bun.file(resolve(fixturesDir(), input.file)).arrayBuffer(),
    );
    const accepted = await acceptIntakeUpload(database.db, storage, {
      teamId,
      bytes,
      declaredMimeType: input.type,
      fileName: input.file,
    });
    if (accepted.status !== "accepted") {
      throw new Error(`${input.file} was not accepted: ${accepted.message}`);
    }
    uploads.push({
      ...input,
      inboxId: accepted.inboxId,
      hash: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
    });
  }

  await drain();

  const rows = [];
  for (const upload of uploads) {
    const [row] = await database.db
      .select()
      .from(inbox)
      .where(eq(inbox.id, upload.inboxId))
      .limit(1);
    if (!row) throw new Error(`${upload.file} has no inbox record`);
    // Source identity is persisted for every input.
    if (
      row.contentHash !== upload.hash ||
      row.size !== upload.size ||
      row.contentType !== upload.type ||
      row.fileName !== upload.file ||
      row.intakeState !== "accepted"
    ) {
      throw new Error(`${upload.file} lost its source identity`);
    }
    rows.push({ upload, row });
  }

  const letter = rows.pop()!;
  if (
    letter.row.status !== "pending" ||
    letter.row.extraction !== null ||
    letter.row.judgments !== null ||
    !letter.row.processingError?.includes("No invoice details")
  ) {
    throw new Error(
      `The non-invoice attachment did not persist a clear failure: ${JSON.stringify(
        {
          status: letter.row.status,
          processingError: letter.row.processingError,
        },
      )}`,
    );
  }

  const {
    textSource: _source,
    pageSources: _pages,
    ...expectedFields
  } = ukInvoiceExtraction;
  const shapes = rows.map(({ upload, row }) => {
    const { textSource, pageSources, ...fields } = (row.extraction ??
      {}) as InvoiceExtraction;
    if (
      row.processingError !== null ||
      row.status !== "pending" ||
      textSource !== upload.read[0] ||
      !Bun.deepEquals(pageSources, upload.read) ||
      !Bun.deepEquals(fields, expectedFields)
    ) {
      throw new Error(
        `${upload.file} did not persist the invoice: ${JSON.stringify({
          processingError: row.processingError,
          extraction: row.extraction,
        })}`,
      );
    }
    // What downstream consumers read: the record columns, the extraction and
    // one judgment per configured question.
    return shapeOf({
      displayName: row.displayName,
      amount: row.amount,
      currency: row.currency,
      date: row.date,
      taxAmount: row.taxAmount,
      taxRate: row.taxRate,
      taxType: row.taxType,
      type: row.type,
      extraction: row.extraction,
      judgments: (row.judgments ?? []).map(
        (judgment) => `${judgment.source}:${judgment.questionId}`,
      ),
    });
  });
  if (!shapes.every((shape) => Bun.deepEquals(shape, shapes[0]))) {
    throw new Error("The input formats persisted different data shapes");
  }

  // A failure after the extraction is saved (for example while emitting its
  // webhook) must never erase the processed invoice.
  const processed = rows[0]!;
  const lateFailure = await recordInboxProcessingFailure(database.db, {
    id: processed.row.id,
    teamId,
    error: "late failure",
  });
  const [afterLateFailure] = await database.db
    .select()
    .from(inbox)
    .where(eq(inbox.id, processed.row.id))
    .limit(1);
  if (
    lateFailure !== undefined ||
    afterLateFailure?.processingError !== null ||
    !Bun.deepEquals(afterLateFailure.extraction, processed.row.extraction)
  ) {
    throw new Error("A late failure erased a processed invoice");
  }

  // A provider failure is recorded with a generic reason; its internal
  // detail never reaches the customer.
  const internalFailure = await verifyInternalFailureHidden(
    database,
    storage,
    teamId,
  );

  return {
    formats: rows.map(({ upload }) => upload.file),
    sameShape: true,
    extractedGross: expectedFields.grossAmount,
    nonInvoiceError: letter.row.processingError,
    lateFailureKeptExtraction: true,
    internalFailure,
  };
}

async function verifyInternalFailureHidden(
  database: ReturnType<typeof createDatabaseClient>,
  storage: ReturnType<typeof createStorageClientFromEnv>,
  teamId: string,
) {
  const rejecting = Bun.serve({
    port: 0,
    fetch: () => new Response("unauthorized", { status: 401 }),
  });
  const baseUrl = process.env.TYPESAFE_BASE_URL;
  process.env.TYPESAFE_BASE_URL = `http://127.0.0.1:${rejecting.port}`;
  try {
    const file = "uk-invoice-multipage.pdf";
    const accepted = await acceptIntakeUpload(database.db, storage, {
      teamId,
      bytes: new Uint8Array(
        await Bun.file(resolve(fixturesDir(), file)).arrayBuffer(),
      ),
      declaredMimeType: "application/pdf",
      fileName: file,
    });
    if (accepted.status !== "accepted") {
      throw new Error(`${file} was not accepted: ${accepted.message}`);
    }
    await drain();
    const [row] = await database.db
      .select()
      .from(inbox)
      .where(eq(inbox.id, accepted.inboxId))
      .limit(1);
    if (
      row?.status !== "pending" ||
      row.extraction !== null ||
      row.processingError !== TEMPORARY_PROCESSING_FAILURE
    ) {
      throw new Error(
        `A provider failure was not recorded generically: ${JSON.stringify({
          status: row?.status,
          processingError: row?.processingError,
        })}`,
      );
    }
    return row.processingError;
  } finally {
    process.env.TYPESAFE_BASE_URL = baseUrl;
    rejecting.stop(true);
  }
}

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

    const inputMatrix = await verifyInputMatrix(database, storage, teamId);

    console.log(
      JSON.stringify({
        event: "workflow_verification_succeeded",
        inputMatrix,
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
