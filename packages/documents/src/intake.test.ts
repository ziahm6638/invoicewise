import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";
import {
  HEIC_UNSUPPORTED_MESSAGE,
  INTAKE_LIMITS,
  checkStoredIntakeBytes,
  isHeifContent,
  sniffIntakeKind,
  validateIntakeDocument,
} from "./intake";
import {
  isolatedPdfDiagnostics,
  runBusyProcessForTest,
  runMemoryHogForTest,
} from "./isolated";

/** Minimal, deterministic PDF builder used for parser-bound fixtures. */
function buildPdf(
  pageCount: number,
  options: { encrypt?: boolean } = {},
): Uint8Array {
  const objects: string[] = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
  ];
  const kids = Array.from(
    { length: pageCount },
    (_, index) => `${index + 3} 0 R`,
  ).join(" ");
  objects.push(
    `2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>\nendobj\n`,
  );
  for (let index = 0; index < pageCount; index++) {
    objects.push(
      `${index + 3} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>\nendobj\n`,
    );
  }

  let encryption = "";
  if (options.encrypt) {
    const encryptId = pageCount + 3;
    objects.push(
      `${encryptId} 0 obj\n<< /Filter /Standard /V 1 /R 2 /O <${"ab".repeat(32)}> /U <${"cd".repeat(32)}> /P -1 >>\nendobj\n`,
    );
    encryption = ` /Encrypt ${encryptId} 0 R /ID [<${"11".repeat(16)}> <${"11".repeat(16)}>]`;
  }

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
  output += `trailer\n<< /Size ${size} /Root 1 0 R${encryption} >>\nstartxref\n${xrefStart}\n%%EOF\n`;

  return new TextEncoder().encode(output);
}

/** Real, complete images so the decoder path is genuinely exercised. */
async function buildPng(width: number, height: number): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({ create: { width, height, channels: 3, background: "white" } })
      .png()
      .toBuffer(),
  );
}

async function buildJpeg(width: number, height: number): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({ create: { width, height, channels: 3, background: "white" } })
      .jpeg()
      .toBuffer(),
  );
}

/** Header-only body with no pixel data: it must not be accepted. */
function headerOnlyPngSize(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

const headerOnlyPng = () => headerOnlyPngSize(1, 1);

/** A one-page PDF with an explicit (possibly pathological) MediaBox. */
function buildPdfWithPageSize(width: number, height: number): Uint8Array {
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
  return new TextEncoder().encode(output);
}

const syntheticInvoice = new Uint8Array(
  await readFile(resolve(__dirname, "test/fixtures/synthetic-invoice.pdf")),
);

describe("intake document validation", () => {
  test("sniffs supported document kinds from real bytes", async () => {
    expect(sniffIntakeKind(syntheticInvoice)).toBe("pdf");
    expect(sniffIntakeKind(await buildPng(10, 10))).toBe("png");
    expect(sniffIntakeKind(await buildJpeg(10, 10))).toBe("jpeg");
    expect(sniffIntakeKind(new Uint8Array([0x47, 0x49, 0x46, 0x38]))).toBe(
      null,
    );
  });

  test("accepts a real PDF with a matching declaration", async () => {
    const result = await validateIntakeDocument({
      bytes: syntheticInvoice,
      declaredMimeType: "application/pdf",
      fileName: "invoice.pdf",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kind).toBe("pdf");
    expect(result.pageCount).toBe(1);
  });

  test("rejects empty and oversized documents", async () => {
    const empty = await validateIntakeDocument({ bytes: new Uint8Array() });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.code).toBe("empty");

    const oversized = await validateIntakeDocument({
      bytes: new Uint8Array(INTAKE_LIMITS.maxBytes + 1),
    });
    expect(oversized.ok).toBe(false);
    if (!oversized.ok) expect(oversized.code).toBe("too_large");
  });

  test("rejects unsupported formats instead of pretending they are accepted", async () => {
    for (const declaredMimeType of [
      "image/webp",
      "image/heic",
      "image/gif",
      "text/plain",
    ]) {
      const result = await validateIntakeDocument({
        bytes: syntheticInvoice,
        declaredMimeType,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("unsupported_type");
    }

    const disguised = await validateIntakeDocument({
      bytes: new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00]),
      declaredMimeType: "application/pdf",
    });
    expect(disguised.ok).toBe(false);
    if (!disguised.ok) expect(disguised.code).toBe("unsupported_type");
  });

  test("rejects a declared type that does not match the bytes", async () => {
    const spoofed = await validateIntakeDocument({
      bytes: await buildPng(10, 10),
      declaredMimeType: "application/pdf",
    });
    expect(spoofed.ok).toBe(false);
    if (!spoofed.ok) expect(spoofed.code).toBe("content_mismatch");

    const opaqueImage = await validateIntakeDocument({
      bytes: await buildJpeg(10, 10),
      declaredMimeType: "application/octet-stream",
    });
    expect(opaqueImage.ok).toBe(false);
    if (!opaqueImage.ok) expect(opaqueImage.code).toBe("content_mismatch");
  });

  test("refuses HEIC photos with a message that says how to send them", async () => {
    // An ISO-BMFF `ftyp` box with the `heic` brand, as an iPhone writes it.
    const heic = new Uint8Array([
      0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63,
      0x00, 0x00, 0x00, 0x00, 0x6d, 0x69, 0x66, 0x31, 0x68, 0x65, 0x69, 0x63,
    ]);
    expect(isHeifContent(heic)).toBe(true);

    for (const declaredMimeType of [
      "image/heic",
      "image/heif",
      "application/octet-stream",
      null,
    ]) {
      const result = await validateIntakeDocument({
        bytes: heic,
        declaredMimeType,
      });
      expect(result).toEqual({
        ok: false,
        code: "unsupported_type",
        message: HEIC_UNSUPPORTED_MESSAGE,
      });
    }
    expect(HEIC_UNSUPPORTED_MESSAGE).toContain("JPEG");
  });

  test("rejects malformed and password-protected PDFs", async () => {
    const malformed = await validateIntakeDocument({
      bytes: new TextEncoder().encode("%PDF-1.4\nnot really a pdf"),
      declaredMimeType: "application/pdf",
    });
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.code).toBe("malformed");

    const encrypted = await validateIntakeDocument({
      bytes: buildPdf(1, { encrypt: true }),
      declaredMimeType: "application/pdf",
    });
    expect(encrypted.ok).toBe(false);
    if (!encrypted.ok) expect(encrypted.code).toBe("password_protected");
  });

  test("bounds PDF page count before extraction work", async () => {
    const withinBound = await validateIntakeDocument({
      bytes: buildPdf(INTAKE_LIMITS.maxPdfPages),
      declaredMimeType: "application/pdf",
    });
    expect(withinBound.ok).toBe(true);

    const overBound = await validateIntakeDocument({
      bytes: buildPdf(INTAKE_LIMITS.maxPdfPages + 1),
      declaredMimeType: "application/pdf",
    });
    expect(overBound.ok).toBe(false);
    if (!overBound.ok) expect(overBound.code).toBe("too_many_pages");
  });

  test("bounds image dimensions and decoded pixels", async () => {
    const accepted = await validateIntakeDocument({
      bytes: await buildJpeg(1200, 900),
      declaredMimeType: "image/jpeg",
    });
    expect(accepted.ok).toBe(true);
    if (accepted.ok) {
      expect(accepted.width).toBe(1200);
      expect(accepted.height).toBe(900);
    }

    const tooWide = await validateIntakeDocument({
      bytes: await buildPng(INTAKE_LIMITS.maxImageDimension + 1, 10),
      declaredMimeType: "image/png",
    });
    expect(tooWide.ok).toBe(false);
    if (!tooWide.ok) expect(tooWide.code).toBe("image_too_large");

    // The decoded-pixel ceiling is exercised with a small bound rather than an
    // 81-megapixel fixture.
    const tooManyPixels = await validateIntakeDocument({
      bytes: await buildPng(64, 64),
      declaredMimeType: "image/png",
      limits: { maxImagePixels: 100 },
    });
    expect(tooManyPixels.ok).toBe(false);
    if (!tooManyPixels.ok) expect(tooManyPixels.code).toBe("image_too_large");
  });

  test("worker re-check rejects a size that disagrees with the intake record", () => {
    const mismatch = checkStoredIntakeBytes({
      bytes: syntheticInvoice,
      expectedMimeType: "application/pdf",
      expectedSize: syntheticInvoice.byteLength + 1,
    });
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.code).toBe("content_mismatch");

    const accepted = checkStoredIntakeBytes({
      bytes: syntheticInvoice,
      expectedMimeType: "application/pdf",
      expectedSize: syntheticInvoice.byteLength,
    });
    expect(accepted.ok).toBe(true);
  });

  test("rejects header-only and truncated image bodies", async () => {
    const header = await validateIntakeDocument({
      bytes: headerOnlyPng(),
      declaredMimeType: "image/png",
    });
    expect(header.ok).toBe(false);
    if (!header.ok) expect(header.code).toBe("malformed");

    const completePng = await buildPng(64, 64);
    const truncatedPng = completePng.subarray(
      0,
      Math.floor(completePng.byteLength / 2),
    );
    const truncated = await validateIntakeDocument({
      bytes: truncatedPng,
      declaredMimeType: "image/png",
    });
    expect(truncated.ok).toBe(false);
    if (!truncated.ok) expect(truncated.code).toBe("malformed");

    const completeJpeg = await buildJpeg(64, 64);
    const truncatedJpeg = await validateIntakeDocument({
      bytes: completeJpeg.subarray(0, 40),
      declaredMimeType: "image/jpeg",
    });
    expect(truncatedJpeg.ok).toBe(false);
  });

  test("bounds PDF page geometry, not just page count", async () => {
    const pathological = buildPdfWithPageSize(20_000, 20_000);
    const result = await validateIntakeDocument({
      bytes: pathological,
      declaredMimeType: "application/pdf",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("page_too_large");
  });

  test("terminates active PDF work when the wall-clock bound expires", async () => {
    const before = isolatedPdfDiagnostics.processesTerminated;
    const result = await validateIntakeDocument({
      bytes: buildPdf(50),
      declaredMimeType: "application/pdf",
      // A 1ms budget cannot cover spawning a process and parsing 50 pages, so
      // the process is killed; the parent keeps running and reports a timeout.
      limits: { maxValidationMs: 1 },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("timeout");
    expect(isolatedPdfDiagnostics.processesTerminated).toBeGreaterThan(before);
    // The parent survived and can still do work afterwards.
    const after = await validateIntakeDocument({
      bytes: syntheticInvoice,
      declaredMimeType: "application/pdf",
    });
    expect(after.ok).toBe(true);
  });

  test("reports parser admission as a retryable temporary failure", async () => {
    const previous = process.env.IW_PDF_MAX_CONCURRENT;
    const previousQueued = process.env.IW_PDF_MAX_QUEUED;
    process.env.IW_PDF_MAX_CONCURRENT = "0";
    process.env.IW_PDF_MAX_QUEUED = "0";
    try {
      const result = await validateIntakeDocument({
        bytes: syntheticInvoice,
        declaredMimeType: "application/pdf",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("temporarily_unavailable");
      }
    } finally {
      if (previous === undefined) {
        process.env.IW_PDF_MAX_CONCURRENT = "";
      } else {
        process.env.IW_PDF_MAX_CONCURRENT = previous;
      }
      if (previousQueued === undefined) {
        process.env.IW_PDF_MAX_QUEUED = "";
      } else {
        process.env.IW_PDF_MAX_QUEUED = previousQueued;
      }
    }

    // Capacity is an attempt-level condition, not a property of the valid
    // document: the same bytes validate normally once admission is available.
    const recovered = await validateIntakeDocument({
      bytes: syntheticInvoice,
      declaredMimeType: "application/pdf",
    });
    expect(recovered.ok).toBe(true);
  });

  test("terminates a process that is busy with synchronous work", async () => {
    const started = Date.now();
    const { readySeen, result } = await runBusyProcessForTest({
      spinMs: 5_000,
      timeoutMs: 400,
    });

    // The child reported it had started working before it was killed, so this
    // proves active-work termination rather than a startup timeout.
    expect(readySeen).toBe(true);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("timeout");
      expect(result.terminated).toBe(true);
    }
    // The 5s spin was cut short rather than allowed to finish.
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  test("kills a process that exceeds the memory budget and survives it", async () => {
    const { readySeen, result } = await runMemoryHogForTest({
      // Small budgets only: the child is killed long before it could affect
      // the host, and the parent must remain usable afterwards.
      targetBytes: 256 * 1024 * 1024,
      maxProcessRssBytes: 96 * 1024 * 1024,
      timeoutMs: 30_000,
    });

    expect(readySeen).toBe(true);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("memory_limit");
      expect(result.terminated).toBe(true);
    }
    expect(isolatedPdfDiagnostics.peakRssBytes).toBeGreaterThan(0);

    const after = await validateIntakeDocument({
      bytes: syntheticInvoice,
      declaredMimeType: "application/pdf",
    });
    expect(after.ok).toBe(true);
  });

  test("worker re-check compares the immutable content hash", () => {
    const acceptedHash = createHash("sha256")
      .update(syntheticInvoice)
      .digest("hex");

    const mismatch = checkStoredIntakeBytes({
      bytes: syntheticInvoice,
      expectedSize: syntheticInvoice.byteLength,
      expectedHash: acceptedHash.replace(/^./, "0"),
    });
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.code).toBe("content_mismatch");

    const accepted = checkStoredIntakeBytes({
      bytes: syntheticInvoice,
      expectedSize: syntheticInvoice.byteLength,
      expectedHash: acceptedHash,
    });
    expect(accepted.ok).toBe(true);
  });
});
