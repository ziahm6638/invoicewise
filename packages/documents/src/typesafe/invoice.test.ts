import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Effect, Layer } from "effect";
import sharp from "sharp";
import { validateIntakeDocument } from "../intake";
import { renderPdfPageIsolated } from "../isolated";
import { layoutRuns } from "../layout";
import { type OracleRequest as Request, oracle } from "../test/oracle";
import { TypeSafe, type TypeSafeAnswer, TypeSafeLive } from "./client";
import {
  INVOICE_EXTRACTION_LIMITS,
  type InvoiceExtraction,
  type InvoiceJudgmentQuestion,
  extractInvoiceLines,
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
  textSource: "text-layer" | "ocr",
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
  pageSources: [textSource],
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

  ocrTest(
    "OCRs a phone photo stored sideways with an EXIF orientation",
    async () => {
      const rendered = await renderPdfPageIsolated(
        new Uint8Array(await fixture("uk-invoice-scanned.pdf")),
        {
          timeoutMs: 30_000,
          maxPages: 1,
          maxPageDimension: 5_000,
          maxTotalPixels: 15_000_000,
          maxChars: 400_000,
        },
        { page: 1, scale: 300 / 72 },
      );
      if (!rendered.ok) throw new Error(rendered.message);
      // Orientation 6: the pixels are stored a quarter-turn anticlockwise and
      // a viewer turns them clockwise to show the page upright.
      const photo = await sharp(Buffer.from(rendered.result.png))
        .rotate(270)
        .withMetadata({ orientation: 6 })
        .jpeg({ quality: 95 })
        .toBuffer();

      const result = await Effect.runPromise(
        processInvoice({
          documentUrl: dataUrl(photo, "image/jpeg"),
          mimetype: "image/jpeg",
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
      pageSources: ["text-layer"],
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
  test("reads a right-column supplier block as a column, not merged with the customer's rows", async () => {
    // The supplier block sits right of the "Invoice to" block, so the VAT
    // line shares its baseline with the customer's street.
    const run = (x: number, y: number, text: string) => ({
      x,
      y,
      width: text.length * 5,
      height: 10,
      text,
    });
    const lines = layoutRuns([
      run(50, 39, "TAX INVOICE"),
      run(320, 39, "Pennine Plumbing & Heating Ltd"),
      run(320, 61, "14 Mill Lane"),
      run(320, 74, "Hebden Bridge"),
      run(50, 87, "Invoice to:"),
      run(320, 87, "West Yorkshire"),
      run(50, 100, "Calder Property Group"),
      run(320, 100, "HX7 8AD"),
      run(50, 113, "5 Market Street"),
      run(320, 113, "VAT No. GB 612 7788 03"),
      run(50, 127, "Halifax HX1 1PB"),
      run(50, 157, "Invoice #"),
      run(150, 157, "PPH-0931"),
    ]);
    const requests: Request[] = [];
    const extraction = await Effect.runPromise(
      extractInvoiceLines(lines).pipe(
        Effect.provide(
          oracle(
            {
              supplier_vat_number: "GB612778803",
              invoice_number: "PPH-0931",
            },
            requests,
          ),
        ),
      ),
    );

    expect(extraction.supplierVatNumber).toBe("GB612778803");
    // TypeSafe reads each side-by-side block as its own column, and the VAT
    // candidate's row is its own column's text, not the customer's street.
    const request = requests.find(
      (entry) => entry.questions.supplier_vat_number,
    )!;
    expect((request.state as { invoice: string }).invoice).toContain(
      [
        "L000| Pennine Plumbing & Heating Ltd",
        "L001| 14 Mill Lane",
        "L002| Hebden Bridge",
        "L003| West Yorkshire",
        "L004| HX7 8AD",
        "L005| VAT No. GB 612 7788 03",
      ].join("\n"),
    );
    expect(
      (request.questions.supplier_vat_number!.criteria as Record<string, any>)
        .vat_0.row,
    ).toBe("L005: VAT No. GB 612 7788 03");
  });

  test("splits side-by-side blocks that share their first and last rows", async () => {
    // The title shares the supplier name's row and the customer block ends on
    // the supplier's last row, so no row holds only the customer's column.
    const run = (x: number, y: number, text: string, height = 10) => ({
      x,
      y,
      width: text.length * 5,
      height,
      text,
    });
    const lines = layoutRuns([
      run(50, 46, "INVOICE", 18),
      run(330, 50, "Aire Valley Electrical Services Ltd"),
      run(330, 66, "Unit 7, Canal Wharf"),
      run(330, 80, "Skipton"),
      run(50, 94, "Bill to:"),
      run(330, 94, "North Yorkshire"),
      run(50, 108, "Harrogate Lettings Ltd"),
      run(330, 108, "BD23 2AB"),
      run(50, 122, "22 Station Parade"),
      run(330, 122, "VAT Reg No: GB 287 4401 62"),
      run(50, 136, "Harrogate HG1 1UF"),
      run(330, 136, "Tel: 01756 700 123"),
      run(50, 170, "Invoice No:"),
      run(150, 170, "AVE-2207"),
    ]);
    const requests: Request[] = [];
    const extraction = await Effect.runPromise(
      extractInvoiceLines(lines).pipe(
        Effect.provide(
          oracle(
            {
              supplier_vat_number: "GB287440162",
              invoice_number: "AVE-2207",
            },
            requests,
          ),
        ),
      ),
    );

    expect(extraction.supplierVatNumber).toBe("GB287440162");
    const request = requests.find(
      (entry) => entry.questions.supplier_vat_number,
    )!;
    const invoice = (request.state as { invoice: string }).invoice;
    expect(invoice).toContain(
      [
        "L000| Aire Valley Electrical Services Ltd",
        "L001| Unit 7, Canal Wharf",
        "L002| Skipton",
        "L003| North Yorkshire",
        "L004| BD23 2AB",
        "L005| VAT Reg No: GB 287 4401 62",
        "L006| Tel: 01756 700 123",
      ].join("\n"),
    );
    expect(invoice).toContain("L005| 22 Station Parade\n");
    // A label/value row keeps its label beside its value.
    expect(invoice).toContain("Invoice No:  AVE-2207");
  });

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
      pageSources: [],
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

  test.each([
    ["Terms: Net 30", "2026-10-15"],
    ["Net 14 days", "2026-09-29"],
    ["Net 500.00", null],
    ["Net 1,000.00", null],
    ["Net total 500.00", null],
  ])("reads %p as payment terms only when it is one", async (line, due) => {
    const result = await Effect.runPromise(
      extractInvoiceText(
        `Acme Supplies Ltd\nInvoice date: 15/09/2026\n${line}`,
      ).pipe(
        Effect.provide(
          oracle({
            supplier_name: "Acme Supplies Ltd",
            invoice_date: "15/09/2026",
          }),
        ),
      ),
    );
    expect(result.dueDate).toBe(due);
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

const multipageSelections = {
  supplier_name: "Northwind Joinery Ltd",
  supplier_address: "Unit 4, Riverside Trading Estate, Leeds, LS11 5QP",
  supplier_vat_number: "GB293445512",
  invoice_number: "NJ-10458",
  invoice_date: "15 September 2026",
  due_date: "15-Oct-2026",
  currency: "GBP",
  net_amount: 5285.3,
  vat_amount: 1057.06,
  gross_amount: 6342.36,
  bank_account_name: "Northwind Joinery Ltd",
  bank_account_number: "71234598",
  bank_sort_code: "40-11-62",
  purchase_order_reference: "PO-55187",
};

const item = (
  description: string,
  quantity: number,
  unitPrice: number,
  total: number,
) => ({ description, quantity, unitPrice, total });

/** Both pages' rows, in page order: nothing dropped, nothing added. */
const multipageLineItems = [
  item("Oak skirting board supply and fit", 12, 45, 540),
  item("Kitchen worktop installation", 1, 850, 850),
  item("Bespoke shelving unit", 2, 325.5, 651),
  item("Internal door hanging", 6, 95, 570),
  item("Door ironmongery set", 6, 38.5, 231),
  item("Architrave supply and fit", 18, 12.75, 229.5),
  item("Staircase spindle replacement", 24, 14.2, 340.8),
  item("Handrail refinishing", 1, 180, 180),
  item("Window board replacement", 5, 42, 210),
  item("Loft hatch installation", 1, 265, 265),
  item("Wardrobe carcass assembly", 2, 410, 820),
  item("Soft-close hinge upgrade", 20, 6.4, 128),
  item("Site protection and cleaning", 1, 150, 150),
  item("Site waste disposal", 3, 40, 120),
];

const multipageExtraction = {
  supplierName: "Northwind Joinery Ltd",
  supplierAddress: "Unit 4, Riverside Trading Estate, Leeds, LS11 5QP",
  supplierVatNumber: "GB293445512",
  invoiceNumber: "NJ-10458",
  invoiceDate: "2026-09-15",
  dueDate: "2026-10-15",
  currency: "GBP",
  netAmount: 5285.3,
  vatAmount: 1057.06,
  grossAmount: 6342.36,
  lineItems: multipageLineItems,
  bankDetails: {
    accountName: "Northwind Joinery Ltd",
    accountNumber: "71234598",
    sortCode: "40-11-62",
    iban: null,
    bic: null,
  },
  description: null,
  purchaseOrderReference: "PO-55187",
};

const MIME_BY_EXTENSION: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
};

/** Runs a committed fixture through intake validation and then the pipeline. */
const processFixture = async (
  name: string,
  selections: Record<string, unknown>,
  companyName = "InvoiceWise Ltd",
) => {
  const bytes = await fixture(name);
  const validation = await validateIntakeDocument({
    bytes: new Uint8Array(bytes),
    declaredMimeType: MIME_BY_EXTENSION[name.split(".").pop()!],
  });
  if (!validation.ok) throw new Error(`${name}: ${validation.message}`);
  return Effect.runPromise(
    Effect.either(
      processInvoice({
        documentUrl: dataUrl(bytes, validation.mimeType),
        mimetype: validation.mimeType,
        companyName,
        previousInvoices: [],
      }).pipe(Effect.provide(oracle(selections))),
    ),
  );
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

describe("supported input matrix", () => {
  ocrTest(
    "the same invoice as text PDF, scanned PDF, PNG scan and JPEG photo yields the same data",
    async () => {
      const inputs = [
        ["uk-invoice.pdf", ["text-layer"]],
        ["uk-invoice-scanned.pdf", ["ocr"]],
        ["uk-invoice-scan.png", ["ocr"]],
        ["uk-invoice-photo.jpg", ["ocr"]],
      ] as const;
      const results = [];
      for (const [name, pageSources] of inputs) {
        const result = await processFixture(name, ukInvoiceSelections);
        if (result._tag === "Left") {
          throw new Error(`${name}: ${result.left.reason}`);
        }
        const {
          textSource,
          pageSources: read,
          ...fields
        } = result.right.extraction;
        expect({ name, textSource, read }).toEqual({
          name,
          textSource: pageSources[0],
          read: [...pageSources],
        });
        // Every source gives the same extracted values...
        const {
          textSource: _t,
          pageSources: _p,
          ...expected
        } = ukInvoiceExtraction("text-layer");
        expect(fields).toEqual(expected);
        results.push(result.right);
      }
      // ...and the same downstream shape, judgments included.
      const [first, ...rest] = results.map(shapeOf);
      for (const shape of rest) expect(shape).toEqual(first);
    },
    180_000,
  );

  test("reads every page of a multi-page invoice and each table row once", async () => {
    const result = await processFixture(
      "uk-invoice-multipage.pdf",
      multipageSelections,
    );
    if (result._tag === "Left") throw new Error(result.left.reason);
    expect(result.right.extraction).toEqual({
      ...multipageExtraction,
      textSource: "text-layer",
      pageSources: ["text-layer", "text-layer"],
    });
  });

  ocrTest(
    "reads a multi-page invoice whose second page is scanned",
    async () => {
      const result = await processFixture(
        "uk-invoice-multipage-mixed.pdf",
        multipageSelections,
      );
      if (result._tag === "Left") throw new Error(result.left.reason);
      expect(result.right.extraction).toEqual({
        ...multipageExtraction,
        textSource: "mixed",
        pageSources: ["text-layer", "ocr"],
      });
    },
    60_000,
  );

  test("a non-invoice attachment fails with a clear reason, not an empty success", async () => {
    const result = await processFixture("non-invoice-letter.pdf", {});
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left.reason).toContain("No invoice details could be read");
      expect(result.left.retryable).toBe(false);
    }
  });

  test("a malformed file is refused at intake and never reaches extraction", async () => {
    const bytes = await fixture("malformed-invoice.pdf");
    expect(
      await validateIntakeDocument({
        bytes: new Uint8Array(bytes),
        declaredMimeType: "application/pdf",
      }),
    ).toMatchObject({ ok: false, code: "malformed" });
    // Even if it did, the pipeline fails permanently instead of retrying.
    const error = await Effect.runPromise(
      Effect.flip(
        processInvoice({
          documentUrl: dataUrl(bytes, "application/pdf"),
          mimetype: "application/pdf",
        }).pipe(Effect.provide(oracle({}))),
      ),
    );
    expect(error.reason).toContain("PDF text extraction failed (malformed)");
    expect(error.retryable).toBe(false);
  });

  test("an unsupported type is refused rather than read as a PDF", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        processInvoice({
          documentUrl: "data:image/heic;base64,AAAA",
          mimetype: "image/heic",
        }).pipe(Effect.provide(oracle({}))),
      ),
    );
    expect(error.reason).toContain("Unsupported document type image/heic");
    expect(error.retryable).toBe(false);
  });
});

describe("extraction limits fail loudly instead of dropping content", () => {
  test("more scanned pages than are OCR'd fails before any OCR work", async () => {
    const pages = INVOICE_EXTRACTION_LIMITS.maxOcrPages + 1;
    const error = await Effect.runPromise(
      Effect.flip(
        processInvoice({
          documentUrl: dataUrl(Buffer.from(blankPdf(pages)), "application/pdf"),
          mimetype: "application/pdf",
        }).pipe(Effect.provide(oracle({}))),
      ),
    );
    expect(error.reason).toContain(`This PDF has ${pages} scanned pages`);
    expect(error.retryable).toBe(false);
  });

  test("a document longer than TypeSafe reads fails rather than keeping its first rows", async () => {
    const rows = Array.from(
      { length: INVOICE_EXTRACTION_LIMITS.maxLines + 1 },
      (_, index) => `Statement entry ${index + 1}`,
    );
    const error = await Effect.runPromise(
      Effect.flip(
        extractInvoiceText(["Invoice number: INV-1", ...rows].join("\n")).pipe(
          Effect.provide(oracle({})),
        ),
      ),
    );
    expect(error.reason).toContain(
      `at most ${INVOICE_EXTRACTION_LIMITS.maxLines} are read per invoice`,
    );
  });

  test("more table rows than are checked fails rather than dropping line items", async () => {
    const rows = Array.from(
      { length: INVOICE_EXTRACTION_LIMITS.maxLineItemRows + 1 },
      (_, index) => `Part ${index + 1} | 1 | £1.00 | £1.00`,
    );
    const error = await Effect.runPromise(
      Effect.flip(
        extractInvoiceText(["Invoice number: INV-1", ...rows].join("\n")).pipe(
          Effect.provide(oracle({})),
        ),
      ),
    );
    expect(error.reason).toContain(
      `at most ${INVOICE_EXTRACTION_LIMITS.maxLineItemRows} line items are read per invoice`,
    );
  });
});

/** A PDF of blank pages: no text layer anywhere. */
const blankPdf = (pageCount: number) => {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>"];
  const kids = Array.from(
    { length: pageCount },
    (_, index) => `${index + 3} 0 R`,
  );
  objects.push(
    `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pageCount} >>`,
  );
  for (let index = 0; index < pageCount; index++) {
    objects.push("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>");
  }
  let body = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const offset = body.length;
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(body);
};

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
