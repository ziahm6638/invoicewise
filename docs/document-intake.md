# Document intake contract

Roadmap issue #34. Every invoice that enters InvoiceWise — dashboard upload or
mailbox attachment — passes through one workspace-authorized lifecycle owned by
the server.

## Identity

- The server generates the inbox id and the storage path
  (`<teamId>/inbox/<inboxId>/<random>.<ext>`). The original filename is display
  metadata only, so two different `invoice.pdf` documents coexist.
- Replay identity is `(team_id, sha256(content))`, enforced by a partial unique
  index over `reserved` and `accepted` records. Re-uploading the accepted bytes
  returns the same inbox id without writing a second object or queueing a second
  processing job. Initial processing is keyed by the canonical inbox id, so a
  concurrent replay cannot create a second job. Each accepted replay is kept
  as a re-delivery of that document (`inbox_redeliveries`: when, file name,
  provider reference, mailbox), shown under the invoice's supplier history;
  replaying the same provider reference is not counted twice, and a mailbox
  sync treats a re-delivered reference as handled. A re-delivery is never
  processed, posted or sent to webhooks again.
- Different bytes never replace an existing object: writes use `uploadIfAbsent`
  (local: write a temp file, then publish it with an atomic link; S3:
  `If-None-Match: *`, where a 409 conditional conflict is retried and a 412
  means the object already exists). After the write, the bytes at the reserved
  path are read back and must match the reservation's size and sha256 before the
  record can be accepted or queued.
- Provider/attachment references are workspace scoped
  (`unique (team_id, reference_id)`), and two same-named attachments in one
  message get distinct references, so two tenants and two `invoice.pdf`
  attachments cannot collide. Webhook references include the attachment
  index. Gmail references keep the original `sha256(messageId_filename)` for
  the first attachment with a given filename (so already-synced mail still
  deduplicates) and add the occurrence number for later ones
  (`gmailAttachmentReferenceIds`).
- Legacy rows created before this change have a null `intake_state` and are
  treated as accepted documents. New intake always sets a state.
- Every persisted binding is checked by one shared validator
  (`isValidDocumentBinding`): the stored path must start with the record's exact
  non-null workspace, its second segment must be the `inbox` document
  namespace, and no segment may be empty, `.`, `..` or contain a separator.
  Reads, capability signing, worker ID/legacy-path resolution, retry, cleanup
  and deletion all use it, so an inconsistent legacy row can never read, sign,
  process or delete another workspace's object. Rows outside that shape are
  refused and, on deletion, their object is deliberately retained.

## Lifecycle

`inbox.intake_state` is one of `reserved`, `accepted` or `cancelled`.

1. Validate the real bytes (see limits below). Nothing is written for a
   rejected document.
2. Reserve a durable `reserved` record with the content hash and server-owned
   path.
3. Write the object immutably at that path.
4. In one transaction: mark the record `accepted` and enqueue the
   `process-attachment` job with `{ inboxId, teamId }`.

Recovery, all explicit:

| Failure point | State left behind | Recovery |
| --- | --- | --- |
| Crash after reserve, before write | `reserved`, no object | Re-upload the same bytes; the same reservation and path are resumed |
| Crash after write, before finalize | `reserved`, object present | Re-upload or retry; the existing object is reused, never rewritten |
| Enqueue or finalize failure | `reserved` with `intake_error` | Re-upload the same bytes; the transaction is retried |
| Worker cannot load the object | `accepted`, job retried | Restore the object, or let the job exhaust attempts into a visible failure |
| Explicit delete | `cancelled`, object removed | Re-uploading the same bytes creates a new document |
| Delete a legacy row whose object another live row still uses | `cancelled`, object kept | The last live row to be deleted removes the object |
| Abandoned reservation | `reserved` past the chosen age | `discardStaleReservations(db, storage, { olderThanMs })` claims `reserved → cancelled` first, removes the object, and returns `{ discarded, failed }`. The claim sets durable removal intent before the effect |

There is deliberately no automatic retention schedule in this slice, and
nothing calls `discardStaleReservations` periodically yet (see #50 for the
owner-approved retention schedule). Reservations never become accepted
invoices, and no accepted invoice is ever left without a queued processing
intent. Until a reservation is accepted it is invisible to product and API
reads: dashboard and REST/MCP listings, detail reads, CSV export, edits and
document signing all show only `accepted` and legacy (null state) rows.

Acceptance is conditional on `intake_state = 'reserved'`, so a late writer can
never move an accepted record backwards or resurrect a cancelled one. Cleanup
claims the reservation before touching storage, so a document that finished
accepting in the meantime is never deleted; removal failures are reported and
recorded on the record instead of being swallowed. Deletes are likewise
conditional (`status <> 'deleted'`), and post-extraction writes refuse to
restore a deleted invoice.

Cleanup is resumable: a removal failure sets `object_removal_pending` on the
record, and every later cleanup pass picks those rows up again even though they
are already `cancelled`. A publication holds a short lease on the row
(`intake_publishing_until`) and every discard claim skips a leased row, so
cleanup cannot tombstone a reservation while a writer is still storing it. A
write that lands after its record was cancelled anyway, and a remote effect that
arrives after a local abort, are covered by the ambiguous-write reconciliation
below rather than by an unproven compensation step.

Removal intent is written **before** the effect, atomically with the state
change: claiming a stale reservation, cancelling a record and deleting an
invoice all set `object_removal_pending` in the same statement that tombstones
the row. A crash between the claim and the storage removal is therefore
recovered by the next cleanup pass, which selects outstanding removals
independently of the reservation age. Non-ambiguous removals clear the flag
after the object is proven gone. Ambiguous publication tombstones do **not**
clear automatically; they stay pending until explicit provider/operator
settlement or verified accepted retry.

No database connection or transaction is held while bytes move to or from
object storage (issue #68), so slow storage cannot exhaust the connection pool.
The publisher first takes the publication lease in one short statement (the
storage budget plus headroom), then performs the immutable write and the hash
read-back with an abort signal and a bounded budget and no connection checked
out, and finally accepts and enqueues in one short `SELECT … FOR UPDATE`
transaction. If the row was cancelled while it was writing, that transaction
records removal intent (with the ambiguity marker) for the bytes it published
instead of accepting. If the write or read-back fails, the attempt records
durable removal intent and leaves its lease to expire, because concurrent
attempts for the same content share it; if the acceptance transaction itself
aborts (for example a database error while queueing), the row stays
`reserved` and the intent is recorded immediately after the rollback.

Acceptance clears any earlier removal intent in the same conditional update that
moves the row to `accepted`, so a successful retry cannot be deleted by a later
pending-removal pass. Pending cleanup never removes a row by id alone: it
re-claims the row with a state-conditional update, and only `reserved` or
already-`cancelled` rows without a live publication lease are eligible. A
retry that is still publishing therefore makes the cleanup claim a no-op, and an accepted row is repaired rather than
removed if it carries a stale tombstone.

Aborted local filesystem calls are cooperative; a call that has already entered
the filesystem may still complete after the abort is observed. A failed
publication is therefore recorded as `object_removal_ambiguous`, and the
tombstone remains pending indefinitely. Repeated cleanup passes continue to
revisit it, so a remote effect that arrives arbitrarily later is still removed.
Clearing requires positive settlement evidence:

- a verified accepted retry clears the obsolete intent atomically with
  acceptance; or
- an operator/provider reconciliation calls
  `settleAmbiguousObjectRemoval({ id, teamId, evidence })` after proving no
  late write remains.

This is not a provider-level exactly-once guarantee. Unknown remote outcomes
remain pending, and hard deployment containment for providers that cannot
supply settlement evidence remains #53.

### Full cleanup pass and pagination

`discardStaleReservations` is the explicit recovery helper. It accepts
`pendingAfter` (the `nextPendingCursor` from the previous call), processes one
deterministic page ordered by `(created_at, id)`, and returns:

- `discarded` — objects successfully removed in this page;
- `unresolved` — ambiguous rows whose bytes were removed but whose remote
  outcome remains pending;
- `failed` — removals or database writes that failed and stay durable;
- `retained` — legacy rows whose object is still used by another live record
  (legacy paths `<team>/inbox/<filename>` could be shared); the bytes are kept
  and the tombstone is cleared;
- `nextPendingCursor` and `hasMorePending` — the cursor for the next page.

To complete a full pass, call the helper repeatedly with `pendingAfter` set to
the previous `nextPendingCursor` until `hasMorePending` is false. Reset the
cursor for the next pass. Permanent ambiguous rows therefore cannot starve
later candidates: each pass advances past them and still reaches the end.
Unknown outcomes remain in `unresolved` and are revisited on every full pass.
A page may contain only legacy or invalid bindings and therefore yield no
`discarded` rows; continue the cursor instead of treating that as the end.

Explicit retries serialize on the canonical inbox row (`SELECT … FOR UPDATE`)
before they look for pending work, so concurrent retries share one processing
job instead of creating duplicates.

## Supported inputs

Every supported format goes through the same pipeline: intake validation, text
reading, TypeSafe extraction and judgments, and one persisted record shape.
There is no per-format extraction path; the inherited Mistral receipt,
classifier and loader path has been removed.

| Input | How text is read | Limits | Result when it cannot be read |
| --- | --- | --- | --- |
| Text PDF | pdf.js text layer, laid out into rows | 5 MB, 50 pages, 10,000 px per page side, 100,000,000 px in total | Failed invoice with the reason |
| Scanned / image-only PDF | Each page with fewer than 40 letters and digits is rendered (≤300 DPI, ≤5,000 px per side, ≤15,000,000 px) and OCR'd with tesseract; other pages keep their text layer | As text PDF, plus at most 10 scanned pages per document | More than 10 scanned pages fails before any OCR |
| JPEG (photo or scan) | Turned upright from its EXIF orientation, then OCR'd as one page | 5 MB, 10,000 px per side, 25,000,000 pixels | Failed invoice with the reason |
| PNG (scan or screenshot) | OCR'd as one page | As JPEG | Failed invoice with the reason |
| HEIC / HEIF (iPhone camera default) | Not supported: no bounded HEIC decoder is available to the isolated OCR path | — | Refused at upload with a message to send a JPEG or PDF; not passed on from mail |
| WebP, GIF, office documents, text | Not supported | — | Refused at intake (`unsupported_type`) |

After reading, every format shares the extraction bounds in
`INVOICE_EXTRACTION_LIMITS` (`packages/documents/src/typesafe/invoice.ts`):
at most 400 printed rows, 40,000 characters of document text and 120 table
rows per invoice. A document over any bound fails with the reason instead of
being read in part, so an invoice whose later pages, rows or line items were
never seen is not saved as complete.

Channels: dashboard upload and the API accept PDF, JPEG and PNG. Forwarded
mail (the inbox webhook) passes PDF, JPEG and PNG attachments on to intake,
skipping images under 100 KB (logos, signatures, tracking pixels). Gmail sync
currently fetches PDF attachments only.

Documents without usable text never produce an empty success: a document with
no readable text even after OCR, or one in which none of supplier, invoice
number, date, amounts or line items is found (a letter, a remittance, a
newsletter), is recorded as a failed invoice with its reason.

### Pages, attachments and splitting

- One stored file is one invoice record. Every page of a multi-page PDF is
  read, in order, and `extraction.pageSources` lists how each page was read
  (`text-layer` or `ocr`); `extraction.textSource` summarises them (`mixed`
  when a document needs both). No page is skipped.
- A document is never split: a PDF that holds several invoices is read as
  one document. Send separate invoices as separate files.
- Several attachments in one email are separate records, each with its own
  provider reference, content hash and processing job.
- Line items come only from printed table rows: a row found under a header
  (a table continues onto a later page under a repeated header), or a row
  whose quantity × unit price = total proves it. Columns are mapped from the
  header's words, not from separators: quantity (Qty, Hours, Days), unit
  price, a discount (money or %), VAT (a rate such as `20%` or an amount) and
  the row amount (Net, Amount, Total; "Total inc VAT" or a lone Gross column
  marks tax-inclusive rows). Wrapped descriptions join their row. A column the
  table does not print stays null. A row printed as one run of text
  ("Continued on page 2", "Page 1 of 2") is never proposed, and TypeSafe
  confirms each candidate row is a purchased item. Nothing is generated.

### Persisted result

Every input persists the same fields on its `inbox` record:

- source identity: `file_name`, `content_type` (sniffed), `size`,
  `content_hash`, `reference_id` for mail and `inbox_account_id` for synced
  mailboxes;
- on success: `extraction` (the typed `InvoiceExtraction`, including
  `textSource`, `pageSources` and per-value `evidence`), `validation` (the
  deterministic checks; see [Validation](#validation)), `judgments` (one per
  configured question, answered, `not_applicable` with a reason, or
  `failed`), the derived amount, currency, date and tax columns, status
  `pending`, and a null `processing_error`;
- on failure: status `pending`, the reason in `processing_error`, and no
  extraction, validation or judgments. Permanent reasons (unreadable, not an invoice, over
  a limit, unsupported) fail at once; transient ones (provider or parser
  capacity) are retried and recorded only after the last attempt. An explicit
  retry clears the reason while it runs. REST/MCP reads return
  `processingError` and the dashboard shows it on the failed invoice. Only
  the document's own problems are recorded word for word; provider,
  infrastructure and configuration failures are recorded as a generic
  temporary processing problem, with the detail in the worker log
  (`invoice_processing_failed`). A failure is recorded only on a document
  still `processing`, so a later error never erases a saved extraction.

Fixtures for each input live in `packages/documents/src/test/fixtures`
(regenerate with `generate-uk-invoice.ts`): `uk-invoice.pdf` (text PDF),
`uk-invoice-scanned.pdf` (scan), `uk-invoice-scan.png`,
`uk-invoice-photo.jpg` (phone photo with EXIF rotation),
`uk-invoice-multipage.pdf` and `uk-invoice-multipage-mixed.pdf` (two pages,
the second scanned), `non-invoice-letter.pdf` and `malformed-invoice.pdf`.

## Limits

Enforced before any provider work, in `packages/documents/src/intake.ts`:

- Size: 5,000,000 bytes (matches the dashboard upload contract). The HTTP
  handler also bounds the *actual request body* while reading it, so a missing,
  false or chunked `content-length` cannot smuggle a larger multipart payload
  past the limit; the reader is cancelled as soon as the bound is crossed.
- Types: PDF, JPEG, PNG. The declared MIME type must match the sniffed content;
  other image formats (WebP, HEIC, GIF) fail explicitly. HEIC is recognised
  by its declared type or its `ftyp` brand and gets a message saying how to
  send a JPEG instead.
- Images: decoded with `sharp`, which rejects header-only, truncated and corrupt
  bodies. Dimensions and decoded pixels are checked first (at most 10,000 px per
  side and 25,000,000 pixels), then a downscaled decode forces the decoder to
  consume the whole stream.
- PDF: every parse runs in a dedicated **child process**
  (`packages/documents/src/isolated.ts`). The installed pdf.js build keeps
  `isWorkerDisabled = true` under Node/Bun, so a timer (or even
  `worker.terminate()`) cannot interrupt synchronous decode work reliably; the
  parent therefore kills and reaps a separate OS process. Enforcement is
  concrete: a wall-clock budget that stays armed until the process exits, an RSS
  budget sampled from the child (default 320 MB) that kills on breach, an output
  byte budget, and bounded admission (beyond that the request fails with a
  typed `busy` outcome). Admission has two independent pools: intake,
  extraction and OCR use `IW_PDF_MAX_CONCURRENT` / `IW_PDF_MAX_QUEUED` (two
  concurrent processes, eight queued), and dashboard previews use
  `IW_PDF_PREVIEW_MAX_CONCURRENT` / `IW_PDF_PREVIEW_MAX_QUEUED` (one concurrent,
  four queued), so preview traffic can never take the capacity invoice intake
  depends on (issue #68). The RSS budget is
  a **sampled soft ceiling**, not a hard heap cap: a very fast allocation can
  overshoot between samples. The sampler is itself bounded, never overlaps, and
  fails closed: if `ps` or another configured sampler cannot be executed or
  returns unusable output, the child is killed and the request returns a
  retryable `temporarily_unavailable`/`monitor_unavailable` outcome. Hard
  deployment-level memory containment remains #53. The child applies the
  page-count (50), per-page geometry (10,000 px per side) and total page area
  (100,000,000 px) bounds, and the caller enforces them. Password-protected and
  malformed files are rejected. A document that opens but then fails to
  parse (a broken or circular page tree, `/Kids` that is not an array, a
  missing page object, a bad content stream) is reported as `malformed`,
  which is permanent; only failures before the document opens (the child
  cannot start or load pdf.js) are operational `task_failed` results. The
  child receives a minimal environment (`PATH`, `HOME`, temp/locale/font
  variables and its own `IW_*` task inputs), never the parent's database,
  storage or API secrets, and Bun children run with `--no-env-file` so a
  working-directory `.env` is not loaded either.
- The same isolated process performs PDF text extraction for the invoice
  pipeline and first-page rendering for the dashboard preview, each with its
  own timeout and output bounds. Text comes back as positioned runs, and the
  parent rebuilds rows and column gaps from their geometry
  (`packages/documents/src/layout.ts`); joining pdf.js items into one string
  loses every line break and made every field unfindable (issue #71).
- A page whose text layer has fewer than 40 letters and digits (a scan or an
  image-only export) is rendered at up to 300 DPI and OCR'd with `tesseract`,
  which runs under the same supervisor: minimal environment, wall-clock, RSS
  and output budgets, bounded admission. PNG and JPEG uploads are OCR'd
  directly after being turned upright from their EXIF orientation (tesseract
  ignores it, so a sideways-stored phone photo would read rotated). At most 10 pages per document are OCR'd; a document with more scanned pages fails before any OCR instead of dropping the rest. The production image and
  CI install `tesseract-ocr`; locally, `brew install tesseract` (or
  `apt-get install tesseract-ocr`) is needed for the scanned-invoice test. Render geometry is checked against the
  **scaled** viewport, so `scale: 2` cannot turn a bounded page into an
  unbounded canvas allocation.
- Extraction never truncates silently: a document with more pages than the
  limit or text beyond the character limit fails with a typed `limit` outcome
  and extracts nothing, so an incomplete invoice is never sent downstream as a
  complete one.
- Cancellation is asserted, not inferred: `runBusyProcessForTest` starts a
  process that reports a ready handshake and then spins synchronously, and the
  test proves it is terminated while busy; `runMemoryHogForTest` proves the RSS
  watchdog kills a growing process inside a small budget and that the parent
  survives both.
- Worker re-check: the stored bytes must match the persisted size, type and
  sha256 content hash before extraction runs, and only `accepted` (or legacy)
  records resolve to a worker binding. A legacy job queued before the intake
  contract (a file path, no inbox id) still runs only when that path is the
  job's own `<teamId>/inbox/...` path; it reuses the matching row or creates
  and binds one as before.
- Intake failures are classified in one place
  (`@invoicewise/jobs/intake-failure`). A failed object write **or read-back**
  is `storage_unavailable` (transient, retried). Parser admission exhaustion,
  child startup failure and RSS-monitor unavailability are
  `temporarily_unavailable` (also transient). A verified hash/size mismatch is
  `content_mismatch`; a verified parser/output/pixel limit is
  `resource_limit`; timeout, malformed and password-protected results stay
  explicit and are not retried as malformed documents. Both mailbox callers use
  the same classification, so a temporary capacity or read failure is never
  acknowledged as a permanent loss.

The worker re-validates the cheap bounds and refuses missing, deleted or
foreign bindings.

## Extraction

TypeSafe selects; it does not generate, and it reads only text. Extraction
therefore runs in three steps (`packages/documents/src/typesafe/`):

1. Code finds every candidate value in the laid-out text
   (`candidates.ts`): a value beside its label, after it, or stacked beneath
   it; distinctive shapes anywhere (GB VAT numbers, IBANs, sort codes, UK
   written and numeric dates); postcode-anchored address blocks; and table
   rows parsed against their header columns (`line-items.ts`).
2. TypeSafe receives the whole document, one tagged row per printed line, and
   picks which candidate each field is, or that the invoice does not state it,
   and confirms which table rows are purchased items.
3. Code copies the chosen values and normalises them (ISO dates, `12-34-56`
   sort codes, grouped IBANs), and records each value's evidence.

The canonical record (`InvoiceExtraction` in
`packages/documents/src/typesafe/invoice.ts`) covers invoices and credit
notes: `documentType` (`invoice`, `credit_note`, or null when the document
says neither), supplier name, address, VAT number and Companies House
number, the document's own number and, for a credit note, the
`originalInvoiceNumber` it credits, invoice and due dates, `currency`, net,
discount, VAT, a single document-level `taxRate`, gross, `amountsIncludeTax`,
line items, bank details, PO and `paymentReference`. Amounts are stored as
printed (a credit note may print them negative or positive).

Nothing is filled in without evidence. A bare `$` offers no currency (it may
be US, Canadian, Australian or New Zealand dollars), so the currency stays
null unless an ISO code, `£`, `€` or a prefixed dollar (`US$`) is printed. A
missing VAT amount stays null, not zero, and a missing VAT number is not read
as "not registered". Dates are only printed dates; a due date is derived only
from printed terms ("Payment terms: 30 days", "Payable on receipt"), and its
evidence says so.

`extraction.evidence.fields` holds, for every value found, the page, the
printed row (`line`, `text`), the label beside it, TypeSafe's `confidence` in
the selection and, for an amount, the currency marker printed with it
(`currencyMarker`, `currency`); derived values carry `derivedFrom` and no
confidence. `evidence.lineItems` does the same for each line item.

An extraction with no readable text, or in which none of supplier, invoice
number, date, amounts or line items was found, fails the job instead of being
saved empty, and the reason is recorded in `processing_error`, so the invoice
shows as failed with that reason. Judgments receive the document
text alongside the extraction; default checks that compare against history,
or need values the invoice does not have, are recorded as `not_applicable`
with a reason rather than answered "No".

## Validation

After extraction, plain code checks the record
(`packages/documents/src/validation.ts`, no model involved) and stores the
result in `inbox.validation`. The same values always validate the same way;
`VALIDATION_VERSION` changes whenever a rule does.

**Precision and rounding.** Money is compared in integer minor units (two
decimal places for every recognised currency: GBP, EUR, USD, CAD, AUD, NZD,
SEK, NOK, DKK, CHF), rounded half away from zero. Tolerances
(`MONEY_RULES`):

| Check | Compared | Tolerance |
| --- | --- | --- |
| `line_arithmetic` | quantity × unit price, less a row discount (% or amount), against the row amount (or row amount + its VAT) | 1p, or ½p per unit of quantity when larger (the printed unit price may be rounded) |
| `line_totals` | sum of row amounts less the document discount, against net (tax-exclusive) or gross (tax-inclusive or no tax) | 1p |
| `tax` | VAT against: the rows' VAT amounts; or each rate group's net × rate (inclusive: gross × rate ÷ (100 + rate)) summed across rates; or net × the document rate | 1p for printed row amounts, else 1p per line item (VAT may be rounded per line or once) |
| `gross` | net + VAT against gross | 1p |
| `currency` | every total's printed currency against the invoice currency | exact |

The tax basis is `inclusive` or `exclusive` when the table header or the
document says so, otherwise whichever the arithmetic proves; `no_tax` when no
VAT is printed anywhere and the totals charge none. Zero-rated lines and
`VAT 0.00` pass as zero tax. A check that cannot be done is `unknown` (for
example VAT with no printed rate), never passed; one that would mix
currencies is `unsupported`.

**Currencies.** An amount always stays paired with its own currency:
`validation.totals` holds `{ amount, currency }` for net, discount, tax and
gross. Amounts printed in different currencies are never added together, and
no exchange rate is inferred; a total printed in another currency fails the
`currency` check.

**Credit notes and identity.** A credit note is compared as magnitudes, so
it validates whether it prints its amounts negative or positive, and its
canonical totals are stored negative. An invoice with a negative total is an
error. A document's identity is `type:supplier:number`, where the supplier is
its VAT number (else its normalised name) and the number ignores spacing,
punctuation and case. When both documents were resolved to workspace
suppliers, the resolved supplier (after merges) decides instead, so a
corrected or merged supplier is followed and two same-named businesses stay
apart (see [Supplier identity and history](#supplier-identity-and-history)).
A copy whose total differs from the earlier one is still a `duplicate` for
delivery, described as a revision. The first live copy received (by `created_at`, then
id; deleted and still-reserved documents never count) is the original, and
every later copy is its duplicate (`identity.duplicateOf`), whatever order
the copies are processed in: saving a document validates again, in the same
transaction, any later copy or credit note already processed and not yet sent
to accounting. A credit note and an invoice with the same number are
different documents. A credit note naming an original invoice is linked to
it (`identity.creditsInvoiceId`) when that invoice is in the workspace,
otherwise flagged; the processing job looks up same-numbered documents
across the whole workspace, not only recent history. At delivery two
documents with the same type and number are never both posted
automatically: a copy from the same supplier becomes a duplicate, and one
from another supplier is held for review until a user retries it; see
[Accounting integrations](accounting-integrations.md#what-each-provider-receives).

**Outcome.** `issues` lists every finding with a `severity`: errors (a
failed check, a missing required field, a due date before the invoice date,
a duplicate, mismatched currencies, a negative invoice) make the status
`invalid`; warnings (no VAT shown, VAT charged in GBP without a VAT number,
failed VAT-number or IBAN check digits, a low-confidence selection below
60%, an unlinked credit note, an unverifiable check) make it `needs_review`.
Uncertain values stay visible as uncertain in the dashboard.

**Delivery policy.** `validation.accounting` says whether the invoice may be
posted as a draft bill. The draft-bill contract (Xero and QuickBooks alike)
requires `documentType` (invoice), supplier name, invoice number, invoice
date, currency and gross total (`ACCOUNTING_REQUIRED_FIELDS`); every error is
a blocker, and a credit note is `credit_note_unsupported` because a draft
bill cannot represent a credit. The accounting job checks this before calling
the provider; a blocked invoice is not posted and its accounting status is
`failed` with `Not sent to <provider>: <reasons>`. Webhooks, REST, MCP and
CSV deliver the validation alongside the extraction, and judgments receive it
as `currentInvoiceValidation`. A record stored before validation existed is
validated at posting time from its extraction.

### Validation corpus

`packages/documents/src/test/corpus/` holds reviewed synthetic documents
(`corpus.ts`, rendered to PDF by `generate-corpus.ts`), each with the values
a correct reading gives and the validation outcome they must produce.
`corpus.test.ts` reads every PDF through the real pipeline with TypeSafe
played by the oracle that selects the reviewed values, then scores each field,
every line item (all columns) and each validation outcome against
`thresholds.json`. The recorded thresholds are 100% for every field, line-item
recall and precision, and validation outcomes; a regression fails the check,
which `corpus.test.ts` itself proves by scoring a deliberately regressed run.
`TYPESAFE_LIVE_SMOKE=1` with a key also reports the live model's per-field
accuracy on the same corpus.

| Document | Validation | Accounting |
| --- | --- | --- |
| `normal-invoice` — 20% VAT, wrapped description, company number, payment reference | valid | ready |
| `tax-inclusive-invoice` — prices and totals include VAT | valid, inclusive | ready |
| `multi-rate-invoice` — 20%, 5% and 0% lines, VAT recomputed per rate | valid | ready |
| `credit-note` — negative amounts, names `HLP-3101` | valid, linked to `normal-invoice` | not sent: credit note |
| `inconsistent-total` — gross £50 above net + VAT | invalid (`gross`) | not sent |
| `no-vat-sole-trader` — no VAT number or VAT line | needs review (`tax_not_stated`) | ready |
| `usd-invoice` — USD with sales tax, bare `$` amounts | valid | ready |
| `missing-currency` — only bare `$` | invalid (no currency) | not sent |
| `eur-invoice-with-sterling-equivalent` — EUR totals, GBP shown for information | valid, nothing converted | ready |
| `discount-invoice` — row discount % and document discount | valid | ready |
| `line-rounded-vat` — VAT rounded per line, 2p above invoice-level | valid (within 5p) | ready |

## Supplier identity and history

Every processed document is resolved to a workspace-local supplier
(`suppliers`; `inbox.supplier_id`, with how it was decided in
`inbox.supplier_resolution`). Plain code decides, no model
(`packages/documents/src/supplier.ts`), under the same workspace lock as
duplicate validation. Identifiers are compared normalised: VAT numbers and
company numbers without spacing, punctuation or case (UK company numbers
padded to eight digits), names without punctuation, case or legal suffixes
(`Ltd`, `Limited`, `PLC`, …).

1. A VAT or company number a supplier holds resolves to it. If the invoice's
   numbers belong to different suppliers, or the supplier holds a different
   number of the same kind, it stays **unresolved** (conflicting identifiers).
2. A VAT or company number no supplier holds makes a **new** supplier, unless
   exactly one supplier has the name and no registration number yet; that
   supplier then gains the number.
3. A name alone resolves only when exactly one supplier carries it. When two
   suppliers share the name (for example two businesses with different VAT
   numbers), a name-only invoice stays **unresolved** rather than being
   attributed to either.

Bank details never decide identity, because they are what the history checks
watch. Documents processed before this existed are given a supplier, oldest
first, the next time the workspace processes an invoice.

**History retrieval.** An invoice is compared only with its own supplier's
earlier documents in its own workspace, however far back, through bounded
indexed queries (`SUPPLIER_HISTORY_LIMITS`): the 20 most recent, up to 10
with the same number or the number it credits, up to 10 with the same date
and total, the 5 most recent with bank details and the first 3 with these
exact bank details. Default judgments receive the same supplier-scoped
history (never another supplier's) and record which documents they saw
(`historyIds`); with no identified supplier they answer "not applicable".

**Checks** (`inbox.supplier_checks`, `SUPPLIER_CHECKS_VERSION`), each with a
message and the earlier documents it cites:

| Check | Outcomes |
| --- | --- |
| `known` | `known` (with the count of earlier documents and the first), `first_invoice`, `insufficient_evidence` (supplier not identified) |
| `duplicate` | `likely_duplicate` (same type and number with the same date and total, or the same date and total under another number), `revision` (same number, different date or total), `credit_note` (linked to the invoice it credits, not a duplicate), `none`, `insufficient_evidence` |
| `bankDetails` | `consistent` or `changed` against the supplier's most recent bank details (a GB IBAN and its sort code and account compare as one account), `not_present`, `insufficient_evidence` (supplier not identified, or no earlier bank details to compare) |

An identical file received again is not a separate document (see
[Identity](#identity)). Stored results keep the supplier, the rules version,
the time they ran and every earlier document they used, so they stay
explainable after later invoices arrive; **Re-run supplier checks** (any
member) recomputes one against the current history. Bank details appear in
results only as their kind and last four characters, and validation messages
mask an IBAN the same way, so neither logs nor notifications carry them.

**Corrections.** An owner or admin can assign an invoice to another supplier
(or a new one), and merge one supplier into another (its records point at the
kept supplier and keep their own identifiers). Each change is a
`supplier_events` row with who made it and what it replaced, and can be
undone exactly unless a later change built on it. Later invoices, and the
invoice corrected, are checked against the chosen supplier; other stored
results stay as recorded until re-run. A manual assignment survives
reprocessing. The dashboard shows all of this in the invoice's **Supplier
history**; REST and MCP return `supplierId` and `supplierChecks`.

## Reads, signatures and deletion

- `inbox.getById`, REST `/inbox/{id}/presigned-url`, the dashboard
  `/api/proxy` and `/api/preview` routes, retry and delete all resolve the
  persisted binding for the caller's workspace first. Client input is only an
  inbox id.
- Capability URLs sign `bucket/path/expiry/download/inboxId` and are capped at
  900 seconds (routes use 60–300 seconds). The serving route re-reads the
  binding on every request, so a deleted or re-bound record invalidates older
  links immediately, and a malformed or traversal-shaped path fails closed with
  401.
- Legacy rows (null intake state) are only served when the persisted path stays
  inside the record's own workspace; a row whose path points at another
  workspace's prefix is refused. `reserved` rows are never served or signed.
- Deletion is only the delete endpoint/procedure. The inbox update schemas
  (REST `PATCH /inbox/{id}` and tRPC `inbox.update`) do not accept
  `status: "deleted"`, because a status edit would skip the tombstone, object
  removal and replay-identity release.
- Deleting a legacy row never removes an object that another live row in the
  workspace still references.
- Responses are `Cache-Control: private, no-store` with
  `X-Content-Type-Options: nosniff`, a sandboxing CSP and an inline/attachment
  `Content-Disposition`. Tenant content never enters a shared cache.

## Non-invoice assets

Logos, avatars, OAuth app logos and OAuth screenshots live under a separate
`assets` branch: `<namespace>/assets/<kind>/<id>/<file>` with
`kind ∈ {avatar, logo, app-logo, screenshot}`. The client sends only a kind; the
server derives the namespace (user id for avatars, workspace for logos and
screenshots, the public `logos` namespace for app logos). Reads follow the same
policy: app logos are public, avatars are readable by any signed-in session, and
team assets only by their workspace. An invoice path (`<team>/inbox/...`) can
never satisfy the asset shape, so this route is not a raw document read.

## Mailbox intake

Mailbox attachments use the same intake service. Provider identity is
`(team_id, reference_id)` and each attachment occurrence is included in the
reference, so two same-named attachments in one message stay distinct. A
transient `storage_unavailable` or `temporarily_unavailable` result fails the
webhook with 503 (so the provider retries) and fails the sync job instead of
marking the account synced; permanent rejections are logged and returned in the
sync result. A `reserved` record is not treated as an already-delivered
attachment, so the next sync recovers it. The webhook validates a message's
attachments one at a time, so an email with more PDFs than the parser
admits at once is not refused with 503 on every retry.

Scheduled syncs form a chain: each run enqueues the next 6-hourly slot. A
run that exhausts its retries (or fails permanently) still enqueues the next
slot without advancing `lastAccessed`, so one failing message or a provider
outage delays the mailbox instead of stopping it for good.

Both boundaries are covered by checks: the webhook route is driven with local
stubs (storage and parser-capacity transients → 503 with a retry message,
permanent → 200, occurrence
identity preserved) and the real sync workflow is run with a stubbed connector
against a deliberately unwritable vault path and with parser admission forced
to zero (job retried, account `lastAccessed` unchanged, no intake row for the
capacity failure, then a successful recovery run once storage/admission is
available again). The HTTP upload route is checked separately: capacity returns
503 and the same bytes succeed on retry.

## Deployment note

Signed URLs are minted against `STORAGE_PUBLIC_URL`. The storage serving route
sends the API's default same-origin resource policy, so the browser preview
works when `/storage` is served from the app origin (the dashboard also has the
session-authenticated `/api/proxy?id=` route). If a deployment puts storage on a
separate host, that origin must be reachable with CORS or the preview should use
`/api/proxy`; this is a deployment decision, not part of #34.

## Checks

- `packages/documents/src/intake.test.ts` — sniffing, spoofed MIME, size, page,
  pixel, malformed and password-protected bounds, busy-process termination
  (with a ready handshake), memory-budget termination and the real-document
  timeout.
- `packages/documents/src/supplier.test.ts` — supplier resolution (VAT,
  company number, merged suppliers, same-name suppliers, ambiguous names,
  conflicting identifiers) and history checks (first invoice, duplicate,
  revision, same date and total, credit notes, changed and masked bank
  details, unresolved suppliers).
- `packages/jobs/src/verify-suppliers.ts` — end to end against Postgres in
  `bun run verify`: two same-named suppliers send repeated, revised and new
  invoices, a credit note and a bank change behind 60 others; results find
  evidence beyond the latest 50, cite only their own supplier and workspace,
  stay unchanged by later invoices; merges and reassignments are audited and
  undone; an identical re-delivery is recorded without a second job.
- `packages/documents/src/validation.test.ts` — rounding and tolerances,
  tax basis, zero and missing tax, currency pairs and mismatches, credit
  notes printed either way, duplicate identity, credit links, required
  fields, low confidence and legacy records.
- `packages/documents/src/test/corpus/corpus.test.ts` — the validation corpus
  gate against its recorded thresholds.
- `packages/documents/src/typesafe/invoice.test.ts` — the supported input
  matrix: the same invoice as text PDF, scanned PDF, PNG and JPEG photo
  yields identical data and shape; multi-page (text and mixed) invoices keep
  every page and table row; non-invoice, malformed and unsupported inputs
  fail with a reason; each extraction limit fails instead of truncating.
  TypeSafe is a deterministic local oracle; the one real-provider test runs
  only with `TYPESAFE_LIVE_SMOKE=1` and a key.
- `packages/documents/src/isolated.test.ts` — text extraction, no silent
  character/page truncation, first-page render, scaled-pixel bounds, typed busy
  admission, saturated preview admission leaving intake admission free,
  fail-closed RSS-sampler behavior, broken page trees classified as
  permanent `malformed` (not transient), and a child environment without the
  parent's secrets.
- `packages/inbox/src/generate-id.test.ts` — backward-compatible Gmail
  attachment references for same-named attachments.
- `apps/dashboard/src/app/api/webhook/inbox/webhook-routes.test.ts` — webhook
  acknowledgment and sequential attachment intake.
- `packages/db/src/storage.test.ts`, `packages/db/src/storage.s3.test.ts` —
  immutable writes, inbox-bound signatures, expiry cap, S3 conditional write.
- `packages/db/src/queries/inbox-binding.test.ts` — the shared document-binding
  validator (workspace, namespace, traversal, separators, empty segments).
- `apps/api/src/intake.http.integration.test.ts` — real HTTP intake, queue,
  worker, capability download and delete across two workspaces, plus the forged
  path, foreign id, traversal, expired URL, replay, conflict, crash-recovery,
  worker-refusal, foreign-legacy-binding, concurrent-retry, failed-cleanup,
  late-publication, ambiguous-publication-after-multiple-passes, explicit
  settlement, paginated full-pass cleanup, transient-readback,
  pending-cleanup-versus-retry, HTTP parser-capacity and mailbox-admission
  cases, uploads proceeding while every preview slot is taken, a slow-storage
  stub proving no pool connection is held during storage I/O, plus same-named Gmail attachments, update-cannot-delete, shared legacy
  objects surviving delete and cleanup, hidden reservations and the sync chain
  surviving an exhausted run.
- `packages/jobs/src/verify-workflows.ts` — end-to-end pipeline verifier on the
  new contract, including the input matrix through real intake, queue,
  worker and Postgres: the same invoice as text PDF, scan, PNG and JPEG
  persists the same data shape with its own source identity, and a
  non-invoice attachment persists its failure reason.
