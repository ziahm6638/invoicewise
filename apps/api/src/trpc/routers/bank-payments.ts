import {
  bankConnectionIdSchema,
  bankTransactionsSchema,
  completeBankConnectionSchema,
  confirmPaymentSchema,
  connectBankSchema,
  invoicePaymentsSchema,
  reconnectBankSchema,
  recordPaymentsSchema,
  setBankPaymentsSchema,
  unlinkPaymentsSchema,
} from "@api/schemas/bank-payments";
import {
  adminProcedure,
  createTRPCRouter,
  workspaceProcedure,
} from "@api/trpc/init";
import { listBankFeedTransactions, roleAtLeast } from "@invoicewise/db/queries";
import {
  BankFeedError,
  completeBankConnection,
  disconnectBankConnection,
  getBankPaymentsOverview,
  reconnectBankConnection,
  requestBankSync,
  setBankPayments,
  startBankConnection,
} from "@invoicewise/jobs/bank-feeds";
import {
  PaymentMatchError,
  confirmPaymentMatch,
  getInvoicePayments,
  recordInvoicePayments,
  unlinkInvoicePayments,
} from "@invoicewise/jobs/payment-matching";
import { TRPCError } from "@trpc/server";

const acting = async <T>(work: () => Promise<T>) => {
  try {
    return await work();
  } catch (error) {
    if (error instanceof BankFeedError || error instanceof PaymentMatchError) {
      throw new TRPCError({
        code:
          error.code === "not_found"
            ? "NOT_FOUND"
            : error.code === "conflict"
              ? "CONFLICT"
              : error.code === "forbidden"
                ? "FORBIDDEN"
                : error.code === "provider"
                  ? "BAD_GATEWAY"
                  : error.code === "invalid"
                    ? "BAD_REQUEST"
                    : "PRECONDITION_FAILED",
        message: error.message,
      });
    }
    throw error;
  }
};

/** What a member sees of a payment decision: the outcome and amounts only. */
const memberView = (decision: Record<string, unknown> | null) =>
  decision
    ? {
        id: decision.id,
        status: decision.status,
        paymentStatus: decision.paymentStatus,
        needsConfirmation: decision.needsConfirmation,
        currency: decision.currency,
        paid: decision.paid,
        remaining: decision.remaining,
        decidedAt: decision.decidedAt,
      }
    : null;

/**
 * Optional bank-payment reconciliation (docs/bank-payments.md). Bank
 * connections and transactions are owners' and admins' only; every member
 * sees an invoice's payment status, and owners and admins its evidence and
 * decisions (see docs/permissions.md).
 */
export const bankPaymentsRouter = createTRPCRouter({
  overview: adminProcedure.query(({ ctx: { db, teamId } }) =>
    getBankPaymentsOverview(db, { teamId: teamId! }),
  ),

  setEnabled: adminProcedure
    .input(setBankPaymentsSchema)
    .mutation(({ ctx: { db, teamId, session }, input }) =>
      acting(() =>
        setBankPayments(db, {
          teamId: teamId!,
          actorId: session.user.id,
          enabled: input.enabled,
        }),
      ),
    ),

  connect: adminProcedure
    .input(connectBankSchema)
    .mutation(({ ctx: { db, teamId, session }, input }) =>
      acting(() =>
        startBankConnection(db, {
          teamId: teamId!,
          actorId: session.user.id,
          consentAccepted: input.consentAccepted,
          consentPeriodDays: input.consentPeriodDays,
        }),
      ),
    ),

  complete: adminProcedure
    .input(completeBankConnectionSchema)
    .mutation(({ ctx: { db, teamId }, input }) =>
      acting(() => completeBankConnection(db, { teamId: teamId!, ...input })),
    ),

  reconnect: adminProcedure
    .input(reconnectBankSchema)
    .mutation(({ ctx: { db, teamId, session }, input }) =>
      acting(() =>
        reconnectBankConnection(db, {
          teamId: teamId!,
          actorId: session.user.id,
          ...input,
        }),
      ),
    ),

  disconnect: adminProcedure
    .input(bankConnectionIdSchema)
    .mutation(({ ctx: { db, teamId, session }, input }) =>
      acting(() =>
        disconnectBankConnection(db, {
          teamId: teamId!,
          actorId: session.user.id,
          connectionId: input.connectionId,
        }),
      ),
    ),

  sync: adminProcedure
    .input(bankConnectionIdSchema)
    .mutation(({ ctx: { db, teamId }, input }) =>
      acting(() =>
        requestBankSync(db, {
          teamId: teamId!,
          connectionId: input.connectionId,
        }),
      ),
    ),

  transactions: adminProcedure
    .input(bankTransactionsSchema)
    .query(async ({ ctx: { db, teamId }, input }) => {
      const pageSize = 100;
      const rows = await listBankFeedTransactions(db, {
        teamId: teamId!,
        connectionId: input.connectionId,
        status: input.status,
        limit: pageSize + 1,
        offset: input.page * pageSize,
      });
      return {
        data: rows.slice(0, pageSize),
        hasNextPage: rows.length > pageSize,
      };
    }),

  /** The invoice's payment decision: evidence and choices for owners and admins. */
  forInvoice: workspaceProcedure
    .input(invoicePaymentsSchema)
    .query(async ({ ctx: { db, teamId, teamRole }, input }) => {
      const canDecide = roleAtLeast(teamRole, "admin");
      const payments = await getInvoicePayments(db, {
        teamId: teamId!,
        inboxId: input.inboxId,
        withChoices: canDecide,
      });
      if (canDecide) return { ...payments, canDecide };
      return {
        enabled: payments.enabled,
        processed: payments.processed,
        current: memberView(payments.current),
        history: [],
        choices: [],
        canDecide,
      };
    }),

  confirm: adminProcedure
    .input(confirmPaymentSchema)
    .mutation(({ ctx: { db, teamId, session }, input }) =>
      acting(() =>
        confirmPaymentMatch(db, {
          teamId: teamId!,
          actorId: session.user.id,
          ...input,
        }),
      ),
    ),

  record: adminProcedure
    .input(recordPaymentsSchema)
    .mutation(({ ctx: { db, teamId, session }, input }) =>
      acting(() =>
        recordInvoicePayments(db, {
          teamId: teamId!,
          actorId: session.user.id,
          ...input,
        }),
      ),
    ),

  unlink: adminProcedure
    .input(unlinkPaymentsSchema)
    .mutation(({ ctx: { db, teamId, session }, input }) =>
      acting(() =>
        unlinkInvoicePayments(db, {
          teamId: teamId!,
          actorId: session.user.id,
          ...input,
        }),
      ),
    ),
});
