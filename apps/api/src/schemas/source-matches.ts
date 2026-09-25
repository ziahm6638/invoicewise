import { z } from "@hono/zod-openapi";

export const invoiceSourceMatchSchema = z.object({
  inboxId: z.string().uuid(),
});

export const sourceInvoicesSchema = z.object({ id: z.string().uuid() });

const expectedMatchId = z
  .string()
  .uuid()
  .nullable()
  .optional()
  .describe("The decision the change was made against; a newer one refuses it");

const reason = z.string().trim().max(1_000);

export const confirmSourceMatchSchema = z.object({
  inboxId: z.string().uuid(),
  expectedMatchId,
  reason: reason.nullish(),
});

export const linkInvoiceSourcesSchema = z.object({
  inboxId: z.string().uuid(),
  expectedMatchId,
  reason: reason.nullish(),
  sources: z
    .array(
      z.object({
        sourceId: z.string().uuid(),
        version: z.number().int().min(1).nullish(),
      }),
    )
    .min(1)
    .max(8),
  allocations: z
    .array(
      z.object({
        sourceId: z.string().uuid(),
        sourceLineReference: z.string().trim().max(100).nullish(),
        invoiceLineIndex: z.number().int().min(0).nullish(),
        amount: z
          .string()
          .trim()
          .regex(/^-?\d{1,13}(\.\d{1,2})?$/, "Use an amount like 1250.00")
          .nullish(),
      }),
    )
    .max(200)
    .nullish(),
});

export const unlinkInvoiceSourcesSchema = z.object({
  inboxId: z.string().uuid(),
  expectedMatchId,
  reason: reason.min(1, "Give a reason"),
});
