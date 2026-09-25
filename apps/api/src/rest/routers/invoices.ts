import { invoiceHttp } from "@api/effect/invoice-http";
import type { Context } from "@api/rest/types";
import { retryInboxSchema } from "@api/schemas/inbox";
import { readInvoiceActivity } from "@api/services/activity";
import { OpenAPIHono } from "@hono/zod-openapi";
import { retryInvoiceDelivery } from "@invoicewise/jobs/delivery";
import { withRequiredScope } from "../middleware";

const app = new OpenAPIHono<Context>();

const forward = (request: Request, teamId: string) => {
  const headers = new Headers(request.headers);
  headers.set("x-invoicewise-team-id", teamId);
  return invoiceHttp.handler(new Request(request, { headers }));
};

app.use("*", withRequiredScope("inbox.read"));
app.get("/", (c) => forward(c.req.raw, c.get("teamId")));
app.get("/export.csv", (c) => forward(c.req.raw, c.get("teamId")));
app.get("/:id", (c) => forward(c.req.raw, c.get("teamId")));
app.get("/:id/delivery-status", (c) => forward(c.req.raw, c.get("teamId")));

// The invoice's activity trace (docs/delivery.md#activity-trace).
app.get("/:id/activity", async (c) => {
  const parsed = retryInboxSchema.safeParse(c.req.param());
  if (!parsed.success) return c.json({ error: "Invalid invoice ID" }, 400);
  const activity = await readInvoiceActivity(c.get("db"), {
    teamId: c.get("teamId"),
    invoiceId: parsed.data.id,
    audience: "customer",
  });
  return activity
    ? c.json(activity)
    : c.json({ error: "Invoice not found" }, 404);
});

// Recovery action: re-drives the failed or cancelled destinations of the
// invoice's current revision, skipping disabled or disconnected ones. The
// accounting re-post keeps its admin requirement and is otherwise reported as
// `admin_required`.
app.post("/:id/delivery/retry", withRequiredScope("inbox.write"), async (c) => {
  const parsed = retryInboxSchema.safeParse(c.req.param());
  if (!parsed.success) return c.json({ error: "Invalid invoice ID" }, 400);
  const result = await retryInvoiceDelivery(c.get("db"), {
    invoiceId: parsed.data.id,
    teamId: c.get("teamId"),
    teamRole: c.get("teamRole"),
  });
  return result ? c.json(result) : c.json({ error: "Invoice not found" }, 404);
});

export { app as invoicesRouter };
