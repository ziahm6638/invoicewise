import type {
  CheckOutcome,
  InvoiceValidation,
  ValidationCheckId,
} from "@invoicewise/documents";
import { Badge } from "@invoicewise/ui/badge";
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  HelpCircle,
  MinusCircle,
  XCircle,
} from "lucide-react";

const CHECK_LABEL: Record<ValidationCheckId, string> = {
  currency: "Currency",
  line_arithmetic: "Line arithmetic",
  line_totals: "Lines add up",
  tax: "VAT",
  gross: "Net + VAT = gross",
};

const OUTCOME_LABEL: Record<CheckOutcome, string> = {
  pass: "Pass",
  fail: "Fail",
  unknown: "Unverified",
  not_applicable: "Not applicable",
  unsupported: "Not checked",
};

const STATUS_LABEL: Record<InvoiceValidation["status"], string> = {
  valid: "Valid",
  needs_review: "Needs review",
  invalid: "Invalid",
};

const TAX_BASIS_LABEL: Record<InvoiceValidation["taxBasis"], string | null> = {
  exclusive: "Prices exclude VAT",
  inclusive: "Prices include VAT",
  no_tax: "No VAT charged",
  unknown: null,
};

function OutcomeIcon({ outcome }: { outcome: CheckOutcome }) {
  if (outcome === "pass") {
    return (
      <CheckCircle2
        aria-hidden
        className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400"
      />
    );
  }
  if (outcome === "fail") {
    return <XCircle aria-hidden className="size-4 shrink-0 text-destructive" />;
  }
  if (outcome === "unknown") {
    return (
      <HelpCircle
        aria-hidden
        className="size-4 shrink-0 text-amber-600 dark:text-amber-400"
      />
    );
  }
  return (
    <MinusCircle
      aria-hidden
      className="size-4 shrink-0 text-muted-foreground"
    />
  );
}

/**
 * The deterministic checks InvoiceWise ran on the extracted values and
 * whether the invoice may be posted to the accounting system, with every
 * reason it may not.
 */
export function ValidationResults({
  validation,
}: {
  validation?: Record<string, unknown> | null;
}) {
  if (!validation || !Array.isArray(validation.checks)) {
    return (
      <p className="py-5 text-sm text-muted-foreground">
        This invoice was processed before validation existed. Retry it to run
        the checks.
      </p>
    );
  }
  const result = validation as InvoiceValidation;
  const warnings = result.issues.filter(
    (issue) => issue.severity === "warning",
  );
  const basis = TAX_BASIS_LABEL[result.taxBasis];

  return (
    <div>
      <div
        className={
          result.accounting.ready
            ? "mt-3 border border-emerald-600/30 bg-emerald-600/5 px-4 py-3"
            : "mt-3 border border-destructive/30 bg-destructive/5 px-4 py-3"
        }
      >
        <div className="flex items-center gap-2">
          {result.accounting.ready ? (
            <CheckCircle2
              aria-hidden
              className="size-4 text-emerald-600 dark:text-emerald-400"
            />
          ) : (
            <Ban aria-hidden className="size-4 text-destructive" />
          )}
          <p className="text-sm font-medium">
            {result.accounting.ready
              ? "Ready for accounting"
              : "Not sent to accounting"}
          </p>
        </div>
        {!result.accounting.ready && (
          <ul className="mt-2 list-disc space-y-1 pl-6 text-xs leading-5">
            {result.accounting.blockers.map((blocker) => (
              <li key={`${blocker.code}-${blocker.message}`}>
                {blocker.message}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Badge variant="tag">{STATUS_LABEL[result.status]}</Badge>
        {result.documentType === "credit_note" && (
          <Badge variant="tag">Credit note</Badge>
        )}
        {basis && <Badge variant="tag">{basis}</Badge>}
      </div>

      <div className="mt-2 divide-y border-t">
        {result.checks.map((check) => (
          <div key={check.id} className="flex items-start gap-3 py-3">
            <OutcomeIcon outcome={check.outcome} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-4">
                <p className="text-sm font-medium">{CHECK_LABEL[check.id]}</p>
                <p className="shrink-0 text-xs text-muted-foreground">
                  {OUTCOME_LABEL[check.outcome]}
                </p>
              </div>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {check.message}
              </p>
            </div>
          </div>
        ))}
      </div>

      {warnings.length > 0 && (
        <div className="mt-3">
          <p className="text-xs font-medium">To review</p>
          <ul className="mt-2 space-y-2">
            {warnings.map((issue) => (
              <li
                key={`${issue.code}-${issue.message}`}
                className="flex items-start gap-2 text-xs leading-5 text-muted-foreground"
              >
                <AlertTriangle
                  aria-hidden
                  className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400"
                />
                {issue.message}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Fields TypeSafe selected with low confidence, to mark as uncertain. */
export function uncertainFields(
  validation?: Record<string, unknown> | null,
): Set<string> {
  const issues = Array.isArray(validation?.issues)
    ? (validation.issues as InvoiceValidation["issues"])
    : [];
  return new Set(
    issues
      .filter((issue) => issue.code === "low_confidence" && issue.field)
      .map((issue) => issue.field!),
  );
}
