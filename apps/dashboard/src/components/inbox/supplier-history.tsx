"use client";

import { useInboxParams } from "@/hooks/use-inbox-params";
import { useUserQuery } from "@/hooks/use-user";
import { useTRPC } from "@/trpc/client";
import { formatDate } from "@/utils/format";
import { Button } from "@invoicewise/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@invoicewise/ui/dialog";
import { Input } from "@invoicewise/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@invoicewise/ui/select";
import { Skeleton } from "@invoicewise/ui/skeleton";
import { useToast } from "@invoicewise/ui/use-toast";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { SupplierChecksView } from "./supplier-checks";

const NEW_SUPPLIER = "__new__";

const EVENT_LABEL: Record<string, string> = {
  assign_invoice: "Invoice reassigned",
  merge: "Suppliers merged",
  revert: "Change undone",
};

function describeEvent(event: {
  action: string;
  data: Record<string, unknown>;
}) {
  if (event.action === "merge") {
    return `${String(event.data.sourceName ?? "A supplier")} merged into ${String(event.data.targetName ?? "another supplier")}`;
  }
  if (event.action === "revert") {
    return `Undid a ${event.data.revertedAction === "merge" ? "merge" : "reassignment"}`;
  }
  return event.data.createdSupplier
    ? "Invoice moved to a new supplier"
    : "Invoice moved to another supplier";
}

/**
 * Who issued the invoice and what its supplier's history says about it
 * (known supplier, duplicate or revision, bank-detail changes), with the
 * earlier documents behind each answer. Admins can correct the supplier.
 */
export function SupplierHistory({ inboxId }: { inboxId: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { setParams } = useInboxParams();
  const { data: user } = useUserQuery();
  const [correcting, setCorrecting] = useState(false);
  const [target, setTarget] = useState<string>("");
  const [newName, setNewName] = useState("");
  const [mergeInto, setMergeInto] = useState<string>("");

  const { data, isLoading } = useQuery(
    trpc.suppliers.forInvoice.queryOptions({ inboxId }),
  );
  const suppliers = useQuery(
    trpc.suppliers.list.queryOptions(undefined, {
      enabled: correcting,
    }),
  );

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({
        queryKey: trpc.suppliers.forInvoice.queryKey({ inboxId }),
      }),
      queryClient.invalidateQueries({
        queryKey: trpc.suppliers.list.queryKey(),
      }),
      queryClient.invalidateQueries({
        queryKey: trpc.inbox.getById.queryKey({ id: inboxId }),
      }),
    ]);
  const done = (title: string) => () => {
    toast({ duration: 3500, variant: "success", title });
    setTarget("");
    setNewName("");
    setMergeInto("");
    return refresh();
  };
  const fail = (title: string) => (error: { message: string }) =>
    toast({
      duration: 5000,
      variant: "error",
      title,
      description: error.message,
    });

  const assign = useMutation(
    trpc.suppliers.assignInvoice.mutationOptions({
      onSuccess: done("Supplier changed"),
      onError: fail("The supplier could not be changed"),
    }),
  );
  const merge = useMutation(
    trpc.suppliers.merge.mutationOptions({
      onSuccess: done("Suppliers merged"),
      onError: fail("The suppliers could not be merged"),
    }),
  );
  const revert = useMutation(
    trpc.suppliers.revert.mutationOptions({
      onSuccess: done("Change undone"),
      onError: fail("The change could not be undone"),
    }),
  );
  const busy = assign.isPending || merge.isPending || revert.isPending;

  if (isLoading) return <Skeleton className="mt-3 h-24 w-full" />;
  if (!data) return null;

  const format = (value: string) => formatDate(value, user?.dateFormat);
  const current = data.supplier;
  const others = (suppliers.data ?? []).filter(
    (supplier) => supplier.id !== current?.id,
  );

  return (
    <div>
      <SupplierChecksView
        checks={data.checks}
        evidence={data.evidence}
        redeliveries={data.redeliveries}
        onOpenInvoice={(id) => setParams({ inboxId: id })}
        formatDate={format}
      />
      {data.canCorrect && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => setCorrecting(true)}
          >
            Correct supplier
          </Button>
        </div>
      )}

      <Dialog open={correcting} onOpenChange={setCorrecting}>
        <DialogContent className="max-w-lg">
          <div className="p-4">
            <DialogHeader>
              <DialogTitle>Correct the supplier</DialogTitle>
              <DialogDescription>
                Later invoices are compared with the supplier you choose. Every
                change is recorded and can be undone.
              </DialogDescription>
            </DialogHeader>

            <section className="mt-5 space-y-2">
              <h4 className="text-sm font-medium">
                Assign this invoice to another supplier
              </h4>
              <Select value={target} onValueChange={setTarget}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose a supplier" />
                </SelectTrigger>
                <SelectContent>
                  {others.map((supplier) => (
                    <SelectItem key={supplier.id} value={supplier.id}>
                      {supplier.name}
                      {supplier.vatKey ? ` · ${supplier.vatKey}` : ""} (
                      {supplier.invoiceCount})
                    </SelectItem>
                  ))}
                  <SelectItem value={NEW_SUPPLIER}>A new supplier…</SelectItem>
                </SelectContent>
              </Select>
              {target === NEW_SUPPLIER && (
                <Input
                  placeholder="New supplier name"
                  value={newName}
                  onChange={(event) => setNewName(event.target.value)}
                />
              )}
              <Button
                size="sm"
                disabled={
                  busy ||
                  !target ||
                  (target === NEW_SUPPLIER && newName.trim() === "")
                }
                onClick={() =>
                  assign.mutate(
                    target === NEW_SUPPLIER
                      ? { inboxId, newSupplierName: newName.trim() }
                      : { inboxId, supplierId: target },
                  )
                }
              >
                Assign
              </Button>
            </section>

            {current && (
              <section className="mt-6 space-y-2">
                <h4 className="text-sm font-medium">
                  Merge {current.name} into another supplier
                </h4>
                <p className="text-xs leading-5 text-muted-foreground">
                  Use this when both are the same business. All of{" "}
                  {current.name}'s invoices then count as the other supplier's
                  history.
                </p>
                <Select value={mergeInto} onValueChange={setMergeInto}>
                  <SelectTrigger>
                    <SelectValue placeholder="Choose the supplier to keep" />
                  </SelectTrigger>
                  <SelectContent>
                    {others.map((supplier) => (
                      <SelectItem key={supplier.id} value={supplier.id}>
                        {supplier.name}
                        {supplier.vatKey ? ` · ${supplier.vatKey}` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || !mergeInto}
                  onClick={() =>
                    merge.mutate({
                      sourceId: current.id,
                      targetId: mergeInto,
                      inboxId,
                    })
                  }
                >
                  Merge
                </Button>
              </section>
            )}

            {data.events.length > 0 && (
              <section className="mt-6">
                <h4 className="text-sm font-medium">Changes</h4>
                <ul className="mt-2 divide-y border-t text-xs">
                  {data.events.map((event) => (
                    <li
                      key={event.id}
                      className="flex items-center justify-between gap-3 py-2"
                    >
                      <div className="min-w-0">
                        <p className="font-medium">
                          {EVENT_LABEL[event.action] ?? event.action}
                        </p>
                        <p className="text-muted-foreground">
                          {describeEvent(event)} ·{" "}
                          {event.actor?.fullName ??
                            event.actor?.email ??
                            "a former member"}{" "}
                          · {format(event.createdAt)}
                          {event.revertedAt ? " · undone" : ""}
                        </p>
                      </div>
                      {event.action !== "revert" && !event.revertedAt && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() =>
                            revert.mutate({ eventId: event.id, inboxId })
                          }
                        >
                          Undo
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
