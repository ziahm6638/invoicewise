import { renderPdfPageIsolated } from "@invoicewise/documents";

/**
 * Bounds for preview rendering. A preview is only a first-page thumbnail, so
 * it must never allocate a canvas from an attacker-controlled MediaBox.
 */
const PREVIEW_MAX_DIMENSION = 10_000;
const PREVIEW_MAX_PIXELS = 25_000_000;
const PREVIEW_SCALE = 2;
const PREVIEW_TIMEOUT_MS = 12_000;

/**
 * Renders the first page of a PDF through the isolated PDF worker.
 *
 * pdf.js cannot be interrupted on the main thread in Node/Bun, so the render
 * happens in a child process that is terminated on timeout or on exceeding the
 * page bounds. Returns null when the document cannot be rendered inside those
 * bounds.
 */
export async function getPdfImage(data: ArrayBuffer) {
  const result = await renderPdfPageIsolated(
    new Uint8Array(data),
    {
      timeoutMs: PREVIEW_TIMEOUT_MS,
      maxPages: 50,
      maxPageDimension: PREVIEW_MAX_DIMENSION,
      maxTotalPixels: PREVIEW_MAX_PIXELS,
      maxChars: 0,
      // Previews have their own admission pool: preview traffic can never
      // take the parser capacity invoice intake depends on.
      admission: "preview",
    },
    {
      page: 1,
      scale: PREVIEW_SCALE,
      maxDimension: PREVIEW_MAX_DIMENSION,
      maxPixels: PREVIEW_MAX_PIXELS,
    },
  );

  if (!result.ok) return null;
  return Buffer.from(result.result.png);
}
