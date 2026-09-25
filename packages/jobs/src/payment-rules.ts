/**
 * Rules for matching bank transactions to invoices (docs/bank-payments.md).
 *
 * Plain code only: no model is asked. A payment is asserted automatically
 * only when the transaction prints the invoice's own number (or payment
 * reference) and moves money the right way in the invoice's own currency.
 * Everything weaker is a proposal or an ambiguity that an owner or admin
 * resolves; nothing here converts between currencies.
 */
import { createHash } from "node:crypto";

/** Bumped whenever a rule changes, so stored results can be recomputed. */
export const PAYMENT_MATCHING_VERSION = 1 as const;

export const PAYMENT_MATCH_RULES = {
  /** A payment may be made this many days before the invoice date. */
  windowBeforeDays: 14,
  /** ...and at most this many days after it. */
  windowAfterDays: 365,
  /** An amount-only proposal must be this close to the invoice date. */
  amountOnlyWindowDays: 120,
  /** Shortest printed reference that counts at all (letters and digits). */
  minReferenceLength: 4,
  /**
   * A reference of digits only and shorter than this is common to many
   * suppliers, so it asserts a payment only with the supplier's name too.
   */
  strongNumericReferenceLength: 6,
  /** Transactions shown as candidates for one invoice. */
  maxCandidates: 20,
} as const;

// --- Money ----------------------------------------------------------------------

/**
 * A decimal string in integer minor units (two places, the only precision the
 * supported invoice currencies use), rounded half away from zero. Never a
 * float: amounts are compared exactly.
 */
export const toMinor = (value: string | number | null | undefined) => {
  if (value === null || value === undefined || value === "") return null;
  const textValue = typeof value === "number" ? value.toFixed(6) : value.trim();
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(textValue);
  if (!match) return null;
  const [, sign, whole, fraction = ""] = match;
  const padded = `${fraction}000`;
  let minor = Number(whole) * 100 + Number(padded.slice(0, 2));
  if (Number(padded[2]) >= 5) minor += 1;
  return sign && minor !== 0 ? -minor : minor;
};

export const fromMinor = (minor: number) => {
  const sign = minor < 0 ? "-" : "";
  const absolute = Math.abs(minor);
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
};

// --- Inputs ---------------------------------------------------------------------

export type PaymentInvoice = {
  id: string;
  documentType: "invoice" | "credit_note" | "unknown";
  currency: string | null;
  /** Gross total in minor units, always positive (a credit note's too). */
  grossMinor: number | null;
  invoiceNumber: string | null;
  paymentReference: string | null;
  supplierName: string | null;
  /** YYYY-MM-DD; the received date when the invoice prints none. */
  invoiceDate: string;
  invoiceDatePrinted: boolean;
  /** Credit notes applied to this invoice (never to a credit note). */
  credits: { creditInboxId: string; invoiceNumber: string | null; amountMinor: number }[];
};

export type PaymentTransaction = {
  id: string;
  accountName: string;
  status: "pending" | "posted" | "superseded" | "reversed";
  duplicated: boolean;
  mode: "normal" | "fee" | "transfer";
  madeOn: string;
  /** Signed as the bank shows it: money out is negative. */
  amountMinor: number;
  currency: string;
  description: string;
  counterparty: string | null;
  reference: string | null;
  /** What other invoices' current decisions have not already counted, positive. */
  availableMinor: number;
};

// --- Result ---------------------------------------------------------------------

export type PaymentMatchStatus =
  | "matched"
  | "pending"
  | "proposed"
  | "ambiguous"
  | "unmatched"
  | "insufficient_evidence";

export type PaymentStatus =
  | "unpaid"
  | "pending"
  | "partially_paid"
  | "paid"
  | "overpaid"
  | "applied";

export type PaymentEvidence = {
  kind:
    | "reference"
    | "supplier"
    | "amount"
    | "date"
    | "direction"
    | "status"
    | "availability"
    | "manual";
  outcome: "supports" | "conflicts" | "neutral";
  message: string;
};

export type PaymentCandidate = {
  transactionId: string;
  accountName: string;
  madeOn: string;
  amount: string;
  currency: string;
  description: string;
  counterparty: string | null;
  reference: string | null;
  status: PaymentTransaction["status"];
  duplicated: boolean;
  available: string;
  /** Could be counted towards this invoice at all. */
  eligible: boolean;
  /** Prints the invoice's number strongly enough to assert a payment. */
  referenceBacked: boolean;
  evidence: PaymentEvidence[];
};

export type PaymentAllocation = {
  kind: "payment" | "fee" | "credit";
  transactionId: string | null;
  creditInboxId: string | null;
  amount: string;
  currency: string;
};

export type PaymentMatchResult = {
  version: typeof PAYMENT_MATCHING_VERSION;
  status: PaymentMatchStatus;
  paymentStatus: PaymentStatus;
  /** A proposal waits for an owner or admin; it never counts as paid. */
  needsConfirmation: boolean;
  message: string;
  invoice: {
    documentType: PaymentInvoice["documentType"];
    currency: string | null;
    gross: string | null;
    credited: string;
    /** Money leaves the bank for an invoice and arrives for a credit note. */
    direction: "out" | "in";
    references: string[];
    invoiceDate: string;
  };
  /** What this decision counts. Empty for a proposal or an ambiguity. */
  allocations: PaymentAllocation[];
  /** What a proposal would count once confirmed. */
  proposed: PaymentAllocation[];
  paid: string;
  /** Gross minus credits and payments; negative when overpaid. */
  remaining: string | null;
  /** Pending transactions that print the reference: not yet paid. */
  pending: { transactionId: string; amount: string }[];
  /** Parts of counted transactions left over, e.g. a bank charge to label. */
  unallocated: { transactionId: string; amount: string }[];
  /** For a credit note settled against the invoice it credits. */
  appliedTo: { invoiceId: string; amount: string } | null;
  candidates: PaymentCandidate[];
  asOf: string;
};

// --- Evidence helpers -------------------------------------------------------------

const tokensOf = (value: string | null | undefined) =>
  (value ?? "")
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);

const compact = (value: string | null | undefined) =>
  (value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/**
 * The references a payment for this invoice would print: its number and its
 * payment reference, whole, when long enough to mean something.
 */
export const invoicePaymentReferences = (invoice: {
  invoiceNumber: string | null;
  paymentReference: string | null;
}) =>
  [...new Set([invoice.invoiceNumber, invoice.paymentReference].map(compact))]
    .filter(
      (value) =>
        value.length >= PAYMENT_MATCH_RULES.minReferenceLength &&
        /\d/.test(value),
    );

/**
 * Whether the transaction's text prints `reference` as a whole: a run of
 * consecutive words that, without spacing or punctuation, is exactly it
 * (`INV 2026-0042` prints `INV-2026-0042`; `INV-2026-00421` does not).
 */
export const printsReference = (textValue: string, reference: string) => {
  const tokens = tokensOf(textValue);
  for (let start = 0; start < tokens.length; start += 1) {
    let joined = "";
    for (let end = start; end < tokens.length && end < start + 6; end += 1) {
      joined += tokens[end];
      if (joined === reference) return true;
      if (joined.length >= reference.length) break;
    }
  }
  return false;
};

const LEGAL_WORDS = new Set([
  "LTD",
  "LIMITED",
  "PLC",
  "LLP",
  "LP",
  "INC",
  "LLC",
  "GMBH",
  "CO",
  "COMPANY",
  "THE",
  "AND",
  "UK",
  "GROUP",
]);

/** The words of a supplier's name that identify it (legal suffixes dropped). */
export const supplierWords = (name: string | null | undefined) =>
  tokensOf(name).filter(
    (word) => word.length >= 2 && !LEGAL_WORDS.has(word),
  );

const transactionText = (transaction: PaymentTransaction) =>
  [transaction.description, transaction.counterparty, transaction.reference]
    .filter(Boolean)
    .join(" ");

const addDays = (day: string, days: number) => {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

const daysBetween = (from: string, to: string) =>
  Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
      86_400_000,
  );

const money = (minor: number, currency: string) =>
  `${fromMinor(minor)} ${currency}`;

type Assessed = {
  transaction: PaymentTransaction;
  candidate: PaymentCandidate;
  printedReference: boolean;
  supplierNamed: boolean;
  amountExact: boolean;
  nearDate: boolean;
};

/** The evidence for one transaction against one invoice. */
export function assessTransaction(
  invoice: PaymentInvoice,
  transaction: PaymentTransaction,
  dueMinor: number,
): Assessed {
  const direction = invoice.documentType === "credit_note" ? "in" : "out";
  const currency = invoice.currency ?? "";
  const evidence: PaymentEvidence[] = [];
  const references = invoicePaymentReferences(invoice);
  const textValue = transactionText(transaction);
  const printed = references.find((reference) =>
    printsReference(textValue, reference),
  );
  const words = supplierWords(invoice.supplierName);
  const textWords = new Set(tokensOf(textValue));
  const supplierNamed =
    words.length > 0 && words.every((word) => textWords.has(word));
  const absolute = Math.abs(transaction.amountMinor);
  const strongReference =
    printed !== undefined &&
    (!/^\d+$/.test(printed) ||
      printed.length >= PAYMENT_MATCH_RULES.strongNumericReferenceLength ||
      supplierNamed);

  if (printed) {
    evidence.push({
      kind: "reference",
      outcome: "supports",
      message: strongReference
        ? `Prints the invoice reference ${printed}.`
        : `Prints ${printed}, a short number many suppliers use; it counts only with the supplier's name.`,
    });
  }
  if (supplierNamed) {
    evidence.push({
      kind: "supplier",
      outcome: "supports",
      message: `Names the supplier (${words.join(" ")}).`,
    });
  }

  const rightWay =
    direction === "out" ? transaction.amountMinor < 0 : transaction.amountMinor > 0;
  if (!rightWay) {
    evidence.push({
      kind: "direction",
      outcome: "conflicts",
      message:
        direction === "out"
          ? "Money came in; an invoice is paid by money going out."
          : "Money went out; a credit note is refunded by money coming in.",
    });
  }

  const amountExact = absolute === dueMinor && dueMinor > 0;
  if (amountExact) {
    evidence.push({
      kind: "amount",
      outcome: "supports",
      message: `Exactly the ${money(dueMinor, currency)} due.`,
    });
  } else if (dueMinor > 0) {
    evidence.push({
      kind: "amount",
      outcome: "neutral",
      message:
        absolute < dueMinor
          ? `${money(absolute, currency)} is less than the ${money(dueMinor, currency)} due (a part payment at most).`
          : `${money(absolute, currency)} is more than the ${money(dueMinor, currency)} due.`,
    });
  }

  const offset = daysBetween(invoice.invoiceDate, transaction.madeOn);
  const inWindow =
    offset >= -PAYMENT_MATCH_RULES.windowBeforeDays &&
    offset <= PAYMENT_MATCH_RULES.windowAfterDays;
  evidence.push({
    kind: "date",
    outcome: inWindow ? (offset < 0 ? "neutral" : "supports") : "conflicts",
    message:
      offset < 0
        ? `${-offset} day(s) before the ${invoice.invoiceDatePrinted ? "invoice date" : "date received"}.`
        : `${offset} day(s) after the ${invoice.invoiceDatePrinted ? "invoice date" : "date received"}.`,
  });

  let statusOk = true;
  if (transaction.duplicated) {
    statusOk = false;
    evidence.push({
      kind: "status",
      outcome: "conflicts",
      message: "The bank data provider marked it as a duplicate.",
    });
  } else if (transaction.status === "reversed") {
    statusOk = false;
    evidence.push({
      kind: "status",
      outcome: "conflicts",
      message: "Reversed at the bank; it paid nothing.",
    });
  } else if (transaction.status === "superseded") {
    statusOk = false;
    evidence.push({
      kind: "status",
      outcome: "neutral",
      message: "A pending entry the bank has since posted separately.",
    });
  } else if (transaction.status === "pending") {
    evidence.push({
      kind: "status",
      outcome: "neutral",
      message: "Still pending at the bank; it is not counted as paid.",
    });
  }
  if (transaction.mode === "fee") {
    evidence.push({
      kind: "amount",
      outcome: "neutral",
      message: "The bank reports it as a fee.",
    });
  }

  const available = Math.min(transaction.availableMinor, absolute);
  if (available < absolute) {
    evidence.push({
      kind: "availability",
      outcome: available > 0 ? "neutral" : "conflicts",
      message:
        available > 0
          ? `${money(absolute - available, transaction.currency)} of it is already counted for other invoices.`
          : "Already counted in full for other invoices.",
    });
  }

  const eligible =
    transaction.currency === currency &&
    rightWay &&
    inWindow &&
    statusOk &&
    available > 0;
  return {
    transaction,
    printedReference: printed !== undefined,
    supplierNamed,
    amountExact: amountExact && available >= dueMinor,
    nearDate:
      offset >= -PAYMENT_MATCH_RULES.windowBeforeDays &&
      offset <= PAYMENT_MATCH_RULES.amountOnlyWindowDays,
    candidate: {
      transactionId: transaction.id,
      accountName: transaction.accountName,
      madeOn: transaction.madeOn,
      amount: fromMinor(transaction.amountMinor),
      currency: transaction.currency,
      description: transaction.description,
      counterparty: transaction.counterparty,
      reference: transaction.reference,
      status: transaction.status,
      duplicated: transaction.duplicated,
      available: fromMinor(available),
      eligible,
      referenceBacked: eligible && strongReference,
      evidence,
    },
  };
}

// --- Deciding ---------------------------------------------------------------------

const paymentStatusOf = (
  grossMinor: number,
  settledMinor: number,
  hasPending: boolean,
): PaymentStatus => {
  if (settledMinor <= 0) return hasPending ? "pending" : "unpaid";
  if (settledMinor < grossMinor) return "partially_paid";
  if (settledMinor === grossMinor) return "paid";
  return "overpaid";
};

const creditAllocations = (invoice: PaymentInvoice): PaymentAllocation[] =>
  invoice.credits.map((credit) => ({
    kind: "credit",
    transactionId: null,
    creditInboxId: credit.creditInboxId,
    amount: fromMinor(credit.amountMinor),
    currency: invoice.currency ?? "",
  }));

const baseOf = (invoice: PaymentInvoice, asOf: string) => {
  const creditedMinor = invoice.credits.reduce(
    (sum, credit) => sum + credit.amountMinor,
    0,
  );
  return {
    version: PAYMENT_MATCHING_VERSION,
    invoice: {
      documentType: invoice.documentType,
      currency: invoice.currency,
      gross:
        invoice.grossMinor === null ? null : fromMinor(invoice.grossMinor),
      credited: fromMinor(creditedMinor),
      direction:
        invoice.documentType === "credit_note"
          ? ("in" as const)
          : ("out" as const),
      references: invoicePaymentReferences(invoice),
      invoiceDate: invoice.invoiceDate,
    },
    creditedMinor,
    asOf,
  };
};

/** Candidates worth showing: anything with evidence tying it to the invoice. */
const shown = (assessed: Assessed[]) =>
  assessed
    .filter(
      (item) =>
        item.printedReference ||
        (item.candidate.eligible && (item.supplierNamed || item.amountExact)),
    )
    .sort(
      (a, b) =>
        Number(b.candidate.referenceBacked) -
          Number(a.candidate.referenceBacked) ||
        Number(b.printedReference) - Number(a.printedReference) ||
        Number(b.amountExact) - Number(a.amountExact) ||
        Number(b.supplierNamed) - Number(a.supplierNamed) ||
        a.transaction.madeOn.localeCompare(b.transaction.madeOn) ||
        a.transaction.id.localeCompare(b.transaction.id),
    )
    .slice(0, PAYMENT_MATCH_RULES.maxCandidates)
    .map((item) => item.candidate);

/**
 * Decides an invoice's payment from its workspace's transactions. The caller
 * has already limited `transactions` to the invoice's workspace and currency
 * and set each one's `availableMinor`.
 */
export function decidePayment(input: {
  invoice: PaymentInvoice;
  transactions: PaymentTransaction[];
  asOf: string;
}): Omit<PaymentMatchResult, "appliedTo"> & { appliedTo: null } {
  const { invoice } = input;
  const base = baseOf(invoice, input.asOf);
  const empty = {
    ...base.invoice,
  };
  if (
    invoice.documentType === "unknown" ||
    !invoice.currency ||
    invoice.grossMinor === null ||
    invoice.grossMinor <= 0
  ) {
    return {
      version: base.version,
      status: "insufficient_evidence",
      paymentStatus: "unpaid",
      needsConfirmation: false,
      message:
        "Payments can only be matched once the document type, currency and gross total are known.",
      invoice: empty,
      allocations: [],
      proposed: [],
      paid: "0.00",
      remaining: null,
      pending: [],
      unallocated: [],
      appliedTo: null,
      candidates: [],
      asOf: input.asOf,
    };
  }

  const grossMinor = invoice.grossMinor;
  const dueMinor = Math.max(0, grossMinor - base.creditedMinor);
  const currency = invoice.currency;
  const assessed = input.transactions.map((transaction) =>
    assessTransaction(invoice, transaction, dueMinor),
  );
  const candidates = shown(assessed);
  const credits = creditAllocations(invoice);

  const finish = (
    status: PaymentMatchStatus,
    message: string,
    extra: {
      allocations?: PaymentAllocation[];
      proposed?: PaymentAllocation[];
      pending?: { transactionId: string; amount: string }[];
      unallocated?: { transactionId: string; amount: string }[];
      needsConfirmation?: boolean;
    } = {},
  ) => {
    const allocations = [...credits, ...(extra.allocations ?? [])];
    const paidMinor = allocations
      .filter((allocation) => allocation.kind === "payment")
      .reduce((sum, allocation) => sum + (toMinor(allocation.amount) ?? 0), 0);
    const settled = paidMinor + base.creditedMinor;
    return {
      version: base.version,
      status,
      paymentStatus: paymentStatusOf(
        grossMinor,
        settled,
        (extra.pending ?? []).length > 0,
      ),
      needsConfirmation: extra.needsConfirmation ?? false,
      message,
      invoice: empty,
      allocations,
      proposed: extra.proposed ?? [],
      paid: fromMinor(paidMinor),
      remaining: fromMinor(grossMinor - settled),
      pending: extra.pending ?? [],
      unallocated: extra.unallocated ?? [],
      appliedTo: null,
      candidates,
      asOf: input.asOf,
    };
  };

  if (dueMinor === 0) {
    return finish(
      "matched",
      "Settled in full by the credit notes applied to it.",
    );
  }

  // 1. Transactions that print the invoice's reference assert a payment.
  const backed = assessed
    .filter((item) => item.candidate.referenceBacked)
    .sort(
      (a, b) =>
        a.transaction.madeOn.localeCompare(b.transaction.madeOn) ||
        a.transaction.id.localeCompare(b.transaction.id),
    );
  const posted = backed.filter((item) => item.transaction.status === "posted");
  const pending = backed
    .filter((item) => item.transaction.status === "pending")
    .map((item) => ({
      transactionId: item.transaction.id,
      amount: fromMinor(Math.abs(item.transaction.amountMinor)),
    }));

  if (posted.length > 0) {
    let remaining = dueMinor;
    const allocations: PaymentAllocation[] = [];
    const unallocated: { transactionId: string; amount: string }[] = [];
    for (const item of posted) {
      const available = Math.min(
        item.transaction.availableMinor,
        Math.abs(item.transaction.amountMinor),
      );
      const take = Math.min(available, remaining);
      if (take > 0) {
        allocations.push({
          kind: "payment",
          transactionId: item.transaction.id,
          creditInboxId: null,
          amount: fromMinor(take),
          currency,
        });
        remaining -= take;
      }
      if (available - take > 0) {
        unallocated.push({
          transactionId: item.transaction.id,
          amount: fromMinor(available - take),
        });
      }
    }
    const count = allocations.length;
    return finish(
      "matched",
      remaining === 0
        ? `Paid by ${count} bank transaction${count === 1 ? "" : "s"} that print${count === 1 ? "s" : ""} the invoice reference.`
        : `Part paid: ${money(dueMinor - remaining, currency)} of ${money(dueMinor, currency)} by transactions that print the invoice reference.`,
      { allocations, pending, unallocated },
    );
  }

  if (pending.length > 0) {
    return finish(
      "pending",
      "A pending bank transaction prints the invoice reference; it is not counted until the bank posts it.",
      { pending },
    );
  }

  // 2. No reference: an exact amount can only be proposed.
  const exact = assessed.filter(
    (item) =>
      item.candidate.eligible &&
      item.transaction.status === "posted" &&
      item.amountExact,
  );
  const named = exact.filter(
    (item) => item.supplierNamed || item.printedReference,
  );
  const pool = named.length > 0 ? named : exact.filter((item) => item.nearDate);
  if (pool.length === 1) {
    const [only] = pool as [Assessed];
    return finish(
      "proposed",
      named.length > 0
        ? "One transaction names the supplier and pays exactly the amount due, but prints no invoice reference: confirm it."
        : "One transaction pays exactly the amount due, with nothing else tying it to the invoice: confirm it or choose another.",
      {
        needsConfirmation: true,
        proposed: [
          {
            kind: "payment",
            transactionId: only.transaction.id,
            creditInboxId: null,
            amount: fromMinor(dueMinor),
            currency,
          },
        ],
      },
    );
  }
  if (pool.length > 1) {
    return finish(
      "ambiguous",
      `${pool.length} transactions could pay this invoice; an owner or admin chooses. None is counted until then.`,
    );
  }
  if (candidates.some((candidate) => candidate.eligible)) {
    return finish(
      "insufficient_evidence",
      "Some transactions relate to this invoice, but none is clear enough to count.",
    );
  }
  return finish("unmatched", "No bank transaction matches this invoice yet.");
}

/**
 * A credit note's decision when it is not refunded but credits an earlier
 * invoice: it is settled by being applied there.
 */
export function appliedCreditResult(input: {
  creditNote: PaymentInvoice;
  invoiceId: string;
  invoiceNumber: string | null;
  asOf: string;
  candidates: PaymentCandidate[];
}): PaymentMatchResult {
  const base = baseOf(input.creditNote, input.asOf);
  const gross = input.creditNote.grossMinor ?? 0;
  return {
    version: base.version,
    status: "matched",
    paymentStatus: "applied",
    needsConfirmation: false,
    message: `Applied to invoice ${input.invoiceNumber ?? input.invoiceId}, which it credits.`,
    invoice: base.invoice,
    allocations: [],
    proposed: [],
    paid: "0.00",
    remaining: "0.00",
    pending: [],
    unallocated: [],
    appliedTo: { invoiceId: input.invoiceId, amount: fromMinor(gross) },
    candidates: input.candidates,
    asOf: input.asOf,
  };
}

export type ManualPaymentInput = {
  transactionId: string;
  /** Paid to this invoice, positive, in the invoice's currency. */
  amount: string;
  /** Part of the same transaction that was a bank charge, not paid to it. */
  fee?: string | null;
};

/**
 * The decision an owner or admin records by choosing transactions. Refuses a
 * transaction in another currency, the wrong way, not posted, a duplicate or
 * reversed one, or more than is left of it.
 */
export function manualPaymentResult(input: {
  invoice: PaymentInvoice;
  transactions: PaymentTransaction[];
  payments: ManualPaymentInput[];
  asOf: string;
}): { result: PaymentMatchResult; issues: string[] } {
  const { invoice } = input;
  const issues: string[] = [];
  const decided = decidePayment({
    invoice,
    transactions: input.transactions,
    asOf: input.asOf,
  });
  const currency = invoice.currency ?? "";
  if (!invoice.currency || invoice.grossMinor === null) {
    issues.push("The invoice's currency and gross total must be known first.");
  }
  const byId = new Map(input.transactions.map((row) => [row.id, row]));
  const allocations: PaymentAllocation[] = [];
  const seen = new Set<string>();
  for (const payment of input.payments) {
    const transaction = byId.get(payment.transactionId);
    if (!transaction) {
      issues.push("A chosen transaction was not found in this workspace.");
      continue;
    }
    if (seen.has(transaction.id)) {
      issues.push("Choose each transaction once.");
      continue;
    }
    seen.add(transaction.id);
    const label = `${transaction.madeOn} ${transaction.description || "transaction"}`;
    if (transaction.currency !== currency) {
      issues.push(
        `${label} is in ${transaction.currency}; the invoice is in ${currency || "an unknown currency"}. Amounts are never converted.`,
      );
      continue;
    }
    const direction = invoice.documentType === "credit_note" ? 1 : -1;
    if (Math.sign(transaction.amountMinor) !== direction) {
      issues.push(`${label} moves money the wrong way for this document.`);
      continue;
    }
    if (transaction.duplicated || transaction.status !== "posted") {
      issues.push(
        `${label} cannot be counted: it is ${transaction.duplicated ? "a duplicate" : transaction.status}.`,
      );
      continue;
    }
    const amount = toMinor(payment.amount);
    const fee = toMinor(payment.fee ?? null) ?? 0;
    if (amount === null || amount < 0 || fee < 0 || amount + fee === 0) {
      issues.push(`Give a positive amount for ${label}.`);
      continue;
    }
    const available = Math.min(
      transaction.availableMinor,
      Math.abs(transaction.amountMinor),
    );
    if (amount + fee > available) {
      issues.push(
        `${label} has ${money(available, transaction.currency)} left to count; ${money(amount + fee, transaction.currency)} was given.`,
      );
      continue;
    }
    if (amount > 0) {
      allocations.push({
        kind: "payment",
        transactionId: transaction.id,
        creditInboxId: null,
        amount: fromMinor(amount),
        currency,
      });
    }
    if (fee > 0) {
      allocations.push({
        kind: "fee",
        transactionId: transaction.id,
        creditInboxId: null,
        amount: fromMinor(fee),
        currency,
      });
    }
  }
  const credits = creditAllocations(invoice);
  const all = [...credits, ...allocations];
  const paidMinor = allocations
    .filter((allocation) => allocation.kind === "payment")
    .reduce((sum, allocation) => sum + (toMinor(allocation.amount) ?? 0), 0);
  const creditedMinor = invoice.credits.reduce(
    (sum, credit) => sum + credit.amountMinor,
    0,
  );
  const grossMinor = invoice.grossMinor ?? 0;
  const settled = paidMinor + creditedMinor;
  const chosen = new Set(allocations.map((row) => row.transactionId));
  const result: PaymentMatchResult = {
    ...decided,
    status: "matched",
    paymentStatus: paymentStatusOf(grossMinor, settled, false),
    needsConfirmation: false,
    message: `Recorded by an owner or admin: ${money(paidMinor, currency)} paid by ${chosen.size} transaction${chosen.size === 1 ? "" : "s"}.`,
    allocations: all,
    proposed: [],
    paid: fromMinor(paidMinor),
    remaining: fromMinor(grossMinor - settled),
    pending: [],
    unallocated: [],
    appliedTo: null,
    candidates: [
      ...decided.candidates
        .filter((candidate) => chosen.has(candidate.transactionId))
        .map((candidate) => ({
          ...candidate,
          evidence: [
            ...candidate.evidence,
            {
              kind: "manual" as const,
              outcome: "supports" as const,
              message: "Chosen by an owner or admin.",
            },
          ],
        })),
      ...input.transactions
        .filter(
          (row) =>
            chosen.has(row.id) &&
            !decided.candidates.some(
              (candidate) => candidate.transactionId === row.id,
            ),
        )
        .map((row) => ({
          ...assessTransaction(invoice, row, grossMinor).candidate,
          evidence: [
            ...assessTransaction(invoice, row, grossMinor).candidate.evidence,
            {
              kind: "manual" as const,
              outcome: "supports" as const,
              message: "Chosen by an owner or admin.",
            },
          ],
        })),
      ...decided.candidates.filter(
        (candidate) => !chosen.has(candidate.transactionId),
      ),
    ],
  };
  return { result, issues };
}

/** What changes a decision: anything but the time it was worked out. */
export const paymentMatchFingerprint = (result: PaymentMatchResult) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        status: result.status,
        paymentStatus: result.paymentStatus,
        needsConfirmation: result.needsConfirmation,
        allocations: result.allocations,
        proposed: result.proposed,
        pending: result.pending,
        appliedTo: result.appliedTo,
        candidates: result.candidates.map((candidate) => [
          candidate.transactionId,
          candidate.status,
          candidate.available,
          candidate.eligible,
          candidate.referenceBacked,
        ]),
      }),
    )
    .digest("hex");
