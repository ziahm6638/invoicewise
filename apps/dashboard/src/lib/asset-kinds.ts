/**
 * Non-invoice asset kinds. Shared by the asset route and its callers so the
 * namespace and read policy stay in one place.
 */
export const ASSET_KINDS = [
  "avatar",
  "logo",
  "app-logo",
  "screenshot",
] as const;

export type AssetKind = (typeof ASSET_KINDS)[number];

export const isAssetKind = (value: string): value is AssetKind =>
  (ASSET_KINDS as readonly string[]).includes(value);
