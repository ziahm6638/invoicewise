# The paved path

The one way to add the things this codebase grows by. Every rule marked
**(lint)** is enforced by `bun run lint` (`scripts/check-paved-path.ts`,
`scripts/check-feature-map.ts`, `scripts/check-test-locations.ts`), so a
change that leaves the path fails the gate. Code that predates a rule is
listed in `.paved-path-allowlist.txt` (or `.test-policy-legacy.txt`); those
lists may only shrink **(lint)**: fix an entry and delete its line, never add one.

The gate is `bun run gate` (typecheck, lint, build, then the e2e journeys
against the running app); see [development](development.md#the-gate-e2e-journeys).

## Add a page

1. Put it under `apps/dashboard/src/app/[locale]/(app)/` when it needs a
   signed-in user (inside `(sidebar)/` for the app shell) or
   `apps/dashboard/src/app/[locale]/(public)/` when it does not **(lint)**. URL
   segments are kebab-case, `[param]` or `(group)` **(lint)**; HTTP route
   handlers (`route.ts`) live only under `apps/dashboard/src/app/api/` **(lint)**.
   Example: `settings/webhooks/page.tsx` renders
   `apps/dashboard/src/components/webhook-endpoints.tsx`.
2. Read and write through tRPC: add a procedure to the area's router in
   `apps/api/src/trpc/routers/` (register a new router in `_app.ts`) using the
   narrowest procedure (`workspaceProcedure`, `adminProcedure` or
   `ownerProcedure` from `apps/api/src/trpc/init.ts`). Every mutation gets an
   entry in `TRPC_AUDIT` (`apps/api/src/trpc/audit.ts`); see
   [permissions](permissions.md) for who may do what.
3. Link it from the navigation (`apps/dashboard/src/components/main-menu.tsx`,
   or the settings/account `layout.tsx` sub-navigation).
4. Add it to `docs/feature-map.json`: route, how a user reaches it, its
   elements and actions **(lint: every page route must be mapped or listed in
   `ignoredRoutes` with a reason)**.
5. Cover the flow with a journey (below) and set the feature's `journey`.
   Absolute dashboard URLs come from `getPublicUrl`
   (`apps/dashboard/src/utils/environment.ts`), never `request.url`.

## Add a migration

1. Change `packages/db/src/schema.ts`, then `bun run db:generate`. Keep the
   generated `NNNN_snake_case.sql` name and journal entry; set the new
   `_journal.json` entry's `when` above the previous entry's, or drizzle
   silently skips it **(lint: journal and files agree, idx in order, `when`
   increasing)**. Example: `packages/db/migrations/0031_quickbooks_delivery.sql`.
2. Migrations are forward-only. A failed batch is recovered forward
   ([development](development.md#forward-migration-recovery)).
3. Money columns are integers of minor units (pence): `integer()`/`bigint()`,
   never `numeric`, `numericCasted`, `doublePrecision` or `real` **(lint on
   columns named like amount, total, price, tax, vat, fee, cost, balance,
   discount)**. The inherited decimal columns are allowlisted.
4. Database access lives in `packages/db`: add a query to
   `packages/db/src/queries/<area>.ts`, export it from `queries/index.ts`, and
   call it from the API, jobs or dashboard. Only `packages/db` (and
   verification tooling) imports `drizzle-orm`, `pg` or `postgres` **(lint)**.
5. A table holding workspace data joins the owner export and the retention job
   ([data lifecycle](data-lifecycle.md)), or is noted there as excluded.

## Add a background job

1. Declare the job's payload and add `{ name, payload }` to the
   `WorkflowRequest` union in `packages/jobs/src/schema.ts`.
2. Handle it with a `case "<name>":` in `WorkflowHandlerLive`
   (`packages/jobs/src/workflows.ts`) **(lint: every declared name is handled
   and every handled name is declared)**.
3. Enqueue it with `enqueueWorkflow` (`packages/jobs/src/client.ts`) or
   `enqueueWorkflowJob` inside the transaction that makes it due, always with a
   deterministic idempotency key. Example: `scheduleInvoiceMatch` in
   `packages/jobs/src/source-matching.ts`. Work that must follow processing is
   scheduled in the same transaction
   ([delivery](delivery.md#processing-to-delivery-handoff)).
4. Name the job for people in `packages/jobs/src/activity.ts` so the invoice
   activity trace can show it.

## Add an integration

1. Calls to a provider live in its adapter only: TypeSafe in
   `packages/documents/src/typesafe/`, Xero and QuickBooks only through the
   self-hosted Nango proxy (`packages/jobs/src/nango.ts`,
   `packages/jobs/src/accounting-providers.ts`), Salt Edge (optional bank
   payments) only in `packages/jobs/src/salt-edge.ts` **(lint: a provider's
   API host may appear only in its adapter)**. Nango integrations are created with
   `bun run nango:configure-integration` in `packages/jobs`, never by hand
   ([accounting integrations](accounting-integrations.md)).
2. A customer-supplied URL is only ever called through the egress guard
   (`packages/jobs/src/egress.ts`).
3. A new required setting goes into Infisical (`prod` and `staging`),
   `config/deploy.yml`, `.kamal/secrets`, `.kamal/secrets.staging` and
   `scripts/deploy/require-env.sh` together ([deployment](deployment.md)).
4. The provider gets a loopback stand-in for the gate: extend
   `e2e/support/stubs.ts` (reuse the verifiers' fakes, such as
   `packages/jobs/src/xero-fake.ts`). The gate never reaches a live provider,
   moves money or spends on TypeSafe.

## Add a journey (the only kind of test)

1. Create `e2e/journeys/<id>.journey.ts` default-exporting a `Journey`
   (`e2e/support/journey.ts`) whose `id` is the file name and whose `features`
   are ids from `docs/feature-map.json`.
2. Create your own users and workspaces with `ctx.tenant(label)` (it signs up,
   follows the emailed verification link and signs in), so journeys run in any
   order and in parallel. Drive the browser with `ctx.page()` (Playwright,
   traced) or `signedInPage`, and HTTP with `ctx.http`/`ctx.trpcQuery`/
   `ctx.trpcMutation` (recorded to `requests.json`). Assert what the user
   sees and what the running app persisted; take `ctx.screenshot`s at the
   moments that matter.
3. Run it alone with `bun run e2e -- --journey <id>`.

Unit tests are not written or kept: a `*.test.*`/`*.spec.*` file may live
only in `e2e/` or `invariants/` **(lint)**. `invariants/` holds at most 10
files, each opening with `// Guards: <the real failure it guards>` **(lint)**,
for checks a journey cannot express.
