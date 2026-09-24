import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { JudgmentResults } from "./judgment-results";

/**
 * Built-in checks ship with internal TypeSafe wording in `question` (field
 * paths wrapped in backticks). The invoice detail page must only ever show the
 * customer-facing `label` for those checks; custom questions keep the wording
 * the customer wrote.
 */
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

describe("judgment results rendered wording", () => {
  test("built-in checks show their plain-English label, never internal wording", () => {
    const html = renderToStaticMarkup(
      <JudgmentResults judgments={builtInChecks} />,
    );

    for (const check of builtInChecks) {
      expect(html).toContain(check.label);
    }
    expect(html).not.toContain("currentInvoice");
    expect(html).not.toContain("previousInvoices");
    expect(html).not.toContain("supplierName");
    expect(html).not.toContain("bankDetails");
    expect(html).not.toContain("`");
  });

  test("custom questions keep the wording the customer wrote", () => {
    const html = renderToStaticMarkup(
      <JudgmentResults judgments={[customCheck]} />,
    );

    expect(html).toContain("Is this over our £500 approval threshold?");
    expect(html).toContain("Your question");
  });
});
