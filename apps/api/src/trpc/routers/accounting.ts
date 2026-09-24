import {
  accountingConnectSessionSchema,
  accountingConnectionSchema,
} from "@api/schemas/accounting";
import {
  adminProcedure,
  createTRPCRouter,
  workspaceProcedure,
} from "@api/trpc/init";
import { getAccountingConnections } from "@invoicewise/db/queries";
import {
  completeAccountingConnection,
  createAccountingConnectSession,
  disconnectAccountingConnection,
  getAccountingProviderAvailability,
} from "@invoicewise/jobs/accounting";
import { TRPCError } from "@trpc/server";

const failure = (error: unknown, fallback: string) => {
  const message = error instanceof Error ? error.message : fallback;
  return new TRPCError({
    code:
      message === "Disconnect the current accounting connection first"
        ? "CONFLICT"
        : "BAD_GATEWAY",
    message,
  });
};

// Xero and QuickBooks connections through self-hosted Nango; the REST routes
// in rest/routers/accounting.ts expose the same operations to API clients.
export const accountingRouter = createTRPCRouter({
  get: workspaceProcedure.query(async ({ ctx: { db, teamId } }) => {
    const [providers, connections] = await Promise.all([
      getAccountingProviderAvailability(),
      getAccountingConnections(db, teamId!),
    ]);
    return {
      providers,
      connections: connections.map((connection) => ({
        id: connection.id,
        provider: connection.provider,
        connectedAt: connection.connectedAt,
        disconnectedAt: connection.disconnectedAt,
        status: connection.disconnectedAt ? "disconnected" : "connected",
      })),
    };
  }),

  createConnectSession: adminProcedure
    .input(accountingConnectSessionSchema)
    .mutation(async ({ ctx: { teamId }, input }) => {
      try {
        return await createAccountingConnectSession({
          teamId: teamId!,
          provider: input.provider,
        });
      } catch (error) {
        throw failure(error, "Unable to start the connection");
      }
    }),

  completeConnection: adminProcedure
    .input(accountingConnectionSchema)
    .mutation(async ({ ctx: { db, teamId }, input }) => {
      try {
        return await completeAccountingConnection(db, {
          teamId: teamId!,
          ...input,
        });
      } catch (error) {
        throw failure(error, "Unable to save the connection");
      }
    }),

  disconnect: adminProcedure
    .input(accountingConnectSessionSchema)
    .mutation(async ({ ctx: { db, teamId }, input }) => {
      try {
        const connection = await disconnectAccountingConnection(db, {
          teamId: teamId!,
          provider: input.provider,
        });
        if (!connection) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Accounting connection not found",
          });
        }
        return { id: connection.id, status: "disconnected" as const };
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        throw failure(error, "Unable to disconnect");
      }
    }),
});
