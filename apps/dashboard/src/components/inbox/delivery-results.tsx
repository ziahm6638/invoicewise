"use client";

import { useTeamPermissions } from "@/hooks/use-team";
import { useTRPC } from "@/trpc/client";
import type { RouterOutputs } from "@api/trpc/routers/_app";
import { Button } from "@invoicewise/ui/button";
import { cn } from "@invoicewise/ui/cn";
import { Label } from "@invoicewise/ui/label";
import { Textarea } from "@invoicewise/ui/textarea";
import { useToast } from "@invoicewise/ui/use-toast";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { ExternalLink } from "lucide-react";
import { useState } from "react";

type DeliveryData = NonNullable<RouterOutputs["inbox"]["delivery"]>;
type Decision = DeliveryData["decisions"][number];
type Reason = { code: string; message: string; locked?: boolean };

const reasonsOf = (decision: Pick<Decision, "reasons">) =>
  (decision.reasons as unknown as Reason[]).filter(
    (reason) => typeof reason?.message === "string",
  );

const heldDestinations = (decision: Decision) =>
  [
    decision.accounting === "held" ? "accounting" : null,
    decision.webhooks === "held" ? "webhooks" : null,
  ].filter(Boolean) as string[];

const resolutionLine = (decision: Decision) =>
  decision.resolution
    ? `${decision.resolution === "released" ? "Released" : "Dismissed"} by ${
        decision.resolver?.fullName ?? "a former member"
      }${decision.resolvedAt ? ` on ${format(new Date(decision.resolvedAt), "d MMM yyyy HH:mm")}` : ""}: ${decision.resolutionReason ?? ""}`
    : null;

/**
 * The delivery rules' decision for the current revision: why it was held,
 * and the owner's or admin's release or dismissal, which is kept with who
 * made it and why.
 */
function DeliveryDecision({
  invoiceId,
  revision,
  decision,
  earlier,
}: {
  invoiceId: string;
  revision: number;
  decision: Decision | null;
  earlier: Decision[];
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const permissions = useTeamPermissions();
  const [action, setAction] = useState<"release" | "dismiss" | null>(null);
  const [reason, setReason] = useState("");

  const settled = async (title: string, description?: string) => {
    setAction(null);
    setReason("");
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: trpc.inbox.delivery.queryKey({ id: invoiceId }),
      }),
      queryClient.invalidateQueries({
        queryKey: trpc.inbox.getById.queryKey({ id: invoiceId }),
      }),
      queryClient.invalidateQueries({ queryKey: trpc.inbox.get.queryKey() }),
    ]);
    toast({ duration: 3500, variant: "success", title, description });
  };
  const failed = (title: string) => (error: { message: string }) =>
    toast({
      duration: 6000,
      variant: "error",
      title,
      description: error.message,
    });
  const release = useMutation(
    trpc.inbox.releaseDelivery.mutationOptions({
      onSuccess: (result) =>
        settled(
          "Invoice released",
          result.accounting === "not_scheduled"
            ? "Accounting is not connected or its automatic posting is off, so no bill was queued."
            : undefined,
        ),
      onError: failed("The invoice was not released"),
    }),
  );
  const dismiss = useMutation(
    trpc.inbox.dismissDelivery.mutationOptions({
      onSuccess: () => settled("Invoice dismissed", "Nothing will be sent."),
      onError: failed("The invoice was not dismissed"),
    }),
  );

  const history = earlier.filter((item) => item.resolution);
  if (!decision) {
    return null;
  }
  const reasons = reasonsOf(decision);
  const held =
    decision.outcome === "hold" && heldDestinations(decision).length > 0;
  const locked = reasons.filter((item) => item.locked);
  const pending = release.isPending || dismiss.isPending;

  return (
    <div className="mt-2 rounded-md border px-3 py-2.5 text-sm">
      {held && !decision.resolution ? (
        <>
          <p className="font-medium text-destructive">
            Held by the delivery rules (version {decision.policyVersion})
          </p>
          <p className="text-xs text-muted-foreground">
            Not sent to {heldDestinations(decision).join(" or ")} until an owner
            or admin releases it.
          </p>
        </>
      ) : decision.resolution ? (
        <p className="font-medium">{resolutionLine(decision)}</p>
      ) : (
        <p className="text-xs text-muted-foreground">
          Eligible under the delivery rules (version {decision.policyVersion}
          ), so it was delivered without a manual step.
          {decision.accounting === "off"
            ? " Posting to accounting is switched off."
            : decision.accounting === "not_scheduled"
              ? " It was not posted to accounting automatically (automatic posting is off, or this revision did not re-post)."
              : ""}
        </p>
      )}
      {reasons.length > 0 && (
        <ul className="mt-2 list-disc space-y-1 pl-4 text-xs">
          {reasons.map((item) => (
            <li key={`${item.code}:${item.message}`}>
              {item.message}
              {item.locked && (
                <span className="text-muted-foreground">
                  {" "}
                  · needs a correction or re-extraction
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {held && !decision.resolution && (
        <div className="mt-3">
          {!permissions.resolveHeldDeliveries ? (
            <p className="text-xs text-muted-foreground">
              An owner or admin can release or dismiss it.
            </p>
          ) : action ? (
            <div className="grid gap-2">
              <Label htmlFor={`resolve-${invoiceId}`} className="text-xs">
                {action === "release"
                  ? "Why is it safe to send? (kept in the history)"
                  : "Why is it not being sent? (kept in the history)"}
              </Label>
              <Textarea
                id={`resolve-${invoiceId}`}
                value={reason}
                maxLength={500}
                onChange={(event) => setReason(event.target.value)}
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant={action === "dismiss" ? "destructive" : "default"}
                  disabled={pending || reason.trim().length < 3}
                  onClick={() =>
                    (action === "release" ? release : dismiss).mutate({
                      id: invoiceId,
                      revision,
                      reason: reason.trim(),
                    })
                  }
                >
                  {action === "release" ? "Release and send" : "Dismiss"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => setAction(null)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                disabled={locked.length > 0}
                onClick={() => setAction("release")}
              >
                Release
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setAction("dismiss")}
              >
                Dismiss
              </Button>
              {locked.length > 0 && (
                <span className="text-xs text-muted-foreground">
                  Correct or re-extract it to send it, or dismiss it.
                </span>
              )}
            </div>
          )}
        </div>
      )}
      {history.length > 0 && (
        <ul className="mt-3 space-y-1 border-t pt-2 text-xs text-muted-foreground">
          {history.map((item) => (
            <li key={item.id}>
              Revision {item.revision}: {resolutionLine(item)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

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
  const decision = data.decision;
  // A held post is sent by a release, never by a retry.
  const accountingHeld =
    decision?.outcome === "hold" && decision.resolution !== "released";
  const canRetry =
    billUpdate?.status === "failed" ||
    billUpdate?.status === "cancelled" ||
    data.webhooks.some(
      (delivery) =>
        delivery.status === "failed" || delivery.status === "cancelled",
    ) ||
    accounting?.attachmentStatus === "failed" ||
    (!accountingHeld &&
      (accounting?.status === "failed" ||
        accounting?.status === "needs_review" ||
        accounting?.status === "cancelled"));

  const earlier = data.decisions.filter(
    (item) => item.revision !== data.revision,
  );

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
      <DeliveryDecision
        invoiceId={invoiceId}
        revision={data.revision}
        decision={decision}
        earlier={earlier}
      />
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
              label={
                accounting.entity === "vendor_credit"
                  ? "Accounting vendor credit"
                  : accounting.provider === "quickbooks"
                    ? "Accounting bill (open, unpaid)"
                    : "Accounting draft bill"
              }
              detail={
                accounting.providerId
                  ? `${providerName} · ${accounting.entity === "vendor_credit" ? "vendor credit" : "bill"} ${accounting.providerId}`
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
          {accounting?.providerId && accounting.attachmentStatus && (
            <Outcome
              label="Source document attachment"
              detail={`${providerName} · attached separately from the ${accounting.entity === "vendor_credit" ? "vendor credit" : "bill"}`}
              status={
                accounting.attachmentStatus === "attached"
                  ? "succeeded"
                  : accounting.attachmentStatus
              }
              error={accounting.attachmentError}
              retryable={accounting.attachmentStatus === "failed" ? true : null}
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
      ) : decision?.outcome === "hold" ? null : (
        <p className="mt-2 text-sm text-muted-foreground">
          No delivery destinations were configured when this invoice was
          processed.
        </p>
      )}
    </section>
  );
}
