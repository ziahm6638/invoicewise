/**
 * The validation corpus gate. Every reviewed document is read from its PDF
 * through the real pipeline (text layer, layout, candidate mining, line-item
 * tables, normalisation and deterministic validation), with TypeSafe played
 * by the deterministic oracle that selects the reviewed values. Scores must
 * meet `thresholds.json`; a regression in anything code owns fails here.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Effect } from "effect";
import { TypeSafeLive } from "../../typesafe/client";
import { type PreviousInvoice, processInvoice } from "../../typesafe/invoice";
import { type InvoiceValidation, validateInvoice } from "../../validation";
import { oracle } from "../oracle";
import { CORPUS, type CorpusDocument } from "./corpus";
import {
  type CorpusRun,
  type Thresholds,
  scoreCorpus,
  thresholdFailures,
} from "./score";
import thresholdsJson from "./thresholds.json";

const thresholds = thresholdsJson as Thresholds;

const pdf = async (name: string) =>
  `data:application/pdf;base64,${(
    await readFile(resolve(__dirname, `${name}.pdf`))
  ).toString("base64")}`;

const idOf = (name: string) => `corpus:${name}`;
const nameOf = (id: string | null) => id?.replace(/^corpus:/, "") ?? null;

const outcomeOf = (validation: InvoiceValidation): CorpusRun["outcome"] => ({
  status: validation.status,
  taxBasis: validation.taxBasis,
  checks: Object.fromEntries(
    validation.checks.map((check) => [check.id, check.outcome]),
  ) as CorpusDocument["validation"]["checks"],
  issues: validation.issues.map((issue) => issue.code),
  accountingReady: validation.accounting.ready,
  blockers: validation.accounting.blockers.map((blocker) => blocker.code),
  duplicateOf: nameOf(validation.identity.duplicateOf),
  creditsInvoice: nameOf(validation.identity.creditsInvoiceId),
});

/** Reads the corpus in order, each document seeing its reviewed history. */
const runCorpus = async (live = false) => {
  const runs: CorpusRun[] = [];
  const read = new Map<string, PreviousInvoice>();
  for (const document of CORPUS) {
    const previousInvoices = (document.history ?? []).map(
      (name) => read.get(name)!,
    );
    const result = await Effect.runPromise(
      processInvoice({
        documentUrl: await pdf(document.name),
        mimetype: "application/pdf",
        companyName: "InvoiceWise Ltd",
        previousInvoices,
        defaultJudgmentQuestions: [],
      }).pipe(
        Effect.provide(live ? TypeSafeLive : oracle(document.selections)),
      ),
    );
    read.set(document.name, {
      id: idOf(document.name),
      extraction: result.extraction,
    });
    runs.push({
      document,
      extraction: result.extraction,
      outcome: outcomeOf(result.validation),
    });
  }
  return runs;
};

let runs: CorpusRun[] = [];
beforeAll(async () => {
  runs = await runCorpus();
}, 120_000);

describe("validation corpus", () => {
  test("every field, line item and validation outcome meets its recorded threshold", () => {
    const failures = thresholdFailures(scoreCorpus(runs), thresholds);
    expect(failures).toEqual([]);
  });

  test("covers every scored field and the proof cases", () => {
    const scored = scoreCorpus(runs);
    expect(Object.keys(scored.fields).sort()).toEqual(
      Object.keys(thresholds.fields).sort(),
    );
    const outcomes = Object.fromEntries(
      runs.map((run) => [run.document.name, run.outcome]),
    );
    // The proof of completion: why each can or cannot be delivered.
    expect(outcomes["normal-invoice"]).toMatchObject({
      status: "valid",
      accountingReady: true,
    });
    expect(outcomes["tax-inclusive-invoice"]).toMatchObject({
      taxBasis: "inclusive",
      accountingReady: true,
    });
    expect(outcomes["multi-rate-invoice"]).toMatchObject({
      checks: { tax: "pass" },
      accountingReady: true,
    });
    expect(outcomes["credit-note"]).toMatchObject({
      creditsInvoice: "normal-invoice",
      accountingReady: true,
    });
    expect(outcomes["inconsistent-total"]).toMatchObject({
      status: "invalid",
      checks: { gross: "fail" },
      accountingReady: false,
    });
  });

  test("every value keeps its evidence: the printed row and the selection's confidence", () => {
    for (const { document, extraction } of runs) {
      for (const [field, value] of Object.entries(document.expected.fields)) {
        if (value === null) continue;
        const evidence =
          extraction.evidence.fields[
            field as keyof typeof extraction.evidence.fields
          ];
        expect({
          document: document.name,
          field,
          evidence: Boolean(evidence),
        }).toEqual({ document: document.name, field, evidence: true });
      }
      expect(extraction.evidence.lineItems).toHaveLength(
        extraction.lineItems.length,
      );
    }
    const normal = runs.find((run) => run.document.name === "normal-invoice")!;
    expect(normal.extraction.evidence.fields.grossAmount).toMatchObject({
      page: 1,
      text: expect.stringContaining("£1,500.00"),
      label: "Total Due",
      confidence: 0.99,
      currencyMarker: "£",
      currency: "GBP",
    });
  });

  test("a second copy of an invoice is a duplicate and is not delivered", () => {
    const normal = runs.find((run) => run.document.name === "normal-invoice")!;
    const validation = validateInvoice(normal.extraction, [
      { id: "earlier", extraction: normal.extraction },
    ]);
    expect(validation.identity).toMatchObject({
      key: "invoice:GB481516249:HLP3101",
      duplicateOf: "earlier",
    });
    expect(validation.accounting.blockers.map((b) => b.code)).toEqual([
      "duplicate",
    ]);
    // A credit note with the same number is a different document.
    const credit = runs.find((run) => run.document.name === "credit-note")!;
    expect(
      validateInvoice(credit.extraction, [
        {
          id: "earlier",
          extraction: { ...normal.extraction, invoiceNumber: "CN-0042" },
        },
      ]).identity.duplicateOf,
    ).toBeNull();
  });

  test("the gate fails when a field, a line item or a validation outcome regresses", () => {
    const regressed = runs.map((run) =>
      run.document.name === "multi-rate-invoice"
        ? {
            ...run,
            extraction: {
              ...run.extraction,
              vatAmount: 132,
              lineItems: run.extraction.lineItems.slice(1),
            },
            outcome: { ...run.outcome, status: "invalid" as const },
          }
        : run,
    );
    const failures = thresholdFailures(scoreCorpus(regressed), thresholds);
    expect(failures.map((failure) => failure.split(":")[0])).toEqual([
      "vatAmount",
      "line items",
      "validation",
    ]);
  });
});

// The same corpus against the real TypeSafe model, for measuring selection
// accuracy. It reports rather than gates, and runs only on request:
//   TYPESAFE_LIVE_SMOKE=1 TYPESAFE_API_KEY=... bun test src/test/corpus
const liveTest =
  process.env.TYPESAFE_LIVE_SMOKE === "1" && process.env.TYPESAFE_API_KEY
    ? test
    : test.skip;

describe("validation corpus with the live model", () => {
  liveTest(
    "reports per-field accuracy",
    async () => {
      const score = scoreCorpus(await runCorpus(true));
      console.log(
        JSON.stringify(
          {
            fields: Object.fromEntries(
              Object.entries(score.fields).map(([field, entry]) => [
                field,
                `${entry.passed}/${entry.total}`,
              ]),
            ),
            lineItems: `${score.lineItems.exact}/${score.lineItems.expected} of ${score.lineItems.read} read`,
            validation: `${score.validation.passed}/${score.validation.total}`,
          },
          null,
          2,
        ),
      );
    },
    300_000,
  );
});
