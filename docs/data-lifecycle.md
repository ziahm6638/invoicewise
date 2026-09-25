# Data lifecycle: export, retention and processors

What InvoiceWise keeps, for how long, how an owner gets a portable copy, and
what has to happen outside InvoiceWise when data is removed. Deletion itself
(accounts, workspaces and their resumable cleanup) is in
[offboarding](offboarding.md).

## Retention schedule

This is InvoiceWise's **current operating policy**: the defaults the service
applies today, changeable by configuration. It is not a legal or contractual
promise, and nothing here should be quoted to a customer as one. Owners and
members see the same schedule under Settings → Data, rendered from
`describeRetentionPolicy` (`packages/jobs/src/retention-policy.ts`).

| Data | Kept | Applied by | Setting |
| --- | --- | --- | --- |
| Invoices, original documents, extraction, judgments, suppliers and their correction history, questions, integration settings | while the workspace exists | a member deleting an invoice (file at once, record as below), the owner deleting the workspace ([offboarding](offboarding.md)) | none |
| Failed uploads and deleted invoices, and the MIME source of a received message that failed | 30 days after upload or receipt | hourly retention job | `RETENTION_FAILED_UPLOAD_DAYS` |
| Source email reference (on the invoice and on each re-delivery) and the headers kept for each received message | 90 days after receipt | hourly retention job | `RETENTION_SOURCE_EMAIL_DAYS` |
| Job and webhook payloads | 30 days after the job or delivery finished | hourly retention job | `RETENTION_JOB_PAYLOAD_DAYS` |
| Application logs | rotated by size: 5 files of 50 MB per container; time-based 30-day expiry not yet enforced | Docker log rotation on the host | `logging` in `config/deploy.yml` |
| Database backups | 30 days | `ops/backup` on hp-slice | `INVOICEWISE_BACKUP_RETAIN_DAYS` on the host, `RETENTION_BACKUP_DAYS` in the app |
| Data export downloads | 24 hours | download route refuses at once; hourly retention job removes the archive | `EXPORT_LINK_TTL_HOURS` |

Settings are whole numbers of days (hours for the export link) in the API
container's environment; the API renders them and the in-process workflow
runner applies them. An invalid value stops the runner's retention and export
work instead of silently falling back to a default.

What each row means precisely:

- **Failed uploads and deleted invoices.** A failed upload never became a
  document: a reservation whose object write did not finish, or intake that
  was cancelled. Deleting an invoice also cancels its record: the file is
  removed at once, but the row, with its extraction, stays behind. Stale
  reservations older than the period are claimed and their objects removed
  through the intake's own claim-then-remove path (`discardStaleReservations`),
  then cancelled records whose upload is older than the period are deleted
  (so a deleted invoice's record goes at the latest 30 days after it was
  uploaded). A record whose object removal is still pending or ambiguous stays
  until that is settled.
  Invoices that were accepted but could not be read (`processing_error`) are
  not failed uploads: they stay in the inbox, where a member can retry or
  delete them.
  A message received at the workspace address (`inbound_emails`) keeps its
  full MIME source (`raw`) only until it settles: a processed message drops
  it at once, and a failed one keeps it for an operator until the retention
  job clears it 30 days after receipt.
- **Source email.** From an email InvoiceWise keeps the invoice attachment
  (active data) and the provider message reference used to recognise
  redelivered mail (`inbox.reference_id`, the message id and attachment name),
  and the same reference for each identical re-delivery of a document
  (`inbox_redeliveries.reference_id`). For a message received at the workspace
  address it also keeps, on its `inbound_emails` row, the envelope and header
  sender, subject, Date header, Message-ID and Cloudflare's
  Authentication-Results, shown beside the message in Settings → Email. The
  retention job clears the references and, once a message has settled, those
  header fields (and any MIME source still held); a message still being
  processed is left until it settles. A re-delivery keeps its time, file name
  and mailbox as part of the invoice's history; a received message keeps its
  recipient address, size, SHA-256 of the raw bytes, the hashed redelivery key
  (`message_key`: a SHA-256 of the Message-ID, or of the raw bytes), its
  outcome note (for a Gmail forwarding confirmation, the confirmation text)
  and its attachment outcomes (file name, type, size, hash and the invoice
  each became). Redelivered mail is still recognised afterwards by the hashed
  key and duplicates by the document's content hash.
  An invoice's sender domain (`website`) is overwritten by extraction and is
  invoice data, not email content.
- **Job and webhook payloads.** Finished workflow jobs keep their name,
  status, attempts, times and idempotency key, so finished work is never run
  again and queue history stays traceable; their payload, result and error are
  emptied. Finished webhook deliveries keep their status and attempts; the
  invoice payload that was sent is emptied. Queued and running work is never
  touched.
- **Application logs.** Container logs rotate by size (`logging` in
  `config/deploy.yml`: 5 files of 50 MB per container). Size rotation bounds
  what is kept but does not remove logs after any fixed time, so the 30-day
  period recorded for logs is not yet enforced; time-based expiry is a
  follow-up. Old containers, and their logs, go when Kamal prunes earlier
  releases.
- **Backups.** Nightly dumps of the InvoiceWise and Nango databases older than
  the period are deleted by `ops/backup/invoicewise-backup`. A change to the
  period takes effect on the host only after `ops/backup/install.sh` is run;
  keep `RETENTION_BACKUP_DAYS` equal to it so the schedule shown in Settings
  matches the host.
- **Deletion records.** Completed `deletion_requests` rows hold only ids and
  timestamps, never a name, email address or provider reference. They are the
  operator audit trail (after a restore, the list of subjects to re-delete) and
  are kept; no retention job removes them.

### The retention job

`apply-retention` (`packages/jobs/src/retention.ts`) runs every hour. Each
runner queues the next hourly slot when it starts, and every run queues the
following slot whether it succeeded or gave up, keyed by the slot so it never
duplicates.

- **Resumable.** Every step changes at most one batch of rows per statement,
  chosen by a predicate that stops matching once a row is handled. A run that
  fails or is interrupted leaves every finished batch committed, and the next
  run continues with what still matches; repeating a finished run changes
  nothing.
- **Workspace-safe.** The schedule applies to every workspace alike and each
  step touches only the rows it names. An export archive is removed only at
  that export's own path inside its own workspace prefix
  (`<workspace>/exports/<export>/…`); a record whose path fails that check is
  refused and reported, never removed.
- **Cannot resurrect.** Steps only delete or empty records. None of them
  inserts rows or queues work, so a sweep can never bring deleted data back
  (the integration suite checks the job count is unchanged).
- **Visible.** A run with failures fails its job (retried with backoff) and
  logs `retention_sweep_failed`; a successful run logs
  `retention_sweep_completed` with the counts per step. `bun jobs:status` lists
  the runs with the other jobs.

## Workspace export

An owner requests an export under Settings → Data (`data.requestExport`,
owner only; admins and members are refused on the server). One export per
workspace is built at a time. The request and its `build-data-export` job are
recorded in one transaction; the job is workspace-scoped, so deleting the
workspace removes queued work, and a running build holds the workspace purge
back until its lease ends.

Progress, expiry, failure and completion are on the `data_exports` row and
shown on the page, which polls while a build runs:

| Status | Meaning |
| --- | --- |
| `queued` | waiting for the runner |
| `running` | documents added so far of the total |
| `ready` | downloadable until `expires_at` (24 hours after completion) |
| `failed` | the reason safe to show the owner; internal detail is in the logs (`data_export_failed`) |
| `expired` | the download window ended and the archive was removed |

### Building and downloading

- The archive is written to a private temporary file (mode 0600 in a 0700
  directory under the worker's temp dir), streamed once into the workspace's
  private storage prefix, and the temporary file is removed in every case.
  The stored archive is the only lasting copy. Build files left by a crashed
  worker are removed by the retention job after six hours.
- The object path is recorded on the request before the upload, so an archive
  stored by a failed or interrupted build is still found and removed.
- An interrupted build is retried by the queue and starts the archive again
  from the beginning, writing to the same path, so a retried build always
  produces a complete archive.
- A build whose job ends without recording an outcome (a worker that dies on
  the final attempt, whose lease then expires) cannot leave the request stuck:
  the runner's periodic reconciler (`WORKFLOW_RECONCILE_MS`, default 60s,
  shared with delivery reconciliation) marks any `queued` or `running` export
  with no queued or running build job `failed`, logging
  `data_export_reconciled`, so the owner sees the failure and can request a
  new export.
- The manifest's `expiresAt` is the same instant as the request's expiry, which
  the download route and the retention job enforce.
- If the request or its workspace is removed while the build runs, the build
  removes the archive it stored instead of publishing it.
- Download links are minted per click by the owner (`data.exportDownloadUrl`),
  last five minutes and are bound to the export request, not to a path. The
  API route `/exports/<id>/download` re-reads the request on every use and
  serves only a `ready`, unexpired archive at that export's own path, with
  `Cache-Control: private, no-store`. An expired, failed or deleted export
  stops serving immediately, before the retention job removes the object.

### Archive format (version 1)

A ZIP file (entries stored uncompressed; originals are already compressed)
named `invoicewise-export-<date>-<id>.zip`:

| Entry | Contents |
| --- | --- |
| `manifest.json` | format and version, export and workspace ids, requester, times, counts, the identifier scheme, the retention policy in force, every data file with its record count, size and SHA-256, and every document with its status, size and SHA-256 |
| `documents/<invoice id>/<file name>` | each original exactly as received |
| `invoices.json` | every invoice (accepted or legacy, not deleted): amounts, status, extraction, judgment ids, the supplier it is assigned to (`supplierId`) with how it was resolved (`supplierResolution`) and its supplier-history checks (`supplierChecks`), source mailbox id and message reference, its re-deliveries (time, file name, mailbox, message reference until it expires), accounting delivery state, and its document entry |
| `judgments.json` | every judgment with its invoice id |
| `suppliers.json` | the workspace's supplier records: name, normalised name, VAT and company number keys, `mergedIntoId` for a merged supplier, times, and the ids of the invoices assigned to it |
| `supplier-events.json` | every supplier correction (invoice reassigned, suppliers merged, change reverted) with its actor, what it replaced and whether it was reverted |
| `questions.json` | the workspace's questions, every version |
| `inbound-emails.json` | every message received at the workspace address: receipt time, recipient address, header and envelope sender and subject (until they expire), outcome and note, delivery count, attachment outcomes and the ids of the invoices it became (`invoiceIds`); never the MIME source |
| `audit.json` | invoice received and posted to accounting, supplier corrections, webhook deliveries, workflow runs and export requests, in time order |
| `workspace.json` | the workspace, its members and roles, mailboxes, accounting connections and webhook endpoints |

Stable identifiers: invoices keep their InvoiceWise UUID; a document is
identified by its invoice id and SHA-256; suppliers and supplier events keep
their InvoiceWise UUID, so an invoice's `supplierId` names the same supplier
in every export (follow `mergedIntoId` to the supplier it was merged into); a
judgment is `<invoice id>:<question id>`; a received message keeps its
InvoiceWise UUID; an audit event is
`<event type>:<source record id>`.

Completeness checks built in: every accepted document is listed in the
manifest; a document whose object is missing from storage is listed as
`missing`, and one whose stored path fails the workspace ownership check is
listed as `withheld` and never read (both are counted as missing on the
request) rather than silently skipped; each
included document also records whether its hash still matches the one taken at
intake (`intakeHashMatches`). Uploads that never became invoices, deleted
invoices and anything from another workspace, including its suppliers, are
never included. Supplier records hold no bank details; bank details appear
only where the invoice's own extraction contains them. Tokens,
webhook signing secrets and provider connection references are never
exported. ZIP64 is not written, so an export above 4 GiB or 65,535 files fails
with a message asking the owner to contact support.

## External processors

What each service holds for a workspace, and what has to be removed or
revoked there. "Automatic" means the deletion cleanup in
[offboarding](offboarding.md) does it; anything else is manual or stays under
the provider's own retention. Do not tell a customer a provider has deleted
data until it has.

| Processor | What it receives or holds | On workspace deletion |
| --- | --- | --- |
| hp-slice (self-hosted: Postgres, Redis, document storage, logs, backups) | all workspace rows, originals and export archives under `/mnt/ssd/invoicewise/storage`, cache entries, container logs, nightly dumps | rows at once; originals and archives by the cleanup purge; cache entries expire by TTL; logs rotate (above); dumps age out after the backup period |
| TypeSafe (api.typesafe.ai) | laid-out invoice text, extraction candidates and judgment questions for each invoice processed; never the file itself | nothing is sent to remove; retention there is TypeSafe's own. A customer who needs it removed must be referred to TypeSafe |
| Nango (self-hosted accessory) | Xero/QuickBooks connection records and encrypted provider tokens, in the `nango` database | automatic: the connection is deleted through Nango. Copies remain in Nango dumps until they age out |
| Xero / QuickBooks | draft or open bills posted for the workspace's invoices | bills stay in the customer's own ledger; InvoiceWise never deletes them. Deleting the Nango connection stops access; the customer can also disconnect InvoiceWise in the provider's app settings |
| Google (Gmail) | the OAuth grant used to read the connected mailbox | automatic: the grant is revoked at Google. The mail stays in the customer's mailbox |
| Microsoft (Outlook) | the OAuth grant used to read the connected mailbox | stored tokens are destroyed (Microsoft has no per-token revocation); the customer removes the app's consent in their Microsoft account if they want the grant gone |
| Cloudflare Email Routing and Email Worker (workspace receiving address on `in.invoicewise.uk`) | each message sent to a workspace address, passed in transit to the signed `POST /inbound/email` endpoint | nothing stored by InvoiceWise to remove; Cloudflare's own logs follow its retention |
| Purelymail (SMTP) | transactional mail InvoiceWise sends: sign-in, invitations, forwarded Google Workspace verification mail | nothing to remove per workspace; sent mail is not stored by InvoiceWise |
| Polar (billing) | the paying customer and subscription | not automatic: cancel the subscription before deleting (known limit in [offboarding](offboarding.md)); Polar keeps billing records under its own obligations |
| Resend (marketing audience, optional) | name and email of a new user, only when `RESEND_API_KEY` and `RESEND_AUDIENCE_ID` are both set | not automatic: remove the contact in Resend. Production does not set these today |
| Customer webhook endpoints | invoice payloads delivered to URLs the workspace configured | the customer's own systems; InvoiceWise stops delivering when the workspace is deleted |
| Cloudflare (tunnel for public hosts) | traffic in transit to hp-slice | nothing stored by InvoiceWise to remove |
| OpenPanel, Sentry (inherited) | analytics events and error reports, only when their keys are configured | production sets no keys for them (`config/deploy.yml`) |

The marketing site (Vercel, PocketBase waitlist) holds no workspace data and is
outside this lifecycle.

## Operator runbook

- `bun jobs:status` lists recent jobs (including `apply-retention` and
  `build-data-export` runs), unfinished deletions, and exports that are in
  progress, failed, or still hold an archive past expiry.
- A failed export needs nothing from an operator: the owner requests a new one,
  and the retention job removes any archive the failed build stored.
- A retention run that keeps failing logs `retention_sweep_failed` with the
  first failures; fix the cause (usually storage access) and the next hourly
  run resumes.
- Changing a period: set the variable under the API role's `env.clear` in
  `config/deploy.yml` and redeploy (the settings are not secrets, and the
  defaults need no entry). For backups also change the script's
  `INVOICEWISE_BACKUP_RETAIN_DAYS` default in `ops/backup/invoicewise-backup`
  and run `ops/backup/install.sh`.

## Proof

`apps/api/src/trpc/routers/data.lifecycle.integration.test.ts` (run by
`bun run verify` as `verify:data-lifecycle`) builds a disposable
multi-workspace dataset and checks: owner-only access; an export interrupted
after its archive was built, then resumed to completion; manifest and
object completeness byte for byte, with suppliers taken from the
workspace's supplier records (including an invoice reassigned to another
supplier), received messages without their MIME source, and no data from the
neighbouring workspace; link tampering and expiry; a retention sweep interrupted after two
batches, then resumed, clearing old invoice and re-delivery email references,
failed received messages' MIME source and settled received messages' headers,
with unrelated, unsettled and recent data untouched and no work
queued; and a workspace deletion that takes its exports and queued export work
with it through an interrupted-then-resumed cleanup while the neighbour's
exports and documents survive. `packages/jobs` `bun run verify` runs an export
and a retention run through the real workflow runner.

Live proof against production uses throwaway workspaces only: create two,
upload invoices to both, export one and validate its manifest against the
stored originals, delete it, wait for the cleanup to complete, and confirm the
other workspace's invoices, documents and exports are unchanged.
