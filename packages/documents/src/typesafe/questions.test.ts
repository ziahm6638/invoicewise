import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { TypeSafe, type TypeSafeAnswer, type TypeSafeQuestion } from "./client";
import {
  type InvoiceExtraction,
  type InvoiceJudgmentQuestion,
  runJudgments,
} from "./invoice";
import {
  QUESTION_EVALUATOR_VERSION,
  QUESTION_LIMITS,
  certaintyFor,
  numberCandidates,
} from "./questions";

const extraction = {
  documentType: "invoice",
  supplierName: "Northwind Joinery Ltd",
  currency: "GBP",
  netAmount: 100,
  vatAmount: 20,
  grossAmount: 120,
  bankDetails: {
    accountName: null,
    accountNumber: null,
    sortCode: null,
    iban: null,
    bic: null,
  },
  lineItems: [],
  evidence: { fields: {}, lineItems: [] },
} as unknown as InvoiceExtraction;

const TEXT = [
  "Northwind Joinery Ltd",
  "Invoice NJ-10457   Date 15/09/2026",
  "Sort code 40-11-62",
  "Payment terms: 30 days net",
  "Late payment interest 8% per annum",
  "Deposit paid: 0",
  "Total due £1,234.50",
].join("\n");

type Asked = Record<string, TypeSafeQuestion>;

/** A TypeSafe stand-in that answers each question with `answer(question)`. */
const typeSafe = (
  answer: (question: TypeSafeQuestion, id: string) => TypeSafeAnswer,
  seen: { questions?: Asked; state?: unknown } = {},
) =>
  Layer.succeed(TypeSafe, {
    evaluate: ({ questions, state }) => {
      seen.questions = questions;
      seen.state = state;
      return Effect.succeed({
        model: "jev-1.13.0",
        answers: Object.fromEntries(
          Object.entries(questions).map(([id, question]) => [
            id,
            answer(question, id),
          ]),
        ),
        usage: { inputTokens: 1200, outputTokens: 0 },
      });
    },
  });

const pick = (key: string, confidence = 0.9): TypeSafeAnswer => ({
  type: "choice",
  choice: key,
  probabilities: { [key]: confidence },
  confidence,
});

const days: InvoiceJudgmentQuestion = {
  id: "payment_days",
  versionId: "payment-days-v2",
  version: 2,
  label: "Payment terms",
  type: "number",
  question: "How many days does the invoice allow for payment?",
  format: { unit: "days", min: 0, max: 365 },
};

const judge = (
  questions: InvoiceJudgmentQuestion[],
  layer: Layer.Layer<TypeSafe>,
  text: string | null = TEXT,
) =>
  Effect.runPromise(
    runJudgments(extraction, [], questions, [], text).pipe(
      Effect.provide(layer),
    ),
  );

describe("number candidates", () => {
  test("finds printed numbers in range, never parts of dates, codes or references", () => {
    const { candidates, truncated } = numberCandidates(TEXT, {
      unit: "days",
      min: 0,
      max: 365,
    });
    expect(truncated).toBe(false);
    expect(candidates.map(({ value, line }) => [value, line])).toEqual([
      [30, 3],
      [8, 4],
      [0, 5],
    ]);
  });

  test("honours the unit: currency keeps decimals, percent needs a rate", () => {
    const money = numberCandidates(TEXT, { unit: "currency", min: 100 });
    expect(money.candidates.map(({ value }) => value)).toEqual([1234.5]);
    const rate = numberCandidates(TEXT, { unit: "percent" });
    expect(rate.candidates.map(({ printed }) => printed)).toEqual(["8%"]);
  });

  test("reports when numbers in range were left out", () => {
    const text = Array.from({ length: 60 }, (_, index) => `Row ${index + 1}`)
      .join("\n")
      .replace(/Row/g, "Qty");
    const { candidates, truncated } = numberCandidates(text, {
      unit: "count",
    });
    expect(candidates).toHaveLength(QUESTION_LIMITS.maxNumberCandidates);
    expect(truncated).toBe(true);
  });
});

describe("answer semantics", () => {
  test("a number answer copies the printed value, its row and the evaluator", async () => {
    const seen: { questions?: Asked } = {};
    const { judgments, model } = await judge(
      [days],
      typeSafe(() => pick("number_0"), seen),
    );
    expect(model).toBe("jev-1.13.0");
    expect(judgments[0]).toMatchObject({
      status: "answered",
      type: "number",
      answer: 30,
      evidence: { line: 3, text: "Payment terms: 30 days net" },
      certainty: "confident",
      questionVersion: 2,
      questionVersionId: "payment-days-v2",
      format: { unit: "days", min: 0, max: 365 },
      evaluator: { model: "jev-1.13.0", version: QUESTION_EVALUATOR_VERSION },
      input: { documentText: "complete", historyCount: 0 },
      limits: [],
    });
    // Asked as a closed choice over the printed numbers plus "none".
    const asked = Object.values(seen.questions!)[0]!;
    expect(asked.type).toBe("choice");
    expect(Object.keys(asked.criteria as object)).toEqual([
      "number_0",
      "number_1",
      "number_2",
      "none",
    ]);
  });

  test("zero is an answer; not stated is unknown, never zero or No", async () => {
    const zero = await judge(
      [days],
      typeSafe(() => pick("number_2")),
    );
    expect(zero.judgments[0]).toMatchObject({ status: "answered", answer: 0 });

    const none = await judge(
      [days],
      typeSafe(() => pick("none")),
    );
    expect(none.judgments[0]).toMatchObject({
      status: "unknown",
      type: "number",
      reason: "The invoice does not state this value.",
    });

    const choice: InvoiceJudgmentQuestion = {
      id: "route",
      label: "Route",
      type: "choice",
      question: "Which approval route applies?",
      options: ["Routine", "Director"],
    };
    const unmatched = await judge(
      [choice],
      typeSafe(() => pick("none")),
    );
    expect(unmatched.judgments[0]).toMatchObject({
      status: "unknown",
      type: "choice",
      options: ["Routine", "Director"],
    });
  });

  test("no number in range is unknown without spending a call", async () => {
    let calls = 0;
    const layer = Layer.succeed(TypeSafe, {
      evaluate: () => {
        calls += 1;
        return Effect.die("not expected");
      },
    });
    const { judgments, model } = await judge(
      [{ ...days, format: { unit: "days", min: 400, max: 500 } }],
      layer,
    );
    expect(calls).toBe(0);
    expect(model).toBeNull();
    expect(judgments[0]).toMatchObject({
      status: "unknown",
      reason:
        "No number within the question's range is printed on the invoice.",
      evaluator: { model: null },
    });
  });

  test("uncertain answers are marked, and truncated input is never confident", async () => {
    const yesNo: InvoiceJudgmentQuestion = {
      id: "capital",
      label: "Capital spend",
      type: "boolean",
      question: "Is this capital spend?",
    };
    const unsure = await judge(
      [yesNo],
      typeSafe(() => ({ type: "noul", noul: 0.45 })),
    );
    expect(unsure.judgments[0]).toMatchObject({
      status: "answered",
      answer: false,
      certainty: "low_confidence",
    });

    const long = `${"x".repeat(QUESTION_LIMITS.maxDocumentTextChars)}\nPayment terms: 30 days`;
    const seen: { state?: unknown } = {};
    const truncated = await judge(
      [yesNo],
      typeSafe(() => ({ type: "noul", noul: 0.99 }), seen),
      long,
    );
    expect(truncated.judgments[0]).toMatchObject({
      certainty: "incomplete_input",
      input: { documentText: "truncated" },
    });
    expect(
      (truncated.judgments[0] as { limits: string[] }).limits[0],
    ).toContain("Only the first 16,000 characters");
    expect(
      ((seen.state as { invoiceText: string }).invoiceText ?? "").length,
    ).toBe(QUESTION_LIMITS.maxDocumentTextChars);

    const noText = await judge(
      [yesNo],
      typeSafe(() => ({ type: "noul", noul: 0.99 })),
      null,
    );
    expect(noText.judgments[0]).toMatchObject({
      certainty: "incomplete_input",
      input: { documentText: "unavailable" },
    });
  });

  test("a score is bounded by its levels and scaled to 0-1", async () => {
    const risk: InvoiceJudgmentQuestion = {
      id: "risk",
      label: "Risk",
      type: "score",
      question: "How risky is this invoice?",
      levels: ["Routine spend", "Unusual spend", "Suspicious spend"],
    };
    const { judgments } = await judge(
      [risk],
      typeSafe(() => ({
        type: "score",
        score: 7,
        legend: { "0": "Routine spend" },
        probabilities: { "2": 1 },
        confidence: 0.3,
      })),
    );
    expect(judgments[0]).toMatchObject({
      status: "answered",
      answer: 2,
      position: 1,
      certainty: "low_confidence",
      options: risk.levels,
    });
  });

  test("certainty thresholds", () => {
    expect(certaintyFor({ probability: 0.71 }, true)).toBe("confident");
    expect(certaintyFor({ probability: 0.29 }, true)).toBe("confident");
    expect(certaintyFor({ probability: 0.6 }, true)).toBe("low_confidence");
    expect(certaintyFor({ confidence: 0.49 }, true)).toBe("low_confidence");
    expect(certaintyFor({ confidence: 0.99 }, false)).toBe("incomplete_input");
  });
});
