/**
 * The InvoiceWise brand: the single source of truth for every logo, favicon,
 * app icon and email logo.
 *
 * The mark is an "iw" monogram: the dot of the i above a round-jointed w.
 * The wordmark is "invoicewise" in Geist Medium, outlined so it renders
 * without the font. `Icons.LogoSmall` and `Icons.Logo` draw these in the
 * apps; `bun scripts/brand/generate.ts` writes the static SVG, PNG and ICO
 * files (see `packages/ui/brand/README.md`).
 */

export const BRAND_INK = "#0c0c0c";
export const BRAND_PAPER = "#ffffff";

/** The symbol, drawn on a 32 unit square. */
export const BRAND_MARK = {
  size: 32,
  strokeWidth: 3.5,
  path: "M4 11.5L9.75 26.5L16 15.5L22.25 26.5L28 11.5",
  dot: { cx: 16, cy: 6.5, r: 2.75 },
} as const;

/** Symbol plus wordmark, 32 units high with the symbol at the left. */
export const BRAND_LOGO = {
  width: 166,
  height: 32,
  wordmarkPath: [
    "M40.05 23L40.05 10.23L42.59 10.23L42.59 23L40.05 23",
    "M40 8.38L40 5.84L42.67 5.84L42.67 8.38L40 8.38",
    "M45.38 23L45.38 10.23L47.71 10.23L47.78 12.44Q48.26 11.19 49.28 10.57Q50.30 9.94 51.64 9.94Q53.73 9.94 54.85 11.29Q55.96 12.63 55.96 14.79L55.96 23L53.42 23L53.42 15.56Q53.42 13.83 52.83 12.96Q52.24 12.08 50.95 12.08Q49.58 12.08 48.75 12.99Q47.92 13.90 47.92 15.56L47.92 23L45.38 23",
    "M61.99 23L57.33 10.23L60.04 10.23L63.52 20.41L67 10.23L69.74 10.23L65.08 23L61.99 23",
    "M76.27 23.29Q74.44 23.29 73.07 22.47Q71.71 21.66 70.95 20.14Q70.19 18.63 70.19 16.62Q70.19 14.60 70.95 13.09Q71.71 11.58 73.07 10.76Q74.44 9.94 76.27 9.94Q78.07 9.94 79.45 10.77Q80.83 11.60 81.57 13.10Q82.31 14.60 82.31 16.62Q82.31 18.63 81.57 20.13Q80.83 21.63 79.45 22.46Q78.07 23.29 76.27 23.29",
    "M76.27 21.08Q77.87 21.08 78.77 19.90Q79.67 18.73 79.67 16.62Q79.67 14.50 78.77 13.33Q77.87 12.15 76.27 12.15Q74.66 12.15 73.75 13.33Q72.83 14.50 72.83 16.62Q72.83 18.73 73.75 19.90Q74.66 21.08 76.27 21.08",
    "M84.26 23L84.26 10.23L86.80 10.23L86.80 23L84.26 23",
    "M84.21 8.38L84.21 5.84L86.87 5.84L86.87 8.38L84.21 8.38",
    "M95.23 23.29Q93.40 23.29 92.02 22.46Q90.64 21.63 89.90 20.12Q89.15 18.61 89.15 16.62Q89.15 14.62 89.90 13.11Q90.64 11.60 92.02 10.77Q93.40 9.94 95.23 9.94Q97.58 9.94 99.09 11.17Q100.60 12.39 100.91 14.58L98.27 14.72Q98.08 13.50 97.27 12.82Q96.45 12.15 95.23 12.15Q93.62 12.15 92.71 13.33Q91.79 14.50 91.79 16.62Q91.79 18.73 92.71 19.90Q93.62 21.08 95.23 21.08Q96.47 21.08 97.28 20.37Q98.08 19.66 98.27 18.32L100.91 18.46Q100.60 20.67 99.08 21.98Q97.55 23.29 95.23 23.29",
    "M108.21 23.29Q106.39 23.29 105.02 22.46Q103.65 21.63 102.91 20.12Q102.16 18.61 102.16 16.62Q102.16 14.62 102.89 13.11Q103.63 11.60 104.98 10.77Q106.34 9.94 108.14 9.94Q109.89 9.94 111.21 10.75Q112.53 11.55 113.26 13.08Q113.99 14.60 113.99 16.71L113.99 17.36L104.83 17.36Q104.92 19.21 105.81 20.16Q106.70 21.10 108.23 21.10Q109.34 21.10 110.09 20.59Q110.85 20.07 111.16 19.16L113.80 19.33Q113.30 21.13 111.80 22.21Q110.30 23.29 108.21 23.29",
    "M111.28 15.44Q111.19 13.78 110.35 12.94Q109.51 12.10 108.14 12.10Q106.77 12.10 105.91 12.97Q105.04 13.83 104.83 15.44L111.28 15.44",
    "M118.36 23L114.47 10.23L117.14 10.23L119.87 20.22L122.68 10.23L125.11 10.23L127.91 20.22L130.65 10.23L133.34 10.23L129.43 23L126.57 23L123.88 13.88L121.22 23L118.36 23",
    "M135.16 23L135.16 10.23L137.71 10.23L137.71 23L135.16 23",
    "M135.11 8.38L135.11 5.84L137.78 5.84L137.78 8.38L135.11 8.38",
    "M145.79 23.29Q143.18 23.29 141.69 22.11Q140.20 20.94 140.06 18.97L142.70 18.85Q143.06 21.15 145.79 21.15Q147.02 21.15 147.70 20.76Q148.39 20.36 148.39 19.54Q148.39 19.04 148.15 18.74Q147.91 18.44 147.26 18.21Q146.61 17.98 145.34 17.77Q143.44 17.43 142.36 16.93Q141.28 16.42 140.83 15.70Q140.37 14.98 140.37 13.90Q140.37 12.10 141.71 11.02Q143.06 9.94 145.48 9.94Q147.81 9.94 149.18 11.12Q150.55 12.30 150.83 14.14L148.22 14.29Q148.03 13.26 147.32 12.67Q146.61 12.08 145.46 12.08Q144.26 12.08 143.63 12.55Q143.01 13.02 143.01 13.81Q143.01 14.65 143.65 15.06Q144.28 15.46 145.87 15.73Q147.83 16.04 148.96 16.53Q150.09 17.02 150.56 17.73Q151.03 18.44 151.03 19.52Q151.03 21.27 149.57 22.28Q148.12 23.29 145.79 23.29",
    "M158.56 23.29Q156.74 23.29 155.37 22.46Q154 21.63 153.26 20.12Q152.51 18.61 152.51 16.62Q152.51 14.62 153.25 13.11Q153.98 11.60 155.33 10.77Q156.69 9.94 158.49 9.94Q160.24 9.94 161.56 10.75Q162.88 11.55 163.61 13.08Q164.35 14.60 164.35 16.71L164.35 17.36L155.18 17.36Q155.27 19.21 156.16 20.16Q157.05 21.10 158.59 21.10Q159.69 21.10 160.45 20.59Q161.20 20.07 161.51 19.16L164.15 19.33Q163.65 21.13 162.15 22.21Q160.65 23.29 158.56 23.29",
    "M161.63 15.44Q161.54 13.78 160.70 12.94Q159.86 12.10 158.49 12.10Q157.12 12.10 156.26 12.97Q155.39 13.83 155.18 15.44",
  ].join(""),
} as const;

/** App icon and favicon: the symbol on a rounded square. */
export const BRAND_APP_ICON = {
  size: 32,
  radius: 7.5,
  /** The symbol's scale inside the square; the stroke is thickened to stay legible at 16px. */
  markScale: 0.66,
  strokeWidth: 4,
} as const;

/**
 * A paint is either a colour or a CSS class, so the favicon can switch colours
 * with the browser's colour scheme.
 */
type Paint = { color: string } | { className: string };

const fillOf = (paint: Paint) =>
  "color" in paint ? `fill="${paint.color}"` : `class="${paint.className}"`;

function markElements(
  paint: Paint,
  strokeWidth: number = BRAND_MARK.strokeWidth,
) {
  const { path, dot } = BRAND_MARK;
  const stroke =
    "color" in paint
      ? `stroke="${paint.color}"`
      : `class="${paint.className}-stroke"`;
  return [
    `<path d="${path}" fill="none" ${stroke} stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>`,
    `<circle cx="${dot.cx}" cy="${dot.cy}" r="${dot.r}" ${fillOf(paint)}/>`,
  ].join("");
}

function svg(width: number, height: number, body: string) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="InvoiceWise"><title>InvoiceWise</title>${body}</svg>\n`;
}

/** The symbol alone, in one colour. */
export function markSvg(color: string = BRAND_INK) {
  return svg(BRAND_MARK.size, BRAND_MARK.size, markElements({ color }));
}

/** The symbol plus wordmark, in one colour. */
export function logoSvg(color: string = BRAND_INK) {
  return svg(
    BRAND_LOGO.width,
    BRAND_LOGO.height,
    `${markElements({ color })}<path d="${BRAND_LOGO.wordmarkPath}" fill="${color}"/>`,
  );
}

function appIconBody(background: Paint, foreground: Paint, radius: number) {
  const { size, markScale, strokeWidth } = BRAND_APP_ICON;
  const offset = (size - BRAND_MARK.size * markScale) / 2;
  return [
    `<rect width="${size}" height="${size}" rx="${radius}" ${fillOf(background)}/>`,
    `<g transform="translate(${offset} ${offset}) scale(${markScale})">${markElements(foreground, strokeWidth / markScale)}</g>`,
  ].join("");
}

/**
 * The app icon: the paper symbol on an ink rounded square. `square` drops the
 * rounding for platforms that mask icons themselves (Apple touch icons).
 */
export function appIconSvg(options: { square?: boolean } = {}) {
  const { size, radius } = BRAND_APP_ICON;
  return svg(
    size,
    size,
    appIconBody(
      { color: BRAND_INK },
      { color: BRAND_PAPER },
      options.square ? 0 : radius,
    ),
  );
}

/** The SVG favicon: the app icon, inverted when the browser is in dark mode. */
export function faviconSvg() {
  const { size, radius } = BRAND_APP_ICON;
  const style = [
    "<style>",
    `.bg{fill:${BRAND_INK}}.fg{fill:${BRAND_PAPER}}.fg-stroke{stroke:${BRAND_PAPER}}`,
    `@media (prefers-color-scheme:dark){.bg{fill:${BRAND_PAPER}}.fg{fill:${BRAND_INK}}.fg-stroke{stroke:${BRAND_INK}}}`,
    "</style>",
  ].join("");
  return svg(
    size,
    size,
    style + appIconBody({ className: "bg" }, { className: "fg" }, radius),
  );
}
