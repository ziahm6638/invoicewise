import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QuestionSummary } from "../question-summary";
import { JudgmentResults } from "./judgment-results";

/**
 * Built-in checks ship with internal TypeSafe wording in `question` (field
 * paths wrapped in backticks). The invoice detail page and Settings must only
 * show the customer-facing label and plain-English description for those
 * checks; custom questions keep the wording the customer wrote.
 */
const expectedDescriptions = {
  likely_duplicate: "This invoice may duplicate one already received.",
  vat_calculation_correct: "VAT adds up correctly for the net amount.",
  known_supplier: "This supplier has sent invoices before.",
  bank_details_consistent:
    "Bank details match earlier invoices from this supplier.",
};

const expectNoInternalWording = (html: string) => {
  expect(html).not.toContain("currentInvoice");
  expect(html).not.toContain("previousInvoices");
  expect(html).not.toContain("supplierName");
  expect(html).not.toContain("bankDetails");
  expect(html).not.toContain("`");
};

const builtInChecks = [
  {
    questionId: "likely_duplicate",
    label: "Likely duplicate",
    question:
      "Is `currentInvoice` likely a duplicate of any entry in `previousInvoices`?",
    source: "default",
    status: "answered",
    type: "boolean",
    answer: false,
    probability: 0.2,
  },
  {
    questionId: "vat_calculation_correct",
    label: "VAT calculation correct",
    question:
      "Is the VAT calculation on `currentInvoice` arithmetically correct, so net amount plus VAT amount equals gross amount?",
    source: "default",
    status: "answered",
    type: "boolean",
    answer: true,
    probability: 0.95,
  },
  {
    questionId: "known_supplier",
    label: "Known supplier",
    question:
      "Does `currentInvoice.supplierName` identify a supplier present in `previousInvoices`?",
    source: "default",
    status: "not_applicable",
    type: "boolean",
    reason: "There are no earlier invoices yet.",
  },
  {
    questionId: "bank_details_consistent",
    label: "Bank details consistent",
    question:
      "Are `currentInvoice.bankDetails` consistent with bank details on previous invoices from the same supplier?",
    source: "default",
    status: "failed",
    type: "boolean",
    error: "InvoiceWise could not produce a reliable answer.",
  },
];

const customCheck = {
  questionId: "custom-threshold",
  label: "Is this over our £500 approval threshold?",
  question: "Is this over our £500 approval threshold?",
  source: "custom",
  status: "answered",
  type: "boolean",
  answer: true,
  probability: 0.8,
};

const settingsQuestion = (check: {
  questionId: string;
  label: string;
  question: string;
  source: string;
}) =>
  ({
    id: `row-${check.questionId}`,
    questionKey: check.questionId,
    label: check.label,
    question: check.question,
    context: null,
    type: "boolean",
    options: null,
    enabled: true,
    isDefault: check.source === "default",
    version: 1,
  }) as unknown as Parameters<typeof QuestionSummary>[0]["question"];

describe("invoice page check wording", () => {
  test("built-in checks show their label and plain-English description, never internal wording", () => {
    const html = renderToStaticMarkup(
      <JudgmentResults judgments={builtInChecks} />,
    );

    for (const check of builtInChecks) {
      expect(html).toContain(check.label);
      expect(html).toContain(
        expectedDescriptions[
          check.questionId as keyof typeof expectedDescriptions
        ],
      );
    }
    expectNoInternalWording(html);
  });

  test("custom questions keep the wording the customer wrote", () => {
    const html = renderToStaticMarkup(
      <JudgmentResults judgments={[customCheck]} />,
    );

    expect(html).toContain("Is this over our £500 approval threshold?");
    expect(html).toContain("Your question");
  });
});

describe("settings question wording", () => {
  test("built-in checks show their label and plain-English description, never internal wording", () => {
    for (const check of builtInChecks) {
      const html = renderToStaticMarkup(
        <QuestionSummary question={settingsQuestion(check)} />,
      );

      expect(html).toContain(check.label);
      expect(html).toContain(
        expectedDescriptions[
          check.questionId as keyof typeof expectedDescriptions
        ],
      );
      expectNoInternalWording(html);
    }
  });

  test("custom questions keep the wording the customer wrote", () => {
    const html = renderToStaticMarkup(
      <QuestionSummary
        question={settingsQuestion({
          ...customCheck,
          label: "Over threshold",
        })}
      />,
    );

    expect(html).toContain("Over threshold");
    expect(html).toContain("Is this over our £500 approval threshold?");
  });
});

describe("answer states", () => {
  const base = {
    questionId: "payment_days",
    label: "Payment terms",
    question: "How many days does the invoice allow for payment?",
    source: "custom",
    type: "number",
    questionVersion: 3,
    evaluator: { model: "jev-1.13.0", version: "questions-2" },
    format: { unit: "days", min: 0, max: 365 },
  };

  test("zero is shown as an answer with the row it was read from", () => {
    const html = renderToStaticMarkup(
      <JudgmentResults
        judgments={[
          {
            ...base,
            status: "answered",
            answer: 0,
            confidence: 0.9,
            certainty: "confident",
            evidence: { line: 4, text: "Deposit days: 0", printed: "0" },
          },
        ]}
      />,
    );
    expect(html).toContain("0 days");
    expect(html).toContain("Deposit days: 0");
    expect(html).toContain("Question v3 · jev-1.13.0");
  });

  test("unknown, uncertain and incomplete answers are never shown as No or 0", () => {
    const html = renderToStaticMarkup(
      <JudgmentResults
        judgments={[
          {
            ...base,
            status: "unknown",
            reason: "The invoice does not state this value.",
          },
          {
            ...customCheck,
            questionId: "leaning",
            probability: 0.45,
            answer: false,
            certainty: "low_confidence",
          },
          {
            ...customCheck,
            questionId: "cut",
            probability: 0.99,
            certainty: "incomplete_input",
            limits: [
              "Only the first 16,000 characters of the document's 20,000 were read.",
            ],
          },
        ]}
      />,
    );
    expect(html).toContain("Unknown");
    expect(html).toContain("The invoice does not state this value.");
    expect(html).toContain("Unsure, leaning no");
    expect(html).toContain("Low confidence");
    expect(html).toContain("Answered from incomplete input");
    expect(html).toContain("Only the first 16,000 characters");
    expect(html).not.toContain(">0 days<");
  });
});
