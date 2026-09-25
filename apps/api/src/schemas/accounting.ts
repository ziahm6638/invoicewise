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

export const accountingOrganisationSchema = z.object({
  provider: accountingProviderSchema,
  // A Xero tenant ID, from the organisations the connection reaches.
  organisationId: z.string().trim().min(1).max(64),
});

export const accountingSettingsSchema = z.object({
  provider: accountingProviderSchema,
  expenseAccountId: z.string().trim().min(1).max(64).nullable().optional(),
  taxCodeIds: z.array(z.string().trim().min(1).max(64)).max(50).optional(),
  // Automatic creation of provider records on processing. Switching it on
  // names the organisation the admin confirmed (its ID as shown to them).
  autoPost: z.boolean(),
  confirmOrganisationId: z.string().trim().min(1).max(64).nullable().optional(),
});
