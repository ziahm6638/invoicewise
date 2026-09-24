import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { validateIntakeDocument } from "./intake";
import {
  extractPdfTextIsolated,
  inspectPdfIsolated,
  ocrImageIsolated,
  renderPdfPageIsolated,
  runBusyProcessForTest,
  runMemoryHogForTest,
} from "./isolated";

const fixture = new Uint8Array(
  await readFile(resolve(__dirname, "test/fixtures/synthetic-invoice.pdf")),
);

const limits = {
  timeoutMs: 30_000,
  maxPages: 50,
  maxPageDimension: 10_000,
  maxTotalPixels: 100_000_000,
  maxChars: 400_000,
};

/** Builds a PDF from raw object bodies with a correct xref table. */
function rawPdf(objects: string[]): Uint8Array {
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

const CATALOG = "<< /Type /Catalog /Pages 2 0 R >>";

// Each document opens, then fails while its page tree is walked.
const brokenPageTrees: Record<string, string[]> = {
  "a kid that is not a page": [
    CATALOG,
    "<< /Type /Pages /Count 1 /Kids [9 0 R] >>",
  ],
  "/Kids that is not an array": [
    CATALOG,
    "<< /Type /Pages /Count 1 /Kids 5 >>",
  ],
  "a circular page tree": [
    CATALOG,
    "<< /Type /Pages /Count 1 /Kids [2 0 R] >>",
  ],
};

describe("isolated PDF tasks", () => {
  test("extracts the fixture text", async () => {
    const result = await extractPdfTextIsolated(fixture, limits);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.text).toContain("ACME");
      expect(result.result.text.length).toBeGreaterThan(50);
    }
  });

  test("keeps rows and column gaps from the text layer", async () => {
    const result = await extractPdfTextIsolated(fixture, limits);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // pdf.js items joined into one string once lost every line break
      // (issue #71); each printed line must stay its own row.
      expect(result.result.text.split("\n")).toContain(
        "Invoice number: INV-2026-0042",
      );
      expect(result.result.pages[0]!.lines.length).toBeGreaterThan(15);
    }
  });

  test("reports a missing OCR engine as a retryable operational failure", async () => {
    const previous = process.env.IW_TESSERACT_COMMAND;
    process.env.IW_TESSERACT_COMMAND = "/nonexistent/tesseract";
    try {
      const result = await ocrImageIsolated(new Uint8Array([1, 2, 3]), limits);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("task_failed");
    } finally {
      if (previous === undefined) {
        Reflect.deleteProperty(process.env, "IW_TESSERACT_COMMAND");
      } else {
        process.env.IW_TESSERACT_COMMAND = previous;
      }
    }
  });

  test("refuses to silently truncate extracted text", async () => {
    const result = await extractPdfTextIsolated(fixture, {
      ...limits,
      maxChars: 40,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("limit");
      expect(result.message).toContain("character limit");
    }
  });

  test("refuses to clip pages silently", async () => {
    const result = await extractPdfTextIsolated(fixture, {
      ...limits,
      maxPages: 0,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("limit");
      expect(result.message).toContain("more pages");
    }
  });

  test("renders a normal first page", async () => {
    const result = await renderPdfPageIsolated(fixture, limits, {
      page: 1,
      scale: 1,
      maxDimension: 4_000,
      maxPixels: 4_000_000,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.png.byteLength).toBeGreaterThan(0);
    }
  });

  test("applies the pixel bound to the scaled render, not the unit box", async () => {
    // A typical A4 page is ~0.5M unit pixels but ~2M at scale 2, so a 1M pixel
    // budget only trips when the scale is part of the bound.
    const result = await renderPdfPageIsolated(fixture, limits, {
      page: 1,
      scale: 2,
      maxDimension: 10_000,
      maxPixels: 1_000_000,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("limit");
      expect(result.message).toContain("preview bounds");
    }
  });

  test("returns a typed busy result when admission is exhausted", async () => {
    const result = await inspectPdfIsolated(fixture, {
      ...limits,
      maxConcurrentProcesses: 0,
      maxQueuedProcesses: 0,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("busy");
      expect(result.terminated).toBe(false);
    }
  });

  test("saturated previews cannot take intake admission", async () => {
    const previousQueued = process.env.IW_PDF_PREVIEW_MAX_QUEUED;
    process.env.IW_PDF_PREVIEW_MAX_QUEUED = "0";
    let previewSettled = false;
    // The preview pool admits one process by default; hold it with a child
    // that is busy for longer than the intake work below takes.
    const held = runBusyProcessForTest({
      spinMs: 4_000,
      timeoutMs: 15_000,
      admission: "preview",
    }).then((outcome) => {
      previewSettled = true;
      return outcome;
    });

    try {
      const preview = await renderPdfPageIsolated(
        fixture,
        { ...limits, admission: "preview" },
        { page: 1 },
      );
      expect(preview.ok).toBe(false);
      if (!preview.ok) expect(preview.code).toBe("busy");

      const intake = await validateIntakeDocument({
        bytes: fixture,
        declaredMimeType: "application/pdf",
      });
      expect(intake.ok).toBe(true);
      // Intake finished while every preview slot was still occupied.
      expect(previewSettled).toBe(false);
    } finally {
      if (previousQueued === undefined) {
        process.env.IW_PDF_PREVIEW_MAX_QUEUED = "";
      } else {
        process.env.IW_PDF_PREVIEW_MAX_QUEUED = previousQueued;
      }
    }

    const { readySeen, result } = await held;
    expect(readySeen).toBe(true);
    expect(result.ok).toBe(true);
  }, 20_000);

  test("fails closed when the RSS sampler cannot run", async () => {
    const { readySeen, result } = await runMemoryHogForTest({
      targetBytes: 16 * 1024 * 1024,
      maxProcessRssBytes: 1 * 1024 * 1024,
      timeoutMs: 5_000,
      rssSamplerCommand: "/invoicewise/definitely-missing-ps",
    });

    expect(readySeen).toBe(true);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("monitor_unavailable");
      expect(result.terminated).toBe(true);
    }
  });

  for (const [name, objects] of Object.entries(brokenPageTrees)) {
    test(`classifies ${name} as malformed, not transient`, async () => {
      const bytes = rawPdf(objects);

      const raw = await inspectPdfIsolated(bytes, limits);
      expect(raw.ok).toBe(false);
      if (!raw.ok) {
        expect(raw.code).toBe("malformed");
        expect(raw.terminated).toBe(false);
      }

      const text = await extractPdfTextIsolated(bytes, limits);
      expect(text.ok).toBe(false);
      if (!text.ok) expect(text.code).toBe("malformed");

      // A permanent rejection, so mailbox callers do not retry it forever.
      const validation = await validateIntakeDocument({
        bytes,
        declaredMimeType: "application/pdf",
      });
      expect(validation.ok).toBe(false);
      if (!validation.ok) expect(validation.code).toBe("malformed");
    });
  }

  test("tolerates recoverable page-tree defects", async () => {
    // pdf.js repairs a wrong /Count and ignores an unusable /MediaBox; these
    // stay acceptable rather than being rejected by the new classification.
    const page = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>";
    for (const objects of [
      [CATALOG, "<< /Type /Pages /Count 3 /Kids [3 0 R] >>", page],
      [
        CATALOG,
        "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox /Foo >>",
      ],
    ]) {
      const result = await validateIntakeDocument({
        bytes: rawPdf(objects),
        declaredMimeType: "application/pdf",
      });
      expect(result.ok).toBe(true);
    }
  });

  test("does not hand the parent environment to the child", async () => {
    const previous = process.env.INVOICEWISE_TEST_SECRET;
    process.env.INVOICEWISE_TEST_SECRET = "must-not-leak";
    try {
      const { result } = await runBusyProcessForTest({
        spinMs: 1,
        timeoutMs: 10_000,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.envKeys).not.toContain("INVOICEWISE_TEST_SECRET");
        expect(result.result.envKeys).toContain("IW_TASK");
      }
    } finally {
      if (previous === undefined) {
        Reflect.deleteProperty(process.env, "INVOICEWISE_TEST_SECRET");
      } else {
        process.env.INVOICEWISE_TEST_SECRET = previous;
      }
    }
  });
});
