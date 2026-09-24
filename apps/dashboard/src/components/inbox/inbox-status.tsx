import {
  type InvoiceState,
  invoiceStateLabel,
} from "@/components/inbox/invoice-state";
import { Badge } from "@invoicewise/ui/badge";
import { cn } from "@invoicewise/ui/cn";

const styles: Record<InvoiceState, string> = {
  processing:
    "border-amber-300/70 bg-amber-50 text-amber-800 dark:bg-amber-950/30 dark:text-amber-300",
  extracted:
    "border-blue-300/70 bg-blue-50 text-blue-800 dark:bg-blue-950/30 dark:text-blue-300",
  judged:
    "border-violet-300/70 bg-violet-50 text-violet-800 dark:bg-violet-950/30 dark:text-violet-300",
  delivering:
    "border-sky-300/70 bg-sky-50 text-sky-800 dark:bg-sky-950/30 dark:text-sky-300",
  delivery_failed: "border-destructive/40 bg-destructive/5 text-destructive",
  delivered:
    "border-emerald-300/70 bg-emerald-50 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300",
  failed: "border-destructive/40 bg-destructive/5 text-destructive",
};

export function InboxStatus({ state }: { state: InvoiceState }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "rounded-full px-2 py-0.5 font-sans text-[10px]",
        styles[state],
      )}
    >
      {invoiceStateLabel[state]}
    </Badge>
  );
}
