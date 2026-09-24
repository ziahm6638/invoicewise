import type { Session } from "@api/utils/auth";
import type { Database } from "@invoicewise/db/client";
import { primaryDb } from "@invoicewise/db/client";
import { type TeamRole, getTeamRole } from "@invoicewise/db/queries";
import { TRPCError } from "@trpc/server";

/**
 * Resolves the caller's role for their active workspace on every request.
 *
 * This deliberately reads the primary database instead of a cache: membership
 * and role changes (removal, demotion) must take effect on the next request
 * without relying on cache invalidation across instances.
 */
export const withTeamPermission = async <TReturn>(opts: {
  ctx: {
    session?: Session | null;
    db: Database;
  };
  next: (opts: {
    ctx: {
      session?: Session | null;
      db: Database;
      teamId: string | null;
      teamRole: TeamRole | null;
    };
  }) => Promise<TReturn>;
}) => {
  const { ctx, next } = opts;

  const userId = ctx.session?.user?.id;

  if (!userId) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "No permission to access this team",
    });
  }

  const teamId = ctx.session?.teamId ?? null;
  let teamRole: TeamRole | null = null;

  // If teamId is null, user has no team assigned but this is now allowed
  if (teamId !== null) {
    teamRole = await getTeamRole(primaryDb, teamId, userId);

    if (!teamRole) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "No permission to access this team",
      });
    }
  }

  return next({
    ctx: {
      session: ctx.session,
      teamId,
      teamRole,
      db: ctx.db,
    },
  });
};
