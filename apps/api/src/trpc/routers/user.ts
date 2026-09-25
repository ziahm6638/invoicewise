import { auth } from "@api/auth";
import { deleteUserSchema, updateUserSchema } from "@api/schemas/users";
import { resend } from "@api/services/resend";
import { createTRPCRouter, protectedProcedure } from "@api/trpc/init";
import { primaryDb } from "@invoicewise/db/client";
import {
  TeamPermissionError,
  deleteUser,
  getSoleOwnedWorkspaces,
  getTeamRole,
  getUserById,
  getUserInvites,
  updateUser,
} from "@invoicewise/db/queries";
import { TRPCError } from "@trpc/server";

export const userRouter = createTRPCRouter({
  me: protectedProcedure.query(async ({ ctx: { db, session } }) => {
    return getUserById(db, session.user.id);
  }),

  update: protectedProcedure
    .input(updateUserSchema)
    .mutation(async ({ ctx: { db, requestHeaders, session }, input }) => {
      if (
        input.teamId &&
        // Fresh primary read rather than a replica-eligible membership lookup.
        !(await getTeamRole(primaryDb, input.teamId, session.user.id))
      ) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      if (input.teamId) {
        await auth.api.setActiveOrganization({
          body: { organizationId: input.teamId },
          headers: requestHeaders,
        });
      }

      return updateUser(db, {
        id: session.user.id,
        ...input,
      });
    }),

  // Workspaces blocking account deletion. Read from the primary so a
  // just-finished ownership transfer is reflected.
  soleOwnedWorkspaces: protectedProcedure.query(
    async ({ ctx: { session } }) => {
      return getSoleOwnedWorkspaces(primaryDb, session.user.id);
    },
  ),

  delete: protectedProcedure
    .input(deleteUserSchema)
    .mutation(async ({ ctx: { db, session }, input }) => {
      let data: Awaited<ReturnType<typeof deleteUser>>;

      try {
        data = await deleteUser(db, session.user.id, {
          deleteWorkspaces: input?.deleteWorkspaces,
        });
      } catch (error) {
        if (error instanceof TeamPermissionError) {
          throw new TRPCError({ code: error.code, message: error.message });
        }

        throw error;
      }

      // Marketing-audience cleanup is best effort and must not fail a deletion
      // that already succeeded. It only runs when the optional Resend audience
      // is configured.
      const audienceId = process.env.RESEND_AUDIENCE_ID?.trim();

      if (process.env.RESEND_API_KEY?.trim() && audienceId) {
        try {
          await resend.contacts.remove({
            email: session.user.email!,
            audienceId,
          });
        } catch (error) {
          console.error("Failed to remove deleted user from Resend", error);
        }
      }

      return data;
    }),

  invites: protectedProcedure.query(async ({ ctx: { db, session } }) => {
    if (!session.user.email) {
      return [];
    }

    return getUserInvites(db, session.user.email);
  }),
});
