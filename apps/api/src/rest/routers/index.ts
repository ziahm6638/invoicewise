import { OpenAPIHono } from "@hono/zod-openapi";
import { protectedMiddleware, withRequiredTeam } from "../middleware";
import { accountingRouter } from "./accounting";
import { authorizationSourcesRouter } from "./authorization-sources";
import { bankPaymentsRouter } from "./bank-payments";
import { deliveryPolicyRouter } from "./delivery-policy";
import { inboxRouter } from "./inbox";
import { invoicesRouter } from "./invoices";
import oauthRouter from "./oauth";
import { teamsRouter } from "./teams";
import { usersRouter } from "./users";
import { webhooksRouter } from "./webhooks";

const routers = new OpenAPIHono();

// Mount OAuth routes first (publicly accessible)
routers.route("/oauth", oauthRouter);

// Apply protected middleware to all subsequent routes
routers.use(...protectedMiddleware);

// Workspace resources need an active workspace
for (const path of [
  "/inbox",
  "/invoices",
  "/webhooks",
  "/accounting",
  "/authorization-sources",
  "/delivery-policy",
  "/bank-payments",
]) {
  routers.use(path, withRequiredTeam);
  routers.use(`${path}/*`, withRequiredTeam);
}

// Mount protected routes
routers.route("/teams", teamsRouter);
routers.route("/users", usersRouter);
routers.route("/inbox", inboxRouter);
routers.route("/invoices", invoicesRouter);
routers.route("/webhooks", webhooksRouter);
routers.route("/accounting", accountingRouter);
routers.route("/authorization-sources", authorizationSourcesRouter);
routers.route("/delivery-policy", deliveryPolicyRouter);
routers.route("/bank-payments", bankPaymentsRouter);

export { routers };
