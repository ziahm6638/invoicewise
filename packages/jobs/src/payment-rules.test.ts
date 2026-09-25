import { describe, expect, test } from "bun:test";
import {
  type PaymentInvoice,
  type PaymentTransaction,
  decidePayment,
  fromMinor,
  manualPaymentResult,
  paymentMatchFingerprint,
  printsReference,
  supplierWords,
  toMinor,
} from "./payment-rules";

const invoice = (overrides: Partial<PaymentInvoice> = {}): PaymentInvoice => ({
  id: "inv-1",
  documentType: "invoice",
  currency: "GBP",
  grossMinor: 120_000,
  invoiceNumber: "INV-2026-0042",
  paymentReference: null,
  supplierName: "Acme Supplies Ltd",
  invoiceDate: "2026-09-01",
  invoiceDatePrinted: true,
  credits: [],
  ...overrides,
});

let next = 0;
const tx = (overrides: Partial<PaymentTransaction> = {}): PaymentTransaction => {
  next += 1;
  const amountMinor = overrides.amountMinor ?? -120_000;
  return {
    id: `tx-${String(next).padStart(3, "0")}`,
    accountName: "Current account",
    status: "posted",
    duplicated: false,
    mode: "normal",
    madeOn: "2026-09-10",
    currency: "GBP",
    description: "Payment",
    counterparty: null,
    reference: null,
    availableMinor: Math.abs(amountMinor),
    ...overrides,
    amountMinor,
  };
};

const decide = (
  transactions: PaymentTransaction[],
  overrides: Partial<PaymentInvoice> = {},
) =>
  decidePayment({
    invoice: invoice(overrides),
    transactions,
    asOf: "2026-09-25T00:00:00.000Z",
  });

describe("money", () => {
  test("parses decimals exactly and rounds half away from zero", () => {
    expect(toMinor("1200")).toBe(120_000);
    expect(toMinor("-120.5")).toBe(-12_050);
    expect(toMinor("0.105")).toBe(11);
    expect(toMinor("-0.105")).toBe(-11);
    expect(toMinor("12.3449")).toBe(1234);
    expect(toMinor("1e3")).toBeNull();
    expect(fromMinor(-12_050)).toBe("-120.50");
    expect(fromMinor(5)).toBe("0.05");
  });
});

describe("references", () => {
  test("a reference is printed whole across spacing and punctuation", () => {
    expect(printsReference("PAYMENT INV 2026-0042 ACME", "INV20260042")).toBe(
      true,
    );
    expect(printsReference("PAYMENT INV-2026-00421", "INV20260042")).toBe(
      false,
    );
    expect(printsReference("XINV20260042", "INV20260042")).toBe(false);
  });

  test("legal words do not identify a supplier", () => {
    expect(supplierWords("The Acme Supplies Ltd")).toEqual(["ACME", "SUPPLIES"]);
  });
});

describe("decidePayment", () => {
  test("a posted transaction printing the invoice number pays it", () => {
    const paid = tx({ description: "BACS INV-2026-0042 ACME SUPPLIES" });
    const result = decide([paid, tx({ description: "Coffee", amountMinor: -350 })]);
    expect(result.status).toBe("matched");
    expect(result.paymentStatus).toBe("paid");
    expect(result.needsConfirmation).toBe(false);
    expect(result.allocations).toEqual([
      {
        kind: "payment",
        transactionId: paid.id,
        creditInboxId: null,
        amount: "1200.00",
        currency: "GBP",
      },
    ]);
    expect(result.remaining).toBe("0.00");
    expect(result.candidates.map((row) => row.transactionId)).toEqual([paid.id]);
  });

  test("two referenced part payments pay it; a third is left over", () => {
    const first = tx({
      description: "INV-2026-0042 part 1",
      amountMinor: -50_000,
      madeOn: "2026-09-05",
    });
    const second = tx({
      description: "INV-2026-0042 part 2",
      amountMinor: -50_000,
      madeOn: "2026-09-12",
    });
    const partial = decide([second, first]);
    expect(partial.paymentStatus).toBe("partially_paid");
    expect(partial.paid).toBe("1000.00");
    expect(partial.remaining).toBe("200.00");
    const third = tx({
      description: "INV-2026-0042 final",
      amountMinor: -50_000,
      madeOn: "2026-09-20",
    });
    const settled = decide([first, second, third]);
    expect(settled.paymentStatus).toBe("paid");
    expect(settled.allocations.map((row) => row.amount)).toEqual([
      "500.00",
      "500.00",
      "200.00",
    ]);
    expect(settled.unallocated).toEqual([
      { transactionId: third.id, amount: "300.00" },
    ]);
  });

  test("an exact amount without a reference is only proposed", () => {
    const named = tx({ description: "ACME SUPPLIES LTD" });
    const result = decide([named]);
    expect(result.status).toBe("proposed");
    expect(result.needsConfirmation).toBe(true);
    expect(result.paymentStatus).toBe("unpaid");
    expect(result.allocations).toEqual([]);
    expect(result.proposed[0]?.transactionId).toBe(named.id);
  });

  test("a transaction printing another invoice's number is never proposed", () => {
    const result = decide([tx({ description: "INV-2026-0099" })], {
      otherReferences: new Set(["INV20260099"]),
    });
    expect(result.status).toBe("unmatched");
    expect(result.proposed).toEqual([]);
    expect(
      result.candidates.flatMap((row) => row.evidence.map((item) => item.message)),
    ).toContain("Prints INV20260099, another invoice's reference.");
  });

  test("two plausible transactions are ambiguous and assert nothing", () => {
    const result = decide([
      tx({ description: "ACME SUPPLIES" }),
      tx({ description: "ACME SUPPLIES", madeOn: "2026-09-11" }),
    ]);
    expect(result.status).toBe("ambiguous");
    expect(result.paymentStatus).toBe("unpaid");
    expect(result.allocations).toEqual([]);
    expect(result.proposed).toEqual([]);
  });

  test("a short numeric reference needs the supplier's name", () => {
    const bare = decide([tx({ description: "REF 1042" })], {
      invoiceNumber: "1042",
    });
    expect(bare.status).toBe("proposed");
    const named = decide([tx({ description: "ACME SUPPLIES REF 1042" })], {
      invoiceNumber: "1042",
    });
    expect(named.status).toBe("matched");
    expect(named.paymentStatus).toBe("paid");
  });

  test("another currency, a reversal and a duplicate never count", () => {
    const result = decide([
      tx({ description: "INV-2026-0042", currency: "EUR" }),
      tx({ description: "INV-2026-0042", status: "reversed" }),
      tx({ description: "INV-2026-0042", duplicated: true }),
    ]);
    expect(result.status).toBe("unmatched");
    expect(result.paymentStatus).toBe("unpaid");
    expect(result.message).toContain("reversed at the bank");
    const [foreign, reversed, duplicate] = result.candidates;
    expect(foreign?.eligible).toBe(false);
    expect(reversed?.eligible).toBe(false);
    expect(duplicate?.eligible).toBe(false);
  });

  test("a pending referenced transaction is pending, not paid", () => {
    const result = decide([
      tx({ description: "INV-2026-0042", status: "pending" }),
    ]);
    expect(result.status).toBe("pending");
    expect(result.paymentStatus).toBe("pending");
    expect(result.allocations).toEqual([]);
  });

  test("money coming in does not pay an invoice but refunds a credit note", () => {
    const refund = tx({ description: "REFUND CN-0099", amountMinor: 30_000 });
    expect(decide([refund]).paymentStatus).toBe("unpaid");
    const credit = decide([refund], {
      documentType: "credit_note",
      invoiceNumber: "CN-0099",
      grossMinor: 30_000,
    });
    expect(credit.paymentStatus).toBe("paid");
    expect(credit.invoice.direction).toBe("in");
  });

  test("an applied credit note reduces what is due", () => {
    const result = decide([tx({ description: "INV-2026-0042", amountMinor: -100_000 })], {
      credits: [
        { creditInboxId: "cn-1", invoiceNumber: "CN-1", amountMinor: 20_000 },
      ],
    });
    expect(result.paymentStatus).toBe("paid");
    expect(result.allocations.map((row) => [row.kind, row.amount])).toEqual([
      ["credit", "200.00"],
      ["payment", "1000.00"],
    ]);
  });

  test("what other invoices already counted is not counted again", () => {
    const shared = tx({
      description: "INV-2026-0042",
      availableMinor: 20_000,
    });
    const result = decide([shared]);
    expect(result.paymentStatus).toBe("partially_paid");
    expect(result.paid).toBe("200.00");
  });

  test("the fingerprint ignores the time a decision was worked out", () => {
    const paid = tx({ description: "INV-2026-0042" });
    const a = decide([paid]);
    const b = { ...a, asOf: "2027-01-01T00:00:00.000Z" };
    expect(paymentMatchFingerprint(a)).toBe(paymentMatchFingerprint(b));
  });
});

describe("manualPaymentResult", () => {
  test("records payments and a bank charge from one transaction", () => {
    const combined = tx({ description: "ACME", amountMinor: -120_500 });
    const { result, issues } = manualPaymentResult({
      invoice: invoice(),
      transactions: [combined],
      payments: [{ transactionId: combined.id, amount: "1200", fee: "5" }],
      asOf: "2026-09-25T00:00:00.000Z",
    });
    expect(issues).toEqual([]);
    expect(result.paymentStatus).toBe("paid");
    expect(result.allocations.map((row) => [row.kind, row.amount])).toEqual([
      ["payment", "1200.00"],
      ["fee", "5.00"],
    ]);
  });

  test("refuses another currency, a pending entry and more than is left", () => {
    const foreign = tx({ currency: "EUR" });
    const pending = tx({ status: "pending" });
    const small = tx({ amountMinor: -10_000 });
    const { issues } = manualPaymentResult({
      invoice: invoice(),
      transactions: [foreign, pending, small],
      payments: [
        { transactionId: foreign.id, amount: "1200" },
        { transactionId: pending.id, amount: "1200" },
        { transactionId: small.id, amount: "200" },
      ],
      asOf: "2026-09-25T00:00:00.000Z",
    });
    expect(issues).toHaveLength(3);
    expect(issues[0]).toContain("never converted");
  });

  test("more than the gross total is overpaid", () => {
    const big = tx({ amountMinor: -150_000 });
    const { result } = manualPaymentResult({
      invoice: invoice(),
      transactions: [big],
      payments: [{ transactionId: big.id, amount: "1500" }],
      asOf: "2026-09-25T00:00:00.000Z",
    });
    expect(result.paymentStatus).toBe("overpaid");
    expect(result.remaining).toBe("-300.00");
  });
});
