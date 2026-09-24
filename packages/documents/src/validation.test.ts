import { describe, expect, test } from "bun:test";
import { lineItem } from "./test/oracle";
import type { FieldEvidence, InvoiceExtraction } from "./typesafe/invoice";
import {
  MONEY_RULES,
  VALIDATION_VERSION,
  accountingReadiness,
  gbVatNumberValid,
  toMinor,
  validateInvoice,
} from "./validation";

const evidence = (value: Partial<FieldEvidence> = {}): FieldEvidence => ({
  page: 1,
  line: 0,
  text: null,
  label: null,
  confidence: 0.95,
  ...value,
});

const invoice = (
  value: Partial<InvoiceExtraction> = {},
): InvoiceExtraction => ({
  documentType: "invoice",
  supplierName: "Harbour Lane Plumbing Ltd",
  supplierAddress: null,
  supplierVatNumber: "GB481516249",
  supplierCompanyNumber: null,
  invoiceNumber: "HLP-1",
  originalInvoiceNumber: null,
  invoiceDate: "2026-09-01",
  dueDate: "2026-10-01",
  currency: "GBP",
  netAmount: 100,
  discountAmount: null,
  vatAmount: 20,
  taxRate: 20,
  grossAmount: 120,
  amountsIncludeTax: null,
  lineItems: [
    lineItem({
      description: "Service",
      quantity: 1,
      unitPrice: 100,
      total: 100,
    }),
  ],
  bankDetails: {
    accountName: null,
    accountNumber: null,
    sortCode: null,
    iban: null,
    bic: null,
  },
  description: null,
  purchaseOrderReference: null,
  paymentReference: null,
  textSource: "text-layer",
  pageSources: ["text-layer"],
  evidence: { fields: {}, lineItems: [] },
  ...value,
});

const outcome = (extraction: unknown, id: string) =>
  validateInvoice(extraction).checks.find((check) => check.id === id)?.outcome;

const codes = (extraction: unknown) =>
  validateInvoice(extraction).issues.map((issue) => issue.code);

describe("money precision and tolerances", () => {
  test("rounds half away from zero into minor units", () => {
    expect(toMinor(1.005)).toBe(101);
    expect(toMinor(-1.005)).toBe(-101);
    expect(toMinor(0.1 + 0.2)).toBe(30);
    expect(MONEY_RULES.lineToleranceMinor(1)).toBe(1);
    expect(MONEY_RULES.lineToleranceMinor(40)).toBe(20);
    expect(MONEY_RULES.taxToleranceMinor(0)).toBe(1);
  });

  test("net + VAT = gross allows one penny and no more", () => {
    expect(outcome(invoice({ grossAmount: 120.01 }), "gross")).toBe("pass");
    const off = invoice({ grossAmount: 120.02 });
    expect(outcome(off, "gross")).toBe("fail");
    expect(validateInvoice(off).accounting).toMatchObject({
      ready: false,
      blockers: [{ code: "gross" }],
    });
  });

  test("tax rounded per line may differ by a penny per line; on one line two pence fail", () => {
    const lines = Array.from({ length: 5 }, () =>
      lineItem({
        description: "Box",
        quantity: 1,
        unitPrice: 2.03,
        taxRate: 20,
        total: 2.03,
      }),
    );
    const perLine = invoice({
      netAmount: 10.15,
      vatAmount: 2.05,
      grossAmount: 12.2,
      taxRate: null,
      lineItems: lines,
    });
    expect(outcome(perLine, "tax")).toBe("pass");
    const oneLine = invoice({
      netAmount: 10.15,
      vatAmount: 2.05,
      grossAmount: 12.2,
      taxRate: 20,
      lineItems: [lineItem({ description: "Box", total: 10.15, taxRate: 20 })],
    });
    expect(outcome(oneLine, "tax")).toBe("fail");
  });

  test("line arithmetic tolerates a rounded unit price in proportion to quantity", () => {
    const labels = (total: number) =>
      invoice({
        netAmount: total,
        vatAmount: null,
        taxRate: null,
        grossAmount: total,
        lineItems: [
          lineItem({
            description: "Labels",
            quantity: 1000,
            unitPrice: 0.33,
            total,
          }),
        ],
      });
    // A unit price printed as 0.33 may be 0.3333: 1000 of them can differ
    // from 330.00 by up to half a penny each (5.00).
    expect(outcome(labels(333.33), "line_arithmetic")).toBe("pass");
    expect(outcome(labels(340), "line_arithmetic")).toBe("fail");
  });
});

describe("tax basis", () => {
  test("an inclusive table adds up to the gross total and VAT is the inclusive fraction", () => {
    const inclusive = invoice({
      netAmount: null,
      vatAmount: 20,
      grossAmount: 120,
      amountsIncludeTax: true,
      lineItems: [
        lineItem({
          description: "Chair",
          quantity: 1,
          unitPrice: 120,
          total: 120,
        }),
      ],
    });
    const validation = validateInvoice(inclusive);
    expect(validation.taxBasis).toBe("inclusive");
    expect(outcome(inclusive, "line_totals")).toBe("pass");
    expect(outcome(inclusive, "tax")).toBe("pass");
    expect(outcome(inclusive, "gross")).toBe("unknown");
  });

  test("zero-rated: VAT printed as zero passes; a missing VAT amount is not assumed zero", () => {
    expect(
      outcome(invoice({ vatAmount: 0, taxRate: 0, grossAmount: 100 }), "tax"),
    ).toBe("pass");
    const missing = invoice({ vatAmount: null, taxRate: null });
    expect(outcome(missing, "tax")).toBe("fail");
    expect(codes(missing)).toContain("tax_missing");
  });

  test("VAT on lines at a rate not printed anywhere is unknown, not assumed", () => {
    const unrated = invoice({ taxRate: null });
    expect(outcome(unrated, "tax")).toBe("unknown");
    expect(validateInvoice(unrated).status).toBe("needs_review");
    expect(validateInvoice(unrated).accounting.ready).toBe(true);
  });

  test("VAT charged without a VAT number is flagged, not treated as registered", () => {
    expect(codes(invoice({ supplierVatNumber: null }))).toEqual([
      "vat_without_registration",
    ]);
  });
});

describe("currencies", () => {
  test("an amount printed in another currency is never added to or converted", () => {
    const mixed = invoice({
      evidence: {
        fields: {
          grossAmount: evidence({ currencyMarker: "USD", currency: "USD" }),
          netAmount: evidence({ currencyMarker: "£", currency: "GBP" }),
        },
        lineItems: [],
      },
    });
    const validation = validateInvoice(mixed);
    expect(validation.checks.map((check) => [check.id, check.outcome])).toEqual(
      [
        ["currency", "fail"],
        ["line_arithmetic", "pass"],
        ["line_totals", "pass"],
        ["tax", "pass"],
        ["gross", "unsupported"],
      ],
    );
    expect(validation.totals.gross).toEqual({ amount: 120, currency: "USD" });
    expect(validation.totals.net).toEqual({ amount: 100, currency: "GBP" });
    expect(validation.accounting.blockers.map((b) => b.code)).toEqual([
      "currency_mismatch",
    ]);
  });

  test("a bare dollar sign fits a dollar currency but not sterling", () => {
    const dollars = (currency: string) =>
      invoice({
        currency,
        supplierVatNumber: null,
        evidence: {
          fields: {
            grossAmount: evidence({ currencyMarker: "$", currency: null }),
          },
          lineItems: [],
        },
      });
    expect(outcome(dollars("USD"), "currency")).toBe("pass");
    expect(outcome(dollars("GBP"), "currency")).toBe("fail");
  });

  test("no currency is unknown and blocks delivery", () => {
    const validation = validateInvoice(invoice({ currency: null }));
    expect(outcome(invoice({ currency: null }), "currency")).toBe("unknown");
    expect(validation.totals.gross).toEqual({ amount: 120, currency: null });
    expect(validation.accounting.blockers).toEqual([
      {
        code: "missing_field",
        message: "No currency was found on the document.",
      },
    ]);
  });
});

describe("credit notes and identity", () => {
  const credit = (value: Partial<InvoiceExtraction> = {}) =>
    invoice({
      documentType: "credit_note",
      invoiceNumber: "CN-1",
      originalInvoiceNumber: "HLP-1",
      netAmount: -100,
      vatAmount: -20,
      grossAmount: -120,
      lineItems: [
        lineItem({
          description: "Refund",
          quantity: -1,
          unitPrice: 100,
          total: -100,
        }),
      ],
      ...value,
    });

  test("printed negative or positive, a credit note validates and is stored negative", () => {
    for (const note of [
      credit(),
      credit({
        netAmount: 100,
        vatAmount: 20,
        grossAmount: 120,
        lineItems: [
          lineItem({
            description: "Refund",
            quantity: 1,
            unitPrice: 100,
            total: 100,
          }),
        ],
      }),
    ]) {
      const validation = validateInvoice(note, [
        { id: "original", extraction: invoice() },
      ]);
      expect(validation.status).toBe("valid");
      expect(validation.totals.gross).toEqual({
        amount: -120,
        currency: "GBP",
      });
      expect(validation.identity.creditsInvoiceId).toBe("original");
      expect(validation.accounting.blockers.map((b) => b.code)).toEqual([
        "credit_note_unsupported",
      ]);
    }
  });

  test("a credit note whose original is unknown or smaller is flagged for review", () => {
    expect(codes(credit())).toEqual(["original_invoice_not_found"]);
    expect(codes(credit({ originalInvoiceNumber: null }))).toEqual([
      "original_invoice_not_stated",
    ]);
    const small = invoice({ grossAmount: 60, netAmount: 50, vatAmount: 10 });
    expect(
      validateInvoice(credit(), [
        { id: "original", extraction: small },
      ]).issues.map((issue) => issue.code),
    ).toEqual(["credit_exceeds_invoice"]);
  });

  test("an invoice with a negative total is refused as a bill", () => {
    const negative = invoice({
      netAmount: -100,
      vatAmount: -20,
      grossAmount: -120,
      lineItems: [],
    });
    expect(codes(negative)).toContain("negative_invoice_total");
    expect(validateInvoice(negative).accounting.ready).toBe(false);
  });

  test("duplicates match on supplier (VAT number, else name) and number, not formatting", () => {
    const earlier = {
      id: "earlier",
      extraction: invoice({ invoiceNumber: "hlp 1" }),
    };
    expect(validateInvoice(invoice(), [earlier]).identity.duplicateOf).toBe(
      "earlier",
    );
    const otherSupplier = {
      id: "other",
      extraction: invoice({ supplierVatNumber: "GB556677885" }),
    };
    expect(
      validateInvoice(invoice(), [otherSupplier]).identity.duplicateOf,
    ).toBeNull();
    const byName = {
      id: "by-name",
      extraction: invoice({
        supplierVatNumber: null,
        supplierName: "HARBOUR LANE PLUMBING LIMITED",
      }),
    };
    expect(
      validateInvoice(invoice({ supplierVatNumber: null }), [byName]).identity
        .duplicateOf,
    ).toBe("by-name");
  });
});

describe("fields, dates and uncertainty", () => {
  test("provider-required fields that are missing block delivery with a reason each", () => {
    const validation = validateInvoice(
      invoice({
        documentType: null,
        invoiceNumber: null,
        invoiceDate: null,
        dueDate: null,
      }),
    );
    expect(validation.status).toBe("invalid");
    expect(
      validation.accounting.blockers.map((blocker) => blocker.message),
    ).toEqual([
      "No document type (invoice or credit note) was found on the document.",
      "No invoice number was found on the document.",
      "No invoice date was found on the document.",
    ]);
  });

  test("a due date before the invoice date is an error", () => {
    expect(codes(invoice({ dueDate: "2026-08-01" }))).toEqual([
      "due_before_invoice_date",
    ]);
  });

  test("low-confidence selections stay visible as uncertain", () => {
    const uncertain = invoice({
      evidence: {
        fields: { invoiceNumber: evidence({ confidence: 0.42 }) },
        lineItems: [evidence({ confidence: 0.55 })],
      },
    });
    expect(validateInvoice(uncertain).issues).toEqual([
      expect.objectContaining({
        code: "low_confidence",
        field: "invoiceNumber",
      }),
      expect.objectContaining({ code: "low_confidence", field: "lineItems" }),
    ]);
    expect(validateInvoice(uncertain).accounting.ready).toBe(true);
  });

  test("identifier check digits are verified, not trusted", () => {
    expect(gbVatNumberValid("GB 481 5162 49")).toBe(true);
    expect(gbVatNumberValid("GB123456789")).toBe(false);
    expect(gbVatNumberValid("FR40123456789")).toBeNull();
    expect(
      codes(
        invoice({
          bankDetails: {
            accountName: null,
            accountNumber: null,
            sortCode: null,
            iban: "GB12 ACME 1234 5678 9012 34",
            bic: null,
          },
        }),
      ),
    ).toEqual(["iban_checksum"]);
  });
});

describe("stored records", () => {
  test("an extraction saved before validation existed is validated without assumptions", () => {
    const legacy = {
      supplierName: "Acme Supplies Ltd",
      supplierVatNumber: "GB123456789",
      invoiceNumber: "INV-1",
      invoiceDate: "2026-09-22",
      currency: "GBP",
      netAmount: 100,
      vatAmount: 20,
      grossAmount: 120,
      lineItems: [
        { description: "Materials", quantity: 1, unitPrice: 100, total: 100 },
      ],
    };
    const validation = validateInvoice(legacy);
    expect(validation.documentType).toBe("unknown");
    expect(validation.accounting.blockers.map((b) => b.code)).toEqual([
      "missing_field",
    ]);
    expect(accountingReadiness(legacy, null)).toEqual(validation.accounting);
  });

  test("the stored verdict is used while its rules are current, and recomputed after", () => {
    const stored = validateInvoice(invoice(), [
      { id: "earlier", extraction: invoice() },
    ]);
    expect(accountingReadiness(invoice(), stored).ready).toBe(false);
    expect(
      accountingReadiness(invoice(), {
        ...stored,
        version: VALIDATION_VERSION - 1,
      }).ready,
    ).toBe(true);
  });
});
