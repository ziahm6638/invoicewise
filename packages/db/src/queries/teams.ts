import type { Database, PrimaryDatabase } from "@db/client";
import {
  apiKeys,
  authSessions,
  bankConnections,
  oauthAccessTokens,
  teams,
  transactionCategories,
  users,
  usersOnTeam,
} from "@db/schema";
import {
  CATEGORIES,
  getTaxRateForCategory,
  getTaxTypeForCountry,
} from "@invoicewise/categories";
import { and, eq, ne } from "drizzle-orm";
import {
  recordDeletionRequest,
  snapshotWorkspaceConnections,
  workspaceDeletionConfirmation,
  workspaceQuiesceUntil,
} from "./deletion-requests";
import {
  TeamPermissionError,
  type TeamRole,
  canAssignRole,
  canDeleteWorkspace,
  canManageMember,
  canTransferOwnership,
  countTeamOwners,
  getTeamMemberRow,
  isPostgresError,
  isTeamRole,
  lockTeamRow,
} from "./team-permissions";
import { revokeInvitesSentBy } from "./user-invites";

export const getTeamById = async (
  db: Database | PrimaryDatabase,
  id: string,
) => {
  const [result] = await db
    .select({
      id: teams.id,
      name: teams.name,
      logoUrl: teams.logoUrl,
      email: teams.email,
      inboxId: teams.inboxId,
      plan: teams.plan,
      // subscriptionStatus: teams.subscriptionStatus,
      baseCurrency: teams.baseCurrency,
      countryCode: teams.countryCode,
      exportSettings: teams.exportSettings,
    })
    .from(teams)
    .where(eq(teams.id, id));

  return result;
};

type UpdateTeamParams = {
  id: string;
  data: Partial<typeof teams.$inferInsert>;
};

export const updateTeamById = async (
  db: Database,
  params: UpdateTeamParams,
) => {
  const { id, data } = params;

  const [result] = await db
    .update(teams)
    .set(data)
    .where(eq(teams.id, id))
    .returning({
      id: teams.id,
      name: teams.name,
      logoUrl: teams.logoUrl,
      email: teams.email,
      inboxId: teams.inboxId,
      plan: teams.plan,
      // subscriptionStatus: teams.subscriptionStatus,
      baseCurrency: teams.baseCurrency,
      countryCode: teams.countryCode,
    });

  return result;
};

type CreateTeamParams = {
  name: string;
  userId: string;
  email: string;
  baseCurrency?: string;
  countryCode?: string;
  logoUrl?: string;
  switchTeam?: boolean;
};

type ProvisioningTransaction = Parameters<
  Parameters<Database["transaction"]>[0]
>[0];

/**
 * Inserts the workspace, its owning membership and its system categories, and
 * optionally points the user at it.
 *
 * Callers must already hold the user row lock: that is the accepted #32 lock
 * order (user row, then any membership snapshot), which lets account deletion,
 * signup provisioning and invitation acceptance serialize instead of creating
 * a workspace around a user who is being deleted — or a second workspace for a
 * user who already has one.
 */
async function provisionWorkspace(
  tx: ProvisioningTransaction,
  params: CreateTeamParams,
  teamCreationId: string,
) {
  console.log(`[${teamCreationId}] Creating team record`);
  const [newTeam] = await tx
    .insert(teams)
    .values({
      name: params.name,
      baseCurrency: params.baseCurrency,
      countryCode: params.countryCode,
      logoUrl: params.logoUrl,
      email: params.email,
    })
    .returning({ id: teams.id });

  if (!newTeam?.id) {
    throw new Error("Failed to create team.");
  }

  console.log(
    `[${teamCreationId}] Team created successfully with ID: ${newTeam.id}`,
  );

  console.log(`[${teamCreationId}] Adding user to team membership`);
  await tx.insert(usersOnTeam).values({
    userId: params.userId,
    teamId: newTeam.id,
    role: "owner",
  });

  // Create system categories for the new team (atomic)
  console.log(`[${teamCreationId}] Creating system categories`);
  await createSystemCategoriesForTeam(tx, newTeam.id, params.countryCode);

  if (params.switchTeam) {
    console.log(`[${teamCreationId}] Switching user to new team`);
    await tx
      .update(users)
      .set({ teamId: newTeam.id })
      .where(eq(users.id, params.userId));
  }

  return newTeam.id;
}

/**
 * Serializes workspace provisioning on the user row. Deletion takes the same
 * lock first, so a provisioning retry either commits before the deletion or
 * fails against the missing user instead of leaving an orphaned workspace.
 */
async function lockUserRow(tx: ProvisioningTransaction, userId: string) {
  const [user] = await tx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId))
    .for("update")
    .limit(1);

  if (!user) {
    throw new TeamPermissionError("NOT_FOUND", "User not found");
  }
}

// Helper function to create system categories for a new team
async function createSystemCategoriesForTeam(
  db: ProvisioningTransaction,
  teamId: string,
  countryCode: string | null | undefined,
) {
  // Since teams have no previous categories on creation, we can insert all categories directly
  const categoriesToInsert: Array<typeof transactionCategories.$inferInsert> =
    [];

  // First, add all parent categories
  for (const parent of CATEGORIES) {
    const taxRate = getTaxRateForCategory(countryCode, parent.slug);
    const taxType = getTaxTypeForCountry(countryCode);

    categoriesToInsert.push({
      teamId,
      name: parent.name,
      slug: parent.slug,
      color: parent.color,
      system: parent.system,
      excluded: parent.excluded,
      taxRate: taxRate > 0 ? taxRate : null,
      taxType: taxRate > 0 ? taxType : null,
      taxReportingCode: undefined,
      description: undefined,
      parentId: undefined, // Parent categories have no parent
    });
  }

  // Insert all parent categories first
  const insertedParents = await db
    .insert(transactionCategories)
    .values(categoriesToInsert)
    .returning({
      id: transactionCategories.id,
      slug: transactionCategories.slug,
    });

  // Create a map of parent slug to parent ID for child category references
  const parentSlugToId = new Map(
    insertedParents.map((parent) => [parent.slug, parent.id]),
  );

  // Now add all child categories with proper parent references
  const childCategoriesToInsert: Array<
    typeof transactionCategories.$inferInsert
  > = [];

  for (const parent of CATEGORIES) {
    const parentId = parentSlugToId.get(parent.slug);
    if (parentId) {
      for (const child of parent.children) {
        const taxRate = getTaxRateForCategory(countryCode, child.slug);
        const taxType = getTaxTypeForCountry(countryCode);

        childCategoriesToInsert.push({
          teamId,
          name: child.name,
          slug: child.slug,
          color: child.color,
          system: child.system,
          excluded: child.excluded,
          taxRate: taxRate > 0 ? taxRate : null,
          taxType: taxRate > 0 ? taxType : null,
          taxReportingCode: undefined,
          description: undefined,
          parentId: parentId,
        });
      }
    }
  }

  // Insert all child categories
  if (childCategoriesToInsert.length > 0) {
    await db.insert(transactionCategories).values(childCategoriesToInsert);
  }
}

export const createTeam = async (db: Database, params: CreateTeamParams) => {
  const startTime = Date.now();
  const teamCreationId = `team_creation_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  console.log(
    `[${teamCreationId}] Starting team creation for user ${params.userId}`,
    {
      teamName: params.name,
      baseCurrency: params.baseCurrency,
      countryCode: params.countryCode,
      email: params.email,
      switchTeam: params.switchTeam,
      timestamp: new Date().toISOString(),
    },
  );

  // Use transaction to ensure atomicity and prevent race conditions
  return await db.transaction(async (tx) => {
    try {
      // Hold the user row before any membership read or write. Account
      // deletion takes the same lock first, so a deletion that wins the race
      // rolls this transaction back instead of orphaning a workspace.
      await lockUserRow(tx, params.userId);

      // Check if user already has teams to prevent duplicate creation
      const existingTeams = await tx
        .select({ id: teams.id, name: teams.name })
        .from(usersOnTeam)
        .innerJoin(teams, eq(teams.id, usersOnTeam.teamId))
        .where(eq(usersOnTeam.userId, params.userId));

      console.log(
        `[${teamCreationId}] User existing teams count: ${existingTeams.length}`,
        {
          existingTeams: existingTeams.map((t) => ({ id: t.id, name: t.name })),
        },
      );

      // A workspace may be created deliberately even when the user already
      // belongs to others; signup provisioning uses ensurePersonalWorkspace.
      const teamId = await provisionWorkspace(tx, params, teamCreationId);

      const duration = Date.now() - startTime;
      console.log(
        `[${teamCreationId}] Team creation completed successfully in ${duration}ms`,
        {
          teamId,
          duration,
        },
      );

      return teamId;
    } catch (error) {
      const duration = Date.now() - startTime;
      console.error(
        `[${teamCreationId}] Team creation failed after ${duration}ms:`,
        {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          params: {
            userId: params.userId,
            teamName: params.name,
            baseCurrency: params.baseCurrency,
            countryCode: params.countryCode,
          },
          duration,
        },
      );

      // Re-throw with more specific error messages
      if (error instanceof Error) {
        throw error;
      }

      throw new Error("Failed to create team due to an unexpected error.");
    }
  });
};

type EnsurePersonalWorkspaceParams = {
  userId: string;
  email: string;
  name: string;
};

/**
 * Idempotent signup provisioning.
 *
 * Better Auth commits the user row before the `user.create.after` hook runs, so
 * a failed workspace insert leaves a verified account with no workspace. This
 * is the repair path: retrying is safe, concurrent retries settle on one
 * workspace, and the user row lock is held before the membership snapshot in
 * the accepted #32 order so account deletion cannot race it into an orphan.
 */
export async function ensurePersonalWorkspace(
  db: Database,
  params: EnsurePersonalWorkspaceParams,
) {
  return await db.transaction(async (tx) => {
    await lockUserRow(tx, params.userId);

    const memberships = await tx
      .select({ teamId: usersOnTeam.teamId })
      .from(usersOnTeam)
      .where(eq(usersOnTeam.userId, params.userId))
      .orderBy(usersOnTeam.createdAt);

    const [existing] = memberships;

    if (existing) {
      const [user] = await tx
        .select({ teamId: users.teamId })
        .from(users)
        .where(eq(users.id, params.userId))
        .limit(1);

      // Repair a membership that exists while the active workspace pointer was
      // lost to a partially applied earlier attempt.
      if (!user?.teamId) {
        await tx
          .update(users)
          .set({ teamId: existing.teamId })
          .where(eq(users.id, params.userId));
      }

      return { teamId: existing.teamId, created: false as const };
    }

    const teamId = await provisionWorkspace(
      tx,
      {
        name: params.name,
        userId: params.userId,
        email: params.email,
        switchTeam: true,
      },
      `personal_workspace_${params.userId}`,
    );

    return { teamId, created: true as const };
  });
}

export async function getTeamMembers(db: Database, teamId: string) {
  const result = await db
    .select({
      id: usersOnTeam.id,
      role: usersOnTeam.role,
      team_id: usersOnTeam.teamId,
      user: {
        id: users.id,
        fullName: users.fullName,
        avatarUrl: users.avatarUrl,
        email: users.email,
      },
    })
    .from(usersOnTeam)
    .innerJoin(users, eq(usersOnTeam.userId, users.id))
    .where(eq(usersOnTeam.teamId, teamId))
    .orderBy(usersOnTeam.createdAt);

  return result.map((item) => ({
    id: item.user.id,
    role: item.role,
    fullName: item.user.fullName,
    avatarUrl: item.user.avatarUrl,
    email: item.user.email,
  }));
}

type LeaveTeamParams = {
  userId: string;
  teamId: string;
};

/** Selects and locks the user row; null when the account no longer exists. */
async function lockUserPointer(tx: ProvisioningTransaction, userId: string) {
  const [user] = await tx
    .select({ teamId: users.teamId })
    .from(users)
    .where(eq(users.id, userId))
    .for("update")
    .limit(1);

  return user ?? null;
}

/**
 * Moves a user's active-workspace pointers off a workspace they no longer
 * belong to.
 *
 * The stored pointer (`users.team_id`) and every session pointed at the stale
 * workspace land on the workspace the user last chose if they are still a
 * member of it, otherwise their earliest remaining membership. With no
 * membership left both are cleared, which sends the dashboard to the workspace
 * chooser and on to workspace creation. Takes the user row lock, so callers
 * that also lock a team row must take that lock first.
 *
 * Returns the workspace and role the user now points at, or null.
 */
async function repointActiveWorkspace(
  tx: ProvisioningTransaction,
  userId: string,
  staleTeamId: string,
): Promise<{ teamId: string; role: TeamRole } | null> {
  const user = await lockUserPointer(tx, userId);

  if (!user) {
    return null;
  }

  const memberships = await tx
    .select({ teamId: usersOnTeam.teamId, role: usersOnTeam.role })
    .from(usersOnTeam)
    .where(
      and(eq(usersOnTeam.userId, userId), ne(usersOnTeam.teamId, staleTeamId)),
    )
    .orderBy(usersOnTeam.createdAt);

  const eligible = memberships.flatMap((membership) =>
    isTeamRole(membership.role)
      ? [{ teamId: membership.teamId, role: membership.role }]
      : [],
  );
  const target =
    eligible.find((membership) => membership.teamId === user.teamId) ??
    eligible[0] ??
    null;
  const targetTeamId = target?.teamId ?? null;

  if (user.teamId !== targetTeamId) {
    await tx
      .update(users)
      .set({ teamId: targetTeamId })
      .where(eq(users.id, userId));
  }

  await tx
    .update(authSessions)
    .set({ activeOrganizationId: targetTeamId })
    .where(
      and(
        eq(authSessions.userId, userId),
        eq(authSessions.activeOrganizationId, staleTeamId),
      ),
    );

  return target;
}

type RecoverActiveWorkspaceParams = {
  userId: string;
  staleTeamId: string;
};

/**
 * Recovers a session whose active-workspace pointer names a workspace the user
 * no longer belongs to (removed, left or deleted while the pointer survived).
 *
 * Membership is re-read under the user row lock: if the user was re-added in
 * the meantime the pointer stands, otherwise the pointers are repaired by
 * `repointActiveWorkspace`. The stale workspace is only ever returned when
 * membership was re-established, so recovery reads no data from it.
 *
 * Returns the workspace and role the request should continue with, or null
 * when the user has no workspace left.
 */
export async function recoverActiveWorkspace(
  db: Database | PrimaryDatabase,
  params: RecoverActiveWorkspaceParams,
): Promise<{ teamId: string; role: TeamRole } | null> {
  return db.transaction(async (tx) => {
    if (!(await lockUserPointer(tx, params.userId))) {
      return null;
    }

    const current = await getTeamMemberRow(
      tx,
      params.staleTeamId,
      params.userId,
    );

    if (current && isTeamRole(current.role)) {
      return { teamId: params.staleTeamId, role: current.role };
    }

    return repointActiveWorkspace(tx, params.userId, params.staleTeamId);
  });
}

/**
 * Revokes everything that could still act on behalf of a user in a workspace
 * once their membership ends: active team pointer, sessions pointed at the
 * workspace, API keys, OAuth tokens and the pending invitations they sent. The
 * pointers move to another workspace the user still belongs to, when there is
 * one.
 */
async function revokeMembershipAccess(
  tx: ProvisioningTransaction,
  teamId: string,
  userId: string,
) {
  await repointActiveWorkspace(tx, userId, teamId);

  await tx
    .delete(apiKeys)
    .where(and(eq(apiKeys.teamId, teamId), eq(apiKeys.userId, userId)));

  await tx
    .update(oauthAccessTokens)
    .set({ revoked: true, revokedAt: new Date().toISOString() })
    .where(
      and(
        eq(oauthAccessTokens.teamId, teamId),
        eq(oauthAccessTokens.userId, userId),
        eq(oauthAccessTokens.revoked, false),
      ),
    );

  await revokeInvitesSentBy(tx, {
    teamId,
    inviterUserId: userId,
    remainingRole: null,
  });
}

export async function leaveTeam(db: Database, params: LeaveTeamParams) {
  return db.transaction(async (tx) => {
    if (!(await lockTeamRow(tx, params.teamId))) {
      throw new TeamPermissionError("NOT_FOUND", "Team not found");
    }

    const member = await getTeamMemberRow(tx, params.teamId, params.userId);

    if (!member) {
      throw new TeamPermissionError(
        "FORBIDDEN",
        "User is not a member of this team",
      );
    }

    if (
      member.role === "owner" &&
      (await countTeamOwners(tx, params.teamId)) <= 1
    ) {
      throw new TeamPermissionError(
        "CONFLICT",
        "The last owner cannot leave until ownership is transferred",
      );
    }

    const [deleted] = await tx
      .delete(usersOnTeam)
      .where(
        and(
          eq(usersOnTeam.teamId, params.teamId),
          eq(usersOnTeam.userId, params.userId),
        ),
      )
      .returning();

    await revokeMembershipAccess(tx, params.teamId, params.userId);

    return deleted;
  });
}

/**
 * Removes a workspace whose team row the caller already holds `FOR UPDATE`,
 * after it has checked who may delete it. Shared by workspace deletion and by
 * account deletion of a sole owner's unshared workspace, so both leave the
 * same state behind and record the same resumable cleanup.
 */
export async function deleteLockedWorkspace(
  tx: ProvisioningTransaction,
  params: { teamId: string; requestedBy: string },
) {
  // Everyone whose stored or session pointer could name the workspace,
  // collected before the membership rows cascade away.
  const members = await tx
    .select({ userId: usersOnTeam.userId })
    .from(usersOnTeam)
    .where(eq(usersOnTeam.teamId, params.teamId));
  const pointedUsers = await tx
    .select({ userId: users.id })
    .from(users)
    .where(eq(users.teamId, params.teamId));
  const pointedSessions = await tx
    .select({ userId: authSessions.userId })
    .from(authSessions)
    .where(eq(authSessions.activeOrganizationId, params.teamId));

  // Repoint before deleting: the session pointer's foreign key is
  // `ON DELETE SET NULL`, so once the team row is gone the sessions no
  // longer name it and would be left with no active workspace while
  // `users.team_id` still names one. Repointing already excludes this
  // workspace, so its membership rows (which cascade with the team) are
  // never chosen. User rows are locked in id order so concurrent deletions
  // cannot deadlock on them.
  const affectedUserIds = [
    ...new Set(
      [...members, ...pointedUsers, ...pointedSessions].map(
        (row) => row.userId,
      ),
    ),
  ].sort();

  for (const userId of affectedUserIds) {
    await repointActiveWorkspace(tx, userId, params.teamId);
  }

  const connections = await snapshotWorkspaceConnections(tx, params.teamId);
  const quiesceUntil = await workspaceQuiesceUntil(
    tx,
    params.teamId,
    new Date(),
  );

  await tx.delete(teams).where(eq(teams.id, params.teamId));

  const request = await recordDeletionRequest(tx, {
    subject: "workspace",
    subjectId: params.teamId,
    requestedBy: params.requestedBy,
    connections,
    quiesceUntil,
  });

  return request;
}

type DeleteTeamParams = {
  teamId: string;
  userId: string;
  /** The workspace name, typed by the owner (see `workspaceDeletionConfirmation`). */
  confirmName: string;
};

/**
 * Deletes a workspace. Owner-only, and only with the workspace named back.
 *
 * Everything that can act on the workspace goes in this one transaction: its
 * rows cascade with the team (memberships, invitations, API keys, OAuth
 * tokens, mailbox and accounting connection records, invoices and queued or
 * retrying jobs), and every member's active-workspace pointers are moved off
 * it. With the team row gone, a late write — a job that was already running,
 * a provider callback, incoming mail — fails on its foreign key instead of
 * recreating data.
 *
 * What lives outside the database (provider connections, private objects) is
 * captured in a durable deletion request whose cleanup is resumable; see
 * `docs/offboarding.md`.
 */
export async function deleteTeam(db: Database, params: DeleteTeamParams) {
  try {
    return await db.transaction(async (tx) => {
      const [team] = await tx
        .select({ id: teams.id, name: teams.name })
        .from(teams)
        .where(eq(teams.id, params.teamId))
        .for("update")
        .limit(1);

      if (!team) {
        throw new TeamPermissionError("NOT_FOUND", "Team not found");
      }

      const actor = await getTeamMemberRow(tx, params.teamId, params.userId);

      if (!canDeleteWorkspace(actor?.role)) {
        throw new TeamPermissionError(
          "FORBIDDEN",
          "Only the workspace owner can delete it",
        );
      }

      if (
        params.confirmName.trim() !== workspaceDeletionConfirmation(team.name)
      ) {
        throw new TeamPermissionError(
          "BAD_REQUEST",
          "Type the workspace name exactly to confirm deletion",
        );
      }

      const request = await deleteLockedWorkspace(tx, {
        teamId: params.teamId,
        requestedBy: params.userId,
      });

      return { id: team.id, deletionRequestId: request.id };
    });
  } catch (error) {
    // Deletion takes the team lock and then touches member user rows, while
    // account deletion takes them the other way round. Postgres breaks such a
    // deadlock by killing one side; report it as a retryable conflict.
    if (isPostgresError(error, "40P01")) {
      throw new TeamPermissionError(
        "CONFLICT",
        "Workspace deletion raced another workspace change. Retry the request",
      );
    }

    throw error;
  }
}

type DeleteTeamMemberParams = {
  actorUserId: string;
  userId: string;
  teamId: string;
};

export async function deleteTeamMember(
  db: Database,
  params: DeleteTeamMemberParams,
) {
  return db.transaction(async (tx) => {
    if (!(await lockTeamRow(tx, params.teamId))) {
      throw new TeamPermissionError("NOT_FOUND", "Team not found");
    }

    const actor = await getTeamMemberRow(tx, params.teamId, params.actorUserId);
    const target = await getTeamMemberRow(tx, params.teamId, params.userId);

    if (!target) {
      throw new TeamPermissionError("NOT_FOUND", "Member not found");
    }

    const ownerCount = await countTeamOwners(tx, params.teamId);

    if (target.role === "owner") {
      // Only an owner may remove an owner, and never the last one.
      if (!canTransferOwnership(actor?.role)) {
        throw new TeamPermissionError(
          "FORBIDDEN",
          "Only the workspace owner can remove an owner",
        );
      }

      if (ownerCount <= 1) {
        throw new TeamPermissionError(
          "CONFLICT",
          "The last owner cannot be removed until ownership is transferred",
        );
      }
    } else if (
      !canManageMember({
        actorRole: actor?.role,
        actorUserId: params.actorUserId,
        targetRole: target.role,
        targetUserId: params.userId,
        ownerCount,
      })
    ) {
      throw new TeamPermissionError(
        "FORBIDDEN",
        "Not allowed to remove this member",
      );
    }

    const [deleted] = await tx
      .delete(usersOnTeam)
      .where(
        and(
          eq(usersOnTeam.userId, params.userId),
          eq(usersOnTeam.teamId, params.teamId),
        ),
      )
      .returning();

    await revokeMembershipAccess(tx, params.teamId, params.userId);

    return deleted;
  });
}

type UpdateTeamMemberParams = {
  actorUserId: string;
  userId: string;
  teamId: string;
  role: TeamRole;
};

export async function updateTeamMember(
  db: Database,
  params: UpdateTeamMemberParams,
) {
  const { actorUserId, userId, teamId, role } = params;

  if (!isTeamRole(role)) {
    throw new TeamPermissionError("FORBIDDEN", "Unknown role");
  }

  return db.transaction(async (tx) => {
    if (!(await lockTeamRow(tx, teamId))) {
      throw new TeamPermissionError("NOT_FOUND", "Team not found");
    }

    const actor = await getTeamMemberRow(tx, teamId, actorUserId);
    const target = await getTeamMemberRow(tx, teamId, userId);

    if (!target) {
      throw new TeamPermissionError("NOT_FOUND", "Member not found");
    }

    if (!canAssignRole(actor?.role, role)) {
      throw new TeamPermissionError(
        "FORBIDDEN",
        "Not allowed to assign this role",
      );
    }

    const ownerCount = await countTeamOwners(tx, teamId);

    if (target.role === "owner" && role !== "owner") {
      // Taking ownership away: only an owner may do it, and never the last one.
      if (!canTransferOwnership(actor?.role)) {
        throw new TeamPermissionError(
          "FORBIDDEN",
          "Only the workspace owner can change an owner's role",
        );
      }

      if (ownerCount <= 1) {
        throw new TeamPermissionError(
          "CONFLICT",
          "The last owner cannot be demoted until ownership is transferred",
        );
      }
    } else if (
      !canManageMember({
        actorRole: actor?.role,
        actorUserId,
        targetRole: target.role,
        targetUserId: userId,
        ownerCount,
      })
    ) {
      throw new TeamPermissionError(
        "FORBIDDEN",
        "Not allowed to change this member's role",
      );
    }

    const [updated] = await tx
      .update(usersOnTeam)
      .set({ role })
      .where(
        and(eq(usersOnTeam.userId, userId), eq(usersOnTeam.teamId, teamId)),
      )
      .returning();

    // Losing admin/owner privileges must not leave a privileged API key or
    // OAuth grant behind. Demotion to member drops every write scope.
    if (role === "member") {
      await tx
        .delete(apiKeys)
        .where(and(eq(apiKeys.teamId, teamId), eq(apiKeys.userId, userId)));

      await tx
        .update(oauthAccessTokens)
        .set({ revoked: true, revokedAt: new Date().toISOString() })
        .where(
          and(
            eq(oauthAccessTokens.teamId, teamId),
            eq(oauthAccessTokens.userId, userId),
            eq(oauthAccessTokens.revoked, false),
          ),
        );
    }

    // Pending invites this member sent for a role they can no longer grant
    // are revoked with the demotion.
    await revokeInvitesSentBy(tx, {
      teamId,
      inviterUserId: userId,
      remainingRole: role,
    });

    return updated;
  });
}

type GetAvailablePlansResult = {
  starter: boolean;
  pro: boolean;
};

export async function getAvailablePlans(
  db: Database,
  teamId: string,
): Promise<GetAvailablePlansResult> {
  const [teamMembersCountResult, bankConnectionsCountResult] =
    await Promise.all([
      db.query.usersOnTeam.findMany({
        where: eq(usersOnTeam.teamId, teamId),
        columns: { id: true },
      }),
      db.query.bankConnections.findMany({
        where: eq(bankConnections.teamId, teamId),
        columns: { id: true },
      }),
    ]);

  const teamMembersCount = teamMembersCountResult.length;
  const bankConnectionsCount = bankConnectionsCountResult.length;

  // Can choose starter if team has 2 or fewer members and 2 or fewer bank connections
  const starter = teamMembersCount <= 2 && bankConnectionsCount <= 2;

  // Can always choose pro plan
  return {
    starter,
    pro: true,
  };
}
