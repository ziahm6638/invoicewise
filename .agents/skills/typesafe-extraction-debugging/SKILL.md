---
name: typesafe-extraction-debugging
description: Use when invoices come back with empty or wrong extracted fields, all-No or odd judgments, failed or slow processing, or when changing the TypeSafe extraction pipeline and deciding whether a test may call the real TypeSafe API. Gives a layer-by-layer triage order and the spend rules.
---

# Debugging TypeSafe extraction

How extraction works is in `docs/document-intake.md#extraction`: code mines candidates from laid-out text, TypeSafe only selects among them, code normalises.
Most "the model got it wrong" reports are not model problems. Work down the layers and stop at the first broken one.

## Triage order

1. **UI or data?** Compare the invoice page with tRPC `inbox.getById` or `GET /v1/invoices/:id`. In the September 2026 extraction outage the API held the same empty fields; the UI was dropping nothing.
2. **Did processing fail?** Read `inbox.processing_error` (the user-facing reason) and the job's redacted `workflow_jobs.last_error`. `TypeSafe is not configured` means the running release had no `TYPESAFE_API_KEY`; that failure is not retried. The startup preflight now refuses such a release, so check which release processed the document.
3. **What text did the pipeline read?** The retained text is in `document_texts` (per invoice revision, with `chars` and `truncated`), and the extraction records `textSource` (text layer or OCR). If line structure is lost, with a whole page on one line, candidate mining finds nothing and TypeSafe is never asked: supplier, VAT, bank and line items all read "Not found" while number, date and total can still come through. That exact regression came from a text-extraction change that joined pdf.js items into one line.
4. **Were candidates found?** A value missing from the candidates is a mining bug in `packages/documents/src/typesafe/candidates.ts` or `line-items.ts`, not a model bug. `extraction.evidence.fields` shows which printed row each chosen value came from.
5. **Only now suspect TypeSafe's selection:** run the live smoke below on the same document.
6. **Judgments** receive the document text plus the extraction, and history checks without history record `not_applicable`. All-No on an empty extraction is the honest answer: fix extraction first.

Reproduce locally with `processInvoice` on the same PDF (the legacy `packages/documents/src/typesafe/invoice.test.ts` shows the harness). Regression coverage is an e2e journey that uploads a realistic PDF and asserts each field's value (`e2e/journeys/invoice-intake-review.journey.ts` does this for the synthetic invoice), not merely that an extraction exists; the outage slipped through tests that used pipe-separated text and only checked presence.

## Other symptoms

- **US-order dates:** stored day-first. Display follows the user's saved date format (the `MM/dd/yyyy` choice still exists); the default is UK.
- **Scans:** tesseract OCR runs in isolated child processes (`packages/documents/src/isolated.ts`), at most two at once. Expect about 4 s for a one-page scan and about 25 s for ten pages. Without a local `tesseract` the scanned-fixture test is skipped, so a local green says nothing about OCR.
- **HEIC** is refused on purpose with a "JPEG or PDF" message.
- **Old invoices keep old results.** Documents processed before a pipeline or validation change are not rewritten (for example "processed before validation existed"). Re-extract them through the product or `/ops/jobs/:id/retry`; never with SQL.
- **Slow-intake alert:** before touching code, read `/ops/metrics` `latency.intake.text` / `.scan` stage p95s (queue, text/OCR, TypeSafe, save) and the hourly `provider_usage` rows. A document that failed and was retried counts from its original acceptance, so an outage batch keeps the alert firing for 24 hours after the fix. Separate that from real queue waits.
- **Queue waits behind a slow job:** the runner once waited for a whole claimed batch before claiming again, so a text PDF waited behind a ten-page scan. If that pattern returns, look at the claim loop in `packages/jobs/src/runner.ts`.

## Spend rules

- The gate (`bun run gate`), `bun run verify` and the legacy suites never call the paid API: a loopback stub (`startTypeSafeStub` in `packages/jobs/src/verify-support.ts`, wired by `e2e/support/stubs.ts`) answers like a correct model for the committed fixtures. Never make the gate need a real key; a real call stays behind `TYPESAFE_LIVE_SMOKE=1` like the existing ones.
- Live runs happen on purpose only, with the key injected by Infisical and never printed:
  ```bash
  infisical run --env prod -- sh -c 'cd packages/documents && TYPESAFE_LIVE_SMOKE=1 bun test src/typesafe -t live'
  infisical run --env prod -- sh -c 'cd packages/documents && TYPESAFE_LIVE_SMOKE=1 bun test src/test/corpus'   # per-field accuracy report
  ```
- Budgets: 2000 calls per UTC day in production and 300 on staging (`TYPESAFE_DAILY_CALL_LIMIT`); processing costs about 3 calls per invoice. Once spent, processing waits until 00:00 UTC.
- Load generation happens on staging only (`scripts/ops/load-test.ts`).

## Pointers

- `docs/document-intake.md` (extraction, validation, corpus, questions, checks)
- `packages/documents/src/typesafe/`, `packages/documents/src/layout.ts`, `packages/documents/src/processors/invoice/invoice-processor.ts`
- `docs/operations.md#health-and-diagnostics`, `apps/api/src/ops/alerts.ts`
