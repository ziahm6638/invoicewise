import {
  confirmSourceMatchSchema,
  invoiceSourceMatchSchema,
  linkInvoiceSourcesSchema,
  sourceInvoicesSchema,
  unlinkInvoiceSourcesSchema,
} from "@api/schemas/source-matches";
import {
  adminProcedure,
  createTRPCRouter,
  workspaceProcedure,
} from "@api/trpc/init";
import {
  getAuthorizationSourceHead,
  getInvoiceForMatching,
  listReconciliationHistory,
  listSourceInvoiceMatches,
  listSourceMatchHistory,
  roleAtLeast,
} from "@invoicewise/db/queries";
import {
  getSourceBalance,
  presentReconciliation,
} from "@invoicewise/jobs/reconciliation";
import {
  SourceMatchError,
  confirmInvoiceMatch,
  linkInvoiceSources,
  presentSourceMatch,
  unlinkInvoiceSources,
} from "@invoicewise/jobs/source-matching";
import { TRPCError } from "@trpc/server";

const deciding = async <T>(work: () => Promise<T>) => {
  try {
    return await work();
  } catch (error) {
    if (error instanceof SourceMatchError) {
      throw new TRPCError({
        code:
          error.code === "not_found"
            ? "NOT_FOUND"
            : error.code === "conflict"
              ? "CONFLICT"
              : error.code === "forbidden"
                ? "FORBIDDEN"
                : "BAD_REQUEST",
        message: error.message,
      });
    }
    throw error;
  }
};

/**
 * Which authorization sources an invoice bills. Every member reads the
 * decisions; only owners and admins confirm, correct or unlink a match (see
 * docs/permissions.md).
 */
export const sourceMatchesRouter = createTRPCRouter({
  /** The invoice's current decision and every earlier one, newest first. */
  forInvoice: workspaceProcedure
    .input(invoiceSourceMatchSchema)
    .query(async ({ ctx: { db, teamId, teamRole }, input }) => {
      const invoice = await getInvoiceForMatching(db, {
        teamId: teamId!,
        inboxId: input.inboxId,
      });
      if (!invoice) return null;
      const history = await listSourceMatchHistory(db, {
        teamId: teamId!,
        inboxId: input.inboxId,
      });
      const decisions = history.map(({ actorName, ...row }) => ({
        ...presentSourceMatch(row),
        actorName,
      }));
      const reconciliations = (
        await listReconciliationHistory(db, {
          teamId: teamId!,
          inboxId: input.inboxId,
        })
      ).map(presentReconciliation);
      const reconciled =
        reconciliations.find((row) => row.id === invoice.reconciliationId) ??
        null;
      // The linked sources' balances as they stand now, beside the ones the
      // reconciliation recorded when it was made.
      const balances = reconciled
        ? await Promise.all(
            reconciled.sources.map(async (source) => {
              const balance = await getSourceBalance(db, {
                teamId: teamId!,
                sourceId: source.sourceId,
              });
              if (!balance) return null;
              const { perInvoice, ...totals } = balance;
              return {
                ...totals,
                counted:
                  perInvoice.find((item) => item.inboxId === invoice.id) ??
                  null,
              };
            }),
          )
        : [];
      return {
        current:
          decisions.find((decision) => decision.id === invoice.sourceMatchId) ??
          null,
        history: decisions,
        reconciliation: {
          current: reconciled,
          history: reconciliations,
          // A newer decision or revision is still being reconciled.
          reconciling:
            invoice.sourceMatchId !== null &&
            (reconciled?.matchId !== invoice.sourceMatchId ||
              reconciled?.processingRevision !== invoice.processingRevision),
          balances: balances.filter((balance) => balance !== null),
        },
        processed:
          Boolean(invoice.extraction) && invoice.status !== "processing",
        canDecide: roleAtLeast(teamRole, "admin"),
      };
    }),

  /** The invoices currently matched to a source, with what each allocates to it. */
  forSource: workspaceProcedure
    .input(sourceInvoicesSchema)
    .query(async ({ ctx: { db, teamId }, input }) => {
      const source = await getAuthorizationSourceHead(db, {
        teamId: teamId!,
        sourceId: input.id,
      });
      if (!source) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Authorization source not found",
        });
      }
      return listSourceInvoiceMatches(db, {
        teamId: teamId!,
        sourceId: input.id,
      });
    }),

  /**
   * The source's balance now: the terms in effect today against every
   * invoice currently counted against it.
   */
  balance: workspaceProcedure
    .input(sourceInvoicesSchema)
    .query(async ({ ctx: { db, teamId }, input }) => {
      const balance = await getSourceBalance(db, {
        teamId: teamId!,
        sourceId: input.id,
      });
      if (!balance) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Authorization source not found",
        });
      }
      return balance;
    }),

  confirm: adminProcedure
    .input(confirmSourceMatchSchema)
    .mutation(({ ctx: { db, teamId, session }, input }) =>
      deciding(() =>
        confirmInvoiceMatch(db, {
          teamId: teamId!,
          actorId: session.user.id,
          ...input,
        }),
      ),
    ),

  link: adminProcedure
    .input(linkInvoiceSourcesSchema)
    .mutation(({ ctx: { db, teamId, session }, input }) =>
      deciding(() =>
        linkInvoiceSources(db, {
          teamId: teamId!,
          actorId: session.user.id,
          ...input,
        }),
      ),
    ),

  unlink: adminProcedure
    .input(unlinkInvoiceSourcesSchema)
    .mutation(({ ctx: { db, teamId, session }, input }) =>
      deciding(() =>
        unlinkInvoiceSources(db, {
          teamId: teamId!,
          actorId: session.user.id,
          ...input,
        }),
      ),
    ),
});
