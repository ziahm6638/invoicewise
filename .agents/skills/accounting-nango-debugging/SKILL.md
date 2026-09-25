---
name: accounting-nango-debugging
description: Use when Xero or QuickBooks connect, posting, attachments or the "not available yet" state misbehave, when operating the self-hosted Nango, or when changing accounting adapter code in packages/jobs. Gives a layer-by-layer check from Settings through Nango to the provider, plus provider gotchas learned in sandbox proofs.
---

# Debugging accounting delivery through self-hosted Nango

The contract is `docs/accounting-integrations.md` (configuration, provider apps, connecting, posting, proofs, status) and operation is `docs/deployment.md#nango`.
This skill adds the checks and gotchas those docs do not collect in one place.

## Check the layers in order

1. **Is Nango up?** `curl -fsS https://nango.invoicewise.uk/health` answers `{"result":"ok"}`; logs with `infisical run --env prod -- kamal accessory logs nango`. The admin dashboard is reachable only through the SSH tunnel in the runbook.
2. **Can the API reach it with the right key?** From inside the api container:
   ```bash
   infisical run --env prod -- kamal app exec --roles api --reuse --interactive sh
   # then, inside the container:
   bun -e 'const r = await fetch(process.env.NANGO_BASE_URL + "/integrations/xero", { headers: { authorization: "Bearer " + process.env.NANGO_SECRET_KEY } }); console.log(r.status)'
   ```
   200 means the integration exists. 404 means it was never created: run `nango:configure-integration` (never create it in the dashboard). 401 means the API and the Nango accessory disagree on the key: reboot the accessory, then deploy the API (the key is shared).
3. **Settings > Accounting says "not available yet":** Nango settings are missing on the API or the integration does not exist. That is Nango answering "no such integration", not a provider failure, so it is not counted in `/ops/metrics`.
4. **The provider's consent popup fails:** Xero's `invalid_request: Invalid redirect_uri` means the provider app does not list `https://nango.invoicewise.uk/oauth/callback`. Only the developer-app owner can add it; it is not a code bug.
5. **Connected, but nothing posts:** posting needs the admin's setup and confirmed opt-in (`auto_post_enabled_at`, re-checked when the post executes), and the workspace's delivery rules must let the invoice through. Read `GET /invoices/:id/delivery-status` (`accounting` block). A `424` means the provider refused the token refresh: the user reconnects.

## Provider gotchas

- **QuickBooks record IDs are small integers that restart in every company.** Never update or attach to a bill by provider ID alone: compare the organisation recorded when it was posted (`inbox.accounting_organisation_id`) with the current connection. Without that check, a reconnect to another company overwrote an unrelated bill with the same ID. Keep the check in any new update or attachment path.
- **Intuit rotates the refresh token on every refresh.** Anything that refreshes outside Nango must persist the new token at once (the sandbox import writes it back to Infisical before anything else); a lost token kills the sandbox authorisation. Access tokens last an hour: never store them.
- **Intuit development keys reach sandbox companies only.** Real companies need Intuit's production approval and keys, then the provider switch in the docs. Switching an integration's provider deletes every connection under it.
- **Xero** creates DRAFT bills, and one authorisation can reach several organisations, so every call sends the chosen `Xero-Tenant-Id`. A live proof needs the free Demo Company and a person signed in to Xero; creating a Xero account needs a real phone number, so automation cannot sign up.
- **Gmail and Outlook through Nango** need a Google OAuth client and a Microsoft Entra app entered into Nango with the same callback URL; self-hosted Nango supplies none.
- **Opt-in off:** an invoice processed while automatic posting is off gets no post status at all, so the dashboard's Retry delivery does not offer it; the REST retry route treats it as unsent.
- **Never change `NANGO_ENCRYPTION_KEY`:** every stored connection becomes unreadable.

## Secrets

- Provider client IDs and secrets and the sandbox tokens live in Infisical `prod` (names in `docs/deployment.md#secrets`). Read them only through `infisical run`.
- When a script must hold a value, pass it through a mode-600 file and delete the file straight after; write back with `infisical secrets set` from that file. Never echo a value, commit it or paste it into chat.

## Tests and proofs

- `bun run verify` pins `NANGO_BASE_URL` to loopback stubs; never point a test at the real Nango. The stateful fakes are `packages/jobs/src/xero-fake.ts` and `quickbooks-fake.ts`.
- Real-provider evidence comes only from `bun run prove:accounting-sandbox` (in `packages/jobs`) against sandbox companies with synthetic records (`docs/accounting-integrations.md#sandbox-proof`).

## Pointers

- `packages/jobs/src/nango.ts` (client and proxy), `accounting-providers.ts` (Xero and QuickBooks adapters), `accounting.ts` (scheduling, posting, updates)
- `packages/jobs/src/configure-nango-integration.ts`, `quickbooks-sandbox-connection.ts`, `prove-accounting-sandbox.ts`
- `docs/delivery.md#delivery-rules`, `docs/delivery.md#corrections-reprocessing-and-retries`
