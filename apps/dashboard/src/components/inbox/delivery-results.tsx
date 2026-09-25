"use client";

import { useTRPC } from "@/trpc/client";
import { Button } from "@invoicewise/ui/button";
import { cn } from "@invoicewise/ui/cn";
import { useToast } from "@invoicewise/ui/use-toast";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";

const PROVIDER_NAME: Record<string, string> = {
  xero: "Xero",
  quickbooks: "QuickBooks",
};

const statusLabel: Record<string, string> = {
  queued: "Queued",
  updated: "Updated",
  delivering: "Retrying",
  succeeded: "Delivered",
  posted: "Posted",
  already_posted: "Posted",
  failed: "Failed",
  needs_review: "Needs review",
  cancelled: "Cancelled",
};

const statusTone = (status: string) =>
  status === "failed" || status === "needs_review"
    ? "text-destructive"
    : status === "cancelled"
      ? "text-muted-foreground"
      : status === "queued" || status === "delivering"
        ? "text-sky-700 dark:text-sky-300"
        : "text-emerald-700 dark:text-emerald-300";

function Outcome({
  label,
  detail,
  status,
  error,
  retryable,
  link,
}: {
  label: string;
  detail: string;
  status: string;
  error: string | null;
  retryable: boolean | null;
  link?: { href: string; label: string } | null;
}) {
  return (
    <li className="flex items-start justify-between gap-4 py-2.5">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{label}</p>
        <p className="truncate text-xs text-muted-foreground">
          {detail}
          {link && (
            <>
              {" · "}
              <a
                href={link.href}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center underline underline-offset-2"
              >
                {link.label}
                <ExternalLink aria-hidden className="ml-1 size-3" />
              </a>
            </>
          )}
        </p>
        {error &&
          (status === "failed" ||
            status === "needs_review" ||
            status === "cancelled") && (
            <p className="mt-1 text-xs text-muted-foreground">
              {error}
              {/* Failures recorded before retryability existed carry null. */}
              {status === "failed" &&
                retryable !== null &&
                (retryable
                  ? " · Retry may succeed"
                  : " · Needs a change before retrying")}
            </p>
          )}
      </div>
      <span className={cn("shrink-0 text-xs font-medium", statusTone(status))}>
        {statusLabel[status] ?? status}
      </span>
    </li>
  );
}

/**
 * Where the current revision of the invoice was delivered, with the
 * per-destination outcome and the retry recovery action.
 */
export function DeliveryResults({ invoiceId }: { invoiceId: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data } = useQuery({
    ...trpc.inbox.delivery.queryOptions({ id: invoiceId }),
    // Queued work is shown as queued until a destination reports back.
    refetchInterval: (query) =>
      query.state.data?.summary?.state === "pending" ? 3000 : false,
  });
  const retry = useMutation(
    trpc.inbox.retryDelivery.mutationOptions({
      onSuccess: async (result) => {
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: trpc.inbox.delivery.queryKey({ id: invoiceId }),
          }),
          queryClient.invalidateQueries({
            queryKey: trpc.inbox.getById.queryKey({ id: invoiceId }),
          }),
          queryClient.invalidateQueries({
            queryKey: trpc.inbox.get.queryKey(),
          }),
          queryClient.invalidateQueries({
            queryKey: trpc.inbox.history.queryKey({ id: invoiceId }),
          }),
        ]);
        const skipped =
          result.webhooks.skipped > 0 ||
          result.accounting === "no_active_connection";
        toast({
          title: "Delivery retry queued",
          description:
            result.accounting === "admin_required" ||
            result.billUpdate === "admin_required"
              ? "Re-posting to your accounting software needs an admin."
              : skipped
                ? "Destinations that were disabled or disconnected were skipped."
                : undefined,
        });
      },
      onError: (error) =>
        toast({
          title: "Delivery retry failed",
          description: error.message,
          variant: "destructive",
        }),
    }),
  );

  if (!data) return null;

  const accounting = data.accounting;
  const billUpdate = data.billUpdate;
  const providerName = accounting?.provider
    ? (PROVIDER_NAME[accounting.provider] ?? "Accounting connection")
    : "Accounting connection";
  const hasDestinations = data.webhooks.length > 0 || accounting !== null;
  const canRetry =
    billUpdate?.status === "failed" ||
    billUpdate?.status === "cancelled" ||
    data.webhooks.some(
      (delivery) =>
        delivery.status === "failed" || delivery.status === "cancelled",
    ) ||
    accounting?.status === "failed" ||
    accounting?.status === "needs_review" ||
    accounting?.status === "cancelled";

  return (
    <section className="mt-7">
      <div className="flex items-center justify-between gap-4">
        <h3 className="text-sm font-semibold">Delivery</h3>
        {canRetry && (
          <Button
            variant="outline"
            size="sm"
            disabled={retry.isPending}
            onClick={() => retry.mutate({ id: invoiceId })}
          >
            Retry delivery
          </Button>
        )}
      </div>
      {hasDestinations ? (
        <ul className="mt-2 divide-y">
          {data.webhooks.map((delivery) => (
            <Outcome
              key={delivery.id}
              label={`Webhook · ${delivery.event}`}
              detail={delivery.endpointUrl}
              status={delivery.status}
              error={delivery.lastError}
              retryable={delivery.retryable}
            />
          ))}
          {accounting && (
            <Outcome
              label="Accounting draft bill"
              detail={
                accounting.providerId
                  ? `${providerName} · bill ${accounting.providerId}`
                  : providerName
              }
              status={accounting.status ?? "queued"}
              error={accounting.lastError}
              retryable={accounting.retryable}
              link={
                accounting.url
                  ? { href: accounting.url, label: `Open in ${providerName}` }
                  : null
              }
            />
          )}
          {billUpdate?.status && (
            <Outcome
              label={`Bill update after correction ${billUpdate.version}`}
              detail={`${providerName} · same bill, updated in place`}
              status={billUpdate.status}
              error={billUpdate.error}
              retryable={billUpdate.retryable}
            />
          )}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">
          No delivery destinations were configured when this invoice was
          processed.
        </p>
      )}
    </section>
  );
}
