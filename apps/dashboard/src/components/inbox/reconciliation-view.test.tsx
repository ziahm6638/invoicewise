import { describe, expect, test } from "bun:test";
import {
  type PriorConsumption,
  type ReconciliationResult,
  type ReconciliationTerms,
  reconcileInvoice,
  sourceBalance,
} from "@invoicewise/documents";
import { renderToStaticMarkup } from "react-dom/server";
import {
  type InvoiceReconciliation,
  type LiveSourceBalance,
  type PresentedReconciliation,
  ReconciliationView,
  balanceRows,
  isNegativeDecimal,
  isPositiveDecimal,
  lineOutcome,
  liveBalanceLine,
  reconciliationStatus,
} from "./reconciliation-view";

const PO = "source-po";

const terms: ReconciliationTerms = {
  versionId: "v1",
  version: 1,
  status: "open",
  title: "Oak boards",
  scope: "Supply of oak boards for the Hatfield site",
  currency: "GBP",
  taxBasis: "exclusive",
  startsOn: "2026-09-01",
  endsOn: "2026-12-31",
  authorizedTotal: "2000.00",
  lines: [
    {
      reference: "1",
      description: "Oak boards",
      quantity: "100",
      unitPrice: "20.00",
      amount: "2000.00",
    },
  ],
};

const reconcile = (prior: PriorConsumption) =>
  reconcileInvoice({
    extraction: {
      documentType: "invoice",
      invoiceNumber: "INV-1",
      invoiceDate: "2026-09-20",
      currency: "GBP",
      netAmount: 1000,
      vatAmount: 200,
      grossAmount: 1200,
      amountsIncludeTax: false,
      lineItems: [
        {
          description: "Oak boards",
          quantity: 50,
          unitPrice: 20,
          discountAmount: null,
          discountRate: null,
          taxRate: null,
          taxAmount: null,
          total: 1000,
        },
      ],
    },
    validation: {
      documentType: "invoice",
      taxBasis: "exclusive",
      currency: "GBP",
      totals: {
        net: { amount: 1000, currency: "GBP" },
        tax: { amount: 200, currency: "GBP" },
        gross: { amount: 1200, currency: "GBP" },
      },
      identity: { duplicateOf: null },
    },
    match: {
      id: "match-1",
      status: "matched",
      needsConfirmation: false,
      invoiceDate: { value: "2026-09-20", basis: "invoice_date" },
      links: [
        {
          sourceId: PO,
          versionId: "v1",
          version: 1,
          type: "purchase_order",
          reference: "PO-55120",
          title: "Oak boards",
        },
      ],
      allocations: [
        {
          sourceId: PO,
          versionId: "v1",
          sourceLineReference: "1",
          invoiceLineIndex: 0,
          amount: "1000.00",
          currency: "GBP",
          basis: "invoice_line",
        },
      ],
      unallocatedLines: [],
    },
    sources: [
      {
        sourceId: PO,
        type: "purchase_order",
        reference: "PO-55120",
        cited: terms,
        current: terms,
        prior,
      },
    ],
    scope: {},
  });

const present = (
  result: ReconciliationResult,
  extra: Partial<PresentedReconciliation> = {},
): PresentedReconciliation => ({
  ...result,
  id: "rec-1",
  sequence: 1,
  processingRevision: 1,
  rulesVersion: 1,
  reconciledAt: "2026-09-21T10:00:00.000Z",
  ...extra,
});

const nothingBefore: PriorConsumption = {
  amount: "0.00",
  invoices: 0,
  uncounted: 0,
  lines: [],
};
const mostlyUsed: PriorConsumption = {
  amount: "1600.00",
  invoices: 2,
  uncounted: 0,
  lines: [{ reference: "1", amount: "1600.00", quantity: "80" }],
};

const live = (committed: string, quantity: string): LiveSourceBalance => {
  const { perInvoice, ...totals } = sourceBalance({
    terms,
    rows: [
      {
        inboxId: "earlier",
        sourceLineReference: "1",
        amount: committed,
        quantity,
        currency: "GBP",
        basis: "net",
      },
    ],
  });
  return {
    ...totals,
    sourceId: PO,
    type: "purchase_order",
    reference: "PO-55120",
    counted: perInvoice[0] ?? null,
  };
};

describe("reconciliation view helpers", () => {
  test("labels every status, and an absent one as not reconciled", () => {
    expect(reconciliationStatus("reconciled")).toEqual({
      label: "Within authorization",
      tone: "good",
    });
    expect(reconciliationStatus("discrepancy").tone).toBe("warn");
    expect(reconciliationStatus("unresolved").label).toBe("Not confirmed");
    expect(reconciliationStatus("unmatched").label).toBe("No source");
    expect(reconciliationStatus(null).label).toBe("Not reconciled");
  });

  test("reads signs from decimal strings without parsing them", () => {
    expect(isNegativeDecimal("-0.01")).toBe(true);
    expect(isNegativeDecimal("-0.00")).toBe(false);
    expect(isNegativeDecimal("12.00")).toBe(false);
    expect(isPositiveDecimal("0.00")).toBe(false);
    expect(isPositiveDecimal("400.00")).toBe(true);
    expect(isPositiveDecimal(null)).toBe(false);
  });

  test("a recorded balance names what this invoice adds and flags going over", () => {
    const over = reconcile(mostlyUsed);
    const rows = balanceRows(
      over.sources[0]!.balance!,
      (amount, currency) => `${currency} ${amount}`,
      "GBP",
    );
    expect(rows.map((row) => [row.label, row.value])).toEqual([
      ["Authorized", "GBP 2000.00"],
      ["Committed before", "GBP 1600.00"],
      ["This invoice", "GBP 1000.00"],
      ["Remaining", "GBP -600.00"],
    ]);
    expect(rows[1]!.detail).toBe("2 invoices");
    expect(rows[3]).toMatchObject({
      negative: true,
      detail: "over authorized",
    });
    const uncounted = balanceRows(
      { ...over.sources[0]!.balance!, counted: false },
      (amount) => amount,
      "GBP",
    );
    expect(uncounted[2]!.detail).toBe("not counted");
  });

  test("the live balance says how much is left now, or how far over it is", () => {
    const money = (amount: string, currency: string | null) =>
      `${currency} ${amount}`;
    expect(liveBalanceLine(live("1000.00", "50"), money)).toBe(
      "Now (version 1): GBP 1000.00 committed of GBP 2000.00 across 1 invoice · GBP 1000.00 remaining. This invoice counts GBP 1000.00.",
    );
    expect(
      liveBalanceLine({ ...live("2600.00", "130"), counted: null }, money),
    ).toContain("GBP 600.00 over");
    expect(
      liveBalanceLine(
        {
          ...live("1000.00", "50"),
          counted: {
            inboxId: "earlier",
            amount: null,
            counted: false,
            reason: "It is in EUR, not GBP.",
          },
        },
        money,
      ),
    ).toContain("This invoice is not counted: It is in EUR, not GBP.");
  });

  test("a line's verdict puts going over first", () => {
    expect(lineOutcome(reconcile(nothingBefore).sources[0]!.lines[0]!)).toEqual(
      { label: "Within", tone: "good" },
    );
    // Half the order on its own is within the line's terms; with 80 of 100
    // already invoiced, the line's findings put it over its balance.
    const over = reconcile(mostlyUsed);
    expect(lineOutcome(over.sources[0]!.lines[0]!).label).toBe("Within");
    expect(lineOutcome(over.sources[0]!.lines[0]!, over.discrepancies)).toEqual(
      { label: "Over balance", tone: "warn" },
    );
  });
});

describe("reconciliation view", () => {
  test("a discrepancy shows the finding with its evidence, the balances and the line table", () => {
    const result = reconcile(mostlyUsed);
    expect(result.status).toBe("discrepancy");
    const reconciliation: InvoiceReconciliation = {
      current: present(result, { id: "rec-2", sequence: 2 }),
      history: [
        present(result, { id: "rec-2", sequence: 2 }),
        present(reconcile(nothingBefore)),
      ],
      reconciling: false,
      balances: [live("2600.00", "130")],
    };
    const html = renderToStaticMarkup(
      <ReconciliationView reconciliation={reconciliation} />,
    );
    expect(html).toContain("Reconciliation");
    expect(html).toContain("Discrepancy");
    expect(html).toContain("Discrepancies");
    expect(html).toContain(result.discrepancies[0]!.message);
    expect(html).toContain("Invoice: ");
    expect(html).toContain("Source: ");
    expect(html).toContain("Purchase order PO-55120");
    expect(html).toContain('href="/authorizations/source-po"');
    expect(html).toContain("Committed before");
    expect(html).toContain("-600.00 GBP");
    expect(html).toContain("600.00 GBP over");
    expect(html).toContain("1. Oak boards");
    expect(html).toContain("Over balance");
    expect(html).toContain("Remaining after: qty -30, -600.00 GBP");
    expect(html).toContain("Tolerances:");
    expect(html).toContain("Earlier reconciliations (1)");
    expect(html).toContain("Within authorization");
    expect(html).not.toContain("Reconciling");
  });

  test("while a newer decision is reconciled it says so, before and after the first result", () => {
    const first = renderToStaticMarkup(
      <ReconciliationView
        reconciliation={{
          current: null,
          history: [],
          reconciling: true,
          balances: [],
        }}
      />,
    );
    expect(first).toContain("Reconciling the latest match");
    expect(first).not.toContain("Not reconciled yet");
    const later = renderToStaticMarkup(
      <ReconciliationView
        reconciliation={{
          current: present(reconcile(nothingBefore)),
          history: [present(reconcile(nothingBefore))],
          reconciling: true,
          balances: [],
        }}
      />,
    );
    expect(later).toContain("The result below is the previous one.");
    expect(later).toContain("Within authorization");
  });

  test("before any reconciliation it says when one is made", () => {
    expect(
      renderToStaticMarkup(<ReconciliationView reconciliation={null} />),
    ).toContain("Not reconciled yet");
  });
});
