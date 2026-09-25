import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import { createTRPCRouter } from "../init";
import { accountingRouter } from "./accounting";
import { apiKeysRouter } from "./api-keys";
import { billingRouter } from "./billing";
import { dataRouter } from "./data";
import { inboundEmailRouter } from "./inbound-email";
import { inboxRouter } from "./inbox";
import { inboxAccountsRouter } from "./inbox-accounts";
import { oauthApplicationsRouter } from "./oauth-applications";
import { questionsRouter } from "./questions";
import { suppliersRouter } from "./suppliers";
import { teamRouter } from "./team";
import { userRouter } from "./user";

export const appRouter = createTRPCRouter({
  accounting: accountingRouter,
  inbox: inboxRouter,
  inboundEmail: inboundEmailRouter,
  inboxAccounts: inboxAccountsRouter,
  oauthApplications: oauthApplicationsRouter,
  billing: billingRouter,
  data: dataRouter,
  team: teamRouter,
  user: userRouter,
  apiKeys: apiKeysRouter,
  questions: questionsRouter,
  suppliers: suppliersRouter,
});

// export type definition of API
export type AppRouter = typeof appRouter;
export type RouterOutputs = inferRouterOutputs<AppRouter>;
export type RouterInputs = inferRouterInputs<AppRouter>;
