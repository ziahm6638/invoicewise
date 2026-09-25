import { cn } from "@invoicewise/ui/cn";
import { Icons } from "@invoicewise/ui/icons";

/** The InvoiceWise logo (symbol plus wordmark) from `@invoicewise/ui/brand`. */
export function Wordmark({ className }: { className?: string }) {
  return <Icons.Logo className={cn("h-6 w-auto", className)} />;
}
