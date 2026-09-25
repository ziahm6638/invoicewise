"use client";

import { useTRPC } from "@/trpc/client";
import { Badge } from "@invoicewise/ui/badge";
import { cn } from "@invoicewise/ui/cn";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@invoicewise/ui/table";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { reconciliationStatus } from "../inbox/reconciliation-view";
import { DateText, Money } from "./shared";

const STATUS_STYLE: Record<string, string> = {
  good: "border-emerald-600/40 text-emerald-700 dark:text-emerald-400",
  warn: "border-amber-500/50 text-amber-700 dark:text-amber-400",
};

const METHOD: Record<string, string> = {
  reference: "Reference",
  semantic: "TypeSafe",
  manual: "Admin",
};

/**
 * The invoices currently matched to this source, with the version each was
 * compared with, what it allocates here, how its reconciliation came out
 * and what it consumes of the balance. One source can be billed by several
 * invoices, and one invoice can split across several sources.
 */
export function SourceInvoices({ id }: { id: string }) {
  const trpc = useTRPC();
  const { data, isLoading } = useQuery(
    trpc.sourceMatches.forSource.queryOptions({ id }),
  );
  // Which invoices the balance counts: a consumption that is not counted
  // (an unconfirmed match, a duplicate, a dismissed invoice, another
  // currency) is shown but marked.
  const balance = useQuery(trpc.sourceMatches.balance.queryOptions({ id }));
  const ledger = new Map(
    (balance.data?.perInvoice ?? []).map((entry) => [entry.inboxId, entry]),
  );

  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium">Matched invoices</h2>
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : !data?.length ? (
        <p className="text-sm text-muted-foreground">
          No invoice is matched to this source yet.
        </p>
      ) : (
        <div className="rounded border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Invoice</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Match</TableHead>
                <TableHead>Version</TableHead>
                <TableHead>Reconciliation</TableHead>
                <TableHead className="text-right">Allocated here</TableHead>
                <TableHead className="text-right">Consumed</TableHead>
                <TableHead className="text-right">Invoice total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((row) => (
                <TableRow key={row.invoiceId}>
                  <TableCell>
                    <Link
                      href={`/inbox?inboxId=${row.invoiceId}`}
                      className="font-medium hover:underline"
                    >
                      {row.documentType === "credit_note" ? "Credit note " : ""}
                      {row.invoiceNumber ?? row.displayName ?? "Invoice"}
                    </Link>
                    {row.displayName && row.invoiceNumber && (
                      <span className="block text-xs text-muted-foreground">
                        {row.displayName}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <DateText value={row.invoiceDate} />
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      <Badge variant="tag">
                        {METHOD[row.method ?? ""] ?? row.method ?? "—"}
                      </Badge>
                      {row.needsConfirmation && (
                        <Badge variant="tag">To confirm</Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>v{row.version}</TableCell>
                  <TableCell>
                    <Badge
                      variant="outline"
                      className={cn(
                        "font-normal",
                        STATUS_STYLE[
                          reconciliationStatus(row.reconciliationStatus).tone
                        ] ?? "text-muted-foreground",
                      )}
                    >
                      {reconciliationStatus(row.reconciliationStatus).label}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    {row.allocatedAmount !== null ? (
                      <Money
                        amount={row.allocatedAmount}
                        currency={row.currency}
                      />
                    ) : (
                      <span className="text-muted-foreground">
                        Not allocated
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {row.consumedAmount !== null ? (
                      <>
                        <Money
                          amount={row.consumedAmount}
                          currency={row.currency}
                        />
                        {balance.data &&
                          !ledger.get(row.invoiceId)?.counted && (
                            <span
                              className="block text-xs text-muted-foreground"
                              title={
                                ledger.get(row.invoiceId)?.reason ?? undefined
                              }
                            >
                              Not counted
                            </span>
                          )}
                      </>
                    ) : (
                      <span
                        className="text-muted-foreground"
                        title="Not reconciled yet, or its amount could not be determined"
                      >
                        —
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {row.amount !== null ? (
                      <Money
                        amount={String(row.amount)}
                        currency={row.currency}
                      />
                    ) : (
                      "—"
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}
