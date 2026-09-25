import { describe, expect, test } from "bun:test";
import { decidePayment } from "@invoicewise/jobs/payment-rules";
import { renderToStaticMarkup } from "react-dom/server";
import { type PaymentDecision, PaymentMatchView } from "./payment-match-view";

const invoice = {
  id: "inv-1",
  documentType: "invoice" as const,
  currency: "GBP",
  grossMinor: 120_000,
  invoiceNumber: "INV-2026-0042",
  paymentReference: null,
  supplierName: "Acme Supplies Ltd",
  invoiceDate: "2026-09-01",
  invoiceDatePrinted: true,
  credits: [],
};

const transaction = (id: string, description: string) => ({
  id,
  accountName: "Current account",
  status: "posted" as const,
  duplicated: false,
  mode: "normal" as const,
  madeOn: "2026-09-10",
  amountMinor: -120_000,
  currency: "GBP",
  description,
  counterparty: null,
  reference: null,
  availableMinor: 120_000,
});

const decision = (
  result: ReturnType<typeof decidePayment>,
): PaymentDecision => ({
  ...result,
  id: "d1",
  sequence: 1,
  origin: "automatic",
  action: "automatic",
  reason: null,
  decidedAt: "2026-09-25T10:00:00.000Z",
});

const render = (current: PaymentDecision | null, enabled = true) =>
  renderToStaticMarkup(
    <PaymentMatchView
      enabled={enabled}
      processed
      current={current}
      history={current ? [current] : []}
      formatDate={(value) => value.slice(0, 10)}
      formatAmount={(amount, currency) => `${amount} ${currency}`}
    />,
  );

describe("PaymentMatchView", () => {
  test("a referenced payment shows as paid with its transaction and evidence", () => {
    const html = render(
      decision(
        decidePayment({
          invoice,
          transactions: [transaction("t1", "BACS INV-2026-0042")],
          asOf: "2026-09-25T00:00:00.000Z",
        }),
      ),
    );
    expect(html).toContain("Paid");
    expect(html).toContain("BACS INV-2026-0042");
    expect(html).toContain("Prints the invoice reference INV20260042.");
  });

  test("an ambiguous decision asserts nothing", () => {
    const html = render(
      decision(
        decidePayment({
          invoice,
          transactions: [
            transaction("t1", "ACME SUPPLIES"),
            transaction("t2", "ACME SUPPLIES"),
          ],
          asOf: "2026-09-25T00:00:00.000Z",
        }),
      ),
    );
    expect(html).toContain("Unpaid");
    expect(html).toContain("Ambiguous: choose the payment");
    expect(html).not.toContain("Counted");
  });

  test("a workspace without bank payments says so", () => {
    expect(render(null, false)).toContain("Bank payments are off");
  });
});
