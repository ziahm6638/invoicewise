# Delivery surfaces

InvoiceWise exposes processed invoice records through authenticated REST, a
read-only MCP server, signed webhooks, and CSV. All REST requests use the API
key's workspace; no delivery route accepts a workspace identifier from the
caller.

## REST and CSV

Create an API key in **Settings → Developer**, then send it as a bearer token:

```bash
export INVOICEWISE_API_KEY=mid_...
export INVOICEWISE_API_URL=https://api.invoicewise.uk

curl --fail --silent \
  -H "Authorization: Bearer $INVOICEWISE_API_KEY" \
  "$INVOICEWISE_API_URL/invoices?pageSize=20&status=pending"
```

Available read routes are:

| Route | Result |
| --- | --- |
| `GET /invoices` | Cursor-paginated invoices; supports `cursor`, `pageSize`, `status`, `q`, `sort`, and `order` |
| `GET /invoices/:id` | Extraction, line items, judgments, and a five-minute signed document URL |
| `GET /invoices/:id/delivery-status` | Webhook deliveries (logical event ID, revision, status, attempts, last error, whether a retry may succeed) plus the Nango accounting post status, provider ID, failure reason and retryability |
| `GET /invoices/export.csv` | Workspace invoices with a `judgment:<questionId>` column for every judgment |

An invoice outside the API key's workspace is returned as `404`, so the route
does not reveal whether another workspace owns that identifier.

`POST /invoices/:id/delivery/retry` (scope `inbox.write`) is the recovery
action for failed or cancelled destinations; see
[Processing-to-delivery handoff](#processing-to-delivery-handoff).

## MCP

The Effect MCP server exposes only three read-only tools:

- `list_invoices`
- `get_invoice`
- `get_invoice_judgments`

The server calls the REST API with `INVOICEWISE_API_KEY`, so authentication,
scopes, and workspace isolation are identical to direct REST access. Tool
arguments do not contain a workspace field, and the server exposes no mutation
tools.

Run it locally with:

```bash
cd apps/api
INVOICEWISE_API_URL=https://api.invoicewise.uk \
INVOICEWISE_API_KEY=mid_... \
bun run mcp
```

For an MCP client that supports stdio server configuration, point the client at
the repository's API workspace. For example:

```json
{
  "mcpServers": {
    "invoicewise": {
      "command": "bun",
      "args": ["run", "mcp"],
      "cwd": "/absolute/path/to/invoicewise/apps/api",
      "env": {
        "INVOICEWISE_API_URL": "https://api.invoicewise.uk",
        "INVOICEWISE_API_KEY": "mid_..."
      }
    }
  }
}
```

Keep the API key in the client's secret/environment configuration rather than
committing it to a shared config file.

## Webhooks

Register an endpoint with an API key that has `inbox.write`:

```bash
curl --fail --silent \
  -X POST \
  -H "Authorization: Bearer $INVOICEWISE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/invoicewise","events":["invoice.processed","invoice.judgments.attached","delivery.failed"]}' \
  "$INVOICEWISE_API_URL/webhooks"
```

The response returns the signing secret once. Store it as a secret. Endpoint
management routes are:

| Route | Required scope | Result |
| --- | --- | --- |
| `GET /webhooks` | `inbox.read` | Registered endpoints (never their secrets) |
| `POST /webhooks` | `inbox.write` | Registers an endpoint and returns its secret once |
| `GET /webhooks/:id/attempts` | `inbox.read` | Visible attempt history for that workspace endpoint |
| `DELETE /webhooks/:id` | `inbox.write` | Disables the endpoint |

InvoiceWise sends these headers with the exact JSON request body:

```text
invoicewise-event: invoice.processed
invoicewise-event-id: <logical event UUID, also the body's "id">
invoicewise-delivery: <delivery UUID>
invoicewise-signature: t=<unix-seconds>,v1=<hex HMAC-SHA256>
```

Delivery is at least once. A worker that dies after your endpoint answered but
before InvoiceWise recorded the answer sends the same request again, so
deduplicate on `invoicewise-event-id` (the body's `id`). The ID is derived
from the invoice, its processing `revision` (also in the body) and the event
type: it is the same on every endpoint and every redelivery, and a
reprocessed invoice gets a new revision and new event IDs.

Verify the signature by computing HMAC-SHA256 over
`<timestamp>.<exact-request-body>` with the endpoint secret, comparing the hex
digest in constant time, and rejecting old timestamps. The repository helper
`verifyWebhookSignature` uses a five-minute tolerance by default.

Webhook HTTP calls run only in the Postgres-backed Effect workflow runner. A
non-2xx response, redirect, or network error is retried four times with bounded
exponential backoff. Each HTTP attempt is stored before the job is retried. A
terminal failure marks the delivery failed and schedules `delivery.failed` for
other subscribed endpoints in the same transaction, so the notification cannot
be lost to a crash. Its event ID derives from the failed delivery and its
attempt count: replays of one failure deduplicate, and a delivery that fails
again after an explicit retry is a new event. Failures of that notification are
not emitted again, so failure events cannot recurse. Slow or unavailable
customer endpoints therefore do not block invoice processing.

## Processing-to-delivery handoff

Every accepted invoice revision reaches each destination the workspace had
configured when it completed, or ends in a visible terminal state.

- **One transaction.** The processing result, the next `processing_revision`
  and one durable intent per destination (a `webhook_deliveries` row per
  subscribed active endpoint and event, and the invoice's accounting post) are
  written together with the workflow jobs that carry them out
  (`completeInvoiceProcessing` in `packages/jobs/src/delivery.ts`). If any
  enqueue fails, all of it rolls back and the processing job retries; after
  the commit no destination can be lost. Only a record still in `processing`
  can complete, so two workers racing on one document produce one revision.
- **Stable identities.** Delivery jobs are keyed by logical event and endpoint,
  accounting jobs by invoice revision, and bills by one provider idempotency
  key per invoice, so retries, replays and expired leases converge on one
  delivery row per endpoint and event and one bill per invoice.
- **Resume.** Extraction and delivery are tracked separately. A replayed
  processing job for an already extracted invoice re-drives its incomplete
  deliveries instead of returning early, and the runner reconciles every
  `WORKFLOW_RECONCILE_MS` (default 60s): an intent whose job is missing is
  enqueued again under its original key, and one whose job failed without
  recording an outcome becomes a visible, retryable failure. That failure is
  recorded only while the job is still failed, so it never overrides an
  explicit retry that restarted the job in the meantime.
- **Removed destinations.** Work queued before an endpoint was disabled, the
  accounting connection was disconnected or the invoice was deleted is
  cancelled with the reason and is never sent. Deleting a workspace removes its
  queued deliveries and jobs. A retry never recreates or re-enables a removed
  destination, and a revision completed afterwards schedules only the current
  destinations.
- **Outcomes.** Each webhook delivery and the accounting post end `succeeded`
  (`posted`/`already_posted`), `failed` or `cancelled`. A failure records
  whether a retry may succeed (exhausted retries, provider outage) or needs a
  configuration change (a rejected URL or request). A failing destination
  does not affect the others.
- **Recovery.** The invoice's **Delivery** panel in the dashboard, tRPC
  `inbox.retryDelivery`, and `POST /invoices/:id/delivery/retry` re-drive the
  failed or cancelled destinations of the current revision on the same
  delivery rows and event IDs, skipping endpoints that are disabled and
  accounting when no connection is active. Re-driving webhooks is open to
  every workspace role; re-posting to the accounting provider needs the admin
  role, as `POST /accounting/invoices/:id/retry` does, and for a member the
  accounting intent is left unchanged and reported as `admin_required` (see
  [permissions](permissions.md)). A retry cannot change which destinations
  exist.
- **Delivered state.** The dashboard shows *Delivering*, *Delivered* or
  *Delivery failed* from the current revision's destination outcomes: any
  failure is *Delivery failed*, any queued work is *Delivering*, and
  *Delivered* needs at least one successful destination with the rest
  succeeded or cancelled. The legacy `done` inbox status plays no part.

### Fault-injection proof

`bun run verify:handoff` in `packages/jobs` (part of `bun run verify`) runs
real worker processes against the verification database. Test-only triggers
fail a write inside the completion transaction or park a worker right before it
records an outcome, where the verifier SIGKILLs it and starts a fresh worker.
It covers: an enqueue failure in the completion transaction; a crash after the
completion commit with one destination's job lost; a crash after a webhook
endpoint answered 2xx; a crash after the provider created a bill; concurrent
completion and two concurrent workers; a lost job and an unrecorded final
failure; a first destination succeeding while the second fails, then the retry;
and a disabled endpoint, a disconnected accounting connection, a deleted
invoice and a deleted workspace. It then reconciles every accepted revision
against the events the consumer received and the bills the provider created.
Observed on 2026-09-24:

```text
save-before-event:        revision=0, deliveries scheduled=0, processing job queued for retry
crash after commit:       revision=1 after restart, 3/3 webhooks succeeded, accounting posted
webhook remote success:   same delivery received twice with one logical event ID
bill remote success:      2 provider requests, 1 bill, status already_posted
second destination fails: attempts=4, retryable, dashboard "failed"; retry re-drove only it -> "delivered"
removed destinations:     disabled endpoint/disconnected accounting/deleted invoice cancelled, retry skipped them
reconciliation:           9 accepted revisions, 17 distinct logical events, 1 deduplicable redelivery, 6 bills, 0 silent losses
```

## Local proof

With the local services and API running, the repeatable proof command creates
two temporary workspaces, creates their API keys through the product API-key
query, and removes its records when it finishes:

```bash
docker compose up -d --wait postgres redis minio
DATABASE_PRIMARY_URL=postgresql://invoicewise:invoicewise@localhost:5432/invoicewise \
  bun --cwd packages/db run migrate

PORT=3313 STORAGE_PUBLIC_URL=http://localhost:3313 \
WORKFLOW_POLL_MS=50 WORKFLOW_RETRY_BASE_MS=100 WORKFLOW_RETRY_MAX_MS=400 \
  bun --env-file=apps/api/.env-template apps/api/src/index.ts

cd apps/api
INVOICEWISE_API_URL=http://localhost:3313 \
  bun --env-file=.env-template run verify:delivery
```

Observed on 2026-09-22:

```text
REST list/detail:        200, listed=true, extraction=true, lineItems=1, signed URL=true
Other workspace reads:   invoice=404, webhook attempts=404
Webhook registration:    201
Webhook signature:       valid
Failed endpoint attempts:[1, 2, 3, 4]
CSV:                     200, judgment:duplicate column present
MCP tool call:           isError=false, duplicate judgment answer=false
```

The command prints the full JSON evidence, including the actual CSV header and
row, webhook retry error, and MCP structured content.
