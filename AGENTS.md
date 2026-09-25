# InvoiceWise — Agent Memory

This file is the project's committed home for project-intrinsic agent knowledge.

## Product Vision

InvoiceWise is **invoice middleware** — it sits between invoice receipt and downstream systems, turning unstructured invoices into structured, intelligent data.

**Core flow:**
```
Email in → TypeSafe extraction + judgments → Auto-post or API/webhooks out
```

**Three layers (roadmap):**
1. **Extract + Deliver** (MVP) — Email → Extract → Judgments → Deliver
2. **Reconcile** — Match invoices to authorisation sources (jobs, POs, contracts)
3. **Monitor** — Patterns, contractor reliability, scope creep over time

**Moat:**
- TypeSafe for semantic understanding (not OCR)
- User-defined questions (stickiness)
- Accumulated intelligence over time

## Origin: Midday Fork

This repo is forked from [midday-ai/midday](https://github.com/midday-ai/midday). The
current, observed repository map is:

| Path | Purpose |
|------|---------|
| `apps/dashboard` | Next.js customer app: Better Auth sessions, inbox, intake upload, document viewer, settings |
| `apps/api` | Hono/Effect HTTP API: REST, tRPC, MCP, OAuth, storage capability route, workflow runner |
| `apps/inbound-email` | Cloudflare Email Worker for the per-workspace receiving addresses (`<local>@in.invoicewise.uk`); signs each message to `POST /inbound/email`, deployed with Wrangler, not Kamal (`docs/inbound-email.md`) |
| `apps/website` | invoicewise.uk marketing site: the adopted Midday Next.js landing page with InvoiceWise copy, live-app screenshots and a PocketBase + Purelymail SMTP waitlist (`apps/website/.env-template`) |
| `packages/db` | Drizzle schema and queries for the primary Postgres database, migrations, storage adapters |
| `packages/jobs` | Postgres-backed Effect workflow queue plus document, delivery and accounting work |
| `packages/documents` | Bounded PDF/image validation, preview, layout-aware text and tesseract OCR in isolated child processes; TypeSafe invoice extraction and judgments |
| `packages/inbox` | Gmail/Outlook mailbox connection |
| `packages/email` | Transactional email templates (sent over Purelymail SMTP) |
| `packages/cache` | Redis-backed cache for auth, team-permission and read-after-write paths |
| `packages/supabase` | Legacy Supabase client used only by the inherited marketing site |
| `packages/{ui,utils,invoice,location,logger,encryption,events,categories,tsconfig}` | Shared libraries |

Retired or inherited and deliberately outside the product path: bank feeds
(GoCardless/Plaid/Teller), bank-line transaction matching, time tracking,
invoice creation, vault, desktop/mobile apps and the Trigger.dev task runner.
The remaining retired bank-matching code lives in `packages/db/src/queries/inbox-matching.ts`,
`packages/db/src/queries/transaction-matching.ts` and `packages/db/src/test/transaction-matching*.test.ts`;
the release gate pins its three known failures as a recorded baseline (see `docs/development.md`).

## Stack

- **Runtime:** Bun `1.3.13` (pinned in `packageManager`, CI and docs)
- **Framework:** Next.js 15 (dashboard, website), Hono + Effect (API)
- **Database:** Postgres 17 with pgvector, accessed with Drizzle; local services from `docker-compose.yml`
- **Auth:** Better Auth (users, sessions, memberships, invitations, TOTP second factor, DB-backed rate limits) in the primary database; production boot policy in `apps/api/src/auth-policy.ts`, flows in `docs/development.md#account-security`
- **Background jobs:** Postgres-backed Effect workflow queue (`packages/jobs`); processing completion and every destination's delivery intent commit in one transaction (`packages/jobs/src/delivery.ts`), see `docs/delivery.md#processing-to-delivery-handoff`
- **Storage:** private local filesystem or S3-compatible (MinIO locally, R2 in production)
- **Email:** transactional mail via Purelymail SMTP (nodemailer); **dedicated addresses:** Cloudflare Email Routing on `in.invoicewise.uk` → Email Worker → signed API endpoint → `process-inbound-email` job → shared intake, with the ack/retry contract in `docs/inbound-email.md`; **mailbox ingestion:** Gmail/Outlook OAuth (from Midday)
- **Extraction:** TypeSafe (text-only, selects among options, never generates): code mines candidates from laid-out text (PDF text layer, else tesseract OCR), TypeSafe picks; see `docs/document-intake.md#extraction`. Text PDF, scanned PDF, PNG and JPEG share one pipeline and record shape; HEIC is refused. The input matrix and limits are in `docs/document-intake.md#supported-inputs`
- **Supplier identity:** each processed document resolves to a workspace `suppliers` row (explicit VAT/company number first; a name only when unique), and supplier-scoped, bounded history drives `inbox.supplier_checks` and the history-based judgments; corrections are audited, reversible `supplier_events`. Rules and outcomes are in `docs/document-intake.md#supplier-identity-and-history`; never compare an invoice with another supplier's or workspace's history
- **Questions:** workspace questions (boolean, choice, score, number) are immutable `user_questions` revisions; every stored answer carries its revision and TypeSafe evaluator, `unknown`/low-confidence/incomplete-input are never No or 0, and previews/reruns read the retained `document_texts`. A rerun changes only judgments (kept in `question_answers`) and never bumps `processing_revision`, so it can't post to accounting; see `docs/document-intake.md#questions` and `docs/delivery.md#question-reruns`
- **Authorization sources (Layer 2 foundation):** jobs, purchase orders and contracts keyed by workspace type + reference, with immutable `authorization_source_versions` (a DB trigger refuses edits; amendments, status changes and supplier links are new versions) and an effective-date lookup; CSV/REST batches are all-or-nothing. Rules, CSV format and API are in `docs/authorization-sources.md`; writes are admin-only and use the `sources.read`/`sources.write` scopes
- **Invoice ↔ source matching (Layer 2):** a `match-invoice` job per processed revision links the invoice to its own workspace's sources: an exact printed reference decides in plain code, TypeSafe only chooses among bounded candidates (or none) when none does. Decisions are immutable `invoice_source_matches` (+ `_links`, `_allocations`; `inbox.source_match_id` is current); an admin's confirm/correct/unlink survives reprocessing. Rules, outcomes and API in `docs/authorization-matching.md`
- **Validation:** plain-code checks of every extraction (arithmetic with explicit tolerances, currency pairs, credit notes, duplicate identity) persist in `inbox.validation` and gate accounting delivery; rules and the reviewed fixture corpus (`packages/documents/src/test/corpus`, gated by `thresholds.json`) are in `docs/document-intake.md#validation`
- **Exception workflow:** re-extract, rerun questions, retry delivery and field corrections each carry the processing revision the user saw (one transition per revision); corrections keep the reading (`inbox.extraction_original`, audited `invoice_corrections`), re-run validation, and a posted bill is kept or updated in place, never posted twice. See `docs/delivery.md#corrections-reprocessing-and-retries` (`packages/jobs/src/exceptions.ts`)
- **Integrations:** self-hosted Nango on hp-slice for Xero/QuickBooks (auth + proxy only, so bill adapters live in `packages/jobs`; see `docs/accounting-integrations.md`), Polar (billing), API/MCP/webhooks
- **Outbound to customer URLs:** webhooks send only through the egress guard `packages/jobs/src/egress.ts` (resolve, refuse private/metadata addresses, connect to the pinned address, bounded); never `fetch` a customer-supplied URL. Management and semantics: `docs/delivery.md#webhooks`

## Commands

```bash
bun install                # frozen install in CI: bun install --frozen-lockfile
bun dev                    # all apps
bun dev:dashboard          # dashboard only
bun dev:api                # API + workflow runner
bun dev:website             # marketing site
bun db:migrate             # apply packages/db/migrations forward
bun jobs:worker            # standalone Effect workflow runner
bun jobs:status            # inspect queued/running/stuck jobs
bun jobs:resume-deletions  # re-queue failed account/workspace deletion cleanup (docs/offboarding.md)
bun scripts/ops/load-test.ts  # staging-only load and hostile-input test (docs/operations.md)
# tesseract must be installed locally for the scanned-invoice OCR test (CI and the image install it)
bun typecheck
bun lint
bun format
bun run verify             # authoritative local release verification
bun run verify:security    # dependency + secret checks only
bun run verify:migrations  # fresh, upgrade and recovery migration proof only
```

## Environment variables

Committed templates are authoritative: `.env.example` (Docker Compose, migrations and root
workflow commands), `apps/api/.env-template`, `apps/dashboard/.env-example` and
`packages/jobs/.env-template`. Postgres, Redis, private local/S3 storage, Better Auth,
TypeSafe, Nango and Polar values are documented in `docs/development.md`. Real
`.env` files are gitignored and are never loaded by the verification command.

## Database

`packages/db` owns the schema (`src/schema.ts`) and the ordered, forward-only migrations in
`migrations/`. Applied state is recorded in `drizzle.__drizzle_migrations`. Member tables include
`users`, `teams`, `users_on_team`, `user_questions`, `inbox` (with extraction, judgments, intake
lifecycle, supplier and accounting-delivery columns), `suppliers`, `supplier_events`,
`inbox_redeliveries`, `invoice_corrections`, `authorization_sources` (+ `_versions`, `_documents`, `_imports`), `invoice_source_matches` (+ `invoice_source_links`, `invoice_source_allocations`) and `workflow_jobs`. Bank and transaction tables are
unused but still defined in the schema; `inbox` keeps the accepted document, its source reference and financial fields.

After `drizzle-kit generate`, set the new `_journal.json` entry's `when` above the previous
entry's (the journal uses synthetic increasing values; drizzle skips a migration whose `when` is
not newer than the last applied one).

Workspace data has an owner export and an hourly retention job (`docs/data-lifecycle.md`); a new
table holding workspace data should be added to both, or noted there as deliberately excluded.

A failed migration batch rolls back to the last committed migration set. Recovery is forward:
resolve the conflicting object or data, then re-run `bun db:migrate`. There is no automatic
destructive reset and no fictional rollback for irreversible enum/schema changes; see
`docs/development.md` for the documented procedure and the verification proof.

## Production

The app runs at `app.invoicewise.uk` (dashboard) and `api.invoicewise.uk` (API) on hp-slice,
deployed with Kamal (`config/deploy.yml`) using secrets from the self-hosted Infisical
project `invoicewise` (`prod`). Migrations apply when the API container boots. Deploy with
`infisical run --env prod -- kamal deploy`; the full procedure is in `docs/deployment.md`.
A new required production setting goes in Infisical (`prod` and `staging`), `config/deploy.yml`,
`.kamal/secrets` and `.kamal/secrets.staging` and `scripts/deploy/require-env.sh` together; `scripts/deploy/deploy-config.test.ts` checks they agree.
Behind the proxy a dashboard request's own origin is the internal `https://localhost:3000`, so
absolute dashboard URLs (redirects, provider return URLs) come from `getPublicUrl`
(`apps/dashboard/src/utils/environment.ts`), never `request.url`.
Transactional mail is Purelymail SMTP as `auth@invoicewise.uk`, never Resend.
Staging (`iw-staging-app.zzapp.uk`, `iw-staging-api.zzapp.uk`, own cookie domain) is the Kamal `staging` destination
on hostinger (`config/deploy.staging.yml`, Infisical `staging`), deployed by CI from `main`; drills
(rollback, worker kill, load) run there, never on production. Service targets, capacity/spend
ceilings, `/ops/metrics` (behind `OPS_TOKEN`) and the alert runbook are in `docs/operations.md`;
public `/health*` responses must stay `{"status":…}` only.
Nango runs as the `nango`/`nango-db` Kamal accessories (never restarted by `kamal deploy`); the
InvoiceWise and Nango databases are dumped nightly by `ops/backup` and application container
logs are pruned to 30 days daily by `ops/log-retention` (see `docs/deployment.md`).

## Links

- **App:** [app.invoicewise.uk](https://app.invoicewise.uk)
- **Product:** [invoicewise.uk](https://invoicewise.uk) (separate Vercel marketing site)
- **Upstream:** [github.com/midday-ai/midday](https://github.com/midday-ai/midday)
- **TypeSafe:** [typesafe.ai](https://typesafe.ai)

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
