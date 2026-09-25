import { z } from "@hono/zod-openapi";
import {
  AUTHORIZATION_SOURCE_LIMITS,
  AUTHORIZATION_SOURCE_STATUSES,
  AUTHORIZATION_SOURCE_TYPES,
} from "@invoicewise/documents/authorization-source";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

export const authorizationSourceListSchema = z.object({
  q: z.string().trim().max(200).nullish(),
  type: z.enum(AUTHORIZATION_SOURCE_TYPES).nullish(),
  status: z.enum(AUTHORIZATION_SOURCE_STATUSES).nullish(),
  supplierId: z.string().uuid().nullish(),
  gap: z.enum(["unknown_supplier", "missing_currency"]).nullish(),
  cursor: z.string().regex(/^\d+$/).nullish(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

export const authorizationSourceIdSchema = z.object({ id: z.string().uuid() });

export const authorizationSourceVersionSchema = z.object({
  id: z.string().uuid(),
  version: z.coerce.number().int().min(1),
});

export const authorizationSourceEffectiveSchema = z.object({
  id: z.string().uuid(),
  on: isoDate,
  asOf: z.string().datetime({ offset: true }).nullish(),
});

const amount = z.union([z.string().max(40), z.number()]).nullish();
const text = (max: number) => z.string().max(max).nullish();

/**
 * The shape a source is supplied in. Values are only loosely typed here; the
 * rules (and their messages) live in `normalizeAuthorizationSource`, so a form,
 * a CSV row and a REST client all get the same answer.
 */
export const authorizationSourceInputSchema = z.object({
  type: z.string().max(40),
  reference: z.string().max(AUTHORIZATION_SOURCE_LIMITS.referenceLength * 2),
  status: text(40),
  title: text(AUTHORIZATION_SOURCE_LIMITS.titleLength * 2),
  scope: text(AUTHORIZATION_SOURCE_LIMITS.scopeLength * 2),
  supplier: z
    .object({
      id: z.string().max(64).nullish(),
      name: text(AUTHORIZATION_SOURCE_LIMITS.titleLength * 2),
      vatNumber: text(80),
      companyNumber: text(80),
    })
    .nullish(),
  currency: text(10),
  taxBasis: text(40),
  issuedOn: text(40),
  startsOn: text(40),
  endsOn: text(40),
  effectiveFrom: text(40),
  authorizedTotal: amount,
  changeReason: text(AUTHORIZATION_SOURCE_LIMITS.textLength * 2),
  lines: z
    .array(
      z.object({
        reference: text(AUTHORIZATION_SOURCE_LIMITS.referenceLength * 2),
        description: text(AUTHORIZATION_SOURCE_LIMITS.textLength * 2),
        quantity: amount,
        unitPrice: amount,
        amount,
      }),
    )
    .max(AUTHORIZATION_SOURCE_LIMITS.maxLinesPerSource)
    .nullish(),
});

export type AuthorizationSourceInput = z.infer<
  typeof authorizationSourceInputSchema
>;

export const createAuthorizationSourceSchema = z.object({
  source: authorizationSourceInputSchema,
});

export const amendAuthorizationSourceSchema = z.object({
  id: z.string().uuid(),
  source: authorizationSourceInputSchema,
});

export const setAuthorizationSourceStatusSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(AUTHORIZATION_SOURCE_STATUSES),
  reason: z
    .string()
    .trim()
    .max(AUTHORIZATION_SOURCE_LIMITS.textLength)
    .nullish(),
  effectiveFrom: isoDate.nullish(),
});

export const linkAuthorizationSourceSupplierSchema = z.object({
  id: z.string().uuid(),
  supplierId: z.string().uuid(),
});

export const importAuthorizationSourcesSchema = z.object({
  csv: z.string().max(AUTHORIZATION_SOURCE_LIMITS.maxCsvBytes),
  fileName: z.string().trim().max(200).nullish(),
  dryRun: z.boolean().default(false),
});

/** `POST /authorization-sources`: sources as they now stand, keyed by type and reference. */
export const submitAuthorizationSourcesSchema = z.object({
  sources: z
    .array(z.unknown())
    .min(1)
    .max(AUTHORIZATION_SOURCE_LIMITS.maxSourcesPerBatch),
  dryRun: z.boolean().default(false),
});

export const authorizationSourceDocumentSchema = z.object({
  id: z.string().uuid(),
  documentId: z.string().uuid(),
});
