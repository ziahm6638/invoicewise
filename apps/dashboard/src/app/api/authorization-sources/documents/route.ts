import { getSession } from "@/lib/auth";
import { readBoundedFormData } from "@invoicewise/api/intake/http";
import { db } from "@invoicewise/db/client";
import { canManageAuthorizationSources } from "@invoicewise/db/queries";
import { INTAKE_LIMITS } from "@invoicewise/documents";
import {
  AuthorizationSourceError,
  attachAuthorizationSourceDocument,
  readAuthorizationSourceDocument,
} from "@invoicewise/jobs/authorization-sources";
import { documentHeaders } from "../../documents/binding";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A retained authorization-source document from the caller's own workspace.
 * The client names only the source and document ids; the stored path comes
 * from the record.
 */
export async function GET(request: Request) {
  const session = await getSession();
  if (!session?.teamId) return new Response("Unauthorized", { status: 401 });
  const params = new URL(request.url).searchParams;
  const sourceId = params.get("sourceId") ?? "";
  const documentId = params.get("documentId") ?? "";
  if (!UUID.test(sourceId) || !UUID.test(documentId)) {
    return new Response("Not found", { status: 404 });
  }
  const document = await readAuthorizationSourceDocument(db, {
    teamId: session.teamId,
    sourceId,
    documentId,
  }).catch(() => null);
  if (!document) return new Response("Not found", { status: 404 });
  return new Response(document.data, {
    headers: documentHeaders({
      contentType: document.contentType,
      fileName: document.fileName,
      download: params.get("download") === "1",
    }),
  });
}

/** Attaches a PDF, PNG or JPEG to a source's current version (owner or admin). */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session?.teamId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!canManageAuthorizationSources(session.teamRole)) {
    return Response.json(
      { error: "Only owners and admins can attach documents" },
      { status: 403 },
    );
  }
  const parsed = await readBoundedFormData(
    request,
    INTAKE_LIMITS.maxBytes + 1_000_000,
  );
  if (!parsed.ok) {
    return Response.json(
      { error: parsed.message },
      {
        status: parsed.code === "too_large" ? 413 : 400,
        headers: { connection: "close" },
      },
    );
  }
  const sourceId = parsed.formData.get("sourceId");
  const file = parsed.formData.get("file");
  if (typeof sourceId !== "string" || !UUID.test(sourceId)) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  if (!(file instanceof Blob)) {
    return Response.json({ error: "Choose a file" }, { status: 400 });
  }
  try {
    const result = await attachAuthorizationSourceDocument(db, {
      teamId: session.teamId,
      actorId: session.user.id,
      sourceId,
      bytes: new Uint8Array(await file.arrayBuffer()),
      fileName:
        "name" in file && typeof file.name === "string" ? file.name : "",
    });
    return Response.json({
      id: result.document.id,
      deduplicated: result.deduplicated,
    });
  } catch (error) {
    if (error instanceof AuthorizationSourceError) {
      return Response.json(
        { error: error.message },
        { status: error.code === "not_found" ? 404 : 400 },
      );
    }
    throw error;
  }
}
