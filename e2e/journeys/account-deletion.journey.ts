import { sessionPage } from "../support/invoices";
import type { Journey } from "../support/journey";

/**
 * Leaving InvoiceWise: a sole owner deletes their account and the workspace
 * they solely own in one confirmed step (an unconfirmed attempt is refused),
 * and someone who first deleted their last workspace lands on workspace
 * creation, which still offers account deletion, and completes it.
 */
const journey: Journey = {
  id: "account-deletion",
  name: "Delete an account and its sole-owned workspace",
  features: ["account", "settings-general", "teams-create"],
  async run(ctx) {
    const solo = await ctx.tenant("solo");

    ctx.step("the sole-owned workspace is offered for deletion");
    const [team] = await ctx.query<{ name: string | null }>(
      "select name from teams where id = $1",
      [solo.teamId],
    );
    const confirmName = team?.name?.trim() || "DELETE";
    const blockers = await ctx.trpcQuery(solo, "user.soleOwnedWorkspaces");
    if (
      blockers.status !== 200 ||
      !blockers.text.includes(solo.teamId) ||
      !blockers.text.includes('"shared":false')
    ) {
      throw new Error(
        `sole-owned workspace was not offered: ${blockers.status} ${blockers.text.slice(0, 200)}`,
      );
    }

    ctx.step("deleting without naming the workspace is refused");
    const unconfirmed = await ctx.trpcMutation(solo, "user.delete");
    if (unconfirmed.status !== 409) {
      throw new Error(`unconfirmed deletion returned ${unconfirmed.status}`);
    }

    ctx.step("delete the account and the workspace");
    const deleted = await ctx.trpcMutation(solo, "user.delete", {
      deleteWorkspaces: [{ teamId: solo.teamId, confirmName }],
    });
    if (deleted.status !== 200) {
      throw new Error(
        `account deletion: ${deleted.status} ${deleted.text.slice(0, 200)}`,
      );
    }
    const [left] = await ctx.query<{ users: string; teams: string }>(
      `select (select count(*)::text from users where id = $1) as users,
              (select count(*)::text from teams where id = $2) as teams`,
      [solo.userId, solo.teamId],
    );
    if (left?.users !== "0" || left?.teams !== "0") {
      throw new Error(`account or workspace survived: ${JSON.stringify(left)}`);
    }
    const requests = await ctx.query<{ subject: string }>(
      "select subject::text from deletion_requests where subject_id in ($1, $2) order by subject",
      [solo.userId, solo.teamId],
    );
    if (requests.map((row) => row.subject).join(",") !== "account,workspace") {
      throw new Error(
        `cleanup not recorded for both: ${JSON.stringify(requests)}`,
      );
    }
    const signIn = await ctx.http(`${ctx.appOrigin}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ctx.appOrigin },
      body: JSON.stringify({ email: solo.email, password: solo.password }),
    });
    if (signIn.status === 200) {
      throw new Error("a deleted account could still sign in");
    }

    ctx.step("delete the last workspace first");
    const stranded = await ctx.tenant("stranded");
    const [strandedTeam] = await ctx.query<{ name: string | null }>(
      "select name from teams where id = $1",
      [stranded.teamId],
    );
    const teamDeleted = await ctx.trpcMutation(stranded, "team.delete", {
      teamId: stranded.teamId,
      confirmName: strandedTeam?.name?.trim() || "DELETE",
    });
    if (teamDeleted.status !== 200) {
      throw new Error(
        `workspace deletion: ${teamDeleted.status} ${teamDeleted.text.slice(0, 200)}`,
      );
    }

    ctx.step("workspace creation still offers account deletion");
    const page = await sessionPage(ctx, stranded);
    await page.goto("/teams/create");
    await page
      .getByText("Delete your account")
      .first()
      .waitFor({ timeout: 30_000 });
    await page.waitForLoadState("networkidle");
    await ctx.screenshot(page, "teams-create-with-account-deletion");

    ctx.step("a user with no workspace deletes their account");
    const strandedDeleted = await ctx.trpcMutation(stranded, "user.delete");
    if (strandedDeleted.status !== 200) {
      throw new Error(
        `no-workspace deletion: ${strandedDeleted.status} ${strandedDeleted.text.slice(0, 200)}`,
      );
    }

    return "a sole owner was refused without confirmation, then deleted account and workspace in one confirmed call (cleanup recorded, sign-in refused); a user with no workspace reached account deletion from workspace creation and completed it";
  },
};

export default journey;
