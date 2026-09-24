import {
  questionInputSchema,
  questionKeySchema,
  updateQuestionSchema,
} from "@api/schemas/questions";
import {
  adminProcedure,
  createTRPCRouter,
  workspaceProcedure,
} from "@api/trpc/init";
import {
  createUserQuestion,
  deleteUserQuestion,
  getUserQuestionVersions,
  getUserQuestions,
  updateUserQuestion,
} from "@invoicewise/db/queries";
import { TRPCError } from "@trpc/server";

const mutationError = (error: unknown) =>
  new TRPCError({
    code: "BAD_REQUEST",
    message: error instanceof Error ? error.message : "Question update failed",
  });

export const questionsRouter = createTRPCRouter({
  list: workspaceProcedure.query(({ ctx: { db, teamId } }) =>
    getUserQuestions(db, teamId!),
  ),

  versions: workspaceProcedure
    .input(questionKeySchema)
    .query(({ ctx: { db, teamId }, input }) =>
      getUserQuestionVersions(db, { teamId: teamId!, ...input }),
    ),

  create: adminProcedure
    .input(questionInputSchema)
    .mutation(({ ctx: { db, teamId, session }, input }) =>
      createUserQuestion(db, {
        ...input,
        teamId: teamId!,
        userId: session.user.id,
      }),
    ),

  update: adminProcedure
    .input(updateQuestionSchema)
    .mutation(async ({ ctx: { db, teamId, session }, input }) => {
      try {
        const question = await updateUserQuestion(db, {
          ...input,
          teamId: teamId!,
          userId: session.user.id,
        });
        if (!question) throw new TRPCError({ code: "NOT_FOUND" });
        return question;
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        throw mutationError(error);
      }
    }),

  delete: adminProcedure
    .input(questionKeySchema)
    .mutation(async ({ ctx: { db, teamId, session }, input }) => {
      try {
        const question = await deleteUserQuestion(db, {
          ...input,
          teamId: teamId!,
          userId: session.user.id,
        });
        if (!question) throw new TRPCError({ code: "NOT_FOUND" });
        return question;
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        throw mutationError(error);
      }
    }),
});
