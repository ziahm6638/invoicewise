import type { InvoiceJudgment } from "@invoicewise/documents";
import { Badge } from "@invoicewise/ui/badge";
import {
  AlertTriangle,
  CheckCircle2,
  CircleHelp,
  MinusCircle,
} from "lucide-react";
import { checkDescription } from "../built-in-checks";
import {
  answerFor,
  cautionFor,
  confidenceFor,
  percent,
  provenanceFor,
} from "./answer-format";

export function JudgmentResults({
  judgments,
}: {
  judgments?: Record<string, unknown>[] | null;
}) {
  if (!judgments?.length) {
    return (
      <p className="py-5 text-sm text-muted-foreground">
        Checks have not completed for this invoice yet.
      </p>
    );
  }

  return (
    <div className="divide-y border-t">
      {(judgments as InvoiceJudgment[]).map((judgment) => {
        const confidence = confidenceFor(judgment);
        const description = checkDescription({
          isBuiltIn: judgment.source !== "custom",
          key: judgment.questionId,
          label: judgment.label,
          question: judgment.question,
        });

        return (
          <div
            key={`${judgment.questionId}-${judgment.questionVersionId ?? "current"}`}
            className="py-4"
          >
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  {judgment.status === "failed" ? (
                    <AlertTriangle
                      aria-hidden
                      className="size-4 text-destructive"
                    />
                  ) : judgment.status === "not_applicable" ? (
                    <MinusCircle
                      aria-hidden
                      className="size-4 text-muted-foreground"
                    />
                  ) : judgment.status === "unknown" || cautionFor(judgment) ? (
                    <CircleHelp
                      aria-hidden
                      className="size-4 text-amber-600 dark:text-amber-400"
                    />
                  ) : (
                    <CheckCircle2
                      aria-hidden
                      className="size-4 text-emerald-600 dark:text-emerald-400"
                    />
                  )}
                  <p className="text-sm font-medium">{judgment.label}</p>
                  {judgment.source === "custom" && (
                    <Badge variant="tag">Your question</Badge>
                  )}
                </div>
                {description && (
                  <p className="mt-1.5 max-w-[65ch] text-xs leading-5 text-muted-foreground">
                    {description}
                  </p>
                )}
              </div>
              <div className="shrink-0 text-right">
                <p
                  className={
                    judgment.status === "failed"
                      ? "text-sm font-medium text-destructive"
                      : judgment.status === "not_applicable" ||
                          judgment.status === "unknown"
                        ? "text-sm font-medium text-muted-foreground"
                        : "text-sm font-semibold"
                  }
                >
                  {answerFor(judgment)}
                </p>
                {confidence !== null && (
                  <p className="mt-1 text-xs tabular-nums text-muted-foreground">
                    {percent(confidence)} confidence
                  </p>
                )}
                {cautionFor(judgment) && (
                  <p className="mt-1 text-xs font-medium text-amber-700 dark:text-amber-400">
                    {cautionFor(judgment)}
                  </p>
                )}
              </div>
            </div>
            {judgment.status === "answered" && judgment.type === "number" && (
              <p className="mt-2 text-xs leading-5 text-muted-foreground">
                Read from: “{judgment.evidence.text}”
              </p>
            )}
            {(judgment.status === "not_applicable" ||
              judgment.status === "unknown") && (
              <p className="mt-2 text-xs leading-5 text-muted-foreground">
                {judgment.reason}
              </p>
            )}
            {judgment.status === "failed" && (
              <p className="mt-2 text-xs leading-5 text-destructive">
                {judgment.error ||
                  "InvoiceWise could not produce a reliable answer."}
              </p>
            )}
            {judgment.limits?.map((limit) => (
              <p
                key={limit}
                className="mt-1 text-xs leading-5 text-amber-700 dark:text-amber-400"
              >
                {limit}
              </p>
            ))}
            {provenanceFor(judgment) && (
              <p className="mt-1 text-[11px] text-muted-foreground">
                {provenanceFor(judgment)}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
