import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { TypeSafe, type TypeSafeAnswer } from "./client";
import {
  type InvoiceJudgmentQuestion,
  extractInvoiceText,
  judgeInvoice,
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

const candidateFor = (question: any, value: string | number) =>
  Object.entries(question.criteria).find(
    ([, criterion]: [string, any]) => criterion?.value === value,
  )?.[0] ?? "absent";

const extractionAnswers = (questions: Record<string, any>) => {
  const expected: Record<string, string | number> = {
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
  return Object.fromEntries(
    Object.entries(questions).map(([id, question]) =>
      id.startsWith("line_item_")
        ? [id, { type: "noul", noul: 0.99 }]
        : [
            id,
            {
              type: "choice",
              choice: candidateFor(question, expected[id]!),
              probabilities: {},
              confidence: 0.99,
            },
          ],
    ),
  ) as Record<string, TypeSafeAnswer>;
};

const ExtractionTest = Layer.succeed(TypeSafe, {
  evaluate: ({ questions }) =>
    Effect.succeed({
      model: "test",
      answers: extractionAnswers(questions),
      usage: { inputTokens: 0, outputTokens: 0 },
    }),
});

describe("TypeSafe invoice extraction", () => {
  test("copies selected candidates into the structured invoice", async () => {
    const result = await Effect.runPromise(
      extractInvoiceText(invoiceText, "InvoiceWise Ltd").pipe(
        Effect.provide(ExtractionTest),
      ),
    );

    expect(result).toEqual({
      supplierName: "Acme Supplies Ltd",
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
    });
  });

  test("represents fields with no source candidate explicitly", async () => {
    const result = await Effect.runPromise(
      extractInvoiceText("INVOICE\nAcme Supplies Ltd").pipe(
        Effect.provide(ExtractionTest),
      ),
    );

    expect(result.invoiceNumber).toBeNull();
    expect(result.invoiceDate).toBeNull();
    expect(result.grossAmount).toBeNull();
    expect(result.bankDetails.iban).toBeNull();
    expect(result.lineItems).toEqual([]);
  });
});

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
    const JudgmentTest = Layer.succeed(TypeSafe, {
      evaluate: ({ questions }) => {
        const ids = Object.keys(questions);
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
    const extraction = await Effect.runPromise(
      extractInvoiceText(invoiceText).pipe(Effect.provide(ExtractionTest)),
    );
    const result = await Effect.runPromise(
      judgeInvoice(extraction, [{ id: "previous", extraction }], custom).pipe(
        Effect.provide(JudgmentTest),
      ),
    );

    expect(
      result.map(({ questionId, type, source }) => ({
        questionId,
        type,
        source,
      })),
    ).toEqual([
      { questionId: "likely_duplicate", type: "boolean", source: "default" },
      {
        questionId: "vat_calculation_correct",
        type: "boolean",
        source: "default",
      },
      { questionId: "known_supplier", type: "boolean", source: "default" },
      {
        questionId: "bank_details_consistent",
        type: "boolean",
        source: "default",
      },
      { questionId: "approval_route", type: "choice", source: "custom" },
      { questionId: "risk_level", type: "score", source: "custom" },
    ]);
    expect(result[4]).toMatchObject({
      answer: "Routine",
      confidence: 0.8,
      questionVersionId: "approval-route-v1",
      status: "answered",
    });
    expect(result[5]).toMatchObject({ answer: 0.2, confidence: 0.76 });
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
      evaluate: ({ questions }) => {
        const answers = Object.fromEntries(
          Object.keys(questions).map((id, index) => [
            id,
            index === 4
              ? { type: "noul" as const, noul: 0.5 }
              : { type: "noul" as const, noul: 0.9 },
          ]),
        );
        return Effect.succeed({
          model: "test",
          answers,
          usage: { inputTokens: 0, outputTokens: 0 },
        });
      },
    });
    const extraction = await Effect.runPromise(
      extractInvoiceText(invoiceText).pipe(Effect.provide(ExtractionTest)),
    );
    const result = await Effect.runPromise(
      judgeInvoice(extraction, [], [malformed]).pipe(
        Effect.provide(JudgmentTest),
      ),
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
