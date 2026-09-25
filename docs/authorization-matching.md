# Matching invoices to authorization sources

Each processed invoice is matched to the [authorization
sources](authorization-sources.md) it bills: the jobs, purchase orders and
contracts of its own workspace. The match says which sources (and which of
their versions) the invoice bills, how much of it goes to each, how sure the
link is and why. Comparing the amounts and quantities with what was authorized
is [reconciliation](reconciliation.md), built on this record.

The rules are plain code in `packages/documents/src/source-matching.ts`
(`SOURCE_MATCHING_VERSION`, `SOURCE_MATCH_THRESHOLDS`,
`SOURCE_MATCH_LIMITS`); the service is `packages/jobs/src/source-matching.ts`.
TypeSafe is the only model involved, and only as described under
[Semantic judgment](#semantic-judgment).

## When matching runs

Saving a processed revision queues a `match-invoice` job in the same
transaction (one per revision), so a completed invoice always has its match
intent. A [correction](delivery.md#corrections) of the invoice's values is a new revision
and queues matching again the same way. The job runs after processing: an invoice's accounting and webhook
deliveries are not held back by matching. The job counts against the TypeSafe daily call budget like processing does.

## How a source is chosen

Only the invoice's own workspace is searched. Candidates are found three
bounded ways:

- **Printed references.** The invoice's purchase-order field, whole, and
  reference-shaped tokens in its description and line descriptions (at most 40).
  References compare like source references: without spacing, punctuation or
  case, so `PO 55120` is `PO-55120`. A free-text token counts as a reference
  only when letters and digits are printed together (`JOB-1042`, `CT/2026/07`)
  or after a reference word (`PO`, `Job`, `Order`, `Contract`, `WO`, `CT`); a
  printed amount or date never does. A number alone (`Job no. 1042`) is looked
  up by the source reference's number but never links on its own.
- **The invoice's supplier.** Up to 20 open or closed sources linked to the
  invoice's workspace supplier (after merges).
- **Unlinked sources.** Up to 50 sources with no linked supplier, kept only
  when the supplier they name agrees with the invoice's (VAT number, company
  number, else the same name). This re-resolves sources recorded before their
  supplier had invoiced.

Each candidate is compared at the **version in effect on the invoice date**
(the date the invoice was received when it prints none), as recorded when the
match ran (`asOf`), so the comparison can be reproduced after later
amendments. When no version was in effect yet, the current version is compared
and the evidence says so.

Every candidate records its evidence: the printed reference and where it was
printed, the version compared, whether the supplier agrees (`same`,
`name_only`, `unknown`, `different`), its status, whether the invoice date is
within the authorized period, and whether the currencies agree. Three things
reject a candidate outright, whatever else points to it:

| Rejection | When |
| --- | --- |
| `wrong_supplier` | the source is recorded for another supplier (linked supplier, VAT or company number differs) |
| `cancelled` | the version compared is cancelled |
| `currency_conflict` | the source authorizes another currency; amounts in different currencies are never compared |

A closed source, a date outside the period and a version not yet in effect are
recorded as conflicting evidence but do not reject.

**Decision**, in order:

1. **Exact reference.** Every eligible source whose reference the invoice
   prints is linked (`method: "reference"`, confidence 1); TypeSafe is not
   asked. When one reference names two sources (a job and a purchase order both
   `A-100`), the purchase-order field decides for the purchase order; otherwise
   the match is `ambiguous`.
2. **Semantic judgment.** With no exact reference, the eligible candidates tied
   to the invoice by its supplier or a printed number (at most 8) are judged by
   TypeSafe, and code applies the thresholds below.
3. **Nothing to judge.** No candidate: `unmatched`, or
   `insufficient_evidence` when the supplier could not be identified and no
   reference is printed.

## Outcomes

| `status` | Meaning |
| --- | --- |
| `matched` | Linked to one or more sources. `needsConfirmation` is true for a semantic proposal |
| `ambiguous` | Two or more sources remain plausible; none is linked until a person chooses |
| `unmatched` | No source applies (none relates, all were rejected, TypeSafe judged none, or a person said so) |
| `insufficient_evidence` | Something relates but not enough to link: the supplier cannot be confirmed, no candidate is clear, or TypeSafe was unavailable on the job's last attempt |

`method` is `reference`, `semantic`, `manual` or null; `confidence` is 1 for
an exact reference and TypeSafe's probability for a semantic result.
`candidates` lists every source considered, including rejected ones, with its
evidence, and `message` says in words what was decided.

## Semantic judgment

TypeSafe receives the invoice (supplier, number, date, currency, totals,
description, purchase-order field and up to 40 line items) and one `choice`
question whose options are the candidate sources (type, reference, title,
scope, supplier, currency, period, authorized total and up to 20 authorized
lines) plus `none`. It selects among those options; it never names a source of
its own and never sees another workspace's. Code reads the probabilities
(`SOURCE_MATCH_THRESHOLDS`):

- `none` at 50% or more: `unmatched`;
- a second source at 20% or more: `ambiguous`;
- one source at 80% or more whose supplier is the invoice's (or has its
  name): `matched`, proposed (`needsConfirmation`);
- otherwise `insufficient_evidence`.

If TypeSafe is unavailable the job retries; the last attempt records
`insufficient_evidence` with the candidates listed for review.

## Allocations

A match records which part of the invoice each source takes: an invoice line
(or the whole invoice), optionally the authorized line it bills, and the
amount, a signed decimal in the invoice's currency (a credit note's
allocations are negative). Automatically:

- one source takes every line; a line is paired with the authorized line of
  the same description, or one whose description (6 characters or more) it
  contains;
- with no line items, one source takes the whole invoice: net against a
  tax-exclusive source, gross against a tax-inclusive one or when net is
  missing;
- with several sources, a line goes to the source whose reference it prints;
  other lines are left unallocated (`allocation.unallocatedLines`) for a
  person.

An admin linking several sources says which source each line bills (or gives
amounts); one source takes the whole invoice when nothing is given. One source
can be billed by any number of invoices: the source's **Matched invoices**
lists each with the version it was compared with and what it allocates there.

## Decisions, overrides and history

Every decision is a new, immutable row (`invoice_source_matches`, with its
`invoice_source_links` and `invoice_source_allocations`; a database trigger
refuses edits). The invoice points at its current decision
(`inbox.source_match_id`); earlier decisions, who made them and why stay in the
history.

| Action | Who | Effect |
| --- | --- | --- |
| `automatic` | the job | a processing run's result. An unchanged result for the same revision records nothing |
| `confirm` | owner, admin | confirms a matched invoice as it stands (typically a proposal) |
| `correct` | owner, admin | links the chosen sources (at the version in effect on the invoice date, or a named one) with allocations; a reason is required when it replaces a matched link |
| `unlink` | owner, admin | records that no source applies; a reason is required |

A processing retry or reprocessed revision **keeps** an owner's or admin's
decision; only another owner's or admin's decision replaces it, and the
replaced decision stays in the history. A change is refused with a conflict when the decision it was
made against (`expectedMatchId`) has since been replaced. A cancelled source or
one in another currency cannot be linked; a source recorded for another
supplier can, and its conflicting evidence is kept on the decision.

## Where it shows

- **Dashboard.** The invoice's **Authorization** panel: status, the linked
  sources and versions with their allocations, every candidate with its
  evidence, the decisions, and (for owners and admins) **Confirm match**,
  **Change sources** and **No source applies**. An ambiguous
  match offers **Choose** on each candidate. A source's page lists its
  **Matched invoices**.
- **REST and MCP.** `GET /invoices`, `GET /invoices/:id` and the MCP
  `get_invoice` and `list_invoices` tools return `sourceMatch`: the current
  decision (the fields above plus `id`, `sequence`, `origin`, `action`,
  `reason`, `decidedAt`), or null before matching. A credential without
  `sources.read` gets only `{ "status", "needsConfirmation", "sourceIds" }`:
  never the sources' references, types, titles or versions, the evidence,
  links or allocations. Dashboard sessions follow the member's role. Existing
  fields are unchanged. `GET /authorization-sources/:id/invoices` (scopes `sources.read`
  and `inbox.read`) lists the invoices currently matched to a source.
- **Webhooks.** `invoice.matched` is sent for every new decision, automatic or
  manual, to endpoints subscribed to it (existing endpoints keep the events
  they chose); see [webhooks](delivery.md#webhooks).
  `data` is `{ "invoiceId", "match" }` with `match` the full decision as
  returned by REST.

## Lifecycle

Decisions are kept while the invoice exists, removed with it and with the
workspace, and included in the owner's [workspace export](data-lifecycle.md)
(`source-matches.json`). A deleted user's decisions keep no link to them.

## Proof

`bun run --cwd packages/jobs verify:source-matching` (part of `bun run
verify`) processes invoices against Postgres and prints the evidence: an exact
purchase-order reference linked without TypeSafe; a free-text invoice
proposed for the right job and confirmed; two near-identical boiler jobs left
ambiguous and resolved by an admin with a reason that survives reprocessing; a
reference to another supplier's PO rejected; an invoice with no source
unmatched; and a neighbouring workspace's source never considered or
linkable. It also covers an invoice split across two sources, one source
billed by several invoices, amendments not changing a recorded match,
unlink with the history kept, stale edits refused, a TypeSafe
outage, idempotent reruns, the immutability trigger and the `invoice.matched`
intent. The rules' fixtures are in
`packages/documents/src/source-matching.test.ts`; role and workspace isolation
are in `apps/api/src/trpc/routers/team.permissions.integration.test.ts` and
`apps/api/src/permissions.http.integration.test.ts`; the `sources.read`
summary is in `apps/api/src/effect/invoice-read.test.ts`.

## Reconciliation

Every decision is reconciled with the sources it links: see
[reconciliation](reconciliation.md). A proposal (`needsConfirmation`), an
ambiguous match and `insufficient_evidence` are unresolved there and are
never counted against a source's balance.
