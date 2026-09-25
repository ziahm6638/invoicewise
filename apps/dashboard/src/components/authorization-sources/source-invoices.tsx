"use client";

import { useTRPC } from "@/trpc/client";
import { Badge } from "@invoicewise/ui/badge";
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
import { DateText, Money } from "./shared";

const METHOD: Record<string, string> = {
  reference: "Reference",
  semantic: "TypeSafe",
  manual: "Admin",
};

/**
 * The invoices currently matched to this source, with the version each was
 * compared with and what it allocates here. One source can be billed by
 * several invoices, and one invoice can split across several sources.
 */
export function SourceInvoices({ id }: { id: string }) {
  const trpc = useTRPC();
  const { data, isLoading } = useQuery(
    trpc.sourceMatches.forSource.queryOptions({ id }),
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
                <TableHead className="text-right">Allocated here</TableHead>
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
