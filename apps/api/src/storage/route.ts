import type { PrimaryDatabase } from "@invoicewise/db/client";
import { primaryDb } from "@invoicewise/db/client";
import { getInboxIntakeBinding } from "@invoicewise/db/queries";
import {
  download as defaultDownload,
  verifySignedUrl,
} from "@invoicewise/db/storage";

export type StorageRouteDeps = {
  db: PrimaryDatabase;
  download: typeof defaultDownload;
};

const defaultDeps = (): StorageRouteDeps => ({
  db: primaryDb,
  download: defaultDownload,
});

/**
 * Filenames come from user metadata, so they are quoted safely for a
 * Content-Disposition header.
 */
const contentDisposition = (download: boolean, fileName: string) => {
  const safe = fileName.replace(/[^\w.\- ]/g, "_").slice(0, 120) || "document";
  return `${download ? "attachment" : "inline"}; filename="${safe}"`;
};

const validateBinding = async (
  deps: StorageRouteDeps,
  input: { inboxId: string; path: string },
) => {
  const binding = await getInboxIntakeBinding(deps.db, { id: input.inboxId });
  if (!binding?.filePath?.length) return null;
  // Reservations are not documents yet; only accepted (or legacy) rows serve.
  if (
    binding.status === "deleted" ||
    binding.intakeState === "cancelled" ||
    binding.intakeState === "reserved"
  ) {
    return null;
  }
  // The capability is only valid for the object the record currently points
  // at, so a re-bound or replaced record invalidates older links.
  if (binding.filePath.join("/") !== input.path) return null;

  // Legacy rows were created with caller-selected paths. They are only served
  // when the persisted path stays inside the record's own workspace.
  const [root] = binding.filePath;
  if (
    binding.teamId &&
    UUID_PATTERN.test(root ?? "") &&
    root !== binding.teamId
  ) {
    return null;
  }

  return binding;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Serving route for short-lived, inbox-bound capability URLs. The signature
 * proves the URL was minted by an authorized caller; the binding is re-read on
 * every request so deleted records and re-bound objects stop working
 * immediately. Tenant content is never cacheable by shared caches.
 */
export async function storageCapabilityResponse(
  request: Request,
  deps: StorageRouteDeps = defaultDeps(),
): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const [, bucket, ...pathParts] = parts;
  const inboxId = url.searchParams.get("inbox") ?? "";
  const expires = Number(url.searchParams.get("expires"));
  const providedSignature = url.searchParams.get("signature") ?? "";
  const downloadFile = url.searchParams.get("download") === "1";

  // A malformed percent-encoding, traversal-shaped path or bad signature must
  // fail closed, not throw. Decoding therefore happens inside the boundary.
  let path = "";
  let signatureValid = false;
  try {
    path = pathParts.map(decodeURIComponent).join("/");
    signatureValid =
      Boolean(bucket) &&
      Boolean(path) &&
      Boolean(inboxId) &&
      Number.isFinite(expires) &&
      verifySignedUrl({
        bucket: bucket ?? "",
        path,
        expires,
        providedSignature,
        download: downloadFile,
        inboxId,
      });
  } catch {
    signatureValid = false;
  }

  if (!signatureValid) {
    return Response.json(
      { error: "Invalid or expired storage URL" },
      { status: 401 },
    );
  }

  const binding = await validateBinding(deps, { inboxId, path });
  if (!binding) {
    return Response.json(
      { error: "Invalid or expired storage URL" },
      { status: 401 },
    );
  }

  try {
    const file = await deps.download({ bucket: bucket!, path });
    const contentType = binding.contentType ?? file.type;

    return new Response(file, {
      headers: {
        "Content-Type": contentType || "application/octet-stream",
        "Content-Length": String(file.size),
        "Content-Disposition": contentDisposition(
          downloadFile,
          binding.fileName ?? pathParts.at(-1) ?? "document",
        ),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        // Contain active document content: no scripts, no plugins, sandboxed.
        "Content-Security-Policy":
          "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
      },
    });
  } catch {
    return Response.json({ error: "File not found" }, { status: 404 });
  }
}
