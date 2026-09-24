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
  consumeConnectorState,
  createConnectorState,
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
    .mutation(async ({ ctx: { db, session, teamId }, input }) => {
      const sessionId = session.sessionId;

      // The callback lands in the browser that started the connect, so the
      // flow is only offered to a browser session.
      if (!sessionId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Connecting a mailbox requires a signed-in browser session",
        });
      }

      try {
        const connector = new InboxConnector(input.provider, db);
        const state = await createConnectorState(db, {
          provider: input.provider,
          userId: session.user.id,
          teamId: teamId!,
          sessionId,
        });

        return await connector.connect(state);
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
    .query(async ({ ctx: { db, session, teamId }, input }) => {
      // The state must be one this session issued for this workspace,
      // unexpired and unused. It is consumed before the code is exchanged, so
      // a replayed or forged callback never reaches the provider.
      const issuedFor = session.sessionId
        ? await consumeConnectorState(db, {
            state: input.state,
            userId: session.user.id,
            teamId: teamId!,
            sessionId: session.sessionId,
          })
        : null;

      const provider =
        connectInboxAccountSchema.shape.provider.safeParse(issuedFor);

      if (!provider.success) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Invalid or expired connection request",
        });
      }

      try {
        const connector = new InboxConnector(provider.data, db);

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
