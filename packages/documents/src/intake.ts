import { createHash } from "node:crypto";
import sharp from "sharp";
import { inspectPdfIsolated } from "./isolated";

/**
 * Resource bounds applied before any invoice is accepted for processing.
 *
 * The byte limit matches the dashboard upload contract (5 MB). Page, pixel and
 * dimension limits are conservative bounds on the work the PDF and image
 * parsers may be asked to do; they are deliberately below the point where a
 * malformed or adversarial document can pin a worker.
 */
export type IntakeLimits = {
  maxBytes: number;
  maxPdfPages: number;
  maxPdfPageDimension: number;
  maxPdfTotalPixels: number;
  maxImagePixels: number;
  maxImageDimension: number;
  maxValidationMs: number;
};

export const INTAKE_LIMITS: IntakeLimits = {
  maxBytes: 5_000_000,
  maxPdfPages: 50,
  /**
   * Rendering work bounds. Page count alone is not a decompression bound, so a
   * document is also rejected when any page, or the sum of its pages, exceeds
   * the pixels a renderer would have to materialise.
   */
  maxPdfPageDimension: 10_000,
  maxPdfTotalPixels: 100_000_000,
  maxImagePixels: 25_000_000,
  maxImageDimension: 10_000,
  /** Wall-clock bound on the parser work done before accepting a document. */
  maxValidationMs: 15_000,
};

/**
 * Observable image-decode counter. PDF parser cancellation is reported by
 * `isolatedPdfDiagnostics` in `./isolated`.
 */
export const intakeParserDiagnostics = {
  imageDecodes: 0,
};

export type IntakeDocumentKind = "pdf" | "jpeg" | "png";

export type IntakeFailureCode =
  | "empty"
  | "too_large"
  | "unsupported_type"
  | "content_mismatch"
  | "malformed"
  | "password_protected"
  | "too_many_pages"
  | "page_too_large"
  | "image_too_large"
  | "timeout"
  | "temporarily_unavailable"
  | "resource_limit";

export type IntakeValidation =
  | {
      ok: true;
      kind: IntakeDocumentKind;
      mimeType: string;
      size: number;
      pageCount: number | null;
      width: number | null;
      height: number | null;
    }
  | {
      ok: false;
      code: IntakeFailureCode;
      message: string;
    };

export type ValidateIntakeDocumentInput = {
  bytes: Uint8Array;
  /** MIME type the client or mailbox declared. Never trusted as proof. */
  declaredMimeType?: string | null;
  fileName?: string | null;
  limits?: Partial<IntakeLimits>;
};

const MIME_BY_KIND: Record<IntakeDocumentKind, string> = {
  pdf: "application/pdf",
  jpeg: "image/jpeg",
  png: "image/png",
};

const DECLARED_MIME_KINDS: Record<string, IntakeDocumentKind | "opaque"> = {
  "application/pdf": "pdf",
  "application/x-pdf": "pdf",
  "image/jpeg": "jpeg",
  "image/jpg": "jpeg",
  "image/png": "png",
  // Mailbox attachments often arrive with a generic content type. Only a PDF
  // body is accepted under this declaration.
  "application/octet-stream": "opaque",
};

const startsWith = (bytes: Uint8Array, signature: readonly number[]) =>
  signature.every((byte, index) => bytes[index] === byte);

/** Detects the real document kind from the leading bytes. */
export function sniffIntakeKind(bytes: Uint8Array): IntakeDocumentKind | null {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "pdf";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "png";
  }
  return null;
}

const failure = (
  code: IntakeFailureCode,
  message: string,
): IntakeValidation => ({
  ok: false,
  code,
  message,
});

const describeKind = (kind: IntakeDocumentKind | "opaque") =>
  kind === "opaque" ? "a document" : MIME_BY_KIND[kind];

type PdfStructure = {
  pageCount: number;
  maxPageDimension: number;
  totalPixels: number;
};

class IntakeTemporarilyUnavailableError extends Error {
  override readonly name = "IntakeTemporarilyUnavailableError";
}

class IntakeResourceLimitError extends Error {
  override readonly name = "IntakeResourceLimitError";
}

/**
 * Reads the PDF structure through the isolated process. The child is killed on
 * timeout, so a pathological document cannot pin the parent with synchronous
 * decode work, and the page geometry is bounded so renderers cannot be asked
 * to materialise an unbounded page.
 */
async function readPdfStructure(
  bytes: Uint8Array,
  limits: {
    maxPdfPages: number;
    maxPdfPageDimension: number;
    maxPdfTotalPixels: number;
    maxValidationMs: number;
  },
): Promise<PdfStructure> {
  const result = await inspectPdfIsolated(bytes, {
    timeoutMs: limits.maxValidationMs,
    maxPages: limits.maxPdfPages,
    maxPageDimension: limits.maxPdfPageDimension,
    maxTotalPixels: limits.maxPdfTotalPixels,
    maxChars: 0,
  });

  if (!result.ok) {
    // `task_failed` is operational only (the child could not start or load
    // pdf.js); a document that opens and then fails to parse is reported by
    // the child as `malformed`, which is permanent.
    if (
      result.code === "busy" ||
      result.code === "task_failed" ||
      result.code === "monitor_unavailable"
    ) {
      throw new IntakeTemporarilyUnavailableError(result.message);
    }
    if (
      result.code === "memory_limit" ||
      result.code === "output_limit" ||
      result.code === "limit"
    ) {
      throw new IntakeResourceLimitError(result.message);
    }

    const error = new Error(result.message);
    error.name =
      result.code === "timeout"
        ? "IntakeTimeoutError"
        : result.code === "password_protected"
          ? "PasswordException"
          : "PdfMalformedError";
    throw error;
  }

  if (result.result.pageCount > limits.maxPdfPages) {
    throw new PdfTooManyPagesError(result.result.pageCount);
  }
  if (
    result.result.maxPageDimension > limits.maxPdfPageDimension ||
    result.result.totalPixels > limits.maxPdfTotalPixels
  ) {
    throw new PdfPageTooLargeError(result.result.maxPageDimension);
  }

  return result.result;
}

class PdfTooManyPagesError extends Error {
  override readonly name = "PdfTooManyPagesError";
  constructor(readonly pageCount: number) {
    super(`PDF has ${pageCount} pages`);
  }
}

class PdfPageTooLargeError extends Error {
  override readonly name = "PdfPageTooLargeError";
  constructor(readonly dimension: number) {
    super(`PDF page is ${dimension}px`);
  }
}

/**
 * Decodes an image body far enough to prove it is complete. The header is
 * parsed first so oversized inputs are rejected before a full decode, then a
 * downscaled decode forces the decoder to consume the whole stream.
 */
async function decodeImage(
  bytes: Uint8Array,
  kind: "png" | "jpeg",
  limits: { maxImagePixels: number; maxImageDimension: number },
): Promise<{ width: number; height: number }> {
  const input = Buffer.from(bytes);

  let metadata: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
  try {
    metadata = await sharp(input, {
      limitInputPixels: limits.maxImagePixels,
      sequentialRead: true,
    }).metadata();
  } catch (error) {
    // libvips refuses to even parse an image above the pixel limit.
    if (String((error as Error)?.message).includes("pixel limit")) {
      throw new IntakeImageError("too_large");
    }
    throw new IntakeImageError("malformed");
  }

  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  const expectedFormat = kind === "png" ? "png" : "jpeg";

  if (!width || !height || metadata.format !== expectedFormat) {
    throw new IntakeImageError("malformed");
  }

  if (
    width > limits.maxImageDimension ||
    height > limits.maxImageDimension ||
    width * height > limits.maxImagePixels
  ) {
    throw new IntakeImageError("too_large");
  }

  intakeParserDiagnostics.imageDecodes += 1;

  // A truncated or corrupt body fails here, after the bounds above have
  // already capped how much the decoder can be asked to materialise.
  await sharp(input, {
    limitInputPixels: limits.maxImagePixels,
    sequentialRead: true,
  })
    .resize({ width: 1, height: 1, fit: "inside" })
    .toBuffer();

  return { width, height };
}

class IntakeImageError extends Error {
  override readonly name = "IntakeImageError";
  constructor(readonly code: "malformed" | "too_large") {
    super(
      code === "too_large"
        ? "Image exceeds the pixel bound"
        : "Image is malformed",
    );
  }
}

/**
 * Decodes an image fully and returns its real content type. Used by upload
 * paths that store images outside the invoice lifecycle, so they reject
 * truncated bodies with the same decoder and bounds as invoice intake.
 */
export async function decodeIntakeImage(
  bytes: Uint8Array,
  limits?: Partial<IntakeLimits>,
): Promise<{ mimeType: string; width: number; height: number }> {
  const kind = sniffIntakeKind(bytes);
  if (kind !== "png" && kind !== "jpeg") {
    throw new IntakeImageError("malformed");
  }

  const effective = { ...INTAKE_LIMITS, ...limits };
  const { width, height } = await decodeImage(bytes, kind, effective);
  return { mimeType: MIME_BY_KIND[kind], width, height };
}

/**
 * Validates the actual bytes of an intake document.
 *
 * The declared MIME type is checked against the sniffed content, the byte size
 * is bounded, PDFs are parsed far enough to prove page count and reject
 * encrypted or malformed files, and images are bounded by dimensions and
 * decoded pixel count. Only PDF, JPEG and PNG are accepted.
 */
export async function validateIntakeDocument(
  input: ValidateIntakeDocumentInput,
): Promise<IntakeValidation> {
  const limits = { ...INTAKE_LIMITS, ...input.limits };
  const { bytes } = input;
  const size = bytes.byteLength;

  if (size === 0) {
    return failure("empty", "The document is empty.");
  }

  if (size > limits.maxBytes) {
    return failure(
      "too_large",
      `Documents must be ${limits.maxBytes} bytes or smaller.`,
    );
  }

  const declared = input.declaredMimeType?.split(";")[0]?.trim().toLowerCase();
  const declaredKind = declared ? DECLARED_MIME_KINDS[declared] : undefined;

  if (declared && !declaredKind) {
    return failure(
      "unsupported_type",
      `Unsupported document type ${declared}. Only PDF, JPEG and PNG invoices are accepted.`,
    );
  }

  const kind = sniffIntakeKind(bytes);

  if (!kind) {
    return failure(
      "unsupported_type",
      "Unsupported document content. Only PDF, JPEG and PNG invoices are accepted.",
    );
  }

  if (declaredKind && declaredKind !== "opaque" && declaredKind !== kind) {
    return failure(
      "content_mismatch",
      `The file declares ${declared} but contains ${describeKind(kind)}.`,
    );
  }

  if (declaredKind === "opaque" && kind !== "pdf") {
    return failure(
      "content_mismatch",
      "Generic binary attachments are only accepted when they contain a PDF.",
    );
  }

  if (kind === "pdf") {
    let structure: PdfStructure;
    try {
      structure = await readPdfStructure(bytes, limits);
    } catch (error) {
      const name = (error as { name?: string } | null)?.name;
      if (name === "PasswordException") {
        return failure(
          "password_protected",
          "Password-protected PDFs are not supported. Upload an unlocked copy.",
        );
      }
      if (name === "IntakeTimeoutError") {
        return failure(
          "timeout",
          "The document took too long to read and the parse was cancelled.",
        );
      }
      if (name === "IntakeTemporarilyUnavailableError") {
        return failure(
          "temporarily_unavailable",
          "The document parser is temporarily at capacity and the upload was not accepted. Retry the delivery.",
        );
      }
      if (name === "IntakeResourceLimitError") {
        return failure(
          "resource_limit",
          "The PDF exceeded the isolated parser resource limits. It was not accepted; upload a smaller document or inspect it manually.",
        );
      }
      if (name === "PdfTooManyPagesError") {
        return failure(
          "too_many_pages",
          `PDFs with more than ${limits.maxPdfPages} pages are not supported.`,
        );
      }
      if (name === "PdfPageTooLargeError") {
        return failure(
          "page_too_large",
          `PDF pages are limited to ${limits.maxPdfPageDimension}px per side and ${limits.maxPdfTotalPixels} pixels in total.`,
        );
      }
      return failure(
        "malformed",
        "The PDF could not be read. It may be corrupt or malformed.",
      );
    }

    if (!Number.isFinite(structure.pageCount) || structure.pageCount < 1) {
      return failure("malformed", "The PDF contains no readable pages.");
    }

    return {
      ok: true,
      kind,
      mimeType: MIME_BY_KIND[kind],
      size,
      pageCount: structure.pageCount,
      width: null,
      height: null,
    };
  }

  let width: number;
  let height: number;
  try {
    ({ width, height } = await decodeImage(bytes, kind, limits));
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === "too_large") {
      return failure(
        "image_too_large",
        `Images are limited to ${limits.maxImageDimension}px per side and ${limits.maxImagePixels} pixels.`,
      );
    }
    return failure(
      "malformed",
      `The ${kind === "png" ? "PNG" : "JPEG"} could not be decoded. It may be truncated or corrupt.`,
    );
  }

  return {
    ok: true,
    kind,
    mimeType: MIME_BY_KIND[kind],
    size,
    pageCount: null,
    width,
    height,
  };
}

/** Cheap re-check used by workers before any provider work. */
export function checkStoredIntakeBytes(input: {
  bytes: Uint8Array;
  expectedMimeType?: string | null;
  expectedSize?: number | null;
  /** sha256 recorded at acceptance; the bytes must still match it. */
  expectedHash?: string | null;
  limits?: Partial<IntakeLimits>;
}) {
  const limits = { ...INTAKE_LIMITS, ...input.limits };
  const { bytes } = input;

  if (bytes.byteLength === 0) {
    return failure("empty", "The stored document is empty.");
  }

  if (bytes.byteLength > limits.maxBytes) {
    return failure(
      "too_large",
      `Stored documents must be ${limits.maxBytes} bytes or smaller.`,
    );
  }

  if (
    typeof input.expectedSize === "number" &&
    input.expectedSize !== bytes.byteLength
  ) {
    return failure(
      "content_mismatch",
      "The stored document size does not match its intake record.",
    );
  }

  if (input.expectedHash) {
    const actualHash = createHash("sha256").update(bytes).digest("hex");
    if (actualHash !== input.expectedHash) {
      return failure(
        "content_mismatch",
        "The stored document does not match the content accepted for this record.",
      );
    }
  }

  const kind = sniffIntakeKind(bytes);
  if (!kind) {
    return failure(
      "unsupported_type",
      "Unsupported document content. Only PDF, JPEG and PNG invoices are accepted.",
    );
  }

  const declared = input.expectedMimeType?.split(";")[0]?.trim().toLowerCase();
  const declaredKind = declared ? DECLARED_MIME_KINDS[declared] : undefined;

  if (declaredKind && declaredKind !== "opaque" && declaredKind !== kind) {
    return failure(
      "content_mismatch",
      "The stored document does not match the type recorded at intake.",
    );
  }

  return {
    ok: true as const,
    kind,
    mimeType: MIME_BY_KIND[kind],
    size: bytes.byteLength,
    pageCount: null,
    width: null,
    height: null,
  };
}
