import { auditLogSchema } from "@api/schemas/inbox";
import { presentAuditEvent } from "@api/services/activity";
import { adminProcedure, createTRPCRouter } from "@api/trpc/init";
import { listAuditEvents } from "@invoicewise/db/queries";

export const auditRouter = createTRPCRouter({
  /**
   * The workspace's audit log, newest first: who changed what, with the
   * outcome, and every operator action or access. Owners and admins only
   * (docs/permissions.md).
   */
  list: adminProcedure
    .input(auditLogSchema)
    .query(async ({ ctx: { db, teamId }, input }) => {
      const page = await listAuditEvents(db, {
        teamId: teamId!,
        categories: input.categories,
        cursor: input.cursor ?? null,
        limit: input.limit,
      });
      return {
        data: page.data.map(presentAuditEvent),
        nextCursor: page.nextCursor,
      };
    }),
});
