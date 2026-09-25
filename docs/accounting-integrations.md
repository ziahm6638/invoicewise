# Accounting integrations (Xero, QuickBooks) through self-hosted Nango

InvoiceWise posts processed invoices to Xero and QuickBooks Online through a
**self-hosted Nango** on hp-slice (`nango.invoicewise.uk`; operation is in
[deployment.md](deployment.md#nango)). Nango owns the OAuth flow, stores and
refreshes the provider tokens, and proxies every provider API call.
InvoiceWise stores only the Nango connection ID and never sees a provider
token.

The free self-hosted edition provides auth (Connect UI, token storage and
refresh) and the proxy; it does not run Nango actions or syncs. The
provider-specific bill calls therefore live in InvoiceWise
(`packages/jobs/src/accounting-providers.ts`) and reach the provider only
through `POST /proxy/...` (`packages/jobs/src/nango.ts`).

## Configuration

API and standalone worker (`apps/api/.env-template`,
`packages/jobs/.env-template`):

| Setting | Production value | Purpose |
| --- | --- | --- |
| `NANGO_BASE_URL` | `http://invoicewise-nango:3003` | Nango as the API reaches it (kamal network). No default: without it accounting is unavailable. |
| `NANGO_PUBLIC_URL` | `https://nango.invoicewise.uk` | Nango as browsers reach it, handed to Connect UI. Defaults to `NANGO_BASE_URL`. |
| `NANGO_SECRET_KEY` | Infisical | The Nango `prod` environment secret key (`NANGO_SECRET_KEY_PROD` on the Nango container). |
| `NANGO_XERO_INTEGRATION_ID` | `xero` | Unique key of the Xero integration in Nango. |
| `NANGO_QUICKBOOKS_INTEGRATION_ID` | `quickbooks` | Unique key of the QuickBooks integration in Nango. |

A provider reads as available (`accounting.get` / `GET /accounting/connections`)
only when these are set **and** its integration exists in Nango, so a provider
whose OAuth app is not registered yet shows "not available yet" instead of
failing at connect time. An integration on a `*-sandbox` Nango provider reads
as available with "Sandbox companies only", and its bill links open the
provider's sandbox app (`app.sandbox.qbo.intuit.com`); `QUICKBOOKS_APP_URL`
overrides the production QuickBooks host only.

## Provider apps and Nango integrations

Each provider needs a developer app whose redirect URI is
`https://nango.invoicewise.uk/oauth/callback`. Its client ID and secret go into
a Nango integration under the `prod` environment, created by the
[deployment contract](#deployment-contract) command rather than in the Nango
admin dashboard:

| Integration unique key | Nango provider | Scopes |
| --- | --- | --- |
| `xero` | `xero` | `offline_access accounting.invoices accounting.contacts accounting.attachments accounting.settings.read` (apps created before March 2026 may use `accounting.transactions` in place of `accounting.invoices`) |
| `quickbooks` | `quickbooks` (production companies) or `quickbooks-sandbox` (sandbox companies) | `com.intuit.quickbooks.accounting` |

Nango records the organisation at connect time: Xero's `tenant_id` (its
`xeroPostConnection` script) and QuickBooks' `realmId` (from the OAuth
callback). One Xero authorisation can reach several organisations, so
InvoiceWise records the one the workspace chose on the connection
(`accounting_connections.organisation_id`) and sends it as `Xero-Tenant-Id`
on every Xero call; Nango's `tenant_id` is only the default at connect.

### Deployment contract

The integrations are created from the app credentials in Infisical (`prod`),
never by hand, with one idempotent command per provider, run from
`packages/jobs` against the Nango API:

```bash
NANGO_BASE_URL=https://nango.invoicewise.uk NANGO_QUICKBOOKS_INTEGRATION_ID=quickbooks \
QUICKBOOKS_NANGO_PROVIDER=quickbooks-sandbox \
  infisical run --env prod -- bun run nango:configure-integration quickbooks

NANGO_BASE_URL=https://nango.invoicewise.uk NANGO_XERO_INTEGRATION_ID=xero \
  infisical run --env prod -- bun run nango:configure-integration xero
```

(Xero has no separate sandbox provider: a Xero app reaches any organisation
its user authorises, including Xero's free, resettable Demo Company.)

It creates the integration (unique key from `NANGO_<PROVIDER>_INTEGRATION_ID`,
the Nango provider, `client_id`/`client_secret` from `INTUIT_CLIENT_ID` /
`INTUIT_CLIENT_SECRET` or `XERO_CLIENT_ID` / `XERO_CLIENT_SECRET`, and the
scopes in the table above) or updates its credentials in place, and prints the
key, provider, scopes and whether the stored client ID matches, never a
credential. It refuses to change an existing integration's provider: that
means deleting the integration in the Nango dashboard, which deletes every
connection made under it, so it is an operator decision.

The self-hosted edition runs no Nango actions or syncs, so there is no Nango
action code to deploy: the bill "action" is the InvoiceWise adapter in
`src/accounting-providers.ts` (versioned with the application and deployed
with it), calling the provider through `POST /proxy`. The contract with
Nango is therefore only the integration above, the connection's `realmId` /
`tenant_id`, token refresh and the proxy. Reproducing a provider end to end
is: its developer app (redirect URI above), the configure command, a
connection through Settings → Accounting, then the [sandbox
proof](#sandbox-proof).

The Intuit app's **development** keys reach only sandbox companies, so the
`quickbooks` integration uses the `quickbooks-sandbox` provider until Intuit
approves the app for production. With the production keys in Infisical,
delete the integration (after disconnecting sandbox connections), rerun the
command with `QUICKBOOKS_NANGO_PROVIDER=quickbooks`, and workspaces connect
their real companies.

## What each provider receives

Only an invoice whose validation allows it (`validation.accounting.ready`) is
posted: an invoice or credit note with supplier name, invoice
number, invoice date, currency and gross total, whose totals reconcile and
which is not a duplicate. Otherwise nothing is sent and the invoice's
accounting status is `failed` with `Not sent to Xero: <reasons>` (or
QuickBooks); see [Validation](document-intake.md#validation).

**One document type and number, one bill.** Two documents of the same type
with the same invoice number (ignoring spacing, punctuation and case) are
never both posted automatically, whatever their suppliers were read as.
Before calling the provider a post claims the type and number
(`accounting_post_claims`, one row per workspace, taken by a single committed
insert); only the holder posts, even when documents post at the same time.
A document that loses the claim is not sent:

- from the same supplier (same VAT number, or the same name when either has
  no VAT number) it is marked a duplicate of the holder (`failed`);
- from another supplier it is held with accounting status `needs_review`
  (possible duplicate invoice number from a different supplier). Retrying it
  (`POST /accounting/invoices/{id}/retry`) is the user's decision that it is
  a separate invoice: it is then sent as its own bill, under its own claim
  and idempotency key.

The claim is kept after a successful post and released only when the
provider refuses the bill for good, so a retry can take it.

- **Xero**: see [Xero](#xero) below: a draft bill (`ACCPAY` invoice in
  `DRAFT`; a credit note becomes a draft `ACCPAYCREDIT` credit note), never
  approved or paid, created only after the workspace chooses the
  organisation, completes setup and opts in.
- **QuickBooks Online**: see [QuickBooks Online](#quickbooks-online) below:
  an open, unpaid `Bill` (a credit note becomes a `VendorCredit`), created
  only after the workspace completes setup and opts in.

Both post the extracted line items only when every line has an amount and they
add up to the net total (within 0.01); otherwise the bill carries a single line
for the net total, so a bill never understates the invoice. A line whose
quantity times unit price (to 2dp) is not its total is sent as quantity 1 at
its total, so the amount the provider computes matches the amount checked.

Provider validation errors (Xero `ValidationErrors`, QuickBooks `Fault`) are
kept on the invoice with what to change, redacted
(`redactOperationalText`); provider credentials never reach InvoiceWise, so no
error can carry them. Missing organisation, supplier or setup is permanent;
Nango `424` (provider or token refresh failure), `429` and `5xx` are retried by
the workflow runner with the same idempotency key, and a `401`/`403` asks the
admin to reconnect. A record that posts but whose attachment fails stays
posted: its attachment status is `queued` while a separate
`attach-accounting-document` job retries only the upload, or `failed` with the
reason once that is exhausted or the provider refused the file. The
per-invoice delivery retry and `POST /accounting/invoices/{id}/retry` re-drive
a failed attachment on its own (`attachment_queued`); neither posts the record
again.

## Xero

**States.** A bill is an `ACCPAY` invoice and a credit note an
`ACCPAYCREDIT` credit note, both created in `DRAFT`: they wait in Xero's
*Bills to pay → Draft* for someone to approve them, and InvoiceWise never
approves, pays or allocates anything. Nothing is created on processing
until an owner or admin completes the setup and switches on **Create bills
automatically** in Settings → Accounting, confirming the organisation by
name and ID (the same opt-in as [QuickBooks](#quickbooks-online), re-checked
when each post runs).

**Connecting and the organisation.** One Xero authorisation can reach
several organisations (the user ticks them on Xero's consent screen). On
Connect UI's `connect` event the API checks the connection's workspace tag,
lists the organisations the authorisation reaches (Xero's own
`GET /connections`, through the proxy), binds the one Nango recorded
(`tenant_id`), and reads it with that tenant header, so it is proven to
answer. Settings → Accounting shows "Company: name (ID …)"; when the
connection reaches more than one, the admin chooses the organisation bills
go to (`accounting.selectOrganisation`, REST
`PUT /accounting/connections/xero/organisation` with `{ "organisationId" }`),
and only one the connection reaches. Choosing another organisation clears the
account, tax rates and opt-in, because they belong to the organisation. A
reconnect keeps the chosen organisation, its setup and opt-in while the new
authorisation still reaches it; otherwise it starts over. Each posted invoice
records the organisation it was posted to, and a bill update or attachment
retry for an invoice posted to another organisation is refused, as for
QuickBooks. **Check** reports `ok`, `unavailable` (Nango, a token refresh or
Xero failing or throttling) or `reconnect` (the connection is gone, Xero
refuses the authorisation, or the chosen organisation is no longer
authorised).

**Mapping** (`xeroContext`), all with provider-supported values read live:

| Invoice | Xero |
| --- | --- |
| Supplier name | `Contact` by name (Xero names are unique ignoring case; archived contacts included in the search), else created with that name. An archived contact is refused with the fix. |
| Lines | Extracted lines, or one net line (see below), each on the **account the admin chose** (`AccountCode`, required setup; active `EXPENSE`-class accounts with a code), `LineAmountTypes: Exclusive`. |
| Tax | One purchase `TaxType` per line: the active rate that can apply to expenses and whose effective rate reproduces the invoice's tax on its net (to a penny a line), preferring the rates the admin ticked where several share a rate (0% zero-rated, exempt, no VAT). An ambiguous or unmatched rate (including mixed-rate invoices) is refused rather than guessed. |
| Currency | `CurrencyCode`: the base currency, or one added in Xero's currency settings; any other is refused with the fix. |
| Invoice number | `InvoiceNumber` (a bill's *Reference* in Xero) or `CreditNoteNumber`. |
| Dates | `Date`, `DueDate` (bills). |
| Credit note | Draft `ACCPAYCREDIT` credit note with the amounts credited (positive), same mapping. |
| Source document | Attachment on the record, by file name. |
| Link back | A bill's `Url` is the invoice's page in InvoiceWise (Xero shows it as *Go to InvoiceWise*), from `BETTER_AUTH_URL`. |

Setup choices live in `accounting_connections.settings` (`expenseAccountId`
holds the account code, `taxCodeIds` the tax types) and are checked against
the live organisation when saved; the REST routes are those under
[Connecting](#connecting).

**Business idempotency.** Every create carries
`Idempotency-Key: <posting key>` (per workspace, document type and number),
so Xero replays the original response to a repeated request. Because that
replay window is Xero's, a create is also preceded by a lookup of the same
number from the same contact that is not deleted or voided and carries
InvoiceWise's key: a bill's `Url` holds it (`posting=<key>`), written in the
same create, and a credit note, which has no `Url`, gets it as a history
note right after it is created. A retry long after an ambiguous timeout, or
a repeated delivery of the same invoice, therefore finds the record instead
of adding one, and a same-numbered record from that contact that InvoiceWise
did not create is refused ("check whether it is this invoice"). The one gap
is a credit note whose create answer was lost before its history note was
written and whose retry comes after Xero's replay window: it is refused for
a person to check rather than duplicated. The attachment upload first lists
the record's attachments and skips a file of the same name, so a retried
upload (including one whose answer was lost) never adds a copy. Nango
refreshes the token before proxied calls and retries nothing itself
(`Retries: 0`), so each retry is InvoiceWise's, under the same keys.

**Links.** Bills open at
`https://go.xero.com/AccountsPayable/Edit.aspx?InvoiceID=<id>`, credit notes
at `https://go.xero.com/AccountsPayable/ViewCreditNote.aspx?creditNoteID=<id>`
(the user's current Xero organisation must be the one posted to).

## QuickBooks Online

**States.** QuickBooks Online has no draft or "awaiting approval" bill:
the API creates a `Bill` that is open with its full amount as the unpaid
balance, and a `VendorCredit` for a credit note. InvoiceWise never creates a
payment, so the outcome is always an unpaid, unapproved-for-payment bill the
customer pays in QuickBooks. Because that is not a draft, a QuickBooks
connection creates nothing on processing until an owner or admin switches on
**Create bills automatically** in Settings → Accounting, which requires the
setup below and confirming the company by name and ID
(`accounting_connections.auto_post_enabled_at` / `_by`). When it is off,
nothing is created automatically. An invoice whose queued post was stopped
can still be sent from that invoice. Invoices processed while it is off show
accounting as not scheduled, and a post already queued when it is switched
off runs but creates nothing: it settles `cancelled` with that reason, and a
person's retry of that invoice sends it (the retry is marked explicit in the
job payload; releasing a held invoice is not, and follows the opt-in). A
Xero connection follows the same opt-in (see [Xero](#xero)).

**Connecting and the company.** On Connect UI's `connect` event the API
checks the connection's workspace tag, then reads the company through the
proxy (`CompanyInfo`) and stores its realm ID and name; Settings shows
"Company: name (ID …)". Reconnecting to the same company keeps the settings
and opt-in; a connection to a different company clears both. A reconnect
deletes the Nango connection it replaced. Each posted invoice records the
company it was posted to (`inbox.accounting_organisation_id`); a bill update
or attachment retry for an invoice posted to another company than the
connected one is refused (QuickBooks IDs restart in every company, so the
same ID names another record there), and the record must be changed in that
company by hand. A company not recorded (a connection or post made before
companies were recorded) is treated as unknown and not refused; a health
check records the company on such a connection. Deleting the replaced Nango
connection is best effort: a failure is logged and the reconnect still
succeeds. **Check** runs a
live health check (the Nango connection exists and the company answers):
`ok`, `reconnect` (authorisation gone, refused or a different company) or
`unavailable` (Nango or QuickBooks down or throttling), stored with its time
and reason. **Reconnect** reruns Connect UI for the same provider.

**Mapping** (`quickBooksContext`):

| Invoice | QuickBooks |
| --- | --- |
| Supplier name | `Vendor` by exact `DisplayName` (active or inactive), else created with that name (and the invoice currency when multicurrency is on). A name QuickBooks reserves for a customer or employee, an inactive vendor, or a vendor in another currency is refused with the fix. |
| Lines | Extracted lines, or one net line (see below), each `AccountBasedExpenseLineDetail` on the **expense account the admin chose** (required setup). |
| Tax, companies outside the US | `GlobalTaxCalculation: TaxExcluded` and one purchase `TaxCodeRef` per line: the active purchase tax code whose rate reproduces the invoice's tax on its net (to a penny a line), preferring the codes the admin ticked where several share a rate (0% zero-rated vs exempt). An ambiguous or unmatched rate (including mixed-rate invoices) is refused rather than guessed. |
| Tax, US companies | No tax code (US bills carry none); when the posted lines are net of tax, the invoice's tax is its own line on the same account, so the bill total equals the invoice total. When the lines match neither the net nor the gross total, the bill is refused rather than understated. |
| Currency | Must be the home currency unless multicurrency is on, then `CurrencyRef`. |
| Invoice number | `DocNumber`, cut to QuickBooks' 21 characters, with the full number in `PrivateNote` when cut. |
| Dates | `TxnDate`, `DueDate` (bills). |
| Credit note | `VendorCredit` with the amounts credited (positive), same mapping. |
| Source document | `Attachable` linked to the record. |

Setup choices live in `accounting_connections.settings` and are checked
against the live company when saved (`accounting.setup`,
`accounting.updateSettings`; REST `GET /accounting/connections/quickbooks/setup`,
`PUT /accounting/connections/quickbooks/settings`,
`POST /accounting/connections/quickbooks/health-check`).

**Business idempotency.** Every create carries
`requestid=<idempotency key>` (at most 50 characters; longer keys such as a
correction's are hashed), so QuickBooks replays the original response to a
repeated request. Because that replay window is QuickBooks', a create is also
preceded by a lookup of the same `DocNumber` from the same vendor whose
`PrivateNote` holds the key: a retry long after an ambiguous timeout finds the
record instead of adding one, and a same-numbered record from that vendor that
InvoiceWise did not create is refused ("check whether it is this invoice").
The attachment upload first checks for an `Attachable` already linked, so a
retried upload (including one whose answer was lost) never adds a copy. Nango
refreshes the token before proxied calls and retries nothing itself
(`Retries: 0`), so each retry is InvoiceWise's, under the same keys.

**Links.** Bills open at `<host>/app/bill?txnId=<id>`, vendor credits at
`<host>/app/vendorcredit?txnId=<id>`.

## Updating a bill after a correction

A posted invoice keeps its provider ID for good. When a user corrects it and
an admin chooses to update the bill (see
[Corrections](delivery.md#corrections)), the `update-accounting-bill` job
sends the corrected invoice to the **same** bill (`updateProviderBill`):

- **Xero**: `POST /Invoices/{InvoiceID}` (or `/CreditNotes/{CreditNoteID}`)
  with the same mapping (contact, number, dates, currency, account and tax
  lines); the status is left as it is, so an approved bill stays approved,
  Xero refuses a bill it no longer lets anyone edit (paid or voided), and a
  correction that changes the document type is refused.
- **QuickBooks**: the bill (or vendor credit) is read for its `SyncToken`,
  then a sparse update of the same `Id` with the same mapping; a correction
  that changes the document type is refused.

The request carries `invoicewise-update:<correction id>:<attempt>` as its
idempotency key, so the runner's retries after an ambiguous timeout replay the
update. A retryable failure is retried by the runner and, once exhausted, is a
failed delivery an admin can retry; each such retry bumps the attempt, so the
provider applies the same values afresh instead of replaying the failure; a refusal, a different provider connected since, or a
corrected invoice that could no longer be posted fails for good with the
reason. The update never creates a bill.

Each record links to the provider's own page: Xero as [above](#xero),
QuickBooks as above (`https://app.qbo.intuit.com`, or the sandbox host for a
connection made through a sandbox integration).

## Connecting

1. An admin opens **Settings → Accounting** and chooses Connect.
2. The API creates a Nango connect session tagged `workspace_id=<team>` and
   limited to that provider's integration.
3. The dashboard opens Nango Connect UI (`@nangohq/frontend`) with the session
   token, the public API URL and the Connect UI host from the session's
   `connect_link` (`https://nango-connect.invoicewise.uk`); a session without
   one is refused rather than falling back to Nango Cloud. The provider
   consent screen runs in a popup and returns to Nango's callback.
4. On Connect UI's `connect` event the API verifies the connection carries this
   workspace's tag and the configured integration, reads the organisation it
   reaches through the proxy, then stores the connection ID and organisation
   in `accounting_connections`. One connection is active per workspace.
5. The admin chooses the organisation (Xero, when the authorisation reaches
   several), the account and tax codes, and switches on automatic posting,
   confirming the organisation. Until then nothing is posted automatically.
6. Disconnect deletes the Nango connection and marks the local row
   disconnected. Reconnect reruns Connect UI and deletes the connection it
   replaced.

Settings → Accounting shows each provider as connected (with its
organisation, health and last check), as connectable, or as *not set up for
InvoiceWise yet* when its Nango settings or integration are missing. That
last read is Nango answering that the integration does not exist, so it is
not counted as a provider failure in `/ops/metrics`.

Nango refreshes access tokens on its own schedule and before proxied calls; a
refresh the provider refuses surfaces as a retryable `424` until the user
reconnects.

The same operations are REST endpoints for API clients:

- `GET /accounting/connections`
- `POST /accounting/connect-sessions` with `{ "provider": "xero" }`
- `POST /accounting/connections` with the provider and the connection ID from
  the Connect UI event
- `DELETE /accounting/connections/:provider`
- `GET /accounting/connections/:provider/setup`,
  `PUT /accounting/connections/:provider/settings` (`expenseAccountId`,
  `taxCodeIds`, `autoPost`, `confirmOrganisationId`),
  `PUT /accounting/connections/xero/organisation` (`organisationId`) and
  `POST /accounting/connections/:provider/health-check`
- `POST /accounting/invoices/:id/retry` (also posts an invoice that has no
  post yet, such as one processed while automatic posting was off)

`GET /invoices/:id/delivery-status` returns webhook deliveries plus the
invoice's `accounting` posting status, provider ID, error, retryability,
revision and timestamps.

A post is scheduled in the same transaction that completes processing, while
an accounting connection is active and opted in to automatic posting and the
workspace's [delivery rules](delivery.md#delivery-rules) let the invoice
through. Its status is `queued` until it settles as
`posted`, `already_posted`, `failed` (after the final attempt, or at once
when validation blocks it; earlier failures keep it `queued` with the last
error), `needs_review` (held as a possible duplicate, above) or `cancelled`
(the connection was disconnected, automatic posting was switched off or the
invoice deleted before it ran). The
per-invoice delivery retry re-drives `failed`, `needs_review` and `cancelled`
posts the same way this route does; neither re-posts an invoice whose current
revision the delivery rules hold. Reprocessing an invoice
never posts a second bill, and a correction of a posted invoice keeps its
bill or updates it in place (above). See
[Processing-to-delivery handoff](delivery.md#processing-to-delivery-handoff).

## Local proof (test-only stub)

The only Nango stand-ins are test code: `src/accounting-providers.test.ts`
(the Xero and QuickBooks request shapes, mapping, idempotency and error
handling, against the stateful fakes in `src/xero-fake.ts` and
`src/quickbooks-fake.ts`), `src/verify-accounting.ts`, `src/verify-xero.ts`
and `src/verify-quickbooks.ts`, which `bun run verify` runs against loopback
stubs. Verification pins `NANGO_BASE_URL` to loopback, so it can never reach a
real Nango.

`verify-accounting.ts` stores a workspace-bound connection, posts a Xero draft
bill through the proxy with its attachment, refuses a duplicate, retries an
ambiguous timeout with the same idempotency key and gets the original bill,
refuses an invoice whose total does not reconcile without calling the
provider, sends exactly one bill for copies of one invoice (processed out of
order, posting concurrently, or read with and without the VAT number), holds
another supplier's same-numbered invoice for review, then disconnects.

`verify-xero.ts` runs the real processing, scheduling and workflow runner
against a fake authorisation reaching two organisations: another
workspace's connection is refused and the organisation Nango bound is
recorded; nothing posts before the setup, the admin chooses the other
organisation (one the connection does not reach is refused), and incomplete,
unconfirmed or foreign choices are refused; then an ambiguous timeout (inside
Xero's replay window, and again after it with the worker retrying later),
throttling followed by a failed token refresh, a failed and a lost upload,
and a refused upload retried explicitly each end as exactly one draft bill
with one attachment, in the chosen organisation only; a currency the
organisation does not use is refused with the fix; the opt-in switched off
under a queued post creates nothing until a person sends it; a credit note
becomes one draft credit note with its link and is corrected in place; a
record from the other organisation is never updated or attached; the health
check reports ok, unreachable and a withdrawn organisation; a reconnect
keeps the organisation and opt-in and deletes the old connection; disconnect
revokes the Nango connection.

`verify-quickbooks.ts` runs the real processing, scheduling and workflow
runner: another workspace's connection is refused and the company is
recorded; nothing posts before the opt-in, and incomplete or unconfirmed
opt-ins are refused; then an ambiguous timeout, throttling followed by a
failed token refresh, a failed and a lost upload, and a refused upload retried
explicitly each end as exactly one bill with one attachment; a credit note
becomes one vendor credit with its link; the health check reports ok,
unreachable and reconnect; disconnect revokes the Nango connection.

## Sandbox proof

With a provider app, its Nango integration and a connection to a sandbox
company, run from `packages/jobs`:

```bash
NANGO_BASE_URL=https://nango.invoicewise.uk \
NANGO_XERO_INTEGRATION_ID=xero NANGO_QUICKBOOKS_INTEGRATION_ID=quickbooks \
  infisical run --env prod -- bun run prove:accounting-sandbox quickbooks <connection id>
```

It uses synthetic records only. It forces a token refresh. For Xero it
refuses any organisation that is not a Xero Demo Company
(`XERO_PROOF_TENANT_ID` picks it when the connection reaches several), chooses
account `429` or the first expense account (`XERO_PROOF_ACCOUNT_CODE`) and
the first purchase tax rate above 0% (`XERO_PROOF_TAX_TYPE`), posts a draft
bill whose create reaches Xero but whose answer is dropped, retries it and
gets that bill, replays the raw create under the same `Idempotency-Key`,
delivers the same invoice again (found by number, contact and key), uploads
the PDF with its answer dropped and retries the upload twice on its own,
posts and repeats a draft credit note, then counts what Xero holds per
reference. For QuickBooks it
chooses the first expense account (or `QUICKBOOKS_PROOF_ACCOUNT_ID`), posts a
bill whose create reaches QuickBooks but whose answer is dropped, retries it
and gets that bill, replays the raw create under the same `requestid`, uploads
the PDF with its answer dropped and retries the upload twice on its own, posts
and replays a vendor credit, then counts what QuickBooks holds per reference.
It exits non-zero unless the token refreshed, each reference has exactly one
record (Xero: in `DRAFT`) with one attachment, and every retry and repeated
delivery returned the original. Its output is the evidence: the organisation,
record IDs and links, never a credential.

### Xero Demo Company connection

Xero's Demo Company is free and resettable (Xero → My Xero → Try the Demo
Company, or reset it there). Connecting it needs a person signed in to Xero:
an admin of a test workspace chooses **Connect** for Xero in Settings →
Accounting, signs in on Xero's consent screen, ticks the Demo Company, and
then chooses it, account `429` and the tax rates in the setup. The proof then
runs against that connection ID (Settings shows it as the connected
organisation; the Nango connection ID is on the workspace's
`accounting_connections` row).

### QuickBooks sandbox connection

The account owner authorised the Intuit app against a sandbox company in
Intuit's OAuth playground; its refresh token and company ID are in Infisical
(`INTUIT_SANDBOX_REFRESH_TOKEN`, `INTUIT_SANDBOX_REALM_ID`). An operator
imports that authorisation into Nango as an ordinary connection, so the proof
and a test workspace use exactly the customer path (Nango refresh and proxy)
without a Connect UI sign-in:

```bash
infisical run --env prod -- bun run quickbooks:sandbox-connection import <workspace id>
infisical run --env prod -- bun run quickbooks:sandbox-connection sync
```

(with `NANGO_BASE_URL` and `NANGO_QUICKBOOKS_INTEGRATION_ID` as above).
`import` mints an access token from the refresh token, writes a rotated
refresh token back to Infisical before anything else, and upserts connection
`quickbooks-sandbox` tagged with the workspace allowed to bind it (that
workspace's admin then binds it like any connection). It refuses an
integration that is not `quickbooks-sandbox`, so it cannot bind a real
company, and customers have no path to it. Intuit rotates refresh tokens and
Nango stores each new one; `sync` copies Nango's current refresh token back
to Infisical so the stored value stays live. Tokens pass through deleted
mode-600 files and are never printed.

## Status (2026-09-25)

Proven live on production Nango: TLS on both hosts, the admin API refused on
the public host, connect sessions with the `prod` secret key, and a complete
Connect UI connection through `nango-connect.invoicewise.uk` (with a temporary
no-credential integration, removed afterwards) found by its workspace tag and
not by another workspace's.

**QuickBooks** (sandbox): the `quickbooks` integration was created on
`quickbooks-sandbox` from the Intuit development keys with
`nango:configure-integration`, the owner's sandbox authorisation imported as
`quickbooks-sandbox` (tagged for no real workspace), and the sandbox proof
passed against the US sandbox company: token refreshed through Nango, a bill
whose create answer was dropped recovered as the same bill (`requestid`
replay returned it too), its PDF attached once after a dropped upload answer
and two separate retries, a vendor credit created once, and one record per
reference with an open balance equal to the invoice total. A UK (purchase
tax) company is proven against the fake only, since the sandbox company is
US.

Still waiting on the account owner: Intuit's production approval and keys
(then the integration moves to the `quickbooks` provider, above).

**Xero**: the `xero` integration was created on production Nango from the
app credentials in Infisical with `nango:configure-integration xero` (a rerun
updates it in place), with the scopes above. Nango's OAuth start for a
connect session sends the browser to Xero's authorize endpoint with
`redirect_uri=https://nango.invoicewise.uk/oauth/callback`, which Xero
currently refuses as `invalid_request: Invalid redirect_uri`: the Xero app
must list that redirect URI (developer.xero.com → the app → Configuration).
Waiting on the account owner for that and for a Xero sign-in to connect the
Demo Company, after which the [Demo Company proof](#xero-demo-company-connection)
runs. Everything else is proven against the fake (`verify-xero.ts`).
