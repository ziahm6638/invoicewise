import { invoiceHttp } from "@api/effect/invoice-http";
import type { Context } from "@api/rest/types";
import { OpenAPIHono } from "@hono/zod-openapi";
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

export { app as invoicesRouter };
