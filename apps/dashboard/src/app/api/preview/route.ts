import { getSession } from "@/lib/auth";
import { getPdfImage } from "@/utils/pdf-to-img";
import { download } from "@midday/db/storage";
import type { NextRequest } from "next/server";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  let filePath = searchParams.get("filePath");

  if (!filePath) {
    return new Response("No file path provided", { status: 400 });
  }

  // Remove 'vault/' prefix if it exists
  if (filePath.startsWith("vault/")) {
    filePath = filePath.substring("vault/".length);
  }

  const session = await getSession();
  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }

  if (!session.teamId || filePath.split("/")[0] !== session.teamId) {
    return new Response("Forbidden", { status: 403 });
  }

  let pdfBlob: Blob;
  try {
    pdfBlob = await download({ bucket: "vault", path: filePath });
  } catch {
    return new Response("Error downloading file", { status: 500 });
  }

  if (pdfBlob.type !== "application/pdf") {
    return new Response("File is not a PDF", { status: 400 });
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
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch (error: unknown) {
    throw new Error(
      `PDF to PNG conversion failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
