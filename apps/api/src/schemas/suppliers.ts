import { z } from "@hono/zod-openapi";

export const supplierInvoiceSchema = z.object({ inboxId: z.string().uuid() });

export const assignInvoiceSupplierSchema = z
  .object({
    inboxId: z.string().uuid(),
    supplierId: z.string().uuid().optional(),
    newSupplierName: z.string().trim().min(1).max(200).optional(),
  })
  .refine(
    (input) => Boolean(input.supplierId) !== Boolean(input.newSupplierName),
    {
      message: "Choose an existing supplier or name a new one",
    },
  );

export const mergeSuppliersSchema = z.object({
  sourceId: z.string().uuid(),
  targetId: z.string().uuid(),
  inboxId: z.string().uuid().optional(),
});

export const revertSupplierChangeSchema = z.object({
  eventId: z.string().uuid(),
  inboxId: z.string().uuid().optional(),
});
