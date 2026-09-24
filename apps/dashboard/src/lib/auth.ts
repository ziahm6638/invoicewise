import "server-only";

import { type Session, getAuthSession } from "@invoicewise/api/auth";
import { primaryDb } from "@invoicewise/db/client";
import { type TeamRole, getTeamRole } from "@invoicewise/db/queries";
import { headers } from "next/headers";

export type DashboardSession = Session & { teamRole: TeamRole | null };

export async function getSession(): Promise<DashboardSession | null> {
  const session = await getAuthSession(await headers());

  if (!session) {
    return null;
  }

  if (!session.teamId) {
    return { ...session, teamRole: null };
  }

  // Server routes on the dashboard (storage upload/download, proxy, billing,
  // portal) scope by `teamId` and role. Re-read both from the primary database
  // so a removed or demoted user cannot keep using a stale session.
  const role = await getTeamRole(primaryDb, session.teamId, session.user.id);

  return {
    ...session,
    teamId: role ? session.teamId : null,
    teamRole: role,
  };
}
