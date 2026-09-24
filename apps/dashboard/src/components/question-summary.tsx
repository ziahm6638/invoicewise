import type { RouterOutputs } from "@invoicewise/api/trpc/routers/_app";
import { Badge } from "@invoicewise/ui/badge";
import { checkDescription } from "./built-in-checks";

type Question = RouterOutputs["questions"]["list"][number];

export function QuestionSummary({ question }: { question: Question }) {
  const description = checkDescription({
    isBuiltIn: question.isDefault,
    key: question.questionKey,
    label: question.label,
    question: question.question,
  });

  return (
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-medium">{question.label}</p>
        {question.isDefault && <Badge variant="tag">Default</Badge>}
        <span className="text-xs text-muted-foreground">
          v{question.version}
        </span>
      </div>
      {description && (
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      )}
      <p className="mt-1 text-xs text-muted-foreground">
        {question.type === "boolean"
          ? "Yes or no"
          : question.type === "choice"
            ? `Choose: ${question.options?.join(", ")}`
            : `Score: ${question.options?.join(" → ")}`}
      </p>
      {question.context && (
        <p className="mt-2 text-xs text-muted-foreground">
          Context: {question.context}
        </p>
      )}
    </div>
  );
}
