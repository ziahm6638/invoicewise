"use client";

import { actorLabel } from "@/components/inbox/invoice-activity";
import { useUserQuery } from "@/hooks/use-user";
import { useTRPC } from "@/trpc/client";
import { formatDate } from "@/utils/format";
import type { RouterOutputs } from "@api/trpc/routers/_app";
import { Badge } from "@invoicewise/ui/badge";
import { Button } from "@invoicewise/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@invoicewise/ui/select";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";

type AuditEvent = RouterOutputs["audit"]["list"]["data"][number];

const ALL = "__all__";

const CATEGORIES = [
  ["invoice", "Invoices"],
  ["delivery", "Delivery"],
  ["question", "Questions"],
  ["supplier", "Suppliers"],
  ["authorization_source", "Authorization sources"],
  ["integration", "Integrations"],
  ["access", "Keys and members"],
  ["workspace", "Workspace"],
  ["operator", "InvoiceWise operators"],
] as const;

const OUTCOME: Record<
  AuditEvent["outcome"],
  {
    label: string;
    variant: "default" | "secondary" | "destructive" | "outline";
  }
> = {
  succeeded: { label: "Done", variant: "secondary" },
  refused: { label: "Refused", variant: "outline" },
  denied: { label: "Not permitted", variant: "destructive" },
  failed: { label: "Failed", variant: "destructive" },
  started: { label: "Outcome unknown", variant: "outline" },
};

const TARGET: Record<string, string> = {
  invoice: "Invoice",
  webhook_endpoint: "Webhook",
  webhook_delivery: "Webhook delivery",
  api_key: "API key",
  user: "Member",
  invitation: "Invitation",
  question: "Question",
  supplier: "Supplier",
  supplier_event: "Supplier change",
  authorization_source: "Authorization source",
  oauth_application: "Application",
  mailbox: "Mailbox",
  data_export: "Export",
  workspace: "Workspace",
  job: "Job",
};

/** A readable summary of an event's recorded detail (no values it lacks). */
const detailText = (detail: AuditEvent["detail"]) =>
  Object.entries(detail ?? {})
    .filter(([, value]) => value !== null && value !== "" && value !== false)
    .slice(0, 6)
    .map(
      ([key, value]) =>
        `${key}: ${Array.isArray(value) ? value.join(", ") : typeof value === "object" ? JSON.stringify(value) : String(value)}`,
    )
    .join(" · ");

function AuditRow({ event }: { event: AuditEvent }) {
  const { data: user } = useUserQuery();
  const outcome = OUTCOME[event.outcome];
  const detail = detailText(event.detail);
  return (
    <li className="py-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium">{event.label}</p>
        <Badge variant={outcome.variant}>{outcome.label}</Badge>
      </div>
      <p className="text-xs text-muted-foreground">
        {formatDate(event.at, user?.dateFormat)}{" "}
        {new Date(event.at).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        })}{" "}
        · {actorLabel({ ...event.actor, id: event.actor.id }) ?? "Unknown"}
        {event.surface === "api" && " · API"}
        {event.target &&
          ` · ${TARGET[event.target.type] ?? event.target.type}${event.revision !== null ? ` (revision ${event.revision})` : ""}`}
      </p>
      {event.purpose && (
        <p className="mt-0.5 text-xs">Purpose: {event.purpose}</p>
      )}
      {detail && (
        <p className="mt-0.5 break-words text-xs text-muted-foreground">
          {detail}
        </p>
      )}
      <details className="mt-1 text-xs text-muted-foreground">
        <summary className="cursor-pointer select-none">Identifiers</summary>
        <p className="mt-1 break-all font-mono">
          event {event.id}
          {event.target?.id && ` · ${event.target.type} ${event.target.id}`}
          {event.actor.credentialId &&
            ` · credential ${event.actor.credentialId}`}
        </p>
      </details>
    </li>
  );
}

/**
 * Who changed what in the workspace, newest first, with the outcome of each
 * action, including refused attempts and every InvoiceWise operator action
 * or access to the workspace's records. Owners and admins only.
 */
export function AuditLog() {
  const trpc = useTRPC();
  const [category, setCategory] = useState<string>(ALL);
  const query = useInfiniteQuery(
    trpc.audit.list.infiniteQueryOptions(
      {
        categories: category === ALL ? undefined : [category as never],
        limit: 50,
      },
      { getNextPageParam: (page) => page.nextCursor },
    ),
  );
  const events = query.data?.pages.flatMap((page) => page.data) ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-medium">Audit log</h2>
          <p className="text-sm text-muted-foreground">
            Changes to invoices, questions, integrations, keys and members,
            delivery actions, and every InvoiceWise operator action or access to
            this workspace. Kept for a year. An operator&apos;s name is the one
            they declared, not an authenticated identity; the token fingerprint
            identifies the operator credential used.
          </p>
        </div>
        <Select value={category} onValueChange={setCategory}>
          <SelectTrigger className="w-[210px]" aria-label="Category">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All activity</SelectItem>
            {CATEGORIES.map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : events.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing has been recorded yet.
        </p>
      ) : (
        <ol className="divide-y border-y">
          {events.map((event) => (
            <AuditRow key={event.id} event={event} />
          ))}
        </ol>
      )}

      {query.hasNextPage && (
        <Button
          variant="outline"
          size="sm"
          disabled={query.isFetchingNextPage}
          onClick={() => query.fetchNextPage()}
        >
          Load more
        </Button>
      )}
    </div>
  );
}
