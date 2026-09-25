import {
  adminProcedure,
  createTRPCRouter,
  workspaceProcedure,
} from "@api/trpc/init";
import type { DatabaseWithPrimary } from "@invoicewise/db/client";
import {
  ensureInboundEmailAddress,
  listInboundEmails,
  rotateInboundEmailAddress,
} from "@invoicewise/db/queries";
import {
  inboundAddress,
  inboundEmailDomain,
  inboundEmailLive,
} from "@invoicewise/jobs/inbound-email";
import { TRPCError } from "@trpc/server";

/**
 * The workspace's dedicated receiving address and the messages it received.
 * The address is provisioned by the server on first read; any member may see
 * it (it is where they forward invoices), and only an admin may rotate it.
 * Until the mailbox is live the address is provisioned but shown to no one.
 */
export const inboundEmailRouter = createTRPCRouter({
  get: workspaceProcedure.query(async ({ ctx, ctx: { teamId, session } }) => {
    // Provisioning writes and reads back, so it must not read a replica.
    const db = (ctx.db as DatabaseWithPrimary).usePrimaryOnly?.() ?? ctx.db;
    const address = await ensureInboundEmailAddress(db, {
      teamId: teamId!,
      userId: session.user.id,
    });
    if (!inboundEmailLive()) {
      return { address: null, createdAt: null, messages: [] };
    }
    const messages = await listInboundEmails(db, { teamId: teamId! });
    return {
      address: inboundAddress(address.localPart, inboundEmailDomain()),
      createdAt: address.createdAt,
      messages,
    };
  }),

  rotate: adminProcedure.mutation(async ({ ctx: { db, teamId, session } }) => {
    if (!inboundEmailLive()) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "The dedicated mailbox is not available yet",
      });
    }
    const address = await rotateInboundEmailAddress(db, {
      teamId: teamId!,
      userId: session.user.id,
    });
    return {
      address: inboundAddress(address.localPart, inboundEmailDomain()),
      createdAt: address.createdAt,
    };
  }),
});
