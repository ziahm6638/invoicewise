import { join } from "node:path";
import {
  BRAND_PAPER,
  appIconSvg,
  faviconSvg,
  logoSvg,
  markSvg,
} from "../../packages/ui/src/brand.ts";

export const ROOT = join(import.meta.dir, "../..");

/** Favicon sizes packed into each `favicon.ico`. */
export const ICO_SIZES = [16, 32, 48] as const;

/** Reference SVGs, generated verbatim from `packages/ui/src/brand.ts`. */
export const BRAND_SVG_FILES: Record<string, string> = {
  "packages/ui/brand/mark.svg": markSvg(),
  "packages/ui/brand/mark-dark.svg": markSvg(BRAND_PAPER),
  "packages/ui/brand/logo.svg": logoSvg(),
  "packages/ui/brand/logo-dark.svg": logoSvg(BRAND_PAPER),
  "packages/ui/brand/app-icon.svg": appIconSvg(),
  "packages/ui/brand/favicon.svg": faviconSvg(),
};
