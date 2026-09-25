import { invoiceHttp, invoiceReadRequest } from "@api/effect/invoice-http";
import type { Context } from "@api/rest/types";
import { heldDeliverySchema } from "@api/schemas/delivery-rules";
import { retryInboxSchema } from "@api/schemas/inbox";
import { OpenAPIHono } from "@hono/zod-openapi";
import {
  InvoiceActionError,
  dismissHeldDelivery,
  releaseHeldDelivery,
  retryInvoiceDelivery,
} from "@invoicewise/jobs/delivery";
import { withRequiredScope } from "../middleware";

const app = new OpenAPIHono<Context>();

const forward = (request: Request, teamId: string, scopes: string[]) =>
  invoiceHttp.handler(invoiceReadRequest(request, { teamId, scopes }));

app.use("*", withRequiredScope("inbox.read"));
app.get("/", (c) => forward(c.req.raw, c.get("teamId"), c.get("scopes")));
app.get("/export.csv", (c) =>
  forward(c.req.raw, c.get("teamId"), c.get("scopes")),
);
app.get("/:id", (c) => forward(c.req.raw, c.get("teamId"), c.get("scopes")));
app.get("/:id/delivery-status", (c) =>
  forward(c.req.raw, c.get("teamId"), c.get("scopes")),
);

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

const HELD_STATUS = {
  not_found: 404,
  conflict: 409,
  invalid: 400,
  forbidden: 403,
} as const;

// Resolving an invoice the delivery rules held (owner or admin): `release`
// sends what was held, `dismiss` records that nothing is sent. Both name the
// revision the caller saw and a reason, kept on the decision.
for (const action of ["release", "dismiss"] as const) {
  app.post(
    `/:id/delivery/${action}`,
    withRequiredScope("inbox.write"),
    async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const parsed = heldDeliverySchema.safeParse({
        ...(body && typeof body === "object" ? body : {}),
        id: c.req.param("id"),
      });
      if (!parsed.success) {
        return c.json(
          { error: "Invalid request", issues: parsed.error.issues },
          400,
        );
      }
      const input = {
        invoiceId: parsed.data.id,
        teamId: c.get("teamId"),
        actorId: c.get("session").user.id,
        teamRole: c.get("teamRole"),
        expectedRevision: parsed.data.revision,
        reason: parsed.data.reason,
      };
      try {
        return c.json(
          action === "release"
            ? await releaseHeldDelivery(c.get("db"), input)
            : await dismissHeldDelivery(c.get("db"), input),
        );
      } catch (error) {
        if (!(error instanceof InvoiceActionError)) throw error;
        return c.json({ error: error.message }, HELD_STATUS[error.code]);
      }
    },
  );
}

export { app as invoicesRouter };
