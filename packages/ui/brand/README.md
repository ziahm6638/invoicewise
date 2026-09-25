# InvoiceWise brand

The mark is an "iw" monogram: the dot of the i above a round-jointed w, drawn
in one colour. The wordmark is "invoicewise" in Geist Medium, outlined to paths
so it renders without the font. Neither the mark nor the green tick is used
anywhere else as the logo.

`packages/ui/src/brand.ts` is the only source. Everything else is derived from it:

| Use | Where |
|-----|-------|
| App header, sign-in and other in-app logos | `Icons.LogoSmall` (symbol) and `Icons.Logo` (symbol + wordmark) from `@invoicewise/ui/icons`, drawn in `currentColor` so they follow light and dark themes |
| Marketing site header and footer | `apps/website/src/components/brand.tsx` (`Icons.Logo`) |
| Reference files for other tools | `packages/ui/brand/` — `mark.svg`, `logo.svg` (ink, for light backgrounds), `mark-dark.svg`, `logo-dark.svg` (paper, for dark backgrounds), `app-icon.svg`, `favicon.svg` |
| Favicons | `apps/{dashboard,website}/src/app/favicon.ico` (16, 32, 48) and `icon.svg` (inverts in dark mode) |
| Apple touch and manifest icons | `apps/{dashboard,website}/src/app/apple-icon.png`, `public/icon-192.png`, `public/icon-512.png`, listed by each app's `src/app/manifest.ts` |
| Email logos | `apps/website/public/email/logo.png` and `logo-footer.png`, served from `invoicewise.uk` (`getEmailUrl`) |
| Open Graph image | `apps/website/public/og.png` (the logo over `public/app/og.png`), used by both apps |
| Marketing screenshots | `apps/website/public/app/*.png` are captures of the live app, so its sidebar shows `Icons.LogoSmall`; recapture them after a logo change |

After changing `brand.ts`, regenerate every file and commit the result:

```bash
bun scripts/brand/generate.ts
```

`scripts/brand/brand-assets.test.ts` (part of `bun run verify`) fails when the
committed files no longer match `brand.ts`.

Colours: ink `#0c0c0c`, paper `#ffffff`.
