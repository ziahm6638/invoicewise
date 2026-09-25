/**
 * Reconciling an invoice with the authorization sources it is matched to.
 *
 * Matching (`source-matching.ts`) says which sources an invoice bills and how
 * much of it goes to each. Reconciliation compares those allocations with the
 * authorized terms, line by line and in total (quantity, unit rate, tax and
 * amount), and with what the source's other invoices have already consumed,
 * so a partial invoice, a credit or an amendment moves the remaining balance
 * exactly once.
 *
 * Plain code decides every number, in integer arithmetic: money in minor
 * units, quantities and rates in ten-thousandths, with the tolerances below.
 * Amounts in different currencies are never compared (no conversion data is
 * held), and missing evidence leaves the result unresolved rather than
 * guessed. TypeSafe is asked only whether an invoice line that pairs with no
 * authorized line falls within the source's written scope; its answer
 * explains the line and never changes a number.
 *
 * `docs/reconciliation.md` publishes these rules.
 */
import { type AuthorizationLine, formatDecimal } from "./authorization-source";
import type {
  SourceAllocation,
  SourceMatchLink,
  SourceMatchStatus,
} from "./source-matching";
import { toMinor } from "./validation";

/** Bumped whenever a rule below changes, so stored results can be told apart. */
export const RECONCILIATION_VERSION = 1;

/** Quantities and unit rates are compared in units of 10^-4. */
const UNIT_SCALE = 4;
const UNIT = 10n ** BigInt(UNIT_SCALE);

/**
 * How close is close enough, stated once. Money is compared in minor units
 * of the invoice currency (two decimals), quantities and unit rates to four
 * decimal places, all rounded half away from zero.
 */
export const RECONCILIATION_TOLERANCES = {
  /**
   * A sum of amounts against its authorized amount: one minor unit per
   * invoice allocation in the sum (at least one), because each printed line
   * total may itself be rounded.
   */
  amountMinor: (allocations: number) => Math.max(1, allocations),
  /**
   * A unit rate against the authorized unit price: half a minor unit
   * (0.0050), because an invoice may print a four-decimal price rounded to
   * two decimals.
   */
  rateUnits: 50,
  /** Quantities are exact to four decimal places. */
  quantityUnits: 0,
  /** Tax charged against a source that authorizes none: one minor unit. */
  taxMinor: 1,
} as const;

/** Tolerances as published with every result. */
export const RECONCILIATION_TOLERANCE_SUMMARY = {
  amount: "0.01 per invoice allocation compared (at least 0.01)",
  rate: "0.0050",
  quantity: "0 (exact to 4 decimal places)",
  tax: "0.01",
} as const;

export const RECONCILIATION_LIMITS = {
  /** Invoice lines judged against a source's scope for one invoice. */
  scopeLines: 20,
  /** Probability TypeSafe needs before a scope answer explains a line. */
  scopeProbability: 0.8,
} as const;

// --- Decimal arithmetic ------------------------------------------------------------

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const text = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const finite = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** A signed decimal string with at most `scale` decimals as integer units. */
export const parseSignedDecimal = (
  value: unknown,
  scale: number,
): bigint | null => {
  if (typeof value !== "string") return null;
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) return null;
  const fraction = (match[3] ?? "").replace(/0+$/, "");
  if (fraction.length > scale) return null;
  const units = BigInt(`${match[2]}${fraction.padEnd(scale, "0")}`);
  return match[1] ? -units : units;
};

/** Integer units as a signed fixed decimal string. */
export const formatSignedDecimal = (units: bigint, scale: number) =>
  `${units < 0n ? "-" : ""}${formatDecimal(units < 0n ? -units : units, scale)}`;

const money = (minor: bigint) => formatSignedDecimal(minor, 2);
/** Quantities and rates without redundant trailing zeros. */
const units = (value: bigint) =>
  formatSignedDecimal(value, UNIT_SCALE).replace(/\.?0+$/, "") || "0";

const minorOfNumber = (value: number) => BigInt(toMinor(value));
const unitsOfNumber = (value: number) =>
  BigInt(
    Math.sign(value) * Math.round(Math.abs(value) * 10 ** UNIT_SCALE + 1e-7),
  );
const abs = (value: bigint) => (value < 0n ? -value : value);

/** `numerator / denominator`, rounded half away from zero. */
const divideRounded = (numerator: bigint, denominator: bigint) => {
  const negative = numerator < 0n !== denominator < 0n;
  const n = abs(numerator);
  const d = abs(denominator);
  const quotient = (n * 2n + d) / (d * 2n);
  return negative ? -quotient : quotient;
};

const display = (currency: string | null, minor: bigint) =>
  `${currency ?? ""} ${money(minor)}`.trim();

// --- Inputs --------------------------------------------------------------------------

/** One version of a source's terms, as reconciliation reads it. */
export type ReconciliationTerms = {
  versionId: string;
  version: number;
  status: string;
  title: string | null;
  scope: string | null;
  currency: string | null;
  taxBasis: string | null;
  startsOn: string | null;
  endsOn: string | null;
  authorizedTotal: string;
  lines: readonly AuthorizationLine[];
};

/** What the source's other invoices consume, as the ledger counts it now. */
export type PriorConsumption = {
  /** Sum of counted amounts in `basis` and `currency`, as a decimal string. */
  amount: string;
  /** Invoices counted. */
  invoices: number;
  /** Invoices matched to the source whose amount could not be counted. */
  uncounted: number;
  lines: { reference: string; amount: string; quantity: string | null }[];
};

export type ReconciliationSource = {
  sourceId: string;
  type: string;
  reference: string;
  /** The version the match compared (in effect on the invoice date). */
  cited: ReconciliationTerms;
  /** The version in effect now (else the newest): the balance's terms. */
  current: ReconciliationTerms;
  prior: PriorConsumption;
};

/** TypeSafe's reading of an unpaired invoice line against a source's scope. */
export type ScopeJudgment =
  | {
      status: "answered";
      model: string;
      answer: "within_scope" | "outside_scope" | "unclear";
      probability: number;
    }
  | { status: "failed"; reason: string };

export type ReconciliationMatch = {
  id: string;
  status: SourceMatchStatus;
  needsConfirmation: boolean;
  invoiceDate: { value: string; basis: string } | null;
  links: readonly SourceMatchLink[];
  allocations: readonly SourceAllocation[];
  unallocatedLines: readonly number[];
};

export type ReconcileInput = {
  extraction: unknown;
  validation: unknown;
  match: ReconciliationMatch;
  sources: readonly ReconciliationSource[];
  /** Keyed by `scopeKey(sourceId, invoiceLineIndex)`. */
  scope: Readonly<Record<string, ScopeJudgment>>;
};

export const scopeKey = (sourceId: string, invoiceLineIndex: number) =>
  `${sourceId}:${invoiceLineIndex}`;

// --- Outputs -------------------------------------------------------------------------

export type ReconciliationStatus =
  | "reconciled"
  | "discrepancy"
  | "unresolved"
  | "unmatched";

export type DiscrepancyCode =
  | "over_authorized_total"
  | "line_amount_over_authorized"
  | "quantity_over_authorized"
  | "rate_above_authorized"
  | "tax_not_authorized"
  | "outside_scope"
  | "line_not_authorized"
  | "source_cancelled"
  | "source_closed"
  | "outside_period"
  | "credit_exceeds_invoiced";

export type UnresolvedCode =
  | "match_needs_confirmation"
  | "match_ambiguous"
  | "match_insufficient_evidence"
  | "allocation_incomplete"
  | "currency_missing"
  | "currency_mismatch"
  | "tax_basis_unknown"
  | "amount_missing"
  | "scope_unclear"
  | "duplicate_invoice"
  | "prior_uncounted";

export type ReconciliationFinding<Code extends string> = {
  code: Code;
  sourceId: string | null;
  reference: string | null;
  invoiceLineIndex: number | null;
  sourceLineReference: string | null;
  message: string;
  /** What the invoice and the source each say, as printed or recorded. */
  evidence: {
    invoice?: Record<string, string | number | null>;
    source?: Record<string, string | number | null>;
  };
};

export type Comparison = {
  invoiced: string | null;
  authorized: string | null;
  /** Invoiced minus authorized. */
  variance: string | null;
  tolerance: string | null;
  outcome: "within" | "above" | "below" | "not_compared";
  note?: string;
};

export type LineVariance = {
  invoiceLineIndex: number | null;
  description: string | null;
  sourceLineReference: string | null;
  authorizedDescription: string | null;
  quantity: Comparison;
  rate: Comparison;
  amount: Comparison;
  tax: Comparison;
  scope: {
    status:
      | "paired"
      | "within_scope"
      | "outside_scope"
      | "unclear"
      | "not_judged";
    probability: number | null;
    message: string;
  };
};

export type LineBalance = {
  reference: string;
  description: string;
  authorizedQuantity: string | null;
  authorizedAmount: string;
  committedQuantityBefore: string | null;
  committedAmountBefore: string;
  invoicedQuantity: string | null;
  invoicedAmount: string | null;
  remainingQuantity: string | null;
  remainingAmount: string | null;
};

/** What this invoice consumes of one source, in the source's current basis. */
export type Consumption = {
  sourceLineReference: string | null;
  /** Signed minor-unit decimal; null when it could not be determined. */
  amount: string | null;
  quantity: string | null;
  currency: string | null;
  basis: "net" | "gross";
};

export type ReconciledSource = {
  sourceId: string;
  type: string;
  reference: string;
  citedVersion: number;
  citedVersionId: string;
  currentVersion: number;
  currentVersionId: string;
  currentStatus: string;
  currency: string | null;
  /** Which amounts are compared: net of tax or including it. */
  basis: "net" | "gross" | null;
  lines: LineVariance[];
  total: Comparison;
  balance: {
    authorized: string;
    committedBefore: string;
    invoiced: string | null;
    committedAfter: string | null;
    remaining: string | null;
    /** Other invoices counted in `committedBefore`. */
    invoices: number;
    uncounted: number;
    /** False for a duplicate or an unconfirmed match: not added to the balance. */
    counted: boolean;
  } | null;
  lineBalances: LineBalance[];
  consumption: Consumption[];
};

export type ReconciliationResult = {
  version: number;
  matchId: string;
  status: ReconciliationStatus;
  /** Whether the invoice's allocations count against its sources' balances. */
  consumes: boolean;
  message: string;
  currency: string | null;
  documentType: string;
  sources: ReconciledSource[];
  discrepancies: ReconciliationFinding<DiscrepancyCode>[];
  unresolved: ReconciliationFinding<UnresolvedCode>[];
  tolerances: typeof RECONCILIATION_TOLERANCE_SUMMARY;
};

// --- Reading the invoice ----------------------------------------------------------------

type InvoiceLine = {
  description: string | null;
  quantity: number | null;
  unitPrice: number | null;
  taxRate: number | null;
  taxAmount: number | null;
  total: number | null;
};

const invoiceOf = (extraction: unknown, validation: unknown) => {
  const record = asRecord(extraction);
  const checked = asRecord(validation);
  const documentType =
    text(checked.documentType) ?? text(record.documentType) ?? "invoice";
  const sign = documentType === "credit_note" ? -1n : 1n;
  const totals = asRecord(checked.totals);
  const total = (key: "net" | "tax" | "gross", fallback: unknown) => {
    const stored = finite(asRecord(totals[key]).amount);
    if (stored !== null) return minorOfNumber(stored);
    const printed = finite(fallback);
    return printed === null ? null : sign * abs(minorOfNumber(printed));
  };
  const lines: InvoiceLine[] = (
    Array.isArray(record.lineItems) ? record.lineItems : []
  ).map((item) => {
    const row = asRecord(item);
    return {
      description: text(row.description),
      quantity: finite(row.quantity),
      unitPrice: finite(row.unitPrice),
      taxRate: finite(row.taxRate),
      taxAmount: finite(row.taxAmount),
      total: finite(row.total),
    };
  });
  const net = total("net", record.netAmount);
  const tax = total("tax", record.vatAmount);
  const gross = total("gross", record.grossAmount);
  const taxBasis =
    text(checked.taxBasis) ??
    (record.amountsIncludeTax === true
      ? "inclusive"
      : record.amountsIncludeTax === false
        ? "exclusive"
        : "unknown");
  return {
    documentType,
    sign,
    currency: text(checked.currency) ?? text(record.currency),
    net,
    tax,
    gross,
    /** No tax at all: net and gross are the same amount. */
    taxFree: taxBasis === "no_tax" || tax === 0n,
    taxBasis,
    taxRate: finite(record.taxRate),
    lines,
    duplicateOf: text(asRecord(checked.identity).duplicateOf),
  };
};

type Invoice = ReturnType<typeof invoiceOf>;

/** The basis a source's amounts are stated in; null when it cannot be told. */
const basisOf = (
  taxBasis: string | null,
  invoice: Invoice,
): "net" | "gross" | null => {
  if (taxBasis === "exclusive" || taxBasis === "not_applicable") return "net";
  if (taxBasis === "inclusive") return "gross";
  return invoice.taxFree ? "net" : null;
};

/** A line's tax in minor units (signed), when printed or derivable. */
const lineTax = (invoice: Invoice, line: InvoiceLine): bigint | null => {
  if (line.taxAmount !== null) {
    return invoice.sign * abs(minorOfNumber(line.taxAmount));
  }
  if (invoice.taxFree) return 0n;
  const rate = line.taxRate ?? invoice.taxRate;
  if (rate === null || line.total === null) return null;
  const total = invoice.sign * abs(minorOfNumber(line.total));
  const rateUnits = unitsOfNumber(rate);
  const hundred = 100n * UNIT;
  if (invoice.taxBasis === "exclusive") {
    return divideRounded(total * rateUnits, hundred);
  }
  if (invoice.taxBasis === "inclusive") {
    return total - divideRounded(total * hundred, hundred + rateUnits);
  }
  return null;
};

/** The basis an invoice's line totals and unit prices are printed in. */
const lineBasisOf = (invoice: Invoice): "net" | "gross" | null =>
  invoice.taxFree
    ? null
    : invoice.taxBasis === "exclusive"
      ? "net"
      : invoice.taxBasis === "inclusive"
        ? "gross"
        : null;

type Amount = { minor: bigint; tax: bigint | null } | { missing: string };

/**
 * An allocation's amount in the basis the source states its amounts in, with
 * the tax it carries when known. Whole-invoice allocations read the
 * invoice's totals; line allocations read the line total in the invoice's
 * tax basis and add or remove the line's tax; a person's stated amount is
 * taken as given, in the source's basis.
 */
const amountIn = (
  invoice: Invoice,
  allocation: SourceAllocation,
  basis: "net" | "gross",
): Amount => {
  if (allocation.basis === "manual" && allocation.amount !== null) {
    const stated = parseSignedDecimal(allocation.amount, 2);
    if (stated === null)
      return { missing: "the stated amount is not a number" };
    const line =
      allocation.invoiceLineIndex === null
        ? null
        : invoice.lines[allocation.invoiceLineIndex];
    return { minor: stated, tax: line ? lineTax(invoice, line) : null };
  }
  if (allocation.invoiceLineIndex === null) {
    const minor = basis === "net" ? invoice.net : invoice.gross;
    if (minor === null) {
      return {
        missing: `the invoice has no ${basis === "net" ? "net" : "gross"} total`,
      };
    }
    return { minor, tax: invoice.tax };
  }
  const line = invoice.lines[allocation.invoiceLineIndex];
  if (!line || line.total === null) {
    return { missing: "the line has no total" };
  }
  const total = invoice.sign * abs(minorOfNumber(line.total));
  const tax = lineTax(invoice, line);
  if (invoice.taxFree) return { minor: total, tax: 0n };
  const lineBasis =
    invoice.taxBasis === "exclusive"
      ? "net"
      : invoice.taxBasis === "inclusive"
        ? "gross"
        : null;
  if (lineBasis === null) {
    return {
      missing: "the invoice does not say whether its line totals include tax",
    };
  }
  if (lineBasis === basis) return { minor: total, tax };
  if (tax === null) {
    return {
      missing: `the line's tax is not shown, so its ${basis === "net" ? "net" : "gross"} amount cannot be worked out`,
    };
  }
  return { minor: basis === "net" ? total - tax : total + tax, tax };
};

// --- Comparisons ---------------------------------------------------------------------

const notCompared = (
  note: string,
  invoiced: string | null = null,
  authorized: string | null = null,
): Comparison => ({
  invoiced,
  authorized,
  variance: null,
  tolerance: null,
  outcome: "not_compared",
  note,
});

const compare = (
  invoiced: bigint,
  authorized: bigint,
  tolerance: bigint,
  format: (value: bigint) => string,
): Comparison => {
  const variance = invoiced - authorized;
  return {
    invoiced: format(invoiced),
    authorized: format(authorized),
    variance: format(variance),
    tolerance: format(tolerance),
    outcome:
      variance > tolerance
        ? "above"
        : variance < -tolerance
          ? "below"
          : "within",
  };
};

const pairedLine = (
  lines: readonly AuthorizationLine[],
  reference: string | null,
) =>
  reference === null
    ? null
    : (lines.find((line) => line.reference === reference) ?? null);

const TYPE_LABEL: Record<string, string> = {
  purchase_order: "Purchase order",
  job: "Job",
  contract: "Contract",
};

const labelOf = (source: { type: string; reference: string }) =>
  `${TYPE_LABEL[source.type] ?? "Source"} ${source.reference}`;

const lineLabel = (index: number | null) =>
  index === null ? "The invoice" : `Invoice line ${index + 1}`;

// --- Reconciliation --------------------------------------------------------------------

/**
 * The invoice lines a person or TypeSafe should read against a source's
 * written scope: lines allocated to a source that pair with none of its
 * authorized lines, when the source has lines or a scope to compare with.
 */
export function scopeQuestionsFor(input: {
  extraction: unknown;
  match: Pick<ReconciliationMatch, "allocations">;
  sources: readonly Pick<ReconciliationSource, "sourceId" | "cited">[];
}) {
  const record = asRecord(input.extraction);
  const lines = Array.isArray(record.lineItems) ? record.lineItems : [];
  return input.match.allocations
    .filter(
      (allocation) =>
        allocation.invoiceLineIndex !== null &&
        allocation.sourceLineReference === null,
    )
    .flatMap((allocation) => {
      const source = input.sources.find(
        (candidate) => candidate.sourceId === allocation.sourceId,
      );
      if (!source) return [];
      const { cited } = source;
      if (cited.lines.length === 0 && !cited.scope) return [];
      const line = asRecord(lines[allocation.invoiceLineIndex!]);
      return [
        {
          key: scopeKey(allocation.sourceId, allocation.invoiceLineIndex!),
          sourceId: allocation.sourceId,
          invoiceLineIndex: allocation.invoiceLineIndex!,
          description: text(line.description),
          quantity: finite(line.quantity),
          unitPrice: finite(line.unitPrice),
          total: finite(line.total),
        },
      ];
    })
    .slice(0, RECONCILIATION_LIMITS.scopeLines);
}

/**
 * Reconciles one invoice with its current match. `sources` carries, for each
 * linked source, the version the match compared, the version in effect now
 * and what the source's other invoices consume; the same inputs always give
 * the same result.
 */
export function reconcileInvoice(input: ReconcileInput): ReconciliationResult {
  const invoice = invoiceOf(input.extraction, input.validation);
  const { match } = input;
  const discrepancies: ReconciliationFinding<DiscrepancyCode>[] = [];
  const unresolved: ReconciliationFinding<UnresolvedCode>[] = [];
  const base = {
    version: RECONCILIATION_VERSION,
    matchId: match.id,
    currency: invoice.currency,
    documentType: invoice.documentType,
    tolerances: RECONCILIATION_TOLERANCE_SUMMARY,
  };
  const finding = <Code extends string>(
    code: Code,
    message: string,
    at: Partial<Omit<ReconciliationFinding<Code>, "code" | "message">> = {},
  ): ReconciliationFinding<Code> => ({
    code,
    sourceId: at.sourceId ?? null,
    reference: at.reference ?? null,
    invoiceLineIndex: at.invoiceLineIndex ?? null,
    sourceLineReference: at.sourceLineReference ?? null,
    message,
    evidence: at.evidence ?? {},
  });

  if (match.status === "unmatched") {
    return {
      ...base,
      status: "unmatched",
      consumes: false,
      message: "The invoice is not matched to any authorization source.",
      sources: [],
      discrepancies,
      unresolved,
    };
  }
  if (
    match.status === "ambiguous" ||
    match.status === "insufficient_evidence"
  ) {
    unresolved.push(
      finding(
        match.status === "ambiguous"
          ? "match_ambiguous"
          : "match_insufficient_evidence",
        match.status === "ambiguous"
          ? "More than one source could be the one this invoice bills; choose it before the invoice can be reconciled."
          : "The invoice could not be linked to a source with confidence; link it before it can be reconciled.",
      ),
    );
    return {
      ...base,
      status: "unresolved",
      consumes: false,
      message: unresolved[0]!.message,
      sources: [],
      discrepancies,
      unresolved,
    };
  }

  const confirmed = !match.needsConfirmation;
  if (!confirmed) {
    unresolved.push(
      finding(
        "match_needs_confirmation",
        "The match is a proposal; it is not counted against the source until an owner or admin confirms it.",
      ),
    );
  }
  if (match.unallocatedLines.length > 0) {
    unresolved.push(
      finding(
        "allocation_incomplete",
        `Invoice line${match.unallocatedLines.length === 1 ? "" : "s"} ${match.unallocatedLines
          .map((index) => index + 1)
          .join(
            ", ",
          )} ${match.unallocatedLines.length === 1 ? "is" : "are"} not allocated to any source; say which source ${match.unallocatedLines.length === 1 ? "it bills" : "they bill"}.`,
        {
          evidence: {
            invoice: { unallocatedLines: match.unallocatedLines.length },
          },
        },
      ),
    );
  }
  const duplicate = invoice.duplicateOf !== null;
  if (duplicate) {
    unresolved.push(
      finding(
        "duplicate_invoice",
        "This document repeats an earlier invoice's number; it is not counted against the source a second time. Correct the original invoice, or dismiss this copy.",
        { evidence: { invoice: { duplicateOf: invoice.duplicateOf } } },
      ),
    );
  }
  const counted = confirmed && !duplicate;

  const sources: ReconciledSource[] = [];
  for (const link of match.links) {
    const source = input.sources.find(
      (candidate) => candidate.sourceId === link.sourceId,
    );
    if (!source) continue;
    const label = labelOf(source);
    const at = { sourceId: source.sourceId, reference: source.reference };
    const { cited, current } = source;
    const allocations = match.allocations.filter(
      (allocation) => allocation.sourceId === source.sourceId,
    );
    const reconciled: ReconciledSource = {
      sourceId: source.sourceId,
      type: source.type,
      reference: source.reference,
      citedVersion: cited.version,
      citedVersionId: cited.versionId,
      currentVersion: current.version,
      currentVersionId: current.versionId,
      currentStatus: current.status,
      currency: cited.currency,
      basis: null,
      lines: [],
      total: notCompared("Not compared."),
      balance: null,
      lineBalances: [],
      consumption: [],
    };
    sources.push(reconciled);
    const uncounted = (reason: string) => {
      // What cannot be measured is still recorded, so the source's ledger
      // lists the invoice as not counted rather than silently dropping it.
      reconciled.consumption = allocations.map((allocation) => ({
        sourceLineReference: allocation.sourceLineReference,
        amount: null,
        quantity: null,
        currency: invoice.currency,
        basis: basisOf(current.taxBasis, invoice) ?? "net",
      }));
      reconciled.total = notCompared(reason);
    };

    // Currencies: never compared across, never assumed.
    if (!invoice.currency || !cited.currency || !current.currency) {
      unresolved.push(
        finding(
          "currency_missing",
          !invoice.currency
            ? "The invoice's currency is not known, so its amounts are not compared."
            : `${label} does not state its currency, so amounts are not compared with it.`,
          {
            ...at,
            evidence: {
              invoice: { currency: invoice.currency },
              source: { currency: cited.currency ?? current.currency },
            },
          },
        ),
      );
      uncounted("A currency is missing.");
      continue;
    }
    if (
      invoice.currency !== cited.currency ||
      invoice.currency !== current.currency
    ) {
      const other =
        invoice.currency !== cited.currency ? cited.currency : current.currency;
      unresolved.push(
        finding(
          "currency_mismatch",
          `The invoice is in ${invoice.currency} and ${label} authorizes ${other}; amounts in different currencies are not compared without approved conversion data.`,
          {
            ...at,
            evidence: {
              invoice: { currency: invoice.currency },
              source: { currency: other },
            },
          },
        ),
      );
      uncounted("Different currencies.");
      continue;
    }

    const basis = basisOf(cited.taxBasis, invoice);
    const currentBasis = basisOf(current.taxBasis, invoice);
    if (basis === null || currentBasis === null) {
      unresolved.push(
        finding(
          "tax_basis_unknown",
          `${label} does not say whether its amounts include tax, and the invoice charges tax, so the amounts cannot be compared.`,
          {
            ...at,
            evidence: {
              invoice: {
                tax: invoice.tax === null ? null : money(invoice.tax),
              },
              source: { taxBasis: cited.taxBasis },
            },
          },
        ),
      );
      uncounted("The tax basis is not known.");
      continue;
    }
    reconciled.basis = basis;
    const basisWord = basis === "net" ? "excluding tax" : "including tax";

    // Period and status of the terms billed.
    if (
      match.invoiceDate &&
      ((cited.startsOn && match.invoiceDate.value < cited.startsOn) ||
        (cited.endsOn && match.invoiceDate.value > cited.endsOn))
    ) {
      discrepancies.push(
        finding(
          "outside_period",
          `The invoice is dated ${match.invoiceDate.value}, outside ${label}'s period (${cited.startsOn ?? "…"} to ${cited.endsOn ?? "…"}).`,
          {
            ...at,
            evidence: {
              invoice: { date: match.invoiceDate.value },
              source: { startsOn: cited.startsOn, endsOn: cited.endsOn },
            },
          },
        ),
      );
    }

    // Line by line against the cited version.
    let sumMinor = 0n;
    let missing: string | null = null;
    let currentSum = 0n;
    let currentMissing: string | null = null;
    const consumption: Consumption[] = [];
    for (const allocation of allocations) {
      const amount = amountIn(invoice, allocation, basis);
      const currentAmount =
        currentBasis === basis
          ? amount
          : amountIn(invoice, allocation, currentBasis);
      const line =
        allocation.invoiceLineIndex === null
          ? null
          : (invoice.lines[allocation.invoiceLineIndex] ?? null);
      const authorized = pairedLine(
        cited.lines,
        allocation.sourceLineReference,
      );
      const quantity =
        line?.quantity == null
          ? null
          : invoice.sign * abs(unitsOfNumber(line.quantity));

      if ("missing" in amount) {
        missing ??= `${lineLabel(allocation.invoiceLineIndex)}: ${amount.missing}.`;
      } else {
        sumMinor += amount.minor;
      }
      if ("missing" in currentAmount) {
        currentMissing ??= `${lineLabel(allocation.invoiceLineIndex)}: ${currentAmount.missing}.`;
      } else {
        currentSum += currentAmount.minor;
      }
      consumption.push({
        sourceLineReference: allocation.sourceLineReference,
        amount: "missing" in currentAmount ? null : money(currentAmount.minor),
        quantity:
          allocation.sourceLineReference !== null && quantity !== null
            ? units(quantity)
            : null,
        currency: invoice.currency,
        basis: currentBasis,
      });

      const variance: LineVariance = {
        invoiceLineIndex: allocation.invoiceLineIndex,
        description: line?.description ?? null,
        sourceLineReference: allocation.sourceLineReference,
        authorizedDescription: authorized?.description ?? null,
        quantity: notCompared("No authorized line to compare with."),
        rate: notCompared("No authorized line to compare with."),
        amount:
          "missing" in amount
            ? notCompared(`Not known: ${amount.missing}.`)
            : notCompared(
                "No authorized line to compare with.",
                money(amount.minor),
              ),
        tax: notCompared(
          cited.taxBasis === "not_applicable"
            ? "The tax could not be determined."
            : `${label} states amounts ${basisWord} and no tax rate, so tax is not compared.`,
          "missing" in amount || amount.tax === null ? null : money(amount.tax),
        ),
        scope: {
          status: "paired",
          probability: null,
          message: authorized
            ? `Billed against authorized line ${authorized.reference}.`
            : "Billed against the invoice as a whole.",
        },
      };

      if (authorized) {
        // Quantity: this invoice's share of the authorized quantity.
        const authorizedQuantity = parseSignedDecimal(
          authorized.quantity,
          UNIT_SCALE,
        );
        variance.quantity =
          quantity === null || authorizedQuantity === null
            ? notCompared(
                quantity === null
                  ? "The invoice line shows no quantity."
                  : "The authorized line states no quantity.",
                quantity === null ? null : units(quantity),
                authorizedQuantity === null ? null : units(authorizedQuantity),
              )
            : compare(
                quantity,
                authorizedQuantity,
                BigInt(RECONCILIATION_TOLERANCES.quantityUnits),
                units,
              );
        // Rate: the unit price charged against the one authorized.
        const authorizedRate = parseSignedDecimal(
          authorized.unitPrice,
          UNIT_SCALE,
        );
        const rate =
          line?.unitPrice == null ? null : abs(unitsOfNumber(line.unitPrice));
        variance.rate =
          rate === null || authorizedRate === null
            ? notCompared(
                rate === null
                  ? "The invoice line shows no unit price."
                  : "The authorized line states no unit price.",
                rate === null ? null : units(rate),
                authorizedRate === null ? null : units(authorizedRate),
              )
            : !invoice.taxFree && lineBasisOf(invoice) !== basis
              ? notCompared(
                  `The invoice's unit prices are stated ${lineBasisOf(invoice) === "gross" ? "including" : lineBasisOf(invoice) === "net" ? "excluding" : "without saying whether they include"} tax, and ${label}'s are ${basisWord}.`,
                  units(rate),
                  units(authorizedRate),
                )
              : compare(
                  rate,
                  authorizedRate,
                  BigInt(RECONCILIATION_TOLERANCES.rateUnits),
                  units,
                );
        if (variance.rate.outcome === "above") {
          discrepancies.push(
            finding(
              "rate_above_authorized",
              `${lineLabel(allocation.invoiceLineIndex)} charges ${variance.rate.invoiced} a unit; ${label} line ${authorized.reference} authorizes ${variance.rate.authorized}.`,
              {
                ...at,
                invoiceLineIndex: allocation.invoiceLineIndex,
                sourceLineReference: authorized.reference,
                evidence: {
                  invoice: {
                    description: line?.description ?? null,
                    unitPrice: variance.rate.invoiced,
                  },
                  source: {
                    description: authorized.description,
                    unitPrice: variance.rate.authorized,
                  },
                },
              },
            ),
          );
        }
        // Amount: this invoice's share of the authorized line amount.
        const authorizedAmount = parseSignedDecimal(authorized.amount, 2);
        if (!("missing" in amount) && authorizedAmount !== null) {
          variance.amount = compare(
            amount.minor,
            authorizedAmount,
            BigInt(RECONCILIATION_TOLERANCES.amountMinor(1)),
            money,
          );
        }
      } else if (allocation.invoiceLineIndex !== null) {
        const judged =
          input.scope[scopeKey(source.sourceId, allocation.invoiceLineIndex)];
        const itemized = cited.lines.length > 0;
        if (!itemized && !cited.scope) {
          variance.scope = {
            status: "not_judged",
            probability: null,
            message: `${label} records no lines or written scope; the line counts against its total.`,
          };
        } else if (
          judged?.status === "answered" &&
          judged.answer !== "unclear" &&
          judged.probability >= RECONCILIATION_LIMITS.scopeProbability
        ) {
          variance.scope = {
            status: judged.answer,
            probability: judged.probability,
            message:
              judged.answer === "within_scope"
                ? `Not an authorized line, but TypeSafe reads it as within ${label}'s scope (${Math.round(judged.probability * 100)}%). It counts against the total.`
                : `TypeSafe reads it as outside ${label}'s scope (${Math.round(judged.probability * 100)}%).`,
          };
          if (judged.answer === "outside_scope") {
            discrepancies.push(
              finding(
                "outside_scope",
                `${lineLabel(allocation.invoiceLineIndex)} (${line?.description ?? "no description"}) is not an authorized line of ${label} and reads as outside its scope.`,
                {
                  ...at,
                  invoiceLineIndex: allocation.invoiceLineIndex,
                  evidence: {
                    invoice: { description: line?.description ?? null },
                    source: {
                      scope: cited.scope,
                      lines: cited.lines.length,
                      probability: judged.probability,
                    },
                  },
                },
              ),
            );
          }
        } else {
          variance.scope = {
            status: judged ? "unclear" : "not_judged",
            probability:
              judged?.status === "answered" ? judged.probability : null,
            message:
              judged?.status === "failed"
                ? `Whether it is within ${label}'s scope could not be judged (${judged.reason}).`
                : judged
                  ? `Whether it is within ${label}'s scope is unclear.`
                  : `Whether it is within ${label}'s scope was not judged.`,
          };
          unresolved.push(
            finding(
              "scope_unclear",
              `${lineLabel(allocation.invoiceLineIndex)} (${line?.description ?? "no description"}) pairs with no authorized line of ${label}, and whether it is within the source's scope is not clear. Link it to an authorized line, or release the invoice after checking it.`,
              {
                ...at,
                invoiceLineIndex: allocation.invoiceLineIndex,
                evidence: {
                  invoice: { description: line?.description ?? null },
                  source: { scope: cited.scope, lines: cited.lines.length },
                },
              },
            ),
          );
        }
      }

      // Tax: a source that authorizes none is charged none.
      if (cited.taxBasis === "not_applicable") {
        const tax = "missing" in amount ? null : amount.tax;
        variance.tax =
          tax === null
            ? notCompared("The tax on this part of the invoice is not shown.")
            : compare(
                tax,
                0n,
                BigInt(RECONCILIATION_TOLERANCES.taxMinor),
                money,
              );
        if (variance.tax.outcome === "above") {
          discrepancies.push(
            finding(
              "tax_not_authorized",
              `${lineLabel(allocation.invoiceLineIndex)} charges ${display(invoice.currency, tax!)} tax; ${label} authorizes amounts without tax.`,
              {
                ...at,
                invoiceLineIndex: allocation.invoiceLineIndex,
                evidence: {
                  invoice: { tax: money(tax!) },
                  source: { taxBasis: "not_applicable" },
                },
              },
            ),
          );
        }
      }
      reconciled.lines.push(variance);
    }
    reconciled.consumption = consumption;

    if (missing) {
      unresolved.push(
        finding(
          "amount_missing",
          `${missing} It is not compared with ${label}.`,
          at,
        ),
      );
    }

    // The invoice against the whole of the cited terms.
    const authorizedTotal = parseSignedDecimal(cited.authorizedTotal, 2) ?? 0n;
    const tolerance = BigInt(
      RECONCILIATION_TOLERANCES.amountMinor(allocations.length),
    );
    reconciled.total = missing
      ? notCompared(missing, null, money(authorizedTotal))
      : compare(sumMinor, authorizedTotal, tolerance, money);

    // The remaining balance: the terms in effect now, less what the
    // source's other invoices consume, less this invoice.
    const authorizedNow = parseSignedDecimal(current.authorizedTotal, 2) ?? 0n;
    const before = parseSignedDecimal(source.prior.amount, 2) ?? 0n;
    const invoiced = currentMissing ? null : currentSum;
    const after =
      invoiced === null ? null : counted ? before + invoiced : before;
    reconciled.balance = {
      authorized: money(authorizedNow),
      committedBefore: money(before),
      invoiced: invoiced === null ? null : money(invoiced),
      committedAfter: after === null ? null : money(after),
      remaining: after === null ? null : money(authorizedNow - after),
      invoices: source.prior.invoices,
      uncounted: source.prior.uncounted,
      counted,
    };
    if (source.prior.uncounted > 0) {
      unresolved.push(
        finding(
          "prior_uncounted",
          `${source.prior.uncounted} other invoice${source.prior.uncounted === 1 ? "" : "s"} matched to ${label} could not be counted, so its remaining balance is not certain.`,
          {
            ...at,
            evidence: { source: { uncounted: source.prior.uncounted } },
          },
        ),
      );
    }

    if (counted && invoiced !== null && after !== null) {
      const over = after - authorizedNow;
      if (invoiced > 0n && over > tolerance) {
        discrepancies.push(
          finding(
            "over_authorized_total",
            `${label} authorizes ${display(invoice.currency, authorizedNow)} ${basisWord} (version ${current.version}); ${display(invoice.currency, before)} was already invoiced against it and this invoice adds ${display(invoice.currency, invoiced)}, ${display(invoice.currency, over)} over the authorized total.`,
            {
              ...at,
              evidence: {
                invoice: { amount: money(invoiced) },
                source: {
                  authorized: money(authorizedNow),
                  committedBefore: money(before),
                  remainingBefore: money(authorizedNow - before),
                  version: current.version,
                },
              },
            },
          ),
        );
      }
      if (invoiced < 0n && after < -tolerance) {
        discrepancies.push(
          finding(
            "credit_exceeds_invoiced",
            `This credit of ${display(invoice.currency, -invoiced)} is more than the ${display(invoice.currency, before)} invoiced against ${label}.`,
            {
              ...at,
              evidence: {
                invoice: { amount: money(invoiced) },
                source: { committedBefore: money(before) },
              },
            },
          ),
        );
      }
      if (invoiced > 0n && current.status !== "open") {
        discrepancies.push(
          finding(
            current.status === "cancelled"
              ? "source_cancelled"
              : "source_closed",
            `${label} is ${current.status} (version ${current.version}); nothing more should be billed against it.`,
            {
              ...at,
              evidence: {
                source: { status: current.status, version: current.version },
              },
            },
          ),
        );
      }
    }

    // Line balances against the terms in effect now.
    for (const authorized of current.lines) {
      if (authorized.reference === null) continue;
      const reference = authorized.reference;
      const prior = source.prior.lines.find(
        (line) => line.reference === reference,
      );
      const mine = consumption.filter(
        (item) => item.sourceLineReference === reference,
      );
      const authorizedAmount = parseSignedDecimal(authorized.amount, 2) ?? 0n;
      const authorizedQuantity = parseSignedDecimal(
        authorized.quantity,
        UNIT_SCALE,
      );
      const beforeAmount = parseSignedDecimal(prior?.amount ?? "0", 2) ?? 0n;
      const beforeQuantity = prior
        ? parseSignedDecimal(prior.quantity, UNIT_SCALE)
        : 0n;
      const mineAmount = mine.some((item) => item.amount === null)
        ? null
        : mine.reduce(
            (sum, item) => sum + (parseSignedDecimal(item.amount, 2) ?? 0n),
            0n,
          );
      const quantities = mine.map((item) =>
        parseSignedDecimal(item.quantity, UNIT_SCALE),
      );
      const mineQuantity =
        mine.length === 0
          ? 0n
          : quantities.some((value) => value === null)
            ? null
            : quantities.reduce((sum: bigint, value) => sum + value!, 0n);
      const afterAmount =
        mineAmount === null
          ? null
          : counted
            ? beforeAmount + mineAmount
            : beforeAmount;
      const afterQuantity =
        mineQuantity === null ||
        authorizedQuantity === null ||
        beforeQuantity === null
          ? null
          : beforeQuantity + (counted ? mineQuantity : 0n);
      reconciled.lineBalances.push({
        reference,
        description: authorized.description,
        authorizedQuantity:
          authorizedQuantity === null ? null : units(authorizedQuantity),
        authorizedAmount: money(authorizedAmount),
        committedQuantityBefore:
          beforeQuantity === null ? null : units(beforeQuantity),
        committedAmountBefore: money(beforeAmount),
        invoicedQuantity: mineQuantity === null ? null : units(mineQuantity),
        invoicedAmount: mineAmount === null ? null : money(mineAmount),
        remainingQuantity:
          afterQuantity === null || authorizedQuantity === null
            ? null
            : units(authorizedQuantity - afterQuantity),
        remainingAmount:
          afterAmount === null ? null : money(authorizedAmount - afterAmount),
      });
      if (!counted || mine.length === 0) continue;
      const lineTolerance = BigInt(
        RECONCILIATION_TOLERANCES.amountMinor(mine.length),
      );
      if (
        mineAmount !== null &&
        mineAmount > 0n &&
        afterAmount !== null &&
        afterAmount - authorizedAmount > lineTolerance
      ) {
        discrepancies.push(
          finding(
            "line_amount_over_authorized",
            `${label} line ${reference} (${authorized.description}) authorizes ${display(invoice.currency, authorizedAmount)}; ${display(invoice.currency, beforeAmount)} was already invoiced and this invoice adds ${display(invoice.currency, mineAmount)}, ${display(invoice.currency, afterAmount - authorizedAmount)} over.`,
            {
              ...at,
              sourceLineReference: reference,
              evidence: {
                invoice: { amount: money(mineAmount) },
                source: {
                  authorized: money(authorizedAmount),
                  committedBefore: money(beforeAmount),
                },
              },
            },
          ),
        );
      }
      if (
        mineQuantity !== null &&
        mineQuantity > 0n &&
        beforeQuantity !== null &&
        afterQuantity !== null &&
        authorizedQuantity !== null &&
        afterQuantity - authorizedQuantity >
          BigInt(RECONCILIATION_TOLERANCES.quantityUnits)
      ) {
        discrepancies.push(
          finding(
            "quantity_over_authorized",
            `${label} line ${reference} (${authorized.description}) authorizes a quantity of ${units(authorizedQuantity)}; ${units(beforeQuantity)} was already invoiced and this invoice adds ${units(mineQuantity)}.`,
            {
              ...at,
              sourceLineReference: reference,
              evidence: {
                invoice: { quantity: units(mineQuantity) },
                source: {
                  authorizedQuantity: units(authorizedQuantity),
                  committedQuantityBefore: units(beforeQuantity),
                },
              },
            },
          ),
        );
      }
    }
    // A line billed against an authorized line the terms in effect now no
    // longer carry (an amendment removed it).
    for (const item of consumption) {
      if (
        counted &&
        item.sourceLineReference !== null &&
        !current.lines.some(
          (line) => line.reference === item.sourceLineReference,
        ) &&
        item.amount !== null &&
        (parseSignedDecimal(item.amount, 2) ?? 0n) > 0n
      ) {
        discrepancies.push(
          finding(
            "line_not_authorized",
            `${label} version ${current.version} no longer authorizes line ${item.sourceLineReference}, which this invoice bills.`,
            {
              ...at,
              sourceLineReference: item.sourceLineReference,
              evidence: {
                invoice: { amount: item.amount },
                source: { version: current.version },
              },
            },
          ),
        );
      }
    }
  }

  const status: ReconciliationStatus =
    discrepancies.length > 0
      ? "discrepancy"
      : unresolved.length > 0
        ? "unresolved"
        : "reconciled";
  const references = sources.map(labelOf).join(", ");
  const message =
    status === "reconciled"
      ? `Within the authorized terms of ${references}.`
      : status === "discrepancy"
        ? `${discrepancies.length} discrepanc${discrepancies.length === 1 ? "y" : "ies"} with ${references}: ${discrepancies[0]!.message}`
        : unresolved[0]!.message;
  return {
    ...base,
    status,
    consumes: confirmed,
    message,
    sources,
    discrepancies,
    unresolved,
  };
}

/** A result's identity: an unchanged reconciliation is not recorded twice. */
export const reconciliationFingerprint = (result: ReconciliationResult) =>
  JSON.stringify([
    result.matchId,
    result.status,
    result.consumes,
    result.sources.map((source) => [
      source.sourceId,
      source.citedVersionId,
      source.currentVersionId,
      source.balance,
      source.consumption,
    ]),
    result.discrepancies.map((item) => [item.code, item.message]),
    result.unresolved.map((item) => [item.code, item.message]),
  ]);

/** What the delivery rules read of a reconciliation. */
export type ReconciliationForPolicy = {
  status: ReconciliationStatus;
  discrepancies: readonly { code: string; message: string }[];
  unresolved: readonly { code: string; message: string }[];
};

// --- The source's ledger -----------------------------------------------------------------

/** One stored consumption row of an invoice currently counted against a source. */
export type ConsumptionRow = {
  inboxId: string;
  sourceLineReference: string | null;
  amount: string | null;
  quantity: string | null;
  currency: string | null;
  basis: string;
};

export type LedgerInvoice = {
  inboxId: string;
  /** What the invoice consumes, signed; null when it is not counted. */
  amount: string | null;
  counted: boolean;
  reason: string | null;
};

/** The basis a source's balance is kept in. */
export const sourceBasisOf = (taxBasis: string | null): "net" | "gross" =>
  taxBasis === "inclusive" ? "gross" : "net";

/**
 * Sums the consumption of the invoices currently counted against a source,
 * exactly. An invoice is counted only when every part of it is in the
 * source's currency and basis and has an amount; any other is listed as not
 * counted, with why, rather than being converted or dropped.
 */
export function summarizeConsumption(
  rows: readonly ConsumptionRow[],
  terms: { currency: string | null; basis: "net" | "gross" },
): PriorConsumption & { perInvoice: LedgerInvoice[] } {
  const byInvoice = new Map<string, ConsumptionRow[]>();
  for (const row of rows) {
    byInvoice.set(row.inboxId, [...(byInvoice.get(row.inboxId) ?? []), row]);
  }
  let total = 0n;
  const lines = new Map<string, { amount: bigint; quantity: bigint | null }>();
  const perInvoice: LedgerInvoice[] = [];
  for (const [inboxId, parts] of byInvoice) {
    const reason = parts.some((part) => part.amount === null)
      ? "Its amount could not be determined."
      : parts.some((part) => part.currency !== terms.currency)
        ? `It is in ${parts.find((part) => part.currency !== terms.currency)?.currency ?? "an unknown currency"}, not ${terms.currency ?? "the source's currency"}.`
        : parts.some((part) => part.basis !== terms.basis)
          ? "It was counted on another tax basis, before an amendment changed the source's."
          : null;
    if (reason) {
      perInvoice.push({ inboxId, amount: null, counted: false, reason });
      continue;
    }
    let sum = 0n;
    for (const part of parts) {
      const amount = parseSignedDecimal(part.amount, 2) ?? 0n;
      sum += amount;
      if (part.sourceLineReference === null) continue;
      const line = lines.get(part.sourceLineReference) ?? {
        amount: 0n,
        quantity: 0n,
      };
      const quantity = parseSignedDecimal(part.quantity, UNIT_SCALE);
      line.amount += amount;
      line.quantity =
        line.quantity === null || quantity === null
          ? null
          : line.quantity + quantity;
      lines.set(part.sourceLineReference, line);
    }
    total += sum;
    perInvoice.push({
      inboxId,
      amount: money(sum),
      counted: true,
      reason: null,
    });
  }
  return {
    amount: money(total),
    invoices: perInvoice.filter((invoice) => invoice.counted).length,
    uncounted: perInvoice.filter((invoice) => !invoice.counted).length,
    lines: [...lines].map(([reference, line]) => ({
      reference,
      amount: money(line.amount),
      quantity: line.quantity === null ? null : units(line.quantity),
    })),
    perInvoice,
  };
}

export type SourceBalance = {
  version: number;
  versionId: string;
  status: string;
  currency: string | null;
  basis: "net" | "gross";
  authorized: string;
  committed: string;
  remaining: string;
  invoices: number;
  uncounted: number;
  /** Committed beyond the authorized total (0.00 when within it). */
  over: string;
  lines: {
    reference: string;
    description: string;
    authorizedQuantity: string | null;
    authorizedAmount: string;
    committedQuantity: string | null;
    committedAmount: string;
    remainingQuantity: string | null;
    remainingAmount: string;
  }[];
  perInvoice: LedgerInvoice[];
};

/**
 * A source's balance now: the terms in effect today against every invoice
 * currently counted against it. Nothing is stored; the same rows always give
 * the same balance, so a revision, credit, unlink or amendment moves it
 * exactly once.
 */
export function sourceBalance(input: {
  terms: ReconciliationTerms;
  rows: readonly ConsumptionRow[];
}): SourceBalance {
  const basis = sourceBasisOf(input.terms.taxBasis);
  const ledger = summarizeConsumption(input.rows, {
    currency: input.terms.currency,
    basis,
  });
  const authorized = parseSignedDecimal(input.terms.authorizedTotal, 2) ?? 0n;
  const committed = parseSignedDecimal(ledger.amount, 2) ?? 0n;
  return {
    version: input.terms.version,
    versionId: input.terms.versionId,
    status: input.terms.status,
    currency: input.terms.currency,
    basis,
    authorized: money(authorized),
    committed: money(committed),
    remaining: money(authorized - committed),
    invoices: ledger.invoices,
    uncounted: ledger.uncounted,
    over: money(committed > authorized ? committed - authorized : 0n),
    lines: input.terms.lines
      .filter((line) => line.reference !== null)
      .map((line) => {
        const used = ledger.lines.find(
          (item) => item.reference === line.reference,
        );
        const authorizedAmount = parseSignedDecimal(line.amount, 2) ?? 0n;
        const authorizedQuantity = parseSignedDecimal(
          line.quantity,
          UNIT_SCALE,
        );
        const committedAmount =
          parseSignedDecimal(used?.amount ?? "0", 2) ?? 0n;
        const committedQuantity = used
          ? parseSignedDecimal(used.quantity, UNIT_SCALE)
          : 0n;
        return {
          reference: line.reference!,
          description: line.description,
          authorizedQuantity:
            authorizedQuantity === null ? null : units(authorizedQuantity),
          authorizedAmount: money(authorizedAmount),
          committedQuantity:
            committedQuantity === null ? null : units(committedQuantity),
          committedAmount: money(committedAmount),
          remainingQuantity:
            authorizedQuantity === null || committedQuantity === null
              ? null
              : units(authorizedQuantity - committedQuantity),
          remainingAmount: money(authorizedAmount - committedAmount),
        };
      }),
    perInvoice: ledger.perInvoice,
  };
}
