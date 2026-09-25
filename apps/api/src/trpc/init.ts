import { getAuthSession } from "@api/utils/auth";
import type { Session } from "@api/utils/auth";
import { getGeoContext } from "@api/utils/geo";
import type { Database } from "@invoicewise/db/client";
import { db } from "@invoicewise/db/client";
import { type TeamRole, roleAtLeast } from "@invoicewise/db/queries";
import { TRPCError, initTRPC } from "@trpc/server";
import type { Context } from "hono";
import superjson from "superjson";
import { withAuditTrail } from "./audit";
import { withPrimaryReadAfterWrite } from "./middleware/primary-read-after-write";
import { withTeamPermission } from "./middleware/team-permission";

type TRPCContext = {
  session: Session | null;
  db: Database;
  geo: ReturnType<typeof getGeoContext>;
  requestHeaders: Headers;
  teamId?: string;
  teamRole?: TeamRole | null;
};

export const createTRPCContext = async (
  _: unknown,
  c: Context,
): Promise<TRPCContext> => {
  const requestHeaders = c.req.raw.headers;
  const session = await getAuthSession(requestHeaders);

  // Use the singleton database instance - no need for caching
  const geo = getGeoContext(c.req);

  return {
    session,
    db,
    geo,
    requestHeaders,
  };
};

const t = initTRPC.context<TRPCContext>().create({
  transformer: superjson,
});

export const createTRPCRouter = t.router;
export const createCallerFactory = t.createCallerFactory;

const withPrimaryDbMiddleware = t.middleware(async (opts) => {
  return withPrimaryReadAfterWrite({
    ctx: opts.ctx,
    type: opts.type,
    next: opts.next,
  });
});

const withTeamPermissionMiddleware = t.middleware(async (opts) => {
  return withTeamPermission({
    ctx: opts.ctx,
    next: opts.next,
  });
});

export const publicProcedure = t.procedure.use(withPrimaryDbMiddleware);

export const protectedProcedure = t.procedure
  .use(withTeamPermissionMiddleware) // NOTE: This is needed to ensure that the teamId is set in the context
  .use(withPrimaryDbMiddleware)
  .use(async (opts) => {
    const { teamId, teamRole, session } = opts.ctx;

    if (!session) {
      throw new TRPCError({ code: "UNAUTHORIZED" });
    }

    return opts.next({
      ctx: {
        teamId,
        teamRole,
        session,
      },
    });
  })
  // Before the role gates below, so a refused attempt is recorded too.
  .use(async (opts) =>
    withAuditTrail({
      path: opts.path,
      type: opts.type,
      db: opts.ctx.db,
      teamId: opts.ctx.teamId ?? null,
      userId: opts.ctx.session.user.id,
      getRawInput: opts.getRawInput,
      next: opts.next,
    }),
  );

/**
 * Requires the caller to hold at least `minimum` in their active workspace.
 * Unknown or missing roles fail closed because `roleAtLeast` ranks them below
 * `member`.
 */
const withMinimumTeamRole = (minimum: TeamRole) =>
  t.middleware(async (opts) => {
    const { teamId, teamRole, session } = opts.ctx;

    if (!session) {
      throw new TRPCError({ code: "UNAUTHORIZED" });
    }

    if (!teamId) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "No active workspace",
      });
    }

    if (!roleAtLeast(teamRole, minimum)) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: `Requires the ${minimum} role in this workspace`,
      });
    }

    return opts.next();
  });

export const adminProcedure = protectedProcedure.use(
  withMinimumTeamRole("admin"),
);

export const ownerProcedure = protectedProcedure.use(
  withMinimumTeamRole("owner"),
);

/**
 * For procedures that operate on the caller's active workspace. `teamId` is
 * non-null here, so a removed member whose session no longer resolves to a
 * workspace is denied instead of falling through to a workspace-less handler.
 */
export const workspaceProcedure = protectedProcedure.use(async (opts) => {
  if (!opts.ctx.teamId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "No active workspace",
    });
  }

  return opts.next();
});
