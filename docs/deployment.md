# Deployment

InvoiceWise runs on `hp-slice`, deployed with Kamal 2 from `config/deploy.yml`.
This is the operator runbook: what runs where, where secrets live, and how to
deploy, check migrations and roll back. Staging (`iw-staging-app.zzapp.uk`) is
the `staging` Kamal destination on hostinger; see [Staging](#staging). Service
targets, capacity and spend ceilings, alerts and the drain/rollback model are
in [operations.md](operations.md). The marketing site at `invoicewise.uk`
is `apps/website`, deployed as a separate Vercel project rather than with Kamal.

## Shape

```text
app.invoicewise.uk ─┐
api.invoicewise.uk ─┴─CNAME─▶ Cloudflare Tunnel 7a0344f4… (cloudflared on hp-slice)
                               ingress: both hostnames → http://localhost:3010
kamal-proxy (shared, 127.0.0.1:3010, TLS terminates at Cloudflare)
  ├─ invoicewise-web-<version>  Next.js dashboard, :3000, health /login
  │                             (serves Better Auth at /api/auth and uploads)
  ├─ invoicewise-api-<version>  Bun API + workflow runner, :3003, health /health/ready
  │                             (applies migrations on boot, then serves)
  ├─ invoicewise-db             pgvector/pgvector:0.8.1-pg17, kamal network only,
  │                             data in /mnt/ssd/invoicewise/postgres
  └─ invoicewise-redis          redis:7.4-alpine, data in /mnt/ssd/invoicewise/redis

<local>@in.invoicewise.uk ─MX─▶ Cloudflare Email Routing ─▶ Email Worker invoicewise-inbound-email
                               └─▶ POST https://api.invoicewise.uk/inbound/email (signed; see docs/inbound-email.md)

nango.invoicewise.uk ─────┐   (same tunnel; see "Nango")
nango-connect.invoicewise.uk ┴─▶ invoicewise-nango    nangohq/nango-server, 127.0.0.1:3020 (API)
                                                      and 127.0.0.1:3021 (Connect UI)
                                 invoicewise-nango-db postgres:16, kamal network only,
                                                      data in /mnt/ssd/invoicewise/nango-postgres
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
- `/health/ready` on the API checks the database and answers only
  `{"status":"ok"}` or `{"status":"unavailable"}`; `/login` on the dashboard
  renders the sign-in page. kamal-proxy only switches traffic to a new
  container once its health check passes. Operator diagnostics are at
  `/ops/metrics` behind `OPS_TOKEN` ([operations.md#health-and-diagnostics](operations.md#health-and-diagnostics)).
- The web container is capped at 1 GiB and the api container at 2 GiB
  (`options.memory`); pools, concurrency, queue and TypeSafe spend bounds are
  set in `config/deploy.yml` ([operations.md#capacity-and-spend-ceilings](operations.md#capacity-and-spend-ceilings)).

## Configuration and the startup preflight

Each role's entrypoint (`scripts/deploy/web.sh`, `scripts/deploy/api.sh`) first
runs `scripts/deploy/require-env.sh <role>`. It refuses to start the container
when a required setting is missing or empty, when `NODE_ENV` is not
`production`, when `MIDDAY_ENCRYPTION_KEY` is not 64 hex characters, when a
pool, concurrency, queue or spend bound is not a positive whole number, when a
public URL is not https, when `OPS_TOKEN` is shorter than 32 characters, or
when a staging container would use production's cookie names. It prints only
variable names, never values. Several of these settings would
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
| `OPS_TOKEN` | api | bearer token for `/ops/metrics`, read by `ops/monitor` |
| `OPS_ALERT_TO` | monitor only | operator address for alerts; written to the monitor host by `ops/monitor/install.sh`, not deployed |
| `INBOUND_EMAIL_SECRET` | api, Email Worker (Wrangler secret) | signs every Worker → API delivery for the dedicated addresses ([inbound email](inbound-email.md#cloudflare-setup)) |
| `INBOUND_EMAIL_LIVE` | api (optional) | `true` shows workspaces their receiving address; set only after the live proof ([going live](inbound-email.md#going-live)) |
| `BANK_PAYMENTS_ENABLED` | api (optional) | `true` offers the optional [bank payments](bank-payments.md#deployment); production is `false` and the API also refuses it there without `SALT_EDGE_PRIVATE_KEY` (a live-status Salt Edge app) |
| `SALT_EDGE_APP_ID`, `SALT_EDGE_SECRET`, `SALT_EDGE_PRIVATE_KEY` | api (optional) | Salt Edge app credentials; set in staging (sandbox app), not in production |
| `NANGO_SECRET_KEY` | api, nango accessory | the Nango `prod` environment secret key (`NANGO_SECRET_KEY_PROD` in Nango) |
| `NANGO_ENCRYPTION_KEY` | nango accessory | encrypts provider tokens in the Nango database; never change it |
| `NANGO_DB_PASSWORD` | nango, nango-db accessories | the Nango database password |
| `NANGO_DASHBOARD_PASSWORD` | nango accessory | basic-auth password for the Nango admin dashboard (user `invoicewise-admin`) |

Infisical also holds `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `AUTH_EMAIL_FROM` and
`TYPESAFE_BASE_URL` for reference; `config/deploy.yml` sets them in clear. To
list what Infisical holds without printing values:

```bash
infisical export --env prod --format json | jq -r '.[].key'
```

Not configured, so the matching features stay off: Gmail/Outlook OAuth
(mailbox connections), Polar (billing). To
enable one, add its keys to Infisical, name them under `env.secret` in
`config/deploy.yml` (on the role that uses them) and in `.kamal/secrets`, and
add any that must never be empty to `scripts/deploy/require-env.sh`.

## Mail

Transactional mail goes through Purelymail SMTP (`smtp.purelymail.com:465`) as
`auth@invoicewise.uk`, sender `InvoiceWise <auth@invoicewise.uk>`. The
`invoicewise.uk` domain's MX, SPF, DKIM and DMARC records point at Purelymail.

Receiving for the workspaces' dedicated addresses is separate: only the
`in.invoicewise.uk` subdomain's MX points at Cloudflare Email Routing, whose
Email Worker (`apps/inbound-email`) is deployed with Wrangler, not Kamal. See
[Dedicated receiving address](inbound-email.md#cloudflare-setup).

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
curl -fsS https://api.invoicewise.uk/health/ready    # {"status":"ok"}
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

## Nango

Self-hosted Nango (free edition: OAuth and the authenticated proxy) carries the
Xero and QuickBooks connections; how InvoiceWise uses it is in
[accounting-integrations.md](accounting-integrations.md). It runs as two Kamal
accessories on hp-slice, `nango` and `nango-db`, with its own Postgres so
Nango's schema and upgrades stay apart from the InvoiceWise database. The API
reaches it as `http://invoicewise-nango:3003` on the kamal network.

- `nango.invoicewise.uk` (API, OAuth callback `/oauth/callback`, websocket)
  and `nango-connect.invoicewise.uk` (Connect UI) come through the Cloudflare
  Tunnel to the loopback ports 3020 and 3021; TLS terminates at Cloudflare.
- Every public API route needs the secret key or a connect-session token.
  The admin dashboard's API (`/api/v1`) and `/internal` are refused (404) on
  the public host by the tunnel ingress, and additionally require basic auth.
- Admin dashboard, over SSH only:

  ```bash
  ssh -N -L 3020:127.0.0.1:3020 root@100.90.24.83
  # open http://localhost:3020 as invoicewise-admin / NANGO_DASHBOARD_PASSWORD
  ```

  Create integrations under the `prod` environment; the integration keys and
  provider apps are listed in accounting-integrations.md.

Accessories are not touched by `kamal deploy`. Starting, upgrading (bump the
image tag in `config/deploy.yml`) or changing Nango's settings leaves the web
and api containers running:

```bash
infisical run --env prod -- kamal accessory boot nango-db     # first time only
infisical run --env prod -- kamal accessory boot nango        # first time
infisical run --env prod -- kamal accessory reboot nango      # after a config or image change
infisical run --env prod -- kamal accessory logs nango
curl -fsS https://nango.invoicewise.uk/health                 # {"result":"ok"}
```

A Nango API key change needs `kamal accessory reboot nango` and then an api
deploy (the key is shared). `NANGO_ENCRYPTION_KEY` must never change: stored
connections could no longer be decrypted and every workspace would have to
reconnect.

## Backups

`invoicewise-backup.timer` (03:40 UTC) runs `/usr/local/sbin/invoicewise-backup`
on hp-slice. It dumps both production databases (`invoicewise` from
`invoicewise-db`, `nango` from `invoicewise-nango-db`) in custom format to
`/var/backups/invoicewise` on the root NVMe disk, apart from the `/mnt/ssd`
disk that holds the live data. Each dump is checked with `pg_restore --list`,
checksummed (`.sha256`) and kept 30 days, the operating backup retention in
[data lifecycle](data-lifecycle.md#retention-schedule) (`RETAIN_DAYS`, from
`INVOICEWISE_BACKUP_RETAIN_DAYS`, default 30). The script and units live in
`ops/backup/`; install or update them with `ops/backup/install.sh`, which also
runs one backup. A retention change in the repository takes effect on the host
only once `install.sh` has run. Document files in `/mnt/ssd/invoicewise/storage` are not in
these dumps.

```bash
ssh root@100.90.24.83 'systemctl list-timers invoicewise-backup.timer; ls -lh /var/backups/invoicewise | tail'
ssh root@100.90.24.83 journalctl -u invoicewise-backup.service -n 20
```

Restore into a stopped application (stop the api role or the nango accessory
first), for example Nango:

```bash
ssh root@100.90.24.83 docker exec -i invoicewise-nango-db \
  pg_restore -U nango -d nango --clean --if-exists < nango-<stamp>.dump
```

## Rollback

```bash
infisical run --env prod -- kamal app containers     # lists deployed versions
infisical run --env prod -- kamal rollback <version>
infisical run --env prod -- kamal app version        # confirms the running version
curl -fsS https://api.invoicewise.uk/health/ready
```

Rollback swaps the `web` and `api` containers back to an earlier image (the
last five are retained on the host) through the same health-gated proxy
switch as a deploy; the api being replaced drains its workflow jobs back to
the queue. It does not undo migrations: the earlier release runs against the
newer schema, which is why migrations stay additive. When the earlier release
cannot run against the newer schema, recover forward (fix, commit, deploy)
instead. The drill is rehearsed on staging (below). Emergency stop:
`infisical run --env prod -- kamal app stop`.

## Logs

```bash
infisical run --env prod -- kamal app logs -r api        # API and workflow logs
infisical run --env prod -- kamal app logs -r web        # dashboard logs
infisical run --env prod -- kamal accessory logs db
```

Container logs rotate by size (`logging` in `config/deploy.yml`, 5 × 50 MB per
container). The logging options apply to a container when it is next created,
so the first deploy after a change picks them up. Size rotation does not
remove logs by time, so `invoicewise-logs-prune.timer` (04:20 UTC) runs
`/usr/local/sbin/invoicewise-logs-prune` on each Kamal host. It removes every
entry of the project's container logs older than 30 days (the operating
application-log retention in [data lifecycle](data-lifecycle.md#retention-schedule))
from rotated files, deleting one that has nothing left, and trims a stopped
container's current file. A running container's current file is not rewritten
from outside: Docker caches the open file's size, and editing it makes
`docker logs --tail` and `kamal app logs -f` read past the end; it is bounded
by `max-size` and trimmed when the container stops or its file rotates.
`INVOICEWISE_LOG_RETENTION_DAYS` on the host changes the window. The script and
units live in `ops/log-retention/`; install or update them on both hosts with
`ops/log-retention/install.sh`, which also runs one prune. A retention change
in the repository takes effect on the host only once `install.sh` has run.

```bash
ops/log-retention/install.sh root@100.90.24.83    # production (hp-slice)
ops/log-retention/install.sh root@31.97.116.107   # staging (hostinger)
ssh root@100.90.24.83 'systemctl list-timers invoicewise-logs-prune.timer; journalctl -u invoicewise-logs-prune.service -n 20'
```

## Tunnel and DNS

`/root/.cloudflared/config.yml` on hp-slice routes `app.invoicewise.uk` and
`api.invoicewise.uk` to `http://localhost:3010`, `nango.invoicewise.uk` to
`http://localhost:3020` (except `^/(api/v1|internal)(/|$)`, answered 404) and
`nango-connect.invoicewise.uk` to `http://localhost:3021`. Edit it, run
`cloudflared tunnel ingress validate` (and `cloudflared tunnel ingress rule
<url>` to check a path), then `systemctl restart cloudflared`; the tunnel
serves other sites too, so the restart briefly interrupts them. All four
hostnames are proxied CNAMEs to
`7a0344f4-eee4-4222-acc7-b884164dd249.cfargotunnel.com` in the `invoicewise.uk`
Cloudflare zone.

## Staging

Staging is the same image and topology as production on a different host with
its own data: `config/deploy.staging.yml` is merged over `config/deploy.yml`
(`kamal <command> -d staging`) and changes only what must differ.

- Host: hostinger (`31.97.116.107`, also on Tailscale as `100.115.84.97`),
  behind the shared kamal-proxy already running there (`127.0.0.1:18090`).
  Service `invoicewise-staging`: containers `invoicewise-staging-web-staging-<version>`
  and `…-api-staging-<version>`, accessories `invoicewise-staging-db`, `-redis`,
  `-nango-db` and `-nango`, all data under `/srv/invoicewise-staging`.
- Domains: `iw-staging-app.zzapp.uk` (dashboard) and
  `iw-staging-api.zzapp.uk` (API): proxied CNAMEs in the `zzapp.uk` zone to the remotely managed
  Cloudflare Tunnel `invoicewise-staging` (`322d1f96-…`), whose ingress (set in
  Cloudflare, not in this repo) sends both to the host's kamal-proxy at
  `127.0.0.1:18090` with a 404 catch-all. Its connector runs as the
  `cloudflared` accessory (host network) with `CLOUDFLARE_TUNNEL_TOKEN` from
  Infisical `staging`; TLS terminates at Cloudflare, as in production, on
  the free `*.zzapp.uk` edge certificate (hence single-level hostnames: it does
  not cover a deeper subdomain). Staging cookies are scoped to `.zzapp.uk`, a
  domain production does not share, so browsers never send a production
  session to staging or the reverse; the preflight refuses a staging cookie
  domain that covers `app.invoicewise.uk` or `api.invoicewise.uk`.
- Secrets: Infisical `staging`, all generated for staging (database, auth,
  signing, encryption, ops token, Nango) except the Purelymail sender password
  and the TypeSafe key, which are the same accounts as production. Staging's
  TypeSafe ceiling is 300 calls a day. Staging Nango is internal only:
  accounting connections are not exercised on staging. Staging has its own
  `INBOUND_EMAIL_SECRET` and the unrouted receiving domain
  `iw-staging-in.zzapp.uk`: no Email Worker points at it, so staging never
  receives real mail ([inbound email](inbound-email.md)).
- Data: synthetic only. The load-test account is a staging-only user; no
  production dump is ever restored here.

### Deploying staging

CI deploys every push to `main` (`.github/workflows/deploy-staging.yml`): the
GitHub `staging` environment only admits `main`, the job signs in to Infisical
with GitHub OIDC as `github-invoicewise-staging` (no project role; one
additional privilege to read the `staging` environment) and gets the deploy
SSH key (`KAMAL_SSH_KEY_B64`, authorised on hostinger as
`invoicewise-staging-ci`), deploys with Kamal building on hostinger, and then
checks readiness, the sign-in page and that `/ops/metrics` reports the pushed
commit. By hand, from a clean checkout:

```bash
infisical run --env staging -- kamal deploy -d staging
infisical run --env staging -- kamal accessory boot all -d staging   # first time only
```

### Drills

Run on staging, never on production:

```bash
# Load and hostile inputs (spends TypeSafe calls from the staging budget).
LOAD_EMAIL=… LOAD_PASSWORD=… OPS_TOKEN=… bun --no-env-file scripts/ops/load-test.ts \
  --app https://iw-staging-app.zzapp.uk --api https://iw-staging-api.zzapp.uk

# Worker interruption: SIGKILL the api container mid-extraction (no drain).
# `docker kill` counts as a manual stop, so the container stays down until
# started: the monitor mails api_unready, then RESOLVED once it is back and
# the orphaned jobs are reclaimed from their expired leases.
ssh root@31.97.116.107 'docker kill $(docker ps -qf name=invoicewise-staging-api-staging)'
ssh root@31.97.116.107 'docker start $(docker ps -aqf name=invoicewise-staging-api-staging --latest)'

# Rollback drill: back to the retained previous image, then forward again.
infisical run --env staging -- kamal app containers -d staging
infisical run --env staging -- kamal rollback <previous-version> -d staging
infisical run --env staging -- kamal rollback <current-version> -d staging
```

The test account's credentials are `LOAD_TEST_EMAIL`/`LOAD_TEST_PASSWORD` in
Infisical `staging`; the load test also accepts `--via http://127.0.0.1:<port>`
to reach the host's kamal-proxy through an SSH tunnel before DNS exists.

### Drill evidence (2026-09-25)

Run against builds of the change that introduced staging (the short hashes are
those staging builds, before the change was squashed onto `main`).

- **Rollback.** With `5218c127` live and `4dca8bd1` retained,
  `kamal rollback 4dca8bd1 -d staging` took 22 s and `kamal rollback 5218c127`
  23 s; `/ops/metrics` reported each version afterwards. A probe polling API
  readiness and the dashboard sign-in page every 0.5 s through both swaps saw
  147 of 147 samples answer 200.
- **Worker interruption.** Eight synthetic invoices were uploaded and the api
  container was SIGKILLed with four extractions running. Two jobs were left
  leased by the dead worker. The staging monitor mailed `api_unready`
  (critical) on its next pass; once the container was started the two jobs
  were reclaimed on their second attempt and succeeded, all eight invoices
  completed, and the next pass mailed the recovery.
- **Load and hostile inputs** (public URLs through Cloudflare, 30 distinct
  synthetic invoices at concurrency 10): all 30 accepted, upload p50 1.1 s and
  p95 1.2 s; the processing queue peaked at 18 due with the oldest waiting
  5 s, drained with no failures, extraction p50 4 s, API peak RSS 461 MiB of
  its 2 GiB limit, 90 TypeSafe calls (about 3 per invoice), no alerts. An
  oversized upload, an 8 MB chunked body with no length, PNG bytes declared as
  PDF, a truncated PDF, a 60-page PDF, a 20000 × 20000 PNG header and a HEIC
  photo were each refused with 400 or 413. The run found that the request
  after an unread oversized body could fail with a 502 through kamal-proxy's
  shared upstream connection; intake now closes the connection on those
  refusals, and a rerun on `3bdc7a82` (10 invoices plus every hostile input)
  passed with no failures.
- **Private storage.** Documents live on the host volume only; unsigned
  requests for a stored document's path are refused (401 from the API, 404
  from the dashboard proxy), and downloads go through signed capability URLs.

