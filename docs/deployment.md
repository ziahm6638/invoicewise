# Deployment

InvoiceWise runs on `hp-slice`, deployed with Kamal 2 from `config/deploy.yml`.
This is the operator runbook: what runs where, where secrets live, and how to
deploy, check migrations and roll back. The marketing site at `invoicewise.uk`
is `apps/website`, deployed as a separate Vercel project rather than with Kamal.

## Shape

```text
app.invoicewise.uk ─┐
api.invoicewise.uk ─┴─CNAME─▶ Cloudflare Tunnel 7a0344f4… (cloudflared on hp-slice)
                               ingress: both hostnames → http://localhost:3010
kamal-proxy (shared, 127.0.0.1:3010, TLS terminates at Cloudflare)
  ├─ invoicewise-web-<version>  Next.js dashboard, :3000, health /login
  │                             (serves Better Auth at /api/auth and uploads)
  ├─ invoicewise-api-<version>  Bun API + workflow runner, :3003, health /health
  │                             (applies migrations on boot, then serves)
  ├─ invoicewise-db             pgvector/pgvector:0.8.1-pg17, kamal network only,
  │                             data in /mnt/ssd/invoicewise/postgres
  └─ invoicewise-redis          redis:7.4-alpine, data in /mnt/ssd/invoicewise/redis
```

- Host: `hp-slice` (Tailscale `100.90.24.83`). Tailscale SSH as `root`.
- One image (`Dockerfile`), two roles. The image is built on hp-slice
  (`builder.remote`) and moved through Kamal's local registry
  (`localhost:5555`, tunnelled over SSH), so no external registry or registry
  token is involved.
- `<version>` is the git commit Kamal deployed. Deploy from a clean checkout:
  a dirty tree gets an `_uncommitted_…` version that matches no commit.
- Document storage is local (`STORAGE_BACKEND=local`) in
  `/mnt/ssd/invoicewise/storage`, mounted into both roles at `/data/storage`.
- `/health` on the API checks the database; `/login` on the dashboard renders
  the sign-in page. kamal-proxy only switches traffic to a new container once
  its health check passes.

## Configuration and the startup preflight

Each role's entrypoint (`scripts/deploy/web.sh`, `scripts/deploy/api.sh`) first
runs `scripts/deploy/require-env.sh <role>`. It refuses to start the container
when a required setting is missing or empty, when `NODE_ENV` is not
`production`, or when `MIDDAY_ENCRYPTION_KEY` is not 64 hex characters. It
prints only variable names, never values. Several of these settings would
otherwise fail only on first use (extraction, signed document links, encrypted
columns) or fall back to a development default (documents in the container's
`/tmp`). The application itself also refuses to boot in production without
`BETTER_AUTH_SECRET` or the SMTP settings (`SMTP_USER`, `SMTP_PASS`,
`AUTH_EMAIL_FROM`).

A refused container never passes its health check, so `kamal deploy` fails and
the previous release keeps serving. The reason is in
`kamal app logs -r <role>` as `invoicewise-<role> refusing to start: …`.

`scripts/deploy/deploy-config.test.ts` (part of `bun run verify`) keeps
`config/deploy.yml`, `.kamal/secrets` and the preflight in step.

## Secrets

Self-hosted Infisical at `infisical.zzapp.uk`, project `invoicewise`
(`.infisical.json`), environment `prod`. `.kamal/secrets` holds no values; every
line is `NAME=$NAME` from the environment `infisical run` injects.

| Key | Roles | Purpose |
| --- | --- | --- |
| `DATABASE_PRIMARY_URL` | web, api | `postgresql://invoicewise:…@invoicewise-db:5432/invoicewise` |
| `POSTGRES_PASSWORD` | db accessory | the database password (same as in the URL) |
| `BETTER_AUTH_SECRET` | web, api | session and token signing |
| `SMTP_PASS` | web, api | Purelymail password for `auth@invoicewise.uk` |
| `STORAGE_SIGNING_SECRET` | web, api | signed document links |
| `MIDDAY_ENCRYPTION_KEY` | web, api | 32-byte hex key for encrypted columns |
| `TYPESAFE_API_KEY` | api | invoice extraction and judgments (workflow runner) |

Infisical also holds `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `AUTH_EMAIL_FROM` and
`TYPESAFE_BASE_URL` for reference; `config/deploy.yml` sets them in clear. To
list what Infisical holds without printing values:

```bash
infisical export --env prod --format json | jq -r '.[].key'
```

Not configured, so the matching features stay off: Nango (accounting
delivery), Gmail/Outlook OAuth (mailbox connections), Polar (billing). To
enable one, add its keys to Infisical, name them under `env.secret` in
`config/deploy.yml` (on the role that uses them) and in `.kamal/secrets`, and
add any that must never be empty to `scripts/deploy/require-env.sh`.

## Mail

Transactional mail goes through Purelymail SMTP (`smtp.purelymail.com:465`) as
`auth@invoicewise.uk`, sender `InvoiceWise <auth@invoicewise.uk>`. The
`invoicewise.uk` domain's MX, SPF, DKIM and DMARC records point at Purelymail.

## Deploying

Prerequisites on the deploying machine: Docker running locally (for Kamal's
local registry), Kamal 2 (`gem install kamal`), the Infisical CLI logged in to
`https://infisical.zzapp.uk/api`, and Tailscale access to hp-slice.

Deploy the current `main`, from the repository root:

```bash
git switch main && git pull --ff-only && git status --short   # must be clean
infisical run --env prod -- kamal deploy
```

`web` boots first, then `api`, which applies pending migrations before it
serves. The dashboard of a release can therefore briefly run against the
previous schema: keep migrations additive.

First-time setup of a fresh host (accessories, proxy registration) is
`infisical run --env prod -- kamal setup`.

### After a deploy

```bash
infisical run --env prod -- kamal app version        # should print the main SHA
curl -fsS https://api.invoicewise.uk/health          # {"status":"ok"}
curl -fsS -o /dev/null -w '%{http_code}\n' https://app.invoicewise.uk/login   # 200
```

Then sign up with a fresh address and confirm the verification email arrives
through Purelymail.

## Migrations

`scripts/deploy/api.sh` runs `drizzle-kit migrate` from `packages/db` on every
API boot. Pending migrations from `packages/db/migrations` apply in one
transaction and are recorded in `drizzle.__drizzle_migrations`; a failed batch
rolls back, the API container exits before serving, and the previous release
keeps traffic. Confirm the applied count matches the journal:

```bash
ssh root@100.90.24.83 docker exec invoicewise-db \
  psql -U invoicewise -d invoicewise -Atc 'select count(*) from drizzle.__drizzle_migrations'
jq '.entries | length' packages/db/migrations/meta/_journal.json
infisical run --env prod -- kamal app logs -r api | grep -i migrat
```

Recovery from a failed migration is forward only (fix the conflicting object or
data, then deploy again); see `docs/development.md`.

## Rollback

```bash
infisical run --env prod -- kamal app containers     # lists deployed versions
infisical run --env prod -- kamal rollback <version>
```

Rollback swaps the `web` and `api` containers back to an earlier image. It does
not undo migrations: the earlier release runs against the newer schema, which
is why migrations stay additive. Emergency stop:
`infisical run --env prod -- kamal app stop`.

## Logs

```bash
infisical run --env prod -- kamal app logs -r api        # API and workflow logs
infisical run --env prod -- kamal app logs -r web        # dashboard logs
infisical run --env prod -- kamal accessory logs db
```

## Tunnel and DNS

`/root/.cloudflared/config.yml` on hp-slice routes `app.invoicewise.uk` and
`api.invoicewise.uk` to `http://localhost:3010` (edit it, run
`cloudflared tunnel ingress validate`, then `systemctl restart cloudflared`).
Both hostnames are proxied CNAMEs to
`7a0344f4-eee4-4222-acc7-b884164dd249.cfargotunnel.com` in the `invoicewise.uk`
Cloudflare zone.
