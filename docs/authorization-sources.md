# Authorization sources

The authorized work invoices are checked against: **jobs**, **purchase
orders** and **contracts**. A workspace creates them in the dashboard
(**Authorizations**), imports them from a CSV file, or has another system send
them through the REST API. InvoiceWise records what was authorized and keeps
every change; it is not a procurement system and does not raise or approve
orders. Invoices are [matched to these sources](authorization-matching.md)
with the version in effect on the invoice date.

The rules are plain code in `packages/documents/src/authorization-source.ts`
(validation, CSV parsing) and `packages/jobs/src/authorization-sources.ts`
(versioning, import, supplier links, documents); the tables are
`authorization_sources`, `authorization_source_versions`,
`authorization_source_documents` and `authorization_source_imports`.

## What a source records

| Field | Notes |
| --- | --- |
| `type` | `job`, `purchase_order` (alias `po`) or `contract` |
| `reference` | the workspace's own stable id (PO number, job number, contract ref). With the type it identifies the source; it is compared without spacing, punctuation or case, so `PO-1001` and `po 1001` are the same source |
| `status` | `open`, `closed` or `cancelled`. New sources are `open`; an amendment that does not give a status keeps the current one |
| `title`, `scope` | what is authorized: a short title and the job or contract scope |
| `supplier` | `name`, `vatNumber`, `companyNumber` as given, or `id` of a workspace supplier (see [Supplier link](#supplier-link)) |
| `currency` | ISO 4217 code. May be left out, but is then shown as missing, never assumed |
| `taxBasis` | `exclusive` (alias `net`), `inclusive` (`gross`) or `not_applicable` (`none`): whether authorized amounts include tax. May be left out; shown as not stated |
| `issuedOn`, `startsOn`, `endsOn` | `YYYY-MM-DD`; the end may not precede the start |
| `lines` | authorized line items: `reference` (unique within the source), `description`, optional `quantity` and `unitPrice` (up to 4 decimal places) and `amount` (2 decimal places). The amount may be left out when quantity and unit price are given, and must otherwise equal quantity × unit price to the penny |
| `authorizedTotal` | required when there are no lines; with lines it is their sum and, if given, must equal it |
| `effectiveFrom` | when this version takes effect (see [Versions](#versions-and-effective-dates)) |
| `changeReason` | why a version was recorded (for example `Variation 2`) |

Amounts are non-negative, exact decimals and never rounded silently. Every
problem with a source is reported together, not just the first.

What a source does not say is stated explicitly on every read as `gaps`:
`unknown_supplier`, `missing_currency` and `missing_tax_basis`. The list can be
filtered to sources with an unknown supplier or no currency.

## Versions and effective dates

A source's terms live in immutable **versions**, numbered from 1. Amending a
source, closing, reopening or cancelling it, or linking its supplier records a
new version; the earlier versions are kept exactly (a database trigger refuses
any edit to a stored version). The dashboard, tRPC and REST read any version
by number.

Each version has an **effective date**. A new source's first version takes
effect from `effectiveFrom`, else its start date, else its issue date, else
the day it was recorded. An amendment or status change takes effect from
`effectiveFrom`, else the later of the day it was recorded and the current
version's effective date, so a version built on a future-dated amendment never
applies that amendment's terms before its date. An explicit `effectiveFrom` is
honoured as given. A supplier link keeps the current version's effective date,
because the terms did not change.

The **version in effect on a date** is the highest-numbered version whose
effective date is on or before it; there is none before the first version
takes effect. Given `asOf` (a time), only versions recorded by then count, so a
comparison made at that time can be reproduced exactly after later
amendments. A comparison that cites a version id always finds the same terms.

Re-supplying a source whose terms have not changed records nothing (the result
is `unchanged`); the effective date and change reason alone are not a change.

A **cancelled** source can no longer be amended or reopened: record the work
under a new reference. Re-sending it unchanged (still cancelled) is accepted as
`unchanged`; re-sending it with any change rejects the whole batch.

## Supplier link

A source links to a workspace supplier by the same rules invoices use
([supplier identity](document-intake.md#supplier-identity-and-history)): a VAT
or company number a supplier holds links to it; a name links only when exactly
one supplier carries it; conflicting identifiers or a shared name stay
unlinked. A supplier is never created from a source, so a supplier nobody has
invoiced from yet stays an explicit **unknown supplier** until an owner or
admin links it (a new version) or a later version resolves it. A later version
with the same supplier details keeps an existing link, including a manual one.
Merged suppliers are followed to the supplier they were merged into. How each
version was linked is kept in `supplierResolution`.

## Who can do what

Every member reads sources, their versions and their documents. Only owners
and admins create, import, amend, close, cancel or link them or attach
documents: sources are the commitments invoices are checked against, so they
are kept away from the members who process invoices
([permissions](permissions.md)). API credentials need the `sources.read` or
`sources.write` scope; a member's credential can hold `sources.read` only.
Everything is scoped to the caller's workspace: another workspace's source id
is answered as not found, and the same reference in two workspaces is two
unrelated sources.

## CSV import

**Authorizations → Import CSV** (or `POST /authorization-sources/import`).
The dashboard links a template. Encoding UTF-8, comma-separated, first row the
header; quoted fields and doubled quotes follow RFC 4180. Up to 2 MB, 5,000
rows and 500 sources per file.

One row per authorized line. Rows with the same `source_type` and `reference`
form one source; its other source-level columns may be repeated on every row or
given once, but must not disagree. A source without lines is one row with
`authorized_total` and the line columns empty.

| Column | Field |
| --- | --- |
| `source_type` (required) | `type` |
| `reference` (required) | `reference` |
| `status`, `title`, `scope` | as above |
| `supplier_name`, `supplier_vat_number`, `supplier_company_number`, `supplier_id` | `supplier` |
| `currency`, `tax_basis` | as above |
| `issued_on`, `starts_on`, `ends_on`, `effective_from` | dates, `YYYY-MM-DD` |
| `authorized_total`, `change_reason` | as above |
| `line_reference`, `line_description`, `quantity`, `unit_price`, `line_amount` | one authorized line |

Unknown or repeated columns reject the file. Amounts may use `,` as a
thousands separator (`1,250.50`).

**All or nothing.** The whole file is validated before anything is written. A
file with any bad row, rows of one source that disagree, or any change to a
cancelled source is **rejected**: nothing is
created or amended, and every problem is reported with its row (the header is
row 1), column, reference and message. An accepted file is applied in one
transaction. **Check file** (`dryRun`) reports what would happen without
writing. References are repeatable: importing the same file again reports
every source `unchanged`, and a changed row amends its source. Every applied
or rejected import is kept with its outcome (**Recent imports**;
`GET /authorization-sources/imports`).

## REST API

For systems that already hold the jobs, orders or contracts: send them as they
now stand, keyed by type and reference. No bespoke connector is needed.

```bash
curl -X POST "$INVOICEWISE_API_URL/authorization-sources" \
  -H "Authorization: Bearer $INVOICEWISE_API_KEY" \
  -H "content-type: application/json" \
  -d '{"sources": [{
        "type": "purchase_order", "reference": "PO-55120",
        "supplier": {"name": "Northwind Joinery Ltd", "vatNumber": "GB293445512"},
        "currency": "GBP", "taxBasis": "exclusive", "issuedOn": "2026-09-02",
        "lines": [{"reference": "1", "description": "Oak boards",
                   "quantity": 120, "unitPrice": "18.50"}]
      }]}'
```

| Route | Scope | Result |
| --- | --- | --- |
| `GET /authorization-sources` | `sources.read` | current state of each source; `q` (reference, title, supplier), `type`, `status`, `supplierId`, `gap`, `cursor`, `pageSize` |
| `GET /authorization-sources/:id` | `sources.read` | the current version, every version's summary and the retained documents |
| `GET /authorization-sources/:id/versions/:version` | `sources.read` | one version's full terms |
| `GET /authorization-sources/:id/effective?on=YYYY-MM-DD[&asOf=<ISO time>]` | `sources.read` | the version in effect on that date; `404` if none was |
| `POST /authorization-sources` | `sources.write`, admin | `{"sources": [...], "dryRun": false}`, 1–500 sources, all or nothing; a reference given twice rejects the request |
| `POST /authorization-sources/import[?dryRun=true]` | `sources.write`, admin | a CSV file as `text/csv` (or `{"csv": "...", "fileName": "..."}`) |
| `GET /authorization-sources/imports` | `sources.read`, admin | recent imports and batches with their outcome |
| `POST /authorization-sources/:id/documents` | `sources.write`, admin | multipart field `file`: attach a document |
| `GET /authorization-sources/:id/documents/:documentId` | `sources.read` | the retained document |
| `GET /authorization-sources/:id/invoices` | `sources.read` and `inbox.read` | the invoices currently [matched](authorization-matching.md) to the source, with the version compared and the amount allocated to it |

A batch answers `200` with `status` `applied` (or `validated` for a dry run),
a `summary` (`created`, `amended`, `unchanged`) and one result per source
(`sourceId`, `version`, `outcome`, `status`, `supplierId`, `gaps`); or `422`
with `status: "rejected"` and `errors`, each naming the source's position
(`index`) or CSV `row`, the `field` or `column`, the `reference` and a
`message`. Amounts are returned as decimal strings.

## Retained documents

A PDF, PNG or JPEG of the signed order, the contract or other evidence (up to
5 MB, checked by content, not by name) is attached to the version that is
current when it arrives, so each version keeps the evidence it was recorded
with. The same file attached twice is kept once. Documents are stored in the
workspace's private storage (`<workspace>/authorization-sources/<source>/…`),
served only to the workspace's members, and never edited.

## Lifecycle

Sources, versions, documents and import records are kept while the workspace
exists, are included in the owner's [workspace export](data-lifecycle.md)
(`authorization-sources.json` and the documents), and are removed with the
workspace ([offboarding](offboarding.md)). A deleted user's name is removed
from the versions and documents they recorded.

## Proof

`bun run --cwd packages/jobs verify:authorization-sources` (part of
`bun run verify`) imports a job, a purchase order and a contract from CSV,
amends the purchase order and reads back the original, the current version and
the version in effect on dates before and after the amendment (and as recorded
before it). It also covers a rejected file writing nothing, row-level errors,
duplicate references, idempotent re-import, cancelled sources, the immutability
trigger, supplier links (explicit, ambiguous name, manual link kept) and
workspace isolation. Role and workspace isolation over tRPC and the scoped REST
API are in `apps/api/src/trpc/routers/team.permissions.integration.test.ts`
and `apps/api/src/permissions.http.integration.test.ts`.
