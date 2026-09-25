import { describe, expect, test } from "bun:test";
import {
  applyInvoiceCorrection,
  changesPostingIdentity,
  invoiceColumnsFromExtraction,
} from "./correction";
import type { InvoiceExtraction } from "./typesafe/invoice";
import { validateInvoice } from "./validation";

const read: InvoiceExtraction = {
  documentType: "invoice",
  supplierName: "Acme Supplies Ltd",
  supplierAddress: null,
  supplierVatNumber: "GB123456782",
  supplierCompanyNumber: null,
  invoiceNumber: "INV-1",
  originalInvoiceNumber: null,
  invoiceDate: "2026-09-01",
  dueDate: "2026-09-30",
  currency: "GBP",
  netAmount: 100,
  discountAmount: null,
  vatAmount: 20,
  taxRate: 20,
  // Read from the balance-due line instead of the total.
  grossAmount: 150,
  amountsIncludeTax: null,
  lineItems: [
    { description: "Materials", quantity: 1, unitPrice: 100, total: 100 },
  ] as InvoiceExtraction["lineItems"],
  bankDetails: {
    accountName: null,
    accountNumber: null,
    sortCode: "12-34-56",
    iban: null,
    bic: null,
  },
  description: null,
  purchaseOrderReference: null,
  paymentReference: null,
  textSource: "text-layer",
  pageSources: ["text-layer"],
  evidence: {
    fields: {
      grossAmount: {
        page: 1,
        line: 12,
        text: "Balance due £150.00",
        label: "Balance due",
        confidence: 0.55,
        currencyMarker: "£",
        currency: "GBP",
      },
    },
    lineItems: [],
  },
};

describe("applyInvoiceCorrection", () => {
  test("changes only the corrected fields and records before and after", () => {
    const result = applyInvoiceCorrection(
      read,
      { grossAmount: 120, invoiceNumber: " INV-1 " },
      "Corrected by a user (correction 1)",
    );
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.changes).toEqual([
      { field: "grossAmount", from: 150, to: 120 },
    ]);
    expect(result.extraction.grossAmount).toBe(120);
    expect(result.extraction.lineItems).toEqual(read.lineItems);
    // The corrected value is evidenced by the user, not a printed row, so
    // the low-confidence warning of the reading no longer applies.
    expect(result.extraction.evidence.fields.grossAmount).toEqual({
      page: null,
      line: null,
      text: null,
      label: null,
      confidence: null,
      derivedFrom: "Corrected by a user (correction 1)",
    });
    // The stored reading is untouched.
    expect(read.grossAmount).toBe(150);
    expect(validateInvoice(read).status).toBe("invalid");
    expect(validateInvoice(result.extraction).status).toBe("valid");
  });

  test("checks every value against the canonical record", () => {
    const result = applyInvoiceCorrection(
      read,
      {
        invoiceDate: "2026-02-30",
        currency: "pounds",
        netAmount: 10.005,
        vatAmount: Number.NaN,
        taxRate: 120,
        documentType: "receipt",
        sortCode: "12-34",
        iban: "not an iban",
        amountsIncludeTax: "yes",
        grossAmount: 100_000_000,
        lineItems: [],
      },
      "note",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((error) => error.field)).toEqual([
      "invoiceDate",
      "currency",
      "netAmount",
      "vatAmount",
      "taxRate",
      "documentType",
      "sortCode",
      "iban",
      "amountsIncludeTax",
      "grossAmount",
      null,
    ]);
    expect(result.errors.at(-1)?.message).toBe("lineItems cannot be corrected");
  });

  test("normalises values the way the reader does", () => {
    const result = applyInvoiceCorrection(
      read,
      {
        currency: "eur",
        sortCode: "40 11 62",
        iban: "gb29nwbk60161331926819",
        bic: "nwbkgb2l",
        supplierAddress: "  ",
        dueDate: null,
      },
      "note",
    );
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.extraction.currency).toBe("EUR");
    expect(result.extraction.bankDetails).toEqual({
      accountName: null,
      accountNumber: null,
      sortCode: "40-11-62",
      iban: "GB29 NWBK 6016 1331 9268 19",
      bic: "NWBKGB2L",
    });
    expect(result.extraction.dueDate).toBeNull();
    // A blank text value clears nothing that was not there.
    expect(result.changes.map((change) => change.field)).toEqual([
      "dueDate",
      "currency",
      "sortCode",
      "iban",
      "bic",
    ]);
  });

  test("refuses a correction that changes nothing", () => {
    const result = applyInvoiceCorrection(read, { grossAmount: 150 }, "note");
    expect(result).toEqual({
      ok: false,
      errors: [{ field: null, message: "The correction changes no value" }],
    });
    expect(applyInvoiceCorrection(null, { grossAmount: 1 }, "note").ok).toBe(
      false,
    );
  });

  test("knows which changes move the identity a bill is posted under", () => {
    const number = applyInvoiceCorrection(read, { invoiceNumber: "INV-2" }, "");
    const amount = applyInvoiceCorrection(read, { grossAmount: 120 }, "");
    if (!number.ok || !amount.ok) throw new Error("unexpected refusal");
    expect(changesPostingIdentity(number.changes)).toBe(true);
    expect(changesPostingIdentity(amount.changes)).toBe(false);
  });

  test("derives the list columns from the corrected record", () => {
    expect(invoiceColumnsFromExtraction({ ...read, grossAmount: 120 })).toEqual(
      {
        displayName: "Acme Supplies Ltd",
        date: "2026-09-30",
        amount: 120,
        currency: "GBP",
        description: null,
        taxAmount: 20,
        taxRate: 20,
        taxType: "vat",
      },
    );
  });
});
