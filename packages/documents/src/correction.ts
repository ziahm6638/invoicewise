/**
 * User corrections of an extracted invoice.
 *
 * A correction replaces field values in the canonical record
 * (`InvoiceExtraction`) and nothing else: every value is checked against the
 * same shape the reader produces, a corrected value's evidence says it came
 * from a user rather than a printed row, and the change list keeps each
 * field's value before and after. Validation then runs on the corrected record
 * exactly as it does on a fresh reading. Line items are not correctable here.
 *
 * `docs/delivery.md#corrections` publishes the workflow around it.
 */
import type {
  FieldEvidence,
  InvoiceEvidenceField,
  InvoiceExtraction,
} from "./typesafe/invoice";

const TEXT_FIELDS = [
  "supplierName",
  "supplierAddress",
  "supplierVatNumber",
  "supplierCompanyNumber",
  "invoiceNumber",
  "originalInvoiceNumber",
  "description",
  "purchaseOrderReference",
  "paymentReference",
] as const;

const DATE_FIELDS = ["invoiceDate", "dueDate"] as const;

const AMOUNT_FIELDS = [
  "netAmount",
  "discountAmount",
  "vatAmount",
  "grossAmount",
] as const;

const BANK_FIELDS = [
  "accountName",
  "accountNumber",
  "sortCode",
  "iban",
  "bic",
] as const;

/** Every field a user may correct, in the order the dashboard shows them. */
export const CORRECTABLE_FIELDS = [
  "documentType",
  ...TEXT_FIELDS.slice(0, 6),
  ...DATE_FIELDS,
  "currency",
  ...AMOUNT_FIELDS,
  "taxRate",
  "amountsIncludeTax",
  ...TEXT_FIELDS.slice(6),
  ...BANK_FIELDS,
] as const satisfies readonly InvoiceEvidenceField[];

export type CorrectableField = (typeof CORRECTABLE_FIELDS)[number];

export type InvoiceCorrectionInput = Partial<
  Record<CorrectableField, string | number | boolean | null>
>;

export type FieldChange = {
  field: CorrectableField;
  from: string | number | boolean | null;
  to: string | number | boolean | null;
};

export type CorrectionError = {
  field: CorrectableField | null;
  message: string;
};

export type CorrectionResult =
  | { ok: true; extraction: InvoiceExtraction; changes: FieldChange[] }
  | { ok: false; errors: CorrectionError[] };

/** The largest amount the invoice columns can hold (numeric(10, 2)). */
export const MAX_CORRECTED_AMOUNT = 99_999_999.99;
const MAX_TEXT_LENGTH = 500;
export const MAX_CORRECTION_REASON_LENGTH = 500;

const isBankField = (field: CorrectableField) =>
  (BANK_FIELDS as readonly string[]).includes(field);

const currentValue = (
  extraction: InvoiceExtraction,
  field: CorrectableField,
): string | number | boolean | null => {
  const value = isBankField(field)
    ? extraction.bankDetails?.[field as (typeof BANK_FIELDS)[number]]
    : extraction[field as keyof InvoiceExtraction];
  return typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
    ? value
    : null;
};

const validDate = (value: string) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(date.getTime()) &&
    date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() + 1 === Number(match[2]) &&
    date.getUTCDate() === Number(match[3])
  );
};

const hasAtMostTwoDecimals = (value: number) =>
  Math.abs(Math.round(value * 100) - value * 100) < 1e-6;

type Normalized =
  | { ok: true; value: string | number | boolean | null }
  | { ok: false; message: string };

/** Checks one submitted value against the canonical field's shape. */
const normalizeValue = (field: CorrectableField, raw: unknown): Normalized => {
  if (raw === null) return { ok: true, value: null };
  if (field === "documentType") {
    return raw === "invoice" || raw === "credit_note"
      ? { ok: true, value: raw }
      : { ok: false, message: "Choose invoice or credit note" };
  }
  if (field === "amountsIncludeTax") {
    return typeof raw === "boolean"
      ? { ok: true, value: raw }
      : { ok: false, message: "Choose whether amounts include VAT" };
  }
  if ((AMOUNT_FIELDS as readonly string[]).includes(field)) {
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      return { ok: false, message: "Enter an amount" };
    }
    if (!hasAtMostTwoDecimals(raw)) {
      return { ok: false, message: "Use at most two decimal places" };
    }
    if (Math.abs(raw) > MAX_CORRECTED_AMOUNT) {
      return { ok: false, message: "The amount is too large" };
    }
    if (field === "discountAmount" && raw < 0) {
      return { ok: false, message: "Enter the discount as a positive amount" };
    }
    return { ok: true, value: Math.round(raw * 100) / 100 };
  }
  if (field === "taxRate") {
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      return { ok: false, message: "Enter a VAT rate" };
    }
    if (raw < 0 || raw > 100 || !hasAtMostTwoDecimals(raw)) {
      return {
        ok: false,
        message: "Enter a rate from 0 to 100 with at most two decimals",
      };
    }
    return { ok: true, value: raw };
  }
  if (typeof raw !== "string") {
    return { ok: false, message: "Enter text" };
  }
  const text = raw.trim();
  if (!text) return { ok: true, value: null };
  if (text.length > MAX_TEXT_LENGTH) {
    return {
      ok: false,
      message: `Use at most ${MAX_TEXT_LENGTH} characters`,
    };
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text)) {
    return { ok: false, message: "Remove control characters" };
  }
  if ((DATE_FIELDS as readonly string[]).includes(field)) {
    return validDate(text)
      ? { ok: true, value: text }
      : { ok: false, message: "Enter a date as YYYY-MM-DD" };
  }
  if (field === "currency") {
    const code = text.toUpperCase();
    return /^[A-Z]{3}$/.test(code)
      ? { ok: true, value: code }
      : { ok: false, message: "Enter a three-letter ISO currency code" };
  }
  if (field === "sortCode") {
    const digits = text.replace(/[\s-]/g, "");
    return /^\d{6}$/.test(digits)
      ? {
          ok: true,
          value: `${digits.slice(0, 2)}-${digits.slice(2, 4)}-${digits.slice(4)}`,
        }
      : { ok: false, message: "Enter a six-digit sort code" };
  }
  if (field === "accountNumber") {
    const digits = text.replace(/\s/g, "");
    return /^\d{6,10}$/.test(digits)
      ? { ok: true, value: digits }
      : { ok: false, message: "Enter a 6 to 10 digit account number" };
  }
  if (field === "iban") {
    const compact = text.replace(/\s/g, "").toUpperCase();
    return /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(compact)
      ? { ok: true, value: compact.replace(/(.{4})(?=.)/g, "$1 ") }
      : { ok: false, message: "Enter a valid IBAN" };
  }
  if (field === "bic") {
    const code = text.replace(/\s/g, "").toUpperCase();
    return /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(code)
      ? { ok: true, value: code }
      : { ok: false, message: "Enter an 8 or 11 character BIC" };
  }
  return { ok: true, value: text };
};

/**
 * Applies a correction to a stored extraction. Unknown fields and values
 * that do not fit the canonical record are refused, and a submission that
 * changes nothing is refused too, so every stored correction is a real
 * change. `note` becomes the corrected fields' evidence.
 */
export function applyInvoiceCorrection(
  stored: unknown,
  input: Record<string, unknown>,
  note: string,
): CorrectionResult {
  if (typeof stored !== "object" || stored === null) {
    return {
      ok: false,
      errors: [
        {
          field: null,
          message: "This invoice has no extracted record to correct",
        },
      ],
    };
  }
  const extraction = stored as InvoiceExtraction;
  const errors: CorrectionError[] = [];
  const changes: FieldChange[] = [];
  for (const [key, raw] of Object.entries(input)) {
    if (raw === undefined) continue;
    if (!(CORRECTABLE_FIELDS as readonly string[]).includes(key)) {
      errors.push({ field: null, message: `${key} cannot be corrected` });
      continue;
    }
    const field = key as CorrectableField;
    const normalized = normalizeValue(field, raw);
    if (!normalized.ok) {
      errors.push({ field, message: normalized.message });
      continue;
    }
    const from = currentValue(extraction, field);
    if (from !== normalized.value) {
      changes.push({ field, from, to: normalized.value });
    }
  }
  if (errors.length) return { ok: false, errors };
  // History reads in the dashboard's field order, whatever order was sent.
  changes.sort(
    (a, b) =>
      CORRECTABLE_FIELDS.indexOf(a.field) - CORRECTABLE_FIELDS.indexOf(b.field),
  );
  if (changes.length === 0) {
    return {
      ok: false,
      errors: [{ field: null, message: "The correction changes no value" }],
    };
  }

  const evidence: FieldEvidence = {
    page: null,
    line: null,
    text: null,
    label: null,
    confidence: null,
    derivedFrom: note,
  };
  const fields = { ...(extraction.evidence?.fields ?? {}) };
  const bankDetails: InvoiceExtraction["bankDetails"] = {
    accountName: extraction.bankDetails?.accountName ?? null,
    accountNumber: extraction.bankDetails?.accountNumber ?? null,
    sortCode: extraction.bankDetails?.sortCode ?? null,
    iban: extraction.bankDetails?.iban ?? null,
    bic: extraction.bankDetails?.bic ?? null,
  };
  const next: Record<string, unknown> = { ...extraction };
  for (const change of changes) {
    if (isBankField(change.field)) {
      bankDetails[change.field as (typeof BANK_FIELDS)[number]] = change.to as
        | string
        | null;
    } else {
      next[change.field] = change.to;
    }
    if (change.to === null) delete fields[change.field];
    else fields[change.field] = evidence;
  }
  return {
    ok: true,
    changes,
    extraction: {
      ...(next as InvoiceExtraction),
      bankDetails,
      evidence: {
        fields,
        lineItems: extraction.evidence?.lineItems ?? [],
      },
    },
  };
}

/** Whether a change moves the identity a bill is posted under. */
export const changesPostingIdentity = (changes: readonly FieldChange[]) =>
  changes.some(
    (change) =>
      change.field === "invoiceNumber" || change.field === "documentType",
  );

/**
 * The invoice columns derived from an extraction (list amount, currency,
 * date, supplier and tax), identical for a fresh reading and a correction.
 */
export const invoiceColumnsFromExtraction = (
  extraction: InvoiceExtraction,
) => ({
  displayName: extraction.supplierName,
  date: extraction.dueDate ?? extraction.invoiceDate,
  amount: extraction.grossAmount,
  currency: extraction.currency,
  description: extraction.description,
  taxAmount: extraction.vatAmount,
  taxRate:
    extraction.taxRate ??
    (extraction.netAmount && extraction.vatAmount !== null
      ? (extraction.vatAmount / extraction.netAmount) * 100
      : null),
  taxType: extraction.vatAmount === null ? null : "vat",
});
