import { describe, expect, test } from "bun:test";
import {
  type SourceCandidateInput,
  type SourceVersionTerms,
  decideSourceMatch,
  prepareSourceMatch,
} from "@invoicewise/documents";
import { renderToStaticMarkup } from "react-dom/server";
import { type SourceMatchDecision, SourceMatchView } from "./source-match-view";

const HEATING = "0d6a2b5c-7f0e-4d1e-8a3b-5c2f9e1d4a77";

const job = (sourceId: string, reference: string, title: string) => {
  const version: SourceVersionTerms = {
    id: `${sourceId}-v1`,
    version: 1,
    status: "open",
    title,
    scope: null,
    linkedSupplier: {
      id: HEATING,
      name: "Warmline Heating Ltd",
      nameKey: "warmline heating",
      vatKey: "",
      companyKey: "",
    },
    suppliedSupplier: { name: null, nameKey: "", vatKey: "", companyKey: "" },
    currency: "GBP",
    taxBasis: "exclusive",
    issuedOn: null,
    startsOn: null,
    endsOn: null,
    effectiveFrom: "2026-09-01",
    authorizedTotal: "600.00",
    lines: [],
  };
  return {
    sourceId,
    type: "job",
    reference,
    referenceKey: reference.replace(/[^A-Z0-9]/g, ""),
    effective: version,
    current: version,
  } satisfies SourceCandidateInput;
};

const invoice = {
  extraction: {
    documentType: "invoice",
    supplierName: "Warmline Heating Ltd",
    invoiceDate: "2026-09-20",
    currency: "GBP",
    netAmount: 600,
    description: "Annual boiler service",
    lineItems: [],
  },
  supplierId: HEATING,
  receivedOn: "2026-09-21",
};
const sources = [
  job("job-a", "JOB-2001", "Boiler service - Block A"),
  job("job-b", "JOB-2002", "Boiler service - Block B"),
];
const preparation = prepareSourceMatch({ invoice, sources });
const ambiguous = decideSourceMatch({
  invoice,
  preparation,
  semantic: {
    status: "answered",
    model: "test",
    probabilities: { "job-a": 0.48, "job-b": 0.45 },
    none: 0.07,
  },
  allocationTargets: [],
  workspaceHasSources: true,
  asOf: "2026-09-21T10:00:00.000Z",
});

const decision = (
  result: typeof ambiguous,
  extra: Partial<SourceMatchDecision>,
): SourceMatchDecision => ({
  ...result,
  id: "match-1",
  sequence: 1,
  origin: "automatic",
  action: "automatic",
  reason: null,
  decidedAt: "2026-09-21T10:00:00.000Z",
  ...extra,
});

describe("source match view", () => {
  test("an ambiguous match lists both candidates with their evidence and lets an admin choose", () => {
    const html = renderToStaticMarkup(
      <SourceMatchView
        current={decision(ambiguous, {})}
        onChoose={() => undefined}
      />,
    );
    expect(html).toContain("Ambiguous");
    expect(html).toContain("Job JOB-2001 · Boiler service - Block A");
    expect(html).toContain("48%");
    expect(html).toContain("45%");
    expect(html).toContain("Recorded for this invoice&#x27;s supplier");
    expect(html.match(/>Choose</g)?.length).toBe(2);
    expect(html).toContain('href="/authorizations/job-b"');
  });

  test("a resolved match shows the linked source, allocation, reason and the earlier decision", () => {
    const resolved = decision(
      {
        ...ambiguous,
        status: "matched",
        method: "manual",
        needsConfirmation: false,
        message: "Linked by an owner or admin to JOB-2002.",
        links: [
          {
            sourceId: "job-b",
            versionId: "job-b-v1",
            version: 1,
            type: "job",
            reference: "JOB-2002",
            title: "Boiler service - Block B",
          },
        ],
        allocations: [
          {
            sourceId: "job-b",
            versionId: "job-b-v1",
            sourceLineReference: null,
            invoiceLineIndex: null,
            amount: "600.00",
            currency: "GBP",
            basis: "invoice_net",
          },
        ],
      },
      {
        id: "match-2",
        sequence: 2,
        origin: "manual",
        action: "correct",
        reason: "Site log shows Block B",
        actorName: "Ada Admin",
      },
    );
    const html = renderToStaticMarkup(
      <SourceMatchView
        current={resolved}
        history={[resolved, decision(ambiguous, {})]}
        onChoose={() => undefined}
      />,
    );
    expect(html).toContain("Matched");
    expect(html).toContain("Decided by an admin");
    expect(html).toContain("Whole invoice: 600.00 GBP");
    expect(html).toContain("Reason: Site log shows Block B");
    expect(html).toContain("Linked by an admin");
    expect(html).toContain("Ada Admin");
    expect(html).toContain("Matched automatically");
    // Choosing is offered only while the match is open.
    expect(html).not.toContain(">Choose<");
  });

  test("before matching has run it says so", () => {
    expect(renderToStaticMarkup(<SourceMatchView current={null} />)).toContain(
      "has not finished yet",
    );
  });
});
