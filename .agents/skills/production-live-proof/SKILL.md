---
name: production-live-proof
description: Use when proving a change live on app.invoicewise.uk / api.invoicewise.uk after a deploy, or checking any feature against production, with throwaway accounts and synthetic invoices. Gives the sign-up-and-verify recipe, safe test data, the evidence to keep and the full cleanup checklist.
---

# Proving a change live on production

Every production change is verified the way a user would meet it, then every trace of the test is removed.
Deploy first with the `production-deploy` skill.

## Rules

- Throwaway accounts and synthetic documents only. Never open, reprocess or read another workspace's invoices; customer diagnosis goes through the purpose-bound `/ops/*` routes (`docs/operations.md#recovery`).
- Everything you create is deleted through the app before you finish, and the deletion is checked in the database.
- Load tests, worker-kill and rollback drills run on staging only.

## Accounts

- Sign up through the real UI or `POST https://app.invoicewise.uk/api/auth/sign-up/email`, using a plus-address of the transactional sender mailbox, e.g. `auth+iw<change>-<random>@invoicewise.uk`. The verification mail is delivered back to that mailbox.
- Read the link over IMAP (Purelymail, `imap.purelymail.com:993`) as `SMTP_USER` with `SMTP_PASS`, both in Infisical `prod`. Run the reader under `infisical run --env prod --` and never print the password.
- Search IMAP by the exact `To:` address. A loose search once picked up another run's mail and left an unverified orphan account behind.
- Do not set `email_verified` directly in the production database: it skips the path you are meant to prove.
- A disposable external inbox (for example mail.tm) is fine for sign-up, and required when the test must come from outside `invoicewise.uk` (inbound-email proofs).
- Verification mail missing, or signed as `purelymail.com` instead of `invoicewise.uk`: Purelymail's stored DNS check can go stale while DNS is correct. Run Purelymail's DNS recheck for the domain and confirm MX, SPF, DKIM and DMARC pass before blaming the app.

## Test data

- Documents: `packages/documents/src/test/corpus/*.pdf` (expected values and validation outcomes in `docs/document-intake.md#validation-corpus`) and `packages/documents/src/test/fixtures/` (`uk-invoice.pdf`, `uk-invoice-scanned.pdf`, `uk-invoice-scan.png`, `uk-invoice-photo.jpg`).
- Upload through the dashboard route `POST /api/storage/upload` with the session, or `POST /v1/invoices` with an API key (`docs/api.md`).
- Each processed upload spends about 3 real TypeSafe calls from production's daily budget; upload only what the proof needs.
- Webhook receiver: `https://httpbin.org/post`, or a temporary `cloudflared tunnel --url http://localhost:<port>` receiver you control. Private and internal targets are refused by design.
- Isolation and role checks need two accounts and two workspaces.
- Accounting proofs use sandbox companies only (`accounting-nango-debugging` skill).

## Evidence to keep

- Deployed SHA, readiness, and applied migrations equal to the journal.
- Each check as request, then status or visible outcome; screenshots from an isolated browser session for UI changes.
- Existing data untouched: counts of other workspaces' invoices before and after (counts only).
- Container logs for the proof window contain none of the API keys or tokens you created (search for fragments).
- Write evidence without secrets, full tokens or real customer data.

## Cleanup checklist

1. Revoke what sits outside the workspace (OAuth apps, API keys), then delete each extra workspace (Settings, typed name) and the account (Account > Delete), or tRPC `team.delete` then `user.delete`.
2. Confirm sign-in answers 401 and the old session cookie gets 401 on `user.me`.
3. Read-only database checks return zero: users like `auth+iw<change>%`, and teams, inbox, API keys and suppliers for the workspace IDs:
   ```bash
   ssh root@100.90.24.83 docker exec invoicewise-db psql -U invoicewise -d invoicewise -Atc "select count(*) from users where email like 'auth+iw<change>%'"
   ```
4. The workspace and account `deletion_requests` complete with storage purged once the ten-minute quiesce passes (`docs/offboarding.md`).
5. Expunge the verification mails from the sender mailbox.
6. Orphans from failed attempts (for example an unverified account): resend verification, verify, delete through the app. Never delete rows with SQL.
7. Stop temporary tunnels and delete disposable external inboxes.

## Pointers

- `docs/deployment.md#after-a-deploy`, `docs/offboarding.md`, `docs/api.md#smoke-check` (`apps/api/src/public-api-smoke.ts`)
- `docs/inbound-email.md#live-proof`, `docs/data-lifecycle.md#proof`, `docs/accounting-integrations.md#sandbox-proof`
