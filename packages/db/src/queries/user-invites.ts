import type { Database } from "@db/client";
import { teams, userInvites, users, usersOnTeam } from "@db/schema";
import { and, eq, gt, or, sql } from "drizzle-orm";
import {
  TeamPermissionError,
  type TeamRole,
  canAssignRole,
  canManageMembers,
  getTeamMemberRow,
  lockTeamRow,
  normalizeTeamRole,
} from "./team-permissions";

export async function getUserInvites(db: Database, email: string) {
  return db.query.userInvites.findMany({
    where: and(
      eq(userInvites.email, email),
      eq(userInvites.status, "pending"),
      gt(userInvites.expiresAt, new Date()),
    ),
    with: {
      user: {
        columns: {
          id: true,
          fullName: true,
          email: true,
        },
      },
      team: {
        columns: {
          id: true,
          name: true,
          logoUrl: true,
        },
      },
    },
    columns: {
      id: true,
      email: true,
      code: true,
      role: true,
    },
  });
}

type AcceptTeamInviteParams = {
  id: string;
  userId: string;
  email: string;
};

export async function acceptTeamInvite(
  db: Database,
  params: AcceptTeamInviteParams,
) {
  return db.transaction(async (tx) => {
    // Locate the invite only to find its workspace, then take the team lock so
    // every authoritative field is read while the workspace is serialized.
    const located = await tx.query.userInvites.findFirst({
      where: eq(userInvites.id, params.id),
      columns: { teamId: true },
    });

    if (!located?.teamId) {
      throw new TeamPermissionError("NOT_FOUND", "Invite not found");
    }

    // Serialize with every other membership change for this workspace.
    if (!(await lockTeamRow(tx, located.teamId))) {
      throw new TeamPermissionError("NOT_FOUND", "Invite not found");
    }

    // Authoritative read: status, email, expiry and role all come from the row
    // as it exists under the lock, so a concurrent accept or cancel cannot be
    // replayed and a stale pre-lock snapshot is never trusted.
    const invite = await tx.query.userInvites.findFirst({
      where: eq(userInvites.id, params.id),
      columns: {
        id: true,
        email: true,
        role: true,
        teamId: true,
        status: true,
        expiresAt: true,
      },
    });

    if (!invite?.teamId) {
      throw new TeamPermissionError("NOT_FOUND", "Invite not found");
    }

    if (invite.email?.toLowerCase() !== params.email.trim().toLowerCase()) {
      throw new TeamPermissionError(
        "FORBIDDEN",
        "Invite was issued to a different email address",
      );
    }

    if (invite.status !== "pending") {
      throw new TeamPermissionError(
        "CONFLICT",
        `Invite is ${invite.status ?? "not pending"}`,
      );
    }

    if (invite.expiresAt.getTime() <= Date.now()) {
      throw new TeamPermissionError("CONFLICT", "Invite has expired");
    }

    const role = normalizeTeamRole(invite.role);

    if (!role) {
      throw new TeamPermissionError("FORBIDDEN", "Invite role is not valid");
    }

    const existing = await getTeamMemberRow(tx, invite.teamId, params.userId);

    if (!existing) {
      await tx.insert(usersOnTeam).values({
        userId: params.userId,
        role,
        teamId: invite.teamId,
      });
    }

    // Consume the invite so it cannot be replayed.
    await tx.delete(userInvites).where(eq(userInvites.id, invite.id));

    return {
      id: invite.id,
      role,
      teamId: invite.teamId,
    };
  });
}

type DeclineTeamInviteParams = {
  id: string;
  email: string;
};

export async function declineTeamInvite(
  db: Database,
  params: DeclineTeamInviteParams,
) {
  const { id, email } = params;

  return db
    .delete(userInvites)
    .where(and(eq(userInvites.id, id), eq(userInvites.email, email)));
}

export async function getTeamInvites(db: Database, teamId: string) {
  return db.query.userInvites.findMany({
    where: eq(userInvites.teamId, teamId),
    columns: {
      id: true,
      email: true,
      code: true,
      role: true,
    },
    with: {
      user: {
        columns: {
          id: true,
          fullName: true,
          email: true,
        },
      },
      team: {
        columns: {
          id: true,
          name: true,
          logoUrl: true,
        },
      },
    },
  });
}

export async function getInvitesByEmail(db: Database, email: string) {
  return db.query.userInvites.findMany({
    where: and(
      eq(userInvites.email, email),
      eq(userInvites.status, "pending"),
      gt(userInvites.expiresAt, new Date()),
    ),
    columns: {
      id: true,
      email: true,
      code: true,
      role: true,
    },
    with: {
      user: {
        columns: {
          id: true,
          fullName: true,
          email: true,
        },
      },
      team: {
        columns: {
          id: true,
          name: true,
          logoUrl: true,
        },
      },
    },
  });
}

type DeleteTeamInviteParams = {
  id: string;
  teamId: string;
  actorUserId: string;
};

export async function deleteTeamInvite(
  db: Database,
  params: DeleteTeamInviteParams,
) {
  const { id, teamId, actorUserId } = params;

  return db.transaction(async (tx) => {
    if (!(await lockTeamRow(tx, teamId))) {
      throw new TeamPermissionError("NOT_FOUND", "Team not found");
    }

    const actor = await getTeamMemberRow(tx, teamId, actorUserId);

    if (!canManageMembers(actor?.role)) {
      throw new TeamPermissionError(
        "FORBIDDEN",
        "Not allowed to cancel invitations",
      );
    }

    const [deleted] = await tx
      .delete(userInvites)
      .where(and(eq(userInvites.id, id), eq(userInvites.teamId, teamId)))
      .returning();

    return deleted;
  });
}

type CreateTeamInvitesParams = {
  teamId: string;
  actorUserId: string;
  invites: {
    email: string;
    role: TeamRole;
    invitedBy: string;
  }[];
};

type InviteValidationResult = {
  validInvites: {
    email: string;
    role: TeamRole;
    invitedBy: string;
  }[];
  skippedInvites: {
    email: string;
    reason:
      | "already_member"
      | "already_invited"
      | "duplicate"
      | "role_not_allowed";
  }[];
};

/**
 * Validates invites by checking for existing team members, pending invites, and duplicates
 */
async function validateInvites(
  db: Database,
  teamId: string,
  invites: {
    email: string;
    role: TeamRole;
    invitedBy: string;
  }[],
  actorRole: TeamRole | null,
): Promise<InviteValidationResult> {
  // Remove duplicates from input
  const uniqueInvites = invites.filter(
    (invite, index, self) =>
      index ===
      self.findIndex(
        (i) => i.email.toLowerCase() === invite.email.toLowerCase(),
      ),
  );

  const emails = uniqueInvites.map((invite) => invite.email.toLowerCase());

  // Check for existing team members
  const existingMembers = await db
    .select({
      email: users.email,
    })
    .from(usersOnTeam)
    .innerJoin(users, eq(usersOnTeam.userId, users.id))
    .where(
      and(
        eq(usersOnTeam.teamId, teamId),
        or(...emails.map((email) => sql`LOWER(${users.email}) = ${email}`)),
      ),
    );

  const existingMemberEmails = new Set(
    existingMembers
      .map((member) => member.email?.toLowerCase())
      .filter(Boolean),
  );

  // Check for pending invites
  const pendingInvites = await db
    .select({
      email: userInvites.email,
    })
    .from(userInvites)
    .where(
      and(
        eq(userInvites.teamId, teamId),
        or(
          ...emails.map((email) => sql`LOWER(${userInvites.email}) = ${email}`),
        ),
      ),
    );

  const pendingInviteEmails = new Set(
    pendingInvites.map((invite) => invite.email?.toLowerCase()).filter(Boolean),
  );

  const validInvites: typeof uniqueInvites = [];
  const skippedInvites: {
    email: string;
    reason:
      | "already_member"
      | "already_invited"
      | "duplicate"
      | "role_not_allowed";
  }[] = [];

  // Process each invite
  for (const invite of uniqueInvites) {
    const emailLower = invite.email.toLowerCase();

    if (!canAssignRole(actorRole, invite.role)) {
      skippedInvites.push({
        email: invite.email,
        reason: "role_not_allowed",
      });
    } else if (existingMemberEmails.has(emailLower)) {
      skippedInvites.push({
        email: invite.email,
        reason: "already_member",
      });
    } else if (pendingInviteEmails.has(emailLower)) {
      skippedInvites.push({
        email: invite.email,
        reason: "already_invited",
      });
    } else {
      validInvites.push(invite);
    }
  }

  return { validInvites, skippedInvites };
}

export async function createTeamInvites(
  db: Database,
  params: CreateTeamInvitesParams,
) {
  const { teamId, invites, actorUserId } = params;

  return db.transaction(async (tx) => {
    if (!(await lockTeamRow(tx, teamId))) {
      throw new TeamPermissionError("NOT_FOUND", "Team not found");
    }

    const actor = await getTeamMemberRow(tx, teamId, actorUserId);

    if (!canManageMembers(actor?.role)) {
      throw new TeamPermissionError(
        "FORBIDDEN",
        "Not allowed to invite members",
      );
    }

    // Validate invites and filter out invalid ones
    const { validInvites, skippedInvites } = await validateInvites(
      tx as unknown as Database,
      teamId,
      invites,
      normalizeTeamRole(actor?.role),
    );

    // If no valid invites, return empty results with skipped info
    if (validInvites.length === 0) {
      return {
        results: [],
        skippedInvites,
      };
    }

    const results = await Promise.all(
      validInvites.map(async (invite) => {
        // Insert new invite with conflict handling to prevent race conditions
        const [row] = await tx
          .insert(userInvites)
          .values({
            email: invite.email,
            role: invite.role,
            invitedBy: invite.invitedBy,
            teamId: teamId,
          })
          .onConflictDoNothing({
            target: [userInvites.teamId, userInvites.email],
          })
          .returning({
            id: userInvites.id,
            email: userInvites.email,
            code: userInvites.code,
            role: userInvites.role,
            invitedBy: userInvites.invitedBy,
            teamId: userInvites.teamId,
          });

        if (!row) return null;

        // Fetch team
        const team = await tx.query.teams.findFirst({
          where: eq(teams.id, teamId),
          columns: {
            id: true,
            name: true,
          },
        });

        return {
          email: row.email,
          code: row.code,
          role: row.role,
          team,
        };
      }),
    );

    return {
      results: results.filter(Boolean),
      skippedInvites,
    };
  });
}
