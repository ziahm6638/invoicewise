---
name: production-deploy
description: Use when deploying InvoiceWise to production (hp-slice) or staging (hostinger) with Kamal and Infisical, deploying the apps/website marketing site to Vercel, or diagnosing a failed deploy or rollback. Adds the operator gotchas docs/deployment.md does not spell out.
---

# Deploying InvoiceWise

The runbook is `docs/deployment.md` (shape, secrets, deploy, migrations, Nango, backups, rollback, logs, staging) plus `docs/operations.md#deploys`.
Read it first; this skill only adds what repeated real deploys taught.
Proving the change live afterwards is the `production-live-proof` skill.

## When this applies

- Shipping merged `main` to `app.invoicewise.uk` / `api.invoicewise.uk`, or to staging.
- Deploying `apps/website` to `invoicewise.uk` (Vercel, not Kamal).
- A deploy failed, hung, refused to start, or needs rolling back.

## Before deploying

1. **One production deploy at a time.** Coordinate with anyone else shipping. Kamal also holds its own lock (`kamal lock status`); if an interrupted deploy left it held, confirm nothing is still running before `kamal lock release`.
2. **Deploy from a detached, clean checkout of `origin/main`**, never a feature worktree. PRs are squash-merged, so a branch head is not what landed, and a dirty tree deploys an `_uncommitted_…` version that matches no commit:
   ```bash
   git fetch origin && git worktree add --detach ../iw-deploy origin/main
   cd ../iw-deploy && git status --short    # must print nothing
   ```
3. **New required setting?** It must already exist in Infisical `prod` and `staging` and in the files AGENTS.md lists (`config/deploy.yml`, `.kamal/secrets*`, `scripts/deploy/require-env.sh`). Check names only: `infisical export --env prod --format json | jq -r '.[].key'`.
4. **New migrations:** drizzle silently skips a migration whose journal `when` is not newer than the newest one already applied. Compare before deploying:
   ```bash
   ssh root@100.90.24.83 docker exec invoicewise-db psql -U invoicewise -d invoicewise \
     -Atc 'select max(created_at) from drizzle.__drizzle_migrations'
   jq '.entries[-1].when' packages/db/migrations/meta/_journal.json   # must be larger
   ```

## Deploying

- `infisical run --env prod -- kamal deploy` takes about 6-7 minutes (the image builds on hp-slice). Do not interrupt it.
- The runbook boots `web` before `api`. When the new web code reads columns this release's migration adds (sign-in, settings and account pages especially), deploy the API first so migrations run before the new web serves:
  ```bash
  infisical run --env prod -- kamal deploy --roles api
  infisical run --env prod -- kamal deploy --roles web
  ```
- `kamal deploy` never touches the Nango accessories; Nango changes follow `docs/deployment.md#nango`.

## After deploying (beyond the runbook's three checks)

- `kamal app version` equals the merge SHA for both roles.
- Applied migration count equals the journal (runbook command), and the API log shows migrations applied and `workflow_runner_started`.
- No error lines since boot: `infisical run --env prod -- kamal app logs -r api --since 15m | grep -ci error` (then `-r web`).
- Pre-existing data still reads: counts of existing invoices are unchanged and the release's new tables/columns exist. Read counts only, never other workspaces' contents.
- In a healthy release's browser console the only error seen has been a 401 from the inherited OpenPanel tracker; anything else is new.

## When it goes wrong

- **Container refused:** `kamal app logs -r <role>` shows `invoicewise-<role> refusing to start: …` naming the variable. The previous release keeps serving, so there is nothing to roll back: fix Infisical or config and deploy again.
- **Rollback** swaps images but not migrations (`docs/deployment.md#rollback`); prefer a forward fix when the schema moved.
- **Jobs that failed under a bad release** (for example one missing `TYPESAFE_API_KEY`): never requeue them with SQL. A SQL requeue keeps each job's original `created_at`, so the intake-latency alert keeps firing for 24 hours. Use `POST /ops/jobs/:id/retry` (`docs/operations.md#recovery`) or the invoice's Re-extract.

## Staging

- Drills, load tests and deploys of unmerged branches go to staging only (`infisical run --env staging -- kamal deploy -d staging`), never production.
- CI deploys `main` to staging only while GitHub Actions workflows are enabled; check `gh workflow list --all`. If they are disabled, staging is not auto-deployed: deploy it by hand from a clean `origin/main` checkout.
- The CI job signs in to Infisical with GitHub OIDC. The Infisical identity's subject must be GitHub's immutable form `repo:<owner>@<owner_id>/<repo>@<repo_id>:environment:staging` (IDs from `gh api repos/<owner>/<repo> --jq '.owner.id, .id'`) with matching `repository`/`repository_id` claims and no wildcards; the plain `repo:<owner>/<repo>:environment:staging` form was rejected.
- Staging's TypeSafe ceiling is 300 calls a day and each processed invoice costs about 3 calls; size load tests accordingly.

## Marketing site (`apps/website` to invoicewise.uk)

- A separate Vercel project (`invoicewise`, Hobby plan, Root Directory `apps/website`). `apps/website/vercel.json` disables the Git integration, so merging never deploys it.
- Deploy with the logged-in Vercel CLI from the **repository root** of a clean `origin/main` checkout (the build needs the monorepo workspace install): `vercel deploy` for a preview, check it, then `vercel deploy --prod` (aliases `invoicewise.uk` and `www`).
- Hobby allows one region: keep `regions` to a single entry (`fra1`).
- Settings live in the Vercel production environment (names in `apps/website/.env-template`); sensitive values cannot be read back, and the durable copies are in Infisical `prod`. Pages render at build time, so changing a value such as `INBOUND_EMAIL_LIVE` needs a redeploy.
- The waitlist refuses submissions without `IP_HASH_SALT` (`apps/website/src/server/leads.server.ts`).
- Verify: `/`, `/pricing`, `/policy`, `/terms` answer 200, Sign in reaches `https://app.invoicewise.uk`, and one test waitlist sign-up lands in the lead store and sends the confirmation from `hello@invoicewise.uk`. Delete the test lead and its IP-attempt record afterwards.

## Pointers

- `docs/deployment.md`, `docs/operations.md` (alerts, recovery, deploy model)
- `config/deploy.yml`, `config/deploy.staging.yml`, `scripts/deploy/require-env.sh`, `scripts/deploy/deploy-config.test.ts`
- `.github/workflows/deploy-staging.yml`, `scripts/ops/load-test.ts`
