import { z } from "zod";

export const accountingProviderSchema = z.enum(["xero", "quickbooks"]);

export const accountingConnectSessionSchema = z.object({
  provider: accountingProviderSchema,
});

export const accountingConnectionSchema = z.object({
  provider: accountingProviderSchema,
  connectionId: z.string().trim().min(1).max(255),
});

export const accountingProviderParamSchema = z.object({
  provider: accountingProviderSchema,
});

export const accountingInvoiceParamSchema = z.object({
  id: z.string().uuid(),
});
