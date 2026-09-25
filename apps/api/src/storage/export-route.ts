import type { PrimaryDatabase } from "@invoicewise/db/client";
import { primaryDb } from "@invoicewise/db/client";
import { getDataExportById } from "@invoicewise/db/queries";
import {
  openRead as defaultOpenRead,
  verifySignedExportUrl,
} from "@invoicewise/db/storage";
import { isDataExportObjectPath } from "@invoicewise/jobs/data-export";

export type ExportRouteDeps = {
  db: PrimaryDatabase;
  openRead: typeof defaultOpenRead;
  now?: () => number;
};

const defaultDeps = (): ExportRouteDeps => ({
  db: primaryDb,
  openRead: defaultOpenRead,
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const unavailable = () =>
  Response.json(
    { error: "Invalid or expired export link" },
    { status: 401, headers: { "Cache-Control": "private, no-store" } },
  );

/**
 * Serves a workspace export archive to the holder of a signed, short-lived
 * link. The link names only the export request; the request is re-read on
 * every use, so an export that expired, failed or went with its workspace
 * stops downloading immediately, and only the archive path recorded for that
 * request (inside its workspace's prefix) is ever read.
 */
export async function exportDownloadResponse(
  request: Request,
  deps: ExportRouteDeps = defaultDeps(),
): Promise<Response> {
  const url = new URL(request.url);
  const [, exportId = "", action] = url.pathname.split("/").filter(Boolean);
  const expires = Number(url.searchParams.get("expires"));
  const providedSignature = url.searchParams.get("signature") ?? "";

  let valid = false;
  try {
    valid =
      action === "download" &&
      UUID.test(exportId) &&
      Number.isFinite(expires) &&
      verifySignedExportUrl({ exportId, expires, providedSignature });
  } catch {
    valid = false;
  }
  if (!valid) return unavailable();

  const row = await getDataExportById(deps.db, exportId);
  const now = deps.now?.() ?? Date.now();
  if (
    !row ||
    row.status !== "ready" ||
    !row.expiresAt ||
    Date.parse(row.expiresAt) <= now ||
    !isDataExportObjectPath(row.filePath, row.teamId, row.id)
  ) {
    return unavailable();
  }

  try {
    const object = await deps.openRead({
      bucket: "vault",
      path: row.filePath!,
    });
    const fileName = (row.fileName ?? "invoicewise-export.zip").replace(
      /[^\w.\-]/g,
      "_",
    );
    return new Response(object.stream, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Length": String(object.size),
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  } catch {
    return Response.json({ error: "Export not found" }, { status: 404 });
  }
}
