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
| Dashboard | `app.invoicewise.uk` | `iw-staging-app.zzapp.uk` |
| API and workflow runner | `api.invoicewise.uk` | `iw-staging-api.zzapp.uk` |
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
| Intake latency, text PDF (accepted → processed) | p95 under 60 s | `latency.intake.text`, `intake_latency:text` alert |
| Intake latency, scanned PDF or image (accepted → processed) | p95 under 3 min | `latency.intake.scan`, `intake_latency:scan` alert |
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
| Workflow jobs running at once | 4 per runner; a slot is refilled as soon as its job finishes, so a long job never holds new work queued | `WORKFLOW_CONCURRENCY` |
| PDF/OCR child processes | 2 running + 8 queued (previews 1 + 4), 320 MB RSS each | `IW_PDF_*`, [document-intake.md#limits](document-intake.md#limits) |
| Upload size and shape | 5 MB, 50 pages, 25 MP images | [document-intake.md#limits](document-intake.md#limits) |
| Queued document processing | 200 per workspace, 1000 in total; beyond that intake answers `429 queue_full` with `Retry-After` | `INTAKE_MAX_PENDING_PER_WORKSPACE`, `INTAKE_MAX_PENDING_TOTAL` |
| Authenticated API requests | 100 per user per 10 min | `apps/api/src/rest/middleware` |
| TypeSafe calls | 2000 per UTC day in production, 300 in staging; when spent, document processing, question reruns and source matching stay queued until 00:00 UTC while every other workflow runs, and question previews and new reruns are refused | `TYPESAFE_DAILY_CALL_LIMIT` |
| Question previews and reruns | 5 invoices per preview (45 s), 25 per rerun, one rerun per question at a time, 20 enabled custom questions per workspace | [document-intake.md#questions](document-intake.md#questions) |
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
| `GET /ops/metrics` | no: `Authorization: Bearer $OPS_TOKEN`, 404 when no token is configured | queue depth and age per workflow, failures and retries, stuck leases, intake latency by input kind (text PDF, scan) with stage p95s, intake-to-delivery latency, provider calls/failures/rate limits/latency/tokens, budget, database size and pool, Redis, storage free space, API memory, version, and the alerts they raise |

Public responses never include pools, timings, hostnames, credentials or
dependency errors. The inherited `/health/db` and `/health/pools` are gone.

```bash
curl -fsS -H "Authorization: Bearer $OPS_TOKEN" https://api.invoicewise.uk/ops/metrics | jq
```

## Recovery

Routine diagnosis and recovery go through the operator routes and the
customer's own recovery actions; none of the incidents below needs a manual
database change. The routes sit beside `/ops/metrics`
(`apps/api/src/ops/recovery.ts`) and hold the same line:

- **Operator authority is separate from customer roles.** Only
  `Authorization: Bearer $OPS_TOKEN` is accepted (a session, API key or OAuth
  token gets `401`), and without a configured token the routes do not exist.
  Every request names its operator in `X-Operator` (`400` without it), which
  the audit trail records. The token is the authority; the name is declared,
  not authenticated: anyone holding the shared token can send any name. Each
  operator audit record and log line therefore also carries
  `tokenFingerprint`, the first 8 hex characters of the token's SHA-256, so a
  record can be tied to the credential that made it (and a rotated token
  tells old records from new). Per-operator credentials are a follow-up.
- **Purpose-bound.** An action (retry, cancel) or any read of a workspace's
  records states a `purpose` (`incident`, `support` or `security`) and a
  `reason` (5 to 200 characters), and is written to that workspace's
  [audit trail](#audit-trail) before anything else happens, where its owners
  and admins see who acted, why and with what result. Impersonating a
  customer is not supported: operators never act as a member.
- **Minimal data.** Job views carry identifiers (the invoice, delivery,
  correction, message or export a job is about), status, attempts, times and
  the redacted error, never the job's payload. The invoice trace an operator
  reads shows actor ids instead of names and no sender address.

| Route | Result |
| --- | --- |
| `GET /ops/jobs?filter=stuck\|overdue\|failed\|queued\|running[&workflow=][&teamId=][&overdueMinutes=15][&limit=]` | Jobs newest first. `stuck`: running with an expired lease (its worker died); `overdue`: queued and due for longer than `overdueMinutes` |
| `GET /ops/jobs/:id` | One job |
| `POST /ops/jobs/:id/retry` `{"purpose","reason"}` | `202` re-driven through the workflow's own recovery path (below); `409` when the job is not failed or a newer job of the same record exists; `422` with the action that recovers a workflow operators do not retry |
| `POST /ops/jobs/:id/cancel` `{"purpose","reason"}` | `202` a queued job, or a running one whose lease expired, is recorded failed ("Cancelled by an operator: …"); the reconcilers then settle its record as a visible, retryable failure the customer can act on. `409` for a job a live worker holds or that already finished |
| `GET /ops/invoices/:id/activity?purpose=&reason=` | The invoice's [activity trace](delivery.md#activity-trace), recorded as an operator access in its workspace |
| `GET /ops/audit[?teamId=][&limit=]` | Operator actions and accesses, newest first |

A retry never restarts a job blindly. It uses the path a customer's own
action uses, so the invoice, delivery row or message moves with it and every
idempotency key still holds:

| Workflow | Operator retry |
| --- | --- |
| `process-attachment` | Re-extract the invoice (a new processing job) |
| `rerun-judgments` | Rerun the questions for the same revision; refused once the invoice has moved on |
| `deliver-webhook` | Redeliver the same delivery and logical event ID |
| `post-accounting-draft`, `update-accounting-bill` | Retry the invoice's failed destinations, including the accounting post or bill update, on the operator's authority |
| `match-invoice` | Match the invoice's current revision again under its own key; a person's confirm, link or unlink is kept, and a job of an older revision is refused |
| `process-inbound-email` | Re-open the failed message from its kept MIME source and process it again |
| `purge-deleted-data` | Resume that deletion request |
| others | Refused with the recovering action: the owner requests a new export, an admin resends an invitation or syncs a mailbox, retention runs hourly by itself |

Runbook:

```bash
# workflow_stuck:<workflow> — a worker died holding jobs.
curl -fsS -H "Authorization: Bearer $OPS_TOKEN" -H "X-Operator: zishan" \
  "https://api.invoicewise.uk/ops/jobs?filter=stuck" | jq '.data[] | {id, workflow, lockedBy, leaseExpiresAt}'
# A running API container reclaims expired leases on its next poll; if none
# is running, boot it: infisical run --env prod -- kamal app boot -r api
# (kamal app logs -r api for why it stopped). Stuck rows then read queued
# or running again. A job that must not run is cancelled instead:
curl -fsS -X POST -H "Authorization: Bearer $OPS_TOKEN" -H "X-Operator: zishan" \
  -H "content-type: application/json" -d '{"purpose":"incident","reason":"Poison job looping on retries"}' \
  "https://api.invoicewise.uk/ops/jobs/<id>/cancel"

# workflow_failures:<workflow> — fix the cause (provider outage, config),
# then retry the failed jobs one by one, newest first:
curl -fsS -H "Authorization: Bearer $OPS_TOKEN" -H "X-Operator: zishan" \
  "https://api.invoicewise.uk/ops/jobs?filter=failed&workflow=process-attachment" | jq -r '.data[].id'
curl -fsS -X POST -H "Authorization: Bearer $OPS_TOKEN" -H "X-Operator: zishan" \
  -H "content-type: application/json" -d '{"purpose":"incident","reason":"TypeSafe outage resolved"}' \
  "https://api.invoicewise.uk/ops/jobs/<id>/retry"

# A customer asks why an invoice is stuck (support ticket):
curl -fsS -H "Authorization: Bearer $OPS_TOKEN" -H "X-Operator: zishan" \
  "https://api.invoicewise.uk/ops/invoices/<invoice>/activity?purpose=support&reason=Ticket%204411" | jq '.entries'
```

Customers recover their own invoices without an operator: **Re-extract**,
**Rerun questions** and **Retry delivery** on the invoice, and **Redeliver**
on a webhook delivery ([delivery](delivery.md#corrections-reprocessing-and-retries)).
`bun jobs:status` still lists the queue from a shell on the host.

The runnable proof is `src/activity.http.integration.test.ts` in `apps/api`
(`verify:activity-recovery-http` in `bun run test:legacy`): a worker is killed
mid-job, a fresh runner reclaims it, a provider outage exhausts its attempts,
customer credentials and bad operator requests are refused, an operator reads
the trace for a stated purpose and retries the job, the invoice is delivered,
a queued job is cancelled and redelivered by the customer, and the timeline
and audit trail are checked end to end, with no secret or bank detail on any
surface.

## Audit trail

`audit_events` records who did what in a workspace: actor (member, API key,
OAuth application or operator, with the credential id), workspace, action,
the record and invoice revision it acted on, time and outcome (`succeeded`,
`refused`, `denied` for a role or scope refusal, `failed`). An action is
written as `started` before it runs and refused if that write fails, so
nothing audited runs unrecorded; one whose process died mid-way stays
`started` ("outcome unknown").

- **What is recorded.** Every dashboard mutation (`TRPC_AUDIT` in
  `apps/api/src/trpc/audit.ts`; a test fails when a new mutation is neither
  listed nor excluded with a reason) and every REST write to a workspace
  route, including the `/v1` public API (`apps/api/src/rest/middleware/audit.ts`; an unlisted route is
  recorded as `api.request`): field corrections, re-extraction, question
  reruns and question changes, supplier and authorization-source changes,
  invoice-to-source match decisions (confirm, link, unlink),
  delivery-rule changes and releasing or dismissing a held delivery,
  webhooks, accounting, mailboxes, the receiving address, OAuth applications
  and grants, API keys, invitations, membership and roles, workspace
  settings, data exports and delivery retries and redeliveries. Operator
  actions and accesses are recorded by the operator routes.
- **What is not.** Values: a correction records field names, the values stay
  in the invoice's correction history; an invitation records roles and a
  count, not addresses; a webhook records its origin, not its path or query.
  Details are bounded and redacted (`sanitizeAuditDetail`).
- **Who reads it.** Owners and admins, under **Settings → Audit log**
  (`audit.list`); every member sees the actions on an invoice in its
  **Activity**; operators read operator actions (`/ops/audit`). The owner's
  data export includes it in `audit.json`.
- **How long.** 365 days (`RETENTION_AUDIT_EVENT_DAYS`), removed by the hourly
  retention job; deleting a workspace removes its trail with it
  ([data lifecycle](data-lifecycle.md#retention-schedule)).

## Logs

Operational logs carry event names, identifiers, workflow names, counts and
redacted error reasons; never document contents, extracted values, bank
details, tokens or webhook secrets. Errors are redacted before they are
stored on a job (`workflow_jobs.last_error`) or logged, and again on every
operator and customer surface: `redactOperationalText`
(`packages/db/src/utils/redact.ts`) masks bearer and basic credentials,
InvoiceWise keys and tokens, webhook signing secrets, provider keys, JWTs, URL
credentials and secret query parameters, IBANs, sort codes, named account
numbers and card numbers, and bounds the text to 500 characters. The shared
pino logger censors credential fields by name. Retention of the logs
themselves is in [data lifecycle](data-lifecycle.md#retention-schedule).

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
| `workflow_stuck:<workflow>` | critical | a lease expired and nothing reclaimed it: is the api container running? `GET /ops/jobs?filter=stuck` ([recovery](#recovery)) |
| `queue_age:<workflow>` | warning | backlog: runner errors in the logs, provider outage, or the TypeSafe budget is spent |
| `workflow_failures:<workflow>` | warning | `GET /ops/jobs?filter=failed&workflow=…` for the error; fix, then `POST /ops/jobs/:id/retry` ([recovery](#recovery)) |
| `intake_latency:text`, `intake_latency:scan` | warning | intake p95 over its target; the summary names each stage's p95 (queue, text/OCR, TypeSafe, save). Queue: runner errors, `queue_age`, a stopped runner or a spent budget; TypeSafe: `providers`; a document that failed and was retried counts from its original acceptance |
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
