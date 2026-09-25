import { type Journey, PASSWORD } from "../support/journey";

/**
 * A new customer creates an account in the browser, verifies it through the
 * emailed link, signs in, reaches the app, signs out and is sent back to the
 * sign-in page. A wrong password is refused with a visible error.
 */
const journey: Journey = {
  id: "sign-up-sign-in",
  name: "Sign up, verify email, sign in and out",
  features: ["sign-up", "sign-in", "invoices"],
  async run(ctx) {
    const page = await ctx.page();
    const email = ctx.email("owner");

    ctx.step("open sign-up page");
    await page.goto("/signup");
    await page.getByLabel("Name").fill("Journey Owner");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(PASSWORD);
    await ctx.screenshot(page, "sign-up-form");

    ctx.step("submit sign-up");
    await page.getByRole("button", { name: "Create account" }).click();
    await page
      .getByText("Check your email to verify your account.")
      .waitFor({ timeout: 30_000 });
    await ctx.screenshot(page, "check-your-email");

    ctx.step("sign-in before verification is refused");
    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page
      .getByRole("button", { name: "Resend verification email" })
      .waitFor({ timeout: 30_000 });
    await ctx.screenshot(page, "unverified-sign-in-refused");

    ctx.step("follow the emailed verification link");
    const link = await ctx.verificationLink(email);
    await page.goto(link);
    await page.waitForLoadState("networkidle");
    await ctx.screenshot(page, "after-verification-link");

    ctx.step("wrong password is refused");
    await page.context().clearCookies();
    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill("not-the-password-123");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page
      .locator("p.text-destructive")
      .waitFor({ state: "visible", timeout: 30_000 });
    await ctx.screenshot(page, "wrong-password");

    ctx.step("sign in");
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
      timeout: 30_000,
    });
    await page.waitForLoadState("networkidle");
    await ctx.screenshot(page, "signed-in-home");

    ctx.step("open the inbox");
    const inbox = await page.goto("/inbox");
    if (!inbox || inbox.status() !== 200) {
      throw new Error(`/inbox returned ${inbox?.status()}`);
    }
    if (page.url().includes("/login")) {
      throw new Error("a signed-in user was sent back to /login");
    }
    await page.waitForLoadState("networkidle");
    await ctx.screenshot(page, "inbox");

    ctx.step("the account and its workspace exist");
    const [row] = await ctx.query<{
      verified: boolean;
      team_id: string | null;
    }>(
      "select email_verified as verified, team_id from users where email = $1",
      [email],
    );
    if (!row?.verified) throw new Error("the email was not marked verified");
    if (!row.team_id) throw new Error("sign-up did not provision a workspace");

    ctx.step("sign out");
    const signedOut = await page.evaluate(async () => {
      const response = await fetch("/api/auth/sign-out", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      return response.status;
    });
    if (signedOut !== 200) throw new Error(`sign-out returned ${signedOut}`);
    await page.goto("/inbox");
    await page.waitForURL((url) => url.pathname.startsWith("/login"), {
      timeout: 30_000,
    });
    await ctx.screenshot(page, "signed-out-redirect");

    return "signed up in the browser, verified via the emailed link, was refused unverified and with a wrong password, signed in to the inbox, signed out and was redirected to /login";
  },
};

export default journey;
