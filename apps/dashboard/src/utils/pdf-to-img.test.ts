/**
 * The invoice preview must never allocate a canvas from an unbounded PDF
 * MediaBox, and it must release the pdf.js document it opened.
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getPdfImage } from "./pdf-to-img";

/** A one-page PDF with an explicit (possibly pathological) MediaBox. */
function buildPdf(width: number, height: number): ArrayBuffer {
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] >>\nendobj\n`,
  ];
  let output = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const object of objects) {
    offsets.push(output.length);
    output += object;
  }
  const xrefStart = output.length;
  const size = objects.length + 1;
  output += `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    output += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  output += `trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return new TextEncoder().encode(output).buffer;
}

describe("invoice preview bounds", () => {
  test("renders a normal invoice page", async () => {
    const bytes = await readFile(
      resolve(
        __dirname,
        "../../../../packages/documents/src/test/fixtures/synthetic-invoice.pdf",
      ),
    );
    const copy = new Uint8Array(bytes);
    const image = await getPdfImage(
      copy.buffer.slice(
        copy.byteOffset,
        copy.byteOffset + copy.byteLength,
      ) as ArrayBuffer,
    );
    expect(image).not.toBeNull();
    expect(image!.byteLength).toBeGreaterThan(0);
  });

  test("refuses a pathological page without allocating a canvas", async () => {
    const image = await getPdfImage(buildPdf(20_000, 20_000));
    expect(image).toBeNull();
  });
});
