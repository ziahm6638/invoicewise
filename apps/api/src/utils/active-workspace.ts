import { primaryDb } from "@invoicewise/db/client";
import {
  type TeamRole,
  getTeamRole,
  recoverActiveWorkspace,
} from "@invoicewise/db/queries";

/**
 * Resolves a signed-in session's active workspace and role from the primary
 * database, so membership changes take effect on the next request.
 *
 * A pointer naming a workspace the user no longer belongs to is recovered in
 * place instead of failing the request: the session moves to another workspace
 * the user belongs to, or to none (the dashboard then shows the workspace
 * chooser/creation screen). The stale workspace is never returned. API keys and
 * OAuth tokens are bound to the workspace they were issued for and must not use
 * this.
 */
export async function resolveActiveWorkspace(
  userId: string,
  teamId: string | null,
): Promise<{ teamId: string | null; teamRole: TeamRole | null }> {
  if (!teamId) {
    return { teamId: null, teamRole: null };
  }

  const teamRole = await getTeamRole(primaryDb, teamId, userId);

  if (teamRole) {
    return { teamId, teamRole };
  }

  const recovered = await recoverActiveWorkspace(primaryDb, {
    userId,
    staleTeamId: teamId,
  });

  return {
    teamId: recovered?.teamId ?? null,
    teamRole: recovered?.role ?? null,
  };
}
