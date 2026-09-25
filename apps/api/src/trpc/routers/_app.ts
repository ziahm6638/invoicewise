import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import { createTRPCRouter } from "../init";
import { accountingRouter } from "./accounting";
import { apiKeysRouter } from "./api-keys";
import { authorizationSourcesRouter } from "./authorization-sources";
import { billingRouter } from "./billing";
import { dataRouter } from "./data";
import { deliveryRulesRouter } from "./delivery-rules";
import { inboundEmailRouter } from "./inbound-email";
import { inboxRouter } from "./inbox";
import { inboxAccountsRouter } from "./inbox-accounts";
import { oauthApplicationsRouter } from "./oauth-applications";
import { questionsRouter } from "./questions";
import { sourceMatchesRouter } from "./source-matches";
import { suppliersRouter } from "./suppliers";
import { teamRouter } from "./team";
import { userRouter } from "./user";
import { webhooksRouter } from "./webhooks";

export const appRouter = createTRPCRouter({
  accounting: accountingRouter,
  authorizationSources: authorizationSourcesRouter,
  inbox: inboxRouter,
  inboundEmail: inboundEmailRouter,
  inboxAccounts: inboxAccountsRouter,
  oauthApplications: oauthApplicationsRouter,
  billing: billingRouter,
  data: dataRouter,
  deliveryRules: deliveryRulesRouter,
  team: teamRouter,
  user: userRouter,
  apiKeys: apiKeysRouter,
  questions: questionsRouter,
  sourceMatches: sourceMatchesRouter,
  suppliers: suppliersRouter,
  webhooks: webhooksRouter,
});

// export type definition of API
export type AppRouter = typeof appRouter;
export type RouterOutputs = inferRouterOutputs<AppRouter>;
export type RouterInputs = inferRouterInputs<AppRouter>;
