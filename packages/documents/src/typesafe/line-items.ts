/**
 * Line-item rows from invoice tables.
 *
 * A table is found by its header row (Description / Qty / Unit price /
 * Amount ...). Each following row until the totals is split into a
 * description and its numeric cells; the header's column order says which
 * number is the quantity, the unit price and the line total, and arithmetic
 * (quantity x unit price = total) settles the order when there is no usable
 * header. Rows without numbers continue the previous row's description, as
 * wrapped descriptions do. TypeSafe then confirms which rows are purchases.
 */
import type { DocumentLine } from "../layout";
import { parseMoney } from "./candidates";

export type InvoiceLineItem = {
  description: string | null;
  quantity: number | null;
  unitPrice: number | null;
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
};

type Role = "description" | "quantity" | "unitPrice" | "total" | "vat" | "other";

const roleOf = (header: string): Role => {
  const text = header.toLowerCase();
  if (
    /\b(?:vat|tax)\b/.test(text) &&
    !/\b(?:incl|inc\.?|including|gross)\b/.test(text)
  ) {
    return "vat";
  }
  if (/\b(?:qty|quantity|hours?|hrs|units?|days|no\.?|count)\b/.test(text) && !/price|rate|cost/.test(text)) {
    return "quantity";
  }
  if (/\b(?:unit|price|rate|each|cost|per)\b/.test(text)) return "unitPrice";
  if (/\b(?:amount|total|net|value|sum|gross|line)\b/.test(text)) return "total";
  if (/\b(?:description|item|details?|services?|products?|particulars|work|goods)\b/.test(text)) {
    return "description";
  }
  return "other";
};

const HEADER_WORDS =
  /\b(?:description|item|details?|services?|products?|particulars|qty|quantity|hours?|hrs|units?|price|rate|each|cost|amount|total|vat|tax|net)\b/i;

const isHeader = (line: DocumentLine) => {
  const roles = line.segments.map((segment) => roleOf(segment.text));
  const numeric = roles.filter((role) =>
    ["quantity", "unitPrice", "total"].includes(role),
  ).length;
  return (
    line.segments.length >= 2 &&
    roles.includes("description") &&
    numeric >= 1 &&
    line.segments.every((segment) => HEADER_WORDS.test(segment.text) || segment.text.length <= 12) &&
    !/\d/.test(line.text.replace(/\bno\.?\b/gi, ""))
  );
};

const TOTALS =
  /^(?:sub\s*-?\s*total|total|net(?:\s+total)?|vat\b|tax\b|amount\s+(?:due|payable)|balance|gross|carriage|shipping|delivery\s+charge|discount|invoice\s+total|payment|bank|account|thank)/i;

const NUMERIC_CELL =
  /^(?:[£€$]|(?:GBP|USD|EUR|CAD|AUD|NZD|SEK|NOK|DKK|CHF)\b)?\s?-?\(?\d[\d,]*(?:\.\d+)?\)?\s?(?:%|(?:GBP|USD|EUR|CAD|AUD|NZD|SEK|NOK|DKK|CHF))?$/i;

type Cell = { text: string; x: number; xEnd: number };

/** Splits a row into description text and trailing numeric cells. */
const splitRow = (line: DocumentLine) => {
  const cells: Cell[] = line.segments.flatMap((segment) => {
    // A segment that ends in several numbers holds merged cells (close
    // columns, OCR spacing); split its numeric tail into words.
    const words = segment.text.split(" ");
    let tail = words.length;
    while (tail > 0 && NUMERIC_CELL.test(words[tail - 1]!)) tail--;
    if (tail === words.length || (tail === 0 && words.length === 1)) {
      return [{ text: segment.text, x: segment.x, xEnd: segment.xEnd }];
    }
    const head = words.slice(0, tail).join(" ");
    const width = (segment.xEnd - segment.x) / Math.max(1, segment.text.length);
    let offset = head.length ? head.length + 1 : 0;
    const out: Cell[] = head
      ? [{ text: head, x: segment.x, xEnd: segment.x + head.length * width }]
      : [];
    for (const word of words.slice(tail)) {
      out.push({
        text: word,
        x: segment.x + offset * width,
        xEnd: segment.x + (offset + word.length) * width,
      });
      offset += word.length + 1;
    }
    return out;
  });
  let first = cells.length;
  while (first > 0 && NUMERIC_CELL.test(cells[first - 1]!.text)) first--;
  return {
    description: cells
      .slice(0, first)
      .map((cell) => cell.text)
      .join(" ")
      .trim(),
    numbers: cells.slice(first),
  };
};

const close = (a: number, b: number) =>
  Math.abs(a - b) <= Math.max(0.011, Math.abs(b) * 0.005);

/** Assigns numeric cells to quantity, unit price and total. */
const assign = (
  numbers: Cell[],
  columns: { role: Role; x: number; xEnd: number }[] | null,
): Omit<InvoiceLineItem, "description"> | null => {
  const values = numbers
    .filter((cell) => !cell.text.includes("%"))
    .map((cell) => ({ cell, value: parseMoney(cell.text) }))
    .filter(
      (entry): entry is { cell: Cell; value: number } => entry.value !== null,
    );
  if (values.length === 0) return null;

  if (columns) {
    const numericColumns = columns.filter((column) =>
      ["quantity", "unitPrice", "total", "vat"].includes(column.role),
    );
    const roles: Role[] =
      numbers.length === numericColumns.length
        ? numericColumns.map((column) => column.role)
        : numbers.map((cell) => {
            const center = (cell.x + cell.xEnd) / 2;
            const nearest = [...numericColumns].sort(
              (a, b) =>
                Math.min(Math.abs(center - (a.x + a.xEnd) / 2), Math.abs(cell.xEnd - a.xEnd)) -
                Math.min(Math.abs(center - (b.x + b.xEnd) / 2), Math.abs(cell.xEnd - b.xEnd)),
            )[0];
            return nearest?.role ?? "other";
          });
    const byRole = (role: Role) => {
      const index = roles.lastIndexOf(role);
      const cell = index >= 0 ? numbers[index] : undefined;
      return cell && !cell.text.includes("%") ? parseMoney(cell.text) : null;
    };
    const quantity = byRole("quantity");
    const unitPrice = byRole("unitPrice");
    const total = byRole("total");
    if (total !== null || unitPrice !== null) {
      return { quantity, unitPrice, total };
    }
  }

  const total = values.at(-1)!.value;
  const earlier = values.slice(0, -1).map((entry) => entry.value);
  for (let q = 0; q < earlier.length; q++) {
    for (let u = 0; u < earlier.length; u++) {
      if (q !== u && close(earlier[q]! * earlier[u]!, total)) {
        const [quantity, unitPrice] =
          Number.isInteger(earlier[q]!) || earlier[q]! < earlier[u]!
            ? [earlier[q]!, earlier[u]!]
            : [earlier[u]!, earlier[q]!];
        return { quantity, unitPrice, total };
      }
    }
  }
  if (earlier.length === 1 && close(earlier[0]!, total)) {
    return { quantity: 1, unitPrice: total, total };
  }
  return { quantity: null, unitPrice: null, total };
};

/** Rows of `desc | qty | price | total`, as some plain-text exports print them. */
const pipeRow = (line: DocumentLine) => {
  const cells = line.text.split("|").map((cell) => cell.trim());
  if (cells.length < 3) return null;
  const numbers = cells.slice(1).map((text) => ({ text, x: 0, xEnd: 0 }));
  if (!numbers.every((cell) => NUMERIC_CELL.test(cell.text))) return null;
  const assigned = assign(numbers, null);
  return assigned ? { description: cells[0]!, ...assigned } : null;
};

export function lineItemRows(lines: readonly DocumentLine[]): LineItemRow[] {
  const rows: LineItemRow[] = [];
  const push = (
    value: InvoiceLineItem,
    line: number,
    source: string,
    header: string | null,
  ) =>
    rows.push({ id: `line_item_${rows.length}`, value, line, source, header });

  let header: DocumentLine | null = null;
  let columns: { role: Role; x: number; xEnd: number }[] | null = null;
  let previous: LineItemRow | null = null;
  let previousLine: DocumentLine | null = null;

  lines.forEach((line, index) => {
    if (isHeader(line)) {
      header = line;
      columns = line.segments.map((segment) => ({
        role: roleOf(segment.text),
        x: segment.x,
        xEnd: segment.xEnd,
      }));
      previous = null;
      previousLine = line;
      return;
    }

    const piped = pipeRow(line);
    if (piped) {
      if (!TOTALS.test(piped.description ?? "")) {
        push(piped, index, line.text, header?.text ?? null);
      }
      return;
    }

    if (!header || !columns) {
      // Without a header, only rows whose arithmetic proves them are rows.
      const { description, numbers } = splitRow(line);
      if (!description || numbers.length < 3 || TOTALS.test(description)) return;
      const assigned = assign(numbers, null);
      if (assigned?.quantity != null && assigned.unitPrice != null) {
        push({ description, ...assigned }, index, line.text, null);
      }
      return;
    }

    const activeHeader = header as DocumentLine;
    if (line.page !== activeHeader.page && !isHeader(line)) {
      // A table continues on a new page only under a repeated header.
      header = null;
      columns = null;
      return;
    }
    const { description, numbers } = splitRow(line);
    if (TOTALS.test(line.segments[0]?.text ?? "") || TOTALS.test(description)) {
      header = null;
      columns = null;
      return;
    }
    const gap = previousLine ? line.top - previousLine.top : 0;
    if (numbers.length === 0) {
      const last = previous as LineItemRow | null;
      const descriptionColumn = (columns as { role: Role; x: number; xEnd: number }[]).find(
        (column) => column.role === "description",
      );
      const inColumn =
        !descriptionColumn ||
        line.segments[0]!.x <= descriptionColumn.x + line.height * 2;
      if (last && inColumn && gap <= line.height * 2.2 && line.segments.length === 1) {
        last.value.description = `${last.value.description ?? ""} ${description}`.trim();
        last.source = `${last.source}\n${line.text}`;
        previousLine = line;
        return;
      }
      if (gap > line.height * 4) {
        header = null;
        columns = null;
      }
      return;
    }
    const assigned = assign(numbers, columns);
    if (!assigned) return;
    push(
      { description: description || null, ...assigned },
      index,
      line.text,
      activeHeader.text,
    );
    previous = rows.at(-1)!;
    previousLine = line;
  });

  return rows;
}
