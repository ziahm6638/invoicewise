import { z } from "@hono/zod-openapi";
import { DELIVERY_POLICY_LIMITS } from "@invoicewise/documents/delivery-policy";

/**
 * A new version of the workspace's delivery rules. The rules themselves are
 * checked by `normalizeDeliveryPolicy` (the same vocabulary the dashboard
 * and the worker use); `expectedVersion` is the version the caller edited.
 */
export const updateDeliveryPolicySchema = z.object({
  expectedVersion: z.number().int().min(0),
  policy: z.record(z.string(), z.unknown()),
});

/** Releasing or dismissing a held invoice, at the revision the caller saw. */
export const heldDeliverySchema = z.object({
  id: z.string().uuid(),
  revision: z.number().int().min(0),
  reason: z
    .string()
    .trim()
    .min(3)
    .max(DELIVERY_POLICY_LIMITS.maxResolutionReasonLength),
});
