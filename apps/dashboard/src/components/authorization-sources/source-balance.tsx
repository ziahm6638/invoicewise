"use client";

import { useTRPC } from "@/trpc/client";
import { useQuery } from "@tanstack/react-query";
import { useMoneyFormat } from "./shared";
import { SourceBalanceView } from "./source-balance-view";

/**
 * The source's balance now: the terms in effect today against every invoice
 * currently counted against it.
 */
export function SourceBalanceSection({ id }: { id: string }) {
  const trpc = useTRPC();
  const format = useMoneyFormat();
  const { data, isLoading } = useQuery(
    trpc.sourceMatches.balance.queryOptions({ id }),
  );
  // The matched invoices name the ones left out of the balance.
  const invoices = useQuery(trpc.sourceMatches.forSource.queryOptions({ id }));
  const invoiceNames = Object.fromEntries(
    (invoices.data ?? []).map((row) => [
      row.invoiceId,
      row.invoiceNumber ?? row.displayName ?? "Invoice",
    ]),
  );

  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium">Balance</h2>
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : data ? (
        <SourceBalanceView
          balance={data}
          formatAmount={format}
          invoiceNames={invoiceNames}
        />
      ) : (
        <p className="text-sm text-muted-foreground">
          No balance is available for this source.
        </p>
      )}
    </section>
  );
}
