# Dedicated receiving address

Roadmap issue #7. Every workspace has its own address on one receiving
subdomain. Mail sent or forwarded there goes through the same intake,
processing and delivery as an upload. Connected Gmail/Outlook mailboxes are a
separate channel (#8, `packages/inbox`).

```text
supplier / forwarding rule
  └─▶ MX in.invoicewise.uk → Cloudflare Email Routing (catch-all on the subdomain)
        └─▶ Email Worker invoicewise-inbound-email (apps/inbound-email)
              └─▶ POST https://api.invoicewise.uk/inbound/email  (HMAC-signed)
                    ├─ recipient → workspace (server-owned mapping)
                    ├─ inbound_emails row + process-inbound-email job, one transaction
                    └─ 202 ──▶ Cloudflare accepts the message (SMTP 250)
Effect worker: process-inbound-email
  └─ each supported attachment → acceptIntakeUpload (same as an upload)
        └─ process-attachment → extraction, validation, judgments → deliveries
```

## Address scheme

- Address: `<local part>@in.invoicewise.uk` (`INBOUND_EMAIL_DOMAIN`). The local
  part is 16 characters from `abcdefghjkmnpqrstuvwxyz23456789` (no look-alikes),
  about 79 bits, generated server-side. It is not derived from the workspace
  name or id, so it cannot be guessed or enumerated.
- The issue's original `invoices@{workspace}.invoicewise.uk` would need a
  wildcard subdomain with its own MX per workspace, which Cloudflare Email
  Routing does not offer. The plan of record on the issue (2026-09-24) replaces
  it with one receiving subdomain and a per-workspace local part.
- Provisioned on first read of `inboundEmail.get` (Settings → Email and the
  empty inbox), one active address per workspace
  (`inbound_email_addresses`, partial unique index on `revoked_at is null`).
- Rotation (`inboundEmail.rotate`, admin and owner) revokes the current address
  and issues a new one in one transaction under the team row lock. The old
  address is refused from that moment. Local parts are globally unique and
  never reissued, so a revoked address can never start delivering to another
  workspace.
- A `+tag` subaddress (`<local>+acme@…`) routes to the same workspace; case is
  ignored.

## Recipient mapping and refusals

The workspace comes only from the **envelope** recipient that Cloudflare
received the message for, resolved through `inbound_email_addresses` joined to
an existing `teams` row. `To:`/`Cc:` headers and anything else in the message
are never used for routing. Unknown, malformed, revoked and deleted-workspace
addresses (workspace deletion cascades to its addresses and messages) answer
`404`, which the Worker turns into a permanent SMTP rejection
(`550 5.1.1 Unknown recipient`).

Cloudflare calls the Worker once per envelope recipient, so a message sent to
two workspace addresses is two independent deliveries, each landing only in its
own workspace.

## Authenticating the provider

`POST /inbound/email` accepts only requests signed by the Worker:

| Header | Value |
| --- | --- |
| `x-invoicewise-inbound-timestamp` | Unix seconds; refused if more than 300 s from the API clock |
| `x-invoicewise-inbound-recipient` | envelope recipient, `encodeURIComponent` |
| `x-invoicewise-inbound-sender` | envelope sender, `encodeURIComponent` |
| `x-invoicewise-inbound-signature` | `v1=` + hex HMAC-SHA256 with `INBOUND_EMAIL_SECRET` over `v1\n<timestamp>\n<recipient>\n<sender>\n<sha256 hex of the body>` |

The body is the raw RFC 5322 message. The signature covers the envelope and
the exact bytes, so neither the recipient nor the content can be changed in
transit. Nothing about the network path is trusted: production traffic
arrives through the Cloudflare Tunnel and kamal-proxy, where any
`x-forwarded-for` or client address can be supplied by the caller. An unset
secret refuses every request (fail closed). A replayed request inside the
window is harmless: it is deduplicated like any redelivery.

The Worker's own unit tests and `apps/api/src/inbound-email/http.test.ts`
(which drives the real Worker code against the real handler) pin this
construction on both sides.

## Acknowledgement and retry contract

| API answer | Meaning | Worker | Sender sees |
| --- | --- | --- | --- |
| `202` | the message and its processing intent are committed in Postgres (new or already held) | returns | accepted (250) |
| `404` | unknown or revoked recipient | `setReject` | permanent rejection, reported by the sender's own server |
| `413` | over 20 MiB | `setReject` | permanent rejection |
| `400` | empty message | `setReject` | permanent rejection |
| `401` | bad signature (for example a secret mismatch after rotation) | retries, then throws | temporary failure; the sending server retries later |
| `503` / network error | database, storage or API unavailable | retries 3 times (1 s, 4 s back-off, 20 s per attempt), then throws | temporary failure; the sending server retries later |

- **Accepted mail is durable before it is acknowledged.** The row (with the
  raw message in `inbound_emails.raw`) and the `process-inbound-email` job
  commit in one transaction; the API answers `202` only after the commit. A
  crash before the commit leaves nothing and the provider has not been told
  the message was accepted. A crash after the commit but before the answer
  leads to a redelivery, which is deduplicated.
- **Temporary failures stay with the sender.** A thrown Worker invocation is
  not a `setReject`; SMTP senders keep a temporarily failed message and retry
  for days. Cloudflare does not document the exact SMTP code a thrown Email
  Worker produces; the live proof below checks it.
- **Nothing here sends mail.** InvoiceWise never bounces, replies or forwards
  from the receiving address, and refusals happen at SMTP time, so the sending
  server reports them to its own user. There is no path for a bounce loop.
- **Worker and storage outages after acknowledgement** are covered by the
  Effect queue: the job retries with back-off (`WORKFLOW_RETRY_*`) and its
  attachments are replayed idempotently by content.

## Deduplication and identity

- Redelivery identity is `(team_id, message_key)`, where `message_key` is
  `mid:<Message-ID>` or, when the header is missing, `sha256:<raw bytes>`.
  Retries by the sending server keep their Message-ID even when trace headers
  differ. A redelivery increments `delivery_count` and `last_delivered_at` and
  never creates a second job.
- Attachments go through `acceptIntakeUpload` with reference
  `email:<message_key>:<attachment index>` and `inbox.inbound_email_id` set, so
  identical bytes are one invoice per workspace (content identity, see
  [document intake](document-intake.md#identity)) and the Message-ID reaches
  downstream provenance: the webhook payload (`referenceId`,
  `inboundEmailId`), and REST/MCP/tRPC invoice reads (`inboundEmail`: message
  id, header and envelope sender, recipient, subject, receipt time).

## What each message becomes

The job parses the stored MIME (postal-mime, nesting depth ≤ 32, headers
≤ 64 KiB) and looks at every attachment part in order:

| Attachment | Outcome |
| --- | --- |
| PDF, JPEG or PNG (declared type, or a `.pdf/.jpg/.jpeg/.png` name) | handed to intake; `accepted`, or `duplicate` of an invoice already in the workspace |
| Image under 100 KB | `skipped` (`small_image`: logos, signatures, tracking pixels) |
| Anything else (text, HEIC, office documents, calendar files) | `skipped` (`unsupported_type`) |
| More than 10 supported documents | the rest `skipped` (`too_many_documents`) |
| More than 50 attachment parts | the rest `skipped` (`too_many_attachments`) |
| Intake refuses the bytes (malformed, password-protected, over a limit) | `rejected` with intake's code and message |

The outcome of every attachment (name, declared type, size, sha256, outcome,
reason, invoice id) is kept in `inbound_emails.attachments`, and Settings →
Email lists the recent messages with their status and reasons.

- **No supported attachment**: the message is `processed` with the detail
  "No PDF, JPEG or PNG attachment was found in this message."
- **Only rejected attachments**: `processed` with "No attachment in this
  message could be read as an invoice."
- **Gmail forwarding confirmation** (`forwarding-noreply@google.com`): the
  confirmation text, including its link and code, is shown as the message's
  detail so the workspace can finish setting up Gmail forwarding.
- **Unreadable MIME**: `failed` at once ("This message could not be read as
  email."), not retried.
- **Transient intake failure** (storage, parser capacity): the job retries; on
  its last attempt the message settles `failed` with the attachments' outcomes,
  so the problem is visible rather than silently dropped.
- **Any other final job failure**: the message settles `failed` with a generic
  temporary-problem detail and the reason in the worker log
  (`inbound_email_processing_failed`).

A message is never retried after it settles, so a poison message costs at most
one job's attempts. A processed message drops its raw source (the invoices
live on in private storage); a failed one keeps it for an operator to re-drive
until the workspace is deleted.

## Limits

| Limit | Value | Enforced by |
| --- | --- | --- |
| Whole message | 20 MiB (`INBOUND_EMAIL_LIMITS.maxMessageBytes`) | Worker (`rawSize` and bytes read), API (bounded body read) |
| One document | intake limits (5 MB, page and pixel bounds) | intake |
| Supported documents per message | 10 | job |
| Attachment parts looked at | 50 | job |
| MIME nesting depth / header size | 32 / 64 KiB | job |

## Cloudflare setup

The Worker source (`apps/inbound-email/src/worker.ts`), its Wrangler config
(`apps/inbound-email/wrangler.toml`) and the routing state
(`apps/inbound-email/cloudflare-routing.json`) live in this repository and are
applied by an operator with access to the `invoicewise.uk` Cloudflare account;
nothing in CI deploys them.

1. **Secret.** Generate one value and store it in Infisical (project
   `invoicewise`, env `prod`) as `INBOUND_EMAIL_SECRET`. The API reads it
   through Kamal; the Worker gets the same value as a Wrangler secret.
2. **Worker.** From `apps/inbound-email`:

   ```bash
   bunx wrangler@4 deploy
   infisical run --env prod -- sh -c 'printf %s "$INBOUND_EMAIL_SECRET" | bunx wrangler@4 secret put INBOUND_EMAIL_SECRET'
   ```

3. **Email Routing on the subdomain.** Email Routing → Settings → Subdomains:
   add `in.invoicewise.uk`. Cloudflare adds MX (`route1/2/3.mx.cloudflare.net`)
   and SPF TXT records on `in.invoicewise.uk` only. The apex MX
   (`mailserver.purelymail.com`, used by `auth@invoicewise.uk`) must stay as it
   is.
4. **Routing rule.** A catch-all for `in.invoicewise.uk` with the action
   "Send to a Worker: invoicewise-inbound-email". Individual addresses are
   never configured in Cloudflare: the API decides which exist.
5. **API.** Deploy with `INBOUND_EMAIL_SECRET` in Infisical; the API preflight
   refuses to start without it (`scripts/deploy/require-env.sh`).

Staging uses its own `INBOUND_EMAIL_SECRET` (Infisical `staging`) and the
unrouted domain `iw-staging-in.zzapp.uk`; nothing is configured in Cloudflare
for it.

Rotating the secret: put the new value in Infisical, update the Worker secret,
then redeploy the API. Mail that arrives while the two disagree gets `401`,
which the Worker treats as temporary, so it is retried rather than lost.

## Live proof

With a throwaway workspace:

1. `dig +short MX in.invoicewise.uk` shows Cloudflare's route servers and
   `dig +short MX invoicewise.uk` still shows Purelymail.
2. From an external mailbox, send a PDF invoice to the workspace address. It
   appears once in Settings → Email as processed and once in the inbox, and the
   invoice's `inboundEmail` carries the message's Message-ID and sender.
3. Redeliver the same message (resend the identical `.eml` with the same
   Message-ID, for example with `swaks --data`). Its `delivery_count` rises and
   there is still one invoice.
4. Send to an unknown address on the subdomain and to the address that
   rotation revoked: the sending mailbox receives a rejection
   (`550 5.1.1 Unknown recipient`) from its own server.
5. A request to `/inbound/email` without a valid signature answers `401`.
6. Optionally, with the Worker's endpoint pointed at an address that answers
   `503`, a test message is deferred by the sending server (temporary failure)
   rather than bounced; this confirms the Cloudflare behaviour for a thrown
   Worker.

## Tests

- `apps/inbound-email/src/worker.test.ts` — signing, permanent vs temporary
  answers, size cap, retries.
- `apps/api/src/inbound-email/http.test.ts` — signature, clock window, body
  bound, fail-closed secret, status mapping, and the real Worker against the
  real handler.
- `packages/jobs/src/inbound-email.test.ts` — recipient parsing, local part
  shape, header reading, message identity.
- `apps/api/src/inbound-email.http.integration.test.ts` (in `bun run verify`)
  — real HTTP and Postgres: delivery through the Worker to the right
  workspace once with provenance, redelivery, refusals (unknown, revoked,
  deleted workspace, spoofed/unsigned), attachment outcomes without retries,
  transient failure then visible failure, and member vs admin rotation.
