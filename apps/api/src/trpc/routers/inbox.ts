import {
  deleteInboxSchema,
  getInboxByIdSchema,
  getInboxSchema,
  retryInboxSchema,
  updateInboxSchema,
} from "@api/schemas/inbox";
import { createTRPCRouter, workspaceProcedure } from "@api/trpc/init";
import {
  deleteInbox,
  getInbox,
  getInboxById,
  updateInbox,
} from "@invoicewise/db/queries";
import { signedUrl } from "@invoicewise/db/storage";
import {
  resolveTeamDocumentBinding,
  retryIntakeProcessing,
} from "@invoicewise/jobs/intake";

export const inboxRouter = createTRPCRouter({
  get: workspaceProcedure
    .input(getInboxSchema.optional())
    .query(async ({ ctx: { db, teamId }, input }) => {
      return getInbox(db, {
        teamId: teamId!,
        ...input,
      });
    }),

  getById: workspaceProcedure
    .input(getInboxByIdSchema)
    .query(async ({ ctx: { db, teamId }, input }) => {
      const item = await getInboxById(db, {
        id: input.id,
        teamId: teamId!,
      });

      if (!item) return item;

      // Signing goes through the shared binding guard: a row whose persisted
      // path is not this workspace's document path is never signed.
      const binding = await resolveTeamDocumentBinding(db, {
        teamId: teamId!,
        id: item.id,
      });

      return {
        ...item,
        attachmentUrl: binding?.filePath?.length
          ? await signedUrl({
              bucket: "vault",
              path: binding.filePath,
              expireIn: 300,
              inboxId: item.id,
            }).catch(() => null)
          : null,
      };
    }),

  delete: workspaceProcedure
    .input(deleteInboxSchema)
    .mutation(async ({ ctx: { db, teamId }, input }) => {
      await deleteInbox(db, {
        id: input.id,
        teamId: teamId!,
      });
    }),

  /**
   * Re-queues processing for a workspace document. The caller supplies an
   * inbox id; path, type and size are resolved from the persisted binding.
   */
  retry: workspaceProcedure
    .input(retryInboxSchema)
    .mutation(async ({ ctx: { db, teamId }, input }) => {
      return retryIntakeProcessing(db, { teamId: teamId!, inboxId: input.id });
    }),

  update: workspaceProcedure
    .input(updateInboxSchema)
    .mutation(async ({ ctx: { db, teamId }, input }) => {
      return updateInbox(db, { ...input, teamId: teamId! });
    }),
});
