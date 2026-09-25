"use client";

import { useTRPC } from "@/trpc/client";
import type {
  RouterInputs,
  RouterOutputs,
} from "@invoicewise/api/trpc/routers/_app";
import type { InvoiceJudgment } from "@invoicewise/documents";
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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { answerFor, cautionFor, provenanceFor } from "./inbox/answer-format";

// Mirrors QUESTION_LIMITS in @invoicewise/documents; the server enforces them.
const MAX_PREVIEW = 5;
const MAX_RERUN = 25;

type QuestionInput = RouterInputs["questions"]["create"];
type PreviewResult = RouterOutputs["questions"]["preview"][number];

function Answer({ judgment }: { judgment: InvoiceJudgment | null }) {
  if (!judgment) {
    return <p className="text-xs text-muted-foreground">No answer yet</p>;
  }
  const caution = cautionFor(judgment);
  const detail =
    judgment.status === "failed"
      ? judgment.error
      : judgment.status === "unknown" || judgment.status === "not_applicable"
        ? judgment.reason
        : judgment.status === "answered" && judgment.type === "number"
          ? `Read from: “${judgment.evidence.text}”`
          : null;
  return (
    <div className="space-y-0.5">
      <p
        className={
          judgment.status === "failed"
            ? "text-sm font-medium text-destructive"
            : "text-sm font-semibold"
        }
      >
        {answerFor(judgment)}
      </p>
      {caution && (
        <p className="text-xs text-amber-700 dark:text-amber-400">{caution}</p>
      )}
      {detail && <p className="text-xs text-muted-foreground">{detail}</p>}
      {judgment.limits?.map((limit) => (
        <p key={limit} className="text-xs text-amber-700 dark:text-amber-400">
          {limit}
        </p>
      ))}
      {provenanceFor(judgment) && (
        <p className="text-[11px] text-muted-foreground">
          {provenanceFor(judgment)}
        </p>
      )}
    </div>
  );
}

const runStatus = (run: RouterOutputs["questions"]["runs"][number]) => {
  if (run.status === "queued" || run.status === "running") {
    return `Rerunning v${run.questionVersion} on ${run.invoiceIds.length} invoice${run.invoiceIds.length === 1 ? "" : "s"}…`;
  }
  const counts = [
    `${run.answered} answered`,
    run.unknown ? `${run.unknown} unknown` : null,
    run.failed ? `${run.failed} could not be answered` : null,
    run.skipped ? `${run.skipped} skipped` : null,
  ]
    .filter(Boolean)
    .join(", ");
  return run.status === "failed" || run.status === "cancelled"
    ? `v${run.questionVersion} rerun ${run.status === "cancelled" ? "cancelled" : "stopped"}: ${run.error ?? "unknown reason"} (${counts})`
    : `v${run.questionVersion} rerun finished: ${counts}`;
};

/**
 * Tries a question on invoices already processed. A preview answers a saved
 * question or an unsaved draft and changes nothing; a rerun (saved, enabled
 * questions only) records the latest revision's answers and keeps the ones
 * they replace.
 */
export function QuestionPreview({
  questionKey,
  draft,
  canRerun,
}: {
  questionKey?: string;
  draft?: QuestionInput | null;
  canRerun: boolean;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [selected, setSelected] = useState<string[]>([]);
  const [results, setResults] = useState<PreviewResult[] | null>(null);
  const invoices = useQuery(trpc.questions.invoices.queryOptions());
  const runs = useQuery({
    ...trpc.questions.runs.queryOptions({ questionKey: questionKey ?? "" }),
    enabled: Boolean(questionKey),
    refetchInterval: (query) =>
      query.state.data?.some(
        (run) => run.status === "queued" || run.status === "running",
      )
        ? 3000
        : false,
  });
  const reportError = (error: { message: string }) =>
    toast({
      title: "Question could not be run",
      description: error.message,
      variant: "destructive",
    });
  const preview = useMutation(
    trpc.questions.preview.mutationOptions({
      onSuccess: (data) => setResults(data as PreviewResult[]),
      onError: reportError,
    }),
  );
  const rerun = useMutation(
    trpc.questions.rerun.mutationOptions({
      onSuccess: async () => {
        toast({
          title: "Rerun started",
          description:
            "New answers appear on each invoice as they are recorded.",
        });
        await queryClient.invalidateQueries({
          queryKey: trpc.questions.runs.queryKey(),
        });
      },
      onError: reportError,
    }),
  );

  const toggle = (id: string, checked: boolean) =>
    setSelected((current) =>
      checked
        ? current.length >= MAX_RERUN || current.includes(id)
          ? current
          : [...current, id]
        : current.filter((value) => value !== id),
    );
  const activeRun = runs.data?.some(
    (run) => run.status === "queued" || run.status === "running",
  );

  return (
    <div className="space-y-4 border-t bg-secondary/10 px-6 py-5">
      <div>
        <p className="text-sm font-medium">Try it on invoices</p>
        <p className="mt-1 text-xs text-muted-foreground">
          A preview answers on up to {MAX_PREVIEW} invoices and changes nothing.
          A rerun records new answers on up to {MAX_RERUN}, keeps the ones they
          replace, and never posts to accounting again.
        </p>
      </div>

      {invoices.isLoading ? (
        <p className="text-xs text-muted-foreground">Loading invoices…</p>
      ) : invoices.data?.length ? (
        <ul className="max-h-56 divide-y overflow-y-auto rounded-md border">
          {invoices.data.map((invoice) => (
            <li key={invoice.id} className="flex items-center gap-3 px-3 py-2">
              <Checkbox
                id={`pick-${questionKey ?? "draft"}-${invoice.id}`}
                checked={selected.includes(invoice.id)}
                onCheckedChange={(checked) =>
                  toggle(invoice.id, checked === true)
                }
              />
              <label
                htmlFor={`pick-${questionKey ?? "draft"}-${invoice.id}`}
                className="flex min-w-0 flex-1 justify-between gap-3 text-sm"
              >
                <span className="truncate">
                  {invoice.displayName ?? invoice.fileName ?? "Invoice"}
                </span>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {invoice.date ?? ""}
                  {invoice.amount !== null && invoice.currency
                    ? ` · ${new Intl.NumberFormat("en-GB", {
                        style: "currency",
                        currency: invoice.currency,
                      }).format(invoice.amount)}`
                    : ""}
                </span>
              </label>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">
          No processed invoices yet.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={
            selected.length === 0 ||
            selected.length > MAX_PREVIEW ||
            preview.isPending ||
            (!questionKey && !draft)
          }
          onClick={() =>
            preview.mutate({
              ...(questionKey ? { questionKey } : {}),
              ...(draft ? { draft } : {}),
              invoiceIds: selected,
            } as RouterInputs["questions"]["preview"])
          }
        >
          {preview.isPending
            ? "Previewing…"
            : selected.length === 0
              ? "Preview"
              : `Preview on ${selected.length} invoice${selected.length === 1 ? "" : "s"}`}
        </Button>
        {canRerun && questionKey && (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                type="button"
                size="sm"
                disabled={
                  selected.length === 0 || rerun.isPending || Boolean(activeRun)
                }
              >
                Rerun on selected
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  Rerun this question on {selected.length} invoice
                  {selected.length === 1 ? "" : "s"}?
                </AlertDialogTitle>
                <AlertDialogDescription>
                  The latest version of the question answers again. Each new
                  answer replaces the current one, which stays under Earlier
                  answers. Subscribed webhooks receive one
                  invoice.judgments.attached event per invoice. Nothing is
                  posted to accounting and invoice.processed is not sent again.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() =>
                    rerun.mutate({ questionKey, invoiceIds: selected })
                  }
                >
                  Rerun
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
        {selected.length > MAX_PREVIEW && (
          <p className="text-xs text-muted-foreground">
            Preview takes at most {MAX_PREVIEW} invoices.
          </p>
        )}
      </div>

      {results && (
        <ul className="divide-y rounded-md border">
          {results.map((result) => (
            <li
              key={result.invoiceId}
              className="grid gap-3 px-3 py-3 md:grid-cols-[1fr_1fr_1fr]"
            >
              <p className="text-sm font-medium">
                {result.invoice?.displayName ??
                  result.invoice?.fileName ??
                  "Invoice"}
              </p>
              {result.unavailable ? (
                <p className="text-xs text-muted-foreground md:col-span-2">
                  {result.unavailable}
                </p>
              ) : (
                <>
                  <div>
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                      Current
                    </p>
                    <Answer
                      judgment={result.current as InvoiceJudgment | null}
                    />
                  </div>
                  <div>
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                      Preview
                    </p>
                    <Answer
                      judgment={result.preview as InvoiceJudgment | null}
                    />
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {runs.data && runs.data.length > 0 && (
        <ul className="space-y-1">
          {runs.data.slice(0, 3).map((run) => (
            <li key={run.id} className="text-xs text-muted-foreground">
              {runStatus(run)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
