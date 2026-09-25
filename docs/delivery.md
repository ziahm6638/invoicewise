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
| `GET /invoices/:id` | Extraction (with per-value evidence), validation, line items, judgments, and a five-minute signed document URL |
| `GET /invoices/:id/delivery-status` | Webhook deliveries (logical event ID, revision, status, attempts, last error, whether a retry may succeed) plus the Nango accounting post status, provider ID, failure reason and retryability |
| `GET /invoices/export.csv` | Workspace invoices with document type, validation status, accounting readiness and issues, and a `judgment:<questionId>` column for every judgment |

An invoice outside the API key's workspace is returned as `404`, so the route
does not reveal whether another workspace owns that identifier.

Every invoice read, the `invoice.processed` webhook payload and MCP
`get_invoice` carry `validation`: the deterministic checks, issues, canonical
totals with their currencies, duplicate and credit-note identity, and
`accounting.ready` with its blockers. See
[Validation](document-intake.md#validation).

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

Owners and admins manage endpoints in **Settings → Webhooks** without any
tooling: add an HTTPS endpoint and choose its events, copy the signing secret
(shown once), send a test event, rotate the secret, open **Deliveries** to see
each event's status, attempts, HTTP results and errors, redeliver a failed
event, and disable the endpoint. The same operations are available over REST
with an API key; every route is scoped to the key's workspace, and an endpoint
or delivery of another workspace is `404`.

```bash
curl --fail --silent \
  -X POST \
  -H "Authorization: Bearer $INVOICEWISE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/invoicewise","events":["invoice.processed","invoice.judgments.attached","delivery.failed"]}' \
  "$INVOICEWISE_API_URL/webhooks"
```

| Route | Required scope and role | Result |
| --- | --- | --- |
| `GET /webhooks` | `inbox.read` | Endpoints with events, state, last rotation and the previous secret's expiry (never a secret) |
| `POST /webhooks` | `inbox.write`, admin | Registers an endpoint and returns its secret once; `400` for a refused destination, `409` for an active duplicate URL or more than 20 active endpoints. Registering a disabled endpoint's URL enables it again with a new secret |
| `GET /webhooks/:id/deliveries` | `inbox.read` | The 50 most recent deliveries: event, logical event ID, invoice and revision, status, attempts, last error and whether a retry may succeed |
| `GET /webhooks/:id/attempts[?deliveryId=]` | `inbox.read` | HTTP attempts (status code, error, duration), newest first, at most 200 |
| `POST /webhooks/:id/test` | `inbox.write`, admin | Queues a `webhook.test` event to that endpoint (`202`) |
| `POST /webhooks/:id/rotate-secret` | `inbox.write`, admin | Returns a new secret once; body `{"revokePrevious": true}` ends the old one immediately |
| `POST /webhooks/:id/deliveries/:deliveryId/redeliver` | `inbox.write`, admin | Re-sends one failed delivery (`202`); `409` if it is not failed or the endpoint is disabled, `410` once retention removed its payload |
| `DELETE /webhooks/:id` | `inbox.write`, admin | Disables the endpoint; its queued deliveries are cancelled |

### Events and payloads

Events are `invoice.processed`, `invoice.judgments.attached` and
`delivery.failed`, plus `webhook.test`, which is sent only when requested and
regardless of the endpoint's subscriptions. Every body is a versioned
envelope:

```json
{
  "id": "<logical event ID>",
  "type": "invoice.processed",
  "version": 1,
  "createdAt": "2026-09-25T10:00:00.000Z",
  "teamId": "<workspace ID>",
  "invoiceId": "<invoice ID>",
  "revision": 3,
  "data": { "...": "the processed invoice record" }
}
```

`version` (also the `invoicewise-webhook-version` header) changes only for a
breaking payload change. `invoiceId` and `revision` identify the exact invoice
revision the event describes; a reprocessed invoice is a new revision with
new event IDs. Payloads never contain a document link, because signed
document URLs expire after five minutes and a queued or redelivered event can
arrive later than that. To read the document, call `GET /invoices/:invoiceId`
with your API key when you handle the event: it returns the current record and
a fresh signed `documentUrl`. The retention job empties the stored payload of a
finished delivery after 30 days ([data lifecycle](data-lifecycle.md)); such an
event can no longer be redelivered, and the invoice is read over REST instead.

### Signatures, rotation and replay

InvoiceWise sends these headers with the exact JSON request body:

```text
invoicewise-event: invoice.processed
invoicewise-event-id: <logical event UUID, also the body's "id">
invoicewise-delivery: <delivery UUID>
invoicewise-webhook-version: 1
invoicewise-signature: t=<unix-seconds>,v1=<hex HMAC-SHA256>[,v1=<hex>]
```

Verify by computing HMAC-SHA256 over `<timestamp>.<exact-request-body>` with
the endpoint secret, comparing it in constant time with each `v1` value, and
rejecting timestamps outside your tolerance to block replays. The repository
helper `verifyWebhookSignature` accepts any matching `v1` and uses a
five-minute tolerance by default.

Rotating a secret returns the new one once. For the next 24 hours each
delivery carries two `v1` signatures, one per secret, so a consumer verifying
with either the old or the new secret keeps accepting events while it deploys
the new one; `previousSecretExpiresAt` on the endpoint shows when the overlap
ends. Rotating again during an overlap replaces the previous secret with the
one being rotated out, and the older one stops signing at once. For a leaked
secret, rotate with `revokePrevious` (or tick **Stop signing with the previous
secret now** in the dashboard) so only the new secret signs.

### Delivery semantics and recovery

Delivery is at least once. A worker that dies after your endpoint answered but
before InvoiceWise recorded the answer sends the same request again, and an
explicit redelivery re-sends an event you may already have processed, so
deduplicate on `invoicewise-event-id` (the body's `id`). The ID is derived
from the invoice, its processing `revision` and the event type: it is the same
on every endpoint, every retry and every redelivery.

Only a `2xx` answer is a success. A non-`2xx` response (including a redirect,
which is never followed), a timeout or a network error is retried: four
attempts per delivery with bounded exponential backoff, each stored before the
next. The last failed attempt marks the delivery failed and schedules
`delivery.failed` to the workspace's other subscribed endpoints in the same
transaction, so the notification cannot be lost to a crash. Its event ID
derives from the failed delivery and its attempt count: replays of one failure
deduplicate, and a delivery that fails again after a redelivery is a new
event. A failed `delivery.failed` notification or test event announces
nothing, so failures cannot cascade into a storm.

Recovery is explicit. **Redeliver** on a failed delivery (or the redeliver
route) re-queues the same delivery row and event ID for four more attempts,
continuing its attempt history; delivered, in-flight and cancelled deliveries
and disabled endpoints are refused. The invoice's **Delivery** panel retries
every failed destination of its current revision at once (see below).

### Outbound request safety

Every webhook request goes through one transport (`packages/jobs/src/egress.ts`):

- **Destination policy.** The URL must be `https`, without credentials, and
  its host must not be a private, loopback, link-local, carrier-grade NAT,
  multicast, documentation or other reserved IPv4 or IPv6 address, including
  IPv4-mapped, NAT64 and 6to4 forms of them, cloud metadata addresses
  (`169.254.169.254`, `fd00:ec2::254`) and local names (`localhost`, `.local`,
  `.internal`, single-label hosts). Registration resolves the hostname and
  refuses it if any address it resolves to is not public, so a
  public-looking name pointing at a private address is rejected up front.
- **Checked on every connection.** Each attempt resolves the name again,
  requires every address to be public and connects only to those validated
  addresses (IPv4 first; the next is tried only when a connection cannot be
  opened, before any request bytes are sent), so a DNS answer that changes after registration (rebinding) is
  refused before any connection. TLS still verifies the certificate against
  the hostname. Requests are written on that socket directly, so proxy
  environment variables, redirects and connection pools cannot send them
  elsewhere.
- **Bounded.** One 10-second deadline covers resolution, connection, request
  and response. Only the status line and headers are read, up to 16 KiB; the
  response body is never read and the connection is closed as soon as the
  status is known. A workspace has at most 20 active endpoints, and at
  most half of the workflow runner's slots (at least one) deliver webhooks at
  once, so slow or hostile endpoints cannot starve document processing.

Local development and the verification suites (any `NODE_ENV` other than
`production`) also allow loopback and private destinations, over plain HTTP,
so a local listener can receive events. Production refuses them.

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
  (`posted`/`already_posted`), `failed`, `cancelled` or, for accounting,
  `needs_review` (a possible duplicate held for the user, counted as a
  failure). A failure records whether a retry may succeed (exhausted retries,
  provider outage, a post held for review) or needs a change first (a rejected
  URL or request, or an invoice that fails
  [validation](document-intake.md#validation)). A failing destination
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
the `delivery.failed` notification of a terminal failure, a new one after a
retry fails again, and none for a failed notification; and a disabled endpoint,
a disconnected accounting connection, a deleted invoice and a deleted
workspace. It then reconciles every accepted revision against the events the
consumer received and the bills the provider created.
Observed on 2026-09-24:

```text
save-before-event:        revision=0, deliveries scheduled=0, processing job queued for retry
crash after commit:       revision=1 after restart, 3/3 webhooks succeeded, accounting posted
webhook remote success:   same delivery received twice with one logical event ID
bill remote success:      2 provider requests, 1 bill, same provider ID, status posted
second destination fails: attempts=4, retryable, dashboard "failed"; retry re-drove only it -> "delivered"
removed destinations:     disabled endpoint/disconnected accounting/deleted invoice cancelled, retry skipped them
reconciliation:           9 accepted revisions, 18 distinct logical events, 1 deduplicable redelivery, 6 bills, 0 silent losses
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

The same command then proves self-service endpoint management over REST
against the running API and its workflow runner. Observed on 2026-09-25:

```text
Test event:              202, webhook.test, version 1, signature valid
Rotation overlap:        old secret verifies=true, new secret verifies=true
Overlap expired:         previous secret verifies=false, new secret verifies=true
Revoke previous now:     previous secret verifies=false, new secret verifies=true
Terminal failure:        attempts=4, delivery.failed notices=1, duplicate URL=409
Redelivery:              202, same event ID=true, then succeeded after 5 attempts; again=409
Other workspace:         deliveries/test/rotate/redeliver/disable all 404
Cascading notices:       0 (failed test events and failed notifications announce nothing)
Disabled endpoint:       active=false, test event=404
```

DNS rebinding, private resolution, redirects and response bounds are covered
by `packages/jobs/src/egress.test.ts`, and the production-mode e2e
(`e2e:webhook-management-production-egress`) renders the dashboard page and
checks that private and metadata destinations are refused.

The command prints the full JSON evidence, including the actual CSV header and
row, webhook retry error, and MCP structured content.
