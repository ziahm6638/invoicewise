import type { Database, PrimaryDatabase } from "@db/client";
import { teams, usersOnTeam } from "@db/schema";
import {
  type ResourceScope,
  SCOPE_ALIASES,
  expandScopes,
  isResourceScope,
} from "@db/utils/scopes";
import { and, eq } from "drizzle-orm";

/**
 * Workspace roles, highest privilege first. Anything that is not listed here
 * (missing, null, or an unknown string from a stale client) resolves to no
 * access rather than to a default role.
 */
export const TEAM_ROLES = ["owner", "admin", "member"] as const;

export type TeamRole = (typeof TEAM_ROLES)[number];

const ROLE_RANK: Record<TeamRole, number> = {
  owner: 2,
  admin: 1,
  member: 0,
};

export const isTeamRole = (value: unknown): value is TeamRole =>
  typeof value === "string" &&
  (TEAM_ROLES as readonly string[]).includes(value);

export const normalizeTeamRole = (value: unknown): TeamRole | null =>
  isTeamRole(value) ? value : null;

const roleRank = (role: TeamRole | null | undefined): number =>
  role !== null && role !== undefined && isTeamRole(role)
    ? ROLE_RANK[role]
    : -1;

export const roleAtLeast = (
  role: TeamRole | null | undefined,
  minimum: TeamRole,
): boolean => roleRank(role) >= ROLE_RANK[minimum];

/** Owner and admin manage ordinary members, invitations, questions and integrations. */
export const canManageMembers = (role: TeamRole | null | undefined) =>
  roleAtLeast(role, "admin");

export const canManageQuestions = (role: TeamRole | null | undefined) =>
  roleAtLeast(role, "admin");

export const canManageIntegrations = (role: TeamRole | null | undefined) =>
  roleAtLeast(role, "admin");

/** Workspace name/logo/currency and API keys are team configuration. */
export const canManageWorkspaceSettings = (role: TeamRole | null | undefined) =>
  roleAtLeast(role, "admin");

/** Ownership transfer, workspace deletion and billing stay with the owner. */
export const canManageBilling = (role: TeamRole | null | undefined) =>
  roleAtLeast(role, "owner");

export const canDeleteWorkspace = (role: TeamRole | null | undefined) =>
  roleAtLeast(role, "owner");

export const canTransferOwnership = (role: TeamRole | null | undefined) =>
  roleAtLeast(role, "owner");

/**
 * The capability set the dashboard renders from. This is the server's decision
 * surfaced to the UI; it is never the enforcement point.
 */
export const getTeamCapabilities = (role: TeamRole | null | undefined) => ({
  manageMembers: canManageMembers(role),
  manageQuestions: canManageQuestions(role),
  manageIntegrations: canManageIntegrations(role),
  manageWorkspaceSettings: canManageWorkspaceSettings(role),
  manageBilling: canManageBilling(role),
  deleteWorkspace: canDeleteWorkspace(role),
  transferOwnership: canTransferOwnership(role),
});

/**
 * An admin may never create another owner (or promote themselves); only an
 * owner may grant the owner role.
 */
export const canAssignRole = (
  actorRole: TeamRole | null | undefined,
  targetRole: TeamRole | null | undefined,
): boolean => {
  const actor = normalizeTeamRole(actorRole);
  const target = normalizeTeamRole(targetRole);

  if (!actor || !target) {
    return false;
  }

  if (actor === "owner") {
    return true;
  }

  if (actor === "admin") {
    return target !== "owner";
  }

  return false;
};

/**
 * Whether the actor may remove or change the role of `targetUserId`.
 * The last remaining owner can never be demoted or removed, by anyone
 * including themselves, until ownership is transferred.
 */
export const canManageMember = (params: {
  actorRole: TeamRole | null | undefined;
  actorUserId: string;
  targetRole: TeamRole | null | undefined;
  targetUserId: string;
  ownerCount: number;
}): boolean => {
  const { actorRole, actorUserId, targetRole, targetUserId, ownerCount } =
    params;

  if (!canManageMembers(actorRole)) {
    return false;
  }

  const target = normalizeTeamRole(targetRole);

  if (!target) {
    return false;
  }

  if (target === "owner") {
    if (!canTransferOwnership(actorRole)) {
      return false;
    }

    // Demoting or removing an owner is only blocked when it would leave the
    // workspace without one. Any owner may act on any owner otherwise.
    return ownerCount > 1;
  }

  // Admins cannot act on each other's ownership, but can manage admins/members.
  if (target === "admin" && actorRole === "admin") {
    return true;
  }

  if (targetUserId === actorUserId && actorRole === "admin") {
    // An admin may step down to member.
    return true;
  }

  return true;
};

export const isReadScope = (scope: string) => scope.endsWith(".read");

/**
 * Scopes a member may hold on a credential. Members use invoice features and
 * read their workspace, but never manage the workspace or its integrations;
 * those surfaces are additionally gated by role on the route itself.
 */
export const MEMBER_SCOPES: readonly ResourceScope[] = [
  "inbox.read",
  "inbox.write",
  "teams.read",
  "users.read",
];

export type TeamPermissionErrorCode = "FORBIDDEN" | "CONFLICT" | "NOT_FOUND";

/**
 * Raised by the DB-backed membership mutations so callers can map invariant
 * violations onto their own transport errors without re-implementing the check.
 */
export class TeamPermissionError extends Error {
  readonly code: TeamPermissionErrorCode;

  constructor(code: TeamPermissionErrorCode, message: string) {
    super(message);
    this.name = "TeamPermissionError";
    this.code = code;
  }
}

/**
 * Scopes granted to a key or token may never exceed the issuing actor's role.
 *
 * Aliases (`apis.all`, `apis.read`) are expanded first, then the result is
 * intersected with the role's allowance and filtered against the authoritative
 * scope list. Unknown scopes and unknown roles therefore resolve to nothing.
 */
export const clampScopesForRole = (
  role: TeamRole | null | undefined,
  scopes: readonly string[],
): ResourceScope[] => {
  if (!normalizeTeamRole(role)) {
    return [];
  }

  const expanded = expandScopes(scopes);

  if (canManageIntegrations(role)) {
    return expanded;
  }

  return expanded.filter(
    (scope) =>
      isResourceScope(scope) &&
      (MEMBER_SCOPES as readonly string[]).includes(scope),
  );
};

/**
 * Whether the actor's role may hold *every* scope the request expands to.
 *
 * Comparison is set-based, not count-based: aliases expand, duplicates and
 * overlaps collapse, and a request containing any scope the role cannot hold —
 * or any unknown scope — is refused rather than silently downgraded.
 */
export const scopesWithinRole = (
  role: TeamRole | null | undefined,
  scopes: readonly string[],
): boolean => {
  if (
    !scopes.every(
      (scope) =>
        isResourceScope(scope) ||
        (SCOPE_ALIASES as readonly string[]).includes(scope),
    )
  ) {
    return false;
  }

  const granted = new Set<string>(clampScopesForRole(role, scopes));

  return expandScopes(scopes).every((scope) => granted.has(scope));
};

/** Fresh primary-read of the actor's role for a workspace. */
export async function getTeamRole(
  db: Database | PrimaryDatabase,
  teamId: string,
  userId: string,
): Promise<TeamRole | null> {
  const [row] = await db
    .select({ role: usersOnTeam.role })
    .from(usersOnTeam)
    .where(and(eq(usersOnTeam.teamId, teamId), eq(usersOnTeam.userId, userId)))
    .limit(1);

  return normalizeTeamRole(row?.role);
}

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Serializes membership mutations for a workspace on the team row so the
 * last-owner check and the write happen in one transaction.
 */
export async function lockTeamRow(tx: Transaction, teamId: string) {
  const [row] = await tx
    .select({ id: teams.id })
    .from(teams)
    .where(eq(teams.id, teamId))
    .for("update")
    .limit(1);

  return row ?? null;
}

export async function countTeamOwners(tx: Transaction, teamId: string) {
  const rows = await tx
    .select({ id: usersOnTeam.id })
    .from(usersOnTeam)
    .where(and(eq(usersOnTeam.teamId, teamId), eq(usersOnTeam.role, "owner")));

  return rows.length;
}

export async function getTeamMemberRow(
  tx: Transaction,
  teamId: string,
  userId: string,
) {
  const [row] = await tx
    .select({
      id: usersOnTeam.id,
      role: usersOnTeam.role,
      teamId: usersOnTeam.teamId,
      userId: usersOnTeam.userId,
    })
    .from(usersOnTeam)
    .where(and(eq(usersOnTeam.teamId, teamId), eq(usersOnTeam.userId, userId)))
    .limit(1);

  return row ?? null;
}
