/**
 * Candidate values for invoice fields.
 *
 * TypeSafe selects; it does not generate. Every field value therefore has to
 * be found in the document first, and this module over-finds on purpose:
 * values next to their label on the same row, under a stacked label, or
 * anywhere when the value has a distinctive shape (a GB VAT number, an IBAN).
 * TypeSafe then picks the candidate the question asks for, reading the row
 * and label context attached to each one, and code copies the chosen value.
 */
import type { DocumentLine, LineSegment } from "../layout";
import { DATE_PATTERN, parseInvoiceDate } from "./dates";

export type Candidate<T> = {
  id: string;
  value: T;
  /** Index into the document lines where the value was found. */
  line: number;
  /** Text immediately labelling the value: to its left on the row, or above it. */
  label?: string | null;
};

type Found<T> = Omit<Candidate<T>, "id">;

const clean = (value: string) =>
  value
    .replace(/\s+/g, " ")
    .replace(/^[\s:#.,;|-]+/, "")
    .replace(/[\s:;,|]+$/, "")
    .trim();

/** Assigns stable ids and drops repeated values, keeping the first occurrence. */
export const withIds = <T>(
  prefix: string,
  found: Found<T>[],
  key: (value: T) => string = (value) => JSON.stringify(value),
): Candidate<T>[] => {
  const seen = new Set<string>();
  const out: Candidate<T>[] = [];
  for (const candidate of found) {
    const k = key(candidate.value);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ ...candidate, id: `${prefix}_${out.length}` });
  }
  return out;
};

const overlaps = (a: LineSegment, b: LineSegment) =>
  Math.min(a.xEnd, b.xEnd) - Math.max(a.x, b.x) > 0;

/** The segment directly below `segment`, within the next two rows. */
const segmentBelow = (
  lines: readonly DocumentLine[],
  index: number,
  segment: LineSegment,
) => {
  const line = lines[index]!;
  for (const next of lines.slice(index + 1, index + 3)) {
    if (next.page !== line.page) return null;
    if (next.top - line.top > line.height * 3.5) return null;
    const below = next.segments.find((candidate) =>
      overlaps(candidate, segment),
    );
    if (below) return { line: lines.indexOf(next), segment: below };
  }
  return null;
};

/** The label text that describes a value found in `segment` on row `index`. */
export const labelFor = (
  lines: readonly DocumentLine[],
  index: number,
  segment: LineSegment,
  within?: string,
): string | null => {
  const line = lines[index]!;
  if (within) return clean(within) || null;
  const position = line.segments.indexOf(segment);
  if (position > 0) return line.segments[position - 1]!.text;
  const previous = lines[index - 1];
  if (
    previous &&
    previous.page === line.page &&
    line.top - previous.top <= line.height * 2.5
  ) {
    const above = previous.segments.find((candidate) =>
      overlaps(candidate, segment),
    );
    if (above) return above.text;
  }
  return null;
};

/**
 * Values introduced by a label: after it in the same segment, in the next
 * segment of the row, or directly beneath a stacked label.
 */
export const labeledValues = (
  lines: readonly DocumentLine[],
  label: RegExp,
  value: RegExp,
): Found<string>[] => {
  const found: Found<string>[] = [];
  const anchored = new RegExp(`^(?:${value.source})`, value.flags);
  const take = (text: string) => {
    const match = anchored.exec(clean(text));
    return match ? clean(match[0]) : null;
  };
  lines.forEach((line, index) => {
    line.segments.forEach((segment, position) => {
      const match = label.exec(segment.text);
      if (!match) return;
      const labelText = clean(
        segment.text.slice(0, match.index + match[0].length),
      );
      const rest = segment.text.slice(match.index + match[0].length);
      const inline = take(rest);
      if (inline) {
        found.push({ value: inline, line: index, label: labelText });
        return;
      }
      if (clean(rest)) return;
      const next = line.segments[position + 1];
      const beside = next ? take(next.text) : null;
      if (beside) {
        found.push({ value: beside, line: index, label: labelText });
        return;
      }
      const below = segmentBelow(lines, index, segment);
      const stacked = below ? take(below.segment.text) : null;
      if (below && stacked) {
        found.push({ value: stacked, line: below.line, label: labelText });
      }
    });
  });
  return found;
};

/** Every match of a distinctive value pattern, wherever it appears. */
export const patternValues = (
  lines: readonly DocumentLine[],
  pattern: RegExp,
): Found<string>[] => {
  const found: Found<string>[] = [];
  const global = new RegExp(
    pattern.source,
    pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
  );
  lines.forEach((line, index) => {
    for (const segment of line.segments) {
      for (const match of segment.text.matchAll(global)) {
        const within = segment.text.slice(0, match.index);
        found.push({
          value: clean(match[0]),
          line: index,
          label: labelFor(lines, index, segment, within),
        });
      }
    }
  });
  return found;
};

// --- Field-specific finders --------------------------------------------------

const VAT_LABEL =
  /\b(?:VAT|V\.A\.T\.?)\s*(?:reg(?:istration|istered)?\.?\s*)?(?:no\b\.?|number|num\b|#)?\s*[:.]?/i;
const VAT_VALUE = /(?:[A-Z]{2}\s?)?\d[\d ]{6,14}\d(?:\s?[A-Z0-9]{3})?/i;
const GB_VAT = /\bGB\s?\d{3}\s?\d{4}\s?\d{2}(?:\s?\d{3})?\b/;

export const normalizeVatNumber = (value: string) =>
  value.replace(/[\s.-]/g, "").toUpperCase();

export const vatNumberCandidates = (lines: readonly DocumentLine[]) =>
  withIds(
    "vat",
    [
      ...labeledValues(lines, VAT_LABEL, VAT_VALUE),
      ...patternValues(lines, GB_VAT),
    ]
      .map((found) => ({ ...found, value: normalizeVatNumber(found.value) }))
      .filter((found) => (found.value.match(/\d/g)?.length ?? 0) >= 7),
    (value) => value,
  );

const SORT_CODE_LABEL = /\bsort\s*-?\s*code\b|\bS\/C\b/i;
const SORT_CODE_VALUE = /\d{2}\s?[-–]?\s?\d{2}\s?[-–]?\s?\d{2}(?!\d)/;

export const normalizeSortCode = (value: string) => {
  const digits = value.replace(/\D/g, "");
  return digits.length === 6
    ? `${digits.slice(0, 2)}-${digits.slice(2, 4)}-${digits.slice(4)}`
    : value;
};

export const sortCodeCandidates = (lines: readonly DocumentLine[]) =>
  withIds(
    "sort_code",
    [
      ...labeledValues(lines, SORT_CODE_LABEL, SORT_CODE_VALUE),
      ...patternValues(lines, /\b\d{2}[-–]\d{2}[-–]\d{2}\b/),
    ].map((found) => ({ ...found, value: normalizeSortCode(found.value) })),
    (value) => value,
  );

const ACCOUNT_NUMBER_LABEL =
  /\b(?:bank\s+)?(?:account|acc(?:oun)?t?\.?|a\/c)\s*(?:no\b\.?|number|num\b|#)/i;

export const accountNumberCandidates = (lines: readonly DocumentLine[]) =>
  withIds(
    "account_number",
    [
      ...labeledValues(lines, ACCOUNT_NUMBER_LABEL, /\d[\d -]{4,14}\d/),
      ...patternValues(lines, /(?<![\d-])\d{8}(?![\d-])/),
    ]
      .map((found) => ({ ...found, value: found.value.replace(/\D/g, "") }))
      .filter((found) => found.value.length >= 6 && found.value.length <= 10),
    (value) => value,
  );

const IBAN_VALUE = /[A-Z]{2}\d{2}(?:\s?[A-Z0-9]){11,30}/i;

export const normalizeIban = (value: string) =>
  value
    .replace(/\s+/g, "")
    .toUpperCase()
    .replace(/(.{4})(?=.)/g, "$1 ");

/** ISO 13616 mod-97 check. */
export const ibanChecksumValid = (value: string) => {
  const compact = value.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(compact)) return false;
  const rearranged = `${compact.slice(4)}${compact.slice(0, 4)}`.replace(
    /[A-Z]/g,
    (letter) => String(letter.charCodeAt(0) - 55),
  );
  let remainder = 0;
  for (const digit of rearranged) {
    remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
};

export const ibanCandidates = (lines: readonly DocumentLine[]) =>
  withIds(
    "iban",
    [
      ...labeledValues(
        lines,
        /\bIBAN\b\s*(?:no\.?|number)?\s*[:.]?/i,
        IBAN_VALUE,
      ),
      ...patternValues(
        lines,
        /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}(?:\s?[A-Z0-9]{1,3})?\b/,
      ),
    ].map((found) => ({ ...found, value: normalizeIban(found.value) })),
    (value) => value,
  );

export const bicCandidates = (lines: readonly DocumentLine[]) =>
  withIds(
    "bic",
    labeledValues(
      lines,
      /\b(?:BIC|SWIFT)(?:\s*\/\s*(?:BIC|SWIFT))?(?:\s*code)?\s*[:.]?/i,
      /[A-Z]{4}\s?[A-Z]{2}\s?[A-Z0-9]{2}(?:\s?[A-Z0-9]{3})?(?![A-Z0-9])/,
    ).map((found) => ({
      ...found,
      value: found.value.replace(/\s+/g, "").toUpperCase(),
    })),
    (value) => value,
  );

const hasLetters = (value: string) => /\p{L}{2}/u.test(value);

export const accountNameCandidates = (lines: readonly DocumentLine[]) =>
  withIds(
    "account_name",
    labeledValues(
      lines,
      /\b(?:(?:bank\s+)?account\s*(?:name|holder)|beneficiary(?:\s+name)?|payee(?:\s+name)?|(?:cheques?\s+)?(?:made\s+)?payable\s+to|pay\s+to)\b\s*[:.]?|^name\b\s*[:.]?/i,
      /[^\d\s][^:]{1,79}/,
    ).filter((found) => hasLetters(found.value)),
    (value) => value.toLowerCase(),
  );

export const invoiceNumberCandidates = (lines: readonly DocumentLine[]) =>
  withIds(
    "invoice_number",
    labeledValues(
      lines,
      /\b(?:(?:tax\s+)?invoice|inv)\.?\s*(?:no\b\.?|number|num\b|#|ref(?:erence)?\b\.?|id\b)\s*[:.]?|\binvoice\s*:|^invoice\s+(?=[A-Z0-9-]*\d)/i,
      /[A-Z0-9][A-Z0-9/._-]{0,30}/i,
    ).filter((found) => /\d/.test(found.value)),
    (value) => value,
  );

export const purchaseOrderCandidates = (lines: readonly DocumentLine[]) =>
  withIds(
    "purchase_order",
    labeledValues(
      lines,
      /\b(?:purchase\s+order|P\.?\s?O\b\.?)(?!\s*box)\s*(?:no\b\.?|number|num\b|#|ref(?:erence)?\b\.?)?\s*[:.]?|\b(?:your|customer)\s+(?:order\s+)?ref(?:erence)?\b\.?\s*[:.]?/i,
      /[A-Z0-9][A-Z0-9/._-]{0,30}/i,
    ).filter((found) => /\d/.test(found.value)),
    (value) => value,
  );

export const descriptionCandidates = (
  lines: readonly DocumentLine[],
  lineItemDescriptions: readonly { value: string; line: number }[],
) =>
  withIds(
    "description",
    [
      ...labeledValues(
        lines,
        /^(?:description|services?|work(?:\s+carried\s+out)?|subject|re|project)\s*:/i,
        /.{3,200}/,
      ),
      ...lineItemDescriptions.map((item) => ({
        ...item,
        label: "line item",
      })),
    ].filter((found) => hasLetters(found.value)),
    (value) => value.toLowerCase(),
  );

export const dateCandidates = (lines: readonly DocumentLine[]) =>
  withIds(
    "date",
    patternValues(lines, DATE_PATTERN).flatMap((found) => {
      const iso = parseInvoiceDate(found.value);
      return iso ? [{ ...found, value: found.value, iso }] : [];
    }),
    (value) => value,
  ) as (Candidate<string> & { iso: string })[];

const MONEY =
  /(?:(?:GBP|USD|EUR|CAD|AUD|NZD|SEK|NOK|DKK|CHF)\s?|[£€$]\s?)-?\d{1,3}(?:[,\s]\d{3})*(?:\.\d{1,2})?(?!\d)|(?:(?:GBP|USD|EUR|CAD|AUD|NZD|SEK|NOK|DKK|CHF)\s?|[£€$]\s?)-?\d+(?:\.\d{1,2})?(?!\d)|-?\(?\b\d{1,3}(?:,\d{3})*\.\d{2}\b\)?|-?\b\d+\.\d{2}\b(?!\s?%)|\b-?\d[\d.,]*\s?(?:GBP|USD|EUR|CAD|AUD|NZD|SEK|NOK|DKK|CHF)\b/g;

export const parseMoney = (raw: string): number | null => {
  const negative = /^-|^\(.*\)$|-\s*$/.test(raw.trim());
  const cleaned = raw.replace(/[^\d,.]/g, "");
  if (!cleaned || !/\d/.test(cleaned)) return null;
  const comma = cleaned.lastIndexOf(",");
  const dot = cleaned.lastIndexOf(".");
  let normalized = cleaned;
  if (comma >= 0 && dot >= 0) {
    const decimal = comma > dot ? "," : ".";
    normalized = cleaned
      .replace(decimal === "," ? /\./g : /,/g, "")
      .replace(decimal, ".");
  } else if (comma >= 0) {
    normalized = /,\d{2}$/.test(cleaned)
      ? cleaned.replace(/,(?=\d{2}$)/, ".").replace(/,/g, "")
      : cleaned.replace(/,/g, "");
  }
  const value = Number(normalized);
  if (!Number.isFinite(value)) return null;
  return negative ? -Math.abs(value) : value;
};

export const amountCandidates = (
  lines: readonly DocumentLine[],
  limit = 150,
) => {
  const found: Found<number>[] = [];
  lines.forEach((line, index) => {
    for (const segment of line.segments) {
      for (const match of segment.text.matchAll(MONEY)) {
        const value = parseMoney(match[0]);
        if (value === null) continue;
        found.push({
          value,
          line: index,
          label: labelFor(
            lines,
            index,
            segment,
            segment.text.slice(0, match.index),
          ),
        });
      }
    }
  });
  // Totals come after the rows they sum, so the last occurrence of a value
  // carries the most useful label; keep that one.
  const unique = withIds("amount", [...found].reverse(), (value) =>
    value.toFixed(2),
  ).reverse();
  const summary = /total|vat|tax|net|gross|due|balance|payable|subtotal/i;
  const ranked = [
    ...unique.filter((candidate) => summary.test(candidate.label ?? "")),
    ...unique
      .filter((candidate) => !summary.test(candidate.label ?? ""))
      .reverse(),
  ].slice(0, limit);
  const kept = new Set(ranked.map((candidate) => candidate.id));
  return unique
    .filter((candidate) => kept.has(candidate.id))
    .map((candidate, index) => ({ ...candidate, id: `amount_${index}` }));
};

export const currencyCandidates = (text: string): Candidate<string>[] => {
  const currencies = new Set<string>();
  for (const match of text.matchAll(
    /\b(?:GBP|USD|EUR|CAD|AUD|NZD|SEK|NOK|DKK|CHF)\b/g,
  )) {
    currencies.add(match[0]);
  }
  if (text.includes("£")) currencies.add("GBP");
  if (text.includes("€")) currencies.add("EUR");
  if (text.includes("$") && currencies.size === 0) currencies.add("USD");
  return [...currencies].map((value, index) => ({
    id: `currency_${index}`,
    value,
    line: -1,
    label: `Currency marker in the invoice resolves to ${value}`,
  }));
};

// --- Supplier identity -------------------------------------------------------

const NOT_A_NAME =
  /^(?:tax\s+)?invoice\b|^(?:bill|invoice|ship|deliver(?:y)?|sold|charge)\s*(?:ed\s*)?to\b|^(?:date|due|vat|tax|sub\s*total|total|description|qty|quantity|unit|price|amount|rate|purchase\s+order|p\.?o\.?\b|page\b|tel|phone|fax|mob|e-?mail|web|www\.|https?:|account|sort\s*code|iban|bic|swift|payment|terms|reference|ref\b|balance|thank)/i;

const COMPANY_NAME =
  /(?:^|[^\p{L}\d&'’])((?:[\p{Lu}\d&][\p{L}\d&'’.,-]*\s+){0,6}?[\p{Lu}\d&][\p{L}\d&'’.,-]*\s+(?:Ltd|Limited|LLP|L\.L\.P\.|PLC|plc|Inc|LLC|CIC|Co\.))(?![\p{L}])\.?/gu;

export const COMPANY_SUFFIX = /\b(?:Ltd|Limited|LLP|PLC|plc|Inc|LLC|CIC)\b\.?/;

const nameLike = (value: string) =>
  value.length >= 2 &&
  value.length <= 80 &&
  (value.match(/\p{L}/gu)?.length ?? 0) >= 3 &&
  !NOT_A_NAME.test(value) &&
  !/@|\d{3,}/.test(value);

export const supplierNameCandidates = (
  lines: readonly DocumentLine[],
  limit = 60,
) => {
  const found: Found<string>[] = [];
  const header = lines.slice(0, 25);
  const footer = lines.length > 35 ? lines.slice(-10) : [];
  for (const line of [...header, ...footer]) {
    const index = lines.indexOf(line);
    for (const segment of line.segments) {
      const value = clean(segment.text);
      if (nameLike(value)) {
        found.push({
          value,
          line: index,
          label: labelFor(lines, index, segment),
        });
      }
    }
  }
  lines.forEach((line, index) => {
    for (const segment of line.segments) {
      for (const match of segment.text.matchAll(COMPANY_NAME)) {
        const value = clean(match[1]!)
          .replace(/\s+[&,]$/, "")
          // A label run into the name ("Name Acme Ltd", "To: Acme Ltd").
          .replace(
            /^(?:(?:account\s+)?name|to|from|for|payee|bill\s+to|invoice\s+to)\b\s*:?\s+/i,
            "",
          );
        if (value.length <= 80) {
          found.push({
            value,
            line: index,
            label: labelFor(lines, index, segment),
          });
        }
      }
    }
  });
  return withIds("supplier", found, (value) => value.toLowerCase()).slice(
    0,
    limit,
  );
};

const UK_POSTCODE =
  /\b(?:GIR ?0AA|[A-PR-UWYZ][A-HK-Y]?\d[A-Z\d]? ?\d[ABD-HJLNP-UW-Z]{2})\b/;

/** Words that introduce an address inside running text, e.g. a footer. */
const ADDRESS_INTRO =
  /\b(?:registered\s+(?:office|address)|(?:trading|business|postal)\s+address|address|registered\s+in\s+[\p{L} ]+?\s+at|located\s+at|office)\b\s*[:\-–]?\s*/giu;

/** Rows that end an address block when walking up from its postcode. */
const NOT_AN_ADDRESS_ROW =
  /^(?:(?:tax\s+)?invoice\b|date\b|due\b|vat\b|tax\b|tel|phone|fax|mob|e-?mail|web\b|account|sort\s*code|iban|bic|swift|company\s+(?:no|number|reg)|reg(?:istered|istration)?\s+(?:no|number)|thank|payment|total)/i;

const RECIPIENT_LABEL =
  /^(?:(?:bill(?:ed)?|invoice(?:d)?|ship(?:ped)?|deliver(?:ed|y)?|sold|charge(?:d)?)(?:\s+to)?|to|customer|client|attn|attention)\b[^:]*:?$/i;

/**
 * Postal-address candidates. A UK postcode anchors each one; the address is
 * the aligned stack of rows above it (name, street, town, postcode), offered
 * with and without its first row so the business name can be left out. A
 * postcode inside a long row (a footer's registered office) yields that row.
 */
export const addressCandidates = (lines: readonly DocumentLine[]) => {
  const found: Found<string>[] = [];
  lines.forEach((line, index) => {
    for (const segment of line.segments) {
      const postcode = UK_POSTCODE.exec(segment.text);
      if (!postcode) continue;
      const upToPostcode = segment.text.slice(
        0,
        postcode.index + postcode[0].length,
      );

      const rows: string[] = [clean(upToPostcode)];
      let label: string | null = null;
      let current = line;
      for (let above = index - 1; above >= 0 && rows.length < 6; above--) {
        const previous = lines[above]!;
        if (previous.page !== current.page) break;
        if (current.top - previous.top > current.height * 2.6) break;
        const aligned =
          previous.segments.find(
            (candidate) =>
              Math.abs(candidate.x - segment.x) <= line.height * 1.5 ||
              Math.abs(candidate.xEnd - segment.xEnd) <= line.height * 1.5,
          ) ??
          // Running text (a centred footer) wraps an address mid-sentence:
          // the row above continues into this one when it ends in a comma.
          previous.segments.find(
            (candidate) =>
              /,\s*$/.test(candidate.text) && overlaps(candidate, segment),
          );
        if (!aligned) break;
        const text = clean(aligned.text);
        if (
          text.length <= 30 &&
          (RECIPIENT_LABEL.test(text) || /^(?:from|supplier)\b/i.test(text))
        ) {
          label = text;
          break;
        }
        if (NOT_AN_ADDRESS_ROW.test(text) || /@|www\.|https?:/i.test(text)) {
          break;
        }
        rows.unshift(text);
        current = previous;
      }

      // An address introduced inside running text ("registered in England
      // and Wales at ...", "Registered office: ...") starts after its
      // introduction; the words before it are not part of the address.
      let introduced = -1;
      rows.forEach((row, position) => {
        if ([...row.matchAll(ADDRESS_INTRO)].length > 0) introduced = position;
      });
      if (introduced >= 0) {
        const row = rows[introduced]!;
        const intro = [...row.matchAll(ADDRESS_INTRO)].at(-1)!;
        const rest = [
          clean(row.slice((intro.index ?? 0) + intro[0].length)),
          ...rows.slice(introduced + 1),
        ].filter(Boolean);
        found.push({
          value: rest.join(", "),
          line: index,
          label: clean(row.slice(0, (intro.index ?? 0) + intro[0].length)),
        });
        continue;
      }
      for (let start = 0; start < rows.length; start++) {
        found.push({
          value: rows.slice(start).join(", "),
          line: index,
          label,
        });
      }
    }
  });
  return withIds("address", found, (value) => value.toLowerCase());
};
