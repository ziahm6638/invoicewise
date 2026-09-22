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
| `GET /invoices/:id/delivery-status` | Webhook delivery state for the invoice |
| `GET /invoices/export.csv` | Workspace invoices with a `judgment:<questionId>` column for every judgment |

An invoice outside the API key's workspace is returned as `404`, so the route
does not reveal whether another workspace owns that identifier.

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
invoicewise-delivery: <delivery UUID>
invoicewise-signature: t=<unix-seconds>,v1=<hex HMAC-SHA256>
```

Verify the signature by computing HMAC-SHA256 over
`<timestamp>.<exact-request-body>` with the endpoint secret, comparing the hex
digest in constant time, and rejecting old timestamps. The repository helper
`verifyWebhookSignature` uses a five-minute tolerance by default.

Webhook HTTP calls run only in the Postgres-backed Effect workflow runner. A
non-2xx response, redirect, or network error is retried four times with bounded
exponential backoff. Each HTTP attempt is stored before the job is retried. A
terminal failure marks the delivery failed and emits `delivery.failed` to other
subscribed endpoints; failures of that notification are not emitted again, so
failure events cannot recurse. Slow or unavailable customer endpoints therefore
do not block invoice processing.

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
