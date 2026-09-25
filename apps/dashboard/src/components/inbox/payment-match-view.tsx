import type {
  PaymentCandidate,
  PaymentEvidence,
  PaymentMatchResult,
} from "@invoicewise/jobs/payment-rules";
import { Badge } from "@invoicewise/ui/badge";
import {
  AlertTriangle,
  CheckCircle2,
  HelpCircle,
  MinusCircle,
} from "lucide-react";
import type { ReactNode } from "react";

/** A stored payment decision as the API presents it. */
export type PaymentDecision = PaymentMatchResult & {
  id: string;
  sequence: number;
  origin: string;
  action: string;
  reason: string | null;
  decidedAt: string;
  actorName?: string | null;
};

/** What a member sees: the outcome and amounts, never the bank data. */
export type PaymentSummary = Pick<
  PaymentMatchResult,
  "status" | "paymentStatus" | "needsConfirmation" | "paid" | "remaining"
> & { id: string; currency: string | null; decidedAt: string };

type Tone = "good" | "warn" | "neutral" | "unknown";

const PAYMENT_STATUS: Record<string, { label: string; tone: Tone }> = {
  paid: { label: "Paid", tone: "good" },
  applied: { label: "Credit applied", tone: "good" },
  partially_paid: { label: "Part paid", tone: "warn" },
  overpaid: { label: "Overpaid", tone: "warn" },
  pending: { label: "Payment pending", tone: "unknown" },
  unpaid: { label: "Unpaid", tone: "neutral" },
};

const STATUS: Record<string, string> = {
  matched: "Evidence-backed",
  pending: "Pending at the bank",
  proposed: "Proposed: needs confirmation",
  ambiguous: "Ambiguous: choose the payment",
  unmatched: "No matching transaction",
  insufficient_evidence: "Not enough evidence",
};

const ACTION: Record<string, string> = {
  automatic: "Matched automatically",
  reversal: "Reversal at the bank recorded",
  confirm: "Confirmed",
  correct: "Recorded by an admin",
  unlink: "Marked as not paid by these transactions",
};

const KIND: Record<string, string> = {
  payment: "Payment",
  fee: "Bank charge",
  credit: "Credit note",
};

const OUTCOME_TONE: Record<PaymentEvidence["outcome"], Tone> = {
  supports: "good",
  conflicts: "warn",
  neutral: "neutral",
};

function ToneIcon({ tone }: { tone: Tone }) {
  const className = "size-4 shrink-0";
  if (tone === "good") {
    return (
      <CheckCircle2
        aria-hidden
        className={`${className} text-emerald-600 dark:text-emerald-400`}
      />
    );
  }
  if (tone === "warn") {
    return (
      <AlertTriangle
        aria-hidden
        className={`${className} text-amber-600 dark:text-amber-400`}
      />
    );
  }
  if (tone === "unknown") {
    return (
      <HelpCircle aria-hidden className={`${className} text-muted-foreground`} />
    );
  }
  return (
    <MinusCircle aria-hidden className={`${className} text-muted-foreground`} />
  );
}

function StatusLine({
  paymentStatus,
  status,
  paid,
  remaining,
  currency,
  formatAmount,
}: {
  paymentStatus: string;
  status: string;
  paid: string;
  remaining: string | null;
  currency: string | null;
  formatAmount: (amount: string, currency: string | null) => string;
}) {
  const shown = PAYMENT_STATUS[paymentStatus] ?? {
    label: paymentStatus,
    tone: "unknown" as Tone,
  };
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <ToneIcon tone={shown.tone} />
      <span className="font-medium">{shown.label}</span>
      <Badge variant="tag-rounded" className="text-xs">
        {STATUS[status] ?? status}
      </Badge>
      <span className="text-muted-foreground">
        {formatAmount(paid, currency)} paid
        {remaining !== null && Number(remaining) !== 0
          ? ` · ${formatAmount(remaining, currency)} ${Number(remaining) < 0 ? "over" : "outstanding"}`
          : ""}
      </span>
    </div>
  );
}

function Transaction({
  candidate,
  formatDate,
  formatAmount,
}: {
  candidate: PaymentCandidate;
  formatDate: (value: string) => string;
  formatAmount: (amount: string, currency: string | null) => string;
}) {
  return (
    <li className="py-2">
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="min-w-0 truncate">
          <span className="font-medium">{formatDate(candidate.madeOn)}</span>{" "}
          {candidate.description || "Transaction"}
          {candidate.counterparty ? ` · ${candidate.counterparty}` : ""}
        </span>
        <span className="shrink-0 tabular-nums">
          {formatAmount(candidate.amount, candidate.currency)}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        {candidate.accountName} · {candidate.status}
        {candidate.duplicated ? " · duplicate" : ""}
        {candidate.referenceBacked ? " · prints the invoice reference" : ""}
      </p>
      <ul className="mt-1 space-y-0.5">
        {candidate.evidence.map((item, index) => (
          <li
            // biome-ignore lint/suspicious/noArrayIndexKey: evidence has no id
            key={index}
            className="flex items-start gap-1.5 text-xs text-muted-foreground"
          >
            <ToneIcon tone={OUTCOME_TONE[item.outcome]} />
            <span>{item.message}</span>
          </li>
        ))}
      </ul>
    </li>
  );
}

/**
 * An invoice's bank-payment decision: whether it is paid, what counts
 * (payments, bank charges, applied credits), every transaction considered
 * with its evidence, and the decision history. Kept apart from the
 * authorization-source match.
 */
export function PaymentMatchView({
  enabled,
  processed,
  current,
  summary,
  history,
  formatDate,
  formatAmount,
  actions,
}: {
  enabled: boolean;
  processed: boolean;
  current: PaymentDecision | null;
  /** For members: the outcome only. */
  summary?: PaymentSummary | null;
  history: PaymentDecision[];
  formatDate: (value: string) => string;
  formatAmount: (amount: string, currency: string | null) => string;
  actions?: ReactNode;
}) {
  if (!enabled) {
    return (
      <p className="mt-2 text-sm text-muted-foreground">
        Bank payments are off for this workspace.
      </p>
    );
  }
  if (!processed) {
    return (
      <p className="mt-2 text-sm text-muted-foreground">
        Payments are matched once the invoice is processed.
      </p>
    );
  }
  if (!current && summary) {
    return (
      <div className="mt-2">
        <StatusLine {...summary} formatAmount={formatAmount} />
      </div>
    );
  }
  if (!current) {
    return (
      <div className="mt-2">
        <p className="text-sm text-muted-foreground">
          Not matched to a bank payment yet.
        </p>
        {actions}
      </div>
    );
  }
  const currency = current.invoice.currency;
  const byId = new Map(
    current.candidates.map((candidate) => [candidate.transactionId, candidate]),
  );
  return (
    <div className="mt-2 space-y-3">
      <StatusLine
        paymentStatus={current.paymentStatus}
        status={current.status}
        paid={current.paid}
        remaining={current.remaining}
        currency={currency}
        formatAmount={formatAmount}
      />
      <p className="text-sm">{current.message}</p>

      {current.allocations.length > 0 && (
        <div>
          <h4 className="text-xs font-medium uppercase text-muted-foreground">
            Counted
          </h4>
          <ul className="divide-y">
            {current.allocations.map((allocation, index) => {
              const transaction = allocation.transactionId
                ? byId.get(allocation.transactionId)
                : undefined;
              return (
                <li
                  // biome-ignore lint/suspicious/noArrayIndexKey: allocations have no id
                  key={index}
                  className="flex justify-between gap-3 py-1.5 text-sm"
                >
                  <span className="min-w-0 truncate">
                    {KIND[allocation.kind] ?? allocation.kind}
                    {transaction
                      ? `: ${formatDate(transaction.madeOn)} ${transaction.description}`
                      : ""}
                  </span>
                  <span className="shrink-0 tabular-nums">
                    {formatAmount(allocation.amount, allocation.currency)}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {current.proposed.length > 0 && (
        <p className="text-sm text-amber-700 dark:text-amber-400">
          Proposed:{" "}
          {current.proposed
            .map((item) =>
              formatAmount(item.amount, item.currency) +
              (item.transactionId && byId.get(item.transactionId)
                ? ` from ${byId.get(item.transactionId)!.description}`
                : ""),
            )
            .join("; ")}
          . It does not count as paid until confirmed.
        </p>
      )}

      {current.unallocated.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Left over:{" "}
          {current.unallocated
            .map((item) => formatAmount(item.amount, currency))
            .join(", ")}{" "}
          of counted transactions is not allocated (a bank charge can be
          recorded as one).
        </p>
      )}

      {current.candidates.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm">
            Transactions considered ({current.candidates.length})
          </summary>
          <ul className="divide-y">
            {current.candidates.map((candidate) => (
              <Transaction
                key={candidate.transactionId}
                candidate={candidate}
                formatDate={formatDate}
                formatAmount={formatAmount}
              />
            ))}
          </ul>
        </details>
      )}

      {actions}

      {history.length > 1 && (
        <details>
          <summary className="cursor-pointer text-sm">
            Payment decisions ({history.length})
          </summary>
          <ol className="mt-1 space-y-1">
            {history.map((decision) => (
              <li key={decision.id} className="text-xs text-muted-foreground">
                {formatDate(decision.decidedAt)} ·{" "}
                {ACTION[decision.action] ?? decision.action}
                {decision.actorName ? ` by ${decision.actorName}` : ""} ·{" "}
                {PAYMENT_STATUS[decision.paymentStatus]?.label ??
                  decision.paymentStatus}
                {decision.reason ? ` · "${decision.reason}"` : ""}
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}
