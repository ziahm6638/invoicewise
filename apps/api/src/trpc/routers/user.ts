import { auth } from "@api/auth";
import { updateUserSchema } from "@api/schemas/users";
import { resend } from "@api/services/resend";
import { createTRPCRouter, protectedProcedure } from "@api/trpc/init";
import {
  deleteUser,
  getUserById,
  getUserInvites,
  hasTeamAccess,
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
        !(await hasTeamAccess(db, input.teamId, session.user.id))
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

  delete: protectedProcedure.mutation(async ({ ctx: { db, session } }) => {
    const [data] = await Promise.all([
      deleteUser(db, session.user.id),
      resend.contacts.remove({
        email: session.user.email!,
        audienceId: process.env.RESEND_AUDIENCE_ID!,
      }),
    ]);

    return data;
  }),

  invites: protectedProcedure.query(async ({ ctx: { db, session } }) => {
    if (!session.user.email) {
      return [];
    }

    return getUserInvites(db, session.user.email);
  }),
});
