# Delivery surfaces

InvoiceWise exposes processed invoice records through authenticated REST, a
read-only MCP server, signed webhooks, and CSV. All REST requests use the API
key's workspace; no delivery route accepts a workspace identifier from the
caller.

The customer contract is the versioned API: [InvoiceWise API (v1)](api.md)
covers programmatic submission with idempotency, polling, retrieval, paged
formula-safe CSV exports, deliberate retries, the stdio MCP server's
install and authentication, errors, rate limits and the clean-room smoke
check. It is
implemented in `apps/api/src/effect/public-api.ts` (domain, schemas),
`apps/api/src/effect/public-api-http.ts` (`HttpApi`, published contract) and
`apps/api/src/rest/v1.ts` (bearer-only authentication, scopes, rate limit).
The unversioned routes below remain served for existing clients.

## REST and CSV (unversioned)

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
| `GET /invoices/export.csv` | Workspace invoices with document type, validation status, accounting readiness and issues, and a `judgment:<questionId>` column for every judgment; formula-like text is prefixed with `'` (`apps/api/src/effect/csv.ts`) |
| `GET /delivery-policy` | The [delivery rules](#delivery-rules) in force: `version` (0 for the built-in defaults), `policy` and the `alwaysHeld` checks |

An invoice outside the API key's workspace is returned as `404`, so the route
does not reveal whether another workspace owns that identifier.

Every invoice read, the `invoice.processed` webhook payload and MCP
`get_invoice` carry `validation`: the deterministic checks, issues, canonical
totals with their currencies, duplicate and credit-note identity, and
`accounting.ready` with its blockers. See
[Validation](document-intake.md#validation).

Invoice reads and MCP `get_invoice`/`list_invoices` also carry `sourceMatch`:
the current decision about which jobs, purchase orders and contracts the
invoice bills, with confidence, allocations and the evidence for every
candidate, or null before matching (a credential without `sources.read` gets
only the status and the linked source IDs). It is decided after processing, so the
`invoice.processed` payload does not include it; subscribe to
`invoice.matched`. See [matching](authorization-matching.md).

Every invoice read also carries `deliveryDecision`: the
[delivery rules](#delivery-rules)' decision for its current revision, with
the reasons it was held and how a hold was resolved.

`POST /invoices/:id/delivery/retry` (scope `inbox.write`) is the recovery
action for failed or cancelled destinations; see
[Processing-to-delivery handoff](#processing-to-delivery-handoff).
`POST /invoices/:id/delivery/release` and `/dismiss` resolve an invoice the
delivery rules held.

## MCP

The MCP tools are read-only and call `/v1` with the caller's own key:
`list_invoices`, `get_invoice`, `get_invoice_judgments` and
`get_invoice_delivery` (`apps/api/src/mcp/invoice-tools.ts`). They are served
over stdio (`apps/api/src/mcp/server.ts`) with identical authentication,
scopes and workspace isolation to REST, and no tool takes a workspace
argument. Client setup is in [API: MCP](api.md#mcp); from a checkout:

```bash
cd apps/api
INVOICEWISE_API_URL=https://api.invoicewise.uk \
INVOICEWISE_API_KEY=mid_... \
bun run mcp
```

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

Events are `invoice.processed`, `invoice.judgments.attached`,
`invoice.matched` and `delivery.failed`, plus `webhook.test`, which is sent
only when requested and regardless of the endpoint's subscriptions.
`invoice.matched` is sent for every new [match
decision](authorization-matching.md), automatic or a person's; its `data` is
`{ "invoiceId", "match" }`. Every body is a versioned envelope:

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

The `data` of `invoice.processed` and `invoice.judgments.attached` carries
`deliveryDecision` (policy and rules version, outcome, reasons, what each
destination was told, and any release), so a consumer sees why an invoice
reached it. `version` (also the `invoicewise-webhook-version` header) changes only for a
breaking payload change. `invoiceId` and `revision` identify the exact invoice
revision the event describes; a reprocessed invoice is a new revision with
new event IDs. A [question rerun](#question-reruns) sends a further
`invoice.judgments.attached` for the same revision, with its own event ID. Payloads never contain a document link, because signed
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
from the invoice, its processing `revision` and the event type (for
`invoice.matched`, from the invoice and the decision): it is the same on every
endpoint, every retry and every redelivery.

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
  opened, before any request bytes are sent), so a DNS answer that changes
  after registration (rebinding) is refused before any connection. TLS still verifies the certificate against
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

## Delivery rules

Automatic delivery is the normal path: an eligible invoice goes to every
enabled destination without a manual step. Each workspace has a small
delivery policy that decides which invoices are eligible and explains every
one it holds. It is exception handling, not an approval step, and not a rules
engine: a fixed set of checks over the validation, supplier-history checks
and question answers each invoice already has, plus at most ten conditions
of two shapes (`packages/documents/src/delivery-policy.ts`). Everyone in the
workspace can read it in **Settings → Delivery rules**, tRPC
`deliveryRules.get` or `GET /delivery-policy`; owners and admins change it.

| Check | Default | Holds when |
| --- | --- | --- |
| Missing required fields | always held | the supplier, invoice number, invoice date, currency or gross total was not found |
| Invalid financial data | always held | any [validation](document-intake.md#validation) error: totals, VAT or lines that do not add up, mixed currencies, a negative total, a due date before the invoice date |
| Duplicate or revised invoice | always held | the same type and number from the same supplier was received before: a copy (`duplicate`), or a revised invoice with a different date or total (`revised_invoice`) |
| Possible duplicate | held | an earlier invoice from the supplier has the same date and total under another number |
| Changed bank details | held | the bank account differs from the supplier's most recent one (shown masked) |
| Uncertain reading | held | the supplier, invoice number, a date, the currency or an amount was read with low confidence |
| New or unidentified supplier | delivered | the supplier's first invoice, or the supplier could not be identified |
| Other validation warnings | delivered | no VAT shown, VAT without a VAT number, failed VAT-number or IBAN check digits and the like |
| Required questions | none | a required question's answer is `unknown`, `not_applicable`, `failed`, `low_confidence`, `incomplete_input` or missing |
| Conditions (up to 10) | none | a question's answer *is*/*is not* a yes/no or choice value, or is *above*/*below* a number or score level; or the gross total is above an amount in a named currency |

An answer that is not a confident answer never counts as no or zero: a
condition over it holds the invoice as *could not be checked*, and so does an
amount limit on an invoice in another currency (amounts are never
converted). The three *always held* checks cannot be switched off, because a
bill could not safely carry them. A credit note is not held; it is not
posted either, because a draft bill cannot represent it.

**Destinations.** *Accounting* on or off: whether eligible invoices are
posted as draft bills. *Webhooks*: `eligible` (the default) sends invoice
events only for eligible or released invoices; `all` sends every processed
invoice, each carrying its decision, for a consumer that runs its own review.

**Decisions.** Each invoice revision is decided once, in the transaction that
schedules its deliveries (`decideRevision` in
`packages/jobs/src/delivery-rules.ts`), and stored in `delivery_decisions`
with the policy version and settings it was made under, the rules version,
the outcome, every reason (with whether a release may clear it) and what
each destination was told: `accounting` is `deliver`, `held`, `off`,
`not_connected`, `not_applicable`, `already_posted` or `not_scheduled` (the
rules would let it through but the revision schedules no post: a question
rerun of an invoice that was not held, or a correction that posts nothing),
`webhooks` is `deliver` or `held`. A destination is scheduled only when its decision lets
it through, so every webhook delivery and bill has the decision it was sent
under (the delivery's revision, or the invoice's `accounting_revision`), and
webhook payloads carry it as `data.deliveryDecision`. A held invoice reads as
*Held* in the dashboard, is listed under *Held* and *Needs attention*, and its
**Delivery** panel shows each reason and the next step.

**Resolving a held invoice.** Every path names the revision the person saw
and is refused as a conflict when the invoice has changed:

- **Release** (owner or admin, with a reason): records who released it, when
  and why on the decision, then schedules the destinations that were held, under
  the same event ids and bill key they would have had. It is refused while an
  *always held* reason stands. Two releases at once produce one; the other
  is a conflict.
- **Dismiss** (owner or admin, with a reason): records that nothing is sent;
  the invoice reads as *Not delivered* and leaves *Needs attention*.
- **Correct** or **re-extract**: the new revision is decided afresh. A
  member's correction of a held invoice is held again for an owner's or
  admin's release (`awaiting_approval`), so a member cannot clear a hold by
  editing values.
- **Rerun questions**: the new revision is decided afresh; when the previous
  revision's bill was held and the new answers make it eligible, the bill is
  posted then (a rerun otherwise never posts). An unresolved
  `awaiting_approval` hold is carried to the new revision, so only a release
  clears it.

*Retry delivery* and `POST /accounting/invoices/:id/retry` never bypass a
hold: while the current revision's decision is held and not released, the
accounting part answers `held` (or `dismissed`) and leaves the post as it is,
even when an earlier revision's post failed, and the dashboard offers no
accounting retry. A question rerun sends no `invoice.judgments.attached`
for an invoice whose webhooks are held.

| Surface | Release / dismiss |
| --- | --- |
| Dashboard | the invoice's **Delivery** panel |
| tRPC | `inbox.releaseDelivery`, `inbox.dismissDelivery` (`id`, `revision`, `reason`) |
| REST | `POST /invoices/:id/delivery/release` and `/dismiss` with `{"revision": n, "reason": "..."}` (scope `inbox.write`): `403` for a member, `404` for another workspace's invoice, `409` for a changed invoice or a resolved hold, `400` for a hold only a correction clears |

**Changing the rules.** Saving writes a new, immutable version
(`delivery_policies`); the caller names the version they edited, so a stale
save is refused (`409`). Decisions already made keep the version they were
made under: nothing is re-decided or re-sent, and an invoice held before the
change stays held until someone resolves it. Revisions completed afterwards
are decided under the new version.

```bash
curl --fail --silent -X PUT \
  -H "Authorization: Bearer $INVOICEWISE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"expectedVersion":0,"policy":{"destinations":{"accounting":true,"webhooks":"eligible"},"rules":{"possible_duplicate":"hold","bank_details_changed":"hold","uncertain_reading":"hold","new_supplier":"deliver","validation_warnings":"deliver"},"requiredQuestions":[],"conditions":[{"kind":"gross_above","amount":5000,"currency":"GBP"}]}}' \
  "$INVOICEWISE_API_URL/delivery-policy"
```

**Business idempotency.** A revision has one decision (a replay returns it);
a release or dismissal is a single conditional transition under the invoice
row lock; events are keyed by invoice, revision and type, and bills by one
key and claim per invoice number, so concurrent jobs, retries and releases
converge on one delivery per endpoint and one bill. A revision of an invoice
(a correction, re-extraction or rerun) keeps the invoice's one bill; a
document from the same supplier with a number already received is a
duplicate or revised invoice, never a new invoice. A later copy processed
before its original is still stopped by the accounting job's claim (see
[accounting integrations](accounting-integrations.md#what-each-provider-receives)).

**Proof.** `bun run verify:delivery-rules` in `packages/jobs` (part of
`bun run verify`) drives the real queue, worker batches and Postgres against
loopback Nango/Xero and webhook stubs: a valid invoice posted and sent with
its decision; a copy held as a duplicate, refused on release and on both
retry routes, dismissed with its reason; a revised invoice held as a
revision; changed bank details held, refused to a member and to a stale tab,
then released by two admins at once into one bill and one event; a missing
number, a low-confidence total and an unknown required answer held; and a
policy update that leaves held invoices held and re-sends nothing while a
new invoice is decided under the new version. Observed on 2026-09-25:

```text
eligible:      decision=deliver, policyVersion=0, accounting=posted, delivery=delivered
duplicate:     reasons=[duplicate], release refused, resolution=dismissed
revised:       reasons=[revised_invoice]
bank details:  "…has account ending 4321, …most recent invoice HP-1001 had account ending 5678…"
               releases=[fulfilled, rejected], bills=1, processed events=1, delivery=delivered
evidence:      missing number=[missing_required_fields, …], low confidence=[uncertain_reading],
               unknown required answer=[required_answer_uncertain]
policy update: version=2, held invoice stays under version 0, re-sent=0, new invoice under version 2
```

## Processing-to-delivery handoff

Every accepted invoice revision reaches each destination the workspace had
configured when it completed and the [delivery rules](#delivery-rules) let
through, or ends in a visible state (held, dismissed or a terminal outcome).

- **One transaction.** The processing result, the next `processing_revision`,
  its delivery decision and one durable intent per destination the decision
  lets through (a `webhook_deliveries` row per subscribed active endpoint and
  event, and the invoice's accounting post) are written together with the
  workflow jobs that carry them out
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
  exist or clear a [delivery-rules](#delivery-rules) hold.
- **Delivered state.** The dashboard shows *Held*, *Delivering*,
  *Delivered*, *Delivery failed* or *Not delivered* from the current
  revision's decision and destination outcomes: an unresolved hold is
  *Held*, any failure is *Delivery failed*, a dismissed hold is *Not
  delivered*, any queued work is *Delivering*, and *Delivered* needs at least
  one successful destination with the rest succeeded or cancelled. The legacy
  `done` inbox status plays no part.

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

## Corrections, reprocessing and retries

The invoice detail page shows where an invoice stands in each stage
(extraction, validation, questions, delivery), the reason for any failure and
the next permitted action (`describeInvoiceWorkflow` in
`apps/dashboard/src/components/inbox/invoice-state.ts`). Queued work always
reads as in progress: an invoice is *Delivered* only when its destinations
have reported success, and a pending bill update keeps it *Delivering*. The
invoice list filters by these states (needs attention, extraction failed,
invalid, needs review, delivering, delivery failed, delivered, processing,
corrected), searches supplier names and invoice numbers, pages with the
filter applied, and acts on a selection (re-extract, rerun questions, retry
delivery), each invoice reporting its own outcome; a retry that re-queued
nothing (nothing failed, already sending, needs an admin, no accounting
connection) is reported as not started.

Three separate actions, each named with the processing revision the user is
looking at, so a double click, a second tab or a finishing worker produces one
transition and the other is refused as a conflict (tRPC `CONFLICT`):

| Action | tRPC | What it does | Downstream |
| --- | --- | --- | --- |
| Re-extract | `inbox.retry` (`id`, `revision`) | Reads the stored document again; concurrent clicks share one processing job | New revision; webhooks for the current endpoints; accounting as after any processing (a posted bill is never posted again or changed). Replaces corrections; the history keeps them, and a failed or cancelled bill update they asked for is recorded as superseded once the new reading is saved, and is never sent or retried. Retry delivery leaves bill updates alone while the document is read; a re-read that fails replaces nothing, so the correction and its update stay retryable. Refused while a bill update is being sent |
| Rerun questions | `inbox.rerunQuestions` | Answers the workspace's questions again for the stored (possibly corrected) extraction, with the supplier-scoped history; one `rerun-judgments` job per revision | New revision with the new answers; `invoice.processed` and `invoice.judgments.attached` for the current endpoints; no accounting |
| Retry delivery | `inbox.retryDelivery` | Re-drives failed or cancelled destinations of the current revision, including a failed bill update | Same delivery rows and event IDs; accounting needs an admin |

A rerun that fails (TypeSafe down, an exhausted job) is recorded on the
invoice (`judgments_rerun_status`) and can be requested again. Every
operation lives in the Postgres queue, so it survives a page refresh and a
worker restart; the runner's reconciler (`reconcileInvoiceOperations` in
`packages/jobs/src/exceptions.ts`, beside `reconcileDeliveries`) re-queues a
lost rerun, turns a rerun or bill update whose job failed without recording
an outcome into a visible, retryable failure, and records a document left
`processing` after its processing job failed as a failed extraction (the
dashboard already shows it as failed, with Re-extract). That settlement
re-checks under the invoice row lock that no processing job is queued or
running, so a concurrent Re-extract wins.

### Corrections

`inbox.correct` (`correctInvoice`) changes extracted fields of one revision.
Members and admins may correct (see [permissions](permissions.md)). In one
transaction, under the invoice row lock and the workspace's identity lock:

- values are checked against the canonical record
  (`applyInvoiceCorrection` in `packages/documents/src/correction.ts`, which
  the dashboard runs too): ISO dates that exist, three-letter currency codes,
  amounts with at most two decimals, a known document type, sort code, IBAN
  and BIC shapes; a submission that changes nothing is refused, and line
  items are not correctable;
- the reading is kept: `inbox.extraction_original` holds the extraction as
  read (until a re-extraction replaces it), and each `invoice_corrections` row
  records the actor, time, reason, version, the revision it corrected and
  created, and every field's value before and after. A corrected value's
  evidence says it came from a user, so the low-confidence warning of the
  reading no longer applies;
- the supplier is resolved again (a manual assignment is kept), validation
  and supplier checks run again, and later copies whose duplicate identity
  depended on the old or new number are checked again;
- the corrected record becomes the next revision; webhook endpoints receive
  `invoice.processed` for it with `data.correction` (version, reason,
  changes).

What happens to the bill:

- **Not posted yet.** The post is scheduled again from the corrected values
  (validation still gates it). Re-posting after a failed, cancelled or held
  post needs an admin, as a retry does; a member's correction reports
  `admin_required`. A correction is refused while a post is running, and
  while an earlier post may already have created the bill (a retryable
  failure or a cancelled post with a stored idempotency key): retry delivery
  first, so the provider's key either creates the bill or replays the
  existing one, then correct the posted invoice and keep or update its bill.
  A post that never reached the provider (blocked by validation, held for
  review) takes its key from the corrected number.
- **Already posted.** The provider ID is kept and the caller must choose:
  `keep_bill` (only InvoiceWise's record changes; the history says the bill
  was kept) or `update_bill` (admin only): the same bill is updated in place
  by the `update-accounting-bill` job with the extraction as approved, under a
  per-correction key, never created again. It is refused when the corrected
  invoice could not be posted (validation blockers), when the bill's provider
  is not connected, or would move the bill to a number another document's
  bill holds. An update cancelled because the connection went away reads as
  a failed delivery until it is retried; a changed number also claims the
  new number, keeping the old claim, so neither can become a second bill. A
  new correction waits until a queued update settles, and the newest
  correction decides the bill: a later correction supersedes an earlier
  update that failed, which then no longer reads as a failed delivery or is
  retried. A correction also supersedes a question rerun queued for the
  previous revision. See
  [Accounting integrations](accounting-integrations.md#updating-a-bill-after-a-correction).

The detail page's **History** lists the corrections newest first and links
the bill in Xero or QuickBooks.

### Upload status

Each uploaded file has its own status in the dashboard's upload panel:
*Received* only after the server answered 200 (stored, record accepted,
processing queued), otherwise the server's reason. A capacity, storage or
connection failure (or a two-minute timeout) offers Retry, which sends the
same bytes and resumes the same reservation; a rejected document does not.
Uploads interrupted by closing the page are listed as interrupted when the
page comes back, never as still uploading; uploading the file again resumes
or deduplicates it (see [intake recovery](document-intake.md#lifecycle)).

### Exception workflow proof

`bun run verify:exceptions` in `packages/jobs` (part of `bun run verify`)
drives the real queue, worker batches and Postgres against loopback
Nango/Xero, TypeSafe and webhook stubs: a failed extraction re-extracted by
three concurrent clicks through one job, a stalled processing job made
retryable, question reruns (concurrent, failed, a worker dying on the last
attempt, retried), invalid totals blocked then corrected by one of two
concurrent corrections and posted once, a member's correction waiting for an
admin retry, a post that timed out after the provider created the bill
retried to the same single bill, and a delivered invoice kept, then updated
in place through a timed-out and retried update with the provider ID and
bill count unchanged.

## Question reruns

When new result events are emitted, and when they are not:

| Action | Events | Accounting |
| --- | --- | --- |
| Processing (or reprocessing) an invoice | `invoice.processed`, and `invoice.judgments.attached` when it has judgments, for the new revision | one post per invoice, as above |
| Editing, disabling or deleting a question | none; stored answers are unchanged | none |
| Previewing a question on invoices | none; nothing is stored | none |
| Rerunning a question on selected invoices | one `invoice.judgments.attached` per invoice whose answer was recorded, per subscribed endpoint | none |

A rerun ([questions](document-intake.md#preview-and-rerun)) changes only
the invoice's judgments. It never increments `processing_revision`, so it
cannot schedule an accounting post, re-send `invoice.processed` or repeat
the processing run's own events. Its event carries the invoice's current
`revision` and an ID derived from the invoice, that revision, the event type
and the run (`question-run:<run id>`): a different ID from processing's
`invoice.judgments.attached`, identical across worker retries and replays of
the run, so each rerun answer is delivered at most once per endpoint (after
deduplication on `invoicewise-event-id`). The event is written in the same
transaction as the answer it announces. Its `data` holds the invoice `id`,
the invoice's full `judgments` after the change, `answer` (the new answer),
`previous` (the one it replaced, or null) and `questionRun` (`id`,
`questionKey`, `questionVersionId`, `questionVersion`). An invoice skipped
by the run, or whose evaluation failed, gets no event. These deliveries
belong to the invoice's current revision, so they show in its **Delivery**
panel and are re-driven by the same retry action.

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
