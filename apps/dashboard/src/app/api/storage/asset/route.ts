import { type AssetKind, isAssetKind } from "@/lib/asset-kinds";
import {
  PUBLIC_ASSET_NAMESPACE,
  isPublicAssetKind,
  mayReadAsset,
  parseAssetPath,
} from "@/lib/asset-paths";
import { getSession } from "@/lib/auth";
import { readBoundedFormData } from "@invoicewise/api/intake/http";
import { download, uploadIfAbsent } from "@invoicewise/db/storage";
import { decodeIntakeImage } from "@invoicewise/documents";
import { NextResponse } from "next/server";

/**
 * Non-invoice assets: workspace logo, user avatar, OAuth app logo and OAuth
 * app screenshots.
 *
 * Assets live under a separate `assets` branch of the vault and can never
 * address an invoice object. Every path is derived on the server from a
 * caller-supplied *kind*; the client never chooses a storage path.
 */
const MAX_ASSET_BYTES = 5_000_000;
const PUBLIC_KIND = "app-logo";

const sanitize = (value: string) =>
  (value.split(/[\\/]/).at(-1) ?? "asset")
    .replace(/[^\w.\- ]/g, "_")
    .slice(0, 120) || "asset";

type Session = {
  teamId: string | null;
  user: { id: string };
};

/** Namespace a kind must be written into, relative to the caller. */
const namespaceFor = (kind: AssetKind, session: Session) => {
  switch (kind) {
    case "avatar":
      return session.user.id;
    case PUBLIC_KIND:
      return PUBLIC_ASSET_NAMESPACE;
    default:
      return session.teamId;
  }
};

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = await readBoundedFormData(request, MAX_ASSET_BYTES + 500_000);
  if (!parsed.ok) {
    return NextResponse.json(
      { error: parsed.message },
      { status: parsed.code === "too_large" ? 413 : 400 },
    );
  }

  const file = parsed.formData.get("file");
  const kind = parsed.formData.get("kind");

  if (!isUploadedFile(file) || typeof kind !== "string" || !isAssetKind(kind)) {
    return NextResponse.json({ error: "Invalid upload" }, { status: 400 });
  }

  const namespace = namespaceFor(kind, session);
  if (!namespace) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength > MAX_ASSET_BYTES) {
    return NextResponse.json({ error: "File is too large" }, { status: 413 });
  }

  let contentType: string;
  try {
    contentType = (await decodeIntakeImage(bytes)).mimeType;
  } catch {
    return NextResponse.json(
      { error: "Only complete PNG and JPEG images are supported" },
      { status: 400 },
    );
  }

  const path = [
    namespace,
    "assets",
    kind,
    crypto.randomUUID(),
    sanitize(file.name),
  ];

  try {
    await uploadIfAbsent({ bucket: "vault", path, file: bytes, contentType });
  } catch {
    return NextResponse.json(
      { error: "Unable to store file" },
      { status: 503 },
    );
  }

  return NextResponse.json({ path });
}

type UploadedFile = {
  name: string;
  arrayBuffer: () => Promise<ArrayBuffer>;
};

const isUploadedFile = (value: unknown): value is UploadedFile =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as UploadedFile).arrayBuffer === "function" &&
  typeof (value as UploadedFile).name === "string";

export async function GET(request: Request) {
  const path = new URL(request.url).searchParams.get("path") ?? "";
  const parsed = parseAssetPath(path);

  if (!parsed) {
    return new Response("Not found", { status: 404 });
  }

  const isPublic = isPublicAssetKind(parsed.kind);
  const session = isPublic ? null : await getSession();

  if (!isPublic && !session) {
    return new Response("Unauthorized", { status: 401 });
  }
  if (!mayReadAsset(parsed, session)) {
    return new Response("Forbidden", { status: 403 });
  }

  try {
    const data = await download({ bucket: "vault", path });
    return new Response(data, {
      headers: {
        "Content-Type": data.type,
        "Cache-Control": isPublic
          ? "public, max-age=31536000, immutable"
          : "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return new Response("File not found", { status: 404 });
  }
}
