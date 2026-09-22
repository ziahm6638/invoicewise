# Local development

This setup runs InvoiceWise's API and dashboard locally. Postgres and Redis run
in Docker; the apps run with Bun. Product database reads and writes use Drizzle
against this Postgres instance. Redis is included because the API's auth,
team-permission, and read-after-write caches use `@midday/cache`.

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

The `--wait` flag waits for both `postgres` and `redis` to become healthy. The
migration command applies `packages/db/migrations` to the database configured
by `DATABASE_PRIMARY_URL`. There is no product-data seed in this repository.

Local development sets only `DATABASE_PRIMARY_URL`. Leave
`DATABASE_FRA_URL`, `DATABASE_SJC_URL`, and `DATABASE_IAD_URL` unset so
`packages/db` uses its single-database path without creating replica pools.

## Run the API

```bash
bun run dev:api
```

The API listens on <http://localhost:3003>. In another terminal, verify its
database-backed health route:

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

Open <http://localhost:3001/login>. The inherited dashboard still uses
Supabase Auth only. Product data, file storage, and update polling no longer
use Supabase. The local placeholder Supabase values are enough to render its
logged-out page, but sign-in and authenticated pages require a real Supabase
project until auth is replaced.

If port 3001 is already in use, the dashboard script accepts an override:

```bash
PORT=3101 bun run dev:dashboard
```

## Environment files

Real `.env` and `.env*.local` files are gitignored. The committed templates
are split by the process that reads them:

| File | Used by | Local requirements |
| --- | --- | --- |
| `.env` | Docker Compose and database migration tooling | Postgres container settings and the migration connection URL |
| `apps/api/.env` | Hono API | Postgres, Redis, local URLs, and placeholder secrets; provider keys are optional until their routes are used |
| `apps/dashboard/.env` | Next.js dashboard | Local database/API/storage values and placeholder Supabase Auth values for the logged-out page; external provider keys are optional |
| `packages/jobs/.env` | Trigger.dev jobs | Only needed when running `bun run jobs:dashboard`; copy `packages/jobs/.env-template` and supply Trigger.dev/provider credentials |

The API, background jobs, dashboard server routes, and Drizzle migrations all
use `DATABASE_PRIMARY_URL`.

Files are stored under `LOCAL_STORAGE_PATH` and served by the API through
short-lived HMAC-signed URLs. This is the proven local-development path; the
production object-storage backend is intentionally deferred to a later lane.
Dashboard realtime refreshes use five-second polling until a dedicated local
event transport is selected.

## Stop local services

```bash
docker compose down
```

Postgres data remains in the `invoicewise-postgres` Docker volume. To test the
documented setup against a genuinely fresh database, remove that volume
explicitly with `docker compose down --volumes` before starting again.
