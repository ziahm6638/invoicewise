import type {
  MaskedBankAccount,
  SupplierChecks,
  SupplierEvidence,
} from "@invoicewise/documents";
import { Badge } from "@invoicewise/ui/badge";
import {
  AlertTriangle,
  CheckCircle2,
  HelpCircle,
  MinusCircle,
} from "lucide-react";
import type { ReactNode } from "react";

export type EvidenceInvoice = {
  id: string;
  status: string | null;
  receivedAt: string;
  documentType: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  currency: string | null;
  grossAmount: number | null;
};

export type Redelivery = {
  id: string;
  fileName: string | null;
  receivedAt: string;
  inboxAccountId: string | null;
  referenceId: string | null;
};

type Tone = "good" | "warn" | "neutral" | "unknown";

const OUTCOME: Record<string, { label: string; tone: Tone }> = {
  known: { label: "Known supplier", tone: "good" },
  first_invoice: { label: "First invoice", tone: "neutral" },
  none: { label: "No duplicate", tone: "good" },
  likely_duplicate: { label: "Likely duplicate", tone: "warn" },
  revision: { label: "Revised invoice", tone: "warn" },
  credit_note: { label: "Credit note", tone: "neutral" },
  consistent: { label: "Unchanged", tone: "good" },
  changed: { label: "Changed", tone: "warn" },
  not_present: { label: "None on invoice", tone: "neutral" },
  insufficient_evidence: { label: "Insufficient evidence", tone: "unknown" },
};

const REASON: Record<SupplierEvidence["reason"], string> = {
  same_number: "Same number, date and total",
  same_number_changed: "Same number, different date or total",
  same_date_and_total: "Same date and total",
  credited_invoice: "Credited invoice",
  first_invoice: "First document from this supplier",
  latest_bank_details: "Most recent bank details",
  same_bank_details: "Earlier use of these bank details",
};

const METHOD: Record<string, string> = {
  vat_number: "Matched by VAT number",
  company_number: "Matched by company number",
  name: "Matched by name",
  manual: "Assigned by an admin",
};

function ToneIcon({ tone }: { tone: Tone }) {
  if (tone === "good") {
    return (
      <CheckCircle2
        aria-hidden
        className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400"
      />
    );
  }
  if (tone === "warn") {
    return (
      <AlertTriangle
        aria-hidden
        className="size-4 shrink-0 text-amber-600 dark:text-amber-400"
      />
    );
  }
  if (tone === "unknown") {
    return (
      <HelpCircle
        aria-hidden
        className="size-4 shrink-0 text-muted-foreground"
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

const money = (amount: number | null, currency: string | null) => {
  if (amount === null) return null;
  if (!currency) return amount.toFixed(2);
  try {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
};

const bank = (account?: MaskedBankAccount | null) =>
  account
    ? `${account.kind === "iban" ? "IBAN" : "Account"} ending ${account.ending}`
    : null;

function EvidenceList({
  evidence,
  invoices,
  onOpen,
  formatDate,
}: {
  evidence: SupplierEvidence[];
  invoices: Map<string, EvidenceInvoice>;
  onOpen?: (id: string) => void;
  formatDate: (value: string) => string;
}) {
  if (evidence.length === 0) return null;
  return (
    <ul className="mt-2 space-y-1.5">
      {evidence.map((item) => {
        const invoice = invoices.get(item.invoiceId);
        const title = invoice
          ? [
              invoice.documentType === "credit_note"
                ? "Credit note"
                : "Invoice",
              invoice.invoiceNumber ?? "without a number",
            ].join(" ")
          : "A document no longer in the workspace";
        const details = invoice
          ? [
              invoice.invoiceDate ? formatDate(invoice.invoiceDate) : null,
              money(invoice.grossAmount, invoice.currency),
              `received ${formatDate(invoice.receivedAt)}`,
              invoice.status === "deleted" ? "deleted" : null,
            ]
              .filter(Boolean)
              .join(" · ")
          : null;
        const content: ReactNode = (
          <>
            <span className="font-medium text-foreground">{title}</span>
            {details && <span> · {details}</span>}
            <span className="block">
              {REASON[item.reason]}
              {bank(item.bankAccount) && ` · ${bank(item.bankAccount)}`}
            </span>
          </>
        );
        return (
          <li
            key={`${item.invoiceId}-${item.reason}`}
            className="text-xs leading-5 text-muted-foreground"
          >
            {onOpen && invoice && invoice.status !== "deleted" ? (
              <button
                type="button"
                className="text-left hover:underline"
                onClick={() => onOpen(item.invoiceId)}
              >
                {content}
              </button>
            ) : (
              content
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The stored supplier-history checks of one invoice with the earlier
 * documents each result cites, so the answer stays explainable later.
 */
export function SupplierChecksView({
  checks,
  evidence = [],
  redeliveries = [],
  onOpenInvoice,
  formatDate = (value) => value.slice(0, 10),
}: {
  checks?: Record<string, unknown> | null;
  evidence?: EvidenceInvoice[];
  redeliveries?: Redelivery[];
  onOpenInvoice?: (id: string) => void;
  formatDate?: (value: string) => string;
}) {
  if (!checks) {
    return (
      <p className="py-4 text-sm text-muted-foreground">
        Supplier checks have not run for this invoice yet. Re-run them to
        compare it with the supplier's history.
      </p>
    );
  }
  const result = checks as SupplierChecks;
  const invoices = new Map(evidence.map((invoice) => [invoice.id, invoice]));
  const rows = [
    { key: "known", title: "Known supplier", check: result.known },
    { key: "duplicate", title: "Duplicate check", check: result.duplicate },
    { key: "bank", title: "Bank details", check: result.bankDetails },
  ];
  const method = result.supplier.method ? METHOD[result.supplier.method] : null;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 py-3">
        <p className="text-sm font-medium">
          {result.supplier.supplierId
            ? (result.supplier.name ?? "Unnamed supplier")
            : "Supplier not identified"}
        </p>
        {method && <Badge variant="tag">{method}</Badge>}
        {result.supplier.status === "new" && (
          <Badge variant="tag">New supplier</Badge>
        )}
      </div>
      {!result.supplier.supplierId && (
        <p className="pb-3 text-xs leading-5 text-muted-foreground">
          {result.supplier.message}
        </p>
      )}
      <div className="divide-y border-t">
        {rows.map(({ key, title, check }) => {
          const outcome = OUTCOME[check.outcome] ?? {
            label: check.outcome,
            tone: "unknown" as const,
          };
          return (
            <div key={key} className="py-3.5">
              <div className="flex items-start justify-between gap-4">
                <div className="flex min-w-0 items-center gap-2">
                  <ToneIcon tone={outcome.tone} />
                  <p className="text-sm font-medium">{title}</p>
                </div>
                <p
                  className={
                    outcome.tone === "warn"
                      ? "shrink-0 text-sm font-semibold text-amber-700 dark:text-amber-300"
                      : outcome.tone === "unknown"
                        ? "shrink-0 text-sm font-medium text-muted-foreground"
                        : "shrink-0 text-sm font-semibold"
                  }
                >
                  {outcome.label}
                </p>
              </div>
              <p className="mt-1.5 max-w-[65ch] text-xs leading-5 text-muted-foreground">
                {check.message}
              </p>
              <EvidenceList
                evidence={check.evidence}
                invoices={invoices}
                onOpen={onOpenInvoice}
                formatDate={formatDate}
              />
            </div>
          );
        })}
        {redeliveries.length > 0 && (
          <div className="py-3.5">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-center gap-2">
                <ToneIcon tone="neutral" />
                <p className="text-sm font-medium">Received again</p>
              </div>
              <p className="shrink-0 text-sm font-semibold">
                {redeliveries.length}{" "}
                {redeliveries.length === 1 ? "time" : "times"}
              </p>
            </div>
            <p className="mt-1.5 max-w-[65ch] text-xs leading-5 text-muted-foreground">
              The identical file arrived again. It was kept as one document and
              was not processed or delivered a second time.
            </p>
            <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
              {redeliveries.map((redelivery) => (
                <li key={redelivery.id}>
                  {formatDate(redelivery.receivedAt)}
                  {redelivery.fileName && ` · ${redelivery.fileName}`}
                  {redelivery.inboxAccountId
                    ? " · connected mailbox"
                    : redelivery.referenceId
                      ? " · email"
                      : " · upload"}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <p className="border-t pt-3 text-xs text-muted-foreground">
        Supplier checks v{result.version}, run {formatDate(result.checkedAt)}{" "}
        against {result.historyIds.length} earlier{" "}
        {result.historyIds.length === 1 ? "document" : "documents"} from this
        supplier.
      </p>
    </div>
  );
}
