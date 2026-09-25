# InvoiceWise API (v1)

The versioned API is how a system sends InvoiceWise documents and takes back
structured results: submit a document, poll until it is read, retrieve the
invoice, its judgments and delivery, retry deliberately, export CSV, and ask
an MCP client about it. Everything below runs with nothing but an API key and
`curl`, except the MCP server, which runs locally with Bun.

- Base URL: `https://api.invoicewise.uk` (staging:
  `https://iw-staging-api.zzapp.uk`)
- Contract: [`openapi-v1.json`](api/openapi-v1.json), also served
  unauthenticated at `GET /v1/openapi.json`
- Every route is under `/v1`; the path is the version.

## Contents

- [Get an API key](#get-an-api-key)
- [Submit a document](#submit-a-document)
- [Poll and retrieve](#poll-and-retrieve)
- [List, filter and page](#list-filter-and-page)
- [Judgments, delivery and the document](#judgments-delivery-and-the-document)
- [Retries](#retries)
- [CSV export](#csv-export)
- [Webhooks](#webhooks)
- [MCP](#mcp)
- [Errors](#errors)
- [Rate limits](#rate-limits)
- [Versioning](#versioning) and [migrating from the unversioned routes](#migrating-from-the-unversioned-routes)
- [Smoke check](#smoke-check)

## Get an API key

1. An owner or admin opens **Settings → Developer** and chooses
   **Create API Key**.
2. Name it and choose **All**, or **Restricted** with *Inbox* read and write.
   A key that only reads (for example one for an MCP client) needs only
   `inbox.read`.
3. Copy the key (`mid_…`). It is shown once; InvoiceWise stores only its
   hash.

```bash
export INVOICEWISE_API_URL=https://api.invoicewise.uk
export INVOICEWISE_API_KEY=mid_...
```

Send it on every request as `Authorization: Bearer $INVOICEWISE_API_KEY`.
OAuth access tokens from an [OAuth application](permissions.md#where-it-is-enforced)
work the same way. A browser session cookie is never accepted by `/v1`.

How keys behave:

- **Workspace.** A key belongs to the workspace it was created in and acts
  with the live role of the person who created it; no request names a
  workspace. Another workspace's invoice is `404`, never `403`.
- **Scopes.** `GET` routes and MCP need `inbox.read`; every `POST` needs
  `inbox.write`. A missing scope is `403 insufficient_scope`.
- **Rotation and revocation.** Create the new key, switch your system to it,
  then delete the old one. Keys are checked against the database on every
  request, so a deleted key is refused (`401`) on its very next request and
  a new key works at once. Removing a member or demoting them to member
  deletes their keys.
- **Never logged.** InvoiceWise does not log request headers or keys, and no
  route accepts a key in a URL. Keep keys in a secret store, not in shared
  configuration files.

## Submit a document

```bash
curl --fail-with-body -sS \
  -H "Authorization: Bearer $INVOICEWISE_API_KEY" \
  -H "Idempotency-Key: po-7788-invoice-1" \
  -F "file=@invoice.pdf;type=application/pdf" \
  "$INVOICEWISE_API_URL/v1/invoices"
```

`202 Accepted`, with `Location: /v1/invoices/{id}`:

```json
{
  "id": "d105fe5d-0726-4bd5-a949-b425152d4e24",
  "status": "processing",
  "revision": 0,
  "deduplicated": false,
  "fileName": "invoice.pdf",
  "contentType": "application/pdf",
  "size": 48213,
  "sha256": "9f2c…",
  "links": { "invoice": "/v1/invoices/d105fe5d-0726-4bd5-a949-b425152d4e24" }
}
```

- **Same intake as the dashboard.** The bytes are validated before anything
  is stored (text or scanned PDF, PNG or JPEG, at most 5 MB; the full matrix
  and limits are in [supported inputs](document-intake.md#supported-inputs)),
  written immutably under a server-chosen path and queued for processing in
  one transaction ([document intake](document-intake.md#lifecycle)). The
  multipart field must be `file`.
- **Idempotency.** `Idempotency-Key` is optional (1–255 visible ASCII
  characters, unique per workspace). Repeating a request with the same key
  and the same bytes returns the same invoice with `deduplicated: true`; the
  same key with different bytes is `409 idempotency_key_reused`. Independently
  of keys, the same bytes are one invoice per workspace: a second submission
  returns the existing invoice (`deduplicated: true`) and is neither
  processed nor delivered again. So a timed-out request is always safe to
  send again.
- **Asynchronous.** Processing happens after the response. Poll the invoice
  (below) or subscribe to the `invoice.processed` webhook.
- **Refusals** are `400` (unreadable, unsupported, password-protected, too
  many pages, …), `413` (too large) and, when InvoiceWise is working through
  a backlog, `429 queue_full` with `Retry-After`. `503` means storage was
  briefly unavailable; send the same request again.

## Poll and retrieve

```bash
curl -sS -H "Authorization: Bearer $INVOICEWISE_API_KEY" \
  "$INVOICEWISE_API_URL/v1/invoices/$ID"
```

`status` is `processing` while the document is read, then `processed` or
`failed` (with `processingError`; see [re-extract](#retries)). Poll every few
seconds; most documents finish within a minute. A processed invoice carries:

| Field | Meaning |
| --- | --- |
| `id`, `revision` | Identity and processing revision. The revision grows on each re-extraction and correction; send it back with any action |
| `document` | `fileName`, `contentType`, `size`, `sha256`, `source` (`api`, `upload`, `email`, `mailbox`) and the `idempotencyKey` it was submitted with |
| `supplierId`, `supplierName`, `invoiceNumber`, `invoiceDate`, `dueDate`, `currency`, `amount` | The headline values; `amount` is the gross total in `currency` |
| `extraction` | The canonical record with per-value evidence and line items ([persisted result](document-intake.md#persisted-result)) |
| `validation` | Deterministic checks and whether it may be posted to accounting ([validation](document-intake.md#validation)) |
| `supplierChecks` | Known supplier, duplicate and bank-detail checks ([supplier history](document-intake.md#supplier-identity-and-history)) |
| `judgments` | Answers to the workspace's questions (below) |
| `delivery` | The current revision's destinations: `state` (`none`, `pending`, `delivered`, `failed`, `cancelled`) and counts |
| `accounting` | The accounting post (`provider`, `status`, `providerId`) or null |
| `corrected`, `questionRerun` | Whether someone corrected it; a queued or failed question rerun |

## List, filter and page

```bash
curl -sS -H "Authorization: Bearer $INVOICEWISE_API_KEY" \
  "$INVOICEWISE_API_URL/v1/invoices?status=processed&limit=50"
```

Returns `{ "data": [...], "hasMore": true, "nextCursor": "…" }`. Pass
`nextCursor` back as `cursor`, with the same filters, until `hasMore` is
false. Pages are keyed on creation time and id, so documents arriving while
you page never shift or repeat a page. A cursor is opaque and tied to the
`order` it was issued for; anything else is `400 invalid_cursor`.

| Parameter | Values |
| --- | --- |
| `limit` | 1–100, default 25 |
| `order` | `desc` (newest first, default) or `asc` |
| `status` | `processing`, `processed`, `failed` |
| `state` | The dashboard's exception states: `needs_attention`, `processing`, `failed`, `invalid`, `needs_review`, `delivering`, `delivery_failed`, `delivered`, `corrected` |
| `q` | Supplier name, invoice number or file name contains |
| `supplierId` | One workspace supplier |
| `createdFrom`, `createdTo` | `YYYY-MM-DD`, inclusive |

## Judgments, delivery and the document

| Route | Result |
| --- | --- |
| `GET /v1/invoices/{id}/judgments` | Current answers plus every answer a deliberate rerun recorded (`history`, oldest first, with the answer it replaced) |
| `GET /v1/invoices/{id}/delivery` | Each webhook delivery (event, event id, revision, status, attempts, last error, whether a retry may succeed) and the accounting post |
| `GET /v1/invoices/{id}/document` | A signed link to the original bytes, valid for 60 seconds |

A judgment has `questionKey`, the `questionVersion` that was asked, `type`
(`boolean`, `choice`, `score`, `number`), `status` and `answer`.
`unknown`, `not_applicable` and `failed` are never a No or a zero: `answer` is
null and `reason` says why. `probability` (boolean) or `confidence`,
`certainty`, `evaluator` (model and evaluator version) and `answeredAt` say
how far it can be relied on. See [questions](document-intake.md#questions).

## Retries

Each action names the `revision` you read. If the invoice has changed since
(someone corrected or re-read it), the action is refused with
`409 conflict`: read it again and decide again. Concurrent identical requests
share one job.

```bash
curl -sS -X POST -H "Authorization: Bearer $INVOICEWISE_API_KEY" \
  -H "Content-Type: application/json" -d '{"revision": 1}' \
  "$INVOICEWISE_API_URL/v1/invoices/$ID/delivery/retry"
```

| Route | What it does | Downstream |
| --- | --- | --- |
| `POST /v1/invoices/{id}/reextract` (`202`) | Reads the stored document again | New revision and its webhooks; a posted bill is never posted again. `409 conflict` while a bill update is being sent |
| `POST /v1/invoices/{id}/questions/rerun` (`202`) | Answers the workspace's questions again | Judgments only: no new revision, no accounting post; one `invoice.judgments.attached` per recorded answer. `409 not_extracted` when there is nothing to ask about |
| `POST /v1/invoices/{id}/delivery/retry` (`200`) | Re-drives the failed or cancelled destinations of the current revision | The same delivery rows and event ids, so a receiver that deduplicates on `invoicewise-event-id` never sees a second event. Disabled endpoints and disconnected accounting are skipped |

The retry response reports what restarted: `started`, `webhooks.requeued`
and `skipped`, and `accounting`/`billUpdate`. Re-posting to accounting needs
an owner's or admin's key and is otherwise `admin_required`, as in the
dashboard ([permissions](permissions.md)). Field corrections stay in the
dashboard. See [corrections, reprocessing and retries](delivery.md#corrections-reprocessing-and-retries).

## CSV export

```bash
curl -sS -D headers.txt -H "Authorization: Bearer $INVOICEWISE_API_KEY" \
  -o invoices.csv "$INVOICEWISE_API_URL/v1/exports/invoices.csv?limit=500"
```

| Route | Rows |
| --- | --- |
| `GET /v1/exports/invoices.csv` | One per invoice: `invoice_id`, `revision`, `status`, `created_at`, `source`, `idempotency_key`, `sha256`, `file_name`, supplier id, name and VAT number, invoice number and dates, document type, `currency`, net, VAT and gross amounts, validation status, accounting readiness and issues, delivery state, accounting provider, status and id, `corrected`, `processing_error`, and a `question:<key>` column per workspace question (its answer, or `unknown`, `not_applicable`, `failed`) |
| `GET /v1/exports/judgments.csv` | One per current answer (`entry=current`) and per answer a rerun recorded (`entry=rerun`, with `previous_status` and `previous_answer`), with the invoice revision, question key, version and version id, type, status, answer, probability, confidence, certainty, currency, reason and evaluator |

Both take the list filters and page like the list, `limit` 1–1000 (default
500). When more rows follow, the response has `X-Next-Cursor` and
`Link: </v1/exports/…&cursor=…>; rel="next"`; follow them until neither is
present. The `question:<key>` columns are the same on every page. Text that a
spreadsheet would run as a formula (it starts with `=`, `+`, `-`, `@`, a tab
or a line break) is written with a leading `'`, so a hostile supplier name
opens as text; plain numbers, including negative amounts, are unchanged.

## Webhooks

Owners and admins register endpoints in **Settings → Webhooks** or with the
key over `POST /webhooks`. Events are `invoice.processed`,
`invoice.judgments.attached` and `delivery.failed`; payloads are signed,
versioned and delivered at least once with a stable event id. Endpoint
management, signatures, rotation and redelivery are documented in
[webhooks](delivery.md#webhooks) and are not versioned under `/v1`.

## MCP

InvoiceWise ships a read-only [Model Context Protocol](https://modelcontextprotocol.io)
server that your MCP client starts locally over stdio. It authenticates with
your API key and exposes four **read-only** tools; there are no tools that
change anything.

| Tool | Arguments | Returns |
| --- | --- | --- |
| `list_invoices` | `status`, `state`, `q`, `supplierId`, `createdFrom`, `createdTo`, `order`, `limit`, `cursor` (all optional) | The list response |
| `get_invoice` | `id` | The invoice |
| `get_invoice_judgments` | `id` | Judgments and their rerun history |
| `get_invoice_delivery` | `id` | Webhook and accounting delivery |

Every tool call is a `GET` to `/v1` with your key, so it sees exactly what
REST shows that key: the same workspace, scope (`inbox.read`), rate limit and
`404` for another workspace's invoice. A refused call returns a tool result
with `isError: true` whose `structuredContent` holds the API's `status`,
`code` and `message` (an unreachable API is `503 api_unreachable`); a
malformed argument is a tool result with `isError: true` describing the
argument, and no request is sent.

**Install** (needs [Bun](https://bun.sh/) 1.3.13 and git):

```bash
git clone https://github.com/ziahm6638/invoicewise.git
cd invoicewise
bun install --frozen-lockfile
export INVOICEWISE_MCP_SERVER="$PWD/apps/api/src/mcp/server.ts"
```

The server reads `INVOICEWISE_API_KEY` and `INVOICEWISE_API_URL` (default
`https://api.invoicewise.uk`) from its environment; put them in the client's
configuration, not in a file in the checkout.

**Claude Code:**

```bash
claude mcp add invoicewise \
  --env INVOICEWISE_API_URL="$INVOICEWISE_API_URL" \
  --env INVOICEWISE_API_KEY="$INVOICEWISE_API_KEY" \
  -- bun --no-env-file "$INVOICEWISE_MCP_SERVER"
```

**Clients configured with JSON** (Claude Desktop, Cursor, VS Code and
others), with the absolute path of `apps/api/src/mcp/server.ts`:

```json
{
  "mcpServers": {
    "invoicewise": {
      "command": "bun",
      "args": ["--no-env-file", "/path/to/invoicewise/apps/api/src/mcp/server.ts"],
      "env": {
        "INVOICEWISE_API_URL": "https://api.invoicewise.uk",
        "INVOICEWISE_API_KEY": "mid_..."
      }
    }
  }
}
```

**Check it from a shell** before configuring a client; the server speaks
newline-delimited JSON-RPC on stdin and stdout:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"shell","version":"1"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_invoices","arguments":{"limit":5}}}' \
  | (cat; sleep 5) | bun --no-env-file "$INVOICEWISE_MCP_SERVER"
```

## Errors

Every error has one body:

```json
{ "error": { "code": "idempotency_key_reused", "message": "This Idempotency-Key was already used for a different document in this workspace." } }
```

Branch on the HTTP status and `code`; `message` is for people. New codes may
be added within a status.

| Status | Codes |
| --- | --- |
| 400 | `invalid_request` (does not match the contract), `invalid_cursor`, `invalid_idempotency_key`, `malformed`, and the intake refusals `empty`, `unsupported_type`, `content_mismatch`, `password_protected`, `too_many_pages`, `page_too_large`, `timeout`, `resource_limit` |
| 401 | `unauthorized` (no, unknown, deleted or expired credential; sent with `WWW-Authenticate: Bearer`) |
| 403 | `insufficient_scope`, `no_workspace`, `forbidden` |
| 404 | `not_found` (no such invoice in this key's workspace, or no such endpoint) |
| 409 | `conflict` (the revision changed or the invoice is busy), `not_extracted`, `idempotency_key_reused`, `superseded` |
| 413 | `too_large`, `image_too_large` |
| 429 | `rate_limited`, `queue_full` (both with `Retry-After`) |
| 500 | `internal_error` |
| 503 | `storage_unavailable`, `temporarily_unavailable` (retry the same request) |

## Rate limits

`/v1` allows 300 requests per 10 minutes for one person's credentials in one
workspace (all of their keys and tokens together, MCP tool calls included).
Every response carries `RateLimit-Policy`, `RateLimit-Limit`,
`RateLimit-Remaining` and `RateLimit-Reset`; over the limit the answer is
`429 rate_limited` with `Retry-After` seconds. Separately, submissions are
refused with `429 queue_full` while the processing backlog is at its bound
([operations](operations.md)). Poll no faster than every few seconds, and
prefer webhooks for high volumes.

## Versioning

- `/v1` changes only additively: new endpoints, new optional parameters, new
  response fields, new error codes. Ignore fields you do not know.
- Anything that would break a v1 client ships as a new path version (`/v2`)
  beside v1, with a migration section here.
- The contract is the committed [`docs/api/openapi-v1.json`](api/openapi-v1.json).
  The API test suite fails when the served contract differs from it, so every
  change to it is a reviewed diff; regenerate it with `bun run contract:v1`
  in `apps/api` after a deliberate, compatible change.

### Migrating from the unversioned routes

The routes before `/v1` (`/invoices`, `/inbox`, `/webhooks`, and the
Midday-inherited `/openapi` document) keep working as they are; the only
change is that their CSV export now neutralizes formulas too. New
integrations should use `/v1`:

| Unversioned | v1 |
| --- | --- |
| `GET /invoices?pageSize&cursor` (offset cursor, `meta.hasNextPage`) | `GET /v1/invoices?limit&cursor` (keyset cursor, `hasMore`, `nextCursor`) |
| `GET /invoices/{id}` with `lineItems` and a 5-minute `documentUrl` | `GET /v1/invoices/{id}` (line items in `extraction.lineItems`) and `GET /v1/invoices/{id}/document` |
| `GET /invoices/{id}/delivery-status` | `GET /v1/invoices/{id}/delivery` |
| `POST /invoices/{id}/delivery/retry` (no body) | `POST /v1/invoices/{id}/delivery/retry` with `{"revision": n}` |
| `GET /invoices/export.csv` (every row at once, `judgment:<questionId>` columns) | `GET /v1/exports/invoices.csv` (paged, `question:<key>` columns) and `GET /v1/exports/judgments.csv` |
| Dashboard upload only | `POST /v1/invoices`, `…/reextract`, `…/questions/rerun` |
| Errors `{"error": "..."}` or plain text | `{"error": {"code", "message"}}` |

The MCP tools now read `/v1`: `list_invoices` takes `limit` instead of
`pageSize` and returns `{data, hasMore, nextCursor}`, `get_invoice` returns
the v1 invoice, and `get_invoice_judgments` returns judgments with their
history. The stdio server defaults to the production URL.

## Smoke check

`apps/api/src/public-api-smoke.ts` is a script, run from the checkout of the
[MCP install](#mcp), that follows this page with only a URL and a key: it checks the contract and
authentication, submits a freshly generated invoice PDF with an
idempotency key (and replays it, and reuses the key for other bytes), polls
until it is processed, reads it, its judgments, delivery and document (and
checks the signed link serves the submitted bytes), pages the list, reads
both exports, exercises the retry contract and queries the invoice through
the stdio MCP server (and checks an unknown key is refused there too). With
`SMOKE_WEBHOOK_URL` set to an HTTPS receiver you control (the key then needs
an owner or admin), it also registers a webhook, waits
for its `invoice.processed` delivery and disables it again.

```bash
INVOICEWISE_API_URL=https://iw-staging-api.zzapp.uk \
INVOICEWISE_API_KEY=mid_... \
  bun apps/api/src/public-api-smoke.ts
```

Use a throwaway staging workspace: the script leaves its invoice in place.
`bun run verify` runs the same script (`verify:public-api` in `apps/api`)
against a locally started API with a loopback TypeSafe stub, and adds what
one key cannot see: another workspace's REST, export, retry and MCP reads are
`404` or empty, a read-only key cannot submit, pages never repeat, a hostile
file name exports as text, a deleted key is refused on its next REST and MCP
request while its replacement works at once, and no key appears in the API's
output.
