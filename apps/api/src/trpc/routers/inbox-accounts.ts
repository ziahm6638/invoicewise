import {
  connectInboxAccountSchema,
  deleteInboxAccountSchema,
  exchangeCodeForAccountSchema,
  syncInboxAccountSchema,
  workflowStatusSchema,
} from "@api/schemas/inbox-accounts";
import { createTRPCRouter, protectedProcedure } from "@api/trpc/init";
import { deleteInboxAccount, getInboxAccounts } from "@invoicewise/db/queries";
import { InboxConnector } from "@invoicewise/inbox/connector";
import {
  enqueueWorkflow,
  getWorkflowStatus,
  workflowKey,
} from "@invoicewise/jobs";
import { TRPCError } from "@trpc/server";

export const inboxAccountsRouter = createTRPCRouter({
  get: protectedProcedure.query(async ({ ctx: { db, teamId } }) => {
    return getInboxAccounts(db, teamId!);
  }),

  connect: protectedProcedure
    .input(connectInboxAccountSchema)
    .mutation(async ({ ctx: { db }, input }) => {
      try {
        const connector = new InboxConnector(input.provider, db);

        return connector.connect();
      } catch (error) {
        console.error(error);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to connect to inbox account",
        });
      }
    }),

  exchangeCodeForAccount: protectedProcedure
    .input(exchangeCodeForAccountSchema)
    .query(async ({ ctx: { db, teamId }, input }) => {
      try {
        const connector = new InboxConnector(input.provider, db);

        const account = await connector.exchangeCodeForAccount({
          code: input.code,
          teamId: teamId!,
        });

        return account;
      } catch (error) {
        console.error(error);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to exchange code for account",
        });
      }
    }),

  delete: protectedProcedure
    .input(deleteInboxAccountSchema)
    .mutation(async ({ ctx: { db, teamId }, input }) => {
      const data = await deleteInboxAccount(db, {
        id: input.id,
        teamId: teamId!,
      });

      return data;
    }),

  sync: protectedProcedure
    .input(syncInboxAccountSchema)
    .mutation(async ({ ctx: { db, teamId }, input }) => {
      return enqueueWorkflow(db, {
        name: "sync-inbox-account",
        teamId: teamId!,
        idempotencyKey: workflowKey.inboxSync(
          input.id,
          `manual:${Math.floor(Date.now() / 60_000)}`,
        ),
        payload: {
          id: input.id,
          manualSync: input.manualSync ?? false,
          scheduleNext: false,
        },
      });
    }),

  syncStatus: protectedProcedure
    .input(workflowStatusSchema)
    .query(async ({ ctx: { db, teamId }, input }) => {
      return getWorkflowStatus(db, { id: input.id, teamId: teamId! });
    }),
});
