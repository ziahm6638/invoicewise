import type { Context } from "@api/rest/types";
import { bankTransactionsSchema } from "@api/schemas/bank-payments";
import { OpenAPIHono } from "@hono/zod-openapi";
import { listBankFeedTransactions } from "@invoicewise/db/queries";
import { getBankPaymentsOverview } from "@invoicewise/jobs/bank-feeds";
import { withRequiredScope, withRequiredTeamRole } from "../middleware";

/**
 * Optional bank payments (docs/bank-payments.md): the workspace's bank
 * connections with their consent and last sync, and its transactions with
 * what each invoice's current payment decision counts. Bank data is for
 * owners and admins only, with `payments.read`.
 */
const app = new OpenAPIHono<Context>();

app.use("*", withRequiredScope("payments.read"), withRequiredTeamRole("admin"));

app.get("/", async (c) => {
  const overview = await getBankPaymentsOverview(c.get("db"), {
    teamId: c.get("teamId"),
  });
  const { consentPeriods, defaultConsentDays, ...rest } = overview;
  return c.json(rest);
});

app.get("/transactions", async (c) => {
  const parsed = bankTransactionsSchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ error: "Invalid query", issues: parsed.error.issues }, 400);
  }
  const pageSize = 100;
  const rows = await listBankFeedTransactions(c.get("db"), {
    teamId: c.get("teamId"),
    connectionId: parsed.data.connectionId,
    status: parsed.data.status,
    limit: pageSize + 1,
    offset: parsed.data.page * pageSize,
  });
  return c.json({
    data: rows
      .slice(0, pageSize)
      .map(({ providerTransactionId, ...row }) => row),
    meta: { page: parsed.data.page, hasNextPage: rows.length > pageSize },
  });
});

export { app as bankPaymentsRouter };
