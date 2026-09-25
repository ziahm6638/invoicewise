import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { createDatabaseClient } from "@invoicewise/db/client";
import {
  createDataExport,
  createInbox,
  createUserQuestion,
  deleteUserQuestion,
  getDataExport,
  getInboxByFilePath,
  getInboxIntakeBinding,
  getInvoicesByDocumentNumber,
  getUserQuestions,
  getWorkflowJob,
  recordInboxProcessingFailure,
  updateInboxWithProcessedData,
  updateUserQuestion,
} from "@invoicewise/db/queries";
import {
  dataExports,
  inbox,
  teams,
  users,
  workflowJobs,
} from "@invoicewise/db/schema";
import { createStorageClientFromEnv } from "@invoicewise/db/storage";
import {
  type InvoiceExtraction,
  validateInvoice,
} from "@invoicewise/documents";
import { and, eq, isNull, ne, or } from "drizzle-orm";
import { Effect, Logger } from "effect";
import { enqueueWorkflow, workflowKey } from "./client";
import { acceptIntakeUpload } from "./intake";
import { WorkflowRuntimeLive, runWorkflowBatch } from "./runner";
import { loadJudgmentHistory } from "./suppliers";
import { required, startTypeSafeStub } from "./verify-support";
import { TEMPORARY_PROCESSING_FAILURE } from "./workflows";
import { readStoredZip } from "./zip";

const priorExtraction: InvoiceExtraction = {
  documentType: "invoice",
  supplierCompanyNumber: null,
  originalInvoiceNumber: null,
  discountAmount: null,
  taxRate: null,
  amountsIncludeTax: null,
  paymentReference: null,
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
      discountAmount: null,
      discountRate: null,
      taxRate: null,
      taxAmount: null,
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
  evidence: { fields: {}, lineItems: [] },
};

/** Every field the synthetic PDF prints, as the pipeline must persist it. */
const expectedExtraction: InvoiceExtraction = { ...priorExtraction };

/**
 * An extraction's values without its evidence, which records the printed
 * rows (and so differs between a text layer and OCR); the evidence itself
 * is checked for presence per value.
 */
const valuesOf = (extraction: unknown) => {
  const { evidence, ...values } = (extraction ?? {}) as InvoiceExtraction;
  return { values, evidence };
};

/** The UK invoice fixture, as every input format must persist it. */
const ukInvoiceExtraction: InvoiceExtraction = {
  documentType: "invoice",
  supplierCompanyNumber: null,
  originalInvoiceNumber: null,
  discountAmount: null,
  taxRate: null,
  amountsIncludeTax: null,
  paymentReference: null,
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
      discountAmount: null,
      discountRate: null,
      taxRate: 20,
      taxAmount: null,
      total: 540,
    },
    {
      description: "Kitchen worktop installation including sealing and edging",
      quantity: 1,
      unitPrice: 850,
      discountAmount: null,
      discountRate: null,
      taxRate: 20,
      taxAmount: null,
      total: 850,
    },
    {
      description: "Bespoke shelving unit",
      quantity: 2,
      unitPrice: 325.5,
      discountAmount: null,
      discountRate: null,
      taxRate: 20,
      taxAmount: null,
      total: 651,
    },
    {
      description: "Site waste disposal",
      quantity: 3,
      unitPrice: 40,
      discountAmount: null,
      discountRate: null,
      taxRate: 20,
      taxAmount: null,
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
  evidence: { fields: {}, lineItems: [] },
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
    evidence: _evidence,
    ...expectedFields
  } = ukInvoiceExtraction;
  const shapes = rows.map(({ upload, row }) => {
    const {
      textSource,
      pageSources,
      evidence: _read,
      ...fields
    } = (row.extraction ?? {}) as InvoiceExtraction;
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
      // Issues differ by design: the same invoice sent again in another
      // format is a duplicate of the first (asserted below).
      validation: {
        ...row.validation,
        issues: [],
        accounting: null,
        identity: null,
      },
      judgments: (row.judgments ?? []).map(
        (judgment) => `${judgment.source}:${judgment.questionId}`,
      ),
    });
  });
  if (!shapes.every((shape) => Bun.deepEquals(shape, shapes[0]))) {
    throw new Error("The input formats persisted different data shapes");
  }
  // One invoice is one identity whatever its format: the first copy received
  // is the original, and every other copy is its duplicate, whatever order
  // the concurrently processed copies finished in.
  const duplicates = rows.map(
    ({ row }) =>
      (row.validation as { identity?: { duplicateOf?: string | null } } | null)
        ?.identity?.duplicateOf ?? null,
  );
  const originals = rows.filter((_, index) => duplicates[index] === null);
  if (
    originals.length !== 1 ||
    duplicates
      .filter((id) => id !== null)
      .some((id) => id !== originals[0]!.row.id)
  ) {
    throw new Error(
      `The copies of this invoice do not share one original: ${JSON.stringify(duplicates)}`,
    );
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

async function verifyDuplicateCandidates(
  database: ReturnType<typeof createDatabaseClient>,
  teamId: string,
) {
  const extraction: InvoiceExtraction = {
    ...priorExtraction,
    invoiceNumber: "CAND-100",
  };
  const insert = async (
    label: string,
    createdAt: string,
    state: Partial<typeof inbox.$inferInsert> = {},
  ) => {
    const [row] = await database.db
      .insert(inbox)
      .values({
        teamId,
        createdAt,
        displayName: label,
        fileName: `${label}.pdf`,
        contentType: "application/pdf",
        type: "invoice",
        status: "pending",
        intakeState: "accepted",
        extraction,
        ...state,
      })
      .returning({ id: inbox.id });
    if (!row) throw new Error(`Unable to create the ${label} copy`);
    return row.id;
  };
  // Every copy of one invoice: only an earlier, live copy may make the
  // current one a duplicate. A deleted, reserved or later copy never does.
  const deleted = await insert("deleted", "2020-01-01T00:00:00Z", {
    status: "deleted",
    intakeState: "cancelled",
  });
  const earlier = await insert("earlier", "2020-01-02T00:00:00Z");
  const reserved = await insert("reserved", "2020-01-03T00:00:00Z", {
    intakeState: "reserved",
  });
  const current = await insert("current", "2020-01-04T00:00:00Z");
  const later = await insert("later", "2020-01-05T00:00:00Z");

  const candidatesOf = async (documentId: string) => {
    const [sameNumber, history] = await Promise.all([
      getInvoicesByDocumentNumber(database.db, {
        teamId,
        documentId,
        numbers: ["CAND-100"],
      }),
      loadJudgmentHistory(database.db, {
        teamId,
        documentId,
        extraction,
      }).then((loaded) => loaded.previousInvoices),
    ]);
    const copies = new Set([deleted, earlier, reserved, current, later]);
    const ids = (rows: readonly { id: string }[]) =>
      rows.map((row) => row.id).filter((id) => copies.has(id));
    return {
      sameNumber: ids(sameNumber),
      history: ids(history),
      duplicateOf: validateInvoice(extraction, [...sameNumber, ...history])
        .identity.duplicateOf,
    };
  };
  const forCurrent = await candidatesOf(current);
  // Reprocessing the first live copy (a retried job) finds no earlier copy.
  const forEarlier = await candidatesOf(earlier);
  const expected = {
    forCurrent: {
      sameNumber: [earlier],
      history: [earlier],
      duplicateOf: earlier,
    },
    forEarlier: { sameNumber: [], history: [], duplicateOf: null },
  };
  if (!Bun.deepEquals({ forCurrent, forEarlier }, expected)) {
    throw new Error(
      `Duplicate candidates include a deleted, reserved or later copy: ${JSON.stringify(
        {
          forCurrent,
          forEarlier,
          copies: { deleted, earlier, reserved, current, later },
        },
      )}`,
    );
  }
  return { duplicateOfEarlierOnly: true };
}

/**
 * The workspace export and the retention run go through the real runner: the
 * export of the processed workspace carries every original byte for byte with
 * its extraction and judgments, and a retention run succeeds and queues the
 * next hourly slot.
 */
async function verifyExportAndRetention(
  database: ReturnType<typeof createDatabaseClient>,
  storage: ReturnType<typeof createStorageClientFromEnv>,
  teamId: string,
  userId: string,
) {
  const request = await createDataExport(database.db, {
    teamId,
    requestedBy: userId,
  });
  await drain();
  const row = await getDataExport(database.db, { id: request.id, teamId });
  if (row?.status !== "ready" || !row.filePath?.length) {
    throw new Error(
      `Export did not become ready: ${JSON.stringify({
        status: row?.status,
        error: row?.error,
      })}`,
    );
  }

  const archive = new Uint8Array(
    await (
      await storage.download({ bucket: "vault", path: row.filePath })
    ).arrayBuffer(),
  );
  if (createHash("sha256").update(archive).digest("hex") !== row.sha256) {
    throw new Error("Stored export archive does not match its checksum");
  }
  const entries = readStoredZip(archive);
  const manifest = JSON.parse(entries.get("manifest.json")?.toString() ?? "{}");
  const exported = JSON.parse(entries.get("invoices.json")?.toString() ?? "[]");
  // Accepted documents and legacy (pre-intake) records are invoices.
  const accepted = await database.db
    .select({ id: inbox.id, filePath: inbox.filePath })
    .from(inbox)
    .where(
      and(
        eq(inbox.teamId, teamId),
        ne(inbox.status, "deleted"),
        or(isNull(inbox.intakeState), eq(inbox.intakeState, "accepted")),
      ),
    );

  for (const invoice of accepted) {
    // A record without a stored original (the synthetic duplicate-candidate
    // copies) has no document to export.
    if (!invoice.filePath?.length) continue;
    const document = manifest.documents?.find(
      (entry: { invoiceId: string }) => entry.invoiceId === invoice.id,
    );
    const original = await storage
      .download({ bucket: "vault", path: invoice.filePath })
      .then(async (blob) => Buffer.from(await blob.arrayBuffer()))
      .catch(() => null);
    if (!document || document.status !== (original ? "included" : "missing")) {
      throw new Error(`Export misreports the document of ${invoice.id}`);
    }
    if (original && !entries.get(document.path)?.equals(original)) {
      throw new Error(`Exported document of ${invoice.id} differs`);
    }
  }
  // The processed invoice carries its extraction, supplier and judgments.
  const processed = exported.find(
    (invoice: {
      extraction?: { supplierName?: string };
      judgmentIds?: string[];
    }) =>
      invoice.extraction?.supplierName === expectedExtraction.supplierName &&
      (invoice.judgmentIds?.length ?? 0) > 0,
  );
  if (exported.length !== accepted.length || !processed?.supplierId) {
    throw new Error("Exported invoices do not match the processed workspace");
  }

  const slot = new Date().toISOString();
  const retention = await enqueueWorkflow(database.db, {
    name: "apply-retention",
    payload: { slot },
    idempotencyKey: workflowKey.retention(`verify-${slot}`),
  });
  await drain();
  const run = await getWorkflowJob(database.db, { id: retention.id });
  const [next] = await database.db
    .select({ id: workflowJobs.id })
    .from(workflowJobs)
    .where(
      and(
        eq(workflowJobs.name, "apply-retention"),
        eq(workflowJobs.status, "queued"),
      ),
    )
    .limit(1);
  if (run?.status !== "succeeded" || !next) {
    throw new Error(
      `Retention run did not succeed and reschedule: ${JSON.stringify({
        status: run?.status,
        error: run?.lastError,
      })}`,
    );
  }

  await storage.remove({ bucket: "vault", path: row.filePath });
  await database.db.delete(dataExports).where(eq(dataExports.id, row.id));

  return {
    exportedInvoices: exported.length,
    exportedDocuments: manifest.counts?.documents,
    retentionRescheduled: true,
  };
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

    const persistedValues = valuesOf(persisted?.extraction);
    if (
      !Bun.deepEquals(
        persistedValues.values,
        valuesOf(expectedExtraction).values,
      ) ||
      persistedValues.evidence?.lineItems.length !==
        expectedExtraction.lineItems.length ||
      !persistedValues.evidence.fields.grossAmount
    ) {
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
      // The deterministic checks are persisted beside the extraction.
      persisted.validation?.version !== 1 ||
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
    const duplicateCandidates = await verifyDuplicateCandidates(
      database,
      teamId,
    );
    const lifecycle = await verifyExportAndRetention(
      database,
      storage,
      teamId,
      userId,
    );

    console.log(
      JSON.stringify({
        event: "workflow_verification_succeeded",
        inputMatrix,
        duplicateCandidates,
        lifecycle,
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
