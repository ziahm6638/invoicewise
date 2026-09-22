# Local development

This setup runs InvoiceWise's API and dashboard locally. Postgres, Redis, and a
private MinIO bucket for S3-compatible storage testing run in Docker; the apps
run with Bun. Product database reads and writes use Drizzle against this
Postgres instance. Redis is included because the API's auth, team-permission,
and read-after-write caches use `@midday/cache`.

## Prerequisites

- [Bun](https://bun.sh/) 1.2.21 or newer
- Docker with Docker Compose

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

Product work is enqueued with `enqueueWorkflow` from `@midday/jobs`. The
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
verification and password-reset links are printed in the dashboard terminal
when `RESEND_API_KEY` has the placeholder value from the template.

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
external credentials.

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

## Document storage

All callers use `@midday/db/storage`. `STORAGE_BACKEND` selects one of two
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

## Stop local services

```bash
docker compose down
```

Postgres data remains in the `invoicewise-postgres` Docker volume. To test the
documented setup against a genuinely fresh database, remove that volume
explicitly with `docker compose down --volumes` before starting again.
