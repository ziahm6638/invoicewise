/**
 * Renders every document in `corpus.ts` into a text-layer PDF beside this
 * script, laid out like a real invoice: supplier block and title, a
 * label/value block, the customer, a shaded table header, ruled rows (a
 * wrapped description continues beneath its row), right-aligned totals,
 * payment notes and a footer.
 *
 * Run from packages/documents: `bun src/test/corpus/generate-corpus.ts`.
 * The PDFs are committed; pass corpus names to regenerate only those.
 */
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
// @ts-expect-error: untyped; only used to regenerate the fixtures.
import PDFDocument from "@react-pdf/pdfkit";
import { CORPUS, type CorpusLayout } from "./corpus";

const collect = (doc: InstanceType<typeof PDFDocument>) =>
  new Promise<Buffer>((done) => {
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => done(Buffer.concat(chunks)));
  });

/** Numeric column positions for a table with this many numeric columns. */
const numericColumns = (count: number) =>
  ({
    2: [360, 470],
    3: [300, 370, 470],
    4: [290, 345, 415, 480],
  })[count] ?? [];

const render = async (layout: CorpusLayout) => {
  const doc = new PDFDocument({ size: "A4", margin: 0 });
  const done = collect(doc);
  const regular = "Helvetica";
  const bold = "Helvetica-Bold";

  doc.font(bold).fontSize(16).text(layout.supplier[0], 50, 50);
  doc.font(regular).fontSize(10);
  layout.supplier
    .slice(1)
    .forEach((line, index) => doc.text(line, 50, 72 + index * 14));

  doc.font(bold).fontSize(20).text(layout.title, 380, 50);
  doc.font(regular).fontSize(10);
  layout.meta.forEach(([label, value], index) => {
    doc.text(label, 360, 86 + index * 14);
    doc.text(value, 455, 86 + index * 14);
  });

  doc.font(bold).text("Bill To", 50, 160);
  doc.font(regular);
  layout.billTo.forEach((line, index) => doc.text(line, 50, 174 + index * 14));

  const positions = [50, ...numericColumns(layout.columns.length - 1)];
  const tableTop = 250;
  doc
    .rect(45, tableTop - 6, 505, 20)
    .fill("#eeeeee")
    .fillColor("#000000");
  doc.font(bold);
  layout.columns.forEach((label, index) =>
    doc.text(label, positions[index], tableTop),
  );
  doc.font(regular);

  let y = tableTop + 24;
  for (const row of layout.rows) {
    row.description.forEach((line, index) =>
      doc.text(line, 50, y + index * 13),
    );
    row.cells.forEach((cell, index) => doc.text(cell, positions[index + 1], y));
    y += row.description.length * 13 + 10;
    doc
      .moveTo(45, y - 5)
      .lineTo(550, y - 5)
      .strokeColor("#cccccc")
      .stroke();
  }

  y += 10;
  layout.totals.forEach(([label, value], index) => {
    doc.font(index === layout.totals.length - 1 ? bold : regular);
    doc.text(label, 330, y + index * 16);
    doc.text(value, 470, y + index * 16);
  });
  doc.font(regular);

  y += layout.totals.length * 16 + 30;
  for (const note of layout.notes) {
    const [label, value] = note.split("  ");
    doc.text(label, 50, y);
    if (value) doc.text(value, 170, y);
    y += 14;
  }

  if (layout.footer) {
    doc.fontSize(8).text(layout.footer, 50, 790, { width: 500 });
  }

  doc.end();
  return done;
};

const requested = new Set(process.argv.slice(2));
for (const entry of CORPUS) {
  if (requested.size > 0 && !requested.has(entry.name)) continue;
  await writeFile(
    resolve(__dirname, `${entry.name}.pdf`),
    await render(entry.layout),
  );
  console.log(`wrote ${entry.name}.pdf`);
}
