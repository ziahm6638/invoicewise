/**
 * CSV encoding shared by every invoice export.
 *
 * Text that a spreadsheet would evaluate as a formula (it starts with `=`,
 * `+`, `-`, `@`, a tab, a carriage return or a line feed, or their
 * full-width forms) is prefixed with a single quote, so a supplier name such
 * as `=HYPERLINK(...)` printed on an invoice opens as text. A plain number,
 * including a negative amount, is left as it is: it cannot be a formula.
 */
const FORMULA_START = /^[=+\-@\t\r\n＝＋－＠]/;
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

export const neutralizeFormula = (text: string) =>
  FORMULA_START.test(text) && !PLAIN_NUMBER.test(text) ? `'${text}` : text;

export const csvCell = (value: unknown) => {
  const raw =
    value === null || value === undefined
      ? ""
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
  const text = neutralizeFormula(raw);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

export const csvLine = (values: readonly unknown[]) =>
  values.map(csvCell).join(",");

export const csvDocument = (
  headers: readonly string[],
  rows: readonly (readonly unknown[])[],
) => [csvLine(headers), ...rows.map(csvLine)].join("\r\n");
