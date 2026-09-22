type Judgment = {
  questionId: string;
  label: string;
  status?: "answered" | "failed";
  type: "boolean" | "choice" | "score";
  answer?: boolean | string | number;
  probability?: number;
  confidence?: number;
  error?: string;
};

const percent = (value: number) => `${Math.round(value * 100)}%`;

export function JudgmentResults({
  judgments,
}: {
  judgments?: Record<string, unknown>[] | null;
}) {
  if (!judgments?.length) return null;

  return (
    <section className="max-h-64 overflow-y-auto border-b px-4 py-4">
      <h3 className="mb-3 text-sm font-medium">Checks</h3>
      <div className="space-y-3">
        {(judgments as Judgment[]).map((judgment) => (
          <div key={`${judgment.questionId}-${judgment.label}`}>
            <div className="flex items-start justify-between gap-4 text-sm">
              <span className="text-muted-foreground">{judgment.label}</span>
              {judgment.status === "failed" ? (
                <span className="font-medium text-destructive">Failed</span>
              ) : (
                <span className="text-right font-medium">
                  {typeof judgment.answer === "boolean"
                    ? judgment.answer
                      ? "Yes"
                      : "No"
                    : judgment.answer}
                </span>
              )}
            </div>
            {judgment.status === "failed" ? (
              <p className="mt-1 text-xs text-destructive">{judgment.error}</p>
            ) : (
              <p className="mt-1 text-right text-xs text-muted-foreground">
                {judgment.type === "boolean" &&
                  judgment.probability !== undefined &&
                  `${percent(judgment.probability)} yes probability`}
                {judgment.type !== "boolean" &&
                  judgment.confidence !== undefined &&
                  `${percent(judgment.confidence)} confidence`}
              </p>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
