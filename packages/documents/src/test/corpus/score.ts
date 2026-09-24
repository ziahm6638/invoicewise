/**
 * Scores corpus extractions against their reviewed expectations and checks
 * the scores against the recorded thresholds. Pure functions, so the gate
 * itself is tested: a regressed extraction must fail it.
 */
import { deepEquals } from "bun";
import type { InvoiceExtraction } from "../../typesafe/invoice";
import type { CorpusDocument, ScoredFields } from "./corpus";

export type Thresholds = {
  /** Minimum share of documents whose value for the field is exactly right. */
  fields: Record<keyof ScoredFields, number>;
  lineItems: {
    /** Minimum share of expected line items read exactly (all columns). */
    recall: number;
    /** Minimum share of read line items that are expected ones. */
    precision: number;
  };
  /** Minimum share of documents whose validation outcome is exactly as reviewed. */
  validation: number;
};

export type CorpusRun = {
  document: CorpusDocument;
  extraction: InvoiceExtraction;
  /** The document's validation outcome, in the corpus's comparable form. */
  outcome: CorpusDocument["validation"] & {
    duplicateOf: string | null;
    creditsInvoice: string | null;
  };
};

export type CorpusScore = {
  fields: Record<string, { passed: number; total: number; failures: string[] }>;
  lineItems: {
    expected: number;
    read: number;
    exact: number;
    failures: string[];
  };
  validation: { passed: number; total: number; failures: string[] };
};

const scoredFields = (extraction: InvoiceExtraction): ScoredFields => {
  const {
    evidence: _evidence,
    textSource: _textSource,
    pageSources: _pageSources,
    lineItems: _lineItems,
    bankDetails,
    ...fields
  } = extraction;
  return { ...fields, ...bankDetails };
};

export function scoreCorpus(runs: readonly CorpusRun[]): CorpusScore {
  const score: CorpusScore = {
    fields: {},
    lineItems: { expected: 0, read: 0, exact: 0, failures: [] },
    validation: { passed: 0, total: 0, failures: [] },
  };
  for (const { document, extraction, outcome } of runs) {
    const actual = scoredFields(extraction);
    for (const [field, expected] of Object.entries(document.expected.fields)) {
      score.fields[field] ??= { passed: 0, total: 0, failures: [] };
      const entry = score.fields[field]!;
      entry.total += 1;
      const value = actual[field as keyof ScoredFields];
      if (deepEquals(value, expected)) entry.passed += 1;
      else {
        entry.failures.push(
          `${document.name}: expected ${JSON.stringify(expected)}, read ${JSON.stringify(value)}`,
        );
      }
    }

    const expectedItems = document.expected.lineItems;
    score.lineItems.expected += expectedItems.length;
    score.lineItems.read += extraction.lineItems.length;
    expectedItems.forEach((expected, index) => {
      const read = extraction.lineItems[index];
      if (deepEquals(read, expected)) score.lineItems.exact += 1;
      else {
        score.lineItems.failures.push(
          `${document.name} line ${index + 1}: expected ${JSON.stringify(expected)}, read ${JSON.stringify(read ?? null)}`,
        );
      }
    });
    if (extraction.lineItems.length > expectedItems.length) {
      score.lineItems.failures.push(
        `${document.name}: ${extraction.lineItems.length - expectedItems.length} unexpected line item(s)`,
      );
    }

    score.validation.total += 1;
    const expectedOutcome = {
      ...document.validation,
      duplicateOf: document.duplicateOf ?? null,
      creditsInvoice: document.creditsInvoice ?? null,
    };
    if (deepEquals(outcome, expectedOutcome)) score.validation.passed += 1;
    else {
      score.validation.failures.push(
        `${document.name}: expected ${JSON.stringify(expectedOutcome)}, got ${JSON.stringify(outcome)}`,
      );
    }
  }
  return score;
}

/** Every threshold the score falls below, with the evidence; empty when it passes. */
export function thresholdFailures(
  score: CorpusScore,
  thresholds: Thresholds,
): string[] {
  const failures: string[] = [];
  for (const [field, minimum] of Object.entries(thresholds.fields)) {
    const entry = score.fields[field];
    if (!entry) {
      failures.push(`${field}: no corpus document scores it`);
      continue;
    }
    const rate = entry.passed / entry.total;
    if (rate < minimum) {
      failures.push(
        `${field}: ${entry.passed}/${entry.total} below ${minimum}\n  ${entry.failures.join("\n  ")}`,
      );
    }
  }
  const { expected, read, exact } = score.lineItems;
  const recall = expected === 0 ? 1 : exact / expected;
  const precision = read === 0 ? 1 : exact / read;
  if (
    recall < thresholds.lineItems.recall ||
    precision < thresholds.lineItems.precision
  ) {
    failures.push(
      `line items: recall ${exact}/${expected}, precision ${exact}/${read} below ${thresholds.lineItems.recall}/${thresholds.lineItems.precision}\n  ${score.lineItems.failures.join("\n  ")}`,
    );
  }
  const validationRate = score.validation.passed / score.validation.total;
  if (validationRate < thresholds.validation) {
    failures.push(
      `validation: ${score.validation.passed}/${score.validation.total} below ${thresholds.validation}\n  ${score.validation.failures.join("\n  ")}`,
    );
  }
  return failures;
}
