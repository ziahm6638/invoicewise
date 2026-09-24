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
| `apps/website` | invoicewise.uk marketing site (inherited Midday content; rewrite tracked in #16) |
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
- **Auth:** Better Auth (users, sessions, memberships, invitations) in the primary database
- **Background jobs:** Postgres-backed Effect workflow queue (`packages/jobs`)
- **Storage:** private local filesystem or S3-compatible (MinIO locally, R2 in production)
- **Email:** transactional mail via Purelymail SMTP (nodemailer); **mailbox ingestion:** Gmail/Outlook OAuth (from Midday)
- **Extraction:** TypeSafe (text-only, selects among options, never generates): code mines candidates from laid-out text (PDF text layer, else tesseract OCR), TypeSafe picks; see `docs/document-intake.md#extraction`. PNG/JPEG invoices take the same OCR path
- **Integrations:** Nango (Xero/QuickBooks), Polar (billing), API/MCP/webhooks

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
lifecycle and accounting-delivery columns) and `workflow_jobs`. Bank and transaction tables are
unused but still defined in the schema; `inbox` keeps the accepted document, its source reference and financial fields.

A failed migration batch rolls back to the last committed migration set. Recovery is forward:
resolve the conflicting object or data, then re-run `bun db:migrate`. There is no automatic
destructive reset and no fictional rollback for irreversible enum/schema changes; see
`docs/development.md` for the documented procedure and the verification proof.

## Production

The app runs at `app.invoicewise.uk` (dashboard) and `api.invoicewise.uk` (API) on hp-slice,
deployed with Kamal (`config/deploy.yml`) using secrets from the self-hosted Infisical
project `invoicewise` (`prod`). Migrations apply when the API container boots. Deploy with
`infisical run --env prod -- kamal deploy`; the full procedure is in `docs/deployment.md`.
A new required production setting goes in Infisical, `config/deploy.yml`, `.kamal/secrets` and
`scripts/deploy/require-env.sh` together; `scripts/deploy/deploy-config.test.ts` checks they agree.
Transactional mail is Purelymail SMTP as `auth@invoicewise.uk`, never Resend.

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
