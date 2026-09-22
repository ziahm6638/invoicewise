# Nango accounting integrations

InvoiceWise uses Nango Connect for Xero and QuickBooks authorization and a
Nango action for provider-specific draft-bill creation. InvoiceWise does not
store provider OAuth credentials or call either provider API directly.

## Production setup

Create Xero and QuickBooks integrations in the Nango environment, with the
scopes needed to create draft supplier bills and upload attachments. Configure
an Environment API key with `environment:connect_sessions:write`,
`environment:connections:list`, `environment:connections:delete`, and
`environment:actions:execute`, then set:

```dotenv
NANGO_SECRET_KEY=<environment API key>
NANGO_BASE_URL=https://api.nango.dev
NANGO_XERO_INTEGRATION_ID=<Xero integration unique key>
NANGO_XERO_DRAFT_BILL_ACTION=create-draft-bill
NANGO_QUICKBOOKS_INTEGRATION_ID=<QuickBooks integration unique key>
NANGO_QUICKBOOKS_DRAFT_BILL_ACTION=create-draft-bill
```

Deploy the configured draft-bill action for each integration in Nango. The
action is the provider adapter and must accept this input:

```json
{
  "idempotencyKey": "invoicewise:<invoice UUID>",
  "status": "draft",
  "supplier": { "name": "Acme Ltd", "taxNumber": "GB123456789" },
  "invoiceNumber": "INV-42",
  "invoiceDate": "2026-09-22",
  "dueDate": "2026-10-22",
  "currency": "GBP",
  "netAmount": 100,
  "vatAmount": 20,
  "grossAmount": 120,
  "lineItems": [],
  "attachment": {
    "url": "https://api.invoicewise.uk/storage/...",
    "fileName": "invoice.pdf",
    "contentType": "application/pdf"
  }
}
```

The action must always create a draft, use `idempotencyKey` through the
provider's idempotency facility or a provider-side lookup, include line items
where accepted, attach the document where supported, and return:

```json
{ "providerId": "provider bill id", "duplicate": false }
```

For an existing idempotency key it returns the original `providerId` with
`"duplicate": true`. Provider validation or transport failures should retain
the provider's useful reason in Nango's error message; InvoiceWise records that
message on the invoice.

The Connect session is tagged with `workspace_id`. After Connect UI reports a
connection, the API verifies that tag and the configured integration ID before
writing the Nango connection ID to `accounting_connections`. Provider OAuth
credentials remain in Nango. Only one accounting connection may be active per
workspace. Disconnecting deletes the Nango connection and marks the local row
disconnected.

The dashboard can use these authenticated endpoints:

- `GET /accounting/connections`
- `POST /accounting/connect-sessions` with `{ "provider": "xero" }`
- `POST /accounting/connections` with the provider and the connection ID from
  the Connect UI event
- `DELETE /accounting/connections/:provider`
- `POST /accounting/invoices/:id/retry`

`GET /invoices/:id/delivery-status` returns webhook deliveries plus the
invoice's `accounting` posting status, provider ID, error, and timestamps.

## Local proof and live-account limit

After applying migrations to the local Postgres database, run:

```bash
cd packages/jobs
bun --env-file=../../.env run verify:accounting
```

The verifier starts an HTTP stub with Nango's connect-session, connection,
action, and disconnect routes. It stores a workspace-bound connection, posts a
draft and receives its provider ID, refuses a duplicate without another Nango
call, simulates an ambiguous provider timeout, retries with the same
idempotency key and receives the original provider ID, then disconnects.

No Nango account or provider sandbox credentials were available during this
implementation. Consequently, real Connect UI OAuth, the deployed Nango action,
Xero draft/attachment behavior, and QuickBooks draft/attachment behavior have
not been verified live. Production rollout must run those four checks in the
configured Nango environment before enabling automatic posting.
