# Reconciling invoices with their authorization

[Matching](authorization-matching.md) says which jobs, purchase orders and
contracts an invoice bills and how much of it goes to each. Reconciliation
compares that with what was authorized: line by line and in total (quantity,
unit rate, tax and amount), and against what the source's other invoices have
already consumed, so partial invoices, credits, revisions and amendments move
the remaining authorized balance exactly once. The result is published on the
invoice and the source, in the API and in webhooks, and the
[delivery rules](delivery.md#delivery-rules) can hold on it.

The rules are plain code in `packages/documents/src/reconciliation.ts`
(`RECONCILIATION_VERSION`, `RECONCILIATION_TOLERANCES`); the service is
`packages/jobs/src/reconciliation.ts`. TypeSafe is asked only one thing, and
never about a number: see [Scope](#scope).

## When it runs

Every match decision, automatic or a person's, and every new revision of an
invoice (a correction, re-extraction or question rerun) queues a
`reconcile-invoice` job for that decision at that revision, in the same
transaction. The job:

1. asks TypeSafe about unpaired lines, if any (outside any transaction);
2. locks the invoice, then the linked sources in a fixed order, so two
   invoices billing one source are reconciled one after the other and the
   second sees what the first consumes;
3. reads what the sources' other invoices consume now, reconciles, records
   the result (`invoice_reconciliations`, with what it consumes in
   `invoice_source_consumption`) and makes it the invoice's current one;
4. announces `invoice.reconciled` and, when the delivery rules were waiting
   for it, decides the revision.

A decision or revision replaced meanwhile is skipped: its own job reconciles
it. A replay records nothing new. Reconciliations are immutable (a database
trigger refuses edits) and each invoice keeps its history.

## Arithmetic and tolerances

Money is compared in integer minor units of the invoice currency, quantities
and unit rates in ten-thousandths, all rounded half away from zero; nothing
is computed in floating point. A variance is invoiced minus authorized.

| Comparison | Tolerance |
| --- | --- |
| An amount, or a sum of amounts, against its authorized amount | 0.01 per invoice allocation in the sum (at least 0.01), because each printed line total may be rounded |
| A unit rate against the authorized unit price | 0.0050, because an invoice may print a four-decimal price rounded to pennies |
| A quantity against the authorized quantity | none: exact to four decimal places |
| Tax charged against a source that authorizes none | 0.01 |

Each result states the tolerances it applied.

**Tax basis.** A source's amounts are compared on its own basis: net for
`exclusive` and `not_applicable`, gross for `inclusive`. An invoice line is
moved to that basis with its printed tax (or its tax rate); a whole invoice
uses its net or gross total. A source that does not state its basis is
compared only with an invoice that charges no tax; otherwise the result is
unresolved. Sources record no tax rate, so tax is compared only against a
`not_applicable` source (which authorizes none). An amount a person gave
when linking is taken as stated, in the source's basis.

**Currencies are never converted.** InvoiceWise holds no approved conversion
data, so an invoice and a source in different currencies, or a source (or
invoice) whose currency is not known, are not compared: the result is
unresolved and the invoice is not counted against the source.

## What is compared

For each linked source, against the **version the match compared** (the one
in effect on the invoice date):

- **Per line**, for an invoice line paired with an authorized line: the
  quantity, the unit rate, the amount and (against a `not_applicable` source)
  the tax. A line that pairs with no authorized line is read against the
  source's scope.
- **In total**: the invoice's allocations to the source against the
  authorized total.

Against the **version in effect now** (else the newest), the **balance**:
authorized, committed before this invoice (by the source's other invoices),
this invoice, committed after, and remaining; and the same per authorized
line, by amount and quantity. An amendment therefore moves the balance at
once, while each recorded reconciliation keeps the terms it compared.

## Outcomes

| `status` | Meaning |
| --- | --- |
| `reconciled` | Within the authorized terms and the remaining balance |
| `discrepancy` | At least one supported discrepancy (below), with its evidence |
| `unresolved` | Something could not be compared, or the match is not settled (below) |
| `unmatched` | The invoice is not matched to any source |

**Discrepancies** — each names the source (and line) and carries what the
invoice and the source say:

| Code | When |
| --- | --- |
| `over_authorized_total` | this invoice takes the source's committed amount past its authorized total |
| `line_amount_over_authorized` | ...past an authorized line's amount |
| `quantity_over_authorized` | ...past an authorized line's quantity |
| `rate_above_authorized` | a line's unit rate is above the authorized unit price (a lower rate is recorded, not flagged) |
| `tax_not_authorized` | tax charged against a source that authorizes amounts without tax |
| `outside_scope` | a line pairs with no authorized line and reads as outside the source's scope |
| `line_not_authorized` | the version in effect now no longer carries the authorized line the invoice bills |
| `source_cancelled`, `source_closed` | the source is cancelled or closed now and the invoice adds to it |
| `outside_period` | the invoice date is outside the compared version's period |
| `credit_exceeds_invoiced` | a credit takes the committed amount below zero |

A credit (negative allocation) is never itself overbilling.

**Unresolved** — the invoice is compared as far as it can be, and never read
as within its authorization:

| Code | When |
| --- | --- |
| `match_needs_confirmation` | the match is a TypeSafe proposal: compared, but not counted until confirmed |
| `match_ambiguous`, `match_insufficient_evidence` | the match is not settled |
| `allocation_incomplete` | invoice lines of a split are not allocated to any source |
| `currency_missing`, `currency_mismatch` | see [Currencies](#arithmetic-and-tolerances) |
| `tax_basis_unknown` | the source does not state its tax basis and the invoice charges tax |
| `amount_missing` | an allocation's amount cannot be worked out on the source's basis |
| `scope_unclear` | an unpaired line's scope could not be judged with confidence |
| `duplicate_invoice` | the document repeats an earlier invoice's number: not counted again |
| `prior_uncounted` | another invoice of the source could not be counted, so its balance is not certain |

## Counting, without double consumption

A source's balance is never stored: it is the sum, in exact decimals, of the
consumption rows of its invoices' **current** reconciliations, counted only
when the invoice

- has a confirmed match (not a proposal, not ambiguous);
- is live (not deleted);
- is not a copy or a revised copy of an earlier invoice with the same number
  (a revised invoice is corrected on the original, which is counted once);
- and its current revision's delivery was not dismissed.

An invoice whose amount, currency or tax basis cannot be counted is listed as
not counted, with why, rather than converted or dropped. So a correction or
re-extraction replaces the invoice's consumption, a credit note subtracts, an
unlink or relink moves it, and a held invoice counts until it is dismissed;
nothing is counted twice.

## Scope

When an invoice line pairs with none of a source's authorized lines (or the
source lists no lines but has a written scope), TypeSafe is asked whether the
work it bills is `within_scope`, `outside_scope` or `unclear`, from the
line's description and the source's title, scope and authorized lines of the
invoice's own workspace. At 80% or more, `within_scope` explains the line (it
counts against the total) and `outside_scope` is a discrepancy; anything else
is unresolved. The answer never changes an amount, a quantity or the balance.
At most 20 lines per invoice are asked; a line already judged against the
same version is not asked again. If TypeSafe is unavailable the job retries;
the last attempt records the lines as unresolved.

## Delivery rules

Three checks join the [delivery rules](delivery.md#delivery-rules), all
**Deliver** by default, so no workspace gets an approval step it did not
choose:

| Rule | Holds when |
| --- | --- |
| Over or outside its authorization (`authorization_discrepancy`) | the reconciliation has a discrepancy |
| Authorization not confirmed (`authorization_unresolved`) | it is unresolved, or the revision could not be reconciled at all |
| No authorization (`authorization_missing`) | the invoice is unmatched |

A hold carries the reconciliation's own findings and is released or
dismissed like any other. When a workspace holds on any of them, each
revision's decision **waits for its reconciliation**: it is recorded as
`pending` (shown as *Delivering*; nothing is scheduled, a retry sends
nothing and it cannot be released or dismissed), and the reconciliation job
decides it under the policy in force then and schedules what the decision
lets through, in the same transaction. If that never happens (the job is
lost or fails for good), the runner's reconciler decides it after two
minutes as not reconciled, which the unresolved rule holds. A decision
already made is never re-decided: an amendment or a match changed later
shows in the reconciliation and the balance, and a person releases a held
invoice.

## Where it shows

- **Dashboard.** The invoice's **Authorization** panel shows the current
  reconciliation (status, findings, line variances, the balance when it was
  reconciled and now) and its history. A source's page shows its
  **Balance** (authorized, committed, remaining, per line) and each matched
  invoice's reconciliation and consumed amount. **Settings → Delivery rules**
  lists the three checks.
- **REST.** Invoice reads (`GET /invoices`, `GET /invoices/:id`) return
  `reconciliation`: the current result
  with `id`, `sequence`, `matchId`, `processingRevision`, `status`,
  `consumes`, `reconciledAt`, or null. A credential without `sources.read`
  gets only `{ "status", "discrepancies", "unresolved" }` with the findings'
  codes. `GET /authorization-sources/:id/balance` (`sources.read`) returns the
  source's balance now; with `inbox.read` as well it lists `byInvoice`, each
  invoice's counted amount or why it is not counted.
  `GET /authorization-sources/:id/invoices` adds each invoice's
  `reconciliationStatus` and `consumedAmount`.
- **Webhooks.** `invoice.reconciled` is sent for every recorded
  reconciliation to endpoints subscribed to it; `data` is
  `{ "invoiceId", "reconciliation" }` as REST returns it. A revision decided
  after its reconciliation carries a summary in its `invoice.processed` event
  (`data.reconciliation`: status, per-source balance, finding codes).

```json
{
  "status": "discrepancy",
  "sources": [{ "reference": "PO-7001", "citedVersion": 1, "currentVersion": 1,
    "basis": "net",
    "balance": { "authorized": "2000.00", "committedBefore": "1800.00",
      "invoiced": "300.00", "committedAfter": "2100.00", "remaining": "-100.00" } }],
  "discrepancies": [{ "code": "over_authorized_total",
    "message": "Purchase order PO-7001 authorizes GBP 2000.00 excluding tax (version 1); GBP 1800.00 was already invoiced against it and this invoice adds GBP 300.00, GBP 100.00 over the authorized total.",
    "evidence": { "invoice": { "amount": "300.00" },
      "source": { "authorized": "2000.00", "committedBefore": "1800.00", "remainingBefore": "200.00", "version": 1 } } }]
}
```

## Lifecycle

Reconciliations and their consumption are kept while the invoice exists,
removed with it, its source or the workspace, and included in the owner's
[workspace export](data-lifecycle.md) (`reconciliations.json`).

## Proof

`bun run --cwd packages/jobs verify:reconciliation` (part of `bun run
verify`) runs through the real queue and worker against Postgres, a
loopback accounting provider and a webhook consumer, under a policy that
holds discrepancies and unresolved reconciliations. It bills a purchase order
in two parts, exceeds its remainder, applies a credit and amends the order,
checking the balance, the reconciliation and the delivery decision after each
step. It also covers a revised copy of an invoice (not counted twice), a
higher unit rate, a cancelled order, a source without a currency, an invoice
with no source, two invoices reconciled at once against one order (exactly
one goes over), a match an admin overrides (the consumption moves with it), a
scope judgment that explains a line without changing an amount, a decision
whose reconciliation never came, the immutability trigger and a
neighbouring workspace's invoice never counted. The rules' fixtures are in
`packages/documents/src/reconciliation.test.ts` and the policy checks in
`packages/documents/src/delivery-policy.test.ts`. Observed on 2026-09-25:

```text
step                               reconciliation  decision                                     bills  balance
bill part 1 (40 x 20.00)           reconciled      deliver                                      1      PO-7001 v1: authorized 2000.00, committed 800.00, remaining 1200.00 (qty 40/100)
bill part 2 (50 x 20.00)           reconciled      deliver                                      1      PO-7001 v1: authorized 2000.00, committed 1800.00, remaining 200.00 (qty 90/100)
exceed the remainder (15 x 20.00)  discrepancy     hold [authorization_discrepancy]             0      PO-7001 v1: authorized 2000.00, committed 2100.00, remaining -100.00 (qty 105/100)
credit 10 boards                   reconciled      deliver                                      0      PO-7001 v1: authorized 2000.00, committed 1900.00, remaining 100.00 (qty 95/100)
amend PO to 120 boards             discrepancy     hold [authorization_discrepancy]             0      PO-7001 v2: authorized 2400.00, committed 1900.00, remaining 500.00 (qty 95/120)
release the held invoice           discrepancy     hold (released) [authorization_discrepancy]  1      PO-7001 v2: authorized 2400.00, committed 1900.00, remaining 500.00 (qty 95/120)
bill 20 more under v2              reconciled      deliver                                      1      PO-7001 v2: authorized 2400.00, committed 2300.00, remaining 100.00 (qty 115/120)
```

## Not yet covered

- The versioned `/v1` API and the MCP tools built on it do not carry the
  match or its reconciliation yet; read them from `GET /invoices/:id`.

- A credit note that credits a matched invoice but prints no source
  reference is matched (and so counted) on its own evidence only; it does not
  inherit the credited invoice's sources.
- Conversion between currencies needs approved conversion data, which
  InvoiceWise does not hold; such invoices stay unresolved.
