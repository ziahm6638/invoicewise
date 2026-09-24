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
failing at connect time.

## Provider apps and Nango integrations

Each provider needs a developer app whose redirect URI is
`https://nango.invoicewise.uk/oauth/callback`. Its client ID and secret go into
a Nango integration, created in the Nango admin dashboard (reached over SSH,
see deployment.md) under the `prod` environment:

| Integration unique key | Nango provider | Scopes |
| --- | --- | --- |
| `xero` | `xero` | `offline_access accounting.invoices accounting.contacts accounting.attachments` (apps created before March 2026 may use `accounting.transactions` in place of `accounting.invoices`) |
| `quickbooks` | `quickbooks` (production companies) or `quickbooks-sandbox` (sandbox companies) | `com.intuit.quickbooks.accounting` |

Nango records the organisation at connect time: Xero's `tenant_id` (its
`xeroPostConnection` script) and QuickBooks' `realmId` (from the OAuth
callback). The bill adapters read them from the connection.

## What each provider receives

- **Xero**: an `ACCPAY` invoice in `DRAFT` (a bill awaiting approval, never
  approved or paid), contact by supplier name, line items, amounts exclusive
  of tax. The request carries
  `Idempotency-Key: invoicewise:<invoice UUID>`, so a retried post returns the
  original bill. The source document is then uploaded to the bill's
  attachments by file name (a repeat replaces it rather than duplicating it).
- **QuickBooks Online**: QuickBooks has no draft bill, so an open, unpaid
  `Bill`. The vendor is found by display name or created; lines post to the
  first expense account; `requestid=invoicewise:<invoice UUID>` makes the
  create idempotent. The document is uploaded as an `Attachable` linked to the
  bill unless one already is.

Both post the extracted line items only when every line has an amount and they
add up to the net total (within 0.01); otherwise the bill carries a single line
for the net total, so a bill never understates the invoice.

Provider validation errors (Xero `ValidationErrors`, QuickBooks `Fault`) are
kept verbatim on the invoice. Missing organisation or supplier is permanent;
Nango `424` (provider or refresh failure), `429` and `5xx` are retried by the
workflow runner with the same idempotency key. A bill that posts but whose
attachment fails is recorded as posted and logs the attachment error.

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
   workspace's tag and the configured integration, then stores the connection
   ID in `accounting_connections`. One connection is active per workspace.
5. Disconnect deletes the Nango connection and marks the local row
   disconnected.

Nango refreshes access tokens on its own schedule and before proxied calls; a
refresh the provider refuses surfaces as a retryable `424` until the user
reconnects.

The same operations are REST endpoints for API clients:

- `GET /accounting/connections`
- `POST /accounting/connect-sessions` with `{ "provider": "xero" }`
- `POST /accounting/connections` with the provider and the connection ID from
  the Connect UI event
- `DELETE /accounting/connections/:provider`
- `POST /accounting/invoices/:id/retry`

`GET /invoices/:id/delivery-status` returns webhook deliveries plus the
invoice's `accounting` posting status, provider ID, error and timestamps.

## Local proof (test-only stub)

The only Nango stand-ins are test code: `src/accounting-providers.test.ts` (the
Xero and QuickBooks request shapes, idempotency and error handling) and
`src/verify-accounting.ts`, which `bun run verify` runs against a loopback
stub. It stores a workspace-bound connection, posts a Xero draft bill through
the proxy with its attachment, refuses a duplicate, retries an ambiguous
timeout with the same idempotency key and gets the original bill, then
disconnects. Verification pins `NANGO_BASE_URL` to loopback, so it can never
reach a real Nango.

## Sandbox proof

Once a provider app and its Nango integration exist, connect a sandbox company
(Xero's Demo Company, or an Intuit sandbox company with the
`quickbooks-sandbox` provider) from **Settings → Accounting**, take the
connection ID from the Nango dashboard, and run from `packages/jobs`:

```bash
NANGO_BASE_URL=https://nango.invoicewise.uk \
NANGO_XERO_INTEGRATION_ID=xero NANGO_QUICKBOOKS_INTEGRATION_ID=quickbooks \
  infisical run --env prod -- bun run prove:accounting-sandbox xero <connection id>
```

It forces a token refresh, posts a draft bill with the synthetic invoice PDF
attached, replays the same idempotency key, and prints the organisation, the
token expiry before and after, the bill ID and whether the replay returned the
same bill. It exits non-zero unless all three hold.

## Status (2026-09-24)

Proven live on production Nango: TLS on both hosts, the admin API refused on
the public host, connect sessions with the `prod` secret key, and a complete
Connect UI connection through `nango-connect.invoicewise.uk` (with a temporary
no-credential integration, removed afterwards) found by its workspace tag and
not by another workspace's.

Not yet proven live, because neither developer app can be registered without
the account owner:

- **Xero**: the owner signs in at developer.xero.com with the business's Xero
  login, creates a *Web app* named InvoiceWise with redirect URI
  `https://nango.invoicewise.uk/oauth/callback`, and hands over the client ID
  and secret (into Infisical as `XERO_CLIENT_ID` / `XERO_CLIENT_SECRET`, for
  the `xero` Nango integration). The Demo Company in the same login serves as
  the sandbox.
- **QuickBooks**: the owner signs in at developer.intuit.com with the
  business's Intuit account, creates an app with the Accounting scope and
  redirect URI `https://nango.invoicewise.uk/oauth/callback`, and hands over
  the development keys (sandbox) and, after Intuit's production review, the
  production keys (`QUICKBOOKS_CLIENT_ID` / `QUICKBOOKS_CLIENT_SECRET`). Intuit
  creates a sandbox company with the developer account.

With those, the sandbox proof above covers connect, token refresh and the
draft-bill round trip for each provider.
