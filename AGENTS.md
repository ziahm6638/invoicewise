# InvoiceWise — Agent Memory

This file is the project's committed home for project-intrinsic agent knowledge.

## Product Vision

InvoiceWise is **invoice middleware** — it sits between invoice receipt and downstream systems, turning unstructured invoices into structured, intelligent data.

**Core flow:**
```
Email in → TypeSafe extraction + judgments → Auto-post or API/webhooks out
```

**Three layers (roadmap):**
1. **Extract + Deliver** (MVP) — Email → Extract → Judgments → Deliver
2. **Reconcile** — Match invoices to authorisation sources (jobs, POs, contracts)
3. **Monitor** — Patterns, contractor reliability, scope creep over time

**Moat:**
- TypeSafe for semantic understanding (not OCR)
- User-defined questions (stickiness)
- Accumulated intelligence over time

## Origin: Midday Fork

This repo is forked from [midday-ai/midday](https://github.com/midday-ai/midday). Key packages we inherit:

| Package | Purpose | Keep/Modify |
|---------|---------|-------------|
| `packages/inbox` | Gmail/Outlook email connection | Keep, extend |
| `packages/documents` | PDF extraction, invoice/receipt schemas | Keep, replace AI with TypeSafe |
| `packages/jobs` | Trigger.dev background jobs | Keep, modify tasks |
| `packages/email` | Transactional email (Resend) | Keep |
| `packages/supabase` | Database client | Keep |
| `packages/db` | Drizzle queries | Modify for our schema |
| `apps/dashboard` | Next.js app | Heavy modification |
| `apps/api` | API routes | Modify |
| `apps/engine` | Cloudflare worker | Evaluate |

**Remove/ignore:**
- Bank connections (GoCardless, Plaid, Teller) — we don't need bank feeds
- Transaction matching — replaced by authorisation matching
- Time tracking, invoicing creation, vault — not our product
- Desktop/mobile apps — not MVP

## Key Modifications Needed

### 1. Replace AI with TypeSafe

Midday uses Gemini/OpenAI for extraction. We replace with TypeSafe for:
- Invoice extraction (structured data from PDFs)
- User-defined judgment questions
- Semantic matching (Layer 2)

Files to modify:
- `packages/documents/src/processors/`
- `packages/documents/src/prompt.ts`
- `packages/jobs/src/tasks/inbox/`

### 2. Add User-Defined Questions

New table: `user_questions`
- `id`, `team_id`, `question`, `type` (boolean/enum/number), `options`, `created_at`

Questions run via TypeSafe on every invoice extraction.

### 3. Replace Transaction Matching with Delivery

Midday matches receipts to bank transactions. We:
- Remove bank connection (GoCardless/Plaid)
- Add Nango for accounting integrations (Xero, QuickBooks)
- Auto-post extracted invoices to connected accounting
- Expose API/MCP/webhooks for non-connected customers

### 4. Simplify Dashboard

Strip:
- Time tracking UI
- Invoice creation UI
- Bank account connections
- Transaction categorization

Keep:
- Inbox (email connections, incoming invoices)
- Document viewer
- Settings (team, integrations)

Add:
- User-defined questions editor
- Extraction results viewer
- Delivery status

## Stack

- **Runtime:** Bun
- **Framework:** Next.js (dashboard), Hono (API)
- **Database:** Supabase (Postgres)
- **Background jobs:** Trigger.dev
- **Email ingestion:** Gmail/Outlook OAuth (from Midday)
- **AI:** TypeSafe (replacing Gemini/OpenAI)
- **Integrations:** Nango (accounting), API/MCP/webhooks

## Commands

```bash
bun install
bun dev                    # All apps
bun dev:dashboard          # Dashboard only
bun dev:api                # API only
bun jobs:dashboard         # Trigger.dev jobs
bun typecheck
bun lint
bun format
```

## Environment Variables (TBD)

```bash
# Supabase
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

# Gmail OAuth
GMAIL_CLIENT_ID=
GMAIL_CLIENT_SECRET=
GMAIL_REDIRECT_URI=

# TypeSafe
TYPESAFE_API_KEY=

# Nango
NANGO_SECRET_KEY=

# Trigger.dev
TRIGGER_SECRET_KEY=
```

## Database Schema Changes (TBD)

New tables:
- `user_questions` — user-defined TypeSafe questions
- `invoice_judgments` — results of questions per invoice
- `delivery_log` — tracking auto-posts and webhook deliveries

Modified tables:
- `inbox` — add `judgments` JSONB column
- Remove bank/transaction related tables

## Links

- **Product:** [invoicewise.uk](https://invoicewise.uk)
- **Upstream:** [github.com/midday-ai/midday](https://github.com/midday-ai/midday)
- **TypeSafe:** [typesafe.ai](https://typesafe.ai)
