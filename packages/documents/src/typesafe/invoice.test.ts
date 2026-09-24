import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Effect, Layer } from "effect";
import {
  TypeSafe,
  type TypeSafeAnswer,
  TypeSafeLive,
  type TypeSafeQuestion,
} from "./client";
import {
  type InvoiceExtraction,
  type InvoiceJudgmentQuestion,
  extractInvoiceText,
  judgeInvoice,
  processInvoice,
} from "./invoice";

const invoiceText = `
Acme Supplies Ltd
VAT number: GB123456789
Invoice number: INV-2026-0042
Invoice date: 2026-09-01
Due date: 2026-09-30
Currency: GBP
Purchase order reference: PO-7788
Description: September consulting services
Consulting services | 2 | £500.00 | £1,000.00
Net total: £1,000.00
VAT: £200.00
Gross total: £1,200.00
Account name: Acme Supplies Ltd
Account number: 12345678
Sort code: 12-34-56
IBAN: GB12 ACME 1234 5678 9012 34
BIC: ACMEGB2L
`;

type Request = { state: unknown; questions: Record<string, TypeSafeQuestion> };

/**
 * A deterministic TypeSafe that answers like a correct model would: for each
 * field it selects the candidate whose value is the expected one (or absent
 * when none is), and confirms every table row. The assertions therefore test
 * everything code owns: reading, layout, candidate coverage, normalisation and
 * copying the selected values into the extraction.
 */
const oracle = (expected: Record<string, unknown>, requests: Request[] = []) =>
  Layer.succeed(TypeSafe, {
    evaluate: (request) => {
      requests.push(request);
      const answers = Object.fromEntries(
        Object.entries(request.questions).map(([id, question]) => {
          if (question.type === "noul") {
            return [id, { type: "noul", noul: 0.99 }];
          }
          const criteria = question.criteria as Record<string, any>;
          const choice =
            Object.entries(criteria).find(
              ([, criterion]) =>
                criterion?.value !== undefined &&
                criterion.value === expected[id],
            )?.[0] ?? "absent";
          return [
            id,
            { type: "choice", choice, probabilities: {}, confidence: 0.99 },
          ];
        }),
      ) as Record<string, TypeSafeAnswer>;
      return Effect.succeed({
        model: "test",
        answers,
        usage: { inputTokens: 0, outputTokens: 0 },
      });
    },
  });

const textExpectations = {
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

const fixture = async (name: string) =>
  readFile(resolve(__dirname, "../test/fixtures", name));

const dataUrl = (bytes: Buffer, mimetype: string) =>
  `data:${mimetype};base64,${bytes.toString("base64")}`;

/** What a UK invoice's printed fields should become, by TypeSafe question id. */
const ukInvoiceSelections = {
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

const ukInvoiceExtraction = (
  textSource: InvoiceExtraction["textSource"],
): InvoiceExtraction => ({
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
  textSource,
});

const tesseractAvailable =
  spawnSync(process.env.IW_TESSERACT_COMMAND || "tesseract", ["--version"])
    .status === 0;
// CI and the production image install tesseract; a developer machine
// without it skips the OCR case instead of failing.
const ocrTest = tesseractAvailable || process.env.CI ? test : test.skip;

describe("invoice extraction from real PDFs", () => {
  test("reads a text-layer UK invoice: supplier, address, VAT, bank details, line items, UK dates", async () => {
    const requests: Request[] = [];
    const result = await Effect.runPromise(
      processInvoice({
        documentUrl: dataUrl(
          await fixture("uk-invoice.pdf"),
          "application/pdf",
        ),
        mimetype: "application/pdf",
        companyName: "InvoiceWise Ltd",
      }).pipe(Effect.provide(oracle(ukInvoiceSelections, requests))),
    );

    expect(result.extraction).toEqual(ukInvoiceExtraction("text-layer"));
    // TypeSafe sees the laid-out document, one tagged row per printed line,
    // with table cells still in their columns.
    const state = requests[0]!.state as { invoice: string };
    expect(state.invoice).toContain(
      "| Oak skirting board supply and fit  12  £45.00  20%  £540.00",
    );
    expect(state.invoice).toContain("| Sort Code:  40-11-62");
  });

  ocrTest(
    "OCRs a scanned, image-only UK invoice with no text layer",
    async () => {
      const result = await Effect.runPromise(
        processInvoice({
          documentUrl: dataUrl(
            await fixture("uk-invoice-scanned.pdf"),
            "application/pdf",
          ),
          mimetype: "application/pdf",
          companyName: "InvoiceWise Ltd",
        }).pipe(Effect.provide(oracle(ukInvoiceSelections))),
      );

      expect(result.extraction).toEqual(ukInvoiceExtraction("ocr"));
    },
    60_000,
  );

  test("reads a supplier named only in a wrapped footer, with a TO: customer block", async () => {
    const result = await Effect.runPromise(
      processInvoice({
        documentUrl: dataUrl(
          await fixture("uk-invoice-footer.pdf"),
          "application/pdf",
        ),
        mimetype: "application/pdf",
        companyName: "Harlow Estates Ltd",
      }).pipe(
        Effect.provide(
          oracle({
            supplier_name: "Brightwater Advisory Ltd",
            supplier_address: "7 Canal Wharf, Wharf Road, Leeds, LS1 4BR",
            invoice_number: "BW-2031",
            invoice_date: "31/12/2025",
            currency: "GBP",
            gross_amount: 1200,
            bank_account_name: "Brightwater Advisory Ltd",
            bank_account_number: "41236789",
            bank_sort_code: "30-94-57",
          }),
        ),
      ),
    );

    expect(result.extraction).toEqual({
      supplierName: "Brightwater Advisory Ltd",
      supplierAddress: "7 Canal Wharf, Wharf Road, Leeds, LS1 4BR",
      supplierVatNumber: null,
      invoiceNumber: "BW-2031",
      invoiceDate: "2025-12-31",
      // "Payment due on receipt"
      dueDate: "2025-12-31",
      currency: "GBP",
      netAmount: null,
      vatAmount: null,
      grossAmount: 1200,
      lineItems: [
        {
          description: "Consultation – 1 DEC 25 to 31 DEC 25",
          quantity: 4,
          unitPrice: 300,
          total: 1200,
        },
      ],
      bankDetails: {
        accountName: "Brightwater Advisory Ltd",
        accountNumber: "41236789",
        sortCode: "30-94-57",
        iban: null,
        bic: null,
      },
      description: null,
      purchaseOrderReference: null,
      textSource: "text-layer",
    });
  });

  test("fails, rather than saving an empty extraction, when nothing is readable", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        extractInvoiceText("   \n  ").pipe(Effect.provide(oracle({}))),
      ),
    );
    expect(error.reason).toContain("no readable text");
    expect(error.retryable).toBe(false);
  });

  test("fails when TypeSafe finds none of the invoice's details", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        extractInvoiceText(
          "Meeting notes\nWe discussed the roadmap and agreed next steps.",
        ).pipe(Effect.provide(oracle({}))),
      ),
    );
    expect(error.reason).toContain("No invoice details could be read");
  });
});

describe("TypeSafe invoice extraction", () => {
  test("copies selected candidates into the structured invoice", async () => {
    const result = await Effect.runPromise(
      extractInvoiceText(invoiceText, "InvoiceWise Ltd").pipe(
        Effect.provide(oracle(textExpectations)),
      ),
    );

    expect(result).toEqual({
      supplierName: "Acme Supplies Ltd",
      supplierAddress: null,
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
        accountName: "Acme Supplies Ltd",
        accountNumber: "12345678",
        sortCode: "12-34-56",
        iban: "GB12 ACME 1234 5678 9012 34",
        bic: "ACMEGB2L",
      },
      description: "September consulting services",
      purchaseOrderReference: "PO-7788",
      textSource: "text",
    });
  });

  test("represents fields with no source candidate explicitly", async () => {
    const result = await Effect.runPromise(
      extractInvoiceText("INVOICE\nAcme Supplies Ltd\nThank you").pipe(
        Effect.provide(oracle({ supplier_name: "Acme Supplies Ltd" })),
      ),
    );

    expect(result.supplierName).toBe("Acme Supplies Ltd");
    expect(result.invoiceNumber).toBeNull();
    expect(result.invoiceDate).toBeNull();
    expect(result.grossAmount).toBeNull();
    expect(result.bankDetails.iban).toBeNull();
    expect(result.lineItems).toEqual([]);
  });

  test("derives the due date from payment terms when none is printed", async () => {
    const result = await Effect.runPromise(
      extractInvoiceText(
        "Acme Supplies Ltd\nInvoice date: 15/09/2026\nPayment terms: 30 days",
      ).pipe(
        Effect.provide(
          oracle({
            supplier_name: "Acme Supplies Ltd",
            invoice_date: "15/09/2026",
          }),
        ),
      ),
    );
    expect(result.invoiceDate).toBe("2026-09-15");
    expect(result.dueDate).toBe("2026-10-15");
  });
});

const extraction = ukInvoiceExtraction("text-layer");

describe("TypeSafe invoice judgments", () => {
  test("stores defaults and configured questions in one typed shape", async () => {
    const custom: InvoiceJudgmentQuestion[] = [
      {
        id: "approval_route",
        versionId: "approval-route-v1",
        label: "Approval route",
        type: "choice",
        question: "Which approval route applies?",
        context: "Director approval is required over £500.",
        options: ["Routine", "Director"],
      },
      {
        id: "risk_level",
        label: "Risk level",
        type: "score",
        question: "How risky is this invoice?",
        levels: ["low", "medium", "high"],
      },
    ];
    const requests: Request[] = [];
    const JudgmentTest = Layer.succeed(TypeSafe, {
      evaluate: (request) => {
        requests.push(request);
        const ids = Object.keys(request.questions);
        const answers: Record<string, TypeSafeAnswer> = {
          [ids[0]!]: { type: "noul", noul: 0.91 },
          [ids[1]!]: { type: "noul", noul: 0.97 },
          [ids[2]!]: { type: "noul", noul: 0.89 },
          [ids[3]!]: { type: "noul", noul: 0.86 },
          [ids[4]!]: {
            type: "choice",
            choice: "option_0",
            probabilities: { option_0: 0.9, option_1: 0.1 },
            confidence: 0.8,
          },
          [ids[5]!]: {
            type: "score",
            score: 0.2,
            legend: { "0": "low", "1": "medium", "2": "high" },
            probabilities: { "0": 0.85, "1": 0.1, "2": 0.05 },
            confidence: 0.76,
          },
        };
        return Effect.succeed({
          model: "test",
          answers,
          usage: { inputTokens: 0, outputTokens: 0 },
        });
      },
    });
    const result = await Effect.runPromise(
      judgeInvoice(
        extraction,
        [{ id: "previous", extraction }],
        custom,
        undefined,
        "Northwind Joinery Ltd\nInvoice No:  NJ-10457",
      ).pipe(Effect.provide(JudgmentTest)),
    );

    expect(
      result.map(({ questionId, type, source, status }) => ({
        questionId,
        type,
        source,
        status,
      })),
    ).toEqual([
      {
        questionId: "likely_duplicate",
        type: "boolean",
        source: "default",
        status: "answered",
      },
      {
        questionId: "vat_calculation_correct",
        type: "boolean",
        source: "default",
        status: "answered",
      },
      {
        questionId: "known_supplier",
        type: "boolean",
        source: "default",
        status: "answered",
      },
      {
        questionId: "bank_details_consistent",
        type: "boolean",
        source: "default",
        status: "answered",
      },
      {
        questionId: "approval_route",
        type: "choice",
        source: "custom",
        status: "answered",
      },
      {
        questionId: "risk_level",
        type: "score",
        source: "custom",
        status: "answered",
      },
    ]);
    expect(result[4]).toMatchObject({
      answer: "Routine",
      confidence: 0.8,
      questionVersionId: "approval-route-v1",
      status: "answered",
    });
    expect(result[5]).toMatchObject({ answer: 0.2, confidence: 0.76 });
    // Judgments read the document as well as the extracted fields.
    expect(requests[0]!.state).toMatchObject({
      currentInvoice: extraction,
      invoiceText: "Northwind Joinery Ltd\nInvoice No:  NJ-10457",
    });
  });

  test("marks history and missing-value checks not applicable instead of answering No", async () => {
    const asked: string[][] = [];
    const JudgmentTest = Layer.succeed(TypeSafe, {
      evaluate: ({ questions }) => {
        asked.push(
          Object.values(questions).map((question) =>
            JSON.stringify(question.instructions),
          ),
        );
        return Effect.succeed({
          model: "test",
          answers: Object.fromEntries(
            Object.keys(questions).map((id) => [
              id,
              { type: "noul" as const, noul: 0.97 },
            ]),
          ),
          usage: { inputTokens: 0, outputTokens: 0 },
        });
      },
    });
    const withoutAmounts = {
      ...extraction,
      netAmount: null,
      bankDetails: {
        accountName: null,
        accountNumber: null,
        sortCode: null,
        iban: null,
        bic: null,
      },
    };
    const result = await Effect.runPromise(
      judgeInvoice(withoutAmounts, []).pipe(Effect.provide(JudgmentTest)),
    );

    expect(result.map(({ status }) => status)).toEqual([
      "not_applicable",
      "not_applicable",
      "not_applicable",
      "not_applicable",
    ]);
    expect(result[0]).toMatchObject({
      reason:
        "There are no earlier invoices in this workspace to compare with yet.",
    });
    expect(result[1]).toMatchObject({
      reason:
        "The net, VAT and gross amounts were not all found on this invoice.",
    });
    expect(result[3]).toMatchObject({
      reason: "No bank details were found on this invoice to compare.",
    });
    // Nothing applicable means TypeSafe is not asked at all.
    expect(asked).toEqual([]);
  });

  test("records an unparseable question without dropping other answers", async () => {
    const malformed: InvoiceJudgmentQuestion = {
      id: "malformed",
      versionId: "malformed-v1",
      label: "Malformed answer",
      type: "choice",
      question: "Which route applies?",
      options: ["Routine", "Director"],
    };
    const JudgmentTest = Layer.succeed(TypeSafe, {
      evaluate: ({ questions }) =>
        Effect.succeed({
          model: "test",
          answers: Object.fromEntries(
            Object.keys(questions).map((id) => [
              id,
              { type: "noul" as const, noul: 0.9 },
            ]),
          ),
          usage: { inputTokens: 0, outputTokens: 0 },
        }),
    });
    const result = await Effect.runPromise(
      judgeInvoice(
        extraction,
        [{ id: "previous", extraction }],
        [malformed],
      ).pipe(Effect.provide(JudgmentTest)),
    );

    expect(result).toHaveLength(5);
    expect(
      result.slice(0, 4).every((judgment) => judgment.status === "answered"),
    ).toBe(true);
    expect(result[4]).toMatchObject({
      questionId: "malformed",
      questionVersionId: "malformed-v1",
      status: "failed",
      error: "TypeSafe returned the wrong answer type for this question",
    });
  });
});

// One end-to-end check against the real TypeSafe API. It runs only when
// explicitly requested with a key, e.g.
//   TYPESAFE_LIVE_SMOKE=1 TYPESAFE_API_KEY=... bun test src/typesafe
const liveTest =
  process.env.TYPESAFE_LIVE_SMOKE === "1" && process.env.TYPESAFE_API_KEY
    ? test
    : test.skip;

describe("live TypeSafe smoke", () => {
  liveTest(
    "extracts the UK invoice fixture with the real model",
    async () => {
      const result = await Effect.runPromise(
        processInvoice({
          documentUrl: dataUrl(
            await fixture("uk-invoice.pdf"),
            "application/pdf",
          ),
          mimetype: "application/pdf",
          companyName: "InvoiceWise Ltd",
        }).pipe(Effect.provide(TypeSafeLive)),
      );
      // The address is printed twice (header block and footer); either copy
      // is the supplier's address.
      const {
        description: _description,
        supplierAddress: _address,
        ...expected
      } = ukInvoiceExtraction("text-layer");
      expect(result.extraction).toMatchObject(expected);
      expect(result.extraction.supplierAddress).toMatch(
        /^Unit 4, Riverside Trading Estate, Leeds,? LS11 5QP$/,
      );
      expect(
        result.judgments.find(
          (judgment) => judgment.questionId === "vat_calculation_correct",
        ),
      ).toMatchObject({ status: "answered", answer: true });
    },
    60_000,
  );
});
