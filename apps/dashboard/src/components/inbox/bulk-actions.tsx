"use client";

import { useTRPC } from "@/trpc/client";
import type { RouterOutputs } from "@api/trpc/routers/_app";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@invoicewise/ui/alert-dialog";
import { Button } from "@invoicewise/ui/button";
import { Checkbox } from "@invoicewise/ui/checkbox";
import { useToast } from "@invoicewise/ui/use-toast";
import { useMutation, useQueryClient } from "@tanstack/react-query";

type Invoice = RouterOutputs["inbox"]["get"]["data"][number];
type Action = "reextract" | "rerun_questions" | "retry_delivery";

const actionLabel: Record<Action, string> = {
  reextract: "Re-extract",
  rerun_questions: "Rerun questions",
  retry_delivery: "Retry delivery",
};

/**
 * Select-all for the loaded invoices and the actions that apply to a
 * selection. Each invoice is acted on at the revision the list shows, so a
 * selection that went stale is reported per invoice instead of applied.
 */
export function BulkActions({
  invoices,
  selected,
  onSelectedChange,
}: {
  invoices: Invoice[];
  selected: ReadonlySet<string>;
  onSelectedChange: (selected: ReadonlySet<string>) => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const chosen = invoices.filter((invoice) => selected.has(invoice.id));
  const allLoaded =
    invoices.length > 0 &&
    invoices.every((invoice) => selected.has(invoice.id));

  const bulk = useMutation(
    trpc.inbox.bulkAction.mutationOptions({
      onSuccess: async ({ action, results }) => {
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: trpc.inbox.get.queryKey(),
          }),
          queryClient.invalidateQueries({
            queryKey: trpc.inbox.getById.queryKey(),
          }),
          queryClient.invalidateQueries({
            queryKey: trpc.inbox.delivery.queryKey(),
          }),
        ]);
        const failed = results.filter((result) => !result.ok);
        const done = results.length - failed.length;
        toast({
          title: `${actionLabel[action as Action]}: ${done} of ${results.length} started`,
          description: failed.length
            ? `${failed.length} not started. ${failed[0]?.error ?? ""}`
            : undefined,
          variant: failed.length ? "error" : "success",
        });
        onSelectedChange(new Set(failed.map((result) => result.id)));
      },
      onError: (error) =>
        toast({
          title: "Bulk action failed",
          description: error.message,
          variant: "error",
        }),
    }),
  );

  const run = (action: Action) =>
    bulk.mutate({
      action,
      items: chosen.slice(0, 50).map((invoice) => ({
        id: invoice.id,
        revision: invoice.processingRevision,
      })),
    });

  return (
    <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
      <Checkbox
        checked={allLoaded ? true : chosen.length ? "indeterminate" : false}
        onCheckedChange={(value) =>
          onSelectedChange(
            value === true
              ? new Set(invoices.map((invoice) => invoice.id))
              : new Set(),
          )
        }
        aria-label="Select all loaded invoices"
      />
      {chosen.length === 0 ? (
        <span className="text-xs text-muted-foreground">
          {invoices.length} loaded
        </span>
      ) : (
        <>
          <span className="text-xs font-medium">
            {chosen.length} selected
            {chosen.length > 50 && " (first 50 are acted on)"}
          </span>
          <div className="ml-auto flex flex-wrap gap-1.5">
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-xs"
                  disabled={bulk.isPending}
                >
                  {actionLabel.reextract}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    Read{" "}
                    {chosen.length === 1
                      ? "this invoice"
                      : `${Math.min(chosen.length, 50)} invoices`}{" "}
                    again?
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    Each stored document is read again and replaces its
                    extracted fields, including any corrections (the history
                    keeps them). Bills already in your accounting software are
                    not changed or sent again.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={() => run("reextract")}>
                    Re-extract
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
            {(["rerun_questions", "retry_delivery"] as const).map((action) => (
              <Button
                key={action}
                size="sm"
                variant="outline"
                className="h-7 px-2 text-xs"
                disabled={bulk.isPending}
                onClick={() => run(action)}
              >
                {actionLabel[action]}
              </Button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
