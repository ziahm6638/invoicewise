import { z } from "zod";

const questionText = z.string().trim().min(3).max(500);
const context = z.string().trim().max(2_000).nullable().optional();
const options = z
  .array(z.string().trim().min(1).max(100))
  .min(2)
  .max(10)
  .refine((values) => new Set(values).size === values.length, {
    message: "Options must be unique",
  });

export const questionInputSchema = z.discriminatedUnion("type", [
  z.object({
    question: questionText,
    type: z.literal("boolean"),
    context,
    enabled: z.boolean().default(true),
    options: z.null().optional(),
  }),
  z.object({
    question: questionText,
    type: z.literal("choice"),
    context,
    enabled: z.boolean().default(true),
    options,
  }),
  z.object({
    question: questionText,
    type: z.literal("score"),
    context,
    enabled: z.boolean().default(true),
    options,
  }),
]);

export const questionKeySchema = z.object({
  questionKey: z.string().min(1),
});

export const updateQuestionSchema = z.intersection(
  questionKeySchema,
  questionInputSchema,
);
