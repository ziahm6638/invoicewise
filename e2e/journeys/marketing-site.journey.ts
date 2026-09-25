import type { Journey } from "../support/journey";

/**
 * The public marketing site (production build) serves its pages: home with
 * the product story and a way into the app, pricing, terms and privacy.
 */
const journey: Journey = {
  id: "marketing-site",
  name: "Marketing site pages render",
  features: [
    "website-home",
    "website-pricing",
    "website-terms",
    "website-policy",
  ],
  async run(ctx) {
    const page = await ctx.page();
    const visited: string[] = [];
    for (const [path, name] of [
      ["/", "home"],
      ["/pricing", "pricing"],
      ["/terms", "terms"],
      ["/policy", "policy"],
    ] as const) {
      ctx.step(`open ${path}`);
      const response = await page.goto(`${ctx.websiteOrigin}${path}`);
      if (!response || response.status() !== 200) {
        throw new Error(`${path} returned ${response?.status()}`);
      }
      await page.waitForLoadState("networkidle");
      const text = await page.locator("body").innerText();
      if (!/invoicewise/i.test(text)) {
        throw new Error(`${path} does not mention InvoiceWise`);
      }
      await ctx.screenshot(page, name);
      visited.push(path);
    }
    return `rendered ${visited.join(", ")} from the production website build`;
  },
};

export default journey;
