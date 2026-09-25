import {
  QUESTION_LIMITS,
  QUESTION_NUMBER_UNITS,
} from "@invoicewise/jobs/questions";
import { z } from "zod";

// Question text is untrusted input that is shown to other members and given
// to TypeSafe: no control characters beyond line breaks and tabs.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const plainText = (schema: z.ZodString) =>
  schema.refine((value) => !CONTROL.test(value), {
    message: "Remove control characters",
  });

const questionText = plainText(z.string().trim().min(3).max(500));
const context = plainText(z.string().trim().max(2_000)).nullable().optional();
const options = z
  .array(plainText(z.string().trim().min(1).max(100)))
  .min(2)
  .max(10)
  .refine(
    (values) =>
      new Set(values.map((value) => value.toLocaleLowerCase("en-GB"))).size ===
      values.length,
    { message: "Options must be unique" },
  );

const bound = z
  .number()
  .finite()
  .min(-QUESTION_LIMITS.maxNumberMagnitude)
  .max(QUESTION_LIMITS.maxNumberMagnitude)
  .nullable()
  .optional();

/**
 * A number question's unit and range, checked when the question is saved:
 * whole-number units take whole, non-negative bounds; a percentage stays
 * within -100..1000; `other` names its unit; min never exceeds max.
 */
export const numberFormatSchema = z
  .object({
    unit: z.enum(QUESTION_NUMBER_UNITS),
    unitLabel: plainText(
      z
        .string()
        .trim()
        .min(1)
        .max(20)
        .regex(/^[\p{L}\p{N} %./²³°-]+$/u, "Use letters, digits or % . / -"),
    )
      .nullable()
      .optional(),
    min: bound,
    max: bound,
  })
  .superRefine((format, ctx) => {
    const { unit, min, max } = format;
    if (unit === "other" && !format.unitLabel) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["unitLabel"],
        message: "Name the unit, for example kg or hours",
      });
    }
    if (
      min !== null &&
      min !== undefined &&
      max !== null &&
      max !== undefined &&
      min > max
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["max"],
        message: "The maximum must not be below the minimum",
      });
    }
    for (const [key, value] of [
      ["min", min],
      ["max", max],
    ] as const) {
      if (value === null || value === undefined) continue;
      if (
        (unit === "days" || unit === "count") &&
        (!Number.isInteger(value) || value < 0)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: "Days and counts are whole numbers of zero or more",
        });
      }
      if (unit === "percent" && (value < -100 || value > 1_000)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: "A percentage range must lie between -100 and 1000",
        });
      }
    }
  })
  .transform((format) => ({
    unit: format.unit,
    unitLabel: format.unit === "other" ? (format.unitLabel ?? null) : null,
    min: format.min ?? null,
    max: format.max ?? null,
  }));

const common = {
  question: questionText,
  context,
  enabled: z.boolean().default(true),
};

export const questionInputSchema = z.discriminatedUnion("type", [
  z.object({
    ...common,
    type: z.literal("boolean"),
    options: z.null().optional(),
    numberFormat: z.null().optional(),
  }),
  z.object({
    ...common,
    type: z.literal("choice"),
    options,
    numberFormat: z.null().optional(),
  }),
  z.object({
    ...common,
    type: z.literal("score"),
    options,
    numberFormat: z.null().optional(),
  }),
  z.object({
    ...common,
    type: z.literal("number"),
    options: z.null().optional(),
    numberFormat: numberFormatSchema,
  }),
]);

export const questionKeySchema = z.object({
  questionKey: z.string().min(1),
});

export const updateQuestionSchema = z.intersection(
  questionKeySchema,
  questionInputSchema,
);

const invoiceIds = (max: number) =>
  z
    .array(z.string().uuid())
    .min(1)
    .max(max)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "Choose each invoice once",
    });

/**
 * Preview a saved question (by key, optionally a past revision) or an
 * unsaved draft of one, on a few invoices.
 */
export const previewQuestionSchema = z.object({
  questionKey: z.string().min(1).optional(),
  versionId: z.string().uuid().optional(),
  draft: questionInputSchema.optional(),
  invoiceIds: invoiceIds(QUESTION_LIMITS.maxPreviewInvoices),
});

export const rerunQuestionSchema = z.object({
  questionKey: z.string().min(1),
  invoiceIds: invoiceIds(QUESTION_LIMITS.maxRerunInvoices),
});

export const questionRunSchema = z.object({
  runId: z.string().uuid(),
});

export const invoiceAnswersSchema = z.object({
  invoiceId: z.string().uuid(),
});
