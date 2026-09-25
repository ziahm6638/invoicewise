"use client";

import { useTRPC } from "@/trpc/client";
import type { InvoiceJudgment } from "@invoicewise/documents";
import { useQuery } from "@tanstack/react-query";
import { answerFor, cautionFor, provenanceFor } from "./answer-format";

/**
 * Answers a deliberate rerun replaced on this invoice. Each keeps the
 * question wording, revision and evaluator it was made with, so an edited
 * or deleted question never relabels what was answered before.
 */
export function EarlierAnswers({ invoiceId }: { invoiceId: string }) {
  const trpc = useTRPC();
  const { data } = useQuery(trpc.questions.answers.queryOptions({ invoiceId }));
  const replaced = (data ?? []).filter((row) => row.previous);
  if (replaced.length === 0) return null;

  return (
    <details className="mt-3 text-sm">
      <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
        Earlier answers ({replaced.length})
      </summary>
      <ul className="mt-2 divide-y border-y">
        {replaced.map((row) => {
          const previous = row.previous as unknown as InvoiceJudgment;
          const caution = cautionFor(previous);
          return (
            <li key={row.id} className="py-2.5">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-xs font-medium">{previous.label}</p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    {provenanceFor(previous) || "Question revision unknown"}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-xs font-semibold">{answerFor(previous)}</p>
                  {caution && (
                    <p className="text-[11px] text-amber-700 dark:text-amber-400">
                      {caution}
                    </p>
                  )}
                </div>
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Replaced by the question v{row.questionVersion ?? "?"} rerun on{" "}
                {new Date(row.createdAt).toLocaleString("en-GB", {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
              </p>
            </li>
          );
        })}
      </ul>
    </details>
  );
}
