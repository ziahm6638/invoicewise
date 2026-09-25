"use client";

import { useUserQuery } from "@/hooks/use-user";
import { formatAmount, formatDate } from "@/utils/format";
import {
  AUTHORIZATION_SOURCE_TYPE_LABELS,
  AUTHORIZATION_TAX_BASIS_LABELS,
  type AuthorizationSourceType,
  type AuthorizationTaxBasis,
} from "@invoicewise/documents/authorization-source";
import { Badge } from "@invoicewise/ui/badge";
import { cn } from "@invoicewise/ui/cn";

export const typeLabel = (type: string) =>
  AUTHORIZATION_SOURCE_TYPE_LABELS[type as AuthorizationSourceType] ?? type;

export const taxBasisLabel = (basis: string | null) =>
  basis
    ? (AUTHORIZATION_TAX_BASIS_LABELS[basis as AuthorizationTaxBasis] ?? basis)
    : "Not stated";

/** An authorized amount; without a currency it is shown as a bare number. */
export function Money({
  amount,
  currency,
}: {
  amount: string;
  currency: string | null;
}) {
  const { data: user } = useUserQuery();
  if (!currency) {
    return (
      <span title="No currency was given">
        {Number(amount).toLocaleString(user?.locale ?? undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })}
      </span>
    );
  }
  return (
    <span>
      {formatAmount({
        amount: Number(amount),
        currency,
        locale: user?.locale ?? undefined,
      })}
    </span>
  );
}

export function DateText({ value }: { value: string | null }) {
  const { data: user } = useUserQuery();
  if (!value) return <span className="text-muted-foreground">—</span>;
  return <span>{formatDate(value, user?.dateFormat)}</span>;
}

const STATUS_STYLE: Record<string, string> = {
  open: "border-emerald-600/40 text-emerald-700 dark:text-emerald-400",
  closed: "text-muted-foreground",
  cancelled: "border-destructive/40 text-destructive",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <Badge
      variant="outline"
      className={cn("font-normal capitalize", STATUS_STYLE[status])}
    >
      {status}
    </Badge>
  );
}

const GAP_LABEL: Record<string, string> = {
  unknown_supplier: "Unknown supplier",
  missing_currency: "No currency",
  missing_tax_basis: "Tax basis not stated",
};

/** What a source does not say, shown explicitly rather than guessed. */
export function GapBadges({
  gaps,
}: {
  gaps: { code: string; message: string }[];
}) {
  if (gaps.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {gaps.map((gap) => (
        <Badge
          key={gap.code}
          variant="outline"
          title={gap.message}
          className="border-amber-500/50 font-normal text-amber-700 dark:text-amber-400"
        >
          {GAP_LABEL[gap.code] ?? gap.code}
        </Badge>
      ))}
    </div>
  );
}
