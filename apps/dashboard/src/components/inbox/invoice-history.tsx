"use client";

import { useUserQuery } from "@/hooks/use-user";
import { useTRPC } from "@/trpc/client";
import { formatDate } from "@/utils/format";
import { cn } from "@invoicewise/ui/cn";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";

const PROVIDER_NAME: Record<string, string> = {
  xero: "Xero",
  quickbooks: "QuickBooks",
};

const FIELD_LABEL: Record<string, string> = {
  documentType: "Document type",
  supplierName: "Supplier",
  supplierAddress: "Supplier address",
  supplierVatNumber: "VAT number",
  supplierCompanyNumber: "Company number",
  invoiceNumber: "Invoice number",
  originalInvoiceNumber: "Credits invoice number",
  invoiceDate: "Invoice date",
  dueDate: "Due date",
  currency: "Currency",
  netAmount: "Net",
  discountAmount: "Discount",
  vatAmount: "VAT",
  grossAmount: "Gross",
  taxRate: "VAT rate",
  amountsIncludeTax: "Amounts include VAT",
  description: "Description",
  purchaseOrderReference: "PO reference",
  paymentReference: "Payment reference",
  accountName: "Account name",
  accountNumber: "Account number",
  sortCode: "Sort code",
  iban: "IBAN",
  bic: "BIC",
};

const show = (value: unknown) =>
  value === null || value === undefined || value === ""
    ? "not found"
    : typeof value === "boolean"
      ? value
        ? "yes"
        : "no"
      : String(value);

const billOutcome = (
  correction: {
    accountingOutcome: string;
    updateStatus: string | null;
    updateError: string | null;
  },
  provider: string,
) => {
  if (correction.accountingOutcome === "keep_bill") {
    return { text: `Bill in ${provider} kept as it was`, tone: "muted" };
  }
  if (correction.accountingOutcome === "not_posted") return null;
  switch (correction.updateStatus) {
    case "updated":
      return { text: `Bill in ${provider} updated`, tone: "ok" };
    case "queued":
      return {
        text: `Updating the bill in ${provider}${correction.updateError ? ` (last attempt: ${correction.updateError})` : ""}`,
        tone: "pending",
      };
    case "superseded":
      return {
        text: `Bill update not sent: a re-extraction replaced this correction; the bill in ${provider} was left as it was`,
        tone: "muted",
      };
    case "cancelled":
      return {
        text: `Bill update cancelled: ${correction.updateError ?? "the connection was removed"}`,
        tone: "bad",
      };
    default:
      return {
        text: `Bill update failed: ${correction.updateError ?? "unknown error"}`,
        tone: "bad",
      };
  }
};

/**
 * Every correction of the invoice, newest first (who, when, why, each value
 * before and after, and what happened to the bill), plus where the bill is
 * in the accounting provider.
 */
export function InvoiceHistory({ invoiceId }: { invoiceId: string }) {
  const trpc = useTRPC();
  const { data: user } = useUserQuery();
  const { data } = useQuery({
    ...trpc.inbox.history.queryOptions({ id: invoiceId }),
    refetchInterval: (query) =>
      query.state.data?.corrections.some(
        (correction) => correction.updateStatus === "queued",
      )
        ? 3000
        : false,
  });
  if (!data || (!data.bill && data.corrections.length === 0)) return null;
  const provider = data.bill
    ? (PROVIDER_NAME[data.bill.provider] ?? data.bill.provider)
    : "accounting";

  return (
    <section className="mt-7" aria-labelledby="invoice-history">
      <h3 id="invoice-history" className="text-sm font-semibold">
        History
      </h3>
      {data.bill && (
        <p className="mt-2 flex flex-wrap items-center gap-x-2 text-sm">
          <span>
            {data.bill.entity === "vendor_credit" ? "Vendor credit" : "Bill"} in{" "}
            {provider}{" "}
            <span className="font-mono text-xs">{data.bill.providerId}</span>
            {data.bill.postedAt && (
              <span className="text-muted-foreground">
                {" "}
                · posted {formatDate(data.bill.postedAt, user?.dateFormat)}
              </span>
            )}
          </span>
          <a
            href={data.bill.url ?? undefined}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center text-xs underline underline-offset-2"
          >
            Open in {provider}
            <ExternalLink aria-hidden className="ml-1 size-3" />
          </a>
        </p>
      )}
      {data.corrections.length > 0 && (
        <ol className="mt-2 divide-y border">
          {data.corrections.map((correction) => {
            const outcome = billOutcome(correction, provider);
            return (
              <li key={correction.id} className="px-3 py-2.5 text-sm">
                <p>
                  <span className="font-medium">
                    Correction {correction.version}
                  </span>
                  <span className="text-muted-foreground">
                    {" "}
                    ·{" "}
                    {correction.actor?.fullName ??
                      correction.actor?.email ??
                      "A former member"}{" "}
                    · {formatDate(correction.createdAt, user?.dateFormat)}{" "}
                    {new Date(correction.createdAt).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}{" "}
                    · revision {correction.baseRevision} → {correction.revision}
                  </span>
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  “{correction.reason}”
                </p>
                <ul className="mt-1.5 space-y-0.5 text-xs">
                  {correction.changes.map((change) => (
                    <li key={change.field}>
                      <span className="text-muted-foreground">
                        {FIELD_LABEL[change.field] ?? change.field}:
                      </span>{" "}
                      <span className="line-through decoration-muted-foreground/60">
                        {show(change.from)}
                      </span>{" "}
                      → <span className="font-medium">{show(change.to)}</span>
                    </li>
                  ))}
                </ul>
                {outcome && (
                  <p
                    className={cn(
                      "mt-1 text-xs",
                      outcome.tone === "ok" &&
                        "text-emerald-700 dark:text-emerald-300",
                      outcome.tone === "pending" &&
                        "text-sky-700 dark:text-sky-300",
                      outcome.tone === "bad" && "text-destructive",
                      outcome.tone === "muted" && "text-muted-foreground",
                    )}
                  >
                    {outcome.text}
                    {correction.providerId &&
                      ` · bill ${correction.providerId}`}
                  </p>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
