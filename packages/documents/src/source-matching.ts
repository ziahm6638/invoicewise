/**
 * Matching an invoice to the authorization sources (jobs, purchase orders,
 * contracts) it bills.
 *
 * Plain code decides. A source whose reference the invoice prints exactly is
 * linked on that evidence alone; TypeSafe is asked only when no exact
 * reference links the invoice, and then only to choose among a bounded set of
 * the workspace's own candidate sources (or none of them). Its answer is one
 * piece of evidence: code applies the thresholds, and a semantic match is a
 * proposal that asks to be confirmed. Nothing here reads another workspace:
 * the caller supplies only the invoice's own workspace's sources.
 *
 * Every candidate carries the evidence it was judged on (reference, supplier,
 * version in effect, status, period, currency, semantic probability), so a
 * decision stays explainable after sources are amended.
 *
 * `docs/authorization-matching.md` publishes these rules.
 */
import {
  type AuthorizationLine,
  type AuthorizationSourceType,
  authorizationReferenceKey,
} from "./authorization-source";
import { companyNumberKey } from "./supplier";
import { supplierKey, toMinor, vatKey } from "./validation";

/** Bumped whenever a rule below changes, so stored results can be told apart. */
export const SOURCE_MATCHING_VERSION = 1;

export const SOURCE_MATCH_LIMITS = {
  /** Distinct references mined from one invoice. */
  references: 40,
  /** Sources recorded for the invoice's supplier that are considered. */
  supplierSources: 20,
  /** Sources offered to the semantic judgment for one invoice. */
  semanticCandidates: 8,
  /** Invoice line items given to the semantic judgment. */
  judgmentLines: 40,
  /** Authorized lines described per candidate in the semantic judgment. */
  candidateLines: 20,
  /** Manual allocations on one match. */
  allocations: 200,
} as const;

/**
 * How TypeSafe's probabilities are read. They are mutually exclusive: a
 * proposal needs at least `propose`, which leaves every rival below `rival`.
 */
export const SOURCE_MATCH_THRESHOLDS = {
  /** Probability one source needs to be proposed as the match. */
  propose: 0.8,
  /** Probability at which a second source keeps the choice open (ambiguous). */
  rival: 0.2,
  /** Probability of "none of these" at which no source is linked. */
  none: 0.5,
} as const;

export type SourceMatchStatus =
  | "matched"
  | "unmatched"
  | "ambiguous"
  | "insufficient_evidence";

export type SourceMatchMethod = "reference" | "semantic" | "manual";

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};

const text = (value: unknown) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

const finite = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

// --- References printed on the invoice -----------------------------------------

export type InvoiceReferenceField =
  | "purchaseOrderReference"
  | "description"
  | "lineItem";

export type InvoiceReference = {
  field: InvoiceReferenceField;
  /** For a line item: its index in `extraction.lineItems`. */
  lineIndex?: number;
  printed: string;
  /** Compared like a source reference: no spacing, punctuation or case. */
  key: string;
  /** The key without its leading letters: `PO-1042` and `Job 1042` share `1042`. */
  numberKey: string | null;
  /**
   * Whether an equal source reference links on this alone. The purchase-order
   * field always does; a token in free text only when it has letters and
   * digits (so a printed amount or date is never read as a reference).
   */
  trusted: boolean;
};

// A token with a digit, optionally led by a short word: "PO-55120",
// "Job 1042", "CT/2026/07", "#4471".
const REFERENCE_TOKEN =
  /\b(?:[A-Za-z]{1,12}[\s#:./-]{0,3})?\d[A-Za-z0-9/.-]*[A-Za-z0-9]/g;

const numberKeyOf = (key: string) => {
  const stripped = key.replace(/^[A-Z]+/, "");
  return stripped.length >= 3 && /\d/.test(stripped) ? stripped : null;
};

// Words that introduce a reference when printed before it with a space:
// "PO 55120", "Job 1042", "Contract CT-7".
const REFERENCE_LABELS = new Set([
  "PO",
  "JOB",
  "ORDER",
  "CONTRACT",
  "WO",
  "CT",
]);

// Printed amounts and dates are numbers, never references.
const NOT_A_REFERENCE =
  /^(?:\d{1,3}(?:,\d{3})*\.\d{2}|\d+\.\d{2}|\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4})$/;

/**
 * A free-text token links exactly only when it reads as one reference: letters
 * and digits printed together ("JOB-1042", "PO55120", "CT/2026/07"), or after
 * a reference word ("PO 55120"). "invoiced 01/09" is not a reference.
 */
const trustedToken = (printed: string, key: string) => {
  if (!/[A-Z]/.test(key) || key.length < 4) return false;
  const words = printed.trim().split(/\s+/);
  if (words.length === 1) return true;
  return REFERENCE_LABELS.has(authorizationReferenceKey(words[0]));
};

const referenceOf = (
  field: InvoiceReferenceField,
  printed: string,
  trustedField: boolean,
  lineIndex?: number,
): InvoiceReference | null => {
  const key = authorizationReferenceKey(printed);
  if (key === "" || !/\d/.test(key)) return null;
  const digits = printed.trim().split(/\s+/).at(-1) ?? "";
  if (!trustedField && NOT_A_REFERENCE.test(digits)) return null;
  const trusted = trustedField || trustedToken(printed, key);
  const numberKey = numberKeyOf(key);
  if (!trusted && !numberKey) return null;
  return {
    field,
    ...(lineIndex === undefined ? {} : { lineIndex }),
    printed: printed.trim(),
    key,
    numberKey,
    trusted,
  };
};

/**
 * Every reference an invoice prints where a source reference could appear:
 * the purchase-order field whole, and reference-shaped tokens in the
 * description and line descriptions. Bounded by `SOURCE_MATCH_LIMITS`.
 */
export function invoiceReferencesOf(extraction: unknown): InvoiceReference[] {
  const record = asRecord(extraction);
  const found: InvoiceReference[] = [];
  const seen = new Set<string>();
  const add = (reference: InvoiceReference | null) => {
    if (!reference || found.length >= SOURCE_MATCH_LIMITS.references) return;
    const id = `${reference.field}:${reference.lineIndex ?? ""}:${reference.key}`;
    if (seen.has(id)) return;
    seen.add(id);
    found.push(reference);
  };
  const tokens = (value: string) => value.match(REFERENCE_TOKEN) ?? [];

  const purchaseOrder = text(record.purchaseOrderReference);
  if (purchaseOrder) {
    add(referenceOf("purchaseOrderReference", purchaseOrder, true));
    // "PO 55120 / Job 1042" names two references in one field.
    for (const token of tokens(purchaseOrder)) {
      add(referenceOf("purchaseOrderReference", token, true));
    }
  }
  const description = text(record.description);
  if (description) {
    for (const token of tokens(description)) {
      add(referenceOf("description", token, false));
    }
  }
  const lines = Array.isArray(record.lineItems) ? record.lineItems : [];
  lines.forEach((line, index) => {
    const value = text(asRecord(line).description);
    if (!value) return;
    for (const token of tokens(value)) {
      add(referenceOf("lineItem", token, false, index));
    }
  });
  return found;
}

/** The keys a candidate lookup needs: exact references and bare numbers. */
export function referenceLookupKeys(references: readonly InvoiceReference[]) {
  return {
    keys: [
      ...new Set(
        references
          .filter((reference) => reference.trusted)
          .map((reference) => reference.key),
      ),
    ],
    numberKeys: [
      ...new Set(
        references
          .map((reference) => reference.numberKey)
          .filter((key): key is string => key !== null),
      ),
    ],
  };
}

/** A source reference's key without its leading letters, as in `InvoiceReference.numberKey`. */
export const sourceNumberKey = (referenceKey: string) =>
  numberKeyOf(referenceKey);

// --- Candidate sources -------------------------------------------------------------

export type MatchSupplierKeys = {
  /** The canonical workspace supplier (after merges), when the source is linked. */
  id: string | null;
  name: string | null;
  nameKey: string;
  vatKey: string;
  companyKey: string;
};

/** One version of a source's terms, as matching reads it. */
export type SourceVersionTerms = {
  id: string;
  version: number;
  status: string;
  title: string | null;
  scope: string | null;
  /** The linked supplier (canonical), or null when the source names an unknown one. */
  linkedSupplier: MatchSupplierKeys | null;
  /** The supplier as the source gave it. */
  suppliedSupplier: Omit<MatchSupplierKeys, "id">;
  currency: string | null;
  taxBasis: string | null;
  issuedOn: string | null;
  startsOn: string | null;
  endsOn: string | null;
  effectiveFrom: string;
  authorizedTotal: string;
  lines: AuthorizationLine[];
};

export type SourceCandidateInput = {
  sourceId: string;
  type: AuthorizationSourceType;
  reference: string;
  referenceKey: string;
  /** The version in effect on the invoice date, or null when none was. */
  effective: SourceVersionTerms | null;
  /** The newest version, compared when none was in effect on the invoice date. */
  current: SourceVersionTerms;
};

export type InvoiceForMatching = {
  extraction: unknown;
  /** The invoice's canonical workspace supplier (after merges), when resolved. */
  supplierId: string | null;
  /** When the invoice was received (`YYYY-MM-DD`), used when it prints no date. */
  receivedOn: string;
};

export type MatchEvidenceKind =
  | "reference"
  | "reference_number"
  | "supplier"
  | "version"
  | "status"
  | "period"
  | "currency"
  | "semantic"
  | "manual";

export type MatchEvidence = {
  kind: MatchEvidenceKind;
  outcome: "supports" | "conflicts" | "unknown" | "neutral";
  message: string;
  field?: InvoiceReferenceField;
  lineIndex?: number;
  printed?: string;
};

export type SourceCandidateRejection =
  | "wrong_supplier"
  | "cancelled"
  | "currency_conflict";

export type SupplierAgreement = "same" | "different" | "name_only" | "unknown";

export type SourceMatchCandidate = {
  sourceId: string;
  type: AuthorizationSourceType;
  reference: string;
  title: string | null;
  versionId: string;
  version: number;
  /** `effective`: in effect on the invoice date; `current`: none was, so the newest. */
  versionBasis: "effective" | "current";
  /** Why it was considered: its reference printed exactly, its number printed, or its supplier. */
  found: "reference" | "reference_number" | "supplier";
  supplier: SupplierAgreement;
  eligible: boolean;
  rejection: SourceCandidateRejection | null;
  /** 1 for an exact reference; TypeSafe's probability for a semantic candidate. */
  confidence: number | null;
  evidence: MatchEvidence[];
};

const supplierAgreement = (
  invoice: InvoiceForMatching,
  version: SourceVersionTerms,
): { agreement: SupplierAgreement; message: string } => {
  const linked = version.linkedSupplier;
  if (invoice.supplierId && linked?.id) {
    return linked.id === invoice.supplierId
      ? {
          agreement: "same",
          message: `Recorded for this invoice's supplier${linked.name ? ` (${linked.name})` : ""}.`,
        }
      : {
          agreement: "different",
          message: `Recorded for another supplier${linked.name ? ` (${linked.name})` : ""}.`,
        };
  }
  const record = asRecord(invoice.extraction);
  const ours = {
    vat: vatKey(record.supplierVatNumber),
    company: companyNumberKey(record.supplierCompanyNumber),
    name: supplierKey(record.supplierName),
  };
  const theirs = {
    vat: linked?.vatKey || version.suppliedSupplier.vatKey,
    company: linked?.companyKey || version.suppliedSupplier.companyKey,
    name: linked?.nameKey || version.suppliedSupplier.nameKey,
  };
  if (ours.vat && theirs.vat) {
    return ours.vat === theirs.vat
      ? {
          agreement: "same",
          message: "The source gives this invoice's VAT number.",
        }
      : {
          agreement: "different",
          message: "The source gives a different supplier VAT number.",
        };
  }
  if (ours.company && theirs.company) {
    return ours.company === theirs.company
      ? {
          agreement: "same",
          message: "The source gives this invoice's company number.",
        }
      : {
          agreement: "different",
          message: "The source gives a different supplier company number.",
        };
  }
  if (ours.name && theirs.name && ours.name === theirs.name) {
    return {
      agreement: "name_only",
      message:
        "The source names a supplier with this invoice's name, but no registration number confirms it.",
    };
  }
  return {
    agreement: "unknown",
    message:
      "The source does not identify its supplier well enough to compare.",
  };
};

const REFERENCE_FIELD_LABEL: Record<InvoiceReferenceField, string> = {
  purchaseOrderReference: "purchase order reference",
  description: "description",
  lineItem: "line item",
};

const SOURCE_TYPE_LABEL: Record<AuthorizationSourceType, string> = {
  job: "Job",
  purchase_order: "Purchase order",
  contract: "Contract",
};

const sourceLabel = (source: {
  type: AuthorizationSourceType;
  reference: string;
}) => `${SOURCE_TYPE_LABEL[source.type]} ${source.reference}`;

/** The invoice date matching compares against, and where it came from. */
export function matchingDateOf(invoice: InvoiceForMatching) {
  const printed = text(asRecord(invoice.extraction).invoiceDate);
  return printed && /^\d{4}-\d{2}-\d{2}$/.test(printed)
    ? { value: printed, basis: "invoice_date" as const }
    : { value: invoice.receivedOn, basis: "received" as const };
}

/** Judges one source against the invoice on everything code can check. */
function assessCandidate(
  invoice: InvoiceForMatching,
  source: SourceCandidateInput,
  references: readonly InvoiceReference[],
  date: ReturnType<typeof matchingDateOf>,
): SourceMatchCandidate {
  const evidence: MatchEvidence[] = [];
  const exact = references.filter(
    (reference) => reference.trusted && reference.key === source.referenceKey,
  );
  const sourceNumber = numberKeyOf(source.referenceKey);
  const numbers = exact.length
    ? []
    : references.filter(
        (reference) =>
          sourceNumber !== null && reference.numberKey === sourceNumber,
      );
  for (const reference of exact) {
    evidence.push({
      kind: "reference",
      outcome: "supports",
      message: `The invoice's ${REFERENCE_FIELD_LABEL[reference.field]} prints "${reference.printed}", this source's reference.`,
      field: reference.field,
      ...(reference.lineIndex === undefined
        ? {}
        : { lineIndex: reference.lineIndex }),
      printed: reference.printed,
    });
  }
  for (const reference of numbers) {
    evidence.push({
      kind: "reference_number",
      outcome: "neutral",
      message: `The invoice's ${REFERENCE_FIELD_LABEL[reference.field]} prints "${reference.printed}", which shares this source's number but not its full reference.`,
      field: reference.field,
      ...(reference.lineIndex === undefined
        ? {}
        : { lineIndex: reference.lineIndex }),
      printed: reference.printed,
    });
  }

  const version = source.effective ?? source.current;
  const versionBasis = source.effective ? "effective" : "current";
  evidence.push(
    source.effective
      ? {
          kind: "version",
          outcome: "supports",
          message: `Version ${version.version} was in effect on ${date.value} (the ${date.basis === "invoice_date" ? "invoice date" : "day the invoice was received"}).`,
        }
      : {
          kind: "version",
          outcome: "conflicts",
          message: `No version was in effect on ${date.value}; compared with version ${version.version}, effective from ${version.effectiveFrom}.`,
        },
  );

  const supplier = supplierAgreement(invoice, version);
  evidence.push({
    kind: "supplier",
    outcome:
      supplier.agreement === "same"
        ? "supports"
        : supplier.agreement === "different"
          ? "conflicts"
          : supplier.agreement === "name_only"
            ? "neutral"
            : "unknown",
    message: supplier.message,
  });

  const cancelled = version.status === "cancelled";
  if (cancelled) {
    evidence.push({
      kind: "status",
      outcome: "conflicts",
      message: `Version ${version.version} is cancelled.`,
    });
  } else if (version.status === "closed") {
    evidence.push({
      kind: "status",
      outcome: "conflicts",
      message: `Version ${version.version} is closed; billing against it needs checking.`,
    });
  } else {
    evidence.push({
      kind: "status",
      outcome: "supports",
      message: "The source is open.",
    });
  }

  if (version.startsOn && date.value < version.startsOn) {
    evidence.push({
      kind: "period",
      outcome: "conflicts",
      message: `${date.value} is before the authorized period starts (${version.startsOn}).`,
    });
  } else if (version.endsOn && date.value > version.endsOn) {
    evidence.push({
      kind: "period",
      outcome: "conflicts",
      message: `${date.value} is after the authorized period ends (${version.endsOn}).`,
    });
  } else if (version.startsOn || version.endsOn) {
    evidence.push({
      kind: "period",
      outcome: "supports",
      message: `${date.value} is within the authorized period.`,
    });
  }

  const invoiceCurrency = text(asRecord(invoice.extraction).currency);
  let currencyConflict = false;
  if (invoiceCurrency && version.currency) {
    currencyConflict = invoiceCurrency !== version.currency;
    evidence.push({
      kind: "currency",
      outcome: currencyConflict ? "conflicts" : "supports",
      message: currencyConflict
        ? `The invoice is in ${invoiceCurrency}; the source authorizes ${version.currency}. Amounts in different currencies are never compared.`
        : `Both are in ${invoiceCurrency}.`,
    });
  } else {
    evidence.push({
      kind: "currency",
      outcome: "unknown",
      message: invoiceCurrency
        ? "The source does not state a currency."
        : "The invoice does not state a currency.",
    });
  }

  const rejection: SourceCandidateRejection | null =
    supplier.agreement === "different"
      ? "wrong_supplier"
      : cancelled
        ? "cancelled"
        : currencyConflict
          ? "currency_conflict"
          : null;
  return {
    sourceId: source.sourceId,
    type: source.type,
    reference: source.reference,
    title: version.title,
    versionId: version.id,
    version: version.version,
    versionBasis,
    found: exact.length
      ? "reference"
      : numbers.length
        ? "reference_number"
        : "supplier",
    supplier: supplier.agreement,
    eligible: rejection === null,
    rejection,
    confidence: exact.length && rejection === null ? 1 : null,
    evidence,
  };
}

export type SourceMatchPreparation = {
  invoiceDate: ReturnType<typeof matchingDateOf>;
  references: InvoiceReference[];
  candidates: SourceMatchCandidate[];
  /** The candidates TypeSafe should judge; empty when an exact reference decides. */
  semanticPool: SourceMatchCandidate[];
};

const FOUND_ORDER = { reference: 0, reference_number: 1, supplier: 2 };
const SUPPLIER_ORDER: Record<SupplierAgreement, number> = {
  same: 0,
  name_only: 1,
  unknown: 2,
  different: 3,
};

/**
 * Assesses every source the caller found for the invoice (all from the
 * invoice's own workspace) and chooses which, if any, need a semantic
 * judgment. An eligible exact reference means none do.
 */
export function prepareSourceMatch(input: {
  invoice: InvoiceForMatching;
  sources: readonly SourceCandidateInput[];
  /** Keep every source given (a person chose them), related or not. */
  keepAll?: boolean;
}): SourceMatchPreparation {
  const references = invoiceReferencesOf(input.invoice.extraction);
  const invoiceDate = matchingDateOf(input.invoice);
  const seen = new Set<string>();
  const candidates = input.sources
    .filter((source) => {
      if (seen.has(source.sourceId)) return false;
      seen.add(source.sourceId);
      return true;
    })
    .map((source) =>
      assessCandidate(input.invoice, source, references, invoiceDate),
    )
    // A source found only by looking for the supplier's sources is kept only
    // when its supplier agrees; an unrelated one is not a candidate.
    .filter(
      (candidate) =>
        input.keepAll ||
        candidate.found !== "supplier" ||
        candidate.supplier === "same" ||
        candidate.supplier === "name_only",
    )
    .sort(
      (a, b) =>
        FOUND_ORDER[a.found] - FOUND_ORDER[b.found] ||
        SUPPLIER_ORDER[a.supplier] - SUPPLIER_ORDER[b.supplier] ||
        a.reference.localeCompare(b.reference),
    );
  const exact = candidates.some(
    (candidate) => candidate.found === "reference" && candidate.eligible,
  );
  const semanticPool = exact
    ? []
    : candidates
        .filter(
          (candidate) =>
            candidate.eligible &&
            candidate.found !== "reference" &&
            // A source is judged only when something ties it to this
            // invoice: its supplier, or its number printed on the invoice.
            (candidate.supplier === "same" ||
              candidate.supplier === "name_only" ||
              candidate.found === "reference_number"),
        )
        .slice(0, SOURCE_MATCH_LIMITS.semanticCandidates);
  return { invoiceDate, references, candidates, semanticPool };
}

// --- Semantic judgment -------------------------------------------------------------

export type SourceSemanticJudgment =
  | {
      status: "answered";
      model: string;
      /** Probability per candidate source id. */
      probabilities: Record<string, number>;
      /** Probability that none of the candidates covers the invoice. */
      none: number;
    }
  | { status: "failed"; reason: string };

// --- Allocations -------------------------------------------------------------------

export type SourceAllocationBasis =
  | "invoice_line"
  | "invoice_net"
  | "invoice_gross"
  | "manual";

/**
 * Part of the invoice billed against a source (and, when known, one of its
 * authorized lines). Amounts are signed decimal strings in the invoice's
 * currency: a credit note's allocations are negative.
 */
export type SourceAllocation = {
  sourceId: string;
  versionId: string;
  sourceLineReference: string | null;
  invoiceLineIndex: number | null;
  amount: string | null;
  currency: string | null;
  basis: SourceAllocationBasis;
};

export type SourceMatchLink = {
  sourceId: string;
  versionId: string;
  version: number;
  type: AuthorizationSourceType;
  reference: string;
  title: string | null;
};

export type AllocationSummary = {
  /** Whether every invoice line (or the whole invoice) is allocated to a source. */
  complete: boolean;
  /** Invoice line indexes not allocated to any source. */
  unallocatedLines: number[];
  /** Sum of allocated amounts, signed, in the invoice currency. */
  allocatedAmount: string | null;
};

const decimalOfMinor = (minor: number) => {
  const sign = minor < 0 ? "-" : "";
  const digits = String(Math.abs(minor)).padStart(3, "0");
  return `${sign}${digits.slice(0, -2)}.${digits.slice(-2)}`;
};

/** Minor units of a signed two-decimal string, or null when it is not one. */
export const minorOfDecimal = (value: unknown): number | null => {
  if (typeof value !== "string") return null;
  const match = /^(-)?(\d{1,13})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  const [, sign, whole = "0", fraction = ""] = match;
  const minor = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return sign ? -minor : minor;
};

const signOf = (extraction: unknown) =>
  asRecord(extraction).documentType === "credit_note" ? -1 : 1;

const signedAmount = (extraction: unknown, value: number | null) =>
  value === null
    ? null
    : decimalOfMinor(signOf(extraction) * Math.abs(toMinor(value)));

const words = (value: string | null) =>
  (value ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** The authorized line an invoice line names: same description, or one contained in it. */
const pairLine = (
  description: string | null,
  lines: readonly AuthorizationLine[],
) => {
  const invoiceWords = words(description);
  if (!invoiceWords) return null;
  const equal = lines.filter(
    (line) => words(line.description) === invoiceWords,
  );
  if (equal.length === 1) return equal[0]!;
  const contained = lines.filter((line) => {
    const lineWords = words(line.description);
    return (
      lineWords.length >= 6 && ` ${invoiceWords} `.includes(` ${lineWords} `)
    );
  });
  return contained.length === 1 ? contained[0]! : null;
};

export type AllocationTarget = {
  sourceId: string;
  versionId: string;
  referenceKey: string;
  taxBasis: string | null;
  lines: readonly AuthorizationLine[];
};

export const summarizeAllocations = (
  extraction: unknown,
  allocations: readonly SourceAllocation[],
): AllocationSummary => {
  const lineCount = Array.isArray(asRecord(extraction).lineItems)
    ? (asRecord(extraction).lineItems as unknown[]).length
    : 0;
  const allocatedLines = new Set(
    allocations
      .map((allocation) => allocation.invoiceLineIndex)
      .filter((index): index is number => index !== null),
  );
  const whole = allocations.some(
    (allocation) => allocation.invoiceLineIndex === null,
  );
  const unallocatedLines = whole
    ? []
    : Array.from({ length: lineCount }, (_, index) => index).filter(
        (index) => !allocatedLines.has(index),
      );
  const amounts = allocations.map((allocation) =>
    minorOfDecimal(allocation.amount),
  );
  return {
    complete:
      allocations.length > 0 && (whole || unallocatedLines.length === 0),
    unallocatedLines,
    allocatedAmount:
      amounts.length > 0 && amounts.every((amount) => amount !== null)
        ? decimalOfMinor(
            amounts.reduce((sum: number, amount) => sum + amount!, 0),
          )
        : null,
  };
};

/**
 * Allocates an automatically matched invoice to its sources. One source takes
 * every line (paired with the authorized line it names, where one does) or,
 * without lines, the whole invoice (net against a tax-exclusive source, gross
 * against an inclusive one). With several sources, a line is allocated only
 * to the one whose reference it prints; the rest are left for a person.
 */
export function allocateInvoice(
  extraction: unknown,
  targets: readonly AllocationTarget[],
): SourceAllocation[] {
  const record = asRecord(extraction);
  const currency = text(record.currency);
  const lines = (Array.isArray(record.lineItems) ? record.lineItems : []).map(
    asRecord,
  );
  if (targets.length === 0) return [];
  if (lines.length === 0) {
    if (targets.length !== 1) return [];
    const target = targets[0]!;
    const net = finite(record.netAmount);
    const gross = finite(record.grossAmount);
    const useGross = target.taxBasis === "inclusive" || net === null;
    const amount = useGross ? gross : net;
    return [
      {
        sourceId: target.sourceId,
        versionId: target.versionId,
        sourceLineReference: null,
        invoiceLineIndex: null,
        amount: signedAmount(extraction, amount),
        currency,
        basis: useGross ? "invoice_gross" : "invoice_net",
      },
    ];
  }
  const references = invoiceReferencesOf(extraction);
  const allocations: SourceAllocation[] = [];
  lines.forEach((line, index) => {
    let target: AllocationTarget | undefined;
    if (targets.length === 1) {
      target = targets[0];
    } else {
      const named = targets.filter((candidate) =>
        references.some(
          (reference) =>
            reference.field === "lineItem" &&
            reference.lineIndex === index &&
            reference.trusted &&
            reference.key === candidate.referenceKey,
        ),
      );
      if (named.length === 1) target = named[0];
    }
    if (!target) return;
    const description = text(line.description);
    allocations.push({
      sourceId: target.sourceId,
      versionId: target.versionId,
      sourceLineReference:
        pairLine(description, target.lines)?.reference ?? null,
      invoiceLineIndex: index,
      amount: signedAmount(extraction, finite(line.total)),
      currency,
      basis: "invoice_line",
    });
  });
  return allocations;
}

// --- Decision ----------------------------------------------------------------------

export type SourceMatchResult = {
  /** Rules version (`SOURCE_MATCHING_VERSION`). */
  version: number;
  status: SourceMatchStatus;
  method: SourceMatchMethod | null;
  /** 1 for an exact reference, TypeSafe's probability for a semantic proposal. */
  confidence: number | null;
  /** A semantic proposal is linked but should be confirmed by a person. */
  needsConfirmation: boolean;
  message: string;
  invoiceDate: ReturnType<typeof matchingDateOf>;
  references: InvoiceReference[];
  links: SourceMatchLink[];
  allocations: SourceAllocation[];
  allocation: AllocationSummary;
  /** Every source considered, including rejected ones, with its evidence. */
  candidates: SourceMatchCandidate[];
  semantic:
    | { status: "not_needed" }
    | {
        status: "answered";
        model: string;
        probabilities: Record<string, number>;
        none: number;
      }
    | { status: "failed"; reason: string };
  /** When the sources were read: the effective lookups are reproducible as of this time. */
  asOf: string;
};

const linkOf = (candidate: SourceMatchCandidate): SourceMatchLink => ({
  sourceId: candidate.sourceId,
  versionId: candidate.versionId,
  version: candidate.version,
  type: candidate.type,
  reference: candidate.reference,
  title: candidate.title,
});

const percent = (value: number) => `${Math.round(value * 100)}%`;

const REJECTION_LABEL: Record<SourceCandidateRejection, string> = {
  wrong_supplier: "is recorded for another supplier",
  cancelled: "is cancelled",
  currency_conflict: "authorizes another currency",
};

/**
 * Decides the invoice's match from the assessed candidates and, when one was
 * needed, TypeSafe's judgment. `allocationTargets` supplies each candidate's
 * authorized lines for automatic allocation.
 */
export function decideSourceMatch(input: {
  invoice: InvoiceForMatching;
  preparation: SourceMatchPreparation;
  semantic: SourceSemanticJudgment | null;
  allocationTargets: readonly AllocationTarget[];
  /** Whether the workspace has any authorization source at all. */
  workspaceHasSources: boolean;
  asOf: string;
}): SourceMatchResult {
  const { preparation, invoice } = input;
  const candidates = preparation.candidates.map((candidate) => ({
    ...candidate,
    evidence: [...candidate.evidence],
  }));
  const base = {
    version: SOURCE_MATCHING_VERSION,
    invoiceDate: preparation.invoiceDate,
    references: preparation.references,
    candidates,
    asOf: input.asOf,
  };
  const withAllocations = (links: SourceMatchLink[]) => {
    const targets = links.flatMap((link) =>
      input.allocationTargets.filter(
        (target) =>
          target.sourceId === link.sourceId &&
          target.versionId === link.versionId,
      ),
    );
    const allocations = allocateInvoice(invoice.extraction, targets);
    return {
      links,
      allocations,
      allocation: summarizeAllocations(invoice.extraction, allocations),
    };
  };
  const none = {
    links: [],
    allocations: [],
    allocation: summarizeAllocations(invoice.extraction, []),
  };

  // 1. Exact references decide on their own.
  const exact = candidates.filter(
    (candidate) => candidate.found === "reference" && candidate.eligible,
  );
  if (exact.length > 0) {
    const fromPurchaseOrderField = new Set(
      preparation.references
        .filter((reference) => reference.field === "purchaseOrderReference")
        .map((reference) => reference.key),
    );
    const byKey = new Map<string, SourceMatchCandidate[]>();
    for (const candidate of exact) {
      const key = authorizationReferenceKey(candidate.reference);
      byKey.set(key, [...(byKey.get(key) ?? []), candidate]);
    }
    const chosen: SourceMatchCandidate[] = [];
    const tied: SourceMatchCandidate[] = [];
    for (const [key, group] of byKey) {
      if (group.length === 1) {
        chosen.push(group[0]!);
        continue;
      }
      // The same reference on a job and a purchase order: the purchase-order
      // field names the purchase order. Otherwise a person must choose.
      const orders = group.filter(
        (candidate) => candidate.type === "purchase_order",
      );
      if (fromPurchaseOrderField.has(key) && orders.length === 1) {
        chosen.push(orders[0]!);
      } else {
        tied.push(...group);
      }
    }
    if (tied.length > 0) {
      return {
        ...base,
        ...none,
        status: "ambiguous",
        method: "reference",
        confidence: null,
        needsConfirmation: true,
        message: `The printed reference names more than one source (${tied
          .map(sourceLabel)
          .join(", ")}). Choose the one this invoice bills.`,
        semantic: { status: "not_needed" },
      };
    }
    return {
      ...base,
      ...withAllocations(chosen.map(linkOf)),
      status: "matched",
      method: "reference",
      confidence: 1,
      needsConfirmation: false,
      message:
        chosen.length === 1
          ? `Matched to ${sourceLabel(chosen[0]!)} by the reference printed on the invoice.`
          : `Matched to ${chosen.map(sourceLabel).join(" and ")} by the references printed on the invoice.`,
      semantic: { status: "not_needed" },
    };
  }

  const rejectedReferences = candidates.filter(
    (candidate) => candidate.found === "reference" && !candidate.eligible,
  );
  const rejectedNote = rejectedReferences.length
    ? ` ${rejectedReferences
        .map(
          (candidate) =>
            `${sourceLabel(candidate)} is printed on the invoice but ${REJECTION_LABEL[candidate.rejection!]}, so it is not linked.`,
        )
        .join(" ")}`
    : "";

  // 2. Nothing ties any source to the invoice.
  const pool = preparation.semanticPool;
  if (pool.length === 0) {
    const record = asRecord(invoice.extraction);
    const identified =
      invoice.supplierId !== null ||
      Boolean(
        vatKey(record.supplierVatNumber) ||
          companyNumberKey(record.supplierCompanyNumber) ||
          supplierKey(record.supplierName),
      );
    if (!input.workspaceHasSources) {
      return {
        ...base,
        ...none,
        status: "unmatched",
        method: null,
        confidence: null,
        needsConfirmation: false,
        message: "This workspace has no authorization sources yet.",
        semantic: { status: "not_needed" },
      };
    }
    if (
      !identified &&
      preparation.references.length === 0 &&
      rejectedReferences.length === 0
    ) {
      return {
        ...base,
        ...none,
        status: "insufficient_evidence",
        method: null,
        confidence: null,
        needsConfirmation: false,
        message:
          "The supplier could not be identified and no source reference is printed, so no source can be proposed.",
        semantic: { status: "not_needed" },
      };
    }
    return {
      ...base,
      ...none,
      status: "unmatched",
      method: null,
      confidence: null,
      needsConfirmation: false,
      message: `No open source references this invoice or is recorded for its supplier.${rejectedNote}`,
      semantic: { status: "not_needed" },
    };
  }

  // 3. TypeSafe judged which candidate, if any, covers the invoiced work.
  const semantic = input.semantic;
  if (!semantic || semantic.status === "failed") {
    const reason = semantic?.reason ?? "No semantic judgment was made.";
    return {
      ...base,
      ...none,
      status: "insufficient_evidence",
      method: null,
      confidence: null,
      needsConfirmation: false,
      message: `No reference links this invoice to a source and the semantic check could not be completed (${reason}); ${pool.length} candidate source${pool.length === 1 ? " is" : "s are"} listed for review.${rejectedNote}`,
      semantic: { status: "failed", reason },
    };
  }

  const poolIds = new Set(pool.map((candidate) => candidate.sourceId));
  for (const candidate of candidates) {
    if (!poolIds.has(candidate.sourceId)) continue;
    const probability = semantic.probabilities[candidate.sourceId] ?? 0;
    candidate.confidence = probability;
    candidate.evidence.push({
      kind: "semantic",
      outcome:
        probability >= SOURCE_MATCH_THRESHOLDS.propose
          ? "supports"
          : probability >= SOURCE_MATCH_THRESHOLDS.rival
            ? "neutral"
            : "conflicts",
      message: `TypeSafe judged the invoiced work to fall under this source with probability ${percent(probability)}.`,
    });
  }
  const ranked = candidates
    .filter((candidate) => poolIds.has(candidate.sourceId))
    .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
  const [top, second] = ranked;
  const semanticResult = {
    status: "answered" as const,
    model: semantic.model,
    probabilities: semantic.probabilities,
    none: semantic.none,
  };
  const topProbability = top?.confidence ?? 0;

  if (semantic.none >= SOURCE_MATCH_THRESHOLDS.none || !top) {
    return {
      ...base,
      ...none,
      status: "unmatched",
      method: "semantic",
      confidence: semantic.none,
      needsConfirmation: false,
      message: `TypeSafe judged that none of the ${pool.length} candidate source${pool.length === 1 ? "" : "s"} covers this invoice (${percent(semantic.none)}).${rejectedNote}`,
      semantic: semanticResult,
    };
  }
  if (second && (second.confidence ?? 0) >= SOURCE_MATCH_THRESHOLDS.rival) {
    const rivals = ranked.filter(
      (candidate) =>
        (candidate.confidence ?? 0) >= SOURCE_MATCH_THRESHOLDS.rival,
    );
    return {
      ...base,
      ...none,
      status: "ambiguous",
      method: "semantic",
      confidence: topProbability,
      needsConfirmation: true,
      message: `The invoice could bill ${rivals
        .map(
          (candidate) =>
            `${sourceLabel(candidate)} (${percent(candidate.confidence ?? 0)})`,
        )
        .join(" or ")}. Choose the one it bills.`,
      semantic: semanticResult,
    };
  }
  if (
    topProbability >= SOURCE_MATCH_THRESHOLDS.propose &&
    (top.supplier === "same" || top.supplier === "name_only")
  ) {
    return {
      ...base,
      ...withAllocations([linkOf(top)]),
      status: "matched",
      method: "semantic",
      confidence: topProbability,
      needsConfirmation: true,
      message: `Proposed ${sourceLabel(top)}: no reference is printed, and TypeSafe judged the invoiced work to fall under it (${percent(topProbability)}). Confirm or correct it.`,
      semantic: semanticResult,
    };
  }
  return {
    ...base,
    ...none,
    status: "insufficient_evidence",
    method: "semantic",
    confidence: topProbability,
    needsConfirmation: false,
    message:
      topProbability >= SOURCE_MATCH_THRESHOLDS.propose
        ? `${sourceLabel(top)} looks like the match (${percent(topProbability)}), but its supplier cannot be confirmed as this invoice's.${rejectedNote}`
        : `No candidate source is a clear match; the closest is ${sourceLabel(top)} (${percent(topProbability)}).${rejectedNote}`,
    semantic: semanticResult,
  };
}

// --- Manual decisions --------------------------------------------------------------

export type ManualAllocationInput = {
  sourceId: string;
  sourceLineReference?: string | null;
  invoiceLineIndex?: number | null;
  amount?: string | null;
};

export type ManualLinkTarget = {
  link: SourceMatchLink;
  lines: readonly AuthorizationLine[];
  currency: string | null;
};

/**
 * Checks the allocations a person gave for a manual link, returning every
 * problem found. With none given, each source takes the invoice as a whole
 * when it is the only one; several sources need explicit allocations.
 */
export function manualAllocations(input: {
  extraction: unknown;
  targets: readonly ManualLinkTarget[];
  allocations: readonly ManualAllocationInput[] | null;
}): { allocations: SourceAllocation[]; issues: string[] } {
  const record = asRecord(input.extraction);
  const currency = text(record.currency);
  const lineCount = Array.isArray(record.lineItems)
    ? record.lineItems.length
    : 0;
  const issues: string[] = [];
  const bySource = new Map(
    input.targets.map((target) => [target.link.sourceId, target]),
  );

  if (!input.allocations || input.allocations.length === 0) {
    if (input.targets.length !== 1) {
      return {
        allocations: [],
        issues:
          input.targets.length > 1
            ? ["Say how the invoice is split between the sources."]
            : [],
      };
    }
    const target = input.targets[0]!;
    const net = finite(record.netAmount);
    const gross = finite(record.grossAmount);
    const amount = net ?? gross;
    return {
      allocations: [
        {
          sourceId: target.link.sourceId,
          versionId: target.link.versionId,
          sourceLineReference: null,
          invoiceLineIndex: null,
          amount: signedAmount(input.extraction, amount),
          currency,
          basis: net === null ? "invoice_gross" : "invoice_net",
        },
      ],
      issues,
    };
  }
  if (input.allocations.length > SOURCE_MATCH_LIMITS.allocations) {
    return {
      allocations: [],
      issues: [
        `At most ${SOURCE_MATCH_LIMITS.allocations} allocations can be given.`,
      ],
    };
  }
  const seen = new Set<string>();
  const allocations: SourceAllocation[] = [];
  input.allocations.forEach((allocation, index) => {
    const at = `Allocation ${index + 1}`;
    const target = bySource.get(allocation.sourceId);
    if (!target) {
      issues.push(`${at} names a source that is not linked.`);
      return;
    }
    const lineReference = text(allocation.sourceLineReference ?? null);
    if (
      lineReference &&
      !target.lines.some(
        (line) =>
          line.reference !== null &&
          authorizationReferenceKey(line.reference) ===
            authorizationReferenceKey(lineReference),
      )
    ) {
      issues.push(
        `${at}: ${sourceLabel(target.link)} version ${target.link.version} has no line "${lineReference}".`,
      );
    }
    const lineIndex = allocation.invoiceLineIndex ?? null;
    if (
      lineIndex !== null &&
      (!Number.isInteger(lineIndex) || lineIndex < 0 || lineIndex >= lineCount)
    ) {
      issues.push(`${at}: the invoice has no line ${lineIndex + 1}.`);
    }
    const key = `${allocation.sourceId}:${lineReference ?? ""}:${lineIndex ?? ""}`;
    if (seen.has(key)) {
      issues.push(`${at} repeats an earlier allocation.`);
    }
    seen.add(key);
    let amount: string | null = null;
    if (
      allocation.amount !== undefined &&
      allocation.amount !== null &&
      allocation.amount !== ""
    ) {
      const minor = minorOfDecimal(allocation.amount);
      if (minor === null) {
        issues.push(
          `${at}: the amount must be a number with at most 2 decimal places.`,
        );
      } else {
        amount = decimalOfMinor(signOf(input.extraction) * Math.abs(minor));
      }
    } else if (lineIndex !== null) {
      const line = asRecord((record.lineItems as unknown[])[lineIndex]);
      amount = signedAmount(input.extraction, finite(line.total));
    }
    if (target.currency && currency && target.currency !== currency) {
      issues.push(
        `${at}: ${sourceLabel(target.link)} authorizes ${target.currency}, the invoice is in ${currency}.`,
      );
    }
    allocations.push({
      sourceId: target.link.sourceId,
      versionId: target.link.versionId,
      sourceLineReference: lineReference,
      invoiceLineIndex: lineIndex,
      amount,
      currency,
      basis: "manual",
    });
  });
  for (const target of input.targets) {
    if (
      !allocations.some(
        (allocation) => allocation.sourceId === target.link.sourceId,
      )
    ) {
      issues.push(
        `Allocate part of the invoice to ${sourceLabel(target.link)}, or unlink it.`,
      );
    }
  }
  return { allocations: issues.length ? [] : allocations, issues };
}

/** A decision's identity: equal decisions are not recorded twice. */
export const sourceMatchFingerprint = (result: {
  status: string;
  links: readonly SourceMatchLink[];
  allocations: readonly SourceAllocation[];
  candidates: readonly {
    sourceId: string;
    versionId: string;
    eligible: boolean;
    confidence: number | null;
  }[];
}) =>
  JSON.stringify([
    result.status,
    result.links.map((link) => [link.sourceId, link.versionId]).sort(),
    result.allocations
      .map((allocation) => [
        allocation.sourceId,
        allocation.versionId,
        allocation.sourceLineReference,
        allocation.invoiceLineIndex,
        allocation.amount,
      ])
      .sort(),
    result.candidates
      .map((candidate) => [
        candidate.sourceId,
        candidate.versionId,
        candidate.eligible,
        candidate.confidence === null
          ? null
          : Math.round(candidate.confidence * 100),
      ])
      .sort(),
  ]);
