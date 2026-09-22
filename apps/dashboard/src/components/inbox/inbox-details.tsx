"use client";

import { FileViewer } from "@/components/file-viewer";
import { FormatAmount } from "@/components/format-amount";
import { getInvoiceState } from "@/components/inbox/invoice-state";
import { useInboxParams } from "@/hooks/use-inbox-params";
import { useUserQuery } from "@/hooks/use-user";
import { useTRPC } from "@/trpc/client";
import { formatDate } from "@/utils/format";
import type { InvoiceExtraction } from "@midday/documents";
import { Alert, AlertDescription, AlertTitle } from "@midday/ui/alert";
import { Button } from "@midday/ui/button";
import { ScrollArea } from "@midday/ui/scroll-area";
import { Skeleton } from "@midday/ui/skeleton";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ExternalLink,
  FileWarning,
  LoaderCircle,
} from "lucide-react";
import type { ReactNode } from "react";
import { InboxStatus } from "./inbox-status";
import { JudgmentResults } from "./judgment-results";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 py-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 break-words text-sm font-medium">
        {children ?? (
          <span className="font-normal text-amber-700 dark:text-amber-300">
            Not found
          </span>
        )}
      </dd>
    </div>
  );
}

function Money({
  amount,
  currency,
}: { amount: number | null; currency: string | null }) {
  if (amount === null || !currency) return null;
  return <FormatAmount amount={amount} currency={currency} />;
}

function ProcessingMessage() {
  return (
    <Alert className="mb-5">
      <LoaderCircle aria-hidden className="size-4 animate-spin" />
      <AlertTitle>Invoice processing is still underway</AlertTitle>
      <AlertDescription>
        The source file is available now. Extracted fields and checks will
        appear here automatically.
      </AlertDescription>
    </Alert>
  );
}

function FailedMessage() {
  return (
    <Alert variant="destructive" className="mb-5">
      <AlertTriangle aria-hidden className="size-4" />
      <AlertTitle>Invoice extraction failed</AlertTitle>
      <AlertDescription>
        InvoiceWise could not read this file reliably. Open the original
        document and upload a clearer copy if needed.
      </AlertDescription>
    </Alert>
  );
}

export function InboxDetails() {
  const { params } = useInboxParams();
  const { data: user } = useUserQuery();
  const trpc = useTRPC();
  const { data, isLoading } = useQuery(
    trpc.inbox.getById.queryOptions(
      { id: params.inboxId! },
      { enabled: Boolean(params.inboxId) },
    ),
  );

  if (isLoading) {
    return (
      <div className="hidden h-full min-h-0 border lg:flex lg:flex-col">
        <div className="space-y-3 border-b p-5">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-4 w-32" />
        </div>
        <Skeleton className="m-5 flex-1" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="hidden h-full items-center justify-center border p-8 text-center text-sm text-muted-foreground lg:flex">
        Select an invoice to inspect its document, extracted fields, and checks.
      </div>
    );
  }

  const extraction = data.extraction as InvoiceExtraction | null;
  const state = getInvoiceState(data);
  const supplier =
    extraction?.supplierName ??
    data.displayName ??
    data.fileName ??
    "Unknown supplier";
  const currency = extraction?.currency ?? data.currency ?? null;
  const amount = extraction?.grossAmount ?? data.amount ?? null;
  const bank = extraction?.bankDetails;

  return (
    <article className="hidden h-full min-h-0 overflow-hidden border bg-background lg:flex lg:flex-col">
      <header className="flex shrink-0 items-start justify-between gap-5 border-b px-5 py-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h2 className="truncate text-base font-semibold">{supplier}</h2>
            <InboxStatus state={state} />
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {extraction?.invoiceNumber ?? "Invoice number not found"}
            <span aria-hidden className="mx-2">
              ·
            </span>
            Received {formatDate(data.createdAt, user?.dateFormat)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <p className="text-right text-base font-semibold tabular-nums">
            {amount !== null && currency ? (
              <FormatAmount amount={amount} currency={currency} />
            ) : (
              <span className="text-sm font-normal text-muted-foreground">
                Amount pending
              </span>
            )}
          </p>
          {data.attachmentUrl && (
            <Button asChild variant="outline" size="sm">
              <a href={data.attachmentUrl} target="_blank" rel="noreferrer">
                Open original
                <ExternalLink aria-hidden className="ml-2 size-3.5" />
              </a>
            </Button>
          )}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto xl:grid xl:grid-cols-[minmax(340px,1.05fr)_minmax(340px,0.95fr)] xl:overflow-hidden">
        <section className="flex h-[460px] min-h-0 flex-col border-b xl:h-full xl:border-b-0 xl:border-r">
          <div className="shrink-0 border-b px-4 py-3">
            <p className="text-sm font-medium">Original document</p>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {data.fileName}
            </p>
          </div>
          <div className="min-h-0 flex-1 bg-secondary/20">
            {data.attachmentUrl ? (
              <FileViewer
                mimeType={data.contentType}
                url={data.attachmentUrl}
                key={data.id}
                maxWidth={560}
              />
            ) : (
              <div className="flex h-full flex-col items-center justify-center p-8 text-center">
                <FileWarning
                  aria-hidden
                  className="mb-3 size-7 text-muted-foreground"
                />
                <p className="text-sm font-medium">Preview unavailable</p>
                <p className="mt-1 max-w-sm text-xs leading-5 text-muted-foreground">
                  The original file has no accessible storage link. The
                  extracted data remains available for review.
                </p>
              </div>
            )}
          </div>
        </section>

        <ScrollArea className="min-h-0 xl:h-full">
          <div className="p-5">
            {state === "processing" && <ProcessingMessage />}
            {state === "failed" && <FailedMessage />}

            {extraction ? (
              <>
                <section>
                  <h3 className="text-sm font-semibold">Extracted fields</h3>
                  <dl className="mt-2 grid grid-cols-2 gap-x-5 divide-y sm:grid-cols-3 xl:grid-cols-2 2xl:grid-cols-3">
                    <Field label="Supplier">{extraction.supplierName}</Field>
                    <Field label="Invoice number">
                      {extraction.invoiceNumber}
                    </Field>
                    <Field label="Invoice date">
                      {extraction.invoiceDate
                        ? formatDate(
                            extraction.invoiceDate,
                            user?.dateFormat,
                            false,
                          )
                        : null}
                    </Field>
                    <Field label="Due date">
                      {extraction.dueDate
                        ? formatDate(
                            extraction.dueDate,
                            user?.dateFormat,
                            false,
                          )
                        : null}
                    </Field>
                    <Field label="VAT number">
                      {extraction.supplierVatNumber}
                    </Field>
                    <Field label="PO reference">
                      {extraction.purchaseOrderReference}
                    </Field>
                    <Field label="Net">
                      <Money
                        amount={extraction.netAmount}
                        currency={currency}
                      />
                    </Field>
                    <Field label="VAT">
                      <Money
                        amount={extraction.vatAmount}
                        currency={currency}
                      />
                    </Field>
                    <Field label="Gross">
                      <Money
                        amount={extraction.grossAmount}
                        currency={currency}
                      />
                    </Field>
                  </dl>
                  {extraction.description && (
                    <p className="mt-3 text-sm leading-6 text-muted-foreground">
                      {extraction.description}
                    </p>
                  )}
                </section>

                <section className="mt-7">
                  <h3 className="text-sm font-semibold">Line items</h3>
                  {extraction.lineItems.length ? (
                    <div className="mt-3 overflow-x-auto border">
                      <table className="w-full min-w-[480px] text-left text-xs">
                        <thead className="border-b bg-secondary/40 text-muted-foreground">
                          <tr>
                            <th className="px-3 py-2 font-medium">
                              Description
                            </th>
                            <th className="px-3 py-2 text-right font-medium">
                              Qty
                            </th>
                            <th className="px-3 py-2 text-right font-medium">
                              Unit price
                            </th>
                            <th className="px-3 py-2 text-right font-medium">
                              Total
                            </th>
                          </tr>
                        </thead>
                        <tbody className="divide-y">
                          {extraction.lineItems.map((item, index) => (
                            <tr key={`${item.description ?? "item"}-${index}`}>
                              <td className="px-3 py-2.5 text-sm">
                                {item.description ?? "Description not found"}
                              </td>
                              <td className="px-3 py-2.5 text-right tabular-nums">
                                {item.quantity ?? "—"}
                              </td>
                              <td className="px-3 py-2.5 text-right tabular-nums">
                                <Money
                                  amount={item.unitPrice}
                                  currency={currency}
                                />
                              </td>
                              <td className="px-3 py-2.5 text-right font-medium tabular-nums">
                                <Money
                                  amount={item.total}
                                  currency={currency}
                                />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="mt-2 text-sm text-muted-foreground">
                      No line items were found on this invoice.
                    </p>
                  )}
                </section>

                <section className="mt-7">
                  <h3 className="text-sm font-semibold">Checks</h3>
                  <JudgmentResults judgments={data.judgments} />
                </section>

                {bank && Object.values(bank).some(Boolean) && (
                  <section className="mt-7 border-t pt-5">
                    <h3 className="text-sm font-semibold">Payment details</h3>
                    <dl className="mt-2 grid grid-cols-2 gap-x-5 divide-y">
                      <Field label="Account name">{bank.accountName}</Field>
                      <Field label="Account number">{bank.accountNumber}</Field>
                      <Field label="Sort code">{bank.sortCode}</Field>
                      <Field label="IBAN">{bank.iban}</Field>
                      <Field label="BIC">{bank.bic}</Field>
                    </dl>
                  </section>
                )}
              </>
            ) : (
              state !== "processing" && (
                <p className="text-sm text-muted-foreground">
                  No extracted fields are available. Review the original
                  document or upload a clearer copy.
                </p>
              )
            )}
          </div>
        </ScrollArea>
      </div>
    </article>
  );
}
