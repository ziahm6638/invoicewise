"use client";

import { useTRPC } from "@/trpc/client";
import { Button } from "@invoicewise/ui/button";
import { cn } from "@invoicewise/ui/cn";
import { useToast } from "@invoicewise/ui/use-toast";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

const statusLabel: Record<string, string> = {
  queued: "Queued",
  delivering: "Retrying",
  succeeded: "Delivered",
  posted: "Posted",
  already_posted: "Posted",
  failed: "Failed",
  cancelled: "Cancelled",
};

const statusTone = (status: string) =>
  status === "failed"
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
}: {
  label: string;
  detail: string;
  status: string;
  error: string | null;
  retryable: boolean | null;
}) {
  return (
    <li className="flex items-start justify-between gap-4 py-2.5">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{label}</p>
        <p className="truncate text-xs text-muted-foreground">{detail}</p>
        {error && (status === "failed" || status === "cancelled") && (
          <p className="mt-1 text-xs text-muted-foreground">
            {error}
            {/* Failures recorded before retryability existed carry null. */}
            {status === "failed" &&
              retryable !== null &&
              (retryable
                ? " · Retry may succeed"
                : " · Needs a configuration change")}
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
  const { data } = useQuery(
    trpc.inbox.delivery.queryOptions({ id: invoiceId }),
  );
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
        ]);
        const skipped =
          result.webhooks.skipped > 0 ||
          result.accounting === "no_active_connection";
        toast({
          title: "Delivery retry queued",
          description:
            result.accounting === "admin_required"
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
  const hasDestinations = data.webhooks.length > 0 || accounting !== null;
  const canRetry =
    data.webhooks.some(
      (delivery) =>
        delivery.status === "failed" || delivery.status === "cancelled",
    ) ||
    accounting?.status === "failed" ||
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
                accounting.provider === "quickbooks"
                  ? "QuickBooks"
                  : accounting.provider === "xero"
                    ? "Xero"
                    : "Accounting connection"
              }
              status={accounting.status ?? "queued"}
              error={accounting.lastError}
              retryable={accounting.retryable}
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
