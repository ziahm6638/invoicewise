import { describe, expect, test } from "bun:test";
import {
  type ReconciliationTerms,
  sourceBalance,
} from "@invoicewise/documents";
import { renderToStaticMarkup } from "react-dom/server";
import {
  type SourceBalanceData,
  SourceBalanceView,
  balanceFigures,
} from "./source-balance-view";

const terms: ReconciliationTerms = {
  versionId: "v2",
  version: 2,
  status: "open",
  title: "Oak boards",
  scope: null,
  currency: "GBP",
  taxBasis: "exclusive",
  startsOn: null,
  endsOn: null,
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

const row = (
  inboxId: string,
  amount: string | null,
  quantity: string,
  currency = "GBP",
) => ({
  inboxId,
  sourceLineReference: "1",
  amount,
  quantity,
  currency,
  basis: "net",
});

const balanceOf = (rows: ReturnType<typeof row>[]): SourceBalanceData => ({
  ...sourceBalance({ terms, rows }),
  sourceId: "po-1",
  type: "purchase_order",
  reference: "PO-55120",
});

const money = (amount: string, currency: string | null) =>
  `${currency} ${amount}`;

describe("source balance", () => {
  test("within its terms, remaining is not flagged", () => {
    const figures = balanceFigures(
      balanceOf([row("a", "1200.00", "60")]),
      money,
    );
    expect(figures.map((figure) => [figure.label, figure.value])).toEqual([
      ["Authorized", "GBP 2000.00"],
      ["Committed", "GBP 1200.00"],
      ["Remaining", "GBP 800.00"],
    ]);
    expect(figures[1]!.detail).toBe("1 invoice counted");
    expect(figures.some((figure) => figure.alert)).toBe(false);
  });

  test("committed beyond the authorized total is highlighted with how far over", () => {
    const over = balanceOf([
      row("a", "1600.00", "80"),
      row("b", "1000.00", "50"),
    ]);
    const [, committed, remaining] = balanceFigures(over, money);
    expect(committed!.detail).toBe("2 invoices counted");
    expect(remaining).toMatchObject({
      value: "GBP -600.00",
      detail: "GBP 600.00 over the authorized total",
      alert: true,
    });
    const html = renderToStaticMarkup(
      <SourceBalanceView balance={over} formatAmount={money} />,
    );
    expect(html).toContain("text-destructive");
    expect(html).toContain("-30");
    expect(html).toContain("GBP -600.00");
    expect(html).toContain("Against version 2 (open)");
  });

  test("invoices left out of the balance are listed with why", () => {
    const html = renderToStaticMarkup(
      <SourceBalanceView
        balance={balanceOf([
          row("a", "1200.00", "60"),
          row("b", "300.00", "15", "EUR"),
        ])}
        formatAmount={money}
        invoiceNames={{ b: "INV-77" }}
      />,
    );
    expect(html).toContain("1 matched invoice is not counted");
    expect(html).toContain('href="/inbox?inboxId=b"');
    expect(html).toContain("INV-77");
    expect(html).toContain("It is in EUR, not GBP.");
  });
});
