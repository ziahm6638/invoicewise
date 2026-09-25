# Bank payments (optional)

A workspace can connect its bank so each invoice shows whether it was paid,
part paid or not, with the bank transactions behind that and why they count.
It is optional, off for every workspace until an owner or admin turns it on,
and separate from [matching invoices to authorization
sources](authorization-matching.md): the payment decision never reads or
changes the authorization decision, and the reverse.

## Scope decision

Recorded for issue #9 (roadmap item 9 of the owner's plan): bank-payment
reconciliation is **retained** in the release as an optional branch, through
[Salt Edge](https://www.saltedge.com/) Account Information only. It is not a
dependency of authorization reconciliation (Layer 2), which stays the
supported path for matching invoices to jobs, purchase orders and contracts.

- It is **not** the removed Midday banking product. GoCardless, Plaid and
  Teller stay retired, and the inherited `bank_accounts`, `bank_connections`
  and `transactions` tables and their queries are unused. This feature has
  its own tables (`bank_payment_settings`, `bank_feed_*`,
  `invoice_payment_*`).
- **Provider access.** Development and staging use a Salt Edge **sandbox**
  (test-status) app: the one SortX already holds, with its values copied into
  InvoiceWise's own Infisical project (`staging`). No paid Salt Edge account,
  live-status app, real bank access or live testing is implied or was
  requested. **Production stays off**: its `BANK_PAYMENTS_ENABLED` is `false`,
  and even when set the API refuses to offer bank payments in production
  without `SALT_EDGE_PRIVATE_KEY`, because only a live-status app (which must
  sign every request) may connect real banks. Going live needs an owner
  decision, a live Salt Edge app and its commercial terms first.
- Read only: the consent scopes are `accounts` and `transactions`. InvoiceWise
  cannot initiate payments.

## Turning it on and connecting a bank

Settings → **Bank payments** (owners and admins).

1. **Switch it on** for the workspace. A deployment without a configured
   provider shows why it is unavailable instead.
2. **Connect a bank.** The admin chooses a consent period (30, 60, 90 or 180
   days) and ticks the consent: read-only access to that bank's accounts and
   transactions, through Salt Edge, for that period, to match payments to
   invoices. InvoiceWise records who gave it and when, then sends the browser
   to Salt Edge's connect page; the bank sign-in happens there and InvoiceWise
   never sees the credentials.
3. **Back from the bank**, Salt Edge appends the connection id to the return
   URL. The API asks Salt Edge for that connection and accepts it only if it
   belongs to **this workspace's own Salt Edge customer**; a connection of any
   other customer (another workspace's, or anything guessed) is refused. With
   no id on the return, the workspace's newest connection not yet held is
   taken from Salt Edge's list for its own customer.

Each workspace has one Salt Edge customer, created on its first connect with
the identifier `invoicewise-<environment>-<workspace id>` (so staging and
development never share one). Callbacks, returns and syncs are attributed to
a workspace only through that customer.

| Connection status | Meaning |
| --- | --- |
| `pending` | a connect attempt has started; the bank sign-in has not come back |
| `active` | connected with a live consent; synced every 6 hours and on **Sync now** |
| `reconnect_required` | the consent expired or was revoked at the bank; nothing is pulled until **Reconnect** |
| `failed` | the connect attempt did not complete (the error class is shown) |
| `disconnected` | disconnected by an admin, or removed at the bank or Salt Edge |

**Reconnect** asks for the consent again (a new period) and opens Salt Edge's
reconnect page; the connection keeps its accounts, transactions and cursors.
**Disconnect** removes the connection at Salt Edge (which revokes its consent),
stops syncing, and deletes every transaction of that connection that no
payment decision counts; transactions an invoice's payment counts (and the
entries that reversed or replaced them) stay as that decision's evidence.
Turning bank payments off is refused while a bank is connected.

## Sync

A `sync-bank-connection` job runs when a connection becomes active, every
6 hours after that (a chain keyed by the slot, which ends when the
connection is no longer active), on **Sync now** (at most once per 5 minutes;
it also asks Salt Edge to refresh from the bank), and on a signed Salt Edge
`success`/`notify` callback that says fetching finished. Each sync:

1. checks the connection still belongs to the workspace's customer and waits
   (retrying) while Salt Edge is still fetching from the bank;
2. reads the consent: expired or revoked moves the connection to
   `reconnect_required` and stops;
3. upserts the accounts;
4. reads **posted** transactions per account from the account's durable
   cursor (`bank_feed_accounts.posted_cursor`, Salt Edge's `from_id`), page by
   page, saving the cursor after each page, at most 10 pages per run (the rest
   continues in a follow-up job);
5. reads the whole current **pending** list;
6. resolves states and records a summary (new, pending, replaced, reversed,
   duplicates) or the error on the connection, shown on the settings page and
   in `GET /bank-payments`.

Transactions are stored once per account and Salt Edge id, so a repeated or
overlapping page never duplicates one. Amounts are kept as the bank's signed
decimals (money out is negative) in the account's currency.

| Transaction status | When |
| --- | --- |
| `pending` | in the bank's current pending list |
| `posted` | booked |
| `superseded` | a pending entry no longer listed whose posted entry arrived: same account, amount and currency, dated within 10 days (the pending row points at it) |
| `reversed` | a pending entry dropped without a posted one, or a posted entry offset by a later reversal, and that reversal itself |

A posted entry is **reversed** only on evidence: a later entry on the same
account within 45 days, of exactly the opposite amount in the same currency,
described as a reversal or return (`REVERSAL`, `RETURNED`, `RECALL`,
`CHARGEBACK`, `UNPAID`, …), that names the same counterparty or repeats most
of the original's words. An opposite amount alone (a supplier's refund) is
never taken for a reversal. Salt Edge's own `duplicated` flag is stored and a
duplicate is never counted. A pending entry Salt Edge renumbers keeps its row.

## Matching payments to invoices

The rules are plain code in `packages/jobs/src/payment-rules.ts`
(`PAYMENT_MATCHING_VERSION`, `PAYMENT_MATCH_RULES`); no model is asked. The
`match-payments` job decides every processed invoice of the workspace after a
sync and after an invoice revision is processed or corrected (only for
workspaces that use bank payments), credit notes first, then invoices, oldest
first, under a workspace lock so no two decisions count the same part of one
transaction.

A transaction is considered for an invoice only when it is in the invoice's
**own currency** (amounts are never converted and no FX is ever applied),
moves money the right way (out for an invoice, in for a credit note's
refund), is dated from 14 days before the invoice date (the date received when
it prints none) to 365 days after, is not a duplicate, reversed or replaced,
and still has an amount that other invoices' current decisions do not count.

Evidence per transaction: whether it prints the invoice's number or payment
reference whole (`INV 2026-0042` prints `INV-2026-0042`; references need 4+
characters with a digit), whether it names the supplier (every word of its
name but legal suffixes), whether it prints **another** invoice's reference,
the amount against what is due, the date, its status and what is left of it.

**Decision**, in order:

1. **Printed reference.** Posted transactions that print the invoice's
   reference are counted, oldest first, up to what is due: `matched`, `paid`
   or `partially_paid`. A reference of digits only and shorter than 6 is
   common to many suppliers, so it counts only with the supplier's name as
   well. What a counted transaction has left over is shown (a bank charge, for
   example).
2. **Pending.** Only pending transactions print it: `pending` (not paid).
3. **Exact amount, no reference.** One posted transaction for exactly the
   amount due that names the supplier (or, failing any such, one for exactly
   the amount within 120 days) is `proposed`: it counts only once an owner or
   admin confirms it. Two or more are `ambiguous` and none counts until an
   owner or admin chooses. A transaction printing another invoice's
   reference is never proposed.
4. Otherwise `insufficient_evidence` (something relates, nothing is clear) or
   `unmatched`.

**Credit notes.** A credit note refunded by an incoming transaction printing
its number is `paid`. Otherwise, when validation found the invoice it credits
(same currency), it is `applied` there: that invoice's amount due falls by the
credit, recorded as a `credit` allocation.

**Payment status** (`paymentStatus`): `unpaid`, `pending`, `partially_paid`,
`paid`, `overpaid` (only by an admin's decision, with a reason) or `applied`.
It counts only `payment` and `credit` allocations; a proposal, an ambiguity or
a pending transaction never makes an invoice paid.

## Decisions, overrides and history

Every decision is a new, immutable row (`invoice_payment_matches` with its
`invoice_payment_allocations`; a database trigger refuses edits) and the
invoice points at its current one (`inbox.payment_match_id`).

| Action | Who | Effect |
| --- | --- | --- |
| `automatic` | the job | the rules' result; an unchanged result for the same revision records nothing |
| `confirm` | owner, admin | counts a proposal as it stands |
| `correct` | owner, admin | records the transactions that paid it: for each, the amount paid to this invoice and optionally the part that was a **bank charge** (`fee`, never counted as paid). Refused for another currency, a pending, duplicate or reversed transaction, or more than is left of one. A reason is required when it replaces a matched decision or overpays |
| `unlink` | owner, admin | records that none of these transactions paid it; a reason is required |
| `reversal` | the job | a transaction a person counted was reversed at the bank: only it stops counting, the rest of their decision stands |

Automatic runs keep a person's decision (and a `reversal` carried from one).
A change is refused with a conflict when the decision it was made against
(`expectedMatchId`) has since been replaced.

## Where it shows

- **Dashboard.** The invoice's **Payment** section (only for a workspace that
  uses bank payments): status, what counts, every transaction considered with
  its evidence, the decisions, and for owners and admins **Confirm payment**,
  **Choose transactions** and **Not paid by these**. Members see the payment
  status and amounts only, never bank transactions. Settings → Bank payments
  lists connections (consent, expiry, last sync and its errors) and recent
  transactions with what each counts for.
- **REST and MCP.** `GET /invoices`, `GET /invoices/:id` and the inbox reads
  return `paymentMatch`, beside and independent of `sourceMatch`: the current
  decision (result plus `id`, `sequence`, `status`, `paymentStatus`, `origin`,
  `action`, `currency`, `dueAmount`, `paidAmount`, `reason`, `decidedAt`), or
  null. A credential without the `payments.read` scope gets only `{ status,
  paymentStatus, needsConfirmation, currency, paid, remaining }`: never the
  transactions or the evidence. `GET /bank-payments` (connections, consent and
  last sync) and `GET /bank-payments/transactions?connectionId&status&page`
  need `payments.read` and the owner or admin role. `payments.read` cannot be
  held by a member's credential.

## Provider callbacks

Register each callback type in the Salt Edge app at
`${SALT_EDGE_CALLBACK_URL}/<type>` (`success`, `fail`, `notify`, `destroy`,
`service`), e.g. `https://iw-staging-api.zzapp.uk/webhooks/saltedge/success`.
Salt Edge signs `<that URL>|<raw body>` with RSA-SHA256; the API verifies the
`Signature` header with Salt Edge's published v6 key (override with
`SALT_EDGE_CALLBACK_PUBLIC_KEY` on rotation) and refuses anything unsigned,
mis-signed, signed for another URL or altered. `success`/`notify` with a
finished stage queue a sync; `fail` records the error; `destroy` disconnects.
A callback naming a customer that is not a workspace's is acknowledged and
ignored. Callbacks are an accelerator, not a dependency: the return URL and
the scheduled sync work without them. The shared sandbox app's callback URLs
point at SortX, so InvoiceWise staging currently runs on returns and syncs
only.

## Deployment

| Key | Roles | Purpose |
| --- | --- | --- |
| `BANK_PAYMENTS_ENABLED` | api (secret) | `true` offers bank payments on the deployment; anything else hides them. Staging `true`, production `false` |
| `SALT_EDGE_APP_ID`, `SALT_EDGE_SECRET` | api (secret) | the Salt Edge app's credentials; also used to remove a deleted workspace's customer |
| `SALT_EDGE_PRIVATE_KEY` | api (secret, optional) | signs every request; required for a live-status app, and so for production |
| `SALT_EDGE_CALLBACK_URL` | api (clear) | base of the callback URLs registered with Salt Edge |
| `SALT_EDGE_BASE_URL` | api (optional) | defaults to `https://www.saltedge.com/api/v6` |
| `SALT_EDGE_CALLBACK_PUBLIC_KEY` | api (optional) | overrides Salt Edge's published callback key |

The dashboard's return URL is `${NEXT_PUBLIC_URL}/settings/bank-payments`.

## Lifecycle

Bank data is workspace data: kept while the workspace exists (transactions
of a disconnected bank only while a payment decision counts them), included in
the owner's export (`bank-feed.json`: connections without provider ids,
accounts and transactions; `payment-matches.json`: every decision with its
allocations), and removed with the workspace. Workspace deletion also removes
the workspace's Salt Edge customer, which removes its connections and
revokes their consent ([data lifecycle](data-lifecycle.md)).

## Proof

- `bun run --cwd packages/jobs verify:bank-payments` (part of `bun run
  verify`) runs against Postgres with an in-memory Salt Edge
  (`packages/jobs/src/fake-salt-edge.ts`, small pages): off by default and
  refused without consent or a provider (and in production without a signing
  key); two workspaces each with their own customer; another workspace's
  connection refused at return and by callback; paging with durable cursors
  and idempotent re-syncs; a referenced payment, part payments completed, an
  ambiguous pair resolved by an admin with a reason that survives automatic
  runs, an exact amount proposed and confirmed, a credit note applied, a bank
  charge, no match across currencies, a pending payment replaced by its
  posted one, a dropped pending entry, a duplicate never counted, reversals
  undoing an automatic and a manual payment, revoked consent and reconnect
  resuming from the cursor, removal at the provider, disconnect keeping only
  counted evidence, immutability, and no authorization-source decision
  touched.
- Unit tests: `packages/jobs/src/payment-rules.test.ts` (rules),
  `packages/jobs/src/salt-edge.test.ts` (client, availability, signing),
  `apps/api/src/bank-payments/callback.test.ts` (callback signatures),
  `apps/api/src/effect/invoice-read.test.ts` (`payments.read` summary), and
  the role and workspace checks in
  `apps/api/src/trpc/routers/team.permissions.integration.test.ts` and
  `apps/api/src/permissions.http.integration.test.ts`.
- **Sandbox walkthrough** against the real Salt Edge sandbox (Fake Bank
  Simple: any login starting `username`, password `secret`):
  `bun run --cwd packages/jobs prove:bank-sandbox <step>` (`start`,
  `complete`, `match`, `reverse`, `revoke`, `reconnect`, `disconnect`,
  `status`) with a sandbox app's `SALT_EDGE_APP_ID`/`SECRET` and a disposable
  `*_test` `DATABASE_PRIMARY_URL`. A person (or a browser driver) completes
  the bank sign-in at the printed URL. It is not part of `bun run verify`.

### Sandbox walkthrough, 2026-09-25

Run with the steps above against the shared SortX sandbox app, a disposable
local database and Fake Bank Simple (Salt Edge's consent page names the app's
owner, SortX Software Ltd):

| Step | Result |
| --- | --- |
| connect | 90-day read-only consent shown by Salt Edge (to 24 Dec 2026); the return carried no `connection_id`, so the connection was taken from the workspace's own customer: `active`, Fake Bank Simple |
| sync | 5 accounts, 17 posted transactions (GBP, EUR, USD, one at four decimal places); an immediate re-sync from the cursors stored nothing new; consent expiry recorded as 24 Dec 2026 |
| match | `BOOTS-773` for 12.51 GBP paid automatically by `25 SEP 26 BOOTS 773 LONDON`; a John Lewis invoice for 2.10 GBP only proposed from `CARD PAYMENT TO JOHN LEWIS 2.1 GBP`, then confirmed by an admin; a second sweep recorded nothing and kept the confirmation |
| reverse | the sandbox cannot post a reversal of its own data, so the bank's reversing entry (`REVERSAL 25 SEP 26 BOOTS 773…`, +12.51) was added to the synced account; the sync's rules marked both entries `reversed` and the Boots invoice went back to unpaid while the confirmed John Lewis payment stood. The sandbox's own -21/+21 USD sample pair, with no reversal wording, was correctly not taken for one |
| revoke, reconnect | consent revoked through Salt Edge's API: the next sync stopped with `reconnect_required` / `revoked`; reconnect with a 30-day consent (Salt Edge showed 25 Oct 2026) made it `active` again, and the sync resumed from the stored cursors (the fake bank added 5 new transactions; none stored twice) |
| disconnect | the connection was removed at Salt Edge (a later lookup returns not found), consent `withdrawn`, 20 uncounted transactions deleted and 3 kept (the John Lewis payment, and the reversed Boots pair as the earlier decision's evidence); the sandbox customer was then removed |

## Known limits

- Payments without a printed reference are only proposed; several payments
  that together pay an invoice without printing its number are recorded by an
  admin.
- Callbacks from the shared sandbox app go to SortX, so staging relies on the
  return and the scheduled sync.
- No `invoice.paid` webhook event yet; payment status is read from invoice
  reads.
