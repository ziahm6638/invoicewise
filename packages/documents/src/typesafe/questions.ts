/**
 * Answer semantics for workspace questions: what each question type means,
 * how sure an answer is, and the bounds every evaluation stays within.
 * `docs/document-intake.md#questions` publishes them.
 *
 * TypeSafe selects; it does not generate. A number question is therefore
 * answered like an extracted field: code finds the numbers printed on the
 * document, TypeSafe picks the one the question asks for (or none), and code
 * copies the printed value. Nothing a question or an invoice says can widen
 * the answer beyond its configured options, levels or range.
 */

/**
 * Identifies how questions are put to TypeSafe (state shape, option wording,
 * certainty thresholds). Stored on every answer with the model that answered,
 * so an answer can always be traced to the evaluator that produced it. Bump
 * it whenever that changes.
 */
export const QUESTION_EVALUATOR_VERSION = "questions-2";

/** What a number question's value measures. */
export const QUESTION_NUMBER_UNITS = [
  "currency",
  "percent",
  "days",
  "count",
  "other",
] as const;
export type QuestionNumberUnit = (typeof QUESTION_NUMBER_UNITS)[number];

/** A number question's unit and the range an answer must fall in. */
export type QuestionNumberFormat = {
  unit: QuestionNumberUnit;
  /** Shown after the value for `other` (e.g. "kg"); ignored otherwise. */
  unitLabel?: string | null;
  min?: number | null;
  max?: number | null;
};

/** Units whose values are whole numbers. */
const WHOLE_UNITS: readonly QuestionNumberUnit[] = ["days", "count"];

/**
 * Bounds of one evaluation. Everything given to TypeSafe and everything
 * stored from its answer is capped; a cap that cut something is reported on
 * the answer, never hidden.
 */
export const QUESTION_LIMITS = {
  /** Document text given with the extraction (about 4k tokens). */
  maxDocumentTextChars: 16_000,
  /** Document text retained per invoice for later reruns and previews. */
  maxRetainedTextChars: 64_000,
  /** Printed numbers offered to a number question. */
  maxNumberCandidates: 40,
  /** Characters of a printed row kept as an answer's evidence. */
  maxEvidenceChars: 200,
  /** Largest magnitude a number question's range may use. */
  maxNumberMagnitude: 1_000_000_000_000,
  /** Invoices one preview may evaluate. */
  maxPreviewInvoices: 5,
  /** Invoices one rerun may evaluate. */
  maxRerunInvoices: 25,
  /** Enabled custom questions per workspace (each adds to every call). */
  maxCustomQuestions: 20,
  /** Wall time of one preview, all invoices together. */
  previewTimeoutMs: 45_000,
} as const;

/** Choice and score answers below this confidence are shown as uncertain. */
export const MIN_CONFIDENCE = 0.5;
/** A yes/no probability within this distance of 0.5 is shown as uncertain. */
export const MIN_BOOLEAN_MARGIN = 0.2;

/**
 * How far an answered question can be relied on. `incomplete_input` means
 * part of the evidence was cut to stay within the limits, so however
 * confident the model was, the answer may have missed something.
 */
export type AnswerCertainty =
  | "confident"
  | "low_confidence"
  | "incomplete_input";

export const certaintyFor = (
  measure: { probability: number } | { confidence: number },
  inputComplete: boolean,
): AnswerCertainty => {
  if (!inputComplete) return "incomplete_input";
  if ("probability" in measure) {
    return Math.abs(measure.probability - 0.5) >= MIN_BOOLEAN_MARGIN
      ? "confident"
      : "low_confidence";
  }
  return measure.confidence >= MIN_CONFIDENCE ? "confident" : "low_confidence";
};

/** What the document text given to a question was. */
export type QuestionInputSummary = {
  documentText: "complete" | "truncated" | "unavailable";
  /** Characters of document text given to TypeSafe. */
  documentTextChars: number;
  /** Earlier invoices given as `previousInvoices`. */
  historyCount: number;
};

/** The document text a question may read, capped, and what was cut. */
export const boundedDocumentText = (text: string | null | undefined) => {
  if (text === null || text === undefined) {
    return {
      text: null,
      documentText: "unavailable" as const,
      limit:
        "The document's text was not available, so only the extracted fields were read.",
    };
  }
  if (text.length <= QUESTION_LIMITS.maxDocumentTextChars) {
    return { text, documentText: "complete" as const, limit: null };
  }
  return {
    text: text.slice(0, QUESTION_LIMITS.maxDocumentTextChars),
    documentText: "truncated" as const,
    limit: `Only the first ${QUESTION_LIMITS.maxDocumentTextChars.toLocaleString("en-GB")} characters of the document's ${text.length.toLocaleString("en-GB")} were read.`,
  };
};

/** Drops control characters and shortens text kept on an answer. */
export const evidenceText = (text: string) => {
  const cleaned = text
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > QUESTION_LIMITS.maxEvidenceChars
    ? `${cleaned.slice(0, QUESTION_LIMITS.maxEvidenceChars - 1)}…`
    : cleaned;
};

export type NumberCandidate = {
  id: string;
  value: number;
  /** The number as printed. */
  printed: string;
  /** 0-based row of the document text it was printed on. */
  line: number;
  /** That row, cleaned and shortened. */
  text: string;
};

// A printed number: thousands separators, decimals, an optional sign or
// percent. Digits joined to letters (invoice numbers, postcodes) and parts
// of dates, sort codes or phone numbers (digits joined by / - . :) are not
// numbers a question asks about.
const NUMBER =
  /(?<![\p{L}\d/\-.:,])[-−]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:\s?%)?(?![\p{L}\d]|[/\-:]\d|[.,]\d)/gu;

const parseNumber = (printed: string) => {
  const value = Number(printed.replace(/[\s%,]/g, "").replace("−", "-"));
  return Number.isFinite(value) ? value : null;
};

const inRange = (value: number, format: QuestionNumberFormat) =>
  (format.min === null || format.min === undefined || value >= format.min) &&
  (format.max === null || format.max === undefined || value <= format.max) &&
  (!WHOLE_UNITS.includes(format.unit) || Number.isInteger(value)) &&
  (format.unit !== "percent" || (value >= -100 && value <= 1_000));

/**
 * The printed numbers a number question may choose from, in reading order:
 * each distinct (value, row) once, only within the configured range and
 * unit, at most `maxNumberCandidates`. `truncated` says numbers in range
 * were left out, so the answer is reported as made from incomplete input.
 */
export const numberCandidates = (
  text: string,
  format: QuestionNumberFormat,
): { candidates: NumberCandidate[]; truncated: boolean } => {
  const candidates: NumberCandidate[] = [];
  const seen = new Set<string>();
  let truncated = false;
  text.split("\n").forEach((row, line) => {
    for (const match of row.matchAll(NUMBER)) {
      const printed = match[0].trim();
      const value = parseNumber(printed);
      if (value === null || !inRange(value, format)) continue;
      if (format.unit === "percent" && !printed.endsWith("%")) {
        // A bare number can still be a rate ("VAT 20"), but only when the row
        // talks about one.
        if (!/%|percent|rate|vat|tax|discount/i.test(row)) continue;
      }
      const key = `${value}:${line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (candidates.length >= QUESTION_LIMITS.maxNumberCandidates) {
        truncated = true;
        return;
      }
      candidates.push({
        id: `number_${candidates.length}`,
        value,
        printed,
        line,
        text: evidenceText(row),
      });
    }
  });
  return { candidates, truncated };
};

/** A number question's unit as a reader sees it. */
export const unitDescription = (format: QuestionNumberFormat) => {
  switch (format.unit) {
    case "currency":
      return "an amount of money in the invoice's currency";
    case "percent":
      return "a percentage";
    case "days":
      return "a number of days";
    case "count":
      return "a count of items";
    default:
      return format.unitLabel
        ? `a quantity in ${format.unitLabel}`
        : "a quantity";
  }
};
