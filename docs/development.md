# Local development

This setup runs InvoiceWise's API and dashboard locally. Postgres, Redis, and a
private MinIO bucket for S3-compatible storage testing run in Docker; the apps
run with Bun. Product database reads and writes use Drizzle against this
Postgres instance. Redis is included because the API's auth, team-permission,
and read-after-write caches use `@invoicewise/cache`.

## Prerequisites

- [Bun](https://bun.sh/) 1.3.13 (the version pinned in `packageManager`, CI and these docs;
  `bun install --frozen-lockfile` is the only supported install)
- Docker with Docker Compose
- [tesseract](https://github.com/tesseract-ocr/tesseract) for scanned-invoice
  OCR (`brew install tesseract` or `apt-get install tesseract-ocr`); without it
  the scanned-fixture test is skipped locally, but CI requires it

## First-time setup

From a clean clone:

```bash
git clone https://github.com/ziahm6638/invoicewise.git
cd invoicewise
bun install
cp .env.example .env
cp apps/api/.env-template apps/api/.env
cp apps/dashboard/.env-example apps/dashboard/.env
docker compose up -d --wait postgres redis minio
docker compose run --rm minio-init
docker compose ps
bun run db:migrate
```

The `--wait` flag waits for `postgres`, `redis`, and `minio` to become healthy.
The one-shot `minio-init` command then creates the private bucket and exits;
running it separately avoids Docker Compose treating that successful exit as a
failed `--wait`. The migration command applies
`packages/db/migrations` to the database configured by `DATABASE_PRIMARY_URL`.
There is no product-data seed in this repository.

Local development sets only `DATABASE_PRIMARY_URL`. Leave
`DATABASE_FRA_URL`, `DATABASE_SJC_URL`, and `DATABASE_IAD_URL` unset so
`packages/db` uses its single-database path without creating replica pools.

## Run the API

```bash
bun run dev:api
```

The API listens on <http://localhost:3003>. Effect's Bun HTTP server and the
workflow runner share the process and shutdown scope, so background work starts
with the API. Inherited Hono and tRPC routes continue through the compatibility
handler while product paths are converted incrementally. In another terminal,
verify the database-backed health route:

```bash
curl --fail --silent http://localhost:3003/health
```

Expected response:

```json
{"status":"ok"}
```

## Background workflows

Product work is enqueued with `enqueueWorkflow` from `@invoicewise/jobs`. The
enqueue call writes a `workflow_jobs` row in Postgres and requires an
idempotency key; repeating the same workflow name and key returns the existing
row instead of scheduling duplicate work. The API-owned Effect runner claims
due rows with `FOR UPDATE SKIP LOCKED` and runs at most
`WORKFLOW_CONCURRENCY` jobs at once (default `4`).

Failed work is retried three times by default with exponential backoff from 5
seconds to 60 seconds. A running job has a renewable two-minute lease. If the
process dies, another runner reclaims the job after that lease; a final expired
lease is marked failed. Every start, retry, success, and terminal failure is
written as a structured JSON log with the workflow ID, name, attempt, and
outcome.

The API starts the runner automatically. A second runner can safely be started
against the same queue for local concurrency testing:

```bash
bun run jobs:worker
```

Inspect recent jobs and the `stuck` flag (a running row whose lease expired):

```bash
bun run jobs:status
```

## Run the dashboard

```bash
bun run dev:dashboard
```

Open <http://localhost:3001/signup> to create a local account and workspace.
Better Auth stores users, credentials, sessions, memberships, and invitations
in the same Postgres database as product data. In local development,
set `AUTH_MAIL_SINK_PATH` to capture verification and password-reset mail
(with its links) in a local file; without a sink or SMTP credentials, only the
subject and recipient are logged (see [Transactional mail](#transactional-mail)).

If port 3001 is already in use, the dashboard script accepts an override:

```bash
PORT=3101 bun run dev:dashboard
```

## Environment files

Real `.env` and `.env*.local` files are gitignored. The committed templates
are split by the process that reads them:

| File | Used by | Local requirements |
| --- | --- | --- |
| `.env` | Docker Compose, database migrations, and the root workflow commands | Postgres/MinIO container settings, migration connection URL, storage selection, and TypeSafe credentials |
| `apps/api/.env` | Effect/Bun API and its workflow runner, including inherited Hono and tRPC routes | Postgres, Redis, local URLs, storage selection, runner settings, and the shared Better Auth secret; provider keys are optional until their workflows run |
| `apps/dashboard/.env` | Next.js dashboard | Postgres, local API/storage values, storage selection, the same Better Auth secret, and optional email/provider keys |
| `packages/jobs/.env` | Direct package-level worker commands | Copy `packages/jobs/.env-template`; use the same database, storage, and provider settings as the API |

The API, background jobs, dashboard server routes, Better Auth, and Drizzle
migrations all use `DATABASE_PRIMARY_URL`. `BETTER_AUTH_SECRET` must be at
least 32 characters and identical in the dashboard and API environment files.
When those apps run on sibling subdomains, set `BETTER_AUTH_COOKIE_DOMAIN` in
both files to their shared parent domain (for example, `.invoicewise.uk`).

Invoice extraction and its judgments use TypeSafe. Set `TYPESAFE_API_KEY` in
the API or standalone worker environment for normal workflow processing.
`TYPESAFE_BASE_URL` and `TYPESAFE_MODEL` have committed defaults. The local
verification command starts a deterministic TypeSafe stub and does not require
external credentials. One test drives the real API on the UK invoice fixture
when asked to:

```bash
cd packages/documents
TYPESAFE_LIVE_SMOKE=1 TYPESAFE_API_KEY=... bun test src/typesafe -t live
```

The invoice fixtures (`uk-invoice.pdf`, `uk-invoice-scanned.pdf` with no text
layer, and the sole-trader style `uk-invoice-footer.pdf`) are regenerated by
`bun src/test/fixtures/generate-uk-invoice.ts` from `packages/documents`.

Accounting connections and draft-bill delivery use Nango. Set
`NANGO_SECRET_KEY`, the Xero and QuickBooks integration IDs, and their
draft-bill action names in both the API and standalone worker environments.
`NANGO_BASE_URL` defaults to Nango Cloud and is overridden only by the local
verification stub. See [Nango accounting integrations](accounting-integrations.md)
for the action contract, required API-key scopes, connection-ID storage, local
proof command, and the live-provider checks that remain outstanding.

To verify the stored-PDF-to-database path with the committed synthetic fixture:

```bash
docker compose up -d --wait postgres redis minio
docker compose run --rm minio-init
bun run db:migrate
cd packages/jobs
bun --env-file=../../.env run verify
```

The command uses the configured storage backend and first queues the synthetic
PDF while it is missing to prove the retry path. It then uploads
`packages/documents/src/test/fixtures/synthetic-invoice.pdf`, runs the real
queued attachment workflow through TypeSafe extraction and judgments, checks
the persisted invoice (including workspace questions), repeats the same
idempotency key, prints the structured runner logs and a verification summary,
and removes its temporary rows and file.

## Identity lifecycle

Better Auth owns verified addresses, credentials and sessions. The product adds
the workspace rules around them instead of keeping a second copy.

| Action | Supported entry point | Session effect |
| --- | --- | --- |
| Signup | `/api/auth/sign-up/email`, then the emailed verification link | Verification signs the account in and provisions one personal workspace; a failed provisioning attempt is retried on the link and on sign-in |
| Email change | `/api/auth/change-email`, then the link sent to the new address | Requires a session signed in within the recent-auth window; completing the change ends every session, including the one the completion response would issue |
| Password reset | `/api/auth/request-password-reset`, then `/api/auth/reset-password` | Every session ends and the account signs in again |
| Password change | `/api/auth/change-password` with `revokeOtherSessions` | The caller receives one fresh session; every other session ends |
| Invitations | dashboard `team.invite` / `team.acceptInvite` (tRPC), delivered by the `invite-team-members` queue job | Unaffected by identity changes |

The rules that keep those flows safe:

- A verified address changes only through Better Auth's verification or
  email-change flow. The generic profile endpoints accept no `email` field and
  reject unknown keys, the DB update helper has no email parameter, and
  `/api/auth/update-user` accepts name and image only.
- An email change needs a session created inside `session.freshAge` (24 hours).
  A stale session is refused with `403` before any message is sent.
- An address that already belongs to an account is never taken over. The
  request is answered without disclosing which address is taken, and neither
  account changes.
- Invitations bind recipient email, workspace, role, status and expiry in one
  locked transaction that re-reads the invite, consumes it and grants the
  membership. Replay, revocation, expiry, wrong-recipient and concurrent
  acceptance are covered by `apps/api/src/identity.http.integration.test.ts`.
- Signup provisioning is idempotent and takes the user row lock before reading
  memberships, the accepted order that account deletion also uses. A signup or
  verification whose workspace insert failed is repaired by the next
  verification request and by the next sign-in, and repeated or concurrent
  attempts settle on exactly one workspace and one membership. The customer
  never needs a manual database repair.
- Session revocation is ordered *before* the identity or credential mutation it
  protects: `/verify-email` for a change-email token, `/reset-password`, and
  `/change-password` with `revokeOtherSessions`. If the revocation cannot
  complete, the request fails with the verified address, reset token and
  password unchanged, so the customer can retry the same link instead of being
  left with a moved address or a new password beside live old sessions.

### Transactional mail

Transactional mail is sent through Purelymail over SMTP with nodemailer. The
API (Better Auth identity mail, API-key and OAuth-application notices, inbox
forwarding) and the workflow worker (invitation and onboarding mail) share one
policy in `@invoicewise/utils/transactional-mail`:

| Variable | Purpose |
| --- | --- |
| `SMTP_HOST` | SMTP server, default `smtp.purelymail.com` |
| `SMTP_PORT` | Default `465`, which uses implicit TLS; any other port starts in plain text |
| `SMTP_USER`, `SMTP_PASS` | The Purelymail mailbox credentials; mail is "not configured" without both |
| `AUTH_EMAIL_FROM` | The sender for every transactional message, a Purelymail address such as `InvoiceWise <auth@invoicewise.uk>` |
| `AUTH_MAIL_SINK_PATH` | Optional local capture file, honoured outside production only |

Verification, invitation and reset links carry bearer tokens, so delivery is
fail-closed:

- Production refuses to start when `SMTP_USER`, `SMTP_PASS` or
  `AUTH_EMAIL_FROM` is missing (the API at import time, the worker when it
  builds its mailer).
- Token-bearing links are never written to a log or a file in production, and
  production ignores `AUTH_MAIL_SINK_PATH`.
- Outside production the explicit sink wins: mail is captured in the file named
  by `AUTH_MAIL_SINK_PATH` instead of being sent, and that sink covers the
  queued workflow mail as well as Better Auth identity mail. The captured
  record holds the real link, so the whole journey completes locally. Without
  a sink, the API sends over SMTP when it is configured and otherwise logs only
  the subject and recipient.
- `AUTH_EMAIL_FROM` is the sender for every transactional message, including
  the invitation and onboarding templates that previously hardcoded their own
  `from` address (Purelymail only relays for its own addresses), and the
  configured application origin (`NEXT_PUBLIC_URL`) is used for links in that
  mail.
- Resend is not used for transactional mail. `RESEND_API_KEY` and
  `RESEND_AUDIENCE_ID` only serve the optional marketing audience (onboarding
  contacts and contact removal on account deletion), which is skipped unless
  both are set.
- Tests and verification send to a loopback SMTP trap
  (`@invoicewise/utils/smtp-trap`) with explicit synthetic credentials; live
  Purelymail delivery stays owner-gated evidence.

## Document storage

All callers use `@invoicewise/db/storage`. `STORAGE_BACKEND` selects one of two
implementations:

- `local` (the default) stores files under `LOCAL_STORAGE_PATH`.
- `s3` stores files in the private bucket named by `STORAGE_S3_BUCKET`. It works
  with the included MinIO service and Cloudflare R2.

Both backends keep the same logical object key (`vault/<team>/inbox/<file>`) and
the same API download path. The API validates its own short-lived HMAC signature
using `STORAGE_SIGNING_SECRET`, then reads the private object through the storage
service. Objects are not made public and the S3 endpoint is never exposed in a
download URL. `LOCAL_STORAGE_SIGNING_SECRET` remains a temporary compatibility
fallback, but new environments should set `STORAGE_SIGNING_SECRET`.

To exercise the S3 path against MinIO, set these values in each process that
uses storage (`apps/api/.env`, `apps/dashboard/.env`, and the jobs environment):

```dotenv
STORAGE_BACKEND=s3
STORAGE_SIGNING_SECRET=local-development-storage-secret
STORAGE_PUBLIC_URL=http://localhost:3003
STORAGE_S3_ENDPOINT=http://localhost:9000
STORAGE_S3_BUCKET=invoicewise
STORAGE_S3_ACCESS_KEY_ID=invoicewise
STORAGE_S3_SECRET_ACCESS_KEY=invoicewise-secret
STORAGE_S3_REGION=us-east-1
STORAGE_S3_FORCE_PATH_STYLE=true
```

Then run the repeatable backend integration test:

```bash
docker compose up -d --wait postgres redis minio
docker compose run --rm minio-init
STORAGE_BACKEND=s3 \
STORAGE_SIGNING_SECRET=local-development-storage-secret \
STORAGE_PUBLIC_URL=http://localhost:3003 \
STORAGE_S3_ENDPOINT=http://localhost:9000 \
STORAGE_S3_BUCKET=invoicewise \
STORAGE_S3_ACCESS_KEY_ID=invoicewise \
STORAGE_S3_SECRET_ACCESS_KEY=invoicewise-secret \
STORAGE_S3_REGION=us-east-1 \
STORAGE_S3_FORCE_PATH_STYLE=true \
STORAGE_S3_INTEGRATION=1 \
bun test packages/db/src/storage.s3.test.ts
```

The test uploads a PDF key, uploads a replacement to the same key, asserts only
one object exists, downloads it, verifies the application signature, deletes it,
and confirms it can no longer be downloaded.

For production R2, create a bucket-scoped Object Read & Write API token and set:

```dotenv
STORAGE_BACKEND=s3
STORAGE_SIGNING_SECRET=<independent-random-secret>
STORAGE_PUBLIC_URL=https://api.invoicewise.uk
STORAGE_S3_ENDPOINT=https://<cloudflare-account-id>.r2.cloudflarestorage.com
STORAGE_S3_BUCKET=<private-r2-bucket-name>
STORAGE_S3_ACCESS_KEY_ID=<r2-access-key-id>
STORAGE_S3_SECRET_ACCESS_KEY=<r2-secret-access-key>
STORAGE_S3_REGION=auto
STORAGE_S3_FORCE_PATH_STYLE=false
```

Use the jurisdiction endpoint instead (for example,
`https://<account-id>.eu.r2.cloudflarestorage.com`) when the R2 bucket has a
jurisdiction. Do not enable an `r2.dev` public URL or public bucket access.

Dashboard workflow status uses one-second polling until a dedicated local event
transport is selected.

## Release verification

`bun run verify` is the authoritative, reproducible check for this repository.
It installs from the frozen lockfile and then gates the whole workspace on a
disposable local stack:

- lint and typecheck for every workspace (including the marketing site and the
  verifier scripts themselves), `manypkg check`, and the workspace unit suites
  (`packages/db`, `packages/documents`, `packages/jobs`, `packages/encryption`,
  `packages/inbox`, `apps/api` and `apps/dashboard`) plus the verifier
  negative-control suite (`bun run verify:selftest`);
- an empty-database bootstrap, an upgrade from the recorded prior schema at
  `ef798a99` (migrations through `0006`) with synthetic users, membership,
  invoice and queued-work rows, and an injected migration failure with the
  documented forward recovery;
- the existing verifiers: `apps/api` delivery, `packages/jobs` workflows and
  accounting, the local and MinIO-backed storage adapters, and the #32/#34
  security and intake HTTP regression suites (including the concurrency,
  content-hash and request-body bound checks);
- real production builds for the dashboard and website, and executable
  `bun build --packages=external` artifacts for the API and the workflow worker
  that are started and probed (health, database health, OpenAPI, a real queued
  job claimed by that worker process, and graceful `SIGTERM` shutdown);
- a two-workspace production-entrypoint smoke: Better Auth sign-up and sign-in
  on a built dashboard origin, a real upload through `/api/storage/upload`, the
  original document through `/api/proxy`, the rendered invoice through
  `/api/preview`, tRPC reads on the separate API origin, and denied cross-tenant
  reads;
- the dependency and secret checks described below.

Supporting commands:

```bash
bun run verify:migrations   # migrations and recovery drill only
bun run verify:security     # dependency advisories and tracked-file secret scan
bun run verify:selftest     # negative controls for the verification tooling
```

Requirements and isolation rules:

- Start the disposable services first: `docker compose up -d --wait postgres
  redis minio` and `docker compose run --rm minio-init`. CI uses
  `scripts/verify/ci-services.sh`, which starts the same pinned images with
  explicit server commands (the pinned MinIO image's default command only prints
  help). It publishes every port on **127.0.0.1 only**, labels the containers it
  owns (`invoicewise.verify.service=true` plus the verification prefix), refuses
  to remove a same-named container it does not own, and asserts the published
  Docker `HostIp` after start; `bash scripts/verify/ci-services.sh --self-check`
  proves the refusal inside its own freshly generated namespace: it never
  touches the caller's or the default service names, never pre-deletes a name,
  records the exact IDs of the decoy and of a labelled live-looking verification
  container it creates, requires both to survive, and removes only those IDs.
  `scripts/verify/ci-services-caller-check.sh` is the automated regression for a
  caller-prefixed pre-existing container surviving intact, and the gate runs it
  as `preflight:ci-bootstrap-caller-prefix-safety`. Service teardown removes
  only IDs captured at start. The verification runner then creates the private
  bucket through the S3 API, so no `mc` container is needed. Override
  `VERIFY_POSTGRES_BASE`/`VERIFY_REDIS_URL`/`VERIFY_MINIO_ENDPOINT` to point at
  a different disposable stack (defaults are local: `localhost` for Postgres, `127.0.0.1` for Redis and MinIO).
- Every database is created and validated as disposable
  (`invoicewise_<name>_test`) before it is dropped or recreated. The command
  refuses loopback violations and protected names and never resets the
  `invoicewise` development database or any Docker volume.
- All product processes (Next build/start, bun test suites, verifiers,
  migrations, executables) run inside a symlink overlay of the repository that
  contains **no** `.env` file, so a developer `.env` cannot be loaded even
  though Next reads dotenv files itself. A canary proves both directions: the
  Next env loader does read a canary `.env` when present, and the overlay loads
  none. Bun children additionally run with `--no-env-file`, and every
  provider/telemetry key is defined-but-empty so a stray file cannot inject a
  live value.
- TypeSafe, Nango and Polar base URLs point at a loopback provider trap started
  by the run, and `SMTP_HOST`/`SMTP_PORT` point at a loopback SMTP trap with
  synthetic credentials. The traps record every request and message (the
  e2e's production-mode Better Auth verification emails reach the SMTP trap
  and TypeSafe calls reach the provider trap, not a paid endpoint).
  `RESEND_API_KEY` is pinned empty.
  Redis uses the disposable logical database `redis://127.0.0.1:6379/9`
  (override with `VERIFY_REDIS_URL`) and MinIO objects use a unique per-run key
  prefix, so no development cache namespace or bucket object is reset.
- Safety preconditions abort the run before any process, database or build
  effect: a rejected target, a missing canary, or an unreachable service
  stops the command (a missing bucket is created) with a redacted summary
  (`bun run verify:selftest` proves the abort with a non-loopback target).
- Redacted logs and `summary.json` are written to `.verify-artifacts/<run-id>/`
  (gitignored) and include the provider-trap request list, the SMTP trap's
  connection and message counts (never message content), the excluded `.env`
  files and the workspace overlay size. The command exits non-zero if any step
  fails, is aborted, or throws unexpectedly. Credential-shaped text is redacted
  before it reaches any note, abort detail, cleanup message or the serialized
  summary; the negative-control suite asserts that a synthetic
  `re_…`-shaped `VERIFY_REDIS_URL` appears in neither stdout/stderr nor
  `summary.json`.

### Forward migration recovery

`packages/db/migrations` is forward-only. `drizzle-kit migrate` applies the
pending batch inside one transaction, so an injected or genuine failure leaves
the database at its last committed migration set; there is no automatic
destructive reset and no fictional rollback for irreversible enum or schema
changes. To recover:

1. Read the failing statement from the migration log (`bun run verify:migrations`
   reproduces the drill against a disposable database).
2. Resolve the conflicting object or data directly (for example, reconcile
   duplicate references before `0009` adds the workspace-scoped unique index).
3. Re-run `bun run db:migrate` and confirm `drizzle.__drizzle_migrations` has one
   row per migration file.

### Dependency and secret checks

`.github/workflows/ci.yml` runs `bun run verify` on pull requests and pushes to
`main`, and a separate `security` job that runs `bun run verify:security`.
Both jobs should be required checks in branch protection; each uploads the redacted
`.verify-artifacts` directory when it fails.

- Dependencies: `bun audit --json` is compared with
  `scripts/verify/dependency-advisory-baseline.json`. A new **high** or
  **critical** advisory fails the job. The 132 recorded entries are the initial
  inventory of outstanding security debt for the inherited dependency tree,
  tracked under **#62** for triage and burn-down; they are not release
  clearance. Remove a baseline entry only after the upgrade that resolves it,
  and never add one without a written reason in the same change.
- Secrets: tracked **and untracked non-ignored** files are scanned locally for
  high-confidence credential patterns (private keys, cloud/provider tokens,
  assigned credentials). CI scans the committed files. Exceptions are exact
  `(path, value)` fixture pairs in `scripts/verify/security.ts`; a real value
  must be rotated and the finding fixed rather than allowlisted, and the
  negative controls prove that a live-shaped token in a template path or with
  "test" in the value is still reported.
- The scanner fails closed: a failed `git ls-files`, a candidate path missing
  from the worktree (uncommitted deletion), a non-regular file, or a read error
  fails the check instead of producing a zero-hit result. The step reports how
  many text files were scanned and how many binary candidates were skipped by
  content.
- Owner: the repository maintainer owns both checks. A failing dependency check
  is handled by upgrading the dependency, pinning a patched version, or
  re-baselining with the reason recorded next to the entry. A failing secret
  check is handled by rotating the credential and removing it from history.

### Recorded scope boundary

Website types/lint are gated normally (they were repaired as compile/lint
repairs, without redesigning marketing content).

Dependency ranges are gated by an exact list rather than a blanket waiver. The
root `package.json` keeps `manypkg.ignoredRules: ["EXTERNAL_MISMATCH"]` only so
the other native manypkg rules stay enforceable; the range rule itself is
replaced by `scripts/verify/dependency-ranges.ts`, which re-runs the installed
manypkg CLI over a probe copy of the current manifests with the waiver removed
and requires the resulting mismatches to equal
`scripts/verify/dependency-range-exceptions.json` exactly (currently ten
entries: `@types/bun`, `@date-fns/utc`, `@polar-sh/sdk`, `@types/node` twice,
`@team-plain/typescript-sdk`, `framer-motion`, `zod` twice and `ai`, each with a
reason). A new or changed mismatch, a stale recorded entry, or any other
manypkg error inside the probe fails the gate. Incompatible runtime ranges (zod
v4 in `documents`/`categories`, the 0.x Polar SDK difference) are deliberately
not forced; no dependency was upgraded for this check. The negative-control
suite also runs manypkg against a probe copy to prove the root configuration
waives only external range mismatches while every other rule still fails.

Retired bank/transaction matching is the only product-scope exclusion: those
suites stay in the repository for historical reference, are out of
`packages/db`'s product `test` script (reachable via
`bun run test:retired-bank-matching`), and the verification command still runs
the retired unit suite (`transaction-matching.test.ts`), requiring a completed
run whose failures are exactly the three recorded tiered-tolerance tests, by
name — a crashed or unreadable run, a newly failing test or a recorded failure
that starts passing fails the gate.
`packages/supabase` is used only by the inherited marketing site, whose data
sources are out of contract.

## Stop local services

```bash
docker compose down
```

Postgres data remains in the `invoicewise-postgres` Docker volume. To test the
documented setup against a genuinely fresh database, remove that volume
explicitly with `docker compose down --volumes` before starting again.
