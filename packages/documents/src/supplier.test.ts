import { describe, expect, test } from "bun:test";
import {
  SUPPLIER_CHECKS_VERSION,
  type SupplierCheckSupplier,
  type SupplierHistoryRecord,
  type SupplierRecord,
  bankAccountKeysOf,
  checkSupplierHistory,
  companyNumberKey,
  resolveSupplier,
  supplierIdentifiersOf,
} from "./supplier";
import { validateInvoice } from "./validation";

const invoice = (value: Record<string, unknown> = {}) => ({
  documentType: "invoice",
  supplierName: "Acme Supplies Ltd",
  supplierVatNumber: null,
  supplierCompanyNumber: null,
  invoiceNumber: "INV-1",
  originalInvoiceNumber: null,
  invoiceDate: "2026-09-01",
  currency: "GBP",
  netAmount: 100,
  vatAmount: 20,
  grossAmount: 120,
  bankDetails: {
    accountName: null,
    accountNumber: null,
    sortCode: null,
    iban: null,
    bic: null,
  },
  ...value,
});

const supplier = (
  id: string,
  value: Partial<SupplierRecord> = {},
): SupplierRecord => ({
  id,
  canonicalId: id,
  nameKey: "acme supplies",
  vatKey: null,
  companyKey: null,
  ...value,
});

const resolve = (extraction: unknown, suppliers: SupplierRecord[]) =>
  resolveSupplier(supplierIdentifiersOf(extraction), suppliers);

const record = (
  id: string,
  extraction: unknown,
  receivedAt = "2026-09-01T10:00:00.000Z",
): SupplierHistoryRecord => ({ id, extraction, receivedAt, supplierId: "s1" });

const matched: SupplierCheckSupplier = {
  status: "matched",
  supplierId: "s1",
  name: "Acme Supplies Ltd",
  method: "vat_number",
  message: "Matched by VAT number.",
};

const check = (
  extraction: unknown,
  history: SupplierHistoryRecord[],
  supplierInfo: SupplierCheckSupplier = matched,
) =>
  checkSupplierHistory({
    extraction,
    validation: validateInvoice(
      extraction,
      history.map(({ id, extraction }) => ({ id, extraction })),
    ),
    supplier: supplierInfo,
    history,
    earlierInvoices: history.length,
    firstInvoice: history.at(-1) ?? null,
    now: new Date("2026-09-25T00:00:00.000Z"),
  });

describe("supplier identifiers", () => {
  test("normalise VAT, company number and legal-name variations", () => {
    expect(
      supplierIdentifiersOf(
        invoice({
          supplierName: "ACME Supplies Limited",
          supplierVatNumber: "gb 123 4567 89",
          supplierCompanyNumber: "1234567",
        }),
      ),
    ).toEqual({
      name: "ACME Supplies Limited",
      nameKey: "acme supplies",
      vatKey: "GB123456789",
      companyKey: "01234567",
    });
    expect(companyNumberKey("SC 123456")).toBe("SC123456");
  });
});

describe("supplier resolution", () => {
  test("a first invoice creates a supplier", () => {
    expect(resolve(invoice(), []).status).toBe("new");
    expect(
      resolve(invoice({ supplierVatNumber: "GB123456789" }), []),
    ).toMatchObject({ status: "new", method: "vat_number" });
  });

  test("a VAT number resolves to its supplier whatever the printed name", () => {
    const suppliers = [supplier("s1", { vatKey: "GB123456789" })];
    expect(
      resolve(
        invoice({
          supplierName: "Acme Trading",
          supplierVatNumber: "GB 123 456 789",
        }),
        suppliers,
      ),
    ).toMatchObject({
      status: "matched",
      supplierId: "s1",
      method: "vat_number",
    });
  });

  test("a merged supplier's identifiers resolve to the supplier it was merged into", () => {
    const suppliers = [
      supplier("s1", { vatKey: "GB123456789" }),
      supplier("s2", {
        canonicalId: "s1",
        nameKey: "acme trading",
        companyKey: "01234567",
      }),
    ];
    expect(
      resolve(invoice({ supplierCompanyNumber: "01234567" }), suppliers),
    ).toMatchObject({
      status: "matched",
      supplierId: "s1",
      method: "company_number",
    });
    expect(
      resolve(invoice({ supplierName: "Acme Trading" }), suppliers),
    ).toMatchObject({ status: "matched", supplierId: "s1", method: "name" });
  });

  test("same-name suppliers with different VAT numbers stay apart", () => {
    const suppliers = [supplier("s1", { vatKey: "GB111111111" })];
    // A second business with the same name and its own VAT number.
    expect(
      resolve(invoice({ supplierVatNumber: "GB222222222" }), suppliers),
    ).toMatchObject({ status: "new", method: "vat_number" });
    // Once both exist, a name-only invoice is ambiguous and stays unresolved.
    const both = [
      ...suppliers,
      supplier("s2", { vatKey: "GB222222222", nameKey: "acme supplies" }),
    ];
    const ambiguous = resolve(invoice(), both);
    expect(ambiguous).toMatchObject({
      status: "unresolved",
      reason: "ambiguous_name",
    });
    expect(
      ambiguous.status === "unresolved" && ambiguous.candidateIds.sort(),
    ).toEqual(["s1", "s2"]);
  });

  test("a name-only supplier gains the first registration number printed for it", () => {
    expect(
      resolve(invoice({ supplierVatNumber: "GB123456789" }), [supplier("s1")]),
    ).toMatchObject({
      status: "matched",
      supplierId: "s1",
      method: "name",
      learn: { vatKey: "GB123456789" },
    });
  });

  test("identifiers that point at different suppliers are not guessed between", () => {
    const suppliers = [
      supplier("s1", { vatKey: "GB123456789" }),
      supplier("s2", { companyKey: "01234567", nameKey: "other" }),
    ];
    expect(
      resolve(
        invoice({
          supplierVatNumber: "GB123456789",
          supplierCompanyNumber: "01234567",
        }),
        suppliers,
      ),
    ).toMatchObject({
      status: "unresolved",
      reason: "conflicting_identifiers",
    });
    expect(
      resolve(
        invoice({
          supplierVatNumber: "GB123456789",
          supplierCompanyNumber: "09999999",
        }),
        [supplier("s1", { vatKey: "GB123456789", companyKey: "01234567" })],
      ),
    ).toMatchObject({
      status: "unresolved",
      reason: "conflicting_identifiers",
    });
  });

  test("no supplier identity at all stays unresolved", () => {
    expect(
      resolve(invoice({ supplierName: null }), [supplier("s1")]),
    ).toMatchObject({
      status: "unresolved",
      reason: "no_supplier_identity",
    });
  });
});

describe("supplier history checks", () => {
  test("a first invoice is not a duplicate and has no bank history", () => {
    const result = check(
      invoice({
        bankDetails: { sortCode: "12-34-56", accountNumber: "12345678" },
      }),
      [],
    );
    expect(result.version).toBe(SUPPLIER_CHECKS_VERSION);
    expect(result.known.outcome).toBe("first_invoice");
    expect(result.duplicate.outcome).toBe("none");
    expect(result.bankDetails.outcome).toBe("insufficient_evidence");
    expect(result.bankDetails.current).toEqual({
      kind: "uk_account",
      ending: "5678",
    });
    expect(result.historyIds).toEqual([]);
  });

  test("a later invoice is from a known supplier and records its evidence", () => {
    const first = record("inv-1", invoice());
    const result = check(invoice({ invoiceNumber: "INV-2", grossAmount: 60 }), [
      first,
    ]);
    expect(result.known).toMatchObject({
      outcome: "known",
      earlierInvoices: 1,
      evidence: [{ invoiceId: "inv-1", reason: "first_invoice" }],
    });
    expect(result.duplicate.outcome).toBe("none");
    expect(result.historyIds).toEqual(["inv-1"]);
  });

  test("the same number, date and total is a likely duplicate", () => {
    const result = check(invoice(), [record("inv-1", invoice())]);
    expect(result.duplicate).toMatchObject({
      outcome: "likely_duplicate",
      evidence: [{ invoiceId: "inv-1", reason: "same_number" }],
    });
  });

  test("the same number with a changed total is a revision, not a copy", () => {
    const result = check(
      invoice({ grossAmount: 150, netAmount: 125, vatAmount: 25 }),
      [record("inv-1", invoice())],
    );
    expect(result.duplicate).toMatchObject({
      outcome: "revision",
      evidence: [{ invoiceId: "inv-1", reason: "same_number_changed" }],
    });
  });

  test("the same date and total under another number may be the same bill", () => {
    const result = check(invoice({ invoiceNumber: "INV-9" }), [
      record("inv-1", invoice()),
    ]);
    expect(result.duplicate).toMatchObject({
      outcome: "likely_duplicate",
      evidence: [{ invoiceId: "inv-1", reason: "same_date_and_total" }],
    });
  });

  test("a credit note against an earlier invoice is linked, not a duplicate", () => {
    const original = record("inv-1", invoice());
    const result = check(
      invoice({
        documentType: "credit_note",
        invoiceNumber: "CN-1",
        originalInvoiceNumber: "INV-1",
        grossAmount: -120,
        netAmount: -100,
        vatAmount: -20,
      }),
      [original],
    );
    expect(result.duplicate).toMatchObject({
      outcome: "credit_note",
      evidence: [{ invoiceId: "inv-1", reason: "credited_invoice" }],
    });
    expect(result.duplicate.message).toContain("INV-1");
  });

  test("a credit note sharing an invoice's number is not that invoice's duplicate", () => {
    const result = check(
      invoice({ documentType: "credit_note", grossAmount: -120 }),
      [record("inv-1", invoice())],
    );
    expect(result.duplicate.outcome).toBe("credit_note");
  });

  test("changed bank details are reported against the latest details, masked", () => {
    const older = record(
      "inv-1",
      invoice({
        invoiceNumber: "INV-1",
        bankDetails: { sortCode: "11-22-33", accountNumber: "44556677" },
      }),
      "2026-08-01T00:00:00.000Z",
    );
    const latest = record(
      "inv-2",
      invoice({
        invoiceNumber: "INV-2",
        bankDetails: { iban: "GB29 NWBK 6016 1331 9268 19" },
      }),
      "2026-09-01T00:00:00.000Z",
    );
    const changed = check(
      invoice({
        invoiceNumber: "INV-3",
        bankDetails: { sortCode: "11-22-33", accountNumber: "44556677" },
      }),
      [latest, older],
    );
    expect(changed.bankDetails).toMatchObject({
      outcome: "changed",
      current: { kind: "uk_account", ending: "6677" },
      evidence: [
        {
          invoiceId: "inv-2",
          reason: "latest_bank_details",
          bankAccount: { kind: "iban", ending: "6819" },
        },
        { invoiceId: "inv-1", reason: "same_bank_details" },
      ],
    });
    const serialized = JSON.stringify(changed);
    expect(serialized).not.toContain("44556677");
    expect(serialized).not.toContain("NWBK60161331926819");
    expect(serialized).not.toContain("112233");

    // A GB IBAN and the same sort code and account are the same account.
    const consistent = check(
      invoice({
        invoiceNumber: "INV-3",
        bankDetails: { sortCode: "60-16-13", accountNumber: "31926819" },
      }),
      [latest, older],
    );
    expect(consistent.bankDetails.outcome).toBe("consistent");
  });

  test("an unresolved supplier has insufficient evidence, not a negative answer", () => {
    const result = check(
      invoice({
        bankDetails: { sortCode: "11-22-33", accountNumber: "44556677" },
      }),
      [],
      {
        status: "unresolved",
        supplierId: null,
        name: "Acme Supplies Ltd",
        method: null,
        message: "2 suppliers in this workspace share this name.",
      },
    );
    expect(result.known.outcome).toBe("insufficient_evidence");
    expect(result.duplicate.outcome).toBe("insufficient_evidence");
    expect(result.bankDetails.outcome).toBe("insufficient_evidence");
  });

  test("bank keys derive a UK account from a GB IBAN", () => {
    expect(
      bankAccountKeysOf(
        invoice({ bankDetails: { iban: "GB29 NWBK 6016 1331 9268 19" } }),
      ),
    ).toEqual({
      iban: "GB29NWBK60161331926819",
      ukAccount: "601613:31926819",
    });
  });
});

describe("validation follows the resolved supplier", () => {
  test("resolved suppliers decide duplicates over printed names", () => {
    const earlier = {
      id: "inv-1",
      extraction: invoice({ supplierName: "Acme Trading" }),
      supplierId: "s1",
    };
    // Different printed names, merged into one supplier: a duplicate.
    expect(
      validateInvoice(invoice(), [earlier], { supplierId: "s1" }).identity
        .duplicateOf,
    ).toBe("inv-1");
    // Same printed name, two different suppliers: not a duplicate.
    expect(
      validateInvoice(invoice({ supplierName: "Acme Trading" }), [earlier], {
        supplierId: "s2",
      }).identity.duplicateOf,
    ).toBeNull();
  });

  test("a revised total is still held back but described as a revision", () => {
    const result = validateInvoice(
      invoice({ grossAmount: 150, netAmount: 125, vatAmount: 25 }),
      [{ id: "inv-1", extraction: invoice() }],
    );
    expect(result.identity.duplicateOf).toBe("inv-1");
    expect(
      result.issues.find((issue) => issue.code === "duplicate")?.message,
    ).toContain("revision");
  });
});
