import type {
  MatchEvidence,
  SourceMatchCandidate,
  SourceMatchResult,
} from "@invoicewise/documents";
import { Badge } from "@invoicewise/ui/badge";
import {
  AlertTriangle,
  CheckCircle2,
  HelpCircle,
  MinusCircle,
} from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

/** A stored decision as the API presents it: the result plus who decided and why. */
export type SourceMatchDecision = SourceMatchResult & {
  id: string;
  sequence: number;
  origin: "automatic" | "manual" | string;
  action: string;
  reason: string | null;
  decidedAt: string;
  actorName?: string | null;
};

const STATUS: Record<string, { label: string; tone: Tone }> = {
  matched: { label: "Matched", tone: "good" },
  proposed: { label: "Proposed", tone: "warn" },
  ambiguous: { label: "Ambiguous", tone: "warn" },
  unmatched: { label: "No source", tone: "neutral" },
  insufficient_evidence: { label: "Insufficient evidence", tone: "unknown" },
};

const METHOD: Record<string, string> = {
  reference: "By printed reference",
  semantic: "Suggested by TypeSafe",
  manual: "Decided by an admin",
};

const ACTION: Record<string, string> = {
  automatic: "Matched automatically",
  confirm: "Confirmed",
  correct: "Linked by an admin",
  unlink: "Unlinked",
};

const REJECTION: Record<string, string> = {
  wrong_supplier: "Another supplier's",
  cancelled: "Cancelled",
  currency_conflict: "Other currency",
};

const TYPE: Record<string, string> = {
  job: "Job",
  purchase_order: "Purchase order",
  contract: "Contract",
};

type Tone = "good" | "warn" | "neutral" | "unknown";

const OUTCOME_TONE: Record<MatchEvidence["outcome"], Tone> = {
  supports: "good",
  conflicts: "warn",
  neutral: "neutral",
  unknown: "unknown",
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
      <HelpCircle
        aria-hidden
        className={`${className} text-muted-foreground`}
      />
    );
  }
  return (
    <MinusCircle aria-hidden className={`${className} text-muted-foreground`} />
  );
}

const percent = (value: number | null) =>
  value === null ? null : `${Math.round(value * 100)}%`;

const statusOf = (decision: SourceMatchDecision) =>
  decision.status === "matched" && decision.needsConfirmation
    ? STATUS.proposed!
    : (STATUS[decision.status] ?? { label: decision.status, tone: "unknown" });

function SourceLink({
  sourceId,
  type,
  reference,
  title,
}: {
  sourceId: string;
  type: string;
  reference: string;
  title: string | null;
}) {
  return (
    <Link
      href={`/authorizations/${sourceId}`}
      className="font-medium text-foreground hover:underline"
    >
      {TYPE[type] ?? type} {reference}
      {title ? ` · ${title}` : ""}
    </Link>
  );
}

function Candidate({
  candidate,
  onChoose,
}: {
  candidate: SourceMatchCandidate;
  onChoose?: (sourceId: string) => void;
}) {
  const label = candidate.rejection
    ? REJECTION[candidate.rejection]
    : percent(candidate.confidence);
  return (
    <li className="py-2.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 text-sm">
          <SourceLink {...candidate} />
          <span className="text-xs text-muted-foreground">
            {" "}
            · version {candidate.version}
            {candidate.versionBasis === "current" ? " (current)" : ""}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {label && (
            <Badge variant="tag" className="text-xs">
              {label}
            </Badge>
          )}
          {onChoose && candidate.eligible && (
            <button
              type="button"
              className="text-xs font-medium underline-offset-2 hover:underline"
              onClick={() => onChoose(candidate.sourceId)}
            >
              Choose
            </button>
          )}
        </div>
      </div>
      <ul className="mt-1.5 space-y-1">
        {candidate.evidence.map((item, index) => (
          <li
            key={`${item.kind}-${index}`}
            className="flex gap-2 text-xs leading-5 text-muted-foreground"
          >
            <span className="mt-0.5">
              <ToneIcon tone={OUTCOME_TONE[item.outcome]} />
            </span>
            <span>{item.message}</span>
          </li>
        ))}
      </ul>
    </li>
  );
}

/**
 * Which authorization sources the invoice bills: the current decision with
 * its linked sources and allocations, every candidate considered with the
 * evidence for and against it, and the earlier decisions.
 */
export function SourceMatchView({
  current,
  history = [],
  processed = true,
  formatDate = (value) => value.slice(0, 10),
  formatAmount = (amount, currency) =>
    `${amount}${currency ? ` ${currency}` : ""}`,
  invoiceLines = [],
  onChoose,
  actions,
}: {
  current: SourceMatchDecision | null;
  history?: SourceMatchDecision[];
  processed?: boolean;
  formatDate?: (value: string) => string;
  formatAmount?: (amount: string, currency: string | null) => string;
  /** Descriptions of the invoice's lines, to name allocated lines. */
  invoiceLines?: (string | null)[];
  onChoose?: (sourceId: string) => void;
  actions?: ReactNode;
}) {
  if (!current) {
    return (
      <p className="py-4 text-sm text-muted-foreground">
        {processed
          ? "Matching to jobs, purchase orders and contracts has not finished yet."
          : "The invoice is matched to authorization sources once it has been processed."}
      </p>
    );
  }
  const status = statusOf(current);
  const linked = new Set(current.links.map((link) => link.sourceId));
  const others = current.candidates.filter(
    (candidate) => !linked.has(candidate.sourceId),
  );
  const choosing =
    current.status === "ambiguous" || current.status === "insufficient_evidence"
      ? onChoose
      : undefined;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 py-3">
        <ToneIcon tone={status.tone} />
        <p className="text-sm font-semibold">{status.label}</p>
        {current.method && (
          <Badge variant="tag">
            {METHOD[current.method] ?? current.method}
          </Badge>
        )}
        {current.confidence !== null && current.method === "semantic" && (
          <Badge variant="tag">{percent(current.confidence)} confidence</Badge>
        )}
      </div>
      <p className="max-w-[65ch] pb-3 text-xs leading-5 text-muted-foreground">
        {current.message}
        {current.reason ? ` Reason: ${current.reason}` : ""}
      </p>

      {current.links.length > 0 && (
        <div className="border-t py-3">
          <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Linked
          </h4>
          <ul className="mt-2 space-y-3">
            {current.links.map((link) => {
              const allocations = current.allocations.filter(
                (allocation) => allocation.sourceId === link.sourceId,
              );
              const candidate = current.candidates.find(
                (item) => item.sourceId === link.sourceId,
              );
              return (
                <li key={link.sourceId} className="text-sm">
                  <SourceLink {...link} />
                  <span className="text-xs text-muted-foreground">
                    {" "}
                    · version {link.version}
                  </span>
                  <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                    {allocations.map((allocation, index) => (
                      <li key={`${allocation.invoiceLineIndex}-${index}`}>
                        {allocation.invoiceLineIndex === null
                          ? "Whole invoice"
                          : `Line ${allocation.invoiceLineIndex + 1}${
                              invoiceLines[allocation.invoiceLineIndex]
                                ? ` (${invoiceLines[allocation.invoiceLineIndex]})`
                                : ""
                            }`}
                        {allocation.sourceLineReference
                          ? ` → authorized line ${allocation.sourceLineReference}`
                          : ""}
                        {allocation.amount !== null
                          ? `: ${formatAmount(allocation.amount, allocation.currency)}`
                          : ""}
                      </li>
                    ))}
                    {allocations.length === 0 && (
                      <li>Not allocated to any invoice line yet.</li>
                    )}
                  </ul>
                  {candidate && (
                    <details className="mt-1">
                      <summary className="cursor-pointer text-xs text-muted-foreground">
                        Evidence
                      </summary>
                      <ul>
                        <Candidate candidate={candidate} />
                      </ul>
                    </details>
                  )}
                </li>
              );
            })}
          </ul>
          {current.allocation.unallocatedLines.length > 0 && (
            <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
              Not allocated to a source:{" "}
              {current.allocation.unallocatedLines
                .map((index) => `line ${index + 1}`)
                .join(", ")}
              .
            </p>
          )}
        </div>
      )}

      {others.length > 0 && (
        <div className="border-t py-3">
          <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {current.links.length > 0 ? "Also considered" : "Candidates"}
          </h4>
          <ul className="divide-y">
            {others.map((candidate) => (
              <Candidate
                key={candidate.sourceId}
                candidate={candidate}
                onChoose={choosing}
              />
            ))}
          </ul>
        </div>
      )}

      {actions}

      {history.length > 1 && (
        <div className="mt-3 border-t pt-3">
          <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Decisions
          </h4>
          <ul className="mt-2 space-y-1.5 text-xs text-muted-foreground">
            {history.map((decision) => (
              <li key={decision.id}>
                <span className="font-medium text-foreground">
                  {ACTION[decision.action] ?? decision.action}
                </span>{" "}
                · {statusOf(decision).label}
                {decision.links.length > 0
                  ? ` · ${decision.links.map((link) => link.reference).join(", ")}`
                  : ""}
                {decision.origin === "manual"
                  ? ` · ${decision.actorName ?? "a former member"}`
                  : ""}
                {" · "}
                {formatDate(decision.decidedAt)}
                {decision.reason ? ` · “${decision.reason}”` : ""}
                {decision.id === current.id ? " · current" : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="border-t pt-3 text-xs text-muted-foreground">
        Matching rules v{current.version}; sources compared as recorded at{" "}
        {formatDate(current.asOf)}, on the{" "}
        {current.invoiceDate.basis === "invoice_date"
          ? "invoice date"
          : "day the invoice was received"}{" "}
        ({current.invoiceDate.value}).
      </p>
    </div>
  );
}
