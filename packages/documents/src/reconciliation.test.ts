import { describe, expect, test } from "bun:test";
import type { AuthorizationLine } from "./authorization-source";
import {
  type PriorConsumption,
  type ReconcileInput,
  type ReconciliationMatch,
  type ReconciliationTerms,
  formatSignedDecimal,
  parseSignedDecimal,
  reconcileInvoice,
  reconciliationFingerprint,
  scopeKey,
  scopeQuestionsFor,
} from "./reconciliation";
import type { SourceAllocation } from "./source-matching";

const PO = "source-po";

const line = (
  reference: string,
  description: string,
  quantity: string | null,
  unitPrice: string | null,
  amount: string,
): AuthorizationLine => ({
  reference,
  description,
  quantity,
  unitPrice,
  amount,
});

const terms = (
  overrides: Partial<ReconciliationTerms> = {},
): ReconciliationTerms => ({
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
  lines: [line("1", "Oak boards", "100", "20.00", "2000.00")],
  ...overrides,
});

const nothingBefore: PriorConsumption = {
  amount: "0.00",
  invoices: 0,
  uncounted: 0,
  lines: [],
};

const invoiceLine = (
  description: string,
  quantity: number | null,
  unitPrice: number | null,
  total: number,
  taxAmount: number | null = null,
) => ({
  description,
  quantity,
  unitPrice,
  discountAmount: null,
  discountRate: null,
  taxRate: null,
  taxAmount,
  total,
});

const extraction = (overrides: Record<string, unknown> = {}) => ({
  documentType: "invoice",
  invoiceNumber: "INV-1",
  invoiceDate: "2026-09-20",
  currency: "GBP",
  netAmount: 1000,
  vatAmount: 200,
  grossAmount: 1200,
  amountsIncludeTax: false,
  lineItems: [invoiceLine("Oak boards", 50, 20, 1000)],
  ...overrides,
});

const validation = (overrides: Record<string, unknown> = {}) => ({
  documentType: "invoice",
  taxBasis: "exclusive",
  currency: "GBP",
  totals: {
    net: { amount: 1000, currency: "GBP" },
    tax: { amount: 200, currency: "GBP" },
    gross: { amount: 1200, currency: "GBP" },
  },
  identity: { duplicateOf: null },
  ...overrides,
});

const allocation = (
  overrides: Partial<SourceAllocation> = {},
): SourceAllocation => ({
  sourceId: PO,
  versionId: "v1",
  sourceLineReference: "1",
  invoiceLineIndex: 0,
  amount: "1000.00",
  currency: "GBP",
  basis: "invoice_line",
  ...overrides,
});

const match = (
  overrides: Partial<ReconciliationMatch> = {},
): ReconciliationMatch => ({
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
  allocations: [allocation()],
  unallocatedLines: [],
  ...overrides,
});

const reconcile = (
  overrides: Partial<ReconcileInput> & {
    cited?: Partial<ReconciliationTerms>;
    current?: Partial<ReconciliationTerms>;
    prior?: PriorConsumption;
  } = {},
) =>
  reconcileInvoice({
    extraction: overrides.extraction ?? extraction(),
    validation: overrides.validation ?? validation(),
    match: overrides.match ?? match(),
    sources: overrides.sources ?? [
      {
        sourceId: PO,
        type: "purchase_order",
        reference: "PO-55120",
        cited: terms(overrides.cited),
        current: terms({ ...overrides.cited, ...overrides.current }),
        prior: overrides.prior ?? nothingBefore,
      },
    ],
    scope: overrides.scope ?? {},
  });

const codes = (items: readonly { code: string }[]) =>
  items.map((item) => item.code);

describe("decimal arithmetic", () => {
  test("parses and formats exact signed decimals without rounding", () => {
    expect(parseSignedDecimal("1250.5", 2)).toBe(125050n);
    expect(parseSignedDecimal("-0.01", 2)).toBe(-1n);
    expect(parseSignedDecimal("18.5000", 2)).toBe(1850n);
    expect(parseSignedDecimal("18.505", 2)).toBeNull();
    expect(parseSignedDecimal("abc", 2)).toBeNull();
    expect(formatSignedDecimal(-125050n, 2)).toBe("-1250.50");
    expect(formatSignedDecimal(5n, 2)).toBe("0.05");
  });

  test("float amounts that do not add up in binary still reconcile exactly", () => {
    // 0.1 + 0.2 in floating point is 0.30000000000000004.
    const result = reconcile({
      extraction: extraction({
        netAmount: 0.3,
        vatAmount: 0,
        grossAmount: 0.3,
        lineItems: [
          invoiceLine("Oak boards", 1, 0.1, 0.1),
          invoiceLine("Oak boards", 2, 0.1, 0.2),
        ],
      }),
      validation: validation({
        taxBasis: "no_tax",
        totals: {
          net: { amount: 0.3 },
          tax: { amount: 0 },
          gross: { amount: 0.3 },
        },
      }),
      match: match({
        allocations: [
          allocation({ invoiceLineIndex: 0, amount: "0.10" }),
          allocation({ invoiceLineIndex: 1, amount: "0.20" }),
        ],
      }),
      cited: {
        authorizedTotal: "0.30",
        lines: [line("1", "Oak boards", "3", "0.10", "0.30")],
      },
    });
    expect(result.status).toBe("reconciled");
    expect(result.sources[0]!.total.variance).toBe("0.00");
    expect(result.sources[0]!.balance!.remaining).toBe("0.00");
    expect(result.sources[0]!.lineBalances[0]!.remainingQuantity).toBe("0");
  });
});

describe("partial and cumulative invoicing", () => {
  test("the first half of a purchase order is within it and leaves the rest", () => {
    const result = reconcile();
    expect(result.status).toBe("reconciled");
    expect(result.consumes).toBe(true);
    const [source] = result.sources;
    expect(source!.basis).toBe("net");
    expect(source!.lines[0]!.quantity).toMatchObject({
      invoiced: "50",
      authorized: "100",
      variance: "-50",
      outcome: "below",
    });
    expect(source!.lines[0]!.rate.outcome).toBe("within");
    expect(source!.balance).toMatchObject({
      authorized: "2000.00",
      committedBefore: "0.00",
      invoiced: "1000.00",
      committedAfter: "1000.00",
      remaining: "1000.00",
      counted: true,
    });
    expect(source!.consumption).toEqual([
      {
        sourceLineReference: "1",
        amount: "1000.00",
        quantity: "50",
        currency: "GBP",
        basis: "net",
      },
    ]);
  });

  test("the second half uses up the balance exactly", () => {
    const result = reconcile({
      prior: {
        amount: "1000.00",
        invoices: 1,
        uncounted: 0,
        lines: [{ reference: "1", amount: "1000.00", quantity: "50" }],
      },
    });
    expect(result.status).toBe("reconciled");
    expect(result.sources[0]!.balance).toMatchObject({
      committedBefore: "1000.00",
      committedAfter: "2000.00",
      remaining: "0.00",
      invoices: 1,
    });
    expect(result.sources[0]!.lineBalances[0]).toMatchObject({
      remainingQuantity: "0",
      remainingAmount: "0.00",
    });
  });

  test("a third invoice past the remainder is overbilling, by amount and by quantity", () => {
    const result = reconcile({
      extraction: extraction({
        netAmount: 300,
        vatAmount: 60,
        grossAmount: 360,
        lineItems: [invoiceLine("Oak boards", 15, 20, 300)],
      }),
      validation: validation({
        totals: {
          net: { amount: 300 },
          tax: { amount: 60 },
          gross: { amount: 360 },
        },
      }),
      match: match({ allocations: [allocation({ amount: "300.00" })] }),
      prior: {
        amount: "1900.00",
        invoices: 2,
        uncounted: 0,
        lines: [{ reference: "1", amount: "1900.00", quantity: "95" }],
      },
    });
    expect(result.status).toBe("discrepancy");
    expect(codes(result.discrepancies)).toEqual([
      "over_authorized_total",
      "line_amount_over_authorized",
      "quantity_over_authorized",
    ]);
    expect(result.discrepancies[0]!.message).toContain("GBP 200.00 over");
    expect(result.discrepancies[0]!.evidence).toEqual({
      invoice: { amount: "300.00" },
      source: {
        authorized: "2000.00",
        committedBefore: "1900.00",
        remainingBefore: "100.00",
        version: 1,
      },
    });
    expect(result.sources[0]!.balance!.remaining).toBe("-200.00");
  });

  test("one penny of rounding per allocation is tolerated, two are not", () => {
    const at = (amount: number) =>
      reconcile({
        extraction: extraction({
          lineItems: [invoiceLine("Oak boards", 100, 20, amount)],
        }),
        match: match({
          allocations: [allocation({ amount: amount.toFixed(2) })],
        }),
      });
    expect(at(2000.01).status).toBe("reconciled");
    expect(codes(at(2000.02).discrepancies)).toContain("over_authorized_total");
  });

  test("a unit rate above the authorized price is a discrepancy, within half a penny is not", () => {
    const at = (unitPrice: number, cited = "20.00") =>
      reconcile({
        extraction: extraction({
          lineItems: [invoiceLine("Oak boards", 10, unitPrice, 10 * unitPrice)],
        }),
        match: match({
          allocations: [allocation({ amount: (10 * unitPrice).toFixed(2) })],
        }),
        cited: { lines: [line("1", "Oak boards", "100", cited, "2000.00")] },
      });
    expect(at(20.5).discrepancies[0]).toMatchObject({
      code: "rate_above_authorized",
      invoiceLineIndex: 0,
      sourceLineReference: "1",
      evidence: {
        invoice: { description: "Oak boards", unitPrice: "20.5" },
        source: { description: "Oak boards", unitPrice: "20" },
      },
    });
    // A four-decimal authorized price printed rounded to pennies.
    expect(at(18.51, "18.505").status).toBe("reconciled");
    expect(at(18.52, "18.505").status).toBe("discrepancy");
    // Charging less is recorded, not flagged.
    const lower = at(19);
    expect(lower.status).toBe("reconciled");
    expect(lower.sources[0]!.lines[0]!.rate.outcome).toBe("below");
  });
});

describe("credits, reversals and amendments", () => {
  test("a credit note reduces what was invoiced", () => {
    const result = reconcile({
      extraction: extraction({
        documentType: "credit_note",
        netAmount: 200,
        vatAmount: 40,
        grossAmount: 240,
        lineItems: [invoiceLine("Oak boards", 10, 20, 200)],
      }),
      validation: validation({
        documentType: "credit_note",
        totals: {
          net: { amount: -200 },
          tax: { amount: -40 },
          gross: { amount: -240 },
        },
      }),
      match: match({ allocations: [allocation({ amount: "-200.00" })] }),
      prior: {
        amount: "2300.00",
        invoices: 3,
        uncounted: 0,
        lines: [{ reference: "1", amount: "2300.00", quantity: "115" }],
      },
    });
    // Still over the total afterwards, but the credit itself is no discrepancy.
    expect(result.status).toBe("reconciled");
    expect(result.sources[0]!.balance).toMatchObject({
      invoiced: "-200.00",
      committedAfter: "2100.00",
      remaining: "-100.00",
    });
    expect(result.sources[0]!.consumption[0]).toMatchObject({
      amount: "-200.00",
      quantity: "-10",
    });
  });

  test("a credit larger than everything invoiced is flagged", () => {
    const result = reconcile({
      extraction: extraction({ documentType: "credit_note", lineItems: [] }),
      validation: validation({
        documentType: "credit_note",
        totals: {
          net: { amount: -1000 },
          tax: { amount: -200 },
          gross: { amount: -1200 },
        },
      }),
      match: match({
        allocations: [
          allocation({
            sourceLineReference: null,
            invoiceLineIndex: null,
            amount: "-1000.00",
            basis: "invoice_net",
          }),
        ],
      }),
      prior: { amount: "400.00", invoices: 1, uncounted: 0, lines: [] },
    });
    expect(codes(result.discrepancies)).toEqual(["credit_exceeds_invoiced"]);
  });

  test("an amendment's new total sets the balance; the cited version sets the comparison", () => {
    const result = reconcile({
      prior: { amount: "1900.00", invoices: 2, uncounted: 0, lines: [] },
      current: {
        versionId: "v2",
        version: 2,
        authorizedTotal: "3000.00",
        lines: [line("1", "Oak boards", "150", "20.00", "3000.00")],
      },
    });
    expect(result.status).toBe("reconciled");
    const [source] = result.sources;
    expect(source!.citedVersion).toBe(1);
    expect(source!.currentVersion).toBe(2);
    expect(source!.total).toMatchObject({
      authorized: "2000.00",
      invoiced: "1000.00",
    });
    expect(source!.balance).toMatchObject({
      authorized: "3000.00",
      committedAfter: "2900.00",
      remaining: "100.00",
    });
  });

  test("billing a source cancelled since the invoice date is a discrepancy", () => {
    const result = reconcile({
      current: { versionId: "v3", version: 3, status: "cancelled" },
    });
    expect(codes(result.discrepancies)).toEqual(["source_cancelled"]);
    expect(result.discrepancies[0]!.message).toContain("cancelled (version 3)");
  });

  test("an amendment that removes a billed line flags it", () => {
    const result = reconcile({
      current: {
        versionId: "v2",
        version: 2,
        lines: [line("2", "Walnut boards", "10", "40.00", "400.00")],
        authorizedTotal: "2400.00",
      },
    });
    expect(codes(result.discrepancies)).toEqual(["line_not_authorized"]);
  });
});

describe("what is not counted or not compared", () => {
  test("an unconfirmed proposal is compared but not counted", () => {
    const result = reconcile({ match: match({ needsConfirmation: true }) });
    expect(result.status).toBe("unresolved");
    expect(result.consumes).toBe(false);
    expect(codes(result.unresolved)).toEqual(["match_needs_confirmation"]);
    expect(result.sources[0]!.balance).toMatchObject({
      invoiced: "1000.00",
      committedAfter: "0.00",
      counted: false,
    });
  });

  test("a duplicate is not counted a second time and is never overbilling", () => {
    const result = reconcile({
      validation: validation({ identity: { duplicateOf: "inbox-original" } }),
      prior: {
        amount: "2000.00",
        invoices: 1,
        uncounted: 0,
        lines: [{ reference: "1", amount: "2000.00", quantity: "100" }],
      },
    });
    expect(result.discrepancies).toEqual([]);
    expect(codes(result.unresolved)).toEqual(["duplicate_invoice"]);
    expect(result.sources[0]!.balance).toMatchObject({
      committedAfter: "2000.00",
      remaining: "0.00",
      counted: false,
    });
  });

  test("unlike currencies are never compared", () => {
    const result = reconcile({ cited: { currency: "EUR" } });
    expect(result.status).toBe("unresolved");
    expect(result.unresolved[0]).toMatchObject({
      code: "currency_mismatch",
      evidence: { invoice: { currency: "GBP" }, source: { currency: "EUR" } },
    });
    expect(result.sources[0]!.balance).toBeNull();
    expect(result.sources[0]!.consumption[0]!.amount).toBeNull();
  });

  test("a source without a currency is not assumed to be in the invoice's", () => {
    const result = reconcile({ cited: { currency: null } });
    expect(codes(result.unresolved)).toEqual(["currency_missing"]);
  });

  test("an unknown tax basis leaves a taxed invoice unresolved", () => {
    const result = reconcile({ cited: { taxBasis: null } });
    expect(codes(result.unresolved)).toEqual(["tax_basis_unknown"]);
    // With no tax on the invoice, net and gross are the same.
    const untaxed = reconcile({
      cited: { taxBasis: null },
      extraction: extraction({ vatAmount: 0, grossAmount: 1000 }),
      validation: validation({
        taxBasis: "no_tax",
        totals: {
          net: { amount: 1000 },
          tax: { amount: 0 },
          gross: { amount: 1000 },
        },
      }),
    });
    expect(untaxed.status).toBe("reconciled");
  });

  test("an inclusive source compares gross amounts, adding the line's tax", () => {
    const result = reconcile({
      extraction: extraction({
        lineItems: [invoiceLine("Oak boards", 50, 20, 1000, 200)],
      }),
      cited: {
        taxBasis: "inclusive",
        authorizedTotal: "2400.00",
        lines: [line("1", "Oak boards", "100", "24.00", "2400.00")],
      },
    });
    const [source] = result.sources;
    expect(source!.basis).toBe("gross");
    expect(source!.balance).toMatchObject({
      invoiced: "1200.00",
      remaining: "1200.00",
    });
    // Unit prices printed net are not compared with gross ones.
    expect(source!.lines[0]!.rate.outcome).toBe("not_compared");
    expect(result.status).toBe("reconciled");
  });

  test("a line without its tax cannot be moved to a gross basis", () => {
    const result = reconcile({
      extraction: extraction({ taxRate: null }),
      cited: { taxBasis: "inclusive", authorizedTotal: "2400.00" },
    });
    expect(codes(result.unresolved)).toEqual(["amount_missing"]);
    expect(result.sources[0]!.balance!.remaining).toBeNull();
  });

  test("tax charged against a source that authorizes none", () => {
    const result = reconcile({
      extraction: extraction({
        lineItems: [invoiceLine("Oak boards", 50, 20, 1000, 200)],
      }),
      cited: { taxBasis: "not_applicable" },
    });
    expect(result.discrepancies[0]).toMatchObject({
      code: "tax_not_authorized",
      evidence: { invoice: { tax: "200.00" } },
    });
  });

  test("an invoice dated outside the authorized period", () => {
    const result = reconcile({ cited: { endsOn: "2026-09-10" } });
    expect(codes(result.discrepancies)).toEqual(["outside_period"]);
  });

  test("unallocated lines of a split leave it unresolved", () => {
    const result = reconcile({ match: match({ unallocatedLines: [1] }) });
    expect(codes(result.unresolved)).toEqual(["allocation_incomplete"]);
  });

  test("ambiguous, weak and missing matches", () => {
    expect(
      reconcile({
        match: match({ status: "ambiguous", links: [], allocations: [] }),
      }).status,
    ).toBe("unresolved");
    const unmatched = reconcile({
      match: match({ status: "unmatched", links: [], allocations: [] }),
    });
    expect(unmatched.status).toBe("unmatched");
    expect(unmatched.consumes).toBe(false);
  });

  test("other invoices that could not be counted make the balance uncertain", () => {
    const result = reconcile({
      prior: { amount: "0.00", invoices: 0, uncounted: 1, lines: [] },
    });
    expect(codes(result.unresolved)).toEqual(["prior_uncounted"]);
  });
});

describe("scope", () => {
  const unpaired = () =>
    match({
      allocations: [
        allocation(),
        allocation({
          sourceLineReference: null,
          invoiceLineIndex: 1,
          amount: "150.00",
        }),
      ],
    });
  const twoLines = extraction({
    netAmount: 1150,
    vatAmount: 230,
    grossAmount: 1380,
    lineItems: [
      invoiceLine("Oak boards", 50, 20, 1000),
      invoiceLine("Delivery to site", 1, 150, 150),
    ],
  });

  test("only lines that pair with no authorized line are asked about", () => {
    const questions = scopeQuestionsFor({
      extraction: twoLines,
      match: unpaired(),
      sources: [{ sourceId: PO, cited: terms() }],
    });
    expect(questions).toEqual([
      {
        key: scopeKey(PO, 1),
        sourceId: PO,
        invoiceLineIndex: 1,
        description: "Delivery to site",
        quantity: 1,
        unitPrice: 150,
        total: 150,
      },
    ]);
  });

  test("a judgment explains a line but never changes an amount", () => {
    const judged = (answer: "within_scope" | "outside_scope" | "unclear") =>
      reconcile({
        extraction: twoLines,
        match: unpaired(),
        scope: {
          [scopeKey(PO, 1)]: {
            status: "answered",
            model: "stub",
            answer,
            probability: 0.9,
          },
        },
      });
    const within = judged("within_scope");
    const outside = judged("outside_scope");
    const unclear = judged("unclear");
    expect(within.status).toBe("reconciled");
    expect(within.sources[0]!.lines[1]!.scope.status).toBe("within_scope");
    expect(codes(outside.discrepancies)).toEqual(["outside_scope"]);
    expect(codes(unclear.unresolved)).toEqual(["scope_unclear"]);
    for (const result of [within, outside, unclear]) {
      expect(result.sources[0]!.balance).toMatchObject({
        invoiced: "1150.00",
        remaining: "850.00",
      });
    }
  });

  test("a judgment short of the threshold explains nothing", () => {
    const result = reconcile({
      extraction: twoLines,
      match: unpaired(),
      scope: {
        [scopeKey(PO, 1)]: {
          status: "answered",
          model: "stub",
          answer: "within_scope",
          probability: 0.6,
        },
      },
    });
    expect(codes(result.unresolved)).toEqual(["scope_unclear"]);
  });
});

test("the same inputs give the same result and fingerprint", () => {
  const first = reconcile();
  const second = reconcile();
  expect(second).toEqual(first);
  expect(reconciliationFingerprint(second)).toBe(
    reconciliationFingerprint(first),
  );
  expect(
    reconciliationFingerprint(
      reconcile({
        prior: { amount: "10.00", invoices: 1, uncounted: 0, lines: [] },
      }),
    ),
  ).not.toBe(reconciliationFingerprint(first));
});
