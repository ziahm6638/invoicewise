import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import { createTRPCRouter } from "../init";
import { apiKeysRouter } from "./api-keys";
import { billingRouter } from "./billing";
import { inboxRouter } from "./inbox";
import { inboxAccountsRouter } from "./inbox-accounts";
import { oauthApplicationsRouter } from "./oauth-applications";
import { questionsRouter } from "./questions";
import { teamRouter } from "./team";
import { userRouter } from "./user";

export const appRouter = createTRPCRouter({
  inbox: inboxRouter,
  inboxAccounts: inboxAccountsRouter,
  oauthApplications: oauthApplicationsRouter,
  billing: billingRouter,
  team: teamRouter,
  user: userRouter,
  apiKeys: apiKeysRouter,
  questions: questionsRouter,
});

// export type definition of API
export type AppRouter = typeof appRouter;
export type RouterOutputs = inferRouterOutputs<AppRouter>;
export type RouterInputs = inferRouterInputs<AppRouter>;
