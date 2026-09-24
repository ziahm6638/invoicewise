import { auth } from "@api/auth";
import {
  acceptTeamInviteSchema,
  createTeamSchema,
  declineTeamInviteSchema,
  deleteTeamInviteSchema,
  deleteTeamMemberSchema,
  deleteTeamSchema,
  inviteTeamMembersSchema,
  leaveTeamSchema,
  updateTeamByIdSchema,
  updateTeamMemberSchema,
} from "@api/schemas/team";
import {
  adminProcedure,
  createTRPCRouter,
  ownerProcedure,
  protectedProcedure,
  workspaceProcedure,
} from "@api/trpc/init";
import {
  TeamPermissionError,
  acceptTeamInvite,
  createTeam,
  createTeamInvites,
  declineTeamInvite,
  deleteTeam,
  deleteTeamInvite,
  deleteTeamMember,
  getInvitesByEmail,
  getTeamById,
  getTeamCapabilities,
  getTeamInvites,
  getTeamMembersByTeamId,
  getTeamsByUserId,
  leaveTeam,
  updateTeamById,
  updateTeamMember,
} from "@invoicewise/db/queries";
import { enqueueWorkflow, workflowKey } from "@invoicewise/jobs";
import type { InviteTeamMembersPayload } from "@invoicewise/jobs/schema";
import { TRPCError } from "@trpc/server";

/** Maps DB-level invariant violations onto transport errors. */
const toTRPCError = (error: unknown) =>
  error instanceof TeamPermissionError
    ? new TRPCError({ code: error.code, message: error.message })
    : error;

export const teamRouter = createTRPCRouter({
  current: protectedProcedure.query(
    async ({ ctx: { db, teamId, teamRole } }) => {
      if (!teamId) {
        return null;
      }

      const team = await getTeamById(db, teamId!);

      return team
        ? {
            ...team,
            role: teamRole,
            permissions: getTeamCapabilities(teamRole),
          }
        : null;
    },
  ),

  update: adminProcedure
    .input(updateTeamByIdSchema)
    .mutation(async ({ ctx: { db, teamId }, input }) => {
      return updateTeamById(db, {
        id: teamId!,
        data: input,
      });
    }),

  members: workspaceProcedure.query(async ({ ctx: { db, teamId } }) => {
    return getTeamMembersByTeamId(db, teamId!);
  }),

  list: protectedProcedure.query(async ({ ctx: { db, session } }) => {
    return getTeamsByUserId(db, session.user.id);
  }),

  create: protectedProcedure
    .input(createTeamSchema)
    .mutation(async ({ ctx: { db, requestHeaders, session }, input }) => {
      const requestId = `trpc_team_create_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      console.log(`[${requestId}] TRPC team creation request`, {
        userId: session.user.id,
        userEmail: session.user.email,
        teamName: input.name,
        baseCurrency: input.baseCurrency,
        countryCode: input.countryCode,
        switchTeam: input.switchTeam,
        timestamp: new Date().toISOString(),
      });

      try {
        const teamId = await createTeam(db, {
          ...input,
          userId: session.user.id,
          email: session.user.email!,
        });

        if (input.switchTeam) {
          await auth.api.setActiveOrganization({
            body: { organizationId: teamId },
            headers: requestHeaders,
          });
        }

        console.log(`[${requestId}] TRPC team creation successful`, {
          teamId,
          userId: session.user.id,
        });

        return teamId;
      } catch (error) {
        console.error(`[${requestId}] TRPC team creation failed`, {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          userId: session.user.id,
          input,
        });
        throw error;
      }
    }),

  leave: protectedProcedure
    .input(leaveTeamSchema)
    .mutation(async ({ ctx: { db, session }, input }) => {
      try {
        // Sessions pointed at the workspace, including this one, move to
        // another workspace the user belongs to inside `leaveTeam`.
        return await leaveTeam(db, {
          userId: session.user.id,
          teamId: input.teamId,
        });
      } catch (error) {
        throw toTRPCError(error);
      }
    }),

  acceptInvite: protectedProcedure
    .input(acceptTeamInviteSchema)
    .mutation(async ({ ctx: { db, session }, input }) => {
      try {
        return await acceptTeamInvite(db, {
          id: input.id,
          userId: session.user.id,
          email: session.user.email!,
        });
      } catch (error) {
        throw toTRPCError(error);
      }
    }),

  declineInvite: protectedProcedure
    .input(declineTeamInviteSchema)
    .mutation(async ({ ctx: { db, session }, input }) => {
      return declineTeamInvite(db, {
        id: input.id,
        email: session.user.email!,
      });
    }),

  delete: ownerProcedure
    .input(deleteTeamSchema)
    .mutation(async ({ ctx: { db, session }, input }) => {
      let data: Awaited<ReturnType<typeof deleteTeam>>;

      try {
        data = await deleteTeam(db, {
          teamId: input.teamId,
          userId: session.user.id,
        });
      } catch (error) {
        throw toTRPCError(error);
      }

      if (!data) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Team not found",
        });
      }

      return data;
    }),

  deleteMember: adminProcedure
    .input(deleteTeamMemberSchema)
    .mutation(async ({ ctx: { db, teamId, session }, input }) => {
      if (input.teamId !== teamId) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      try {
        return await deleteTeamMember(db, {
          teamId: input.teamId,
          userId: input.userId,
          actorUserId: session.user.id,
        });
      } catch (error) {
        throw toTRPCError(error);
      }
    }),

  updateMember: adminProcedure
    .input(updateTeamMemberSchema)
    .mutation(async ({ ctx: { db, teamId, session }, input }) => {
      if (input.teamId !== teamId) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      try {
        return await updateTeamMember(db, {
          ...input,
          actorUserId: session.user.id,
        });
      } catch (error) {
        throw toTRPCError(error);
      }
    }),

  teamInvites: adminProcedure.query(async ({ ctx: { db, teamId } }) => {
    return getTeamInvites(db, teamId!);
  }),

  invitesByEmail: protectedProcedure.query(async ({ ctx: { db, session } }) => {
    return getInvitesByEmail(db, session.user.email!);
  }),

  invite: adminProcedure
    .input(inviteTeamMembersSchema)
    .mutation(async ({ ctx: { db, session, teamId, geo }, input }) => {
      const ip = geo.ip ?? "127.0.0.1";

      let data: Awaited<ReturnType<typeof createTeamInvites>>;

      try {
        data = await createTeamInvites(db, {
          teamId: teamId!,
          actorUserId: session.user.id,
          invites: input.map((invite) => ({
            ...invite,
            invitedBy: session.user.id,
          })),
        });
      } catch (error) {
        throw toTRPCError(error);
      }

      const results = data?.results ?? [];
      const skippedInvites = data?.skippedInvites ?? [];

      const invites = results.map((invite) => ({
        email: invite?.email!,
        invitedBy: session.user.id!,
        invitedByName: session.user.full_name!,
        invitedByEmail: session.user.email!,
        teamName: invite?.team?.name!,
        inviteCode: invite?.code!,
      }));

      for (const invite of invites) {
        await enqueueWorkflow(db, {
          name: "invite-team-members",
          teamId: teamId!,
          payload: {
            teamId: teamId!,
            invite,
            ip,
            locale: "en",
          } satisfies InviteTeamMembersPayload,
          idempotencyKey: workflowKey.invitations(teamId!, [invite.inviteCode]),
        });
      }

      // Return information about the invitation process
      return {
        sent: invites.length,
        skipped: skippedInvites.length,
        skippedInvites,
      };
    }),

  deleteInvite: adminProcedure
    .input(deleteTeamInviteSchema)
    .mutation(async ({ ctx: { db, teamId, session }, input }) => {
      try {
        return await deleteTeamInvite(db, {
          teamId: teamId!,
          id: input.id,
          actorUserId: session.user.id,
        });
      } catch (error) {
        throw toTRPCError(error);
      }
    }),
});
