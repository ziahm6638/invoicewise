import { describe, expect, test } from "bun:test";
import {
  previewQuestionSchema,
  questionInputSchema,
  rerunQuestionSchema,
} from "./questions";

const number = (numberFormat: Record<string, unknown>) =>
  questionInputSchema.safeParse({
    question: "How many days does the invoice allow for payment?",
    type: "number",
    numberFormat,
  });

describe("question configuration", () => {
  test("accepts a bounded number question and normalises its format", () => {
    const parsed = number({ unit: "days", min: 0, max: 90, unitLabel: "x" });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({
      type: "number",
      numberFormat: { unit: "days", unitLabel: null, min: 0, max: 90 },
    });
  });

  test("refuses ranges and units that cannot hold", () => {
    expect(number({ unit: "days", min: 10, max: 5 }).success).toBe(false);
    expect(number({ unit: "days", min: 1.5 }).success).toBe(false);
    expect(number({ unit: "count", min: -1 }).success).toBe(false);
    expect(number({ unit: "percent", max: 5000 }).success).toBe(false);
    expect(number({ unit: "other" }).success).toBe(false);
    expect(number({ unit: "other", unitLabel: "<script>" }).success).toBe(
      false,
    );
    expect(
      number({ unit: "currency", max: Number.POSITIVE_INFINITY }).success,
    ).toBe(false);
    expect(number({ unit: "kilograms" }).success).toBe(false);
    expect(number({ unit: "other", unitLabel: "kg", min: 0 }).success).toBe(
      true,
    );
  });

  test("refuses duplicate, empty or too many enum options", () => {
    const choice = (options: string[]) =>
      questionInputSchema.safeParse({
        question: "Which kind of spend is this?",
        type: "choice",
        options,
      }).success;
    expect(choice(["Capital", "Operational"])).toBe(true);
    expect(choice(["Capital", "capital"])).toBe(false);
    expect(choice(["Capital"])).toBe(false);
    expect(choice(["Capital", " "])).toBe(false);
    expect(choice(Array.from({ length: 11 }, (_, index) => `O${index}`))).toBe(
      false,
    );
  });

  test("refuses control characters in question text", () => {
    expect(
      questionInputSchema.safeParse({
        question: "Approved?\u0007",
        type: "boolean",
      }).success,
    ).toBe(false);
  });

  test("bounds preview and rerun selections", () => {
    const ids = (count: number) =>
      Array.from({ length: count }, () => crypto.randomUUID());
    expect(
      previewQuestionSchema.safeParse({ questionKey: "k", invoiceIds: ids(5) })
        .success,
    ).toBe(true);
    expect(
      previewQuestionSchema.safeParse({ questionKey: "k", invoiceIds: ids(6) })
        .success,
    ).toBe(false);
    expect(
      rerunQuestionSchema.safeParse({ questionKey: "k", invoiceIds: ids(25) })
        .success,
    ).toBe(true);
    expect(
      rerunQuestionSchema.safeParse({ questionKey: "k", invoiceIds: ids(26) })
        .success,
    ).toBe(false);
    const [id] = ids(1);
    expect(
      rerunQuestionSchema.safeParse({ questionKey: "k", invoiceIds: [id, id] })
        .success,
    ).toBe(false);
  });
});
