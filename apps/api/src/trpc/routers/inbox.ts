import {
  createInboxItemSchema,
  deleteInboxSchema,
  getInboxByIdSchema,
  getInboxSchema,
  processAttachmentsSchema,
  updateInboxSchema,
} from "@api/schemas/inbox";
import { createTRPCRouter, protectedProcedure } from "@api/trpc/init";
import {
  createInbox,
  deleteInbox,
  getInbox,
  getInboxById,
  updateInbox,
} from "@midday/db/queries";
import { enqueueWorkflow, workflowKey } from "@midday/jobs";

export const inboxRouter = createTRPCRouter({
  get: protectedProcedure
    .input(getInboxSchema.optional())
    .query(async ({ ctx: { db, teamId }, input }) => {
      return getInbox(db, {
        teamId: teamId!,
        ...input,
      });
    }),

  getById: protectedProcedure
    .input(getInboxByIdSchema)
    .query(async ({ ctx: { db, teamId }, input }) => {
      return getInboxById(db, {
        id: input.id,
        teamId: teamId!,
      });
    }),

  delete: protectedProcedure
    .input(deleteInboxSchema)
    .mutation(async ({ ctx: { db, teamId }, input }) => {
      await deleteInbox(db, {
        id: input.id,
        teamId: teamId!,
      });
    }),

  create: protectedProcedure
    .input(createInboxItemSchema)
    .mutation(async ({ ctx: { db, teamId }, input }) => {
      return createInbox(db, {
        displayName: input.filename,
        teamId: teamId!,
        filePath: input.filePath,
        fileName: input.filename,
        contentType: input.mimetype,
        size: input.size,
        status: "processing",
      });
    }),

  processAttachments: protectedProcedure
    .input(processAttachmentsSchema)
    .mutation(async ({ ctx: { db, teamId }, input }) => {
      return Promise.all(
        input.map((item) =>
          enqueueWorkflow(db, {
            name: "process-attachment",
            teamId: teamId!,
            idempotencyKey: workflowKey.attachment(teamId!, item.filePath),
            payload: {
              filePath: item.filePath,
              mimetype: item.mimetype,
              size: item.size,
              teamId: teamId!,
            },
          }),
        ),
      );
    }),

  update: protectedProcedure
    .input(updateInboxSchema)
    .mutation(async ({ ctx: { db, teamId }, input }) => {
      return updateInbox(db, { ...input, teamId: teamId! });
    }),
});
