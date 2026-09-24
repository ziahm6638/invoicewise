import { type AssetKind, isAssetKind } from "./asset-kinds";

export const PUBLIC_ASSET_KIND: AssetKind = "app-logo";
export const PUBLIC_ASSET_NAMESPACE = "logos";

/** Kinds any signed-in session may read (non-sensitive profile images). */
const SESSION_READABLE_KINDS: readonly AssetKind[] = ["avatar"];

export type ParsedAssetPath = { namespace: string; kind: AssetKind };

/**
 * Asset objects live at `<namespace>/assets/<kind>/<id>/<file>`.
 *
 * Invoice objects live at `<team>/inbox/<inboxId>/<file>`, so they can never
 * satisfy this shape: the asset route is not a raw document read.
 */
export function parseAssetPath(path: string): ParsedAssetPath | null {
  const parts = path.split("/");
  if (parts.length !== 5) return null;
  const [namespace, branch, kind, id, file] = parts;
  if (!namespace || branch !== "assets" || !kind || !id || !file) return null;
  if (!isAssetKind(kind)) return null;
  // Public brand assets may only live in the shared public namespace.
  if (kind === PUBLIC_ASSET_KIND && namespace !== PUBLIC_ASSET_NAMESPACE) {
    return null;
  }
  return { namespace, kind };
}

export function isPublicAssetKind(kind: AssetKind) {
  return kind === PUBLIC_ASSET_KIND;
}

/** Read policy for a parsed asset path. */
export function mayReadAsset(
  parsed: ParsedAssetPath,
  session: { teamId: string | null; user: { id: string } } | null,
) {
  if (isPublicAssetKind(parsed.kind)) return true;
  if (!session) return false;
  if (SESSION_READABLE_KINDS.includes(parsed.kind)) return true;
  return (
    parsed.namespace === session.teamId || parsed.namespace === session.user.id
  );
}
