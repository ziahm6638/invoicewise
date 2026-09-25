import type { InboxQueryDatabase } from "@invoicewise/db/queries";
import { INTAKE_LIMITS } from "@invoicewise/documents";
import {
  type IntakeStorage,
  acceptIntakeUpload,
} from "@invoicewise/jobs/intake";

// Form encoding adds a small amount of framing overhead on top of the file.
export const MAX_INTAKE_REQUEST_BYTES = INTAKE_LIMITS.maxBytes + 1_000_000;

export type IntakeHttpDeps = {
  teamId: string;
  db: InboxQueryDatabase;
  storage: IntakeStorage;
};

/** Minimal structural view so DOM and undici FormData both satisfy it. */
export type ParsedForm = { get: (name: string) => unknown };

export type BoundedFormResult =
  | { ok: true; formData: ParsedForm }
  | { ok: false; code: "too_large" | "malformed"; message: string };

const json = (
  body: unknown,
  status: number,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const tooLargeBody = () => {
  return {
    ok: false as const,
    code: "too_large" as const,
    message: "Uploaded file is too large",
  };
};

/**
 * Reads the request body with a real byte bound before any multipart parsing.
 *
 * A missing, false or chunked `content-length` cannot bypass the limit because
 * the stream is counted as it is read, and the reader is cancelled as soon as
 * the bound is crossed.
 */
export async function readBoundedBody(
  request: Request,
  maxBytes: number,
): Promise<
  | { ok: true; bytes: Uint8Array<ArrayBuffer> }
  | { ok: false; code: "too_large" | "malformed"; message: string }
> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    return tooLargeBody();
  }

  const body = request.body;
  const chunks: Uint8Array[] = [];
  let total = 0;

  if (body) {
    const reader = body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          return tooLargeBody();
        }
        chunks.push(value);
      }
    } catch {
      return {
        ok: false,
        code: "malformed",
        message: "Invalid upload",
      };
    }
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

export async function readBoundedFormData(
  request: Request,
  maxBytes: number,
): Promise<BoundedFormResult> {
  const read = await readBoundedBody(request, maxBytes);
  if (!read.ok) return read;
  const buffered = read.bytes;

  const contentType = request.headers.get("content-type");
  if (!contentType) {
    return { ok: false, code: "malformed", message: "Invalid upload" };
  }

  try {
    const formData = await new Request("http://intake.local/upload", {
      method: "POST",
      headers: { "content-type": contentType },
      body: buffered,
    }).formData();
    return { ok: true, formData };
  } catch {
    return { ok: false, code: "malformed", message: "Invalid upload" };
  }
}

type UploadedFile = {
  name: string;
  type: string;
  arrayBuffer: () => Promise<ArrayBuffer>;
};

/**
 * Structural check so the handler works with the platform `File` in Next.js
 * and with undici's `File` in tests.
 */
const isUploadedFile = (value: unknown): value is UploadedFile =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as UploadedFile).arrayBuffer === "function" &&
  typeof (value as UploadedFile).name === "string";

/**
 * Workspace-bound invoice intake. The client sends bytes and an original
 * filename; it cannot choose a storage path, and the response carries the
 * canonical inbox id the rest of the product uses.
 */
export async function handleInvoiceIntake(
  request: Request,
  deps: IntakeHttpDeps,
): Promise<Response> {
  const parsed = await readBoundedFormData(request, MAX_INTAKE_REQUEST_BYTES);
  if (!parsed.ok) {
    // The rest of the body may still be arriving. Closing the connection
    // stops a reverse proxy (kamal-proxy) from reusing it for another
    // client's request, which would otherwise stall behind the unread bytes
    // and fail with a 502.
    return json(
      { error: parsed.message, code: parsed.code },
      parsed.code === "too_large" ? 413 : 400,
      { connection: "close" },
    );
  }

  const { formData } = parsed;

  const file = formData.get("file");
  if (!isUploadedFile(file)) {
    return json({ error: "Invalid upload", code: "malformed" }, 400);
  }

  const result = await acceptIntakeUpload(deps.db, deps.storage, {
    teamId: deps.teamId,
    bytes: new Uint8Array(await file.arrayBuffer()),
    declaredMimeType: file.type,
    fileName: file.name,
  });

  if (result.status === "rejected") {
    if (result.code === "queue_full") {
      return json({ error: result.message, code: result.code }, 429, {
        "retry-after": "120",
      });
    }
    const status =
      result.code === "too_large" || result.code === "image_too_large"
        ? 413
        : result.code === "storage_unavailable" ||
            result.code === "temporarily_unavailable"
          ? 503
          : 400;
    return json({ error: result.message, code: result.code }, status);
  }

  return json(
    {
      id: result.inboxId,
      path: result.filePath,
      fileName: result.fileName,
      contentType: result.mimeType,
      size: result.size,
      deduplicated: result.deduplicated,
    },
    200,
  );
}
