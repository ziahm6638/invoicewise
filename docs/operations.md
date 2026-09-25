# Operations

How InvoiceWise is run: who owns it, where it runs, the service and load
targets it is held to, the capacity and spend ceilings that bound it, the
alerts that reach the operator, and how releases drain, recover and roll back.
Deploy commands and secrets are in [deployment.md](deployment.md).

## Owner

The operator is the repository owner. Alerts and the daily status mail go to
the address in Infisical `OPS_ALERT_TO` (same value in `prod` and `staging`).
The operator alone authorises infrastructure spending (new hosts, paid
services, a higher provider budget) and each production release; staging
deploys automatically from `main`.

## Topology

| | Production | Staging |
| --- | --- | --- |
| Dashboard | `app.invoicewise.uk` | `staging.invoicewise.uk` |
| API and workflow runner | `api.invoicewise.uk` | `api-staging.invoicewise.uk` |
| Host | hp-slice (UK, 4 cores, 15 GiB) | hostinger (EU VPS, 8 cores, 31 GiB) |
| Edge and TLS | Cloudflare Tunnel (locally managed) on hp-slice | Cloudflare Tunnel `invoicewise-staging` (remotely managed), connector as a Kamal accessory |
| Postgres 17, Redis 7, Nango | Kamal accessories on hp-slice | Kamal accessories on hostinger, own data under `/srv/invoicewise-staging` |
| Documents | private local volume `/mnt/ssd/invoicewise/storage` | private local volume `/srv/invoicewise-staging/storage` |
| Secrets | Infisical `invoicewise` / `prod` | Infisical `invoicewise` / `staging` |
| Mail | Purelymail SMTP as `auth@invoicewise.uk` | same sender, "InvoiceWise Staging" |
| Deployed by | the operator, `kamal deploy` | CI on every push to `main` |
| Monitored from | hostinger (a different host) | hostinger |

The marketing site `invoicewise.uk` is a separate Vercel project. Document
storage is a private filesystem volume, never publicly served: downloads go
through signed, expiring capability URLs on the API. The S3-compatible
adapter (R2, MinIO) is supported by configuration (`STORAGE_BACKEND=s3`) but
not adopted, because it would be a new paid service. Staging holds synthetic
data only; it never receives production data or customer mailboxes.

## Service and load targets

Initial targets for one production host. They are what alerts and the load
test measure; revisit them with real traffic.

| Target | Value | Measured by |
| --- | --- | --- |
| Availability (dashboard and API) | 99.5% per month | `api_unready`, `app_unavailable` alerts |
| Upload response (≤ 5 MB) | p95 under 3 s | load test |
| Intake latency (accepted → extracted) | p95 under 10 min | `latency.extraction`, `intake_latency` alert |
| Queue wait | oldest due job under 15 min | `queue_age` alert |
| Intake → delivery (webhook or accounting draft) | p95 under 15 min | `latency.delivery` in `/ops/metrics` |
| Sustained volume | 500 invoices per day | `budget.typesafe`, daily status |
| Burst | 30 concurrent uploads without a 5xx other than load-shedding 503 | load test |
| Recovery | RPO 24 h (nightly dumps), RTO 4 h | [deployment.md#backups](deployment.md#backups) |

## Capacity and spend ceilings

Every resource a burst can grow is bounded; beyond each bound work is shed or
waits, it never grows memory or spend without limit.

| Resource | Ceiling | Where |
| --- | --- | --- |
| API container memory (API, runner, PDF/OCR children) | 2 GiB hard limit | `config/deploy.yml` `options.memory` |
| Dashboard container memory | 1 GiB hard limit | same |
| Database connections | 8 per pool; api has 3 pools, web 1 (≤ 32 of 100) | `DATABASE_POOL_MAX` |
| Redis connections | one per cache namespace per process (≤ 6) | `packages/cache` |
| Workflow jobs running at once | 4 per runner | `WORKFLOW_CONCURRENCY` |
| PDF/OCR child processes | 2 running + 8 queued (previews 1 + 4), 320 MB RSS each | `IW_PDF_*`, [document-intake.md#limits](document-intake.md#limits) |
| Upload size and shape | 5 MB, 50 pages, 25 MP images | [document-intake.md#limits](document-intake.md#limits) |
| Queued document processing | 200 per workspace, 1000 in total; beyond that intake answers `429 queue_full` with `Retry-After` | `INTAKE_MAX_PENDING_PER_WORKSPACE`, `INTAKE_MAX_PENDING_TOTAL` |
| Authenticated API requests | 100 per user per 10 min | `apps/api/src/rest/middleware` |
| TypeSafe calls | 2000 per UTC day in production, 300 in staging; when spent, document processing stays queued until 00:00 UTC while every other workflow runs | `TYPESAFE_DAILY_CALL_LIMIT` |
| Infrastructure cost | £0 above the existing hosts, Cloudflare free plan and Purelymail account | operator authorisation for anything more |

TypeSafe spend is metered per call into `provider_usage` (calls, failures,
rate limits, tokens, latency; never content). `/ops/metrics` reports calls and
tokens today; set `TYPESAFE_GBP_PER_MILLION_INPUT_TOKENS` and
`..._OUTPUT_TOKENS` on the api role to also report an estimated sterling cost.
The daily call ceiling is the hard spend bound; raising it is an operator
decision.

## Health and diagnostics

| Path | Public | Answers |
| --- | --- | --- |
| `GET /health/live` | yes | `{"status":"ok"}` while the process serves; touches nothing |
| `GET /health`, `GET /health/ready` | yes | `{"status":"ok"}` (200) or `{"status":"unavailable"}` (503): the database answers within 3 s. kamal-proxy gates traffic on it |
| `GET /ops/metrics` | no: `Authorization: Bearer $OPS_TOKEN`, 404 when no token is configured | queue depth and age per workflow, failures and retries, stuck leases, intake and intake-to-delivery latency, provider calls/failures/rate limits/latency/tokens, budget, database size and pool, Redis, storage free space, API memory, version, and the alerts they raise |

Public responses never include pools, timings, hostnames, credentials or
dependency errors. The inherited `/health/db` and `/health/pools` are gone.

```bash
curl -fsS -H "Authorization: Bearer $OPS_TOKEN" https://api.invoicewise.uk/ops/metrics | jq
```

## Alerts

`ops/monitor/invoicewise-monitor` runs every two minutes per environment
(`invoicewise-monitor@production.timer`, `@staging.timer`) on hostinger, so an
hp-slice outage still alerts. Each pass checks public readiness and the
sign-in page, then reads the alerts the API computes (thresholds in
`apps/api/src/ops/alerts.ts`, each overridable with `OPS_ALERT_*`). It mails
the operator through Purelymail when an alert starts, changes severity,
is still firing after 6 hours, or resolves, and sends a daily status after
08:00 UTC; a missing daily status means the monitor or hostinger is down.
Mail carries alert keys, workflow and provider names and numbers only, never
invoice contents, file names or workspace names.

| Alert | Severity | First action |
| --- | --- | --- |
| `api_unready` | critical | `kamal app logs -r api`; `kamal accessory logs db`; is the host up? |
| `app_unavailable` | critical | `kamal app logs -r web` |
| `metrics_unavailable` | warning | API up but a dependency failed mid-query: API logs (`ops_metrics_failed`) |
| `workflow_stuck:<workflow>` | critical | a lease expired and nothing reclaimed it: is the api container running? `bun jobs:status` |
| `queue_age:<workflow>` | warning | backlog: runner errors in the logs, provider outage, or the TypeSafe budget is spent |
| `workflow_failures:<workflow>` | warning | `bun jobs:status` for the error; fix, then retry from the inbox |
| `intake_latency` | warning | extraction p95 over target: provider latency (`providers`) or queue age |
| `provider_throttled:<provider>/<op>`, `provider_errors:…` | warning | provider status page; failures retry with backoff |
| `provider_budget:typesafe` | warning at 80%, critical when spent | expected volume, or runaway intake? Raising the ceiling is an operator decision |
| `storage_capacity` | warning at 15% free, critical at 5% | prune old backups, grow the volume |
| `database_size` | warning at 20 GiB | review retention |
| `database_pool` | warning | requests waiting for a connection: slow queries or a pool too small |
| `cache_unavailable` | warning | `kamal accessory logs redis` |
| `api_memory` | warning at 1.6 GB of the 2 GiB limit | look for a leak before the kernel kills the container |

Install or update a monitor (reads the token, SMTP password and operator
address from Infisical; nothing is printed):

```bash
ops/monitor/install.sh production
ops/monitor/install.sh staging
ssh root@31.97.116.107 'systemctl list-timers "invoicewise-monitor@*"; journalctl -u invoicewise-monitor@production -n 20'
```

## Deploys

- **Immutable, versioned builds.** Each deploy builds one image tagged with
  the git commit (deploy from a clean checkout: a dirty tree gets an
  `_uncommitted_` version); the
  running version is `kamal app version` and `/ops/metrics` `version`.
  Staging and production images differ only in the compiled public origins.
- **Migration gate.** The api entrypoint runs the startup preflight, then
  applies pending migrations in one transaction before it serves. A failed
  migration or preflight exits the container, the health check never passes,
  and kamal-proxy keeps the previous release. Migrations stay additive so the
  previous release can run against the newer schema.
- **Drain.** kamal-proxy stops routing to the old container and waits up to
  `drain_timeout` (30 s) for in-flight requests. On `SIGTERM` the workflow
  runner hands every job it holds back to the queue without spending an
  attempt (`workflow_run_released` in the log), so the new release claims it
  immediately.
- **Lease recovery.** A runner that dies without draining (killed, OOM, host
  crash) leaves its jobs leased for at most two minutes; the next runner
  reclaims them, and a job whose final attempt expired is marked failed. The
  `workflow_stuck` alert fires if nothing reclaims them.
- **Rollback.** `kamal rollback <version>` swaps web and api back to a
  retained image (the last 5 are kept). It does not undo migrations. When a
  release cannot be rolled back (a migration the previous version cannot run
  against), recovery is forward: fix, commit, deploy.

## Drills and evidence

Staging is where the drills run: the rollback drill, the worker interruption
and the load test. The latest results are recorded in
[deployment.md#staging](deployment.md#staging).
