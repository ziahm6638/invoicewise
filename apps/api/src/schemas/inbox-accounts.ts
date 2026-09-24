import { z } from "@hono/zod-openapi";

export const connectInboxAccountSchema = z.object({
  provider: z.enum(["gmail"]),
});

export const exchangeCodeForAccountSchema = z.object({
  code: z.string(),
  // The single-use value issued by `connect`; it also names the provider.
  state: z.string().min(1),
});

export const deleteInboxAccountSchema = z.object({ id: z.string() });

export const syncInboxAccountSchema = z.object({
  id: z.string(),
  manualSync: z.boolean().optional(),
});

export const workflowStatusSchema = z.object({ id: z.string().uuid() });
