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
import { and, eq } from "drizzle-orm";
import {
  TeamPermissionError,
  type TeamRole,
  canAssignRole,
  canDeleteWorkspace,
  canManageMember,
  canTransferOwnership,
  countTeamOwners,
  getTeamMemberRow,
  isTeamRole,
  lockTeamRow,
} from "./team-permissions";

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

// Helper function to create system categories for a new team
async function createSystemCategoriesForTeam(
  db: Database,
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

      // Create the team
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

      // Add user to team membership (atomic with team creation)
      console.log(`[${teamCreationId}] Adding user to team membership`);
      await tx.insert(usersOnTeam).values({
        userId: params.userId,
        teamId: newTeam.id,
        role: "owner",
      });

      // Create system categories for the new team (atomic)
      console.log(`[${teamCreationId}] Creating system categories`);
      // @ts-expect-error - tx is a PgTransaction
      await createSystemCategoriesForTeam(tx, newTeam.id, params.countryCode);

      // Optionally switch user to the new team (atomic)
      if (params.switchTeam) {
        console.log(`[${teamCreationId}] Switching user to new team`);
        await tx
          .update(users)
          .set({ teamId: newTeam.id })
          .where(eq(users.id, params.userId));
      }

      const duration = Date.now() - startTime;
      console.log(
        `[${teamCreationId}] Team creation completed successfully in ${duration}ms`,
        {
          teamId: newTeam.id,
          duration,
        },
      );

      return newTeam.id;
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

/**
 * Revokes everything that could still act on behalf of a user in a workspace
 * once their membership ends: active team pointer, sessions pointed at the
 * workspace, API keys and OAuth tokens.
 */
async function revokeMembershipAccess(
  tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
  teamId: string,
  userId: string,
) {
  await tx
    .update(users)
    .set({ teamId: null })
    .where(and(eq(users.id, userId), eq(users.teamId, teamId)));

  await tx
    .update(authSessions)
    .set({ activeOrganizationId: null })
    .where(
      and(
        eq(authSessions.userId, userId),
        eq(authSessions.activeOrganizationId, teamId),
      ),
    );

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

type DeleteTeamParams = {
  teamId: string;
  userId: string;
};

export async function deleteTeam(db: Database, params: DeleteTeamParams) {
  return db.transaction(async (tx) => {
    if (!(await lockTeamRow(tx, params.teamId))) {
      throw new TeamPermissionError("NOT_FOUND", "Team not found");
    }

    const actor = await getTeamMemberRow(tx, params.teamId, params.userId);

    if (!canDeleteWorkspace(actor?.role)) {
      throw new TeamPermissionError(
        "FORBIDDEN",
        "Only the workspace owner can delete it",
      );
    }

    const [result] = await tx
      .delete(teams)
      .where(eq(teams.id, params.teamId))
      .returning({
        id: teams.id,
      });

    // Membership rows, API keys and OAuth tokens cascade with the team, but
    // the active-team pointers on users and sessions do not.
    await tx
      .update(users)
      .set({ teamId: null })
      .where(eq(users.teamId, params.teamId));

    await tx
      .update(authSessions)
      .set({ activeOrganizationId: null })
      .where(eq(authSessions.activeOrganizationId, params.teamId));

    return result;
  });
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
