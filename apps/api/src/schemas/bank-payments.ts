import { z } from "@hono/zod-openapi";

const consent = {
  consentAccepted: z
    .literal(true)
    .describe(
      "The owner or admin agreed to read-only access to the bank's accounts and transactions",
    ),
  consentPeriodDays: z
    .union([z.literal(30), z.literal(60), z.literal(90), z.literal(180)])
    .optional(),
};

export const setBankPaymentsSchema = z.object({ enabled: z.boolean() });

export const connectBankSchema = z.object(consent);

export const bankConnectionIdSchema = z.object({
  connectionId: z.string().uuid(),
});

export const reconnectBankSchema = z.object({
  connectionId: z.string().uuid(),
  ...consent,
});

export const completeBankConnectionSchema = z.object({
  connectionId: z.string().uuid(),
  // What Salt Edge appended to the return URL; verified with Salt Edge.
  providerConnectionId: z
    .string()
    .trim()
    .regex(/^[0-9A-Za-z_-]{1,64}$/)
    .nullish(),
  errorClass: z.string().trim().max(200).nullish(),
});

export const bankTransactionsSchema = z.object({
  connectionId: z.string().uuid().optional(),
  status: z.enum(["pending", "posted", "superseded", "reversed"]).optional(),
  page: z.coerce.number().int().min(0).max(1_000).default(0),
});

export const invoicePaymentsSchema = z.object({ inboxId: z.string().uuid() });

const expectedMatchId = z
  .string()
  .uuid()
  .nullable()
  .optional()
  .describe("The decision the change was made against; a newer one refuses it");

const reason = z.string().trim().max(1_000);

const amount = z
  .string()
  .trim()
  .regex(/^\d{1,13}(\.\d{1,2})?$/, "Use an amount like 1250.00");

export const confirmPaymentSchema = z.object({
  inboxId: z.string().uuid(),
  expectedMatchId,
  reason: reason.nullish(),
});

export const recordPaymentsSchema = z.object({
  inboxId: z.string().uuid(),
  expectedMatchId,
  reason: reason.nullish(),
  payments: z
    .array(
      z.object({
        transactionId: z.string().uuid(),
        amount,
        fee: amount.nullish(),
      }),
    )
    .min(1)
    .max(20),
});

export const unlinkPaymentsSchema = z.object({
  inboxId: z.string().uuid(),
  expectedMatchId,
  reason: reason.min(1, "Give a reason"),
});
