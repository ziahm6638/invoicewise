import {
  connectInboxAccountSchema,
  deleteInboxAccountSchema,
  exchangeCodeForAccountSchema,
  syncInboxAccountSchema,
  workflowStatusSchema,
} from "@api/schemas/inbox-accounts";
import {
  adminProcedure,
  createTRPCRouter,
  workspaceProcedure,
} from "@api/trpc/init";
import {
  deleteInboxAccount,
  getInboxAccountById,
  getInboxAccounts,
} from "@invoicewise/db/queries";
import { InboxConnector } from "@invoicewise/inbox/connector";
import {
  enqueueWorkflow,
  getWorkflowStatus,
  workflowKey,
} from "@invoicewise/jobs";
import { TRPCError } from "@trpc/server";

export const inboxAccountsRouter = createTRPCRouter({
  get: workspaceProcedure.query(async ({ ctx: { db, teamId } }) => {
    return getInboxAccounts(db, teamId!);
  }),

  connect: adminProcedure
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

  exchangeCodeForAccount: adminProcedure
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

  delete: adminProcedure
    .input(deleteInboxAccountSchema)
    .mutation(async ({ ctx: { db, teamId }, input }) => {
      const data = await deleteInboxAccount(db, {
        id: input.id,
        teamId: teamId!,
      });

      return data;
    }),

  sync: adminProcedure
    .input(syncInboxAccountSchema)
    .mutation(async ({ ctx: { db, teamId }, input }) => {
      // The idempotency key is per account, so an account from another
      // workspace must be refused here rather than only by the worker.
      const account = await getInboxAccountById(db, {
        id: input.id,
        teamId: teamId!,
      });

      if (!account) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Inbox account not found",
        });
      }

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

  syncStatus: workspaceProcedure
    .input(workflowStatusSchema)
    .query(async ({ ctx: { db, teamId }, input }) => {
      return getWorkflowStatus(db, { id: input.id, teamId: teamId! });
    }),
});
