import type {
  Comparison,
  LedgerInvoice,
  LineVariance,
  ReconciledSource,
  ReconciliationFinding,
  ReconciliationResult,
  SourceBalance,
} from "@invoicewise/documents";
import { Badge } from "@invoicewise/ui/badge";
import { cn } from "@invoicewise/ui/cn";
import { LoaderCircle } from "lucide-react";
import Link from "next/link";
import { type Tone, ToneIcon } from "./source-match-view";

/** A stored reconciliation as the API presents it: the result plus its identity. */
export type PresentedReconciliation = ReconciliationResult & {
  id: string;
  sequence: number;
  processingRevision: number;
  rulesVersion: number;
  reconciledAt: string | Date;
};

/** A linked source's balance now, with this invoice's entry in its ledger. */
export type LiveSourceBalance = Omit<SourceBalance, "perInvoice"> & {
  sourceId: string;
  type: string;
  reference: string;
  counted: LedgerInvoice | null;
};

export type InvoiceReconciliation = {
  current: PresentedReconciliation | null;
  history: PresentedReconciliation[];
  /** A newer match decision or revision is still being reconciled. */
  reconciling: boolean;
  balances: LiveSourceBalance[];
};

type FormatAmount = (amount: string, currency: string | null) => string;
type FormatDate = (value: string | Date) => string;

const STATUS: Record<string, { label: string; tone: Tone }> = {
  reconciled: { label: "Within authorization", tone: "good" },
  discrepancy: { label: "Discrepancy", tone: "warn" },
  unresolved: { label: "Not confirmed", tone: "unknown" },
  unmatched: { label: "No source", tone: "neutral" },
};

/** How a reconciliation status reads, on the invoice and on its sources. */
export const reconciliationStatus = (status: string | null | undefined) =>
  status
    ? (STATUS[status] ?? { label: status, tone: "unknown" as Tone })
    : { label: "Not reconciled", tone: "neutral" as Tone };

const OUTCOME: Record<Comparison["outcome"], { label: string; tone: Tone }> = {
  within: { label: "Within", tone: "good" },
  above: { label: "Over", tone: "warn" },
  below: { label: "Under", tone: "neutral" },
  not_compared: { label: "Not compared", tone: "unknown" },
};

export const comparisonOutcome = (outcome: Comparison["outcome"]) =>
  OUTCOME[outcome] ?? { label: outcome, tone: "unknown" as Tone };

const TYPE: Record<string, string> = {
  job: "Job",
  purchase_order: "Purchase order",
  contract: "Contract",
};

const BASIS: Record<string, string> = {
  net: "net of tax",
  gross: "including tax",
};

/** Whether a signed decimal string is below zero (no float parsing). */
export const isNegativeDecimal = (value: string | null | undefined) =>
  typeof value === "string" &&
  value.trim().startsWith("-") &&
  /[1-9]/.test(value);

/** Whether a signed decimal string is above zero. */
export const isPositiveDecimal = (value: string | null | undefined) =>
  typeof value === "string" &&
  !value.trim().startsWith("-") &&
  /[1-9]/.test(value);

const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * The balance a reconciliation recorded for one source, as labelled rows:
 * what was authorized, what earlier invoices had committed, what this
 * invoice adds (or that it is not counted) and what remains.
 */
export function balanceRows(
  balance: NonNullable<ReconciledSource["balance"]>,
  formatAmount: FormatAmount,
  currency: string | null,
) {
  const money = (value: string | null) =>
    value === null ? "—" : formatAmount(value, currency);
  return [
    { label: "Authorized", value: money(balance.authorized), detail: null },
    {
      label: "Committed before",
      value: money(balance.committedBefore),
      detail: `${plural(balance.invoices, "invoice")}${
        balance.uncounted > 0 ? `, ${balance.uncounted} not counted` : ""
      }`,
    },
    {
      label: "This invoice",
      value: money(balance.invoiced),
      detail: balance.counted ? null : "not counted",
    },
    {
      label: "Remaining",
      value: money(balance.remaining),
      detail: isNegativeDecimal(balance.remaining) ? "over authorized" : null,
      negative: isNegativeDecimal(balance.remaining),
    },
  ] as {
    label: string;
    value: string;
    detail: string | null;
    negative?: boolean;
  }[];
}

/** One sentence for a source's balance now, beside the recorded one. */
export function liveBalanceLine(
  balance: LiveSourceBalance,
  formatAmount: FormatAmount,
) {
  const money = (value: string) => formatAmount(value, balance.currency);
  const parts = [
    `Now (version ${balance.version}): ${money(balance.committed)} committed of ${money(balance.authorized)} across ${plural(balance.invoices, "invoice")}`,
    isPositiveDecimal(balance.over)
      ? `${money(balance.over)} over`
      : `${money(balance.remaining)} remaining`,
  ];
  if (balance.uncounted > 0) parts.push(`${balance.uncounted} not counted`);
  const self = !balance.counted
    ? "This invoice is not counted against it now."
    : balance.counted.counted
      ? `This invoice counts ${money(balance.counted.amount ?? "0.00")}.`
      : `This invoice is not counted: ${balance.counted.reason ?? "no reason recorded"}`;
  return `${parts.join(" · ")}. ${self}`;
}

/** Findings that a line goes over what is left of its authorized line. */
const CUMULATIVE = new Set([
  "line_amount_over_authorized",
  "quantity_over_authorized",
]);

/** Whether a finding is about this compared line. */
const concerns = (
  finding: Pick<
    ReconciliationFinding<string>,
    "invoiceLineIndex" | "sourceLineReference"
  >,
  line: Pick<LineVariance, "invoiceLineIndex" | "sourceLineReference">,
) =>
  (finding.invoiceLineIndex !== null &&
    finding.invoiceLineIndex === line.invoiceLineIndex) ||
  (finding.sourceLineReference !== null &&
    finding.sourceLineReference === line.sourceLineReference);

/**
 * The line's verdict: going over wins (on its own terms, or cumulatively,
 * which a discrepancy about the line records), then scope, then within.
 * `discrepancies` are the ones about the line's source.
 */
export function lineOutcome(
  line: LineVariance,
  discrepancies: readonly ReconciliationFinding<string>[] = [],
): { label: string; tone: Tone } {
  const comparisons = [line.quantity, line.rate, line.amount, line.tax];
  if (comparisons.some((item) => item.outcome === "above")) {
    return { label: "Over", tone: "warn" };
  }
  if (line.scope.status === "outside_scope") {
    return { label: "Outside scope", tone: "warn" };
  }
  const findings = discrepancies.filter((finding) => concerns(finding, line));
  if (findings.length > 0) {
    return findings.every((finding) => CUMULATIVE.has(finding.code))
      ? { label: "Over balance", tone: "warn" }
      : { label: "Discrepancy", tone: "warn" };
  }
  if (line.scope.status === "unclear") {
    return { label: "Scope unclear", tone: "unknown" };
  }
  if (comparisons.some((item) => item.outcome === "within")) {
    return { label: "Within", tone: "good" };
  }
  return { label: "Not compared", tone: "unknown" };
}

const toneText: Record<Tone, string> = {
  good: "text-emerald-700 dark:text-emerald-300",
  warn: "text-amber-700 dark:text-amber-300",
  neutral: "text-muted-foreground",
  unknown: "text-muted-foreground",
};

/** "invoiced / authorized", or why they were not compared. */
function ComparisonCell({
  comparison,
  format,
}: {
  comparison: Comparison;
  format: (value: string) => string;
}) {
  const value = (item: string | null) => (item === null ? "—" : format(item));
  const outcome = comparisonOutcome(comparison.outcome);
  return (
    <td className="px-1.5 py-1.5 text-right align-top tabular-nums">
      <span className={cn(comparison.outcome === "above" && toneText.warn)}>
        {value(comparison.invoiced)} / {value(comparison.authorized)}
      </span>
      {comparison.outcome === "not_compared" ? (
        comparison.note && (
          <span className="block text-[11px] leading-4 text-muted-foreground">
            {comparison.note}
          </span>
        )
      ) : comparison.outcome !== "within" ? (
        <span
          className={cn("block text-[11px] leading-4", toneText[outcome.tone])}
        >
          {outcome.label}
          {comparison.variance !== null
            ? ` by ${format(comparison.variance.replace(/^-/, ""))}`
            : ""}
        </span>
      ) : null}
    </td>
  );
}

const words = (key: string) =>
  key.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();

const evidenceText = (items: Record<string, string | number | null> = {}) =>
  Object.entries(items)
    .map(([key, value]) => `${words(key)} ${value ?? "—"}`)
    .join(", ");

function Findings({
  title,
  tone,
  items,
}: {
  title: string;
  tone: Tone;
  items: ReconciliationFinding<string>[];
}) {
  if (items.length === 0) return null;
  return (
    <div className="mt-3">
      <h5 className="text-xs font-medium">{title}</h5>
      <ul className="mt-1 space-y-1.5">
        {items.map((item, index) => {
          const invoice = evidenceText(item.evidence.invoice);
          const source = evidenceText(item.evidence.source);
          return (
            <li
              key={`${item.code}-${index}`}
              className="flex gap-2 text-xs leading-5"
            >
              <span className="mt-0.5">
                <ToneIcon tone={tone} />
              </span>
              <span>
                {item.message}
                {(invoice || source) && (
                  <span className="block text-muted-foreground">
                    {invoice ? `Invoice: ${invoice}` : ""}
                    {invoice && source ? " · " : ""}
                    {source ? `Source: ${source}` : ""}
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function SourceReconciliation({
  source,
  live,
  discrepancies,
  currency,
  formatAmount,
  invoiceLines,
}: {
  source: ReconciledSource;
  live: LiveSourceBalance | undefined;
  discrepancies: ReconciliationFinding<string>[];
  currency: string | null;
  formatAmount: FormatAmount;
  invoiceLines: (string | null)[];
}) {
  const money = (value: string) => formatAmount(value, currency);
  const plain = (value: string) => value;
  const total = comparisonOutcome(source.total.outcome);
  return (
    <li className="py-3">
      <div className="text-sm">
        <Link
          href={`/authorizations/${source.sourceId}`}
          className="font-medium text-foreground hover:underline"
        >
          {TYPE[source.type] ?? source.type} {source.reference}
        </Link>
        <span className="text-xs text-muted-foreground">
          {" "}
          · compared with version {source.citedVersion}
          {source.currentVersion !== source.citedVersion
            ? ` (now version ${source.currentVersion})`
            : ""}
          {source.currentStatus !== "open" ? ` · ${source.currentStatus}` : ""}
          {source.basis ? ` · amounts ${BASIS[source.basis]}` : ""}
        </span>
      </div>

      {source.balance && (
        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-4">
          {balanceRows(source.balance, formatAmount, currency).map((row) => (
            <div key={row.label}>
              <dt className="text-muted-foreground">{row.label}</dt>
              <dd
                className={cn(
                  "font-medium tabular-nums",
                  row.negative && "text-destructive",
                )}
              >
                {row.value}
                {row.detail && (
                  <span className="block font-normal text-muted-foreground">
                    {row.detail}
                  </span>
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {live && (
        <p
          className={cn(
            "mt-1.5 text-xs text-muted-foreground",
            isPositiveDecimal(live.over) && toneText.warn,
          )}
        >
          {liveBalanceLine(live, formatAmount)}
        </p>
      )}

      {source.lines.length > 0 && (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-muted-foreground">
              <tr className="border-b">
                <th className="py-1 pr-1.5 text-left font-normal">Line</th>
                <th className="px-1.5 py-1 text-right font-normal">Qty</th>
                <th className="px-1.5 py-1 text-right font-normal">Rate</th>
                <th className="px-1.5 py-1 text-right font-normal">Amount</th>
                <th className="py-1 pl-1.5 text-right font-normal">Outcome</th>
              </tr>
            </thead>
            <tbody>
              {source.lines.map((line, index) => {
                const outcome = lineOutcome(line, discrepancies);
                const remaining = source.lineBalances.find(
                  (item) => item.reference === line.sourceLineReference,
                );
                const description =
                  line.description ??
                  (line.invoiceLineIndex === null
                    ? null
                    : invoiceLines[line.invoiceLineIndex]);
                return (
                  <tr
                    key={`${line.invoiceLineIndex}-${line.sourceLineReference}-${index}`}
                    className="border-b last:border-0"
                  >
                    <td className="py-1.5 pr-1.5 align-top">
                      {line.invoiceLineIndex === null
                        ? "Whole invoice"
                        : `${line.invoiceLineIndex + 1}. ${description ?? "Line"}`}
                      {line.sourceLineReference && (
                        <span className="block text-[11px] leading-4 text-muted-foreground">
                          → line {line.sourceLineReference}
                          {line.authorizedDescription
                            ? ` (${line.authorizedDescription})`
                            : ""}
                        </span>
                      )}
                      {remaining && (
                        <span
                          className={cn(
                            "block text-[11px] leading-4 text-muted-foreground",
                            (isNegativeDecimal(remaining.remainingAmount) ||
                              isNegativeDecimal(remaining.remainingQuantity)) &&
                              "text-destructive",
                          )}
                        >
                          Remaining after:{" "}
                          {remaining.remainingQuantity !== null
                            ? `qty ${remaining.remainingQuantity}, `
                            : ""}
                          {remaining.remainingAmount === null
                            ? "—"
                            : money(remaining.remainingAmount)}
                        </span>
                      )}
                      {(line.scope.status === "outside_scope" ||
                        line.scope.status === "unclear") && (
                        <span className="block text-[11px] leading-4 text-muted-foreground">
                          {line.scope.message}
                        </span>
                      )}
                    </td>
                    <ComparisonCell comparison={line.quantity} format={plain} />
                    <ComparisonCell comparison={line.rate} format={plain} />
                    <ComparisonCell comparison={line.amount} format={money} />
                    <td className="py-1.5 pl-1.5 text-right align-top">
                      <span className={toneText[outcome.tone]}>
                        {outcome.label}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-1.5 text-xs text-muted-foreground">
        Total:{" "}
        {source.total.invoiced === null ? "—" : money(source.total.invoiced)}{" "}
        invoiced against{" "}
        {source.total.authorized === null
          ? "—"
          : money(source.total.authorized)}{" "}
        authorized · <span className={toneText[total.tone]}>{total.label}</span>
        {source.total.note ? ` · ${source.total.note}` : ""}
      </p>
    </li>
  );
}

/**
 * The invoice's reconciliation with the authorized terms of the sources it
 * bills: the verdict, every discrepancy and open question with the evidence
 * behind it, each source's balance as recorded and as it stands now, the
 * line variances, and the earlier reconciliations. Read-only.
 */
export function ReconciliationView({
  reconciliation,
  formatDate = (value) =>
    (typeof value === "string" ? value : value.toISOString()).slice(0, 10),
  formatAmount = (amount, currency) =>
    `${amount}${currency ? ` ${currency}` : ""}`,
  invoiceLines = [],
}: {
  reconciliation: InvoiceReconciliation | null | undefined;
  formatDate?: FormatDate;
  formatAmount?: FormatAmount;
  /** Descriptions of the invoice's lines, to name compared lines. */
  invoiceLines?: (string | null)[];
}) {
  const current = reconciliation?.current ?? null;
  const reconciling = reconciliation?.reconciling ?? false;
  const history = reconciliation?.history ?? [];
  const balances = reconciliation?.balances ?? [];

  return (
    <div className="border-t py-3">
      <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Reconciliation
      </h4>
      {reconciling && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-sky-700 dark:text-sky-300">
          <LoaderCircle aria-hidden className="size-3.5 animate-spin" />
          Reconciling the latest match with its sources…
          {current ? " The result below is the previous one." : ""}
        </p>
      )}
      {!current ? (
        !reconciling && (
          <p className="mt-2 text-xs text-muted-foreground">
            Not reconciled yet. The invoice is compared with its sources'
            authorized terms once it is matched.
          </p>
        )
      ) : (
        <ReconciliationBody
          current={current}
          balances={balances}
          formatAmount={formatAmount}
          invoiceLines={invoiceLines}
        />
      )}

      {history.length > 1 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-muted-foreground">
            Earlier reconciliations ({history.length - 1})
          </summary>
          <ul className="mt-1.5 space-y-1 text-xs text-muted-foreground">
            {history.map((item) => (
              <li key={item.id}>
                <span className="font-medium text-foreground">
                  #{item.sequence}
                </span>{" "}
                · {reconciliationStatus(item.status).label} · revision{" "}
                {item.processingRevision} · {formatDate(item.reconciledAt)}
                {item.id === current?.id ? " · current" : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function ReconciliationBody({
  current,
  balances,
  formatAmount,
  invoiceLines,
}: {
  current: PresentedReconciliation;
  balances: LiveSourceBalance[];
  formatAmount: FormatAmount;
  invoiceLines: (string | null)[];
}) {
  const status = reconciliationStatus(current.status);
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 pt-2">
        <ToneIcon tone={status.tone} />
        <p className="text-sm font-semibold">{status.label}</p>
        {!current.consumes && current.status !== "unmatched" && (
          <Badge variant="tag">Not counted against its sources</Badge>
        )}
      </div>
      <p className="max-w-[65ch] pt-1 text-xs leading-5 text-muted-foreground">
        {current.message}
      </p>

      <Findings
        title="Discrepancies"
        tone="warn"
        items={current.discrepancies}
      />
      <Findings
        title="Could not be confirmed"
        tone="unknown"
        items={current.unresolved}
      />

      {current.sources.length > 0 && (
        <ul className="mt-2 divide-y">
          {current.sources.map((source) => (
            <SourceReconciliation
              key={source.sourceId}
              source={source}
              live={balances.find((item) => item.sourceId === source.sourceId)}
              discrepancies={current.discrepancies.filter(
                (finding) => finding.sourceId === source.sourceId,
              )}
              currency={source.currency ?? current.currency}
              formatAmount={formatAmount}
              invoiceLines={invoiceLines}
            />
          ))}
        </ul>
      )}

      <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
        Reconciliation rules v{current.rulesVersion}. Tolerances: amount{" "}
        {current.tolerances.amount}; rate {current.tolerances.rate}; quantity{" "}
        {current.tolerances.quantity}; tax {current.tolerances.tax}.
      </p>
    </>
  );
}
