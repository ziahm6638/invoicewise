import type { Database, PrimaryDatabase } from "@db/client";
import { teams, users, usersOnTeam } from "@db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  DELETION_QUIESCE_MS,
  recordDeletionRequest,
  workspaceDeletionConfirmation,
} from "./deletion-requests";
import {
  TeamPermissionError,
  isPostgresError,
  lockTeamRow,
} from "./team-permissions";
import { deleteLockedWorkspace } from "./teams";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * The account profile and stored active workspace. The workspace is only
 * returned while the user is a member of it, so a stale pointer never exposes
 * a workspace they were removed from. It deliberately carries no workspace
 * credential (such as the team's inbound-mail address): workspace details come
 * from the workspace-scoped reads, which apply the caller's live role.
 */
export const getUserById = async (
  db: Database | PrimaryDatabase,
  id: string,
) => {
  const [result] = await db
    .select({
      id: users.id,
      fullName: users.fullName,
      email: users.email,
      avatarUrl: users.avatarUrl,
      locale: users.locale,
      timeFormat: users.timeFormat,
      dateFormat: users.dateFormat,
      weekStartsOnMonday: users.weekStartsOnMonday,
      timezone: users.timezone,
      timezoneAutoSync: users.timezoneAutoSync,
      teamId: usersOnTeam.teamId,
      team: {
        id: teams.id,
        name: teams.name,
        logoUrl: teams.logoUrl,
        plan: teams.plan,
        createdAt: teams.createdAt,
        countryCode: teams.countryCode,
        canceledAt: teams.canceledAt,
      },
    })
    .from(users)
    .leftJoin(
      usersOnTeam,
      and(
        eq(usersOnTeam.userId, users.id),
        eq(usersOnTeam.teamId, users.teamId),
      ),
    )
    .leftJoin(teams, eq(usersOnTeam.teamId, teams.id))
    .where(eq(users.id, id));

  return result;
};

/**
 * Generic profile fields.
 *
 * `email` is deliberately absent: a verified address only changes through the
 * authoritative Better Auth email-change flow (#33), so no generic profile
 * write can rebind the account, its invitations or its memberships.
 */
export type UpdateUserParams = {
  id: string;
  fullName?: string | null;
  teamId?: string | null;
  avatarUrl?: string | null;
  locale?: string | null;
  timeFormat?: number | null;
  dateFormat?: string | null;
  weekStartsOnMonday?: boolean | null;
  timezone?: string | null;
  timezoneAutoSync?: boolean | null;
};

export const updateUser = async (db: Database, data: UpdateUserParams) => {
  const { id, ...updateData } = data;

  const [result] = await db
    .update(users)
    .set(updateData)
    .where(eq(users.id, id))
    .returning({
      id: users.id,
      fullName: users.fullName,
      email: users.email,
      avatarUrl: users.avatarUrl,
      locale: users.locale,
      timeFormat: users.timeFormat,
      dateFormat: users.dateFormat,
      weekStartsOnMonday: users.weekStartsOnMonday,
      timezone: users.timezone,
      timezoneAutoSync: users.timezoneAutoSync,
      teamId: users.teamId,
    });

  return result;
};

export const getUserTeamId = async (db: Database, userId: string) => {
  const result = await db.query.users.findFirst({
    columns: { teamId: true },
    where: eq(users.id, userId),
  });

  return result?.teamId || null;
};

/**
 * A workspace the user is the only owner of, which blocks account deletion.
 * An unshared one (the user is its only member) can be deleted together with
 * the account; a shared one must have its ownership transferred first.
 */
export type SoleOwnedWorkspace = {
  id: string;
  name: string | null;
  /** What the user types to delete it (see `workspaceDeletionConfirmation`). */
  confirmation: string;
  shared: boolean;
};

async function findSoleOwnedWorkspaces(
  db: Pick<Transaction, "select">,
  userId: string,
): Promise<SoleOwnedWorkspace[]> {
  const owned = await db
    .select({ id: teams.id, name: teams.name })
    .from(usersOnTeam)
    .innerJoin(teams, eq(teams.id, usersOnTeam.teamId))
    .where(and(eq(usersOnTeam.userId, userId), eq(usersOnTeam.role, "owner")))
    .orderBy(teams.id);

  if (owned.length === 0) {
    return [];
  }

  const counts = await db
    .select({
      teamId: usersOnTeam.teamId,
      owners: sql<number>`count(*) filter (where ${usersOnTeam.role} = 'owner')`,
      members: sql<number>`count(*)`,
    })
    .from(usersOnTeam)
    .where(
      inArray(
        usersOnTeam.teamId,
        owned.map((team) => team.id),
      ),
    )
    .groupBy(usersOnTeam.teamId);

  return owned.flatMap((team) => {
    const count = counts.find((row) => row.teamId === team.id);

    if (!count || Number(count.owners) > 1) {
      return [];
    }

    return [
      {
        id: team.id,
        name: team.name,
        confirmation: workspaceDeletionConfirmation(team.name),
        shared: Number(count.members) > 1,
      },
    ];
  });
}

/**
 * The workspaces standing between the user and account deletion, so the
 * account screen can offer to delete unshared ones in the same confirmed step
 * and ask for an ownership transfer of shared ones.
 */
export const getSoleOwnedWorkspaces = async (
  db: Database | PrimaryDatabase,
  userId: string,
) => findSoleOwnedWorkspaces(db, userId);

export type DeleteUserOptions = {
  /**
   * Unshared workspaces the user solely owns, each named back as for
   * workspace deletion, to delete in the same transaction as the account.
   */
  deleteWorkspaces?: { teamId: string; confirmName: string }[];
};

/**
 * Deletes a user's identity and memberships.
 *
 * This is the account-deletion path, so it must uphold the same last-owner
 * invariant as every other membership mutation: a user who is the sole owner of
 * a workspace cannot delete their account until ownership is transferred or the
 * workspace is deleted deliberately. Shared workspaces are never deleted here —
 * removing one person must leave the workspace and its other members intact.
 *
 * A sole-owned workspace nobody else belongs to can be deleted deliberately in
 * the same step: listed in `deleteWorkspaces` and named back, it is removed
 * exactly as workspace deletion would, before the account, in one transaction.
 *
 * The person's own private objects (their avatar) are purged afterwards by the
 * resumable cleanup recorded in the same transaction.
 */
export const deleteUser = async (
  db: Database,
  id: string,
  options: DeleteUserOptions = {},
) => {
  const requested = new Map(
    (options.deleteWorkspaces ?? []).map((workspace) => [
      workspace.teamId,
      workspace.confirmName,
    ]),
  );

  try {
    return await db.transaction(async (tx) => {
      // Lock the user row before taking any other lock or snapshot.
      //
      // Granting a membership inserts a row whose foreign key takes a
      // `FOR KEY SHARE` lock on this user, which conflicts with `FOR UPDATE`.
      // A concurrent workspace creation or invitation acceptance therefore
      // waits here and either sees the user still present (and commits a
      // membership) or fails and rolls back — it can never create a workspace
      // around a user this transaction is deleting.
      const [user] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, id))
        .for("update")
        .limit(1);

      if (!user) {
        throw new TeamPermissionError("NOT_FOUND", "User not found");
      }

      // Snapshot memberships only after the user row is held, then lock the
      // teams in a deterministic order.
      const memberships = await tx
        .select({ teamId: usersOnTeam.teamId })
        .from(usersOnTeam)
        .where(eq(usersOnTeam.userId, id));

      const teamIds = [...new Set(memberships.map((row) => row.teamId))].sort();

      for (const teamId of teamIds) {
        await lockTeamRow(tx, teamId);
      }

      // Membership and ownership are stable now that every team row is held.
      const soleOwned = await findSoleOwnedWorkspaces(tx, id);

      for (const teamId of requested.keys()) {
        const workspace = soleOwned.find((team) => team.id === teamId);

        if (!workspace || workspace.shared) {
          throw new TeamPermissionError(
            workspace ? "CONFLICT" : "BAD_REQUEST",
            workspace
              ? "Transfer ownership of a shared workspace before deleting your account"
              : "Only a workspace you solely own and share with no one can be deleted with your account",
          );
        }

        if (requested.get(teamId)?.trim() !== workspace.confirmation) {
          throw new TeamPermissionError(
            "BAD_REQUEST",
            "Type the workspace name exactly to confirm deletion",
          );
        }
      }

      if (soleOwned.some((team) => !requested.has(team.id))) {
        throw new TeamPermissionError(
          "CONFLICT",
          "Transfer ownership or delete the workspace before deleting your account",
        );
      }

      const deletedWorkspaces: string[] = [];

      for (const workspace of soleOwned) {
        await deleteLockedWorkspace(tx, {
          teamId: workspace.id,
          requestedBy: id,
        });
        deletedWorkspaces.push(workspace.id);
      }

      // Memberships, sessions, API keys and OAuth tokens cascade with the user.
      await tx.delete(users).where(eq(users.id, id));

      const request = await recordDeletionRequest(tx, {
        subject: "account",
        subjectId: id,
        requestedBy: id,
        quiesceUntil: new Date(Date.now() + DELETION_QUIESCE_MS),
      });

      return { id, deletionRequestId: request.id, deletedWorkspaces };
    });
  } catch (error) {
    // Other flows take the team lock first and the user lock second, so a
    // deletion racing one of them can deadlock. Postgres resolves it by killing
    // one transaction; surface that as a retryable conflict rather than a raw
    // driver error, and never retry blindly inside the request.
    if (isPostgresError(error, "40P01")) {
      throw new TeamPermissionError(
        "CONFLICT",
        "Account deletion raced another workspace change. Retry the request",
      );
    }

    throw error;
  }
};
