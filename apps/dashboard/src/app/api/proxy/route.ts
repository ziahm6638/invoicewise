import { download } from "@invoicewise/db/storage";
import type { NextRequest } from "next/server";
import { documentHeaders, resolveDocumentBinding } from "../documents/binding";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const binding = await resolveDocumentBinding(searchParams.get("id"));

  if (!binding?.filePath?.length) {
    return new Response("Not found", { status: 404 });
  }

  const downloadFile = searchParams.get("download") === "1";

  try {
    const data = await download({ bucket: "vault", path: binding.filePath });
    return new Response(data, {
      headers: documentHeaders({
        contentType: binding.contentType ?? data.type,
        fileName: binding.fileName ?? "document",
        download: downloadFile,
      }),
    });
  } catch {
    return new Response("File not found", { status: 404 });
  }
}
