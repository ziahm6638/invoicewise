import {
  accountingConnectSessionSchema,
  accountingConnectionSchema,
  accountingOrganisationSchema,
  accountingSettingsSchema,
} from "@api/schemas/accounting";
import {
  adminProcedure,
  createTRPCRouter,
  workspaceProcedure,
} from "@api/trpc/init";
import { getAccountingConnections } from "@invoicewise/db/queries";
import {
  AccountingSettingsError,
  accountingSetupMissing,
  checkAccountingConnection,
  completeAccountingConnection,
  createAccountingConnectSession,
  disconnectAccountingConnection,
  getAccountingProviderAvailability,
  getAccountingSetup,
  selectAccountingOrganisation,
  updateAccountingSettings,
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
        organisationId: connection.organisationId,
        organisationName: connection.organisationName,
        sandbox: connection.sandbox,
        autoPostEnabledAt: connection.autoPostEnabledAt,
        setupMissing: accountingSetupMissing(
          connection.provider,
          connection.settings,
        ),
        health: {
          status: connection.healthStatus,
          error: connection.healthError,
          checkedAt: connection.healthCheckedAt,
        },
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

  /**
   * What an admin chooses from to set up posting (the company's expense
   * accounts and purchase tax codes; for Xero also the organisations the
   * authorisation reaches), read live from the provider.
   */
  setup: adminProcedure.query(async ({ ctx: { db, teamId } }) => {
    try {
      return await getAccountingSetup(db, { teamId: teamId! });
    } catch (error) {
      throw failure(error, "Unable to read the accounting company");
    }
  }),

  updateSettings: adminProcedure
    .input(accountingSettingsSchema)
    .mutation(async ({ ctx: { db, teamId, session }, input }) => {
      try {
        const connection = await updateAccountingSettings(db, {
          ...input,
          teamId: teamId!,
          userId: session?.user.id ?? null,
        });
        return {
          id: connection?.id ?? null,
          autoPostEnabledAt: connection?.autoPostEnabledAt ?? null,
        };
      } catch (error) {
        if (error instanceof AccountingSettingsError) {
          throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
        }
        throw failure(error, "Unable to save the accounting settings");
      }
    }),

  /**
   * Chooses which organisation a Xero connection posts to; another
   * organisation starts its setup and opt-in over.
   */
  selectOrganisation: adminProcedure
    .input(accountingOrganisationSchema)
    .mutation(async ({ ctx: { db, teamId }, input }) => {
      try {
        const connection = await selectAccountingOrganisation(db, {
          ...input,
          teamId: teamId!,
        });
        return {
          id: connection?.id ?? null,
          organisationId: connection?.organisationId ?? null,
          organisationName: connection?.organisationName ?? null,
        };
      } catch (error) {
        if (error instanceof AccountingSettingsError) {
          throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
        }
        throw failure(error, "Unable to choose the organisation");
      }
    }),

  /** A live check of the connection through Nango; the result is stored. */
  checkHealth: adminProcedure.mutation(async ({ ctx: { db, teamId } }) => {
    const connection = await checkAccountingConnection(db, {
      teamId: teamId!,
    });
    if (!connection) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "No accounting connection is active",
      });
    }
    return {
      healthStatus: connection.healthStatus,
      healthError: connection.healthError,
      healthCheckedAt: connection.healthCheckedAt,
      organisationName: connection.organisationName,
    };
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
