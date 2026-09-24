import { cn } from "@invoicewise/ui/cn";

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      role="img"
      aria-label="InvoiceWise"
      className={cn("size-7", className)}
    >
      <rect width="32" height="32" rx="7" fill="#173a40" />
      <path
        d="M8.5 16.8l4.4 4.4L23.5 11"
        fill="none"
        stroke="#4fb8b2"
        strokeWidth="3.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("flex items-center gap-2", className)}>
      <LogoMark />
      <span className="text-lg font-semibold tracking-tight">InvoiceWise</span>
    </span>
  );
}
