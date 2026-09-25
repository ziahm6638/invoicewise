import type { InvoiceJudgment } from "@invoicewise/documents";

export const percent = (value: number) => `${Math.round(value * 100)}%`;

const UNIT_SUFFIX: Record<string, string> = {
  percent: "%",
  days: " days",
  count: "",
};

/** A number answer as printed with its unit. */
export function formatNumberAnswer(
  judgment: Extract<InvoiceJudgment, { type: "number"; status: "answered" }>,
) {
  const unit = judgment.format?.unit;
  if (unit === "currency") {
    return judgment.currency
      ? new Intl.NumberFormat("en-GB", {
          style: "currency",
          currency: judgment.currency,
        }).format(judgment.answer)
      : judgment.answer.toLocaleString("en-GB");
  }
  if (unit === "other") {
    const label = judgment.format?.unitLabel;
    return `${judgment.answer.toLocaleString("en-GB")}${label ? ` ${label}` : ""}`;
  }
  return `${judgment.answer.toLocaleString("en-GB")}${UNIT_SUFFIX[unit ?? "count"] ?? ""}`;
}

/** The answer itself, in words. Unknown and failed are never shown as No or 0. */
export function answerFor(judgment: InvoiceJudgment) {
  if (judgment.status === "failed") return "Could not answer";
  if (judgment.status === "not_applicable") return "Not applicable";
  if (judgment.status === "unknown") return "Unknown";
  if (judgment.type === "boolean") {
    if (judgment.certainty === "low_confidence") {
      return judgment.answer ? "Unsure, leaning yes" : "Unsure, leaning no";
    }
    return judgment.answer ? "Yes" : "No";
  }
  if (judgment.type === "score") {
    const level = Math.round(judgment.answer);
    return (
      judgment.levels[String(level)] ??
      judgment.options?.[level] ??
      String(judgment.answer)
    );
  }
  if (judgment.type === "number") return formatNumberAnswer(judgment);
  return judgment.answer;
}

/** How sure the answer is, 0-1, or null when there is no answer. */
export function confidenceFor(judgment: InvoiceJudgment) {
  if (judgment.status !== "answered") return null;
  if (judgment.type === "boolean") {
    return judgment.answer ? judgment.probability : 1 - judgment.probability;
  }
  return judgment.confidence;
}

/** A caution to show beside an answer that should not be relied on as is. */
export function cautionFor(judgment: InvoiceJudgment) {
  if (judgment.status !== "answered") return null;
  if (judgment.certainty === "incomplete_input") {
    return "Answered from incomplete input";
  }
  if (judgment.certainty === "low_confidence") return "Low confidence";
  return null;
}

/** Which revision of the question, and which evaluator, produced the answer. */
export function provenanceFor(judgment: InvoiceJudgment) {
  const parts: string[] = [];
  if (judgment.questionVersion !== undefined) {
    parts.push(`Question v${judgment.questionVersion}`);
  }
  if (judgment.evaluator?.model) parts.push(judgment.evaluator.model);
  if (judgment.runId) parts.push("rerun");
  if (judgment.answeredAt) {
    parts.push(
      new Date(judgment.answeredAt).toLocaleString("en-GB", {
        dateStyle: "medium",
        timeStyle: "short",
      }),
    );
  }
  return parts.join(" · ");
}
