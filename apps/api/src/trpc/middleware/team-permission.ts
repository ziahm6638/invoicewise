import { resolveActiveWorkspace } from "@api/utils/active-workspace";
import type { Session } from "@api/utils/auth";
import type { Database } from "@invoicewise/db/client";
import type { TeamRole } from "@invoicewise/db/queries";
import { TRPCError } from "@trpc/server";

/**
 * Resolves the caller's role for their active workspace on every request.
 *
 * This deliberately reads the primary database instead of a cache: membership
 * and role changes (removal, demotion) must take effect on the next request
 * without relying on cache invalidation across instances. A stale pointer is
 * recovered rather than failing the request; see `resolveActiveWorkspace`.
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

  if (!ctx.session || !userId) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "No permission to access this team",
    });
  }

  // If teamId is null, user has no team assigned but this is now allowed
  const { teamId, teamRole } = await resolveActiveWorkspace(
    userId,
    ctx.session.teamId ?? null,
  );

  return next({
    ctx: {
      session: { ...ctx.session, teamId },
      teamId,
      teamRole,
      db: ctx.db,
    },
  });
};
