---
name: e2e-journeys
description: Use when `bun run gate` or `bun run e2e` fails, when writing or changing a journey in e2e/journeys, or when a change needs PR evidence from the running app. Gives the fast iteration loop, how to read a run's evidence, and the production-mode gotchas journeys hit.
---

# Running and debugging the e2e gate

What the gate runs and the journey contract are owned by `docs/development.md#the-gate-e2e-journeys` and `docs/paved-path.md#add-a-journey-the-only-kind-of-test`.
This skill is the working loop and the traps.

## Before a run

- The runner reuses the project's running Postgres and Redis and never starts containers. Check `docker ps` for the compose services or the `invoicewise.verify.service=true` suite; if neither runs, start one suite (`docker compose up -d --wait postgres redis`). Pin other targets with `E2E_POSTGRES_BASE` / `E2E_REDIS_URL` (loopback only).
- Browser journeys need Chromium for the pinned `playwright-core`: `bunx playwright-core install chromium` (once per machine).
- One e2e run at a time per machine is the polite default: each run starts three production servers and a browser.

## Fast loop

A full run builds the dashboard (about 1-2 minutes). Build once, then rerun journeys against it:

```bash
bun scripts/e2e.ts --build-only "$PWD/.verify-artifacts/dev-build"
E2E_KEEP_BUILD=1 bun scripts/e2e.ts --prebuilt "$PWD/.verify-artifacts/dev-build" --journey intake
```

Rebuild after changing app code (the build is a production build). `--parallel` runs journeys three at a time (`E2E_CONCURRENCY`). Remove `.verify-artifacts/dev-build` when done.

## Reading a failure

- The last line is `E2E_REPORT=<report.md>`; the report names the failed journey and the step (`ctx.step`) it failed in.
- `journeys/<id>/screenshots/NN-failure.png` is the page at the moment of failure; `trace.zip` opens with `bunx playwright-core show-trace <trace.zip>`; `requests.json` holds every HTTP exchange the journey made (redacted).
- `logs/process-app_*.log` are the API, dashboard, website and worker outputs; `logs/NNN-*.log` are the build and setup steps.
- A run that was killed still drops its database on SIGINT/SIGTERM; anything left behind is removed by `bun run e2e:sweep` after an hour.

## Production-mode traps (the app runs with NODE_ENV=production)

- **Auth rate limits are per client IP** (`apps/api/src/auth-policy.ts`: 5 sign-ups per 10 minutes). Each journey is its own client: the context sends a unique TEST-NET `X-Forwarded-For` (loopback is a trusted proxy). Never sign up more than 5 users in one journey.
- **Only same-origin dashboard requests may carry that header.** An extra header on the browser's cross-origin calls to the API fails the CORS preflight and the page hangs on skeletons; the context adds it through `context.route` for the dashboard origin only.
- **Email must be verified to sign in.** `ctx.tenant()` reads the verification link from the SMTP trap and follows it; a valid link signs the user in and lands on `/invoices`.
- **Signing in again can change state.** A user with no workspace who signs in gets a new personal workspace; use `sessionPage(ctx, tenant)` to reuse the existing session instead.
- **The parser pool answers 503 `temporarily_unavailable` when busy.** It is documented back-pressure: `postUpload` retries it like the dashboard does. Do not raise pool limits to make a journey pass.
- **Wait for hydration before driving a client component** (for example the upload drop zone's `#upload-files` input): `waitForLoadState("networkidle")` and a visible text first.
- **The finished-uploads panel overlays the bottom of the invoice sheet**; clear it before clicking buttons there.

## Providers

Everything external is a loopback stand-in (`e2e/support/stubs.ts`): TypeSafe answers through `startTypeSafeStub` for the committed synthetic invoice, Xero is the stateful `xero-fake` behind a fake Nango that binds a connection to the workspace that opened the connect session, Polar and anything else hit the provider trap, mail goes to the SMTP trap. A new provider call needs a stand-in there before a journey can exercise it; never point the gate at a live provider.

## Evidence for a PR

Run `bun run gate` on the branch and put its final `E2E_REPORT=` path in the PR's `## Evidence` section (the merge guard checks the path exists).
