/**
 * Date candidates on UK invoices. Numeric dates are day-first unless the
 * order is unambiguous from the values; written dates may name the month in
 * full or short form, with or without an ordinal suffix.
 */

const MONTH =
  "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const DAY = "(?:[0-2]?\\d|3[01])(?:st|nd|rd|th)?";
const SEP = "[\\s./-]+";

/** Matches every supported written or numeric date form. */
export const DATE_PATTERN = new RegExp(
  [
    "\\b\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}\\b",
    "\\b\\d{1,2}[/.-]\\d{1,2}[/.-](?:\\d{4}|\\d{2})\\b",
    `\\b${DAY}(?:\\s+of)?${SEP}${MONTH}\\.?,?${SEP}(?:\\d{4}|'?\\d{2})\\b`,
    `\\b${MONTH}\\.?${SEP}${DAY},?${SEP}\\d{4}\\b`,
  ].join("|"),
  "gi",
);

const MONTHS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];

const monthNumber = (name: string) =>
  MONTHS.indexOf(name.slice(0, 3).toLowerCase()) + 1;

const fullYear = (raw: string) => {
  const digits = raw.replace(/\D/g, "");
  return digits.length === 2 ? 2000 + Number(digits) : Number(digits);
};

const iso = (year: number, month: number, day: number): string | null => {
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1) {
    return null;
  }
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day > daysInMonth) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
};

/** Converts one matched date to ISO `yyyy-MM-dd`, or null when it is not a real date. */
export function parseInvoiceDate(raw: string | null): string | null {
  if (!raw) return null;
  const value = raw.trim();

  const yearFirst = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(value);
  if (yearFirst) {
    return iso(
      Number(yearFirst[1]),
      Number(yearFirst[2]),
      Number(yearFirst[3]),
    );
  }

  const numeric = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(value);
  if (numeric) {
    const first = Number(numeric[1]);
    const second = Number(numeric[2]);
    const year = fullYear(numeric[3]!);
    // Day-first (UK) unless only month-first can be a real date.
    return first > 12 || second <= 12
      ? iso(year, second, first)
      : iso(year, first, second);
  }

  const dayFirst = new RegExp(
    `^(${DAY})(?:\\s+of)?${SEP}(${MONTH})\\.?,?${SEP}('?\\d{2}|\\d{4})$`,
    "i",
  ).exec(value);
  if (dayFirst) {
    return iso(
      fullYear(dayFirst[3]!),
      monthNumber(dayFirst[2]!),
      Number.parseInt(dayFirst[1]!, 10),
    );
  }

  const monthFirst = new RegExp(
    `^(${MONTH})\\.?${SEP}(${DAY}),?${SEP}(\\d{4})$`,
    "i",
  ).exec(value);
  if (monthFirst) {
    return iso(
      Number(monthFirst[3]),
      monthNumber(monthFirst[1]!),
      Number.parseInt(monthFirst[2]!, 10),
    );
  }

  return null;
}

/** Adds whole days to an ISO date in UTC, so no local timezone shifts the result. */
export function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
