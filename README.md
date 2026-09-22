# InvoiceWise

**Invoice middleware. Extraction + delivery.**

InvoiceWise turns unstructured invoices into structured, intelligent data. Email in → TypeSafe extraction + judgments → auto-post to accounting or API/webhooks out.

## What It Is

- Middleware for invoices (not an invoicing system, not an accounting system)
- Email-first ingestion via dedicated mailboxes
- TypeSafe-powered extraction and semantic judgments
- User-defined questions that run on every invoice
- Auto-delivery to Xero/QuickBooks (via Nango) or API/MCP/webhooks

## What It Is Not

- ❌ An invoicing system (you don't create invoices here)
- ❌ An accounting system (Xero/QuickBooks stays)
- ❌ An AP approval workflow (no manual review steps required)
- ❌ A replacement for anything — it connects everything

## Core Flow

```
1. Customer gets a mailbox: invoices@acme.invoicewise.uk
2. Invoices arrive (supplier sends or customer forwards)
3. Auto-ingest from email
4. TypeSafe extracts structured data + runs judgments
5. User-defined questions run automatically
6. Auto-post to connected accounting (Nango) OR available via API/MCP/webhooks
```

Zero manual steps in the happy path.

## User-Defined Questions

Customers configure their own TypeSafe questions. These run automatically on every invoice:

```yaml
# Default questions (shipped with product)
- Is this a duplicate of a previous invoice?
- Is the VAT calculation correct?
- Does this supplier match known suppliers?
- Are bank details consistent with previous invoices?

# User-defined (examples)
- Is this over our £500 approval threshold?
- Does this look like capital or operational spend?
- Should this be allocated to multiple cost centers?
- Is this contractor charging more than their average?
```

## Roadmap Layers

| Layer | What | Status |
|-------|------|--------|
| **Layer 1: Extract + Deliver** | Email → Extract → Judgments → Deliver | MVP |
| **Layer 2: Reconcile** | Match invoices to jobs/POs, verify against authorisation | Future |
| **Layer 3: Monitor** | Patterns, contractor reliability, scope creep, anomalies over time | Future |

## Moat

- **TypeSafe** — Semantic understanding, not OCR. Competitors don't have it.
- **User-defined questions** — Customers build their own logic. Switching cost increases.
- **Accumulated intelligence** — History + patterns + questions = their invoice brain.

## Origin

Forked from [Midday](https://github.com/midday-ai/midday), an open-source business management platform. We use their email ingestion, document extraction, and matching infrastructure, replacing transaction matching with TypeSafe-powered authorisation matching.

## Stack (inherited from Midday)

- Bun
- TypeScript
- Next.js
- Postgres + Drizzle (database)
- Local filesystem storage for development; production object storage is deferred
- Supabase Auth (temporary; replacement is a separate roadmap item)
- Effect Workflows with a Postgres-backed queue
- Nango (accounting integrations) — replacing GoCardless/Plaid bank connections

## Development

See [docs/development.md](docs/development.md) for the complete local setup,
including Docker services, database migrations, and app-specific commands.

## License

AGPL-3.0 (inherited from Midday). Open source code, paid hosted service.

---

**Domain:** [invoicewise.uk](https://invoicewise.uk)
