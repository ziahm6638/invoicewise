import { signedInPage } from "../support/invoices";
import type { Journey } from "../support/journey";

/**
 * An admin manages webhook endpoints: the production app refuses every
 * private, loopback, link-local and metadata destination however it is
 * spelled, and the Webhooks settings page renders for the admin.
 */
const journey: Journey = {
  id: "webhooks",
  name: "Webhook endpoints refuse private destinations",
  features: ["settings-webhooks"],
  async run(ctx) {
    const admin = await ctx.tenant("admin");

    ctx.step("private destinations are refused at registration");
    const refused: string[] = [];
    for (const url of [
      "http://localhost:3014/hook",
      "https://127.0.0.1/hook",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/hook",
      "https://[::ffff:169.254.169.254]/hook",
      "https://[fd00:ec2::254]/hook",
      "https://2130706433/hook",
      "https://metadata.google.internal/computeMetadata",
    ]) {
      const created = await ctx.trpcMutation(admin, "webhooks.create", {
        url,
        events: ["invoice.processed"],
      });
      if (created.status === 200) {
        throw new Error(`production accepted a private webhook URL ${url}`);
      }
      refused.push(`${url}=${created.status}`);
    }

    ctx.step("the endpoint list stays empty");
    const listed = await ctx.trpcQuery(admin, "webhooks.list");
    if (listed.status !== 200) {
      throw new Error(
        `webhooks.list: ${listed.status} ${listed.text.slice(0, 200)}`,
      );
    }
    if (Array.isArray(listed.json) && listed.json.length > 0) {
      throw new Error(
        `a refused endpoint was stored: ${listed.text.slice(0, 300)}`,
      );
    }

    ctx.step("the Webhooks settings page renders");
    const page = await signedInPage(ctx, admin);
    await page.goto("/settings/webhooks");
    await page.getByText("Add endpoint").first().waitFor({ timeout: 30_000 });
    await page.waitForLoadState("networkidle");
    await ctx.screenshot(page, "webhooks");

    return `production refused ${refused.length} private destinations (${refused.join(", ")}); nothing was stored; the admin's Webhooks page rendered`;
  },
};

export default journey;
