import {
  invoiceAnswersSchema,
  previewQuestionSchema,
  questionInputSchema,
  questionKeySchema,
  rerunQuestionSchema,
  updateQuestionSchema,
} from "@api/schemas/questions";
import {
  adminProcedure,
  createTRPCRouter,
  workspaceProcedure,
} from "@api/trpc/init";
import {
  QuestionLimitError,
  createUserQuestion,
  deleteUserQuestion,
  getUserQuestionRevision,
  getUserQuestionVersions,
  getUserQuestions,
  listInvoicesForQuestions,
  listQuestionAnswers,
  listQuestionRuns,
  updateUserQuestion,
} from "@invoicewise/db/queries";
import {
  QuestionRequestError,
  QuestionRunInProgressError,
  previewQuestion,
  requestQuestionRerun,
  toJudgmentQuestion,
} from "@invoicewise/jobs/questions";
import { TRPCError } from "@trpc/server";

const mutationError = (error: unknown) =>
  new TRPCError({
    code: "BAD_REQUEST",
    message: error instanceof Error ? error.message : "Question update failed",
  });

/** Refusals the person can act on keep their message; anything else is internal. */
const requestError = (error: unknown) => {
  if (error instanceof TRPCError) return error;
  if (error instanceof QuestionRunInProgressError) {
    return new TRPCError({ code: "CONFLICT", message: error.message });
  }
  if (
    error instanceof QuestionRequestError ||
    error instanceof QuestionLimitError
  ) {
    return new TRPCError({ code: "BAD_REQUEST", message: error.message });
  }
  return new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: "The question could not be evaluated. Try again shortly.",
  });
};

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
    .mutation(async ({ ctx: { db, teamId, session }, input }) => {
      try {
        return await createUserQuestion(db, {
          ...input,
          teamId: teamId!,
          userId: session.user.id,
        });
      } catch (error) {
        throw mutationError(error);
      }
    }),

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

  /** Processed invoices of the workspace to preview or rerun a question on. */
  invoices: workspaceProcedure.query(({ ctx: { db, teamId } }) =>
    listInvoicesForQuestions(db, { teamId: teamId! }),
  ),

  /**
   * Answers a saved question, one of its past revisions, or an unsaved
   * draft on a few invoices, next to their current answers. Stores nothing
   * and sends nothing.
   */
  preview: adminProcedure
    .input(previewQuestionSchema)
    .mutation(async ({ ctx: { db, teamId }, input }) => {
      const stored = input.questionKey
        ? await getUserQuestionRevision(db, {
            teamId: teamId!,
            questionKey: input.questionKey,
            versionId: input.versionId,
          })
        : null;
      if (input.questionKey && !stored) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }
      if (!stored && !input.draft) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Choose a question or write one to preview.",
        });
      }
      if (stored?.isDefault && input.draft) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Default questions can only be enabled or disabled.",
        });
      }
      const question = input.draft
        ? toJudgmentQuestion({
            id: "",
            questionKey: stored?.questionKey ?? "draft",
            version: 0,
            label: input.draft.question,
            question: input.draft.question,
            context: input.draft.context ?? null,
            type: input.draft.type,
            options: input.draft.options ?? null,
            numberFormat: input.draft.numberFormat ?? null,
          })
        : toJudgmentQuestion(stored!);
      if (input.draft) {
        // A draft has no stored revision yet.
        question.versionId = undefined;
        question.version = undefined;
      }
      try {
        return await previewQuestion(db, {
          teamId: teamId!,
          question,
          isDefault: stored?.isDefault ?? false,
          invoiceIds: input.invoiceIds,
        });
      } catch (error) {
        throw requestError(error);
      }
    }),

  /**
   * Reruns the question's latest revision on the selected invoices. Each new
   * answer replaces the current one and keeps it as history; the run never
   * posts to accounting or repeats `invoice.processed`.
   */
  rerun: adminProcedure
    .input(rerunQuestionSchema)
    .mutation(async ({ ctx: { db, teamId, session }, input }) => {
      try {
        return await requestQuestionRerun(db, {
          teamId: teamId!,
          userId: session.user.id,
          questionKey: input.questionKey,
          invoiceIds: input.invoiceIds,
        });
      } catch (error) {
        throw requestError(error);
      }
    }),

  runs: workspaceProcedure
    .input(questionKeySchema)
    .query(({ ctx: { db, teamId }, input }) =>
      listQuestionRuns(db, { teamId: teamId!, questionKey: input.questionKey }),
    ),

  /** Every answer a rerun recorded on an invoice, with the one it replaced. */
  answers: workspaceProcedure
    .input(invoiceAnswersSchema)
    .query(({ ctx: { db, teamId }, input }) =>
      listQuestionAnswers(db, { teamId: teamId!, invoiceId: input.invoiceId }),
    ),
});
