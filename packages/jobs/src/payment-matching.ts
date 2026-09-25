/**
 * Matching invoices to bank payments (docs/bank-payments.md).
 *
 * `matchWorkspacePayments` runs as the `match-payments` workflow after a bank
 * sync and after an invoice revision is processed or corrected. It decides
 * every processed invoice of the workspace in turn (credit notes first, then
 * invoices, oldest first) under a workspace lock, so no two decisions count
 * the same part of one transaction. Owners and admins confirm a proposal,
 * choose transactions or record that none paid the invoice; each is a new
 * immutable decision, and automatic runs keep a person's decision. When a
 * transaction a person counted is later reversed at the bank, a `reversal`
 * decision removes just that transaction and keeps the rest.
 *
 * Payment decisions are kept apart from authorization-source decisions
 * (`source-matching.ts`): neither reads or changes the other.
 */
import type { Database } from "@invoicewise/db/client";
import {
  type PaymentInvoiceRow,
  type PaymentMatchRow,
  enqueueWorkflowJob,
  getBankPaymentSettings,
  getPaymentMatch,
  listAppliedCredits,
  listInvoicesForPaymentMatching,
  listPaymentCandidateTransactions,
  listPaymentMatchHistory,
  lockInvoiceForPayment,
  lockWorkspacePayments,
  recordPaymentMatch,
} from "@invoicewise/db/queries";
import {
  type ManualPaymentInput,
  PAYMENT_MATCHING_VERSION,
  PAYMENT_MATCH_RULES,
  type PaymentAllocation,
  type PaymentInvoice,
  type PaymentMatchResult,
  type PaymentTransaction,
  appliedCreditResult,
  decidePayment,
  fromMinor,
  manualPaymentResult,
  paymentMatchFingerprint,
  toMinor,
} from "./payment-rules";

/** Invoices one sweep decides; the oldest are decided first. */
const SWEEP_LIMIT = 1_000;
const MAX_REASON = 1_000;

export class PaymentMatchError extends Error {
  override readonly name = "PaymentMatchError";
  constructor(
    message: string,
    readonly code: "not_found" | "conflict" | "invalid" | "disabled",
  ) {
    super(message);
  }
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};

const text = (value: unknown) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

const addDays = (day: string, days: number) => {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

// --- Reading an invoice ---------------------------------------------------------------

/** The invoice as payment matching reads it, from its validation and extraction. */
export function paymentInvoiceOf(
  row: PaymentInvoiceRow,
  credits: PaymentInvoice["credits"] = [],
): PaymentInvoice {
  const extraction = record(row.extraction);
  const validation = record(row.validation);
  const documentType =
    validation.documentType === "invoice" ||
    validation.documentType === "credit_note"
      ? validation.documentType
      : "unknown";
  const gross = record(record(validation.totals).gross);
  const grossMinor = toMinor(
    typeof gross.amount === "number" || typeof gross.amount === "string"
      ? (gross.amount as number | string)
      : null,
  );
  const printed = text(extraction.invoiceDate);
  const dated = printed !== null && /^\d{4}-\d{2}-\d{2}$/.test(printed);
  return {
    id: row.id,
    documentType,
    currency: text(validation.currency) ?? text(gross.currency),
    grossMinor: grossMinor === null ? null : Math.abs(grossMinor),
    invoiceNumber: text(extraction.invoiceNumber),
    paymentReference: text(extraction.paymentReference),
    supplierName: text(extraction.supplierName),
    invoiceDate: dated ? printed! : row.createdAt.slice(0, 10),
    invoiceDatePrinted: dated,
    credits: documentType === "invoice" ? credits : [],
  };
}

const creditedInvoiceOf = (row: PaymentInvoiceRow) =>
  text(record(record(row.validation).identity).creditsInvoiceId);

type CandidateRow = Awaited<
  ReturnType<typeof listPaymentCandidateTransactions>
>[number];

const transactionOf = (row: CandidateRow): PaymentTransaction => {
  const amountMinor = toMinor(row.amount) ?? 0;
  const counted = toMinor(row.countedElsewhere) ?? 0;
  return {
    id: row.id,
    accountName: row.accountName,
    status: row.status as PaymentTransaction["status"],
    duplicated: row.duplicated,
    mode: row.mode as PaymentTransaction["mode"],
    madeOn: row.madeOn,
    amountMinor,
    currency: row.currency,
    description: row.description,
    counterparty: row.counterparty,
    reference: row.reference,
    availableMinor: Math.max(0, Math.abs(amountMinor) - counted),
  };
};

async function transactionsFor(
  db: Database,
  teamId: string,
  invoice: PaymentInvoice,
  extraIds: string[] = [],
) {
  if (!invoice.currency) return [];
  const window = await listPaymentCandidateTransactions(db, {
    teamId,
    currency: invoice.currency,
    from: addDays(invoice.invoiceDate, -PAYMENT_MATCH_RULES.windowBeforeDays),
    to: addDays(invoice.invoiceDate, PAYMENT_MATCH_RULES.windowAfterDays),
    excludeInboxId: invoice.id,
  });
  const missing = extraIds.filter((id) => !window.some((row) => row.id === id));
  const extra = missing.length
    ? await listPaymentCandidateTransactions(db, {
        teamId,
        currency: invoice.currency,
        from: "",
        to: "",
        excludeInboxId: invoice.id,
        transactionIds: missing,
      })
    : [];
  return [...window, ...extra].map(transactionOf);
}

/** Credit notes of this workspace applied to `invoiceId`. */
async function creditsFor(db: Database, teamId: string, invoiceId: string) {
  const applied = await listAppliedCredits(db, { teamId });
  return applied.flatMap((row) => {
    const appliedTo = record(record(row.result).appliedTo);
    const amountMinor = toMinor(text(appliedTo.amount));
    if (appliedTo.invoiceId !== invoiceId || !amountMinor) return [];
    return [
      {
        creditInboxId: row.creditInboxId,
        invoiceNumber: text(record(record(row.result).invoice).invoiceNumber),
        amountMinor,
      },
    ];
  });
}

// --- Presenting a decision ------------------------------------------------------------

/** A decision as REST, MCP and the dashboard show it. */
export const presentPaymentMatch = (row: PaymentMatchRow) => ({
  ...row.result,
  id: row.id,
  sequence: row.sequence,
  status: row.status,
  paymentStatus: row.paymentStatus,
  origin: row.origin,
  action: row.action,
  currency: row.currency,
  dueAmount: row.dueAmount,
  paidAmount: row.paidAmount,
  reason: row.reason,
  processingRevision: row.processingRevision,
  rulesVersion: row.rulesVersion,
  decidedAt: row.createdAt,
});

const allocationsOf = (result: PaymentMatchResult) =>
  result.allocations.map((allocation) => ({
    kind: allocation.kind,
    transactionId: allocation.transactionId,
    creditInboxId: allocation.creditInboxId,
    amount: allocation.amount,
    currency: allocation.currency,
  }));

async function record_(
  db: Database,
  input: {
    teamId: string;
    invoice: PaymentInvoiceRow;
    current: PaymentMatchRow | null;
    result: PaymentMatchResult;
    origin: "automatic" | "manual";
    action: "automatic" | "reversal" | "confirm" | "correct" | "unlink";
    reason: string | null;
    actorId: string | null;
  },
) {
  const result = {
    ...input.result,
    ...(input.current ? { previousMatchId: input.current.id } : {}),
  };
  return recordPaymentMatch(db, {
    teamId: input.teamId,
    inboxId: input.invoice.id,
    status: input.result.status,
    paymentStatus: input.result.paymentStatus,
    origin: input.origin,
    action: input.action,
    currency: input.result.invoice.currency,
    dueAmount: input.result.invoice.gross,
    paidAmount: input.result.paid,
    result: result as unknown as Record<string, unknown>,
    reason: input.reason,
    processingRevision: input.invoice.processingRevision,
    rulesVersion: PAYMENT_MATCHING_VERSION,
    fingerprint: paymentMatchFingerprint(input.result),
    actorId: input.actorId,
    allocations: allocationsOf(input.result),
  });
}

/** A person's decision, or the reversal decision that carried one forward. */
const keepsPersonDecision = (current: PaymentMatchRow | null) =>
  current !== null &&
  (current.origin === "manual" || current.action === "reversal");

// --- Scheduling -------------------------------------------------------------------------

export async function schedulePaymentMatching(
  db: Database,
  input: { teamId: string; key: string },
) {
  const { job, deduplicated } = await enqueueWorkflowJob(db, {
    name: "match-payments",
    teamId: input.teamId,
    payload: { teamId: input.teamId },
    idempotencyKey: `${input.teamId}:${input.key}`,
  });
  return { jobId: job.id, deduplicated };
}

/**
 * Queues payment matching for a processed or corrected revision, when the
 * workspace uses bank payments. Runs in the caller's transaction.
 */
export async function schedulePaymentMatchingForRevision(
  db: Database,
  input: { teamId: string; invoiceId: string; revision: number },
) {
  const settings = await getBankPaymentSettings(db, input.teamId);
  if (!settings?.enabled) return null;
  return schedulePaymentMatching(db, {
    teamId: input.teamId,
    key: `invoice:${input.invoiceId}:r${input.revision}`,
  });
}

// --- Automatic matching -------------------------------------------------------------------

export type PaymentSweepOutcome = {
  outcome: "skipped" | "completed";
  reason?: string;
  considered: number;
  recorded: number;
  unchanged: number;
  kept: number;
  reversed: number;
};

/**
 * Decides every processed invoice of the workspace. Credit notes go first so
 * the credits they apply are known when the invoices they credit are decided.
 */
export async function matchWorkspacePayments(
  db: Database,
  input: { teamId: string; now?: Date },
): Promise<PaymentSweepOutcome> {
  const outcome: PaymentSweepOutcome = {
    outcome: "completed",
    considered: 0,
    recorded: 0,
    unchanged: 0,
    kept: 0,
    reversed: 0,
  };
  const settings = await getBankPaymentSettings(db, input.teamId);
  if (!settings?.enabled) {
    return { ...outcome, outcome: "skipped", reason: "disabled" };
  }
  const rows = await listInvoicesForPaymentMatching(db, {
    teamId: input.teamId,
    limit: SWEEP_LIMIT,
  });
  const ordered = rows
    .map((row) => ({ row, invoice: paymentInvoiceOf(row) }))
    .sort(
      (a, b) =>
        Number(b.invoice.documentType === "credit_note") -
          Number(a.invoice.documentType === "credit_note") ||
        a.invoice.invoiceDate.localeCompare(b.invoice.invoiceDate) ||
        a.row.createdAt.localeCompare(b.row.createdAt) ||
        a.row.id.localeCompare(b.row.id),
    );
  for (const { row } of ordered) {
    outcome.considered += 1;
    const result = await matchInvoicePayment(db, {
      teamId: input.teamId,
      invoiceId: row.id,
      now: input.now,
    });
    if (result === "recorded") outcome.recorded += 1;
    else if (result === "unchanged") outcome.unchanged += 1;
    else if (result === "kept") outcome.kept += 1;
    else if (result === "reversed") outcome.reversed += 1;
  }
  return outcome;
}

/** Decides one invoice's payment and records it when it changed. */
export async function matchInvoicePayment(
  db: Database,
  input: { teamId: string; invoiceId: string; now?: Date },
): Promise<"skipped" | "recorded" | "unchanged" | "kept" | "reversed"> {
  const asOf = (input.now ?? new Date()).toISOString();
  return db.transaction(async (tx) => {
    const executor = tx as unknown as Database;
    await lockWorkspacePayments(executor, input.teamId);
    const row = await lockInvoiceForPayment(executor, {
      teamId: input.teamId,
      inboxId: input.invoiceId,
    });
    if (!row || !row.extraction || !row.validation || row.status === "processing") {
      return "skipped";
    }
    const current = row.paymentMatchId
      ? await getPaymentMatch(executor, {
          teamId: input.teamId,
          matchId: row.paymentMatchId,
        })
      : null;
    const credits = await creditsFor(executor, input.teamId, row.id);
    const invoice = paymentInvoiceOf(row, credits);

    if (keepsPersonDecision(current)) {
      return carryForward(executor, {
        teamId: input.teamId,
        row,
        invoice,
        current: current!,
        asOf,
      });
    }

    const transactions = await transactionsFor(executor, input.teamId, invoice);
    let result: PaymentMatchResult = decidePayment({
      invoice,
      transactions,
      asOf,
    });
    const credited = creditedInvoiceOf(row);
    if (
      invoice.documentType === "credit_note" &&
      credited &&
      result.status !== "matched" &&
      result.status !== "pending"
    ) {
      const [target] = await listInvoicesForPaymentMatching(executor, {
        teamId: input.teamId,
        limit: 1,
        inboxIds: [credited],
      });
      const targetInvoice = target ? paymentInvoiceOf(target) : null;
      if (
        targetInvoice?.documentType === "invoice" &&
        targetInvoice.currency === invoice.currency
      ) {
        result = appliedCreditResult({
          creditNote: invoice,
          invoiceId: credited,
          invoiceNumber: targetInvoice.invoiceNumber,
          asOf,
          candidates: result.candidates,
        });
      }
    }
    const fingerprint = paymentMatchFingerprint(result);
    if (
      current &&
      current.fingerprint === fingerprint &&
      current.processingRevision === row.processingRevision
    ) {
      return "unchanged";
    }
    await record_(executor, {
      teamId: input.teamId,
      invoice: row,
      current,
      result,
      origin: "automatic",
      action: "automatic",
      reason: null,
      actorId: null,
    });
    return "recorded";
  });
}

/**
 * Keeps a person's decision, except for transactions it counts that the bank
 * has since reversed (or a pending entry replaced): those stop counting in a
 * new `reversal` decision and everything else stands.
 */
async function carryForward(
  db: Database,
  input: {
    teamId: string;
    row: PaymentInvoiceRow;
    invoice: PaymentInvoice;
    current: PaymentMatchRow;
    asOf: string;
  },
): Promise<"kept" | "reversed"> {
  const previous = input.current.result as unknown as PaymentMatchResult;
  const counted = (previous.allocations ?? []).filter(
    (allocation) => allocation.transactionId,
  );
  if (counted.length === 0) return "kept";
  const ids = [...new Set(counted.map((allocation) => allocation.transactionId!))];
  const rows = await listPaymentCandidateTransactions(db, {
    teamId: input.teamId,
    currency: input.invoice.currency ?? "",
    from: "",
    to: "",
    excludeInboxId: input.invoice.id,
    transactionIds: ids,
  });
  const gone = new Set(
    rows
      .filter((row) => row.status !== "posted" || row.duplicated)
      .map((row) => row.id),
  );
  if (gone.size === 0) return "kept";
  const allocations = previous.allocations.filter(
    (allocation) => !allocation.transactionId || !gone.has(allocation.transactionId),
  );
  const paidMinor = allocations
    .filter((allocation) => allocation.kind === "payment")
    .reduce((sum, allocation) => sum + (toMinor(allocation.amount) ?? 0), 0);
  const creditedMinor = allocations
    .filter((allocation) => allocation.kind === "credit")
    .reduce((sum, allocation) => sum + (toMinor(allocation.amount) ?? 0), 0);
  const gross = input.invoice.grossMinor ?? 0;
  const settled = paidMinor + creditedMinor;
  const described = rows
    .filter((row) => gone.has(row.id))
    .map((row) => `${row.madeOn} ${row.description} (${row.status})`)
    .join("; ");
  const result: PaymentMatchResult = {
    ...previous,
    status: allocations.length > 0 ? "matched" : "unmatched",
    paymentStatus:
      settled <= 0
        ? "unpaid"
        : settled < gross
          ? "partially_paid"
          : settled === gross
            ? "paid"
            : "overpaid",
    message: `No longer counted, reversed at the bank: ${described}. The rest of the earlier decision stands.`,
    allocations,
    paid: fromMinor(paidMinor),
    remaining: fromMinor(gross - settled),
    candidates: (previous.candidates ?? []).map((candidate) =>
      gone.has(candidate.transactionId)
        ? {
            ...candidate,
            status:
              (rows.find((row) => row.id === candidate.transactionId)
                ?.status as PaymentTransaction["status"]) ?? candidate.status,
            eligible: false,
            referenceBacked: false,
            evidence: [
              ...candidate.evidence,
              {
                kind: "status",
                outcome: "conflicts",
                message: "Reversed at the bank after it was counted.",
              },
            ],
          }
        : candidate,
    ),
    asOf: input.asOf,
  };
  await record_(db, {
    teamId: input.teamId,
    invoice: input.row,
    current: input.current,
    result,
    origin: "automatic",
    action: "reversal",
    reason: null,
    actorId: null,
  });
  return "reversed";
}

// --- A person's decisions -------------------------------------------------------------------

const reasonOf = (reason: string | null | undefined, required: boolean) => {
  const value = reason?.trim() ?? "";
  if (required && !value) {
    throw new PaymentMatchError("Give a reason for this change.", "invalid");
  }
  if (value.length > MAX_REASON) {
    throw new PaymentMatchError(
      `The reason can be at most ${MAX_REASON} characters.`,
      "invalid",
    );
  }
  return value || null;
};

async function lockForDecision(
  db: Database,
  input: { teamId: string; inboxId: string; expectedMatchId?: string | null },
) {
  const settings = await getBankPaymentSettings(db, input.teamId);
  if (!settings?.enabled) {
    throw new PaymentMatchError(
      "Bank payments are not turned on for this workspace.",
      "disabled",
    );
  }
  await lockWorkspacePayments(db, input.teamId);
  const row = await lockInvoiceForPayment(db, {
    teamId: input.teamId,
    inboxId: input.inboxId,
  });
  if (!row) throw new PaymentMatchError("Invoice not found", "not_found");
  if (!row.extraction || !row.validation || row.status === "processing") {
    throw new PaymentMatchError(
      "The invoice has not been processed yet.",
      "conflict",
    );
  }
  if (
    input.expectedMatchId !== undefined &&
    (input.expectedMatchId ?? null) !== (row.paymentMatchId ?? null)
  ) {
    throw new PaymentMatchError(
      "The payment decision changed since it was opened. Reload and try again.",
      "conflict",
    );
  }
  const current = row.paymentMatchId
    ? await getPaymentMatch(db, {
        teamId: input.teamId,
        matchId: row.paymentMatchId,
      })
    : null;
  const credits = await creditsFor(db, input.teamId, row.id);
  return { row, current, invoice: paymentInvoiceOf(row, credits) };
}

const inTransaction = <T>(db: Database, work: (tx: Database) => Promise<T>) =>
  db.transaction((tx) => work(tx as unknown as Database));

/** Confirms a proposal: the proposed transaction now counts. */
export async function confirmPaymentMatch(
  db: Database,
  input: {
    teamId: string;
    inboxId: string;
    actorId: string;
    expectedMatchId?: string | null;
    reason?: string | null;
  },
) {
  return inTransaction(db, async (tx) => {
    const { row, current, invoice } = await lockForDecision(tx, input);
    const previous = current?.result as unknown as PaymentMatchResult | undefined;
    if (!current || current.status !== "proposed" || !previous?.proposed.length) {
      throw new PaymentMatchError(
        "Only a proposed payment can be confirmed; choose transactions instead.",
        "conflict",
      );
    }
    const reason = reasonOf(input.reason, false);
    const transactions = await transactionsFor(
      tx,
      input.teamId,
      invoice,
      previous.proposed.flatMap((item) => (item.transactionId ? [item.transactionId] : [])),
    );
    const { result, issues } = manualPaymentResult({
      invoice,
      transactions,
      payments: previous.proposed.map((item) => ({
        transactionId: item.transactionId!,
        amount: item.amount,
      })),
      asOf: new Date().toISOString(),
    });
    if (issues.length) {
      throw new PaymentMatchError(
        `The proposal no longer holds: ${issues.join(" ")}`,
        "conflict",
      );
    }
    const match = await record_(tx, {
      teamId: input.teamId,
      invoice: row,
      current,
      result: { ...result, message: `Confirmed: ${result.message.replace(/^Recorded by an owner or admin: /, "")}` },
      origin: "manual",
      action: "confirm",
      reason,
      actorId: input.actorId,
    });
    return presentPaymentMatch(match);
  });
}

/**
 * Records which transactions paid the invoice (and any bank charge carried by
 * them). A reason is required when it replaces a matched decision or pays
 * more than the invoice's total.
 */
export async function recordInvoicePayments(
  db: Database,
  input: {
    teamId: string;
    inboxId: string;
    actorId: string;
    expectedMatchId?: string | null;
    reason?: string | null;
    payments: ManualPaymentInput[];
  },
) {
  if (input.payments.length === 0) {
    throw new PaymentMatchError(
      "Choose at least one transaction, or record that none paid the invoice.",
      "invalid",
    );
  }
  if (input.payments.length > PAYMENT_MATCH_RULES.maxCandidates) {
    throw new PaymentMatchError(
      `At most ${PAYMENT_MATCH_RULES.maxCandidates} transactions can pay one invoice.`,
      "invalid",
    );
  }
  return inTransaction(db, async (tx) => {
    const { row, current, invoice } = await lockForDecision(tx, input);
    const transactions = await transactionsFor(
      tx,
      input.teamId,
      invoice,
      input.payments.map((payment) => payment.transactionId),
    );
    const { result, issues } = manualPaymentResult({
      invoice,
      transactions,
      payments: input.payments,
      asOf: new Date().toISOString(),
    });
    if (issues.length) throw new PaymentMatchError(issues.join(" "), "invalid");
    const reason = reasonOf(
      input.reason,
      current?.status === "matched" || result.paymentStatus === "overpaid",
    );
    const match = await record_(tx, {
      teamId: input.teamId,
      invoice: row,
      current,
      result,
      origin: "manual",
      action: "correct",
      reason,
      actorId: input.actorId,
    });
    return presentPaymentMatch(match);
  });
}

/** Records that no bank transaction paid the invoice, with the reason. */
export async function unlinkInvoicePayments(
  db: Database,
  input: {
    teamId: string;
    inboxId: string;
    actorId: string;
    expectedMatchId?: string | null;
    reason: string;
  },
) {
  return inTransaction(db, async (tx) => {
    const { row, current, invoice } = await lockForDecision(tx, input);
    const reason = reasonOf(input.reason, true);
    const previous = current?.result as unknown as PaymentMatchResult | undefined;
    const decided = decidePayment({
      invoice: { ...invoice, credits: [] },
      transactions: [],
      asOf: new Date().toISOString(),
    });
    const result: PaymentMatchResult = {
      ...decided,
      status: "unmatched",
      paymentStatus: "unpaid",
      needsConfirmation: false,
      message: "Marked by an owner or admin as paid by none of these bank transactions.",
      allocations: [],
      proposed: [],
      paid: "0.00",
      remaining: decided.invoice.gross,
      pending: [],
      unallocated: [],
      candidates: previous?.candidates ?? [],
    };
    const match = await record_(tx, {
      teamId: input.teamId,
      invoice: row,
      current,
      result,
      origin: "manual",
      action: "unlink",
      reason,
      actorId: input.actorId,
    });
    return presentPaymentMatch(match);
  });
}

// --- Reading -------------------------------------------------------------------------------

/**
 * An invoice's current payment decision and its history, plus the
 * transactions an owner or admin could choose from (in the invoice's own
 * currency and date window, with what is left of each).
 */
export async function getInvoicePayments(
  db: Database,
  input: { teamId: string; inboxId: string; withChoices: boolean },
) {
  const settings = await getBankPaymentSettings(db, input.teamId);
  const [row] = await listInvoicesForPaymentMatching(db, {
    teamId: input.teamId,
    limit: 1,
    inboxIds: [input.inboxId],
  });
  const history = await listPaymentMatchHistory(db, {
    teamId: input.teamId,
    inboxId: input.inboxId,
  });
  const decisions = history.map(({ match, actorName }) => ({
    ...presentPaymentMatch(match),
    actorName,
  }));
  let choices: (PaymentTransaction & { amount: string; available: string })[] = [];
  if (input.withChoices && row && settings?.enabled) {
    const invoice = paymentInvoiceOf(row);
    const direction = invoice.documentType === "credit_note" ? 1 : -1;
    choices = (await transactionsFor(db, input.teamId, invoice))
      .filter(
        (item) =>
          item.status === "posted" &&
          !item.duplicated &&
          Math.sign(item.amountMinor) === direction &&
          item.availableMinor > 0,
      )
      .slice(0, 200)
      .map((item) => ({
        ...item,
        amount: fromMinor(item.amountMinor),
        available: fromMinor(item.availableMinor),
      }));
  }
  return {
    enabled: settings?.enabled ?? false,
    processed: Boolean(row),
    current:
      decisions.find((decision) => decision.id === row?.paymentMatchId) ?? null,
    history: decisions,
    choices,
  };
}

export type { PaymentAllocation };
