import {
  bulkInvoiceActionSchema,
  correctInboxSchema,
  deleteInboxSchema,
  getInboxByIdSchema,
  getInboxSchema,
  invoiceRevisionSchema,
  retryInboxSchema,
  updateInboxSchema,
} from "@api/schemas/inbox";
import { readInvoiceActivity } from "@api/services/activity";
import { createTRPCRouter, workspaceProcedure } from "@api/trpc/init";
import type { Database } from "@invoicewise/db/client";
import {
  type TeamRole,
  deleteInbox,
  getInbox,
  getInboxById,
  getInvoiceAccountingStatus,
  getInvoiceDeliveryStatus,
  getInvoiceOriginalExtraction,
  getLatestBillUpdate,
  listInvoiceCorrections,
  updateInbox,
} from "@invoicewise/db/queries";
import { signedUrl } from "@invoicewise/db/storage";
import { providerBillUrl } from "@invoicewise/jobs/accounting";
import { retryInvoiceDelivery } from "@invoicewise/jobs/delivery";
import {
  InvoiceActionError,
  correctInvoice,
  requestQuestionRerun,
} from "@invoicewise/jobs/exceptions";
import {
  resolveTeamDocumentBinding,
  retryIntakeProcessing,
} from "@invoicewise/jobs/intake";
import { TRPCError } from "@trpc/server";

const ACTION_ERROR_CODE = {
  not_found: "NOT_FOUND",
  conflict: "CONFLICT",
  invalid: "BAD_REQUEST",
  forbidden: "FORBIDDEN",
} as const;

/** Refused invoice actions reach the dashboard as typed tRPC errors. */
const asTRPCError = (error: unknown) =>
  error instanceof InvoiceActionError
    ? new TRPCError({
        code: ACTION_ERROR_CODE[error.code],
        message: error.message,
      })
    : error;

const reextract = async (
  db: Database,
  input: { teamId: string; id: string; revision?: number },
) => {
  const result = await retryIntakeProcessing(db, {
    teamId: input.teamId,
    inboxId: input.id,
    expectedRevision: input.revision,
  }).catch((error) => {
    throw asTRPCError(error);
  });
  if (!result) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Invoice not found" });
  }
  return result;
};

const rerunQuestions = (
  db: Database,
  input: { teamId: string; id: string; revision: number },
) =>
  requestQuestionRerun(db, {
    invoiceId: input.id,
    teamId: input.teamId,
    expectedRevision: input.revision,
  }).catch((error) => {
    throw asTRPCError(error);
  });

const retryDelivery = async (
  db: Database,
  input: { teamId: string; id: string; teamRole: TeamRole | null },
) => {
  const result = await retryInvoiceDelivery(db, {
    invoiceId: input.id,
    teamId: input.teamId,
    teamRole: input.teamRole,
  });
  if (!result) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Invoice not found" });
  }
  return result;
};

/** Why a delivery retry re-queued nothing, or null when something restarted. */
const retryNotStartedReason = (
  result: Awaited<ReturnType<typeof retryDelivery>>,
) => {
  if (
    result.webhooks.requeued > 0 ||
    result.accounting === "requeued" ||
    result.billUpdate === "requeued"
  ) {
    return null;
  }
  if (
    result.accounting === "in_progress" ||
    result.billUpdate === "in_progress"
  ) {
    return "Already being sent";
  }
  if (
    result.accounting === "admin_required" ||
    result.billUpdate === "admin_required"
  ) {
    return "Re-sending to accounting needs an admin";
  }
  if (
    result.accounting === "no_active_connection" ||
    result.billUpdate === "no_active_connection"
  ) {
    return "Reconnect accounting first";
  }
  return "Nothing failed to retry";
};

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
    .mutation(async ({ ctx: { db, teamId }, input }) =>
      reextract(db, {
        teamId: teamId!,
        id: input.id,
        revision: input.revision,
      }),
    ),

  /**
   * Corrects extracted fields of the revision the user saw; see
   * `correctInvoice` for validation, history and what happens to the bill.
   */
  correct: workspaceProcedure
    .input(correctInboxSchema)
    .mutation(async ({ ctx: { db, teamId, teamRole, session }, input }) =>
      correctInvoice(db, {
        invoiceId: input.id,
        teamId: teamId!,
        actorId: session.user.id,
        teamRole: teamRole ?? null,
        expectedRevision: input.revision,
        reason: input.reason,
        changes: input.changes,
        accountingOutcome: input.accountingOutcome,
      }).catch((error) => {
        throw asTRPCError(error);
      }),
    ),

  /** Answers the workspace's questions again for the revision the user saw. */
  rerunQuestions: workspaceProcedure
    .input(invoiceRevisionSchema)
    .mutation(async ({ ctx: { db, teamId }, input }) =>
      rerunQuestions(db, {
        teamId: teamId!,
        id: input.id,
        revision: input.revision,
      }),
    ),

  /**
   * One action over the selected invoices. Each item runs on its own, at the
   * revision the user saw, and reports its own outcome.
   */
  bulkAction: workspaceProcedure
    .input(bulkInvoiceActionSchema)
    .mutation(async ({ ctx: { db, teamId, teamRole }, input }) => {
      const results = [];
      for (const item of input.items) {
        try {
          if (input.action === "reextract") {
            await reextract(db, { teamId: teamId!, ...item });
          } else if (input.action === "rerun_questions") {
            await rerunQuestions(db, { teamId: teamId!, ...item });
          } else {
            const retried = await retryDelivery(db, {
              teamId: teamId!,
              id: item.id,
              teamRole: teamRole ?? null,
            });
            const notStarted = retryNotStartedReason(retried);
            if (notStarted) {
              results.push({
                id: item.id,
                ok: false as const,
                error: notStarted,
              });
              continue;
            }
          }
          results.push({ id: item.id, ok: true as const, error: null });
        } catch (error) {
          results.push({
            id: item.id,
            ok: false as const,
            error: error instanceof Error ? error.message : "The action failed",
          });
        }
      }
      return { action: input.action, results };
    }),

  /**
   * The invoice's correction history, the reading it was corrected from and
   * where its bill is in the accounting provider.
   */
  history: workspaceProcedure
    .input(getInboxByIdSchema)
    .query(async ({ ctx: { db, teamId }, input }) => {
      const item = await getInboxById(db, { id: input.id, teamId: teamId! });
      if (!item) return null;
      const target = { invoiceId: item.id, teamId: teamId! };
      const [corrections, original, accounting] = await Promise.all([
        listInvoiceCorrections(db, target),
        getInvoiceOriginalExtraction(db, target),
        getInvoiceAccountingStatus(db, target),
      ]);
      return {
        revision: item.processingRevision,
        corrections,
        original,
        bill:
          accounting?.provider && accounting.providerId
            ? {
                provider: accounting.provider,
                providerId: accounting.providerId,
                postedAt: accounting.postedAt,
                url: providerBillUrl(
                  accounting.provider,
                  accounting.providerId,
                ),
              }
            : null,
      };
    }),

  /**
   * The invoice's activity trace: receipt, each reading and question rerun,
   * corrections and actions with who took them, and every destination with
   * its outcome and correlation identifiers. Every member may read it.
   */
  activity: workspaceProcedure
    .input(getInboxByIdSchema)
    .query(async ({ ctx: { db, teamId }, input }) =>
      readInvoiceActivity(db, {
        teamId: teamId!,
        invoiceId: input.id,
        audience: "customer",
      }),
    ),

  /**
   * Per-destination delivery outcome of the invoice's current revision:
   * webhook deliveries and the accounting post.
   */
  delivery: workspaceProcedure
    .input(getInboxByIdSchema)
    .query(async ({ ctx: { db, teamId }, input }) => {
      const item = await getInboxById(db, { id: input.id, teamId: teamId! });
      if (!item) return null;
      const [webhooks, accounting, billUpdate] = await Promise.all([
        getInvoiceDeliveryStatus(db, { invoiceId: item.id, teamId: teamId! }),
        getInvoiceAccountingStatus(db, {
          invoiceId: item.id,
          teamId: teamId!,
        }),
        getLatestBillUpdate(db, { invoiceId: item.id, teamId: teamId! }),
      ]);
      return {
        revision: item.processingRevision,
        summary: item.delivery,
        webhooks: webhooks.filter(
          (delivery) =>
            delivery.revision === item.processingRevision &&
            delivery.event !== "delivery.failed",
        ),
        accounting: accounting && {
          ...accounting,
          url:
            accounting.provider && accounting.providerId
              ? providerBillUrl(accounting.provider, accounting.providerId)
              : null,
        },
        billUpdate: billUpdate && {
          version: billUpdate.version,
          status: billUpdate.updateStatus,
          error: billUpdate.updateError,
          retryable: billUpdate.updateRetryable,
          updatedAt: billUpdate.updatedAt,
        },
      };
    }),

  /**
   * Re-drives the failed or cancelled destinations of the invoice's current
   * revision. Destinations that were disabled or disconnected are skipped,
   * and the accounting re-post is left to an admin (`admin_required`).
   */
  retryDelivery: workspaceProcedure
    .input(retryInboxSchema)
    .mutation(async ({ ctx: { db, teamId, teamRole }, input }) =>
      retryDelivery(db, {
        teamId: teamId!,
        id: input.id,
        teamRole: teamRole ?? null,
      }),
    ),

  update: workspaceProcedure
    .input(updateInboxSchema)
    .mutation(async ({ ctx: { db, teamId }, input }) => {
      return updateInbox(db, { ...input, teamId: teamId! });
    }),
});
