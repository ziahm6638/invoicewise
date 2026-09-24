/**
 * Reading-order layout for invoice text.
 *
 * Both text sources (the PDF text layer via pdf.js, and OCR via tesseract)
 * produce positioned runs of text rather than lines. Invoice fields are found
 * by where they sit: a label and its value share a row, a table row keeps its
 * cells in order, an address is a stack of left-aligned rows. This module
 * rebuilds those rows from geometry so both sources yield the same structure.
 */

/** A positioned run of text. Coordinates are top-down, in source units. */
export type TextRun = {
  x: number;
  /** Top edge of the run. */
  y: number;
  width: number;
  height: number;
  text: string;
};

/** A horizontally contiguous piece of a row, separated from its neighbours by a column gap. */
export type LineSegment = { x: number; xEnd: number; text: string };

export type DocumentLine = {
  page: number;
  top: number;
  height: number;
  segments: LineSegment[];
  /** Segments joined by a column gap of two spaces; words inside a segment use one space. */
  text: string;
};

export type DocumentPageSource = "text-layer" | "ocr";

export type DocumentText = {
  lines: DocumentLine[];
  /** How each page's text was obtained, in page order. */
  pageSources: DocumentPageSource[];
};

/** Two spaces separate columns in `DocumentLine.text`; single spaces separate words. */
export const COLUMN_GAP = "  ";

const normalizeSpace = (value: string) =>
  value
    .replaceAll("\u0000", "")
    .replace(/[  -​ 　]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const joinSegments = (segments: LineSegment[]) =>
  segments.map((segment) => segment.text).join(COLUMN_GAP);

/**
 * Groups runs into rows by vertical overlap, then splits each row into
 * segments wherever the horizontal gap is wider than a couple of spaces.
 */
export function layoutRuns(runs: readonly TextRun[], page = 1): DocumentLine[] {
  const visible = runs
    .map((run) => ({ ...run, text: normalizeSpace(run.text) }))
    .filter((run) => run.text && run.height > 0 && Number.isFinite(run.x));
  const sorted = [...visible].sort(
    (a, b) => a.y + a.height / 2 - (b.y + b.height / 2) || a.x - b.x,
  );

  const rows: { top: number; bottom: number; runs: typeof visible }[] = [];
  for (const run of sorted) {
    const center = run.y + run.height / 2;
    const row = rows.at(-1);
    if (row) {
      const rowCenter = (row.top + row.bottom) / 2;
      const tolerance = Math.max(row.bottom - row.top, run.height) * 0.5;
      if (Math.abs(center - rowCenter) <= tolerance) {
        row.runs.push(run);
        row.top = Math.min(row.top, run.y);
        row.bottom = Math.max(row.bottom, run.y + run.height);
        continue;
      }
    }
    rows.push({ top: run.y, bottom: run.y + run.height, runs: [run] });
  }

  return rows.map((row) => {
    const cells = [...row.runs].sort((a, b) => a.x - b.x);
    const height = Math.max(...cells.map((cell) => cell.height));
    const segments: LineSegment[] = [];
    let previousEnd = Number.NEGATIVE_INFINITY;
    for (const cell of cells) {
      const gap = cell.x - previousEnd;
      const current = segments.at(-1);
      if (!current || gap > height * 1.2) {
        segments.push({
          x: cell.x,
          xEnd: cell.x + cell.width,
          text: cell.text,
        });
      } else {
        // Runs closer than a word space are pieces of one word (kerning,
        // font changes); anything wider is a word break.
        current.text += gap > height * 0.12 ? ` ${cell.text}` : cell.text;
        current.xEnd = Math.max(current.xEnd, cell.x + cell.width);
      }
      previousEnd = Math.max(previousEnd, cell.x + cell.width);
    }
    return {
      page,
      top: row.top,
      height,
      segments,
      text: joinSegments(segments),
    };
  });
}

const PLAIN_CHAR_WIDTH = 6;
const PLAIN_LINE_HEIGHT = 12;

/**
 * Treats caller-supplied text as already laid out: one row per line, columns
 * separated by tabs or runs of two or more spaces.
 */
export function linesFromPlainText(text: string): DocumentLine[] {
  const lines: DocumentLine[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const segments: LineSegment[] = [];
    for (const match of raw.replaceAll("\t", "  ").matchAll(/\S+(?: \S+)*/g)) {
      const value = normalizeSpace(match[0]);
      if (!value) continue;
      const x = (match.index ?? 0) * PLAIN_CHAR_WIDTH;
      segments.push({
        x,
        xEnd: x + match[0].length * PLAIN_CHAR_WIDTH,
        text: value,
      });
    }
    if (segments.length === 0) return;
    lines.push({
      page: 1,
      top: index * PLAIN_LINE_HEIGHT,
      height: PLAIN_LINE_HEIGHT - 2,
      segments,
      text: joinSegments(segments),
    });
  });
  return lines;
}

/** Word-level runs from tesseract's TSV output, dropping low-confidence noise. */
export function runsFromTesseractTsv(tsv: string): TextRun[] {
  const runs: TextRun[] = [];
  for (const row of tsv.split(/\r?\n/).slice(1)) {
    const cells = row.split("\t");
    if (cells.length < 12 || cells[0] !== "5") continue;
    const [left, top, width, height, confidence] = cells
      .slice(6, 11)
      .map(Number);
    const text = cells.slice(11).join("\t").trim();
    if (!text || !(confidence! >= 20)) continue;
    runs.push({ x: left!, y: top!, width: width!, height: height!, text });
  }
  return runs;
}

/** Counts letters and digits, the measure of whether a page has usable text. */
export const readableCharacters = (value: string) =>
  value.match(/[\p{L}\p{N}]/gu)?.length ?? 0;

export const documentPlainText = (lines: readonly DocumentLine[]) =>
  lines.map((line) => line.text).join("\n");
