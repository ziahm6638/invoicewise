/**
 * Line-item rows from invoice tables.
 *
 * A table is found by its header row (Description / Qty / Unit price /
 * Amount ...), read as an ordered list of column roles; cells printed close
 * together can share one text segment, so roles come from the header's words
 * rather than its segments. Each following row until the totals keeps its
 * description and ends in one number per numeric column, so the row's last N
 * numbers map to the header's N numeric columns in order, and any earlier
 * number (a date such as "1 DEC 25") stays in the description. Arithmetic
 * (quantity x unit price = total) settles rows that do not line up with the
 * header, and finds rows when there is no header at all. Rows without numbers
 * continue the previous row's description, as wrapped descriptions do.
 * TypeSafe then confirms which rows are purchased items.
 */
import type { DocumentLine } from "../layout";
import { parseMoney } from "./candidates";

/**
 * One printed table row. Every value is as printed; a column the table does
 * not have is null rather than assumed (no tax column is not "0% VAT").
 */
export type InvoiceLineItem = {
  description: string | null;
  quantity: number | null;
  unitPrice: number | null;
  /** A discount printed as a money amount, as a positive magnitude. */
  discountAmount: number | null;
  /** A discount printed as a percentage of quantity x unit price. */
  discountRate: number | null;
  /** The row's VAT or tax rate in percent, when the table prints one. */
  taxRate: number | null;
  /** The row's VAT or tax amount, when the table prints one. */
  taxAmount: number | null;
  /** The row's amount, net of any row discount. */
  total: number | null;
};

export type LineItemRow = {
  id: string;
  value: InvoiceLineItem;
  /** Index of the row's first document line. */
  line: number;
  /** The row as printed, including wrapped description lines. */
  source: string;
  header: string | null;
  /**
   * Whether the header says the row amounts include tax ("Total inc VAT",
   * "Gross"), exclude it ("Net", "ex VAT"), or does not say (null).
   */
  includesTax: boolean | null;
};

type Role =
  | "description"
  | "quantity"
  | "unitPrice"
  | "total"
  | "gross"
  | "vat"
  | "discount";

/** Header vocabulary, longest phrases first, each with the column it names. */
const HEADER_TERMS: [RegExp, Role][] = (
  [
    [
      /^(?:unit ?(?:price|cost|rate)|price ?(?:each|per unit)|rate ?per)/,
      "unitPrice",
    ],
    [/^(?:vat|tax) ?(?:rate|%|amount|amt)?/, "vat"],
    [/^disc(?:ount)?\.? ?%?/, "discount"],
    [/^gross ?(?:amount|total|value)?/, "gross"],
    [
      /^(?:line ?total|net ?amount|total ?amount|amount|total|net|value|sum|subtotal)/,
      "total",
    ],
    [/^(?:qty|quantity|hours?|hrs|days|units|no\.? ?of|count)/, "quantity"],
    [/^(?:price|rate|each|cost|fee)/, "unitPrice"],
    [
      /^(?:description|item|items|details?|services?|products?|particulars|work|goods)/,
      "description",
    ],
  ] as [RegExp, Role][]
).map(([pattern, role]) => [
  // Whole words only: "net" names a column, "network" does not. Words
  // inside a term are one space apart; two spaces are a column gap.
  new RegExp(`${pattern.source}(?![a-z])`),
  role,
]);

/** Words a header may carry besides its column names. */
const HEADER_FILLER =
  /^(?:\(?(?:gbp|eur|usd|£|€|\$)\)?|ex\.?|excl?\.?|inc\.?|incl\.?|%|of|per|&|\/|-|the|no\.?|#|\(?hours?\)?)$/i;

/** "inc VAT" / "ex. VAT" after a price or amount column name. */
const TAX_QUALIFIER =
  /^\(?(inc|incl|including|inclusive of|ex|exc|excl|excluding|exclusive of)\.? ?(?:vat|tax)\)?(?![a-z])/;

type Header = { roles: Role[]; includesTax: boolean | null };

/** Column roles named by a header row, in order, or null when the row is not a header. */
const headerRoles = (line: DocumentLine): Header | null => {
  if (/\d/.test(line.text)) return null;
  const roles: Role[] = [];
  let includesTax: boolean | null = null;
  let rest = line.text.toLowerCase().trim();
  let unknown = 0;
  while (rest) {
    const qualifier = TAX_QUALIFIER.exec(rest);
    const last = roles.length - 1;
    if (qualifier && last >= 0) {
      const inclusive = qualifier[1]!.startsWith("inc");
      // "Total inc VAT" is a gross column; "Total ex VAT" a net one.
      if (inclusive && roles[last] === "total") roles[last] = "gross";
      if (["total", "gross", "unitPrice"].includes(roles[last]!)) {
        includesTax = inclusive;
      }
      rest = rest.slice(qualifier[0].length).replace(/^[\s:/|.,()-]+/, "");
      continue;
    }
    const term = HEADER_TERMS.find(([pattern]) => pattern.test(rest));
    if (term) {
      const match = term[0].exec(rest)!;
      roles.push(term[1]);
      rest = rest.slice(match[0].length).replace(/^[\s:/|.,()-]+/, "");
      continue;
    }
    const word = /^\S+/.exec(rest)![0];
    if (!HEADER_FILLER.test(word)) unknown += 1;
    rest = rest.slice(word.length).trimStart();
  }
  const numeric = roles.filter((role) => role !== "description").length;
  if (!roles.includes("description") || numeric < 1 || unknown > 2) {
    return null;
  }
  // A table whose only amount column is gross prints tax-inclusive rows; one
  // with a net or total column beside the gross column prints net rows.
  if (roles.includes("gross") && !roles.includes("total")) includesTax = true;
  if (roles.includes("gross") && roles.includes("total")) includesTax = false;
  return { roles, includesTax };
};

const TOTALS =
  /^(?:sub\s*-?\s*total|total|net(?:\s+total)?\b|vat\b|tax\b|amount\s+(?:due|payable)|balance|gross|carriage|shipping|delivery\s+charge|discount|invoice\s+total|payment|bank|account|thank)/i;

/** A totals row ("Subtotal", "VAT @ 20%", "Total due (GBP):") ends the table. */
const isTotals = (description: string) =>
  TOTALS.test(description) && description.split(" ").length <= 5;

const NUMERIC_TOKEN =
  /^-?(?:[£€$]|(?:GBP|USD|EUR|CAD|AUD|NZD|SEK|NOK|DKK|CHF))?-?\(?\d[\d,]*(?:\.\d+)?\)?(?:%|(?:GBP|USD|EUR|CAD|AUD|NZD|SEK|NOK|DKK|CHF))?$/i;

const tokens = (text: string) =>
  text
    // Keep a currency code or symbol attached to its amount.
    .replace(/\b(GBP|USD|EUR|CAD|AUD|NZD|SEK|NOK|DKK|CHF)\s+(?=-?\d)/gi, "$1")
    .replace(/([£€$])\s+(?=-?\d)/g, "$1")
    .split(/\s+/)
    .filter(Boolean);

/**
 * Splits a row into its description and its numeric cells: up to `leading`
 * numbers before the description (a quantity-first table) and up to
 * `trailing` after it.
 */
const splitRow = (
  text: string,
  trailing = Number.POSITIVE_INFINITY,
  leading = 0,
) => {
  const words = tokens(text);
  let start = 0;
  while (
    start < leading &&
    start < words.length &&
    NUMERIC_TOKEN.test(words[start]!)
  ) {
    start += 1;
  }
  const maxNumbers = trailing;
  let first = words.length;
  while (
    first > start &&
    words.length - first < maxNumbers &&
    NUMERIC_TOKEN.test(words[first - 1]!)
  ) {
    first -= 1;
  }
  return {
    description: words
      .slice(start, first)
      .join(" ")
      .replace(/[\s|–-]+$/, ""),
    numbers: [...words.slice(0, start), ...words.slice(first)],
  };
};

const close = (a: number, b: number) =>
  Math.abs(a - b) <= Math.max(0.011, Math.abs(b) * 0.005);

type Amounts = Omit<InvoiceLineItem, "description">;

const NOT_PRINTED = {
  discountAmount: null,
  discountRate: null,
  taxRate: null,
  taxAmount: null,
} as const;

/** Quantity x unit price = total among the row's numbers, total last. */
const byArithmetic = (numbers: string[]): Amounts | null => {
  const values = numbers
    .filter((token) => !token.includes("%"))
    .map((token) => parseMoney(token))
    .filter((value): value is number => value !== null);
  if (values.length === 0) return null;
  const total = values.at(-1)!;
  const earlier = values.slice(0, -1);
  for (let q = 0; q < earlier.length; q++) {
    for (let u = 0; u < earlier.length; u++) {
      if (q !== u && close(earlier[q]! * earlier[u]!, total)) {
        const [quantity, unitPrice] =
          Number.isInteger(earlier[q]!) || earlier[q]! < earlier[u]!
            ? [earlier[q]!, earlier[u]!]
            : [earlier[u]!, earlier[q]!];
        return { quantity, unitPrice, ...NOT_PRINTED, total };
      }
    }
  }
  if (earlier.length === 1 && close(earlier[0]!, total)) {
    return { quantity: 1, unitPrice: total, ...NOT_PRINTED, total };
  }
  return { quantity: null, unitPrice: null, ...NOT_PRINTED, total };
};

const percentValue = (token: string) => {
  if (!token.includes("%")) return null;
  const value = Number(token.replace(/[^\d.]/g, ""));
  return Number.isFinite(value) ? value : null;
};

/** Maps a row's numbers to the header's numeric columns, in order. */
const byHeader = (numbers: string[], roles: Role[]): Amounts | null => {
  const numericRoles: Role[] = roles.filter((role) => role !== "description");
  if (numbers.length !== numericRoles.length) return byArithmetic(numbers);
  const tokenFor = (role: Role) => {
    const index = numericRoles.lastIndexOf(role);
    return index >= 0 ? numbers[index] : undefined;
  };
  const moneyFor = (role: Role) => {
    const token = tokenFor(role);
    return token && !token.includes("%") ? parseMoney(token) : null;
  };
  const rateFor = (role: Role) => {
    const token = tokenFor(role);
    return token ? percentValue(token) : null;
  };
  const discount = moneyFor("discount");
  const item: Amounts = {
    quantity: moneyFor("quantity"),
    unitPrice: moneyFor("unitPrice"),
    discountAmount: discount === null ? null : Math.abs(discount),
    discountRate: rateFor("discount"),
    taxRate: rateFor("vat"),
    taxAmount: moneyFor("vat"),
    // The net column is the row amount when the table has one; a table that
    // prints only gross amounts is tax inclusive (`includesTax`).
    total: moneyFor("total") ?? moneyFor("gross"),
  };
  return item.total === null && item.unitPrice === null
    ? byArithmetic(numbers)
    : item;
};

/** Rows of `desc | qty | price | total`, as some plain-text exports print them. */
const pipeRow = (line: DocumentLine) => {
  const cells = line.text.split("|").map((cell) => cell.trim());
  if (cells.length < 3) return null;
  const numbers = cells.slice(1).map((cell) => tokens(cell).join(""));
  if (!numbers.every((cell) => NUMERIC_TOKEN.test(cell))) return null;
  const assigned = byArithmetic(numbers);
  return assigned ? { description: cells[0]!, ...assigned } : null;
};

export function lineItemRows(lines: readonly DocumentLine[]): LineItemRow[] {
  const rows: LineItemRow[] = [];
  let table: ({ header: DocumentLine } & Header) | null = null;
  let previous: LineItemRow | null = null;
  let previousLine: DocumentLine | null = null;

  const push = (value: InvoiceLineItem, index: number, line: DocumentLine) => {
    previous = {
      id: `line_item_${rows.length}`,
      value,
      line: index,
      source: line.text,
      header: table?.header.text ?? null,
      includesTax: table?.includesTax ?? null,
    };
    rows.push(previous);
    previousLine = line;
  };

  lines.forEach((line, index) => {
    const header = headerRoles(line);
    if (header) {
      table = { header: line, ...header };
      previous = null;
      previousLine = line;
      return;
    }

    const piped = pipeRow(line);
    if (piped) {
      if (!isTotals(piped.description)) push(piped, index, line);
      return;
    }

    if (!table) {
      // Without a header, only rows whose arithmetic proves them are rows.
      const { description, numbers } = splitRow(line.text);
      if (!description || numbers.length < 3 || isTotals(description)) {
        return;
      }
      const assigned = byArithmetic(numbers);
      if (assigned?.quantity != null && assigned.unitPrice != null) {
        push({ description, ...assigned }, index, line);
      }
      return;
    }

    const active = table as { header: DocumentLine } & Header;
    if (line.page !== active.header.page) {
      // A table continues on a new page only under a repeated header.
      table = null;
      return;
    }
    const leading = active.roles.indexOf("description");
    const numericColumns = active.roles.filter(
      (role) => role !== "description",
    ).length;
    const { description, numbers } = splitRow(
      line.text,
      numericColumns - leading,
      leading,
    );
    if (isTotals(description)) {
      table = null;
      return;
    }
    const gap = previousLine ? line.top - previousLine.top : 0;
    if (numbers.length === 0) {
      const last = previous as LineItemRow | null;
      if (last && gap <= line.height * 2.2 && line.segments.length === 1) {
        last.value.description =
          `${last.value.description ?? ""} ${description}`.trim();
        last.source = `${last.source}\n${line.text}`;
        previousLine = line;
        return;
      }
      if (gap > line.height * 4) table = null;
      return;
    }
    // A priced row keeps its cells in separate columns. A row printed as one
    // run of text ("Continued on page 2", "Page 1 of 2") is a note whose
    // number is not a price; proposing it would invent a line item.
    if (line.segments.length === 1) return;
    const assigned = byHeader(numbers, active.roles);
    if (assigned)
      push({ description: description || null, ...assigned }, index, line);
  });

  return rows;
}
