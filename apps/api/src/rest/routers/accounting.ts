import type { Context } from "@api/rest/types";
import {
  accountingConnectSessionSchema,
  accountingConnectionSchema,
  accountingInvoiceParamSchema,
  accountingProviderParamSchema,
} from "@api/schemas/accounting";
import { OpenAPIHono } from "@hono/zod-openapi";
import { getAccountingConnections } from "@invoicewise/db/queries";
import {
  completeAccountingConnection,
  createAccountingConnectSession,
  disconnectAccountingConnection,
  retryAccountingPost,
} from "@invoicewise/jobs/accounting";
import { withRequiredScope } from "../middleware";

const app = new OpenAPIHono<Context>();

const message = (error: unknown) =>
  error instanceof Error ? error.message : "Accounting integration failed";

app.get("/connections", withRequiredScope("inbox.read"), async (c) => {
  const connections = await getAccountingConnections(
    c.get("db"),
    c.get("teamId"),
  );
  return c.json({
    data: connections.map((connection) => ({
      ...connection,
      status: connection.disconnectedAt ? "disconnected" : "connected",
    })),
  });
});

app.post("/connect-sessions", withRequiredScope("inbox.write"), async (c) => {
  const parsed = accountingConnectSessionSchema.safeParse(
    await c.req.json().catch(() => undefined),
  );
  if (!parsed.success) {
    return c.json(
      { error: "Invalid accounting provider", issues: parsed.error.issues },
      400,
    );
  }
  try {
    return c.json(
      await createAccountingConnectSession({
        teamId: c.get("teamId"),
        provider: parsed.data.provider,
      }),
      201,
    );
  } catch (error) {
    return c.json({ error: message(error) }, 502);
  }
});

app.post("/connections", withRequiredScope("inbox.write"), async (c) => {
  const parsed = accountingConnectionSchema.safeParse(
    await c.req.json().catch(() => undefined),
  );
  if (!parsed.success) {
    return c.json(
      { error: "Invalid accounting connection", issues: parsed.error.issues },
      400,
    );
  }
  try {
    const connection = await completeAccountingConnection(c.get("db"), {
      teamId: c.get("teamId"),
      ...parsed.data,
    });
    return c.json(connection, 201);
  } catch (error) {
    const errorMessage = message(error);
    return c.json(
      { error: errorMessage },
      errorMessage === "Disconnect the current accounting connection first"
        ? 409
        : 502,
    );
  }
});

app.delete(
  "/connections/:provider",
  withRequiredScope("inbox.write"),
  async (c) => {
    const parsed = accountingProviderParamSchema.safeParse(c.req.param());
    if (!parsed.success) {
      return c.json({ error: "Invalid accounting provider" }, 400);
    }
    try {
      const connection = await disconnectAccountingConnection(c.get("db"), {
        teamId: c.get("teamId"),
        provider: parsed.data.provider,
      });
      return connection
        ? c.json({ id: connection.id, status: "disconnected" })
        : c.json({ error: "Accounting connection not found" }, 404);
    } catch (error) {
      return c.json({ error: message(error) }, 502);
    }
  },
);

app.post("/invoices/:id/retry", withRequiredScope("inbox.write"), async (c) => {
  const parsed = accountingInvoiceParamSchema.safeParse(c.req.param());
  if (!parsed.success) return c.json({ error: "Invalid invoice ID" }, 400);
  try {
    const result = await retryAccountingPost(c.get("db"), {
      invoiceId: parsed.data.id,
      teamId: c.get("teamId"),
    });
    return result
      ? c.json(result)
      : c.json({ error: "Invoice not found" }, 404);
  } catch (error) {
    const errorMessage = message(error);
    return c.json(
      { error: errorMessage },
      errorMessage === "No accounting connection is active" ? 409 : 500,
    );
  }
});

export { app as accountingRouter };
