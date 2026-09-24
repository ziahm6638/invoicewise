/**
 * Deterministic validation of an extracted invoice or credit note.
 *
 * TypeSafe reads and selects; this module only does arithmetic and rules on
 * what was selected, so the same extraction always validates the same way.
 * It never fills a gap: a missing VAT amount is not zero, a bare "$" is not
 * US dollars, and a missing date is not today. What it cannot verify is
 * reported as `unknown`, and what the delivery path cannot represent (a
 * credit note posted as a bill) as `unsupported`.
 *
 * `docs/document-intake.md#validation` publishes these rules.
 */
import { ibanChecksumValid } from "./typesafe/candidates";
import type {
  FieldEvidence,
  InvoiceEvidenceField,
  InvoiceExtraction,
  InvoiceLineItem,
  PreviousInvoice,
} from "./typesafe/invoice";

/** Bumped whenever a rule changes, so stored results can be recomputed. */
export const VALIDATION_VERSION = 1;

/**
 * Money is compared in integer minor units of the invoice currency, rounded
 * half away from zero. Every currency the reader recognises (GBP, EUR, USD,
 * CAD, AUD, NZD, SEK, NOK, DKK, CHF) has two decimal places.
 */
export const MONEY_RULES = {
  minorUnitDigits: 2,
  rounding: "half away from zero",
  /** One printed sum against its parts (net + tax = gross, lines = net). */
  sumToleranceMinor: 1,
  /**
   * Quantity x unit price against the row total: one minor unit, or half a
   * minor unit per unit of quantity when that is more, because the printed
   * unit price may itself be rounded.
   */
  lineToleranceMinor: (quantity: number) =>
    Math.max(1, Math.ceil(Math.abs(quantity) * 0.5)),
  /**
   * Tax recomputed from a rate: one minor unit per line item (at least one),
   * because suppliers may round tax per line or once per invoice.
   */
  taxToleranceMinor: (lineCount: number) => Math.max(1, lineCount),
} as const;

/** A selection TypeSafe was less sure of than this is flagged for review. */
export const LOW_CONFIDENCE = 0.6;

/** Fields a draft bill needs; without any of them the post is not attempted. */
export const ACCOUNTING_REQUIRED_FIELDS = [
  "documentType",
  "supplierName",
  "invoiceNumber",
  "invoiceDate",
  "currency",
  "grossAmount",
] as const satisfies readonly (keyof InvoiceExtraction)[];

export type CheckOutcome =
  | "pass"
  | "fail"
  | "unknown"
  | "not_applicable"
  | "unsupported";

export type ValidationCheckId =
  | "line_arithmetic"
  | "line_totals"
  | "tax"
  | "gross"
  | "currency";

export type ValidationCheck = {
  id: ValidationCheckId;
  outcome: CheckOutcome;
  message: string;
  /** Amounts in major units, signed as printed. */
  expected?: number | null;
  actual?: number | null;
  tolerance?: number;
  /** Line items (0-based) the check failed on. */
  lines?: number[];
};

export type ValidationIssue = {
  code: string;
  severity: "error" | "warning";
  field?: InvoiceEvidenceField | "lineItems";
  message: string;
};

/** An amount always travels with its currency; null when the invoice does not name it. */
export type Money = { amount: number; currency: string | null };

export type InvoiceValidation = {
  version: typeof VALIDATION_VERSION;
  /** `invalid` has errors, `needs_review` only warnings. */
  status: "valid" | "needs_review" | "invalid";
  documentType: "invoice" | "credit_note" | "unknown";
  taxBasis: "exclusive" | "inclusive" | "no_tax" | "unknown";
  currency: string | null;
  /**
   * Canonical totals, signed by document type: an invoice's are positive and
   * a credit note's negative, whichever way the document prints them.
   */
  totals: {
    net: Money | null;
    discount: Money | null;
    tax: Money | null;
    gross: Money | null;
  };
  checks: ValidationCheck[];
  issues: ValidationIssue[];
  identity: {
    /** `type:supplier:number`; null without a supplier and a number. */
    key: string | null;
    /** An earlier document with the same identity. */
    duplicateOf: string | null;
    /** For a credit note: the earlier invoice it credits, when found. */
    creditsInvoiceId: string | null;
  };
  /** Whether the invoice may be posted to the accounting provider as a draft bill. */
  accounting: {
    ready: boolean;
    requiredFields: readonly string[];
    blockers: { code: string; message: string }[];
  };
};

// --- Money -------------------------------------------------------------------

const SCALE = 10 ** MONEY_RULES.minorUnitDigits;

/** Major units to integer minor units, half away from zero. */
export const toMinor = (value: number) =>
  Math.sign(value) * Math.round(Math.abs(value) * SCALE + 1e-7);

const toMajor = (minor: number) => minor / SCALE;

const format = (minor: number) =>
  toMajor(minor).toLocaleString("en-GB", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

// --- Identity ----------------------------------------------------------------

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};

/** A supplier name without punctuation, legal suffixes or case. */
export const supplierKey = (name: unknown) =>
  typeof name === "string"
    ? name
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .replace(/\b(?:ltd|limited|plc|llp|inc|llc|co|company|the|uk)\b/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    : "";

/** A document number compared without spacing, punctuation or case. */
export const documentNumberKey = (value: unknown) =>
  typeof value === "string"
    ? value.toUpperCase().replace(/[^A-Z0-9]/g, "")
    : "";

const vatKey = (value: unknown) =>
  typeof value === "string"
    ? value.toUpperCase().replace(/[^A-Z0-9]/g, "")
    : "";

type Identity = {
  type: "invoice" | "credit_note";
  vat: string;
  name: string;
  number: string;
};

const identityOf = (extraction: unknown): Identity | null => {
  const record = asRecord(extraction);
  const number = documentNumberKey(record.invoiceNumber);
  const name = supplierKey(record.supplierName);
  const vat = vatKey(record.supplierVatNumber);
  if (!number || (!name && !vat)) return null;
  // Records extracted before document types existed were all read as invoices.
  const type =
    record.documentType === "credit_note" ? "credit_note" : "invoice";
  return { type, vat, name, number };
};

const sameSupplier = (
  a: Pick<Identity, "vat" | "name">,
  b: Pick<Identity, "vat" | "name">,
) => (a.vat && b.vat ? a.vat === b.vat : a.name !== "" && a.name === b.name);

const identityKey = (identity: Identity) =>
  `${identity.type}:${identity.vat || identity.name}:${identity.number}`;

// --- Supplier identifiers ----------------------------------------------------

/** HMRC's check-digit test for a GB VAT number (9 digits, or 12 with a branch). */
export const gbVatNumberValid = (value: string) => {
  const compact = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const match = /^GB(\d{9})(\d{3})?$/.exec(compact);
  if (!match) return null;
  const digits = match[1]!.split("").map(Number);
  const weighted = digits
    .slice(0, 7)
    .reduce((sum, digit, index) => sum + digit * (8 - index), 0);
  const check = digits[7]! * 10 + digits[8]!;
  return (weighted + check) % 97 === 0 || (weighted + check + 55) % 97 === 0;
};

// --- Validation --------------------------------------------------------------

/** How each field is named in messages shown to customers. */
export const FIELD_LABEL: Record<InvoiceEvidenceField, string> = {
  documentType: "document type (invoice or credit note)",
  supplierName: "supplier name",
  supplierAddress: "supplier address",
  supplierVatNumber: "supplier VAT number",
  supplierCompanyNumber: "company number",
  invoiceNumber: "invoice number",
  originalInvoiceNumber: "original invoice number",
  invoiceDate: "invoice date",
  dueDate: "due date",
  currency: "currency",
  netAmount: "net total",
  discountAmount: "discount",
  vatAmount: "VAT amount",
  taxRate: "VAT rate",
  grossAmount: "gross total",
  amountsIncludeTax: "tax basis",
  accountName: "bank account name",
  accountNumber: "bank account number",
  sortCode: "sort code",
  iban: "IBAN",
  bic: "BIC",
  description: "description",
  purchaseOrderReference: "purchase order reference",
  paymentReference: "payment reference",
};

const EMPTY: Omit<InvoiceExtraction, "textSource" | "pageSources"> = {
  documentType: null,
  supplierName: null,
  supplierAddress: null,
  supplierVatNumber: null,
  supplierCompanyNumber: null,
  invoiceNumber: null,
  originalInvoiceNumber: null,
  invoiceDate: null,
  dueDate: null,
  currency: null,
  netAmount: null,
  discountAmount: null,
  vatAmount: null,
  taxRate: null,
  grossAmount: null,
  amountsIncludeTax: null,
  lineItems: [],
  bankDetails: {
    accountName: null,
    accountNumber: null,
    sortCode: null,
    iban: null,
    bic: null,
  },
  description: null,
  purchaseOrderReference: null,
  paymentReference: null,
  evidence: { fields: {}, lineItems: [] },
};

const textOrNull = (value: unknown) =>
  typeof value === "string" && value.trim() !== "" ? value : null;

const numberOrNull = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** A stored extraction of any age, with every field present. */
const normalize = (extraction: unknown) => {
  const record = asRecord(extraction);
  const merged = { ...EMPTY, ...record } as typeof EMPTY;
  const evidence = asRecord(record.evidence);
  return {
    ...merged,
    // Records extracted before document types existed have no key at all.
    documentType:
      record.documentType === "invoice" || record.documentType === "credit_note"
        ? (record.documentType as "invoice" | "credit_note")
        : null,
    supplierName: textOrNull(merged.supplierName),
    supplierVatNumber: textOrNull(merged.supplierVatNumber),
    invoiceNumber: textOrNull(merged.invoiceNumber),
    originalInvoiceNumber: textOrNull(merged.originalInvoiceNumber),
    invoiceDate: textOrNull(merged.invoiceDate),
    dueDate: textOrNull(merged.dueDate),
    currency: textOrNull(merged.currency),
    amountsIncludeTax:
      typeof merged.amountsIncludeTax === "boolean"
        ? merged.amountsIncludeTax
        : null,
    bankDetails: {
      ...EMPTY.bankDetails,
      iban: textOrNull(asRecord(record.bankDetails).iban),
    },
    netAmount: numberOrNull(merged.netAmount),
    discountAmount: numberOrNull(merged.discountAmount),
    vatAmount: numberOrNull(merged.vatAmount),
    taxRate: numberOrNull(merged.taxRate),
    grossAmount: numberOrNull(merged.grossAmount),
    lineItems: (Array.isArray(merged.lineItems) ? merged.lineItems : []).map(
      (item) => {
        const row = asRecord(item);
        return {
          description:
            typeof row.description === "string" ? row.description : null,
          quantity: numberOrNull(row.quantity),
          unitPrice: numberOrNull(row.unitPrice),
          discountAmount: numberOrNull(row.discountAmount),
          discountRate: numberOrNull(row.discountRate),
          taxRate: numberOrNull(row.taxRate),
          taxAmount: numberOrNull(row.taxAmount),
          total: numberOrNull(row.total),
        } satisfies InvoiceLineItem;
      },
    ),
    evidence: {
      fields: asRecord(evidence.fields) as Partial<
        Record<InvoiceEvidenceField, FieldEvidence>
      >,
      lineItems: (Array.isArray(evidence.lineItems)
        ? evidence.lineItems
        : []) as FieldEvidence[],
    },
  };
};

const DOLLAR_CURRENCIES = new Set(["USD", "CAD", "AUD", "NZD"]);

/** Whether an amount's printed marker is consistent with the invoice currency. */
const markerMatches = (
  evidence: FieldEvidence | undefined,
  currency: string,
) => {
  if (!evidence) return true;
  if (evidence.currency) return evidence.currency === currency;
  if (evidence.currencyMarker === "$") return DOLLAR_CURRENCIES.has(currency);
  return true;
};

const AMOUNT_FIELDS = [
  ["netAmount", "net total"],
  ["discountAmount", "discount"],
  ["vatAmount", "VAT amount"],
  ["grossAmount", "gross total"],
] as const;

/**
 * Validates an extraction and, given the workspace's earlier documents,
 * decides its duplicate identity and credit-note link.
 */
export function validateInvoice(
  input: unknown,
  previousInvoices: readonly PreviousInvoice[] = [],
): InvoiceValidation {
  const x = normalize(input);
  const checks: ValidationCheck[] = [];
  const issues: ValidationIssue[] = [];
  const error = (
    code: string,
    message: string,
    field?: ValidationIssue["field"],
  ) =>
    issues.push({
      code,
      severity: "error",
      message,
      ...(field ? { field } : {}),
    });
  const warn = (
    code: string,
    message: string,
    field?: ValidationIssue["field"],
  ) =>
    issues.push({
      code,
      severity: "warning",
      message,
      ...(field ? { field } : {}),
    });

  const documentType: InvoiceValidation["documentType"] =
    x.documentType ?? "unknown";
  const credit = documentType === "credit_note";
  const currency = x.currency;

  // --- Currency: amounts keep their currency; unlike currencies never mix.
  const mismatched = currency
    ? AMOUNT_FIELDS.filter(
        ([field]) =>
          x[field] !== null &&
          !markerMatches(x.evidence.fields[field], currency),
      )
    : [];
  if (!currency) {
    checks.push({
      id: "currency",
      outcome: "unknown",
      message:
        'The invoice does not name its currency (a bare "$" is not enough); it is not assumed.',
    });
  } else if (mismatched.length > 0) {
    const printed = mismatched
      .map(([field, label]) => {
        const evidence = x.evidence.fields[field];
        return `${label} printed in ${evidence?.currency ?? evidence?.currencyMarker}`;
      })
      .join(", ");
    checks.push({
      id: "currency",
      outcome: "fail",
      message: `The invoice currency is ${currency}, but the ${printed}. Amounts in different currencies are not added together or converted.`,
    });
    error("currency_mismatch", checks.at(-1)!.message, "currency");
  } else {
    checks.push({
      id: "currency",
      outcome: "pass",
      message: `All totals are in ${currency}.`,
    });
  }
  const unlike = new Set<string>(mismatched.map(([field]) => field));

  // --- Signs. Credit notes print their amounts either way round; they are
  // compared as magnitudes and stored negative.
  const signed = [x.netAmount, x.vatAmount, x.grossAmount].filter(
    (value): value is number => value !== null && value !== 0,
  );
  if (credit && new Set(signed.map(Math.sign)).size > 1) {
    warn(
      "mixed_signs",
      "The credit note prints some totals as negative and others as positive; they are compared as amounts credited.",
    );
  }
  const amount = (value: number | null) =>
    value === null ? null : toMinor(credit ? Math.abs(value) : value);
  const net = amount(x.netAmount);
  const tax = amount(x.vatAmount);
  const gross = amount(x.grossAmount);
  const discount =
    x.discountAmount === null ? 0 : toMinor(Math.abs(x.discountAmount));
  const lineValue = (value: number | null) =>
    value === null ? null : toMinor(credit ? Math.abs(value) : value);
  const lines = x.lineItems;

  if (!credit && x.grossAmount !== null && x.grossAmount < 0) {
    error(
      "negative_invoice_total",
      "The document is read as an invoice but its total is negative; a negative total is a credit, which is not posted as a bill.",
      "grossAmount",
    );
  }

  // --- Line arithmetic: quantity x unit price (less any row discount).
  const lineFailures: number[] = [];
  let lineChecked = 0;
  lines.forEach((item, index) => {
    if (
      item.quantity === null ||
      item.unitPrice === null ||
      item.total === null
    ) {
      return;
    }
    lineChecked += 1;
    const quantity = credit ? Math.abs(item.quantity) : item.quantity;
    const unitPrice = credit ? Math.abs(item.unitPrice) : item.unitPrice;
    let base = quantity * unitPrice;
    if (item.discountRate !== null) base *= 1 - item.discountRate / 100;
    if (item.discountAmount !== null) base -= Math.abs(item.discountAmount);
    const expected = toMinor(base);
    const total = lineValue(item.total)!;
    const tolerance = MONEY_RULES.lineToleranceMinor(quantity);
    const withTax =
      item.taxAmount === null ? null : expected + lineValue(item.taxAmount)!;
    if (
      Math.abs(expected - total) > tolerance &&
      (withTax === null || Math.abs(withTax - total) > tolerance)
    ) {
      lineFailures.push(index);
    }
  });
  if (lines.length === 0) {
    checks.push({
      id: "line_arithmetic",
      outcome: "not_applicable",
      message: "No line items were found to check.",
    });
  } else if (lineChecked === 0) {
    checks.push({
      id: "line_arithmetic",
      outcome: "unknown",
      message:
        "No line item prints its quantity, unit price and total, so none could be recomputed.",
    });
  } else if (lineFailures.length > 0) {
    checks.push({
      id: "line_arithmetic",
      outcome: "fail",
      message: `Quantity x unit price does not match the total on line ${lineFailures.map((index) => index + 1).join(", ")}.`,
      lines: lineFailures,
    });
    error("line_arithmetic", checks.at(-1)!.message, "lineItems");
  } else {
    checks.push({
      id: "line_arithmetic",
      outcome: "pass",
      message: `Quantity x unit price matches the total on ${lineChecked} of ${lines.length} line items.`,
    });
  }

  // --- Tax basis and the line-item sum.
  const lineTotals = lines.map((item) => lineValue(item.total));
  const allTotals =
    lines.length > 0 && lineTotals.every((value) => value !== null);
  const lineSum = allTotals
    ? (lineTotals as number[]).reduce((sum, value) => sum + value, 0) - discount
    : null;
  const within = (a: number, b: number, tolerance: number) =>
    Math.abs(a - b) <= tolerance;
  const sumTolerance = MONEY_RULES.sumToleranceMinor;

  let taxBasis: InvoiceValidation["taxBasis"] =
    x.amountsIncludeTax === true
      ? "inclusive"
      : x.amountsIncludeTax === false
        ? "exclusive"
        : "unknown";
  if (taxBasis === "unknown" && lineSum !== null) {
    if (net !== null && within(lineSum, net, sumTolerance)) {
      taxBasis = "exclusive";
    } else if (
      gross !== null &&
      tax !== null &&
      tax !== 0 &&
      within(lineSum, gross, sumTolerance)
    ) {
      taxBasis = "inclusive";
    }
  }
  const noTaxPrinted =
    tax === null &&
    lines.every((item) => item.taxRate === null && item.taxAmount === null);
  if (noTaxPrinted && x.taxRate === null) {
    const netEqualsGross =
      net === null || gross === null || within(net, gross, sumTolerance);
    if (netEqualsGross) taxBasis = "no_tax";
  }
  if (tax === 0) taxBasis = taxBasis === "unknown" ? "no_tax" : taxBasis;

  const amountsUnlike = (...fields: string[]) =>
    fields.some((field) => unlike.has(field));

  if (lines.length === 0) {
    checks.push({
      id: "line_totals",
      outcome: "not_applicable",
      message: "No line items were found to add up.",
    });
  } else if (lineSum === null) {
    checks.push({
      id: "line_totals",
      outcome: "unknown",
      message: "A line item has no total, so the lines could not be added up.",
    });
  } else {
    const target =
      taxBasis === "inclusive"
        ? { value: gross, label: "gross total", field: "grossAmount" }
        : net !== null
          ? { value: net, label: "net total", field: "netAmount" }
          : taxBasis === "no_tax"
            ? { value: gross, label: "total", field: "grossAmount" }
            : { value: null, label: "net total", field: "netAmount" };
    const discountText = discount
      ? ` less the ${format(discount)} discount`
      : "";
    if (amountsUnlike(target.field, "discountAmount")) {
      checks.push({
        id: "line_totals",
        outcome: "unsupported",
        message: `The ${target.label} is in a different currency from the invoice; the lines are not compared with it.`,
      });
    } else if (target.value === null) {
      checks.push({
        id: "line_totals",
        outcome: "unknown",
        message: `The lines add up to ${format(lineSum)}${discountText}, but the invoice prints no ${target.label} to compare.`,
      });
    } else if (within(lineSum, target.value, sumTolerance)) {
      checks.push({
        id: "line_totals",
        outcome: "pass",
        message: `The ${lines.length} line items${discountText} add up to the ${target.label}.`,
        expected: toMajor(target.value),
        actual: toMajor(lineSum),
        tolerance: toMajor(sumTolerance),
      });
    } else {
      checks.push({
        id: "line_totals",
        outcome: "fail",
        message: `The line items${discountText} add up to ${format(lineSum)}, but the ${target.label} is ${format(target.value)}.`,
        expected: toMajor(target.value),
        actual: toMajor(lineSum),
        tolerance: toMajor(sumTolerance),
      });
      error("line_totals", checks.at(-1)!.message, "lineItems");
    }
  }

  // --- Tax.
  const rated = lines.filter((item) => item.taxRate !== null);
  const taxTolerance = MONEY_RULES.taxToleranceMinor(lines.length);
  const expectedTax = ():
    | { value: number; how: string }
    | { unknown: string } => {
    if (lines.length > 0 && lines.every((item) => item.taxAmount !== null)) {
      return {
        value: lines.reduce((sum, item) => sum + lineValue(item.taxAmount)!, 0),
        how: "the line items' tax amounts",
      };
    }
    if (lines.length > 0 && rated.length === lines.length && allTotals) {
      const byRate = new Map<number, number>();
      lines.forEach((item, index) => {
        byRate.set(
          item.taxRate!,
          (byRate.get(item.taxRate!) ?? 0) + lineTotals[index]!,
        );
      });
      const positive = [...byRate.keys()].filter((rate) => rate > 0);
      if (discount && positive.length > 1) {
        return {
          unknown:
            "The invoice-level discount is not allocated across its tax rates, so tax could not be recomputed per rate.",
        };
      }
      let value = 0;
      for (const [rate, base] of byRate) {
        const taxable = discount && rate > 0 ? base - discount : base;
        value +=
          taxBasis === "inclusive"
            ? toMinor(toMajor(taxable) * (rate / (100 + rate)))
            : toMinor(toMajor(taxable) * (rate / 100));
      }
      const rates = [...byRate.keys()]
        .sort((a, b) => b - a)
        .map((rate) => `${rate}%`);
      return { value, how: `the line items at ${rates.join(", ")}` };
    }
    if (x.taxRate !== null) {
      if (taxBasis === "inclusive" && gross !== null) {
        return {
          value: toMinor(toMajor(gross) * (x.taxRate / (100 + x.taxRate))),
          how: `the gross total at ${x.taxRate}%`,
        };
      }
      if (net !== null) {
        return {
          value: toMinor(toMajor(net) * (x.taxRate / 100)),
          how: `the net total at ${x.taxRate}%`,
        };
      }
    }
    if (rated.length > 0) {
      return {
        unknown:
          "Only some line items print a tax rate, so tax could not be recomputed.",
      };
    }
    return {
      unknown:
        "No tax rate is printed, so the VAT amount could not be recomputed; only net + VAT = gross is checked.",
    };
  };

  if (amountsUnlike("vatAmount", "netAmount")) {
    checks.push({
      id: "tax",
      outcome: "unsupported",
      message:
        "The tax and net amounts are in different currencies; tax is not recomputed.",
    });
  } else if (tax === null) {
    if (taxBasis === "no_tax") {
      checks.push({
        id: "tax",
        outcome: "pass",
        message: "No VAT or tax is printed and the totals charge none.",
      });
      warn(
        "tax_not_stated",
        "No VAT or tax is shown. InvoiceWise does not assume the supplier is VAT registered or that the supply is zero-rated.",
        "vatAmount",
      );
    } else if (net !== null && gross !== null) {
      checks.push({
        id: "tax",
        outcome: "fail",
        message: `No VAT amount was found, but the gross total exceeds the net total by ${format(gross - net)}.`,
      });
      error("tax_missing", checks.at(-1)!.message, "vatAmount");
    } else {
      checks.push({
        id: "tax",
        outcome: "unknown",
        message: "No VAT amount was found; it is not assumed to be zero.",
      });
      warn("tax_unknown", checks.at(-1)!.message, "vatAmount");
    }
  } else if (tax === 0 && rated.length === 0 && x.taxRate === null) {
    checks.push({
      id: "tax",
      outcome: "pass",
      message: "VAT is printed as zero and no tax rate is charged.",
    });
  } else {
    const expected = expectedTax();
    if ("unknown" in expected) {
      checks.push({ id: "tax", outcome: "unknown", message: expected.unknown });
      warn("tax_unverified", expected.unknown, "vatAmount");
    } else if (within(expected.value, tax, taxTolerance)) {
      checks.push({
        id: "tax",
        outcome: "pass",
        message: `The VAT amount matches ${expected.how}.`,
        expected: toMajor(expected.value),
        actual: toMajor(tax),
        tolerance: toMajor(taxTolerance),
      });
    } else {
      checks.push({
        id: "tax",
        outcome: "fail",
        message: `The VAT amount is ${format(tax)}, but ${expected.how} give ${format(expected.value)}.`,
        expected: toMajor(expected.value),
        actual: toMajor(tax),
        tolerance: toMajor(taxTolerance),
      });
      error("tax", checks.at(-1)!.message, "vatAmount");
    }
  }

  // --- Gross = net + tax.
  if (amountsUnlike("netAmount", "vatAmount", "grossAmount")) {
    checks.push({
      id: "gross",
      outcome: "unsupported",
      message:
        "The totals are printed in different currencies, so net + VAT = gross is not checked and nothing is converted.",
    });
  } else if (gross === null) {
    checks.push({
      id: "gross",
      outcome: "unknown",
      message: "No gross total was found.",
    });
  } else if (net === null) {
    checks.push({
      id: "gross",
      outcome: "unknown",
      message:
        "No net total was found, so net + VAT = gross could not be checked.",
    });
  } else if (tax === null && taxBasis !== "no_tax") {
    checks.push({
      id: "gross",
      outcome: "unknown",
      message:
        "No VAT amount was found, so net + VAT = gross could not be checked.",
    });
  } else {
    const expected = net + (tax ?? 0);
    if (within(expected, gross, sumTolerance)) {
      checks.push({
        id: "gross",
        outcome: "pass",
        message: "Net + VAT equals the gross total.",
        expected: toMajor(expected),
        actual: toMajor(gross),
        tolerance: toMajor(sumTolerance),
      });
    } else {
      checks.push({
        id: "gross",
        outcome: "fail",
        message: `Net ${format(net)} + VAT ${format(tax ?? 0)} = ${format(expected)}, but the gross total is ${format(gross)}.`,
        expected: toMajor(expected),
        actual: toMajor(gross),
        tolerance: toMajor(sumTolerance),
      });
      error("gross", checks.at(-1)!.message, "grossAmount");
    }
  }

  // --- Required fields, dates and identifiers.
  for (const field of ACCOUNTING_REQUIRED_FIELDS) {
    if (x[field] === null) {
      error(
        "missing_field",
        `No ${FIELD_LABEL[field]} was found on the document.`,
        field,
      );
    }
  }
  if (x.invoiceDate && x.dueDate && x.dueDate < x.invoiceDate) {
    error(
      "due_before_invoice_date",
      `The due date ${x.dueDate} is before the invoice date ${x.invoiceDate}.`,
      "dueDate",
    );
  }
  // UK VAT invoices must show the supplier's VAT number; other tax regimes
  // (US sales tax) have no such number to look for.
  if (currency === "GBP" && tax !== null && tax !== 0 && !x.supplierVatNumber) {
    warn(
      "vat_without_registration",
      "VAT is charged but no supplier VAT registration number was found; a UK VAT invoice must show one.",
      "supplierVatNumber",
    );
  }
  if (x.supplierVatNumber && gbVatNumberValid(x.supplierVatNumber) === false) {
    warn(
      "vat_number_check_digits",
      `The VAT number ${x.supplierVatNumber} fails HMRC's check-digit test.`,
      "supplierVatNumber",
    );
  }
  if (x.bankDetails.iban && !ibanChecksumValid(x.bankDetails.iban)) {
    warn(
      "iban_checksum",
      `The IBAN ${x.bankDetails.iban} fails its checksum; confirm the bank details with the supplier.`,
      "iban",
    );
  }

  // --- Uncertain selections stay visible.
  for (const [field, evidence] of Object.entries(x.evidence.fields)) {
    if (
      evidence &&
      typeof evidence.confidence === "number" &&
      evidence.confidence < LOW_CONFIDENCE
    ) {
      warn(
        "low_confidence",
        `The ${FIELD_LABEL[field as InvoiceEvidenceField] ?? field} was selected with low confidence (${Math.round(evidence.confidence * 100)}%); check it against the document.`,
        field as InvoiceEvidenceField,
      );
    }
  }
  x.evidence.lineItems.forEach((evidence, index) => {
    if (
      typeof evidence?.confidence === "number" &&
      evidence.confidence < LOW_CONFIDENCE
    ) {
      warn(
        "low_confidence",
        `Line ${index + 1} was confirmed as a purchased item with low confidence (${Math.round(evidence.confidence * 100)}%).`,
        "lineItems",
      );
    }
  });

  // --- Duplicate identity and credit-note link.
  const identity = identityOf(x);
  let duplicateOf: string | null = null;
  let creditsInvoiceId: string | null = null;
  if (identity) {
    const duplicate = previousInvoices.find((previous) => {
      const other = identityOf(previous.extraction);
      return (
        other &&
        other.type === identity.type &&
        other.number === identity.number &&
        sameSupplier(identity, other)
      );
    });
    if (duplicate) {
      duplicateOf = duplicate.id;
      error(
        "duplicate",
        `${credit ? "Credit note" : "Invoice"} ${x.invoiceNumber} from ${x.supplierName ?? x.supplierVatNumber} has already been received.`,
        "invoiceNumber",
      );
    }
  }
  if (credit) {
    const original = documentNumberKey(x.originalInvoiceNumber);
    if (!original) {
      warn(
        "original_invoice_not_stated",
        "The credit note does not name the invoice it credits.",
        "originalInvoiceNumber",
      );
    } else {
      const supplier = {
        vat: vatKey(x.supplierVatNumber),
        name: supplierKey(x.supplierName),
      };
      const match = previousInvoices.find((previous) => {
        const other = identityOf(previous.extraction);
        return (
          other &&
          other.type === "invoice" &&
          other.number === original &&
          sameSupplier(supplier, other)
        );
      });
      if (!match) {
        warn(
          "original_invoice_not_found",
          `The credited invoice ${x.originalInvoiceNumber} has not been received in this workspace.`,
          "originalInvoiceNumber",
        );
      } else {
        creditsInvoiceId = match.id;
        const originalRecord = normalize(match.extraction);
        if (
          gross !== null &&
          originalRecord.grossAmount !== null &&
          originalRecord.currency === currency &&
          gross > toMinor(Math.abs(originalRecord.grossAmount)) + sumTolerance
        ) {
          warn(
            "credit_exceeds_invoice",
            `The credit of ${format(gross)} is more than the ${format(toMinor(originalRecord.grossAmount))} total of invoice ${x.originalInvoiceNumber}.`,
            "grossAmount",
          );
        }
      }
    }
  }

  // --- Canonical totals, each paired with its own currency.
  const money = (field: (typeof AMOUNT_FIELDS)[number][0]): Money | null => {
    const value = x[field];
    if (value === null) return null;
    const evidence = x.evidence.fields[field];
    const own = unlike.has(field) ? (evidence?.currency ?? null) : currency;
    const magnitude = Math.abs(value);
    const canonical =
      field === "discountAmount" ? magnitude : credit ? -magnitude : value;
    return { amount: toMajor(toMinor(canonical)), currency: own };
  };

  // --- Accounting readiness: the draft-bill contract.
  const blockers = issues
    .filter((issue) => issue.severity === "error")
    .map(({ code, message }) => ({ code, message }));
  if (credit) {
    blockers.push({
      code: "credit_note_unsupported",
      message:
        "This is a credit note. Accounting delivery creates draft bills, so credit notes are not posted; record it in the accounting system by hand.",
    });
  }

  const hasErrors = issues.some((issue) => issue.severity === "error");
  return {
    version: VALIDATION_VERSION,
    status: hasErrors
      ? "invalid"
      : issues.length > 0
        ? "needs_review"
        : "valid",
    documentType,
    taxBasis,
    currency,
    totals: {
      net: money("netAmount"),
      discount: money("discountAmount"),
      tax: money("vatAmount"),
      gross: money("grossAmount"),
    },
    checks,
    issues,
    identity: {
      key: identity ? identityKey(identity) : null,
      duplicateOf,
      creditsInvoiceId,
    },
    accounting: {
      ready: blockers.length === 0,
      requiredFields: ACCOUNTING_REQUIRED_FIELDS,
      blockers,
    },
  };
}

/**
 * The accounting verdict for a stored invoice: the persisted validation when
 * it was made by the current rules, otherwise the extraction validated now
 * (without history, so a legacy record is never blocked as a duplicate it
 * was not checked for).
 */
export function accountingReadiness(
  extraction: unknown,
  validation: unknown,
): InvoiceValidation["accounting"] {
  const stored = asRecord(validation);
  if (
    stored.version === VALIDATION_VERSION &&
    asRecord(stored.accounting).blockers
  ) {
    return stored.accounting as InvoiceValidation["accounting"];
  }
  return validateInvoice(extraction).accounting;
}
