import type { Context } from "@api/rest/types";
import { updateDeliveryPolicySchema } from "@api/schemas/delivery-rules";
import { OpenAPIHono } from "@hono/zod-openapi";
import { LOCKED_DELIVERY_RULES } from "@invoicewise/documents/delivery-policy";
import { InvoiceActionError } from "@invoicewise/jobs/delivery";
import {
  loadDeliveryPolicy,
  saveDeliveryPolicy,
} from "@invoicewise/jobs/delivery-rules";
import { withRequiredScope, withRequiredTeamRole } from "../middleware";

const app = new OpenAPIHono<Context>();

const STATUS = {
  not_found: 404,
  conflict: 409,
  invalid: 400,
  forbidden: 403,
} as const;

// The rules in force: version 0 is the built-in defaults. Checks listed in
// `alwaysHeld` cannot be switched off (docs/delivery.md#delivery-rules).
app.get("/", withRequiredScope("inbox.read"), async (c) => {
  const current = await loadDeliveryPolicy(c.get("db"), c.get("teamId"));
  return c.json({
    version: current.version,
    policy: current.policy,
    alwaysHeld: LOCKED_DELIVERY_RULES,
    createdAt: current.createdAt,
    createdBy: current.createdBy,
  });
});

// Saves a new version. `expectedVersion` is the version the caller edited;
// decisions already made keep their version and nothing is re-sent.
app.put(
  "/",
  withRequiredScope("inbox.write"),
  withRequiredTeamRole("admin"),
  async (c) => {
    const body = await c.req.json().catch(() => undefined);
    const parsed = updateDeliveryPolicySchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid delivery policy", issues: parsed.error.issues },
        400,
      );
    }
    try {
      const saved = await saveDeliveryPolicy(c.get("db"), {
        teamId: c.get("teamId"),
        actorId: c.get("session").user.id,
        teamRole: c.get("teamRole"),
        expectedVersion: parsed.data.expectedVersion,
        settings: parsed.data.policy,
      });
      return c.json({ version: saved.version, policy: saved.policy });
    } catch (error) {
      if (!(error instanceof InvoiceActionError)) throw error;
      return c.json(
        { error: error.message, issues: error.fields },
        STATUS[error.code],
      );
    }
  },
);

export { app as deliveryPolicyRouter };
