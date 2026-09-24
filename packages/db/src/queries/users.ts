import type { Database, PrimaryDatabase } from "@db/client";
import { teams, users, usersOnTeam } from "@db/schema";
import { eq } from "drizzle-orm";
import {
  TeamPermissionError,
  countTeamOwners,
  getTeamMemberRow,
  lockTeamRow,
} from "./team-permissions";

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
      teamId: users.teamId,
      team: {
        id: teams.id,
        name: teams.name,
        logoUrl: teams.logoUrl,
        plan: teams.plan,
        inboxId: teams.inboxId,
        createdAt: teams.createdAt,
        countryCode: teams.countryCode,
        canceledAt: teams.canceledAt,
      },
    })
    .from(users)
    .leftJoin(teams, eq(users.teamId, teams.id))
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
 * Deletes a user's identity and memberships.
 *
 * This is the account-deletion path, so it must uphold the same last-owner
 * invariant as every other membership mutation: a user who is the sole owner of
 * a workspace cannot delete their account until ownership is transferred or the
 * workspace is deleted deliberately. Shared workspaces are never deleted here —
 * removing one person must leave the workspace and its other members intact.
 * Resumable provider/storage cleanup is issue #35.
 */
export const deleteUser = async (db: Database, id: string) => {
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

      const soleOwnerTeams: string[] = [];

      for (const teamId of teamIds) {
        const member = await getTeamMemberRow(tx, teamId, id);

        if (
          member?.role === "owner" &&
          (await countTeamOwners(tx, teamId)) <= 1
        ) {
          soleOwnerTeams.push(teamId);
        }
      }

      if (soleOwnerTeams.length > 0) {
        throw new TeamPermissionError(
          "CONFLICT",
          "Transfer ownership or delete the workspace before deleting your account",
        );
      }

      // Memberships, sessions, API keys and OAuth tokens cascade with the user.
      await tx.delete(users).where(eq(users.id, id));

      return { id };
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

/** Matches a Postgres error code, including when a driver wraps the cause. */
const isPostgresError = (error: unknown, code: string): boolean => {
  let current: unknown = error;

  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (
      typeof current === "object" &&
      "code" in current &&
      (current as { code?: unknown }).code === code
    ) {
      return true;
    }

    current =
      typeof current === "object" && "cause" in current
        ? (current as { cause?: unknown }).cause
        : undefined;
  }

  return false;
};
