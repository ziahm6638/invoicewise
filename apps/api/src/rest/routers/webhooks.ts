import type { Context } from "@api/rest/types";
import {
  createWebhookEndpointSchema,
  webhookEndpointIdSchema,
} from "@api/schemas/webhooks";
import { OpenAPIHono } from "@hono/zod-openapi";
import {
  createWebhookEndpoint,
  disableWebhookEndpoint,
  getWebhookAttemptsByEndpoint,
  getWebhookEndpointById,
  getWebhookEndpoints,
} from "@invoicewise/db/queries";
import { withRequiredScope, withRequiredTeamRole } from "../middleware";

const app = new OpenAPIHono<Context>();

app.get("/", withRequiredScope("inbox.read"), async (c) =>
  c.json({ data: await getWebhookEndpoints(c.get("db"), c.get("teamId")) }),
);

app.post(
  "/",
  withRequiredScope("inbox.write"),
  withRequiredTeamRole("admin"),
  async (c) => {
    const body = await c.req.json().catch(() => undefined);
    const parsed = createWebhookEndpointSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid webhook endpoint", issues: parsed.error.issues },
        400,
      );
    }
    const endpoint = await createWebhookEndpoint(c.get("db"), {
      ...parsed.data,
      teamId: c.get("teamId"),
      userId: c.get("session").user.id,
    });
    return c.json(endpoint, 201);
  },
);

app.get("/:id/attempts", withRequiredScope("inbox.read"), async (c) => {
  const parsed = webhookEndpointIdSchema.safeParse(c.req.param());
  if (!parsed.success) return c.json({ error: "Invalid endpoint ID" }, 400);
  const input = { ...parsed.data, teamId: c.get("teamId") };
  if (!(await getWebhookEndpointById(c.get("db"), input))) {
    return c.json({ error: "Webhook endpoint not found" }, 404);
  }
  return c.json({
    data: await getWebhookAttemptsByEndpoint(c.get("db"), {
      endpointId: input.id,
      teamId: input.teamId,
    }),
  });
});

app.delete(
  "/:id",
  withRequiredScope("inbox.write"),
  withRequiredTeamRole("admin"),
  async (c) => {
    const parsed = webhookEndpointIdSchema.safeParse(c.req.param());
    if (!parsed.success) return c.json({ error: "Invalid endpoint ID" }, 400);
    const endpoint = await disableWebhookEndpoint(c.get("db"), {
      ...parsed.data,
      teamId: c.get("teamId"),
    });
    return endpoint
      ? c.json({ id: endpoint.id, active: false })
      : c.json({ error: "Webhook endpoint not found" }, 404);
  },
);

export { app as webhooksRouter };
