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
import { cn } from "@invoicewise/ui/cn";
import { useToast } from "@invoicewise/ui/use-toast";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  LoaderCircle,
  PencilLine,
  RefreshCw,
  XCircle,
} from "lucide-react";
import {
  type WorkflowStageStatus,
  describeInvoiceWorkflow,
  getInvoiceState,
} from "./invoice-state";

export type InvoiceDetail = NonNullable<RouterOutputs["inbox"]["getById"]>;

const PROVIDER_NAME: Record<string, string> = {
  xero: "Xero",
  quickbooks: "QuickBooks",
};

/** Every query that shows an invoice, refreshed after an action on it. */
export function useInvalidateInvoice() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  return (id: string) =>
    Promise.all([
      queryClient.invalidateQueries({
        queryKey: trpc.inbox.getById.queryKey({ id }),
      }),
      queryClient.invalidateQueries({
        queryKey: trpc.inbox.delivery.queryKey({ id }),
      }),
      queryClient.invalidateQueries({
        queryKey: trpc.inbox.history.queryKey({ id }),
      }),
      queryClient.invalidateQueries({ queryKey: trpc.inbox.get.queryKey() }),
    ]);
}

const stageIcon: Record<WorkflowStageStatus, typeof Circle> = {
  done: CheckCircle2,
  in_progress: LoaderCircle,
  attention: AlertTriangle,
  failed: XCircle,
  not_started: Circle,
};

const stageTone: Record<WorkflowStageStatus, string> = {
  done: "text-emerald-700 dark:text-emerald-300",
  in_progress: "text-sky-700 dark:text-sky-300",
  attention: "text-amber-700 dark:text-amber-300",
  failed: "text-destructive",
  not_started: "text-muted-foreground",
};

function ConfirmAction({
  label,
  icon: Icon,
  title,
  consequences,
  confirm,
  disabled,
  pending,
  onConfirm,
}: {
  label: string;
  icon: typeof Circle;
  title: string;
  consequences: string[];
  confirm: string;
  disabled: boolean;
  pending: boolean;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm" disabled={disabled || pending}>
          <Icon
            aria-hidden
            className={cn("mr-2 size-3.5", pending && "animate-spin")}
          />
          {label}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <ul className="list-disc space-y-1.5 pl-5 text-sm">
              {consequences.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>{confirm}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * Where the invoice stands (extraction, validation, questions, delivery),
 * why, and what may be done next: correct it, read it again, or answer its
 * questions again. Each action names the revision on screen, so a second
 * click or another tab cannot apply it twice.
 */
export function InvoiceWorkflow({
  invoice,
  editing,
  onCorrect,
}: {
  invoice: InvoiceDetail;
  editing: boolean;
  onCorrect: () => void;
}) {
  const trpc = useTRPC();
  const { toast } = useToast();
  const invalidate = useInvalidateInvoice();
  const stages = describeInvoiceWorkflow(invoice);
  const state = getInvoiceState(invoice);
  const provider = invoice.accountingProvider
    ? PROVIDER_NAME[invoice.accountingProvider]
    : null;
  const posted = Boolean(invoice.accountingProviderId);
  const corrections = invoice.correctionCount ?? 0;
  const busy = state === "processing";
  const readable = !busy && state !== "failed";
  const onError = (error: { message: string }) => {
    toast({
      title: "Not done",
      description: error.message,
      variant: "error",
    });
    void invalidate(invoice.id);
  };

  const reextract = useMutation(
    trpc.inbox.retry.mutationOptions({
      onSuccess: async (result) => {
        await invalidate(invoice.id);
        toast({
          title: result.deduplicated
            ? "Already being read again"
            : "Reading the document again",
          variant: "success",
        });
      },
      onError,
    }),
  );
  const rerun = useMutation(
    trpc.inbox.rerunQuestions.mutationOptions({
      onSuccess: async (result) => {
        await invalidate(invoice.id);
        toast({
          title: result.deduplicated
            ? "The questions are already being answered again"
            : "Answering the questions again",
          variant: "success",
        });
      },
      onError,
    }),
  );

  const accountingLine = posted
    ? `The bill already in ${provider ?? "your accounting software"} is not changed or sent again. If the new reading differs, correct the invoice and choose to update that bill.`
    : invoice.accountingPostStatus === "failed" ||
        invoice.accountingPostStatus === "needs_review" ||
        invoice.accountingPostStatus === "cancelled"
      ? "If an accounting connection is active and the new reading passes validation, it is sent to accounting again."
      : "If an accounting connection is active, the new reading is sent to accounting once it passes validation.";

  return (
    <section aria-labelledby="invoice-workflow" className="mb-7">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 id="invoice-workflow" className="text-sm font-semibold">
          Status and next steps
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant={editing ? "secondary" : "outline"}
            size="sm"
            disabled={!readable}
            onClick={onCorrect}
          >
            <PencilLine aria-hidden className="mr-2 size-3.5" />
            {editing ? "Cancel correction" : "Correct fields"}
          </Button>
          <ConfirmAction
            label="Rerun questions"
            icon={RefreshCw}
            title="Answer the questions again?"
            consequences={[
              "Your workspace's questions are answered again for the invoice as it is now, including any corrections.",
              "Webhook endpoints receive the new answers as a new revision.",
              "Extracted fields and the accounting bill are not changed.",
            ]}
            confirm="Rerun questions"
            disabled={
              !readable || invoice.judgmentsRerunStatus === "queued" || editing
            }
            pending={rerun.isPending}
            onConfirm={() =>
              rerun.mutate({
                id: invoice.id,
                revision: invoice.processingRevision,
              })
            }
          />
          <ConfirmAction
            label="Re-extract"
            icon={RefreshCw}
            title="Read the document again?"
            consequences={[
              corrections
                ? `The stored document is read again and replaces the current fields, including ${corrections === 1 ? "your correction" : `your ${corrections} corrections`}. The history keeps them.`
                : "The stored document is read again and replaces the extracted fields.",
              "Validation and the questions run again, and webhook endpoints receive the new reading.",
              accountingLine,
            ]}
            confirm="Re-extract"
            disabled={busy || editing}
            pending={reextract.isPending}
            onConfirm={() =>
              reextract.mutate({
                id: invoice.id,
                revision: invoice.processingRevision,
              })
            }
          />
        </div>
      </div>
      <ol className="mt-3 divide-y border">
        {stages.map((stage) => {
          const Icon = stageIcon[stage.status];
          return (
            <li key={stage.key} className="flex gap-3 px-3 py-2.5">
              <Icon
                aria-hidden
                className={cn(
                  "mt-0.5 size-4 shrink-0",
                  stageTone[stage.status],
                  stage.status === "in_progress" && "animate-spin",
                )}
              />
              <div className="min-w-0 text-sm">
                <p>
                  <span className="font-medium">{stage.label}</span>
                  <span className="text-muted-foreground">
                    {" "}
                    · {stage.summary}
                  </span>
                </p>
                {stage.next && (
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Next: {stage.next}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
