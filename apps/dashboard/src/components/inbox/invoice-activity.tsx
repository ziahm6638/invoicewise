"use client";

import { useUserQuery } from "@/hooks/use-user";
import { useTRPC } from "@/trpc/client";
import { formatDate } from "@/utils/format";
import type { RouterOutputs } from "@api/trpc/routers/_app";
import { Button } from "@invoicewise/ui/button";
import { cn } from "@invoicewise/ui/cn";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

type Entry = NonNullable<RouterOutputs["inbox"]["activity"]>["entries"][number];

const STATUS_DOT: Record<Entry["status"], string> = {
  ok: "bg-emerald-600 dark:bg-emerald-400",
  pending: "bg-sky-600 dark:bg-sky-400",
  review: "bg-amber-600 dark:bg-amber-400",
  failed: "bg-destructive",
  refused: "bg-amber-600 dark:bg-amber-400",
  info: "bg-muted-foreground",
};

const STATUS_LABEL: Record<Entry["status"], string> = {
  ok: "Done",
  pending: "In progress",
  review: "Needs review",
  failed: "Failed",
  refused: "Refused or cancelled",
  info: "Information",
};

const REF_LABEL: Record<string, string> = {
  invoiceId: "Invoice",
  inboundEmailId: "Received message",
  messageId: "Message-ID",
  mailboxId: "Mailbox",
  redeliveryId: "Re-delivery",
  jobId: "Job",
  attempts: "Attempts",
  revision: "Revision",
  deliveryId: "Delivery",
  eventId: "Event ID",
  endpointId: "Endpoint",
  providerId: "Bill",
  correctionId: "Correction",
  version: "Version",
  runId: "Question run",
  auditEventId: "Audit event",
};

export const actorLabel = (actor: Entry["actor"]) => {
  if (!actor) return null;
  switch (actor.type) {
    case "operator":
      return actor.name
        ? `InvoiceWise operator (declared as ${actor.name}, not authenticated)`
        : "InvoiceWise operator";
    case "api_key":
      return actor.name ? `${actor.name} (API key)` : "An API key";
    case "oauth":
      return actor.name ? `${actor.name} (connected app)` : "A connected app";
    default:
      return actor.name ?? "A former member";
  }
};

function ActivityEntry({ entry }: { entry: Entry }) {
  const { data: user } = useUserQuery();
  const actor = actorLabel(entry.actor);
  const refs = Object.entries(entry.refs);
  return (
    <li className="relative py-2.5 pl-5 text-sm">
      <span
        role="img"
        aria-label={STATUS_LABEL[entry.status]}
        className={cn(
          "absolute left-0 top-[15px] size-2 rounded-full",
          STATUS_DOT[entry.status],
        )}
      />
      <p className="font-medium">{entry.title}</p>
      <p className="text-xs text-muted-foreground">
        {formatDate(entry.at, user?.dateFormat)}{" "}
        {new Date(entry.at).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        })}
        {actor && ` · ${actor}`}
      </p>
      {entry.reason && (
        <p
          className={cn(
            "mt-0.5 text-xs",
            entry.status === "failed"
              ? "text-destructive"
              : "text-muted-foreground",
          )}
        >
          {entry.reason}
        </p>
      )}
      {refs.length > 0 && (
        <details className="mt-1 text-xs text-muted-foreground">
          <summary className="cursor-pointer select-none">Identifiers</summary>
          <dl className="mt-1 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5">
            {refs.map(([key, value]) => (
              <div key={key} className="contents">
                <dt>{REF_LABEL[key] ?? key}</dt>
                <dd className="break-all font-mono">{String(value)}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
    </li>
  );
}

/**
 * The invoice's activity trace, oldest first: how it arrived, every reading
 * and question rerun, corrections and actions with who took them, and each
 * destination with its outcome and the identifiers support needs. Loaded on
 * request; refreshed while something is still in progress.
 */
export function InvoiceActivity({ invoiceId }: { invoiceId: string }) {
  const trpc = useTRPC();
  const [open, setOpen] = useState(false);
  const { data, isLoading } = useQuery({
    ...trpc.inbox.activity.queryOptions({ id: invoiceId }),
    enabled: open,
    refetchInterval: (query) =>
      query.state.data?.entries.some((entry) => entry.status === "pending")
        ? 5000
        : false,
  });

  return (
    <section className="mt-7" aria-labelledby="invoice-activity">
      <div className="flex items-center justify-between gap-4">
        <h3 id="invoice-activity" className="text-sm font-semibold">
          Activity
        </h3>
        <Button
          variant="outline"
          size="sm"
          aria-expanded={open}
          aria-controls="invoice-activity-list"
          onClick={() => setOpen((value) => !value)}
        >
          {open ? "Hide" : "Show activity"}
        </Button>
      </div>
      {open && (
        <div id="invoice-activity-list">
          {isLoading && (
            <p className="mt-2 text-sm text-muted-foreground">Loading…</p>
          )}
          {data && (
            <>
              <ol className="mt-2 divide-y border-l pl-3">
                {data.entries.map((entry) => (
                  <ActivityEntry key={entry.id} entry={entry} />
                ))}
              </ol>
              {data.truncated && (
                <p className="mt-2 text-xs text-muted-foreground">
                  Only the most recent activity is shown.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
