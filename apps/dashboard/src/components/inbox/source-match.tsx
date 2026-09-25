"use client";

import { useUserQuery } from "@/hooks/use-user";
import { useTRPC } from "@/trpc/client";
import { formatDate } from "@/utils/format";
import { Button } from "@invoicewise/ui/button";
import { Checkbox } from "@invoicewise/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@invoicewise/ui/dialog";
import { Input } from "@invoicewise/ui/input";
import { Label } from "@invoicewise/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@invoicewise/ui/select";
import { Skeleton } from "@invoicewise/ui/skeleton";
import { Textarea } from "@invoicewise/ui/textarea";
import { useToast } from "@invoicewise/ui/use-toast";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ReconciliationView } from "./reconciliation-view";
import { type SourceMatchDecision, SourceMatchView } from "./source-match-view";

const UNALLOCATED = "__none__";

const money = (amount: string, currency: string | null) => {
  const value = Number(amount);
  if (!currency || !Number.isFinite(value))
    return `${amount} ${currency ?? ""}`.trim();
  try {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency,
    }).format(value);
  } catch {
    return `${amount} ${currency}`;
  }
};

type InvoiceLine = { description: string | null; total: number | null };

/**
 * The invoice's match to jobs, purchase orders and contracts. Every member
 * sees the decision and its evidence; owners and admins confirm, change or
 * unlink it, and anyone may ask for automatic matching again (replacing an
 * admin's decision needs an admin).
 */
export function SourceMatch({
  inboxId,
  lines,
}: {
  inboxId: string;
  lines: InvoiceLine[];
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: user } = useUserQuery();
  const [changing, setChanging] = useState(false);
  const [unlinking, setUnlinking] = useState(false);
  const [search, setSearch] = useState("");
  const [chosen, setChosen] = useState<
    { id: string; type: string; reference: string }[]
  >([]);
  const [lineTargets, setLineTargets] = useState<Record<number, string>>({});
  const [reason, setReason] = useState("");

  const { data, isLoading } = useQuery({
    ...trpc.sourceMatches.forInvoice.queryOptions({ inboxId }),
    // A newer decision or revision is shown as reconciling until it is.
    refetchInterval: (query) =>
      query.state.data?.reconciliation.reconciling ? 3000 : false,
  });
  const sources = useQuery(
    trpc.authorizationSources.list.queryOptions(
      { q: search.trim() || null, pageSize: 20 },
      { enabled: changing },
    ),
  );

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({
        queryKey: trpc.sourceMatches.forInvoice.queryKey({ inboxId }),
      }),
      queryClient.invalidateQueries({
        queryKey: trpc.inbox.getById.queryKey({ id: inboxId }),
      }),
    ]);
  const done = (title: string) => () => {
    toast({ duration: 3500, variant: "success", title });
    setChanging(false);
    setUnlinking(false);
    setChosen([]);
    setLineTargets({});
    setReason("");
    return refresh();
  };
  const fail = (title: string) => (error: { message: string }) =>
    toast({
      duration: 6000,
      variant: "error",
      title,
      description: error.message,
    });

  const confirm = useMutation(
    trpc.sourceMatches.confirm.mutationOptions({
      onSuccess: done("Match confirmed"),
      onError: fail("The match could not be confirmed"),
    }),
  );
  const link = useMutation(
    trpc.sourceMatches.link.mutationOptions({
      onSuccess: done("Match saved"),
      onError: fail("The match could not be saved"),
    }),
  );
  const unlink = useMutation(
    trpc.sourceMatches.unlink.mutationOptions({
      onSuccess: done("Invoice unlinked"),
      onError: fail("The invoice could not be unlinked"),
    }),
  );
  const busy = confirm.isPending || link.isPending || unlink.isPending;

  if (isLoading) return <Skeleton className="mt-3 h-24 w-full" />;
  if (!data) return null;

  const current = data.current as unknown as SourceMatchDecision | null;
  const history = data.history as unknown as SourceMatchDecision[];
  const format = (value: string | Date) => formatDate(value, user?.dateFormat);
  const expectedMatchId = current?.id ?? null;

  const openChange = (preselect?: string) => {
    const candidate = current?.candidates.find(
      (item) => item.sourceId === preselect,
    );
    setChosen(
      candidate
        ? [
            {
              id: candidate.sourceId,
              type: candidate.type,
              reference: candidate.reference,
            },
          ]
        : (current?.links ?? []).map((item) => ({
            id: item.sourceId,
            type: item.type,
            reference: item.reference,
          })),
    );
    setLineTargets({});
    setReason("");
    setChanging(true);
  };
  const toggle = (source: { id: string; type: string; reference: string }) =>
    setChosen((selected) =>
      selected.some((item) => item.id === source.id)
        ? selected.filter((item) => item.id !== source.id)
        : [...selected, source],
    );
  const allocations =
    chosen.length > 1
      ? Object.entries(lineTargets)
          .filter(([, sourceId]) => sourceId !== UNALLOCATED)
          .map(([index, sourceId]) => ({
            sourceId,
            invoiceLineIndex: Number(index),
          }))
      : null;

  const actions = (
    <div className="flex flex-wrap gap-2 border-t py-3">
      {data.canDecide &&
        current?.status === "matched" &&
        current.origin === "automatic" && (
          <Button
            size="sm"
            disabled={busy}
            onClick={() => confirm.mutate({ inboxId, expectedMatchId })}
          >
            Confirm match
          </Button>
        )}
      {data.canDecide && data.processed && (
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => openChange()}
        >
          {current?.links.length ? "Change sources" : "Link a source"}
        </Button>
      )}
      {data.canDecide && current && current.status !== "unmatched" && (
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => {
            setReason("");
            setUnlinking(true);
          }}
        >
          No source applies
        </Button>
      )}
    </div>
  );

  return (
    <div>
      <SourceMatchView
        current={current}
        history={history}
        processed={data.processed}
        formatDate={format}
        formatAmount={money}
        invoiceLines={lines.map((line) => line.description)}
        onChoose={data.canDecide ? openChange : undefined}
        reconciliation={
          <ReconciliationView
            reconciliation={data.reconciliation}
            formatDate={format}
            formatAmount={money}
            invoiceLines={lines.map((line) => line.description)}
          />
        }
        actions={actions}
      />

      <Dialog open={changing} onOpenChange={setChanging}>
        <DialogContent className="max-w-lg">
          <form
            className="p-4"
            onSubmit={(event) => {
              event.preventDefault();
              link.mutate({
                inboxId,
                expectedMatchId,
                reason: reason.trim() || null,
                sources: chosen.map((source) => ({ sourceId: source.id })),
                allocations,
              });
            }}
          >
            <DialogHeader>
              <DialogTitle>Link authorization sources</DialogTitle>
              <DialogDescription>
                Choose the jobs, purchase orders or contracts this invoice
                bills. Each is compared at the version in effect on the invoice
                date. The current decision is kept in the history.
              </DialogDescription>
            </DialogHeader>

            <div className="mt-4 space-y-2">
              <Label htmlFor="source-search">Find a source</Label>
              <Input
                id="source-search"
                placeholder="Reference, title or supplier"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              <ul className="max-h-56 divide-y overflow-y-auto rounded border">
                {(sources.data?.data ?? []).map((source) => (
                  <li key={source.id} className="flex items-center gap-2 p-2">
                    <Checkbox
                      id={`source-${source.id}`}
                      checked={chosen.some((item) => item.id === source.id)}
                      disabled={source.status === "cancelled"}
                      onCheckedChange={() => toggle(source)}
                    />
                    <Label
                      htmlFor={`source-${source.id}`}
                      className="min-w-0 text-sm font-normal"
                    >
                      <span className="font-medium">{source.reference}</span>
                      {source.title ? ` · ${source.title}` : ""}
                      <span className="block text-xs text-muted-foreground">
                        {source.supplier?.name ??
                          source.suppliedSupplierName ??
                          "Unknown supplier"}{" "}
                        · {source.status}
                      </span>
                    </Label>
                  </li>
                ))}
                {sources.data?.data.length === 0 && (
                  <li className="p-2 text-sm text-muted-foreground">
                    No sources found.
                  </li>
                )}
              </ul>
            </div>

            {chosen.length > 0 && (
              <p className="mt-3 text-sm">
                Chosen: {chosen.map((source) => source.reference).join(", ")}
              </p>
            )}

            {chosen.length > 1 && lines.length > 0 && (
              <fieldset className="mt-4 space-y-2">
                <legend className="text-sm font-medium">
                  Which source does each line bill?
                </legend>
                {lines.map((line, index) => (
                  <div
                    // biome-ignore lint/suspicious/noArrayIndexKey: invoice lines have no id
                    key={index}
                    className="flex items-center justify-between gap-3"
                  >
                    <span className="min-w-0 truncate text-sm">
                      {index + 1}. {line.description ?? "Line"}
                    </span>
                    <Select
                      value={lineTargets[index] ?? UNALLOCATED}
                      onValueChange={(value) =>
                        setLineTargets((targets) => ({
                          ...targets,
                          [index]: value,
                        }))
                      }
                    >
                      <SelectTrigger className="w-40">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={UNALLOCATED}>
                          Not allocated
                        </SelectItem>
                        {chosen.map((source) => (
                          <SelectItem key={source.id} value={source.id}>
                            {source.reference}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </fieldset>
            )}

            <div className="mt-4 space-y-2">
              <Label htmlFor="match-reason">Reason</Label>
              <Textarea
                id="match-reason"
                placeholder="Why this is the right source (required when replacing a match)"
                value={reason}
                maxLength={1000}
                onChange={(event) => setReason(event.target.value)}
              />
            </div>

            <div className="mt-4 flex justify-end">
              <Button type="submit" disabled={busy || chosen.length === 0}>
                Save match
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={unlinking} onOpenChange={setUnlinking}>
        <DialogContent className="max-w-md">
          <form
            className="p-4"
            onSubmit={(event) => {
              event.preventDefault();
              unlink.mutate({
                inboxId,
                expectedMatchId,
                reason: reason.trim(),
              });
            }}
          >
            <DialogHeader>
              <DialogTitle>No source applies</DialogTitle>
              <DialogDescription>
                Records that this invoice bills no job, purchase order or
                contract. Processing it again keeps this decision.
              </DialogDescription>
            </DialogHeader>
            <div className="mt-4 space-y-2">
              <Label htmlFor="unlink-reason">Reason</Label>
              <Textarea
                id="unlink-reason"
                required
                maxLength={1000}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </div>
            <div className="mt-4 flex justify-end">
              <Button type="submit" disabled={busy || reason.trim() === ""}>
                Save
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
