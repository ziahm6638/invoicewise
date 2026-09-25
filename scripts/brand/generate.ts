/**
 * Writes every static brand file from `packages/ui/src/brand.ts`:
 * the reference SVGs, favicons, Apple touch and manifest icons, the email
 * logos and the marketing site's Open Graph image.
 *
 *   bun scripts/brand/generate.ts
 *
 * `scripts/brand/brand-assets.test.ts` checks the committed files still match.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import sharp from "sharp";
import {
  BRAND_LOGO,
  appIconSvg,
  faviconSvg,
  logoSvg,
  markSvg,
} from "../../packages/ui/src/brand.ts";
import { BRAND_SVG_FILES, ICO_SIZES, ROOT } from "./files.ts";

/** Re-sizes an SVG document so it rasterises natively at `width` x `height`. */
export function sized(svg: string, width: number, height = width) {
  return svg.replace(
    /^<svg([^>]*?) width="[^"]*" height="[^"]*"/,
    `<svg$1 width="${width}" height="${height}"`,
  );
}

async function png(svg: string, width: number, height = width) {
  return sharp(Buffer.from(sized(svg, width, height)))
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/** Packs PNG images into a Windows ICO container (PNG entries, Vista+). */
export function ico(images: { size: number; data: Buffer }[]) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + images.length * 16;
  const entries = images.map(({ size, data }) => {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    return entry;
  });
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

async function write(path: string, data: string | Buffer) {
  const target = join(ROOT, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, data);
  console.log(`wrote ${path}`);
}

/** Open Graph card: the logo above the product screenshot. */
async function openGraphImage() {
  const width = 1200;
  const height = 630;
  const logoHeight = 64;
  const logoWidth = Math.round(
    (BRAND_LOGO.width / BRAND_LOGO.height) * logoHeight,
  );
  const screenshotWidth = 1056;
  const screenshot = await sharp(
    await readFile(join(ROOT, "apps/website/public/app/og.png")),
  )
    .resize(screenshotWidth)
    .toBuffer();
  const frame = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${screenshotWidth + 2}" height="${height}"><rect x="0.5" y="0.5" width="${screenshotWidth + 1}" height="${height + 10}" rx="12" fill="none" stroke="#dcdcdc"/></svg>`,
  );
  return sharp({
    create: { width, height, channels: 4, background: "#fbfbfb" },
  })
    .composite([
      { input: await png(logoSvg(), logoWidth, logoHeight), left: 72, top: 56 },
      { input: screenshot, left: 72, top: 168 },
      { input: frame, left: 71, top: 167 },
    ])
    .flatten({ background: "#fbfbfb" })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function main() {
  for (const [path, svg] of Object.entries(BRAND_SVG_FILES)) {
    await write(path, svg);
  }

  const favicon = ico(
    await Promise.all(
      ICO_SIZES.map(async (size) => ({
        size,
        data: await png(appIconSvg(), size),
      })),
    ),
  );
  const appleIcon = await png(appIconSvg({ square: true }), 180);
  const icon192 = await png(appIconSvg(), 192);
  const icon512 = await png(appIconSvg(), 512);

  for (const app of ["apps/dashboard", "apps/website"]) {
    await write(`${app}/src/app/favicon.ico`, favicon);
    await write(`${app}/src/app/icon.svg`, faviconSvg());
    await write(`${app}/src/app/apple-icon.png`, appleIcon);
    await write(`${app}/public/icon-192.png`, icon192);
    await write(`${app}/public/icon-512.png`, icon512);
  }
  await write("apps/dashboard/public/appicon.png", icon512);

  // Email clients need raster images; these are shown at 40px and 120px wide.
  await write("apps/website/public/email/logo.png", await png(markSvg(), 80));
  await write(
    "apps/website/public/email/logo-footer.png",
    await png(logoSvg(), BRAND_LOGO.width * 3, BRAND_LOGO.height * 3),
  );

  await write("apps/website/public/og.png", await openGraphImage());
}

if (import.meta.main) {
  await main();
}
