import type { TeamRole } from "@invoicewise/db/queries";
import { roleAtLeast } from "@invoicewise/db/queries";
import type { MiddlewareHandler } from "hono";

/**
 * Requires the authenticated caller to hold at least `minimum` in their active
 * workspace. The role is resolved from the primary database by `withAuth`.
 */
export const withRequiredTeamRole = (minimum: TeamRole): MiddlewareHandler => {
  return async (c, next) => {
    const role = c.get("teamRole");

    if (!roleAtLeast(role, minimum)) {
      return c.json(
        {
          error: "Forbidden",
          description: `Requires the ${minimum} role in this workspace.`,
        },
        403,
      );
    }

    await next();
  };
};

/**
 * Requires an active workspace. Workspace resources cannot be read or written
 * by a session that has not selected one.
 */
export const withRequiredTeam: MiddlewareHandler = async (c, next) => {
  if (!c.get("teamId")) {
    return c.json(
      {
        error: "Forbidden",
        description: "Select a workspace to access this resource.",
      },
      403,
    );
  }

  await next();
};
