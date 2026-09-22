import { FormatAmount } from "@/components/format-amount";
import {
  getExtractionText,
  getInvoiceState,
} from "@/components/inbox/invoice-state";
import { useInboxParams } from "@/hooks/use-inbox-params";
import { useUserQuery } from "@/hooks/use-user";
import { formatDate } from "@/utils/format";
import type { RouterOutputs } from "@api/trpc/routers/_app";
import { cn } from "@invoicewise/ui/cn";
import { forwardRef } from "react";
import { InboxStatus } from "./inbox-status";

type Props = {
  item: RouterOutputs["inbox"]["get"]["data"][number];
  index: number;
};

export const InboxItem = forwardRef<HTMLButtonElement, Props>(
  function InboxItem({ item, index }, ref) {
    const { params, setParams } = useInboxParams();
    const { data: user } = useUserQuery();
    const extraction = item.extraction as Record<string, unknown> | null;
    const state = getInvoiceState(item);
    const supplier =
      getExtractionText(extraction, "supplierName") ??
      item.displayName ??
      item.fileName ??
      "Unknown supplier";
    const invoiceNumber = getExtractionText(extraction, "invoiceNumber");
    const isSelected =
      params.inboxId === item.id || (!params.inboxId && index === 0);

    return (
      <button
        ref={ref}
        type="button"
        onClick={() => setParams({ inboxId: item.id })}
        className={cn(
          "w-full border-b px-4 py-3.5 text-left transition-colors last:border-b-0 hover:bg-secondary/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          isSelected && "bg-secondary/60",
        )}
      >
        <div className="flex items-start justify-between gap-3">
          <p className="min-w-0 truncate text-sm font-semibold">{supplier}</p>
          <p className="shrink-0 text-sm font-medium tabular-nums">
            {item.currency && item.amount != null ? (
              <FormatAmount amount={item.amount} currency={item.currency} />
            ) : (
              <span className="text-muted-foreground">Amount pending</span>
            )}
          </p>
        </div>
        <div className="mt-1.5 flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <span className="min-w-0 truncate font-mono">
            {invoiceNumber ??
              (state === "processing"
                ? "Reading invoice…"
                : "No invoice number")}
          </span>
          <span className="shrink-0">
            Received {formatDate(item.createdAt, user?.dateFormat)}
          </span>
        </div>
        <div className="mt-3 flex items-center justify-between gap-3">
          <InboxStatus state={state} />
          <span className="truncate text-[11px] text-muted-foreground">
            {item.currency ?? "Currency pending"}
          </span>
        </div>
      </button>
    );
  },
);
