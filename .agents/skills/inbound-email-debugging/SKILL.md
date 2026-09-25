---
name: inbound-email-debugging
description: Use when mail sent to a workspace's <local>@in.invoicewise.uk address bounces, is deferred, never shows up or is processed wrongly, or when deploying or changing the Cloudflare Email Worker (apps/inbound-email) or its routing. Gives the trace path from DNS to Worker to API to job, the Cloudflare API gotchas, and a live test recipe.
---

# Debugging the dedicated receiving address

The contract (address scheme, refusals, signing, ack and retry, dedupe, limits, Cloudflare setup, going live, observed header layout) is `docs/inbound-email.md`.
This skill is the trace order and the operational gotchas around it.

## Trace one message

1. **DNS.** `dig +short MX in.invoicewise.uk` lists `route1/2/3.mx.cloudflare.net`, and `dig +short MX invoicewise.uk` still lists Purelymail. If the apex MX moved, transactional mail from `auth@invoicewise.uk` breaks too.
2. **The sender got `550 5.1.1 Unknown recipient`** (a Purelymail sender sees it wrapped as `555 5.7.1 550 5.1.1 …` from `route*.mx.cloudflare.net`): the API refused the recipient. The address is unknown, rotated away, belongs to a deleted workspace, or carries a `+tag` subaddress, which is refused by design. Check `inbound_email_addresses` (`local_part`, `revoked_at`).
3. **The sender reports a deferral or retries:** the Worker got a temporary answer from the API: `401` after a secret change on one side only, a 5xx, the API down, or `411`. Stream Worker logs with `bunx wrangler@4 tail invoicewise-inbound-email`. If every message gets `411`, something on the Cloudflare edge, tunnel or kamal-proxy path dropped `Content-Length`.
4. **Accepted:** one `inbound_emails` row per workspace and message; `delivery_count` rises on redelivery while there is still one invoice. `status` moves from `received` to processed or failed; `detail` holds the reason; `raw` (the MIME source) is kept only for failed messages. The invoice's reference is `email:mid:<Message-ID>:<n>`.
5. **Processing:** a `process-inbound-email` job feeds the shared intake, which queues `process-attachment`. An operator retry re-opens the kept MIME source (`docs/operations.md#recovery`).
6. **Settings > Email shows no address:** `INBOUND_EMAIL_LIVE` is not `true` in the API's Infisical environment. The address is still provisioned and mail still works. The marketing site reads the same flag from Vercel and needs a redeploy after a change.

## Cloudflare changes

- There may be no general-purpose Cloudflare API token on the machine you work from. `wrangler deploy` needs a token that can edit Workers scripts; without one, build the bundle with `bunx wrangler@4 deploy --dry-run --outdir <dir>` (from `apps/inbound-email`) and upload it through the Cloudflare API or dashboard with whatever account access exists.
- Enable Email Routing for the **subdomain only**: `POST /zones/<zone_id>/email/routing/dns` with body `{"name":"in.invoicewise.uk"}`. Never call `/zones/<zone_id>/email/routing/enable` for the zone: the apex MX belongs to Purelymail. The zone's Email Routing page then reports the apex as misconfigured, which is expected and harmless.
- The rule is one catch-all on the subdomain to the Worker; never add per-address rules (`apps/inbound-email/cloudflare-routing.json` is the desired state).
- First rollout order: store `INBOUND_EMAIL_SECRET` in Infisical, deploy the API (its preflight requires the secret), then the Worker and its secret, then the routing rule. That way the Worker never posts to an endpoint that does not exist yet.
- Handle secret values through `infisical run … | wrangler secret put` as the doc shows, or a mode-600 file deleted immediately; never print them.
- Staging's receiving domain is deliberately unrouted: staging never receives real mail.

## Live test

- Use a throwaway workspace (`production-live-proof` skill). Open its Settings > Email once to provision the address, then read it from `inbound_email_addresses`.
- Send from a real mailbox on another domain, so SPF, DKIM and DMARC appear as pass in Cloudflare's headers. Mail from `invoicewise.uk` itself proves less.
- Test dedupe by resending the identical `.eml` with the same Message-ID, e.g. `swaks --server <sender smtp> --auth … --data message.eml`.
- The Gmail forwarding-confirmation check trusts only the result headers directly under Cloudflare's own topmost `Received` header. If Cloudflare changes its layout, genuine confirmations quietly read as ordinary mail (it fails safe). Re-record the layout from a failed message's `raw`; a MIME message nested deeper than 32 levels fails on purpose and keeps its source.

## Pointers

- `apps/inbound-email/src/handler.ts`, `src/worker.ts`, `wrangler.toml`
- `apps/api/src/inbound-email/http.ts` (signature, clock window, body bound)
- `packages/jobs/src/inbound-email.ts` (recipient parsing, identity, `isGoogleSigned`), `packages/jobs/src/workflows.ts`
- Tests listed in `docs/inbound-email.md#tests`
