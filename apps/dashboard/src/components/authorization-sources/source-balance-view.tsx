import type { LedgerInvoice, SourceBalance } from "@invoicewise/documents";
import { cn } from "@invoicewise/ui/cn";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@invoicewise/ui/table";
import Link from "next/link";
import {
  isNegativeDecimal,
  isPositiveDecimal,
} from "../inbox/reconciliation-view";

type FormatAmount = (amount: string, currency: string | null) => string;

export type SourceBalanceData = SourceBalance & {
  sourceId: string;
  type: string;
  reference: string;
  perInvoice: LedgerInvoice[];
};

const BASIS: Record<string, string> = {
  net: "net of tax",
  gross: "including tax",
};

/**
 * The headline figures of a source's balance. Remaining is flagged when
 * invoices have committed more than the terms authorize.
 */
export function balanceFigures(
  balance: Pick<
    SourceBalance,
    | "authorized"
    | "committed"
    | "remaining"
    | "over"
    | "invoices"
    | "uncounted"
    | "currency"
  >,
  formatAmount: FormatAmount,
) {
  const money = (value: string) => formatAmount(value, balance.currency);
  const over = isPositiveDecimal(balance.over);
  return [
    { label: "Authorized", value: money(balance.authorized), alert: false },
    {
      label: "Committed",
      value: money(balance.committed),
      detail: `${balance.invoices} invoice${balance.invoices === 1 ? "" : "s"} counted`,
      alert: false,
    },
    {
      label: "Remaining",
      value: money(balance.remaining),
      detail: over ? `${money(balance.over)} over the authorized total` : null,
      alert: over || isNegativeDecimal(balance.remaining),
    },
  ] as {
    label: string;
    value: string;
    detail?: string | null;
    alert: boolean;
  }[];
}

/**
 * What a source has authorized against what the invoices currently counted
 * against it have committed, overall and per authorized line, and the
 * invoices left out of the balance with why.
 */
export function SourceBalanceView({
  balance,
  formatAmount = (amount, currency) =>
    `${amount}${currency ? ` ${currency}` : ""}`,
  invoiceNames = {},
}: {
  balance: SourceBalanceData;
  formatAmount?: FormatAmount;
  /** Names of the matched invoices, by id, to label uncounted ones. */
  invoiceNames?: Record<string, string>;
}) {
  const money = (value: string) => formatAmount(value, balance.currency);
  const uncounted = balance.perInvoice.filter((invoice) => !invoice.counted);

  return (
    <div className="space-y-3">
      <dl className="grid gap-x-6 gap-y-3 rounded border p-3 text-sm md:grid-cols-3">
        {balanceFigures(balance, formatAmount).map((figure) => (
          <div key={figure.label}>
            <dt className="text-muted-foreground">{figure.label}</dt>
            <dd
              className={cn(
                "font-medium tabular-nums",
                figure.alert && "text-destructive",
              )}
            >
              {figure.value}
            </dd>
            {figure.detail && (
              <dd
                className={cn(
                  "text-xs",
                  figure.alert ? "text-destructive" : "text-muted-foreground",
                )}
              >
                {figure.detail}
              </dd>
            )}
          </div>
        ))}
      </dl>
      <p className="text-xs text-muted-foreground">
        Against version {balance.version} ({balance.status}), the terms in
        effect today; amounts {BASIS[balance.basis] ?? balance.basis}
        {balance.currency ? ` in ${balance.currency}` : ""}.
      </p>

      {uncounted.length > 0 && (
        <div className="rounded border border-amber-500/40 p-3 text-sm">
          <p className="font-medium">
            {uncounted.length} matched invoice
            {uncounted.length === 1 ? " is" : "s are"} not counted
          </p>
          <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
            {uncounted.map((invoice) => (
              <li key={invoice.inboxId}>
                <Link
                  href={`/inbox?inboxId=${invoice.inboxId}`}
                  className="font-medium text-foreground hover:underline"
                >
                  {invoiceNames[invoice.inboxId] ?? "Invoice"}
                </Link>
                : {invoice.reason ?? "No reason recorded."}
              </li>
            ))}
          </ul>
        </div>
      )}

      {balance.lines.length > 0 && (
        <div className="rounded border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[80px]">Ref</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="text-right">Authorized qty</TableHead>
                <TableHead className="text-right">Committed qty</TableHead>
                <TableHead className="text-right">Remaining qty</TableHead>
                <TableHead className="text-right">Authorized</TableHead>
                <TableHead className="text-right">Committed</TableHead>
                <TableHead className="text-right">Remaining</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {balance.lines.map((line) => (
                <TableRow key={line.reference}>
                  <TableCell>{line.reference}</TableCell>
                  <TableCell>{line.description}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {line.authorizedQuantity ?? "—"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {line.committedQuantity ?? "—"}
                  </TableCell>
                  <TableCell
                    className={cn(
                      "text-right tabular-nums",
                      isNegativeDecimal(line.remainingQuantity) &&
                        "text-destructive",
                    )}
                  >
                    {line.remainingQuantity ?? "—"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {money(line.authorizedAmount)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {money(line.committedAmount)}
                  </TableCell>
                  <TableCell
                    className={cn(
                      "text-right tabular-nums",
                      isNegativeDecimal(line.remainingAmount) &&
                        "text-destructive",
                    )}
                  >
                    {money(line.remainingAmount)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
