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
docker compose up -d --wait
docker compose ps
bun run db:migrate
```

The `--wait` flag waits for `postgres`, `redis`, and `minio` to become healthy;
`minio-init` creates the private bucket and exits. The migration command applies
`packages/db/migrations` to the database configured by `DATABASE_PRIMARY_URL`.
There is no product-data seed in this repository.

Local development sets only `DATABASE_PRIMARY_URL`. Leave
`DATABASE_FRA_URL`, `DATABASE_SJC_URL`, and `DATABASE_IAD_URL` unset so
`packages/db` uses its single-database path without creating replica pools.

## Run the API

```bash
bun run dev:api
```

The API listens on <http://localhost:3003>. Effect's Bun HTTP server owns the
process; inherited Hono and tRPC routes continue through its compatibility
handler while product paths are converted incrementally. In another terminal,
verify the database-backed health route:

```bash
curl --fail --silent http://localhost:3003/health
```

Expected response:

```json
{"status":"ok"}
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
| `.env` | Docker Compose and database migration tooling | Postgres/MinIO container settings, migration connection URL, and storage defaults |
| `apps/api/.env` | Effect/Bun API, including inherited Hono and tRPC routes | Postgres, Redis, local URLs, storage selection, and the shared Better Auth secret; provider keys are optional until their routes are used |
| `apps/dashboard/.env` | Next.js dashboard | Postgres, local API/storage values, storage selection, the same Better Auth secret, and optional email/provider keys |
| `packages/jobs/.env` | Background jobs | Copy `packages/jobs/.env-template`; use the same storage settings as the API and dashboard, then supply runner/provider credentials |

The API, background jobs, dashboard server routes, Better Auth, and Drizzle
migrations all use `DATABASE_PRIMARY_URL`. `BETTER_AUTH_SECRET` must be at
least 32 characters and identical in the dashboard and API environment files.
When those apps run on sibling subdomains, set `BETTER_AUTH_COOKIE_DOMAIN` in
both files to their shared parent domain (for example, `.invoicewise.uk`).

Invoice extraction and its default judgments use TypeSafe. Set
`TYPESAFE_API_KEY` in the root `.env` for the local verification command and in
`packages/jobs/.env` when running Trigger.dev. `TYPESAFE_BASE_URL` and
`TYPESAFE_MODEL` default to the values in the templates.

To verify the stored-PDF-to-database path with the committed synthetic fixture:

```bash
docker compose up -d --wait
bun run db:migrate
cd packages/jobs
bun --env-file=../../.env run verify:typesafe
```

The command uploads `packages/documents/src/test/fixtures/synthetic-invoice.pdf`
to the configured storage backend, runs the same processing function used by
the attachment job, prints the persisted extraction and judgments, then removes
its temporary team and invoice rows.

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
docker compose up -d --wait
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

Dashboard realtime refreshes use five-second polling until a dedicated local
event transport is selected.

## Stop local services

```bash
docker compose down
```

Postgres data remains in the `invoicewise-postgres` Docker volume. To test the
documented setup against a genuinely fresh database, remove that volume
explicitly with `docker compose down --volumes` before starting again.
