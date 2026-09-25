import { describe, expect, test } from "bun:test";
import { validateInvoice } from "@invoicewise/documents";
import { renderToStaticMarkup } from "react-dom/server";
import { ValidationResults, uncertainFields } from "./validation-results";

const extraction = {
  documentType: "invoice",
  supplierName: "Northgate Scaffolding Ltd",
  supplierVatNumber: "GB314159283",
  invoiceNumber: "NS-20931",
  invoiceDate: "2026-09-08",
  currency: "GBP",
  netAmount: 2000,
  vatAmount: 400,
  taxRate: 20,
  grossAmount: 2450,
  lineItems: [],
  evidence: {
    fields: {
      invoiceNumber: {
        page: 1,
        line: 3,
        text: "Invoice Number:  NS-20931",
        label: "Invoice Number:",
        confidence: 0.4,
      },
    },
    lineItems: [],
  },
};

describe("invoice validation panel", () => {
  test("shows why an invoice is not sent to accounting, check by check", () => {
    const validation = validateInvoice(extraction);
    const html = renderToStaticMarkup(
      <ValidationResults validation={validation} />,
    );
    expect(html).toContain("Not sent to accounting");
    expect(html).toContain(
      "Net 2,000.00 + VAT 400.00 = 2,400.00, but the gross total is 2,450.00.",
    );
    expect(html).toContain("Net + VAT = gross");
    expect(html).toContain("Invalid");
    expect(html).toContain(
      "The invoice number was selected with low confidence",
    );
    expect(uncertainFields(validation)).toEqual(new Set(["invoiceNumber"]));
  });

  test("marks a deliverable invoice ready and a credit note as not sent", () => {
    const ready = renderToStaticMarkup(
      <ValidationResults
        validation={validateInvoice({ ...extraction, grossAmount: 2400 })}
      />,
    );
    expect(ready).toContain("Ready for accounting");
    expect(ready).not.toContain("Not sent to accounting");

    const credit = renderToStaticMarkup(
      <ValidationResults
        validation={validateInvoice({
          ...extraction,
          documentType: "credit_note",
          grossAmount: 2400,
        })}
      />,
    );
    expect(credit).toContain("Credit note");
    expect(credit).toContain("QuickBooks receives it as a vendor credit");
  });

  test("an invoice processed before validation existed says so", () => {
    expect(
      renderToStaticMarkup(<ValidationResults validation={null} />),
    ).toContain("processed before validation existed");
  });
});
