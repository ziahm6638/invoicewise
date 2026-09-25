/**
 * Authorization sources: the jobs, purchase orders and contracts invoices are
 * checked against.
 *
 * Plain code, no model, and no Node-only imports, so the dashboard can share
 * the vocabulary. Every way a source arrives (dashboard form, CSV import, REST
 * batch) is normalised and validated here with the same rules, so a row the
 * import refuses is refused for the same reason everywhere.
 *
 * `docs/authorization-sources.md` publishes these rules and the CSV format.
 */

export const AUTHORIZATION_SOURCE_TYPES = [
  "job",
  "purchase_order",
  "contract",
] as const;
export type AuthorizationSourceType =
  (typeof AUTHORIZATION_SOURCE_TYPES)[number];

export const AUTHORIZATION_SOURCE_STATUSES = [
  "open",
  "closed",
  "cancelled",
] as const;
export type AuthorizationSourceStatus =
  (typeof AUTHORIZATION_SOURCE_STATUSES)[number];

/** Whether authorized amounts exclude tax, include it, or tax does not apply. */
export const AUTHORIZATION_TAX_BASES = [
  "exclusive",
  "inclusive",
  "not_applicable",
] as const;
export type AuthorizationTaxBasis = (typeof AUTHORIZATION_TAX_BASES)[number];

export const AUTHORIZATION_SOURCE_TYPE_LABELS: Record<
  AuthorizationSourceType,
  string
> = {
  job: "Job",
  purchase_order: "Purchase order",
  contract: "Contract",
};

export const AUTHORIZATION_TAX_BASIS_LABELS: Record<
  AuthorizationTaxBasis,
  string
> = {
  exclusive: "Amounts exclude tax",
  inclusive: "Amounts include tax",
  not_applicable: "No tax applies",
};

export const AUTHORIZATION_SOURCE_LIMITS = {
  /** Sources in one REST batch or one CSV import. */
  maxSourcesPerBatch: 500,
  maxLinesPerSource: 500,
  maxCsvBytes: 2_000_000,
  maxCsvRows: 5_000,
  referenceLength: 100,
  titleLength: 200,
  scopeLength: 4_000,
  textLength: 500,
  /** Largest authorized amount, in major units. */
  maxAmount: 1_000_000_000_000,
} as const;

/** One authorized line as stored: money as fixed two-decimal strings. */
export type AuthorizationLine = {
  reference: string | null;
  description: string;
  quantity: string | null;
  unitPrice: string | null;
  amount: string;
};

export type AuthorizationSupplierInput = {
  /** An existing workspace supplier chosen explicitly. */
  id: string | null;
  name: string | null;
  vatNumber: string | null;
  companyNumber: string | null;
};

/** A validated, normalised source as supplied (one version's terms). */
export type AuthorizationTerms = {
  type: AuthorizationSourceType;
  reference: string;
  /** The reference compared without spacing, punctuation or case. */
  referenceKey: string;
  /** Null when not supplied: new sources open, amendments keep their status. */
  status: AuthorizationSourceStatus | null;
  title: string | null;
  scope: string | null;
  supplier: AuthorizationSupplierInput;
  /** Null when not supplied; recorded as missing, never assumed. */
  currency: string | null;
  taxBasis: AuthorizationTaxBasis | null;
  issuedOn: string | null;
  startsOn: string | null;
  endsOn: string | null;
  /** Null when not supplied; the service picks the default. */
  effectiveFrom: string | null;
  authorizedTotal: string;
  lines: AuthorizationLine[];
  changeReason: string | null;
};

export type AuthorizationIssue = {
  field: string;
  message: string;
  /** Index of the offending line, for line-level fields. */
  line?: number;
};

export type NormalizedAuthorizationSource =
  | { ok: true; terms: AuthorizationTerms }
  | { ok: false; issues: AuthorizationIssue[] };

// --- Small parsers ---------------------------------------------------------------

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const isBlank = (value: unknown) =>
  value === undefined ||
  value === null ||
  (typeof value === "string" && value.trim() === "");

/** A source or document reference compared without spacing, punctuation or case. */
export const authorizationReferenceKey = (value: unknown) =>
  typeof value === "string"
    ? value.toUpperCase().replace(/[^A-Z0-9]/g, "")
    : "";

const token = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

const TYPE_ALIASES: Record<string, AuthorizationSourceType> = {
  job: "job",
  purchase_order: "purchase_order",
  po: "purchase_order",
  contract: "contract",
};

const STATUS_ALIASES: Record<string, AuthorizationSourceStatus> = {
  open: "open",
  closed: "closed",
  cancelled: "cancelled",
  canceled: "cancelled",
};

const TAX_BASIS_ALIASES: Record<string, AuthorizationTaxBasis> = {
  exclusive: "exclusive",
  net: "exclusive",
  inclusive: "inclusive",
  gross: "inclusive",
  not_applicable: "not_applicable",
  none: "not_applicable",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const knownCurrencies = (() => {
  try {
    return new Set(Intl.supportedValuesOf("currency"));
  } catch {
    return null;
  }
})();

/** Whether `value` is a real `YYYY-MM-DD` calendar date. */
export const isIsoDate = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
};

/**
 * A non-negative decimal as an integer count of 10^-scale units, or null.
 * Accepts plain numbers and strings with optional thousands separators;
 * refuses anything with more decimals than `scale`, so no amount is rounded
 * silently.
 */
export const parseDecimal = (
  value: unknown,
  scale: number,
): bigint | "invalid" | "precision" | null => {
  if (isBlank(value)) return null;
  let text: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "invalid";
    text = String(value);
    if (/e/i.test(text)) return "invalid";
  } else if (typeof value === "string") {
    text = value.trim();
    if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(text)) text = text.replace(/,/g, "");
  } else {
    return "invalid";
  }
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return "invalid";
  const [, whole = "0", fraction = ""] = match;
  const trimmed = fraction.replace(/0+$/, "");
  if (trimmed.length > scale) return "precision";
  return BigInt(whole + trimmed.padEnd(scale, "0"));
};

/** An integer count of 10^-scale units as a fixed decimal string. */
export const formatDecimal = (units: bigint, scale: number) => {
  const digits = units.toString().padStart(scale + 1, "0");
  return scale === 0
    ? digits
    : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
};

/** Trims a decimal string's redundant trailing zeros (quantities, unit prices). */
const formatQuantity = (units: bigint, scale: number) =>
  formatDecimal(units, scale).replace(/\.?0+$/, "") || "0";

const MAX_MINOR = BigInt(AUTHORIZATION_SOURCE_LIMITS.maxAmount) * 100n;

// --- Normalisation ---------------------------------------------------------------

/**
 * Validates one source as supplied by a form, a REST client or a CSV group and
 * returns its normalised terms, or every problem found (not just the first).
 */
export function normalizeAuthorizationSource(
  input: unknown,
): NormalizedAuthorizationSource {
  const record = asRecord(input);
  const issues: AuthorizationIssue[] = [];
  const issue = (field: string, message: string, line?: number) =>
    issues.push(
      line === undefined ? { field, message } : { field, message, line },
    );

  const text = (field: string, value: unknown, max: number, line?: number) => {
    if (isBlank(value)) return null;
    if (typeof value !== "string" && typeof value !== "number") {
      issue(field, "Must be text.", line);
      return null;
    }
    const trimmed = String(value).trim();
    if (trimmed.length > max) {
      issue(field, `Must be at most ${max} characters.`, line);
      return null;
    }
    return trimmed;
  };

  const choice = <T extends string>(
    field: string,
    value: unknown,
    aliases: Record<string, T>,
    allowed: readonly T[],
  ): T | null => {
    if (isBlank(value)) return null;
    const found = typeof value === "string" ? aliases[token(value)] : undefined;
    if (!found) {
      issue(field, `Must be one of: ${allowed.join(", ")}.`);
      return null;
    }
    return found;
  };

  const dateOf = (field: string, value: unknown) => {
    if (isBlank(value)) return null;
    if (typeof value !== "string" || !isIsoDate(value.trim())) {
      issue(field, "Must be a date written as YYYY-MM-DD.");
      return null;
    }
    return value.trim();
  };

  // Identity
  let type: AuthorizationSourceType | null = null;
  if (isBlank(record.type)) issue("type", "Is required.");
  else
    type = choice(
      "type",
      record.type,
      TYPE_ALIASES,
      AUTHORIZATION_SOURCE_TYPES,
    );

  const reference = text(
    "reference",
    record.reference,
    AUTHORIZATION_SOURCE_LIMITS.referenceLength,
  );
  const referenceKey = authorizationReferenceKey(reference);
  if (isBlank(record.reference)) issue("reference", "Is required.");
  else if (reference !== null && !referenceKey) {
    issue("reference", "Must contain at least one letter or digit.");
  }

  const status = choice(
    "status",
    record.status,
    STATUS_ALIASES,
    AUTHORIZATION_SOURCE_STATUSES,
  );
  const title = text(
    "title",
    record.title,
    AUTHORIZATION_SOURCE_LIMITS.titleLength,
  );
  const scope = text(
    "scope",
    record.scope,
    AUTHORIZATION_SOURCE_LIMITS.scopeLength,
  );
  const changeReason = text(
    "changeReason",
    record.changeReason,
    AUTHORIZATION_SOURCE_LIMITS.textLength,
  );

  // Supplier
  const supplierRecord = asRecord(record.supplier);
  let supplierId: string | null = null;
  if (!isBlank(supplierRecord.id)) {
    if (
      typeof supplierRecord.id === "string" &&
      UUID.test(supplierRecord.id.trim())
    ) {
      supplierId = supplierRecord.id.trim().toLowerCase();
    } else {
      issue("supplier.id", "Must be a supplier id.");
    }
  }
  const supplier: AuthorizationSupplierInput = {
    id: supplierId,
    name: text(
      "supplier.name",
      supplierRecord.name,
      AUTHORIZATION_SOURCE_LIMITS.titleLength,
    ),
    vatNumber: text("supplier.vatNumber", supplierRecord.vatNumber, 40),
    companyNumber: text(
      "supplier.companyNumber",
      supplierRecord.companyNumber,
      40,
    ),
  };

  // Currency and tax
  let currency: string | null = null;
  if (!isBlank(record.currency)) {
    const code =
      typeof record.currency === "string"
        ? record.currency.trim().toUpperCase()
        : "";
    if (
      /^[A-Z]{3}$/.test(code) &&
      (knownCurrencies === null || knownCurrencies.has(code))
    ) {
      currency = code;
    } else {
      issue("currency", "Must be a three-letter ISO 4217 currency code.");
    }
  }
  const taxBasis = choice(
    "taxBasis",
    record.taxBasis,
    TAX_BASIS_ALIASES,
    AUTHORIZATION_TAX_BASES,
  );

  // Dates
  const issuedOn = dateOf("issuedOn", record.issuedOn);
  const startsOn = dateOf("startsOn", record.startsOn);
  const endsOn = dateOf("endsOn", record.endsOn);
  const effectiveFrom = dateOf("effectiveFrom", record.effectiveFrom);
  if (startsOn && endsOn && endsOn < startsOn) {
    issue("endsOn", "Must not be before the start date.");
  }

  // Lines and amounts
  const lines: AuthorizationLine[] = [];
  let lineTotal = 0n;
  const rawLines = record.lines;
  if (!isBlank(rawLines) && !Array.isArray(rawLines)) {
    issue("lines", "Must be a list of lines.");
  }
  const lineInputs = Array.isArray(rawLines) ? rawLines : [];
  if (lineInputs.length > AUTHORIZATION_SOURCE_LIMITS.maxLinesPerSource) {
    issue(
      "lines",
      `At most ${AUTHORIZATION_SOURCE_LIMITS.maxLinesPerSource} lines per source.`,
    );
  }
  const lineReferences = new Map<string, number>();
  lineInputs
    .slice(0, AUTHORIZATION_SOURCE_LIMITS.maxLinesPerSource)
    .forEach((raw, index) => {
      const line = asRecord(raw);
      const before = issues.length;
      const lineReference = text(
        "lines.reference",
        line.reference,
        AUTHORIZATION_SOURCE_LIMITS.referenceLength,
        index,
      );
      if (lineReference) {
        const key = authorizationReferenceKey(lineReference) || lineReference;
        const earlier = lineReferences.get(key);
        if (earlier !== undefined) {
          issue(
            "lines.reference",
            `Repeats the reference of line ${earlier + 1}.`,
            index,
          );
        } else {
          lineReferences.set(key, index);
        }
      }
      const description = text(
        "lines.description",
        line.description,
        AUTHORIZATION_SOURCE_LIMITS.textLength,
        index,
      );
      if (!description) issue("lines.description", "Is required.", index);

      const decimal = (field: string, value: unknown, scale: number) => {
        const parsed = parseDecimal(value, scale);
        if (parsed === "invalid") {
          issue(field, "Must be a non-negative number.", index);
          return null;
        }
        if (parsed === "precision") {
          issue(field, `Must have at most ${scale} decimal places.`, index);
          return null;
        }
        return parsed;
      };
      const quantity = decimal("lines.quantity", line.quantity, 4);
      const unitPrice = decimal("lines.unitPrice", line.unitPrice, 4);
      let amount = decimal("lines.amount", line.amount, 2);

      if (quantity !== null && unitPrice !== null) {
        // quantity (4 dp) × unit price (4 dp) = 8 dp; round half up to 2 dp.
        const product = quantity * unitPrice;
        const expected = (product + 500_000n) / 1_000_000n;
        if (amount === null && isBlank(line.amount)) {
          amount = expected;
        } else if (amount !== null) {
          const difference =
            amount > expected ? amount - expected : expected - amount;
          if (difference > 1n) {
            issue(
              "lines.amount",
              `Does not equal quantity × unit price (${formatDecimal(expected, 2)}).`,
              index,
            );
          }
        }
      } else if (isBlank(line.amount)) {
        issue(
          "lines.amount",
          "Is required (or give both quantity and unit price).",
          index,
        );
      }
      if (amount !== null && amount > MAX_MINOR) {
        issue("lines.amount", "Is too large.", index);
      }
      if (issues.length === before && description && amount !== null) {
        lineTotal += amount;
        lines.push({
          reference: lineReference,
          description,
          quantity: quantity === null ? null : formatQuantity(quantity, 4),
          unitPrice: unitPrice === null ? null : formatQuantity(unitPrice, 4),
          amount: formatDecimal(amount, 2),
        });
      }
    });

  let authorizedTotal: string | null = null;
  const total = parseDecimal(record.authorizedTotal, 2);
  if (total === "invalid") {
    issue("authorizedTotal", "Must be a non-negative number.");
  } else if (total === "precision") {
    issue("authorizedTotal", "Must have at most 2 decimal places.");
  } else if (total !== null && total > MAX_MINOR) {
    issue("authorizedTotal", "Is too large.");
  } else if (lineInputs.length > 0) {
    if (
      total !== null &&
      total !== lineTotal &&
      issues.every((i) => i.line === undefined)
    ) {
      issue(
        "authorizedTotal",
        `Does not equal the sum of the line amounts (${formatDecimal(lineTotal, 2)}).`,
      );
    }
    authorizedTotal = formatDecimal(lineTotal, 2);
  } else if (total !== null) {
    authorizedTotal = formatDecimal(total, 2);
  } else {
    issue(
      "authorizedTotal",
      "Give an authorized total or at least one authorized line.",
    );
  }

  if (issues.length > 0 || !type || !reference || authorizedTotal === null) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    terms: {
      type,
      reference,
      referenceKey,
      status,
      title,
      scope,
      supplier,
      currency,
      taxBasis,
      issuedOn,
      startsOn,
      endsOn,
      effectiveFrom,
      authorizedTotal,
      lines,
      changeReason,
    },
  };
}

// --- Gaps ------------------------------------------------------------------------

export type AuthorizationGap = {
  code: "unknown_supplier" | "missing_currency" | "missing_tax_basis";
  message: string;
};

/** What a source does not say, stated explicitly rather than guessed. */
export function authorizationSourceGaps(source: {
  supplierId: string | null;
  currency: string | null;
  taxBasis?: string | null;
}): AuthorizationGap[] {
  const gaps: AuthorizationGap[] = [];
  if (!source.supplierId) {
    gaps.push({
      code: "unknown_supplier",
      message: "Not linked to a workspace supplier.",
    });
  }
  if (!source.currency) {
    gaps.push({
      code: "missing_currency",
      message: "No currency was given, so amounts cannot be compared.",
    });
  }
  if (source.taxBasis === null) {
    gaps.push({
      code: "missing_tax_basis",
      message: "It is not stated whether amounts include tax.",
    });
  }
  return gaps;
}

// --- CSV ---------------------------------------------------------------------------

/**
 * The documented import columns, in template order. One row per authorized
 * line; rows sharing `source_type` and `reference` form one source, so a
 * source with three lines is three rows. A source without lines is one row
 * with `authorized_total` and the line columns empty.
 */
export const AUTHORIZATION_SOURCE_CSV_COLUMNS = [
  "source_type",
  "reference",
  "status",
  "title",
  "scope",
  "supplier_name",
  "supplier_vat_number",
  "supplier_company_number",
  "supplier_id",
  "currency",
  "tax_basis",
  "issued_on",
  "starts_on",
  "ends_on",
  "effective_from",
  "authorized_total",
  "change_reason",
  "line_reference",
  "line_description",
  "quantity",
  "unit_price",
  "line_amount",
] as const;

type CsvColumn = (typeof AUTHORIZATION_SOURCE_CSV_COLUMNS)[number];

const LINE_COLUMNS: readonly CsvColumn[] = [
  "line_reference",
  "line_description",
  "quantity",
  "unit_price",
  "line_amount",
];

const HEADER_COLUMNS = AUTHORIZATION_SOURCE_CSV_COLUMNS.filter(
  (column) => !LINE_COLUMNS.includes(column),
);

/** Where each normalised field came from, for row-level CSV errors. */
const FIELD_COLUMNS: Record<string, CsvColumn> = {
  type: "source_type",
  reference: "reference",
  status: "status",
  title: "title",
  scope: "scope",
  "supplier.name": "supplier_name",
  "supplier.vatNumber": "supplier_vat_number",
  "supplier.companyNumber": "supplier_company_number",
  "supplier.id": "supplier_id",
  currency: "currency",
  taxBasis: "tax_basis",
  issuedOn: "issued_on",
  startsOn: "starts_on",
  endsOn: "ends_on",
  effectiveFrom: "effective_from",
  authorizedTotal: "authorized_total",
  changeReason: "change_reason",
  lines: "line_description",
  "lines.reference": "line_reference",
  "lines.description": "line_description",
  "lines.quantity": "quantity",
  "lines.unitPrice": "unit_price",
  "lines.amount": "line_amount",
};

export type AuthorizationRowError = {
  /** 1-based line of the CSV file (the header is row 1). */
  row: number;
  column: string | null;
  reference: string | null;
  message: string;
};

export type ParsedAuthorizationCsv = {
  /** Raw source inputs, one per `source_type` + `reference`, in file order. */
  sources: { input: Record<string, unknown>; rows: number[] }[];
  errors: AuthorizationRowError[];
};

/** RFC 4180 records: quoted fields, doubled quotes, CRLF or LF line ends. */
export function parseCsvRecords(text: string): {
  records: string[][];
  error: string | null;
} {
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let quoted = false;
  let index = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const pushRecord = () => {
    record.push(field);
    records.push(record);
    record = [];
    field = "";
  };
  for (; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index++;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"' && field === "") {
      quoted = true;
    } else if (char === ",") {
      record.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index++;
      pushRecord();
    } else {
      field += char;
    }
  }
  if (quoted) return { records, error: "A quoted field is never closed." };
  if (field !== "" || record.length > 0) pushRecord();
  return { records, error: null };
}

/**
 * Parses an import file into source inputs plus row-level errors. Structural
 * problems (unknown columns, inconsistent source rows) are reported here; the
 * values themselves are validated by `normalizeAuthorizationSource`, whose
 * issues `csvRowErrors` maps back to rows.
 */
export function parseAuthorizationSourcesCsv(
  text: string,
): ParsedAuthorizationCsv {
  const errors: AuthorizationRowError[] = [];
  const fail = (message: string) => ({
    sources: [],
    errors: [{ row: 1, column: null, reference: null, message }],
  });
  if (text.length > AUTHORIZATION_SOURCE_LIMITS.maxCsvBytes) {
    return fail(
      `The file is larger than ${AUTHORIZATION_SOURCE_LIMITS.maxCsvBytes / 1_000_000} MB.`,
    );
  }
  const { records, error } = parseCsvRecords(text);
  if (error) return fail(error);
  const [header, ...rest] = records;
  if (!header || header.every((cell) => cell.trim() === "")) {
    return fail("The file is empty.");
  }
  const columns = header.map((cell) => cell.trim().toLowerCase());
  const unknown = columns.filter(
    (column) =>
      column !== "" &&
      !(AUTHORIZATION_SOURCE_CSV_COLUMNS as readonly string[]).includes(column),
  );
  if (unknown.length > 0) {
    return fail(`Unknown column: ${unknown.join(", ")}.`);
  }
  const repeated = columns.filter(
    (column, index) => column !== "" && columns.indexOf(column) !== index,
  );
  if (repeated.length > 0) {
    return fail(`Repeated column: ${[...new Set(repeated)].join(", ")}.`);
  }
  for (const required of ["source_type", "reference"]) {
    if (!columns.includes(required)) {
      return fail(`Missing required column: ${required}.`);
    }
  }
  if (rest.length > AUTHORIZATION_SOURCE_LIMITS.maxCsvRows) {
    return fail(
      `The file has more than ${AUTHORIZATION_SOURCE_LIMITS.maxCsvRows} rows.`,
    );
  }

  type Group = {
    first: Record<CsvColumn, string>;
    firstRow: number;
    rows: number[];
    lines: Record<string, unknown>[];
  };
  const groups = new Map<string, Group>();

  rest.forEach((cells, offset) => {
    const row = offset + 2;
    if (cells.every((cell) => cell.trim() === "")) return;
    if (cells.length > columns.length) {
      errors.push({
        row,
        column: null,
        reference: null,
        message: `Has ${cells.length} fields; the header has ${columns.length}.`,
      });
      return;
    }
    const values = {} as Record<CsvColumn, string>;
    for (const column of AUTHORIZATION_SOURCE_CSV_COLUMNS) {
      const at = columns.indexOf(column);
      values[column] = at === -1 ? "" : (cells[at] ?? "").trim();
    }
    const typeKey =
      TYPE_ALIASES[token(values.source_type)] ?? values.source_type;
    const key = `${typeKey}\u0000${authorizationReferenceKey(values.reference) || values.reference}`;
    let group = groups.get(key);
    if (!group) {
      group = { first: values, firstRow: row, rows: [], lines: [] };
      groups.set(key, group);
    } else {
      for (const column of HEADER_COLUMNS) {
        if (
          column !== "reference" &&
          column !== "source_type" &&
          values[column] !== "" &&
          values[column] !== group.first[column]
        ) {
          errors.push({
            row,
            column,
            reference: values.reference || null,
            message: `Differs from row ${group.firstRow} of the same source ("${group.first[column]}"); every row of one source must agree.`,
          });
        }
      }
    }
    group.rows.push(row);
    if (LINE_COLUMNS.some((column) => values[column] !== "")) {
      group.lines.push({
        reference: values.line_reference,
        description: values.line_description,
        quantity: values.quantity,
        unitPrice: values.unit_price,
        amount: values.line_amount,
        row,
      });
    }
  });

  if (groups.size > AUTHORIZATION_SOURCE_LIMITS.maxSourcesPerBatch) {
    return fail(
      `The file has more than ${AUTHORIZATION_SOURCE_LIMITS.maxSourcesPerBatch} sources.`,
    );
  }

  const sources = [...groups.values()].map((group) => {
    const first = group.first;
    return {
      rows: group.rows,
      input: {
        type: first.source_type,
        reference: first.reference,
        status: first.status,
        title: first.title,
        scope: first.scope,
        supplier: {
          id: first.supplier_id,
          name: first.supplier_name,
          vatNumber: first.supplier_vat_number,
          companyNumber: first.supplier_company_number,
        },
        currency: first.currency,
        taxBasis: first.tax_basis,
        issuedOn: first.issued_on,
        startsOn: first.starts_on,
        endsOn: first.ends_on,
        effectiveFrom: first.effective_from,
        authorizedTotal: first.authorized_total,
        changeReason: first.change_reason,
        lines: group.lines,
      },
    };
  });

  return { sources, errors };
}

/** Maps `normalizeAuthorizationSource` issues for one CSV group back to rows. */
export function csvRowErrors(
  source: { input: Record<string, unknown>; rows: number[] },
  issues: readonly AuthorizationIssue[],
): AuthorizationRowError[] {
  const lines = Array.isArray(source.input.lines)
    ? (source.input.lines as { row?: number }[])
    : [];
  const reference =
    typeof source.input.reference === "string" && source.input.reference
      ? source.input.reference
      : null;
  return issues.map((item) => ({
    row:
      item.line !== undefined
        ? (lines[item.line]?.row ?? source.rows[0] ?? 1)
        : (source.rows[0] ?? 1),
    column: FIELD_COLUMNS[item.field] ?? null,
    reference,
    message: item.message,
  }));
}

/** A CSV template with one example of each source type. */
export const AUTHORIZATION_SOURCE_CSV_TEMPLATE = `${AUTHORIZATION_SOURCE_CSV_COLUMNS.join(",")}
job,JOB-1042,open,Kitchen refit,Strip out and refit kitchen at 12 High St,Northwind Joinery Ltd,GB293445512,,,GBP,exclusive,2026-09-01,2026-09-07,2026-10-31,,,,1,Labour,40,45,1800.00
job,JOB-1042,open,Kitchen refit,Strip out and refit kitchen at 12 High St,Northwind Joinery Ltd,GB293445512,,,GBP,exclusive,2026-09-01,2026-09-07,2026-10-31,,,,2,Materials,,,2400.00
purchase_order,PO-55120,open,Timber,,Northwind Joinery Ltd,GB293445512,,,GBP,exclusive,2026-09-02,,,,,,1,Oak boards,120,18.5,2220.00
contract,CT-2026-07,open,Grounds maintenance 2026/27,Monthly grounds maintenance for all sites,Acme Supplies Ltd,,01234567,,GBP,inclusive,2026-04-01,2026-04-01,2027-03-31,,14400.00,,,,,,
`;
