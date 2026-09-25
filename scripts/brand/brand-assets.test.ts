import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { faviconSvg } from "../../packages/ui/src/brand.ts";
import { BRAND_SVG_FILES, ICO_SIZES, ROOT } from "./files.ts";

const read = (path: string) => readFileSync(join(ROOT, path));

/** Width and height from a PNG's IHDR chunk. */
function pngSize(data: Buffer) {
  expect(data.subarray(1, 4).toString("ascii")).toBe("PNG");
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

const APPS = ["apps/dashboard", "apps/website"];

describe("brand assets", () => {
  test("reference SVGs match packages/ui/src/brand.ts", () => {
    for (const [path, svg] of Object.entries(BRAND_SVG_FILES)) {
      expect(read(path).toString("utf8"), path).toBe(svg);
    }
  });

  test("each app serves the brand favicon set", () => {
    for (const app of APPS) {
      expect(read(`${app}/src/app/icon.svg`).toString("utf8")).toBe(
        faviconSvg(),
      );

      const ico = read(`${app}/src/app/favicon.ico`);
      expect(ico.readUInt16LE(2)).toBe(1);
      const count = ico.readUInt16LE(4);
      const sizes = Array.from({ length: count }, (_, i) => {
        const entry = 6 + i * 16;
        const size = ico.readUInt8(entry) || 256;
        const offset = ico.readUInt32LE(entry + 12);
        expect(pngSize(ico.subarray(offset))).toEqual({
          width: size,
          height: size,
        });
        return size;
      });
      expect(sizes).toEqual([...ICO_SIZES]);

      expect(pngSize(read(`${app}/src/app/apple-icon.png`))).toEqual({
        width: 180,
        height: 180,
      });
      expect(pngSize(read(`${app}/public/icon-192.png`)).width).toBe(192);
      expect(pngSize(read(`${app}/public/icon-512.png`)).width).toBe(512);
    }
  });

  test("email logos and the Open Graph image exist at their sizes", () => {
    expect(pngSize(read("apps/website/public/email/logo.png"))).toEqual({
      width: 80,
      height: 80,
    });
    expect(pngSize(read("apps/website/public/email/logo-footer.png"))).toEqual({
      width: 498,
      height: 96,
    });
    expect(pngSize(read("apps/website/public/og.png"))).toEqual({
      width: 1200,
      height: 630,
    });
  });

  test("the shared logo components draw the brand, not Midday's sun", () => {
    const icons = read("packages/ui/src/components/icons.tsx").toString("utf8");
    // Opening coordinates of Midday's sun mark (symbol and wordmark variants).
    expect(icons).not.toContain("M14.854 2.698");
    expect(icons).not.toContain("M16.622 3.866");
    expect(icons).toContain("BRAND_MARK");
    expect(icons).toContain("BRAND_LOGO.wordmarkPath");
  });
});
