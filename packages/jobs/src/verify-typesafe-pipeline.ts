import { resolve } from "node:path";
import { createDatabaseClient } from "@midday/db/client";
import {
  createInbox,
  createUserQuestion,
  deleteUserQuestion,
  getUserQuestions,
  updateInboxWithProcessedData,
  updateUserQuestion,
} from "@midday/db/queries";
import { teams, users } from "@midday/db/schema";
import { createStorageClientFromEnv } from "@midday/db/storage";
import type { InvoiceExtraction } from "@midday/documents";
import { eq } from "drizzle-orm";
import { processDocumentAttachment } from "./tasks/inbox/process-document";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const extractionValues: Record<string, string | number> = {
  supplier_name: "Acme Supplies Ltd",
  supplier_vat_number: "GB123456789",
  invoice_number: "INV-2026-0042",
  invoice_date: "2026-09-01",
  due_date: "2026-09-30",
  currency: "GBP",
  net_amount: 1000,
  vat_amount: 200,
  gross_amount: 1200,
  bank_account_name: "Acme Supplies Ltd",
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
      const answers = Object.hasOwn(body.questions, "supplier_name")
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
};

async function main() {
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
  const typeSafeStub = startTypeSafeStub();
  process.env.TYPESAFE_API_KEY = "verification-key";
  process.env.TYPESAFE_BASE_URL = `http://127.0.0.1:${typeSafeStub.port}`;
  let teamId: string | undefined;
  let userId: string | undefined;
  let uploadedPath: string[] | undefined;
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

    const filePath = [teamId, "inbox", "synthetic-invoice.pdf"];
    uploadedPath = filePath;
    await storage.upload({ bucket: "vault", path: filePath, file: bytes });
    const stored = await storage.download({ bucket: "vault", path: filePath });
    const storedBytes = Buffer.from(await stored.arrayBuffer());
    const current = await createInbox(database.db, {
      displayName: "synthetic-invoice.pdf",
      teamId,
      filePath,
      fileName: "synthetic-invoice.pdf",
      contentType: "application/pdf",
      size: bytes.length,
      status: "processing",
    });
    if (!current) throw new Error("Unable to create current invoice");

    const { record } = await processDocumentAttachment(database.db, {
      inboxId: current.id,
      teamId,
      documentUrl: `data:application/pdf;base64,${storedBytes.toString("base64")}`,
      mimetype: "application/pdf",
      companyName: "InvoiceWise Ltd",
    });
    const judgments = record?.judgments ?? [];
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
    if (
      record?.status !== "pending" ||
      defaultJudgments.length !== 4 ||
      !approvalJudgment ||
      !failedJudgment
    ) {
      throw new Error(
        "Pipeline verification did not persist expected judgments",
      );
    }

    console.log(
      JSON.stringify(
        {
          id: record?.id,
          status: record?.status,
          filePath: record?.filePath,
          extraction: record?.extraction,
          judgments,
        },
        null,
        2,
      ),
    );
  } finally {
    if (uploadedPath) {
      await storage.remove({ bucket: "vault", path: uploadedPath });
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
