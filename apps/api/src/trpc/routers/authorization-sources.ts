import {
  amendAuthorizationSourceSchema,
  authorizationSourceEffectiveSchema,
  authorizationSourceIdSchema,
  authorizationSourceListSchema,
  authorizationSourceVersionSchema,
  createAuthorizationSourceSchema,
  importAuthorizationSourcesSchema,
  linkAuthorizationSourceSupplierSchema,
  setAuthorizationSourceStatusSchema,
} from "@api/schemas/authorization-sources";
import {
  adminProcedure,
  createTRPCRouter,
  workspaceProcedure,
} from "@api/trpc/init";
import {
  presentAuthorizationSource,
  presentAuthorizationSourceList,
  presentAuthorizationVersion,
} from "@api/utils/authorization-sources";
import {
  canManageAuthorizationSources,
  getAuthorizationSource,
  getAuthorizationSourceVersion,
  getEffectiveAuthorizationSourceVersion,
  listAuthorizationSourceImports,
  listAuthorizationSources,
} from "@invoicewise/db/queries";
import {
  AuthorizationSourceError,
  amendAuthorizationSource,
  createAuthorizationSource,
  importAuthorizationSourcesCsv,
  linkAuthorizationSourceSupplier,
  setAuthorizationSourceStatus,
} from "@invoicewise/jobs/authorization-sources";
import { TRPCError } from "@trpc/server";

const writing = async <T>(work: () => Promise<T>) => {
  try {
    return await work();
  } catch (error) {
    if (error instanceof AuthorizationSourceError) {
      throw new TRPCError({
        code:
          error.code === "not_found"
            ? "NOT_FOUND"
            : error.code === "conflict"
              ? "CONFLICT"
              : "BAD_REQUEST",
        message: error.message,
      });
    }
    throw error;
  }
};

const notFound = () =>
  new TRPCError({
    code: "NOT_FOUND",
    message: "Authorization source not found",
  });

/**
 * Jobs, purchase orders and contracts. Every member reads them; only owners
 * and admins create, import, amend, close, cancel or link them (see
 * docs/permissions.md).
 */
export const authorizationSourcesRouter = createTRPCRouter({
  list: workspaceProcedure
    .input(authorizationSourceListSchema)
    .query(async ({ ctx: { db, teamId }, input }) =>
      presentAuthorizationSourceList(
        await listAuthorizationSources(db, { ...input, teamId: teamId! }),
      ),
    ),

  get: workspaceProcedure
    .input(authorizationSourceIdSchema)
    .query(async ({ ctx: { db, teamId, teamRole }, input }) => {
      const source = await getAuthorizationSource(db, {
        teamId: teamId!,
        sourceId: input.id,
      });
      if (!source) throw notFound();
      return {
        ...presentAuthorizationSource(source),
        canManage: canManageAuthorizationSources(teamRole),
      };
    }),

  version: workspaceProcedure
    .input(authorizationSourceVersionSchema)
    .query(async ({ ctx: { db, teamId }, input }) => {
      const version = await getAuthorizationSourceVersion(db, {
        teamId: teamId!,
        sourceId: input.id,
        version: input.version,
      });
      if (!version) throw notFound();
      return presentAuthorizationVersion(version);
    }),

  /** The version in effect on a date (optionally as recorded at a time), or null. */
  effective: workspaceProcedure
    .input(authorizationSourceEffectiveSchema)
    .query(async ({ ctx: { db, teamId }, input }) => {
      const version = await getEffectiveAuthorizationSourceVersion(db, {
        teamId: teamId!,
        sourceId: input.id,
        on: input.on,
        asOf: input.asOf,
      });
      return version ? presentAuthorizationVersion(version) : null;
    }),

  imports: adminProcedure.query(({ ctx: { db, teamId } }) =>
    listAuthorizationSourceImports(db, { teamId: teamId! }),
  ),

  create: adminProcedure
    .input(createAuthorizationSourceSchema)
    .mutation(({ ctx: { db, teamId, session }, input }) =>
      writing(() =>
        createAuthorizationSource(db, {
          teamId: teamId!,
          actorId: session.user.id,
          source: input.source,
        }),
      ),
    ),

  amend: adminProcedure
    .input(amendAuthorizationSourceSchema)
    .mutation(({ ctx: { db, teamId, session }, input }) =>
      writing(() =>
        amendAuthorizationSource(db, {
          teamId: teamId!,
          actorId: session.user.id,
          sourceId: input.id,
          source: input.source,
        }),
      ),
    ),

  setStatus: adminProcedure
    .input(setAuthorizationSourceStatusSchema)
    .mutation(({ ctx: { db, teamId, session }, input }) =>
      writing(() =>
        setAuthorizationSourceStatus(db, {
          teamId: teamId!,
          actorId: session.user.id,
          sourceId: input.id,
          status: input.status,
          reason: input.reason,
          effectiveFrom: input.effectiveFrom,
        }),
      ),
    ),

  linkSupplier: adminProcedure
    .input(linkAuthorizationSourceSupplierSchema)
    .mutation(({ ctx: { db, teamId, session }, input }) =>
      writing(() =>
        linkAuthorizationSourceSupplier(db, {
          teamId: teamId!,
          actorId: session.user.id,
          sourceId: input.id,
          supplierId: input.supplierId,
        }),
      ),
    ),

  /** Validates (`dryRun`) or applies a CSV import; a rejected file changes nothing. */
  import: adminProcedure
    .input(importAuthorizationSourcesSchema)
    .mutation(({ ctx: { db, teamId, session }, input }) =>
      writing(() =>
        importAuthorizationSourcesCsv(db, {
          teamId: teamId!,
          actorId: session.user.id,
          csv: input.csv,
          fileName: input.fileName,
          dryRun: input.dryRun,
        }),
      ),
    ),
});
