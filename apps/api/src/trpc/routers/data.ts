import {
  createTRPCRouter,
  ownerProcedure,
  workspaceProcedure,
} from "@api/trpc/init";
import {
  DataExportInProgressError,
  createDataExport,
  getDataExport,
  listDataExports,
} from "@invoicewise/db/queries";
import { signedExportUrl } from "@invoicewise/db/storage";
import {
  describeRetentionPolicy,
  resolveRetentionPolicy,
} from "@invoicewise/jobs/retention-policy";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

/** A download link is minted per click and is short lived. */
const DOWNLOAD_LINK_SECONDS = 300;

export const dataRouter = createTRPCRouter({
  /**
   * The operating retention schedule. Every member may read it; it is the
   * same for every workspace.
   */
  retentionPolicy: workspaceProcedure.query(() => {
    const policy = resolveRetentionPolicy(process.env);
    return {
      policy,
      entries: describeRetentionPolicy(policy),
      note: "InvoiceWise's current operating policy. It can change and is not a legal or contractual promise.",
    };
  }),

  exports: ownerProcedure.query(({ ctx: { db, teamId } }) =>
    listDataExports(db, teamId!),
  ),

  requestExport: ownerProcedure.mutation(
    async ({ ctx: { db, teamId, session } }) => {
      try {
        return await createDataExport(db, {
          teamId: teamId!,
          requestedBy: session.user.id,
        });
      } catch (error) {
        if (error instanceof DataExportInProgressError) {
          throw new TRPCError({ code: "CONFLICT", message: error.message });
        }
        throw error;
      }
    },
  ),

  /**
   * A short-lived link to a ready archive. The link is bound to the export
   * request, and the download route re-checks that the request is still
   * ready and unexpired on every use.
   */
  exportDownloadUrl: ownerProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx: { db, teamId }, input }) => {
      const request = await getDataExport(db, {
        id: input.id,
        teamId: teamId!,
      });

      if (!request) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Export not found" });
      }

      if (
        request.status !== "ready" ||
        !request.expiresAt ||
        Date.parse(request.expiresAt) <= Date.now()
      ) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "This export is not available to download.",
        });
      }

      return {
        url: signedExportUrl({
          exportId: request.id,
          expireIn: DOWNLOAD_LINK_SECONDS,
        }),
        expiresIn: DOWNLOAD_LINK_SECONDS,
      };
    }),
});
