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

## Stack

- Bun `1.3.13` (pinned) + TypeScript
- Next.js 15 for the dashboard and website; Hono + Effect for the API
- Postgres 17 with pgvector, accessed through Drizzle
- Better Auth for users, sessions, memberships and invitations
- Effect workflows on a Postgres-backed queue (`packages/jobs`)
- Private local filesystem storage in development, S3-compatible (MinIO/R2) elsewhere
- TypeSafe for semantic extraction and judgments
- Nango for Xero/QuickBooks delivery, Polar for billing, Resend for email

## Development

See [docs/development.md](docs/development.md) for the complete local setup,
database migrations, app-specific commands and the authoritative
`bun run verify` release check.
See [docs/delivery.md](docs/delivery.md) for REST, MCP, webhook signing and
retry behavior, and CSV export.

## License

AGPL-3.0 (inherited from Midday). Open source code, paid hosted service.

---

**Domain:** [invoicewise.uk](https://invoicewise.uk)
