import type { InvoiceJudgment } from "@invoicewise/documents";
import { Badge } from "@invoicewise/ui/badge";
import { AlertTriangle, CheckCircle2, MinusCircle } from "lucide-react";

const percent = (value: number) => `${Math.round(value * 100)}%`;

function answerFor(judgment: InvoiceJudgment) {
  if (judgment.status === "failed") return "Could not answer";
  if (judgment.status === "not_applicable") return "Not applicable";
  if (judgment.type === "boolean") return judgment.answer ? "Yes" : "No";
  if (judgment.type === "score") {
    return judgment.levels[String(judgment.answer)] ?? String(judgment.answer);
  }
  return judgment.answer;
}

function confidenceFor(judgment: InvoiceJudgment) {
  if (judgment.status === "failed" || judgment.status === "not_applicable") {
    return null;
  }
  if (judgment.type === "boolean") {
    return judgment.answer ? judgment.probability : 1 - judgment.probability;
  }
  return judgment.confidence;
}

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
                {judgment.question !== judgment.label && (
                  <p className="mt-1.5 max-w-[65ch] text-xs leading-5 text-muted-foreground">
                    {judgment.question}
                  </p>
                )}
              </div>
              <div className="shrink-0 text-right">
                <p
                  className={
                    judgment.status === "failed"
                      ? "text-sm font-medium text-destructive"
                      : judgment.status === "not_applicable"
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
              </div>
            </div>
            {judgment.status === "not_applicable" && (
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
          </div>
        );
      })}
    </div>
  );
}
