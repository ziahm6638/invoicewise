import type { Context } from "@api/rest/types";
import {
  createWebhookEndpointSchema,
  rotateWebhookSecretSchema,
  webhookAttemptsQuerySchema,
  webhookDeliveryParamsSchema,
  webhookEndpointIdSchema,
} from "@api/schemas/webhooks";
import {
  registerWebhookEndpoint,
  rotateEndpointSecret,
} from "@api/services/webhooks";
import { OpenAPIHono } from "@hono/zod-openapi";
import {
  disableWebhookEndpoint,
  getWebhookAttemptsByEndpoint,
  getWebhookEndpointById,
  getWebhookEndpointDeliveries,
  getWebhookEndpoints,
} from "@invoicewise/db/queries";
import {
  redeliverWebhook,
  sendWebhookTestEvent,
} from "@invoicewise/jobs/delivery";
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
    const result = await registerWebhookEndpoint(c.get("db"), {
      ...parsed.data,
      teamId: c.get("teamId"),
      userId: c.get("session").user.id,
    });
    if ("error" in result) {
      return c.json({ error: result.error }, result.status);
    }
    return c.json(result.endpoint, 201);
  },
);

app.get("/:id/deliveries", withRequiredScope("inbox.read"), async (c) => {
  const parsed = webhookEndpointIdSchema.safeParse(c.req.param());
  if (!parsed.success) return c.json({ error: "Invalid endpoint ID" }, 400);
  const input = { ...parsed.data, teamId: c.get("teamId") };
  if (!(await getWebhookEndpointById(c.get("db"), input))) {
    return c.json({ error: "Webhook endpoint not found" }, 404);
  }
  return c.json({
    data: await getWebhookEndpointDeliveries(c.get("db"), {
      endpointId: input.id,
      teamId: input.teamId,
    }),
  });
});

app.get("/:id/attempts", withRequiredScope("inbox.read"), async (c) => {
  const parsed = webhookEndpointIdSchema.safeParse(c.req.param());
  const query = webhookAttemptsQuerySchema.safeParse(c.req.query());
  if (!parsed.success) return c.json({ error: "Invalid endpoint ID" }, 400);
  if (!query.success) return c.json({ error: "Invalid delivery ID" }, 400);
  const input = { ...parsed.data, teamId: c.get("teamId") };
  if (!(await getWebhookEndpointById(c.get("db"), input))) {
    return c.json({ error: "Webhook endpoint not found" }, 404);
  }
  return c.json({
    data: await getWebhookAttemptsByEndpoint(c.get("db"), {
      endpointId: input.id,
      teamId: input.teamId,
      deliveryId: query.data.deliveryId,
    }),
  });
});

app.post(
  "/:id/rotate-secret",
  withRequiredScope("inbox.write"),
  withRequiredTeamRole("admin"),
  async (c) => {
    const parsed = webhookEndpointIdSchema.safeParse(c.req.param());
    if (!parsed.success) return c.json({ error: "Invalid endpoint ID" }, 400);
    const body = rotateWebhookSecretSchema.safeParse(
      await c.req.json().catch(() => ({})),
    );
    if (!body.success) {
      return c.json(
        { error: "Invalid rotation request", issues: body.error.issues },
        400,
      );
    }
    const result = await rotateEndpointSecret(c.get("db"), {
      id: parsed.data.id,
      teamId: c.get("teamId"),
      revokePrevious: body.data.revokePrevious,
    });
    if ("error" in result) {
      return c.json({ error: result.error }, result.status);
    }
    return c.json(result.rotated);
  },
);

app.post(
  "/:id/test",
  withRequiredScope("inbox.write"),
  withRequiredTeamRole("admin"),
  async (c) => {
    const parsed = webhookEndpointIdSchema.safeParse(c.req.param());
    if (!parsed.success) return c.json({ error: "Invalid endpoint ID" }, 400);
    const queued = await sendWebhookTestEvent(c.get("db"), {
      endpointId: parsed.data.id,
      teamId: c.get("teamId"),
    });
    return queued
      ? c.json(queued, 202)
      : c.json({ error: "Webhook endpoint not found or disabled" }, 404);
  },
);

app.post(
  "/:id/deliveries/:deliveryId/redeliver",
  withRequiredScope("inbox.write"),
  withRequiredTeamRole("admin"),
  async (c) => {
    const parsed = webhookDeliveryParamsSchema.safeParse(c.req.param());
    if (!parsed.success) return c.json({ error: "Invalid delivery ID" }, 400);
    const result = await redeliverWebhook(c.get("db"), {
      deliveryId: parsed.data.deliveryId,
      endpointId: parsed.data.id,
      teamId: c.get("teamId"),
    });
    switch (result.status) {
      case "requeued":
        return c.json(result, 202);
      case "not_found":
        return c.json({ error: "Webhook delivery not found" }, 404);
      case "not_failed":
        return c.json(
          { error: "Only a failed delivery can be redelivered" },
          409,
        );
      case "endpoint_disabled":
        return c.json({ error: "Webhook endpoint is disabled" }, 409);
      case "payload_expired":
        return c.json(
          {
            error:
              "The event payload was removed by retention; fetch the invoice with GET /invoices/:id instead",
          },
          410,
        );
    }
  },
);

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
