import { getPdfImage } from "@/utils/pdf-to-img";
import { download } from "@invoicewise/db/storage";
import type { NextRequest } from "next/server";
import { resolveDocumentBinding } from "../documents/binding";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const binding = await resolveDocumentBinding(searchParams.get("id"));

  if (!binding?.filePath?.length) {
    return new Response("Not found", { status: 404 });
  }

  if ((binding.contentType ?? "") !== "application/pdf") {
    return new Response("File is not a PDF", { status: 400 });
  }

  let pdfBlob: Blob;
  try {
    pdfBlob = await download({ bucket: "vault", path: binding.filePath });
  } catch {
    return new Response("Error downloading file", { status: 500 });
  }

  try {
    const pdfBuffer = await pdfBlob.arrayBuffer();
    const imageBuffer = await getPdfImage(pdfBuffer);

    if (!imageBuffer) {
      return new Response("Failed to convert PDF to image", { status: 500 });
    }

    return new Response(new Uint8Array(imageBuffer), {
      headers: {
        "Content-Type": "image/png",
        // Rendered invoice pages are tenant content and must never enter a
        // shared or CDN cache.
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return new Response(
      `PDF to PNG conversion failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { status: 500 },
    );
  }
}
