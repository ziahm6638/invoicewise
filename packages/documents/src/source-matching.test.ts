import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import type { AuthorizationLine } from "./authorization-source";
import {
  type AllocationTarget,
  type InvoiceForMatching,
  type SourceCandidateInput,
  type SourceSemanticJudgment,
  type SourceVersionTerms,
  decideSourceMatch,
  invoiceReferencesOf,
  manualAllocations,
  prepareSourceMatch,
  referenceLookupKeys,
  sourceMatchFingerprint,
} from "./source-matching";
import { TypeSafe, type TypeSafeQuestion } from "./typesafe/client";
import { judgeSourceCandidates } from "./typesafe/source-match";

const NORTHWIND = "supplier-northwind";
const HEATING = "supplier-heating";
const OTHER = "supplier-other";

const supplierKeys = (id: string, name: string, vat = "") => ({
  id,
  name,
  nameKey: name.toLowerCase().replace(/ ltd$/, ""),
  vatKey: vat,
  companyKey: "",
});

const line = (
  reference: string,
  description: string,
  amount: string,
): AuthorizationLine => ({
  reference,
  description,
  quantity: null,
  unitPrice: null,
  amount,
});

const version = (
  overrides: Partial<SourceVersionTerms> & { id: string },
): SourceVersionTerms => ({
  version: 1,
  status: "open",
  title: null,
  scope: null,
  linkedSupplier: null,
  suppliedSupplier: { name: null, nameKey: "", vatKey: "", companyKey: "" },
  currency: "GBP",
  taxBasis: "exclusive",
  issuedOn: "2026-09-01",
  startsOn: null,
  endsOn: null,
  effectiveFrom: "2026-09-01",
  authorizedTotal: "0.00",
  lines: [],
  ...overrides,
});

const source = (
  sourceId: string,
  type: SourceCandidateInput["type"],
  reference: string,
  terms: Partial<SourceVersionTerms>,
): SourceCandidateInput => {
  const current = version({ id: `${sourceId}-v1`, ...terms });
  return {
    sourceId,
    type,
    reference,
    referenceKey: reference.toUpperCase().replace(/[^A-Z0-9]/g, ""),
    effective: current,
    current,
  };
};

// The workspace's sources. The ambiguous pair are two boiler services for one
// heating contractor; PO-9001 belongs to another supplier.
const purchaseOrder = source("po-55120", "purchase_order", "PO-55120", {
  title: "Timber",
  linkedSupplier: supplierKeys(
    NORTHWIND,
    "Northwind Joinery Ltd",
    "GB293445512",
  ),
  authorizedTotal: "2220.00",
  lines: [line("1", "Oak boards", "2220.00")],
});
const kitchenJob = source("job-1042", "job", "JOB-1042", {
  title: "Kitchen refit",
  scope: "Refit the kitchen at 12 High St: labour and materials",
  linkedSupplier: supplierKeys(
    NORTHWIND,
    "Northwind Joinery Ltd",
    "GB293445512",
  ),
  startsOn: "2026-09-07",
  endsOn: "2026-10-31",
  authorizedTotal: "4200.00",
  lines: [line("1", "Labour", "1800.00"), line("2", "Materials", "2400.00")],
});
const boilerA = source("job-2001", "job", "JOB-2001", {
  title: "Boiler service - Block A",
  linkedSupplier: supplierKeys(HEATING, "Warmline Heating Ltd"),
  authorizedTotal: "600.00",
});
const boilerB = source("job-2002", "job", "JOB-2002", {
  title: "Boiler service - Block B",
  linkedSupplier: supplierKeys(HEATING, "Warmline Heating Ltd"),
  authorizedTotal: "600.00",
});
const otherSupplierOrder = source("po-9001", "purchase_order", "PO-9001", {
  title: "Scaffolding",
  linkedSupplier: supplierKeys(OTHER, "Tall Order Scaffolds Ltd"),
  authorizedTotal: "900.00",
});
const ALL = [purchaseOrder, kitchenJob, boilerA, boilerB, otherSupplierOrder];

const invoice = (
  extraction: Record<string, unknown>,
  supplierId: string | null,
): InvoiceForMatching => ({
  extraction: {
    documentType: "invoice",
    supplierName: null,
    supplierVatNumber: null,
    supplierCompanyNumber: null,
    invoiceNumber: "INV-1",
    invoiceDate: "2026-09-20",
    currency: "GBP",
    netAmount: null,
    grossAmount: null,
    description: null,
    purchaseOrderReference: null,
    lineItems: [],
    ...extraction,
  },
  supplierId,
  receivedOn: "2026-09-21",
});

const targetsFor = (sources: readonly SourceCandidateInput[]) =>
  sources.map(
    (candidate): AllocationTarget => ({
      sourceId: candidate.sourceId,
      versionId: candidate.current.id,
      referenceKey: candidate.referenceKey,
      taxBasis: candidate.current.taxBasis,
      lines: candidate.current.lines,
    }),
  );

/** Finds candidates the way the job does: printed references and the supplier's sources. */
const candidatesFor = (target: InvoiceForMatching) => {
  const { keys, numberKeys } = referenceLookupKeys(
    invoiceReferencesOf(target.extraction),
  );
  return ALL.filter(
    (candidate) =>
      keys.includes(candidate.referenceKey) ||
      numberKeys.includes(candidate.referenceKey.replace(/^[A-Z]+/, "")) ||
      candidate.current.linkedSupplier?.id === target.supplierId,
  );
};

const decide = (
  target: InvoiceForMatching,
  semantic: SourceSemanticJudgment | null = null,
  sources = candidatesFor(target),
) => {
  const preparation = prepareSourceMatch({ invoice: target, sources });
  return {
    preparation,
    result: decideSourceMatch({
      invoice: target,
      preparation,
      semantic,
      allocationTargets: targetsFor(sources),
      workspaceHasSources: true,
      asOf: "2026-09-21T10:00:00.000Z",
    }),
  };
};

const answered = (
  probabilities: Record<string, number>,
  none = 0,
): SourceSemanticJudgment => ({
  status: "answered",
  model: "test",
  probabilities,
  none,
});

describe("invoice references", () => {
  test("reads the purchase-order field whole and reference-shaped tokens from free text", () => {
    const references = invoiceReferencesOf({
      purchaseOrderReference: "PO55120",
      description: "Works under Job 1042, invoiced 01/09/2026 for £1,250.00",
      lineItems: [{ description: "Labour (see CT/2026/07)" }],
    });
    expect(
      references.map(({ field, key, trusted }) => [field, key, trusted]),
    ).toEqual([
      ["purchaseOrderReference", "PO55120", true],
      ["description", "JOB1042", true],
      ["lineItem", "CT202607", true],
    ]);
    // An amount or a date is never a reference; "Job 1042" is also a number.
    expect(referenceLookupKeys(references).numberKeys).toEqual([
      "55120",
      "1042",
      "202607",
    ]);
    // A word before a number makes it a reference only when it is a reference word.
    expect(
      invoiceReferencesOf({ description: "Week 12 labour for 2 staff" }).map(
        (reference) => reference.trusted,
      ),
    ).toEqual([]);
  });
});

describe("matching", () => {
  test("an exact purchase-order reference links on its own, with its evidence and allocations", () => {
    const target = invoice(
      {
        supplierName: "Northwind Joinery Ltd",
        purchaseOrderReference: "po 55120",
        netAmount: 2220,
        lineItems: [{ description: "Oak boards", total: 2220 }],
      },
      NORTHWIND,
    );
    const { preparation, result } = decide(target);
    expect(preparation.semanticPool).toEqual([]);
    expect(result).toMatchObject({
      status: "matched",
      method: "reference",
      confidence: 1,
      needsConfirmation: false,
      semantic: { status: "not_needed" },
      links: [{ sourceId: "po-55120", versionId: "po-55120-v1", version: 1 }],
      allocations: [
        {
          sourceId: "po-55120",
          sourceLineReference: "1",
          invoiceLineIndex: 0,
          amount: "2220.00",
          currency: "GBP",
          basis: "invoice_line",
        },
      ],
      allocation: {
        complete: true,
        unallocatedLines: [],
        allocatedAmount: "2220.00",
      },
    });
    const chosen = result.candidates.find((c) => c.sourceId === "po-55120")!;
    expect(chosen.evidence.map((item) => [item.kind, item.outcome])).toEqual([
      ["reference", "supports"],
      ["version", "supports"],
      ["supplier", "supports"],
      ["status", "supports"],
      ["currency", "supports"],
    ]);
    expect(chosen.evidence[0]!.printed).toBe("po 55120");
  });

  test("free text with no reference is matched semantically to the supplier's job, as a proposal", () => {
    const target = invoice(
      {
        supplierName: "Northwind Joinery Ltd",
        description: "Kitchen refit at 12 High St - labour for weeks 1-3",
        netAmount: 1800,
        lineItems: [{ description: "Labour", total: 1800 }],
      },
      NORTHWIND,
    );
    const { preparation, result } = decide(
      target,
      answered({ "job-1042": 0.93, "po-55120": 0.04 }, 0.03),
    );
    expect(preparation.semanticPool.map((c) => c.sourceId).sort()).toEqual([
      "job-1042",
      "po-55120",
    ]);
    expect(result).toMatchObject({
      status: "matched",
      method: "semantic",
      confidence: 0.93,
      needsConfirmation: true,
      links: [{ sourceId: "job-1042" }],
      allocations: [
        { sourceId: "job-1042", sourceLineReference: "1", amount: "1800.00" },
      ],
    });
    const job = result.candidates.find((c) => c.sourceId === "job-1042")!;
    expect(job.evidence.at(-1)).toMatchObject({
      kind: "semantic",
      outcome: "supports",
    });
    expect(job.evidence.find((e) => e.kind === "period")?.outcome).toBe(
      "supports",
    );
  });

  test("two similar sources that TypeSafe cannot separate are ambiguous, never linked", () => {
    const target = invoice(
      {
        supplierName: "Warmline Heating Ltd",
        description: "Annual boiler service",
      },
      HEATING,
    );
    const { result } = decide(
      target,
      answered({ "job-2001": 0.48, "job-2002": 0.45 }, 0.07),
    );
    expect(result).toMatchObject({
      status: "ambiguous",
      method: "semantic",
      links: [],
      allocations: [],
    });
    expect(result.message).toContain("JOB-2001 (48%)");
    expect(result.message).toContain("JOB-2002 (45%)");
  });

  test("a reference to another supplier's source is rejected, not linked", () => {
    const target = invoice(
      {
        supplierName: "Northwind Joinery Ltd",
        purchaseOrderReference: "PO-9001",
      },
      NORTHWIND,
    );
    const { preparation, result } = decide(
      target,
      answered({ "job-1042": 0.1, "po-55120": 0.05 }, 0.85),
    );
    const rejected = result.candidates.find((c) => c.sourceId === "po-9001")!;
    expect(rejected).toMatchObject({
      found: "reference",
      eligible: false,
      rejection: "wrong_supplier",
      supplier: "different",
      confidence: null,
    });
    expect(preparation.semanticPool.map((c) => c.sourceId)).not.toContain(
      "po-9001",
    );
    expect(result.status).toBe("unmatched");
    expect(result.links).toEqual([]);
    expect(result.message).toContain(
      "Purchase order PO-9001 is printed on the invoice but is recorded for another supplier",
    );
  });

  test("an invoice no source relates to is unmatched without asking TypeSafe", () => {
    const target = invoice(
      {
        supplierName: "Unrelated Stationery Ltd",
        description: "Printer paper",
      },
      "supplier-stationery",
    );
    const { preparation, result } = decide(target);
    expect(preparation.candidates).toEqual([]);
    expect(result).toMatchObject({
      status: "unmatched",
      method: null,
      semantic: { status: "not_needed" },
      message:
        "No open source references this invoice or is recorded for its supplier.",
    });
    const empty = decideSourceMatch({
      invoice: target,
      preparation,
      semantic: null,
      allocationTargets: [],
      workspaceHasSources: false,
      asOf: "2026-09-21T10:00:00.000Z",
    });
    expect(empty.message).toBe(
      "This workspace has no authorization sources yet.",
    );
  });

  test("an unidentified supplier with no printed reference is insufficient evidence", () => {
    const { result } = decide(invoice({ description: "Works" }, null));
    expect(result.status).toBe("insufficient_evidence");
  });

  test("a failed semantic check leaves the candidates for review instead of guessing", () => {
    const target = invoice(
      { supplierName: "Warmline Heating Ltd", description: "Boiler service" },
      HEATING,
    );
    const { result } = decide(target, {
      status: "failed",
      reason: "TypeSafe is unavailable",
    });
    expect(result).toMatchObject({
      status: "insufficient_evidence",
      links: [],
      semantic: { status: "failed", reason: "TypeSafe is unavailable" },
    });
    expect(result.candidates).toHaveLength(2);
  });

  test("a strong semantic answer for a source whose supplier cannot be confirmed is not linked", () => {
    const unlinked = source("job-3001", "job", "JOB-3001", {
      title: "Roof repair",
      suppliedSupplier: {
        name: "Someone",
        nameKey: "someone",
        vatKey: "",
        companyKey: "",
      },
    });
    const target = invoice(
      {
        supplierName: "Northwind Joinery Ltd",
        description: "Roof repair ref 3001",
      },
      NORTHWIND,
    );
    const { result } = decide(target, answered({ "job-3001": 0.95 }, 0.05), [
      unlinked,
    ]);
    expect(result.status).toBe("insufficient_evidence");
    expect(result.candidates[0]).toMatchObject({
      found: "reference_number",
      supplier: "unknown",
    });
  });

  test("the same reference on a job and a purchase order: the PO field decides, free text is ambiguous", () => {
    const job = source("job-a100", "job", "A-100", {
      linkedSupplier: supplierKeys(NORTHWIND, "Northwind Joinery Ltd"),
    });
    const order = source("po-a100", "purchase_order", "A-100", {
      linkedSupplier: supplierKeys(NORTHWIND, "Northwind Joinery Ltd"),
    });
    const byField = decide(
      invoice({ purchaseOrderReference: "A-100" }, NORTHWIND),
      null,
      [job, order],
    ).result;
    expect(byField).toMatchObject({
      status: "matched",
      links: [{ sourceId: "po-a100" }],
    });
    const byText = decide(
      invoice({ description: "Works for A-100" }, NORTHWIND),
      null,
      [job, order],
    ).result;
    expect(byText).toMatchObject({
      status: "ambiguous",
      method: "reference",
      links: [],
    });
  });

  test("cancelled sources and other currencies are rejected with their reason", () => {
    const cancelled = source("po-c", "purchase_order", "PO-777", {
      status: "cancelled",
      linkedSupplier: supplierKeys(NORTHWIND, "Northwind Joinery Ltd"),
    });
    const euro = source("po-e", "purchase_order", "PO-778", {
      currency: "EUR",
      linkedSupplier: supplierKeys(NORTHWIND, "Northwind Joinery Ltd"),
    });
    const { result } = decide(
      invoice({ purchaseOrderReference: "PO-777 / PO-778" }, NORTHWIND),
      null,
      [cancelled, euro],
    );
    expect(result.status).toBe("unmatched");
    expect(
      result.candidates.map((c) => [c.sourceId, c.rejection]).sort(),
    ).toEqual([
      ["po-c", "cancelled"],
      ["po-e", "currency_conflict"],
    ]);
  });

  test("an invoice covering two sources allocates each line to the source it names", () => {
    const target = invoice(
      {
        supplierName: "Northwind Joinery Ltd",
        purchaseOrderReference: "PO-55120",
        description: "Timber and kitchen labour (JOB-1042)",
        lineItems: [
          { description: "Oak boards for PO-55120", total: 2220 },
          { description: "Labour JOB-1042", total: 900 },
          { description: "Delivery", total: 45 },
        ],
      },
      NORTHWIND,
    );
    const { result } = decide(target);
    expect(result.status).toBe("matched");
    expect(result.links.map((link) => link.sourceId).sort()).toEqual([
      "job-1042",
      "po-55120",
    ]);
    expect(
      result.allocations.map((a) => [
        a.sourceId,
        a.invoiceLineIndex,
        a.sourceLineReference,
        a.amount,
      ]),
    ).toEqual([
      ["po-55120", 0, "1", "2220.00"],
      ["job-1042", 1, "1", "900.00"],
    ]);
    expect(result.allocation).toEqual({
      complete: false,
      unallocatedLines: [2],
      allocatedAmount: "3120.00",
    });
  });

  test("a credit note is allocated negative; with no lines the whole net is allocated", () => {
    const { result } = decide(
      invoice(
        {
          documentType: "credit_note",
          purchaseOrderReference: "PO-55120",
          netAmount: 100,
          grossAmount: 120,
        },
        NORTHWIND,
      ),
    );
    expect(result.allocations).toEqual([
      {
        sourceId: "po-55120",
        versionId: "po-55120-v1",
        sourceLineReference: null,
        invoiceLineIndex: null,
        amount: "-100.00",
        currency: "GBP",
        basis: "invoice_net",
      },
    ]);
  });

  test("the version not yet in effect on the invoice date is compared as current, and says so", () => {
    const future = { ...purchaseOrder, effective: null };
    const { result } = decide(
      invoice({ purchaseOrderReference: "PO-55120" }, NORTHWIND),
      null,
      [future],
    );
    expect(result.status).toBe("matched");
    expect(result.candidates[0]).toMatchObject({ versionBasis: "current" });
    expect(
      result.candidates[0]!.evidence.find((e) => e.kind === "version"),
    ).toMatchObject({ outcome: "conflicts" });
  });

  test("equal decisions share a fingerprint", () => {
    const target = invoice({ purchaseOrderReference: "PO-55120" }, NORTHWIND);
    expect(sourceMatchFingerprint(decide(target).result)).toBe(
      sourceMatchFingerprint(decide(target).result),
    );
  });
});

describe("manual allocations", () => {
  const extraction = {
    currency: "GBP",
    netAmount: 3000,
    lineItems: [
      { description: "Oak boards", total: 2000 },
      { description: "Labour", total: 1000 },
    ],
  };
  const po = {
    link: {
      sourceId: "po-55120",
      versionId: "po-55120-v1",
      version: 1,
      type: "purchase_order" as const,
      reference: "PO-55120",
      title: "Timber",
    },
    lines: purchaseOrder.current.lines,
    currency: "GBP",
  };
  const job = {
    link: {
      sourceId: "job-1042",
      versionId: "job-1042-v1",
      version: 1,
      type: "job" as const,
      reference: "JOB-1042",
      title: "Kitchen refit",
    },
    lines: kitchenJob.current.lines,
    currency: "GBP",
  };

  test("one source takes the whole invoice when no split is given", () => {
    expect(
      manualAllocations({ extraction, targets: [po], allocations: null }),
    ).toEqual({
      allocations: [
        {
          sourceId: "po-55120",
          versionId: "po-55120-v1",
          sourceLineReference: null,
          invoiceLineIndex: null,
          amount: "3000.00",
          currency: "GBP",
          basis: "invoice_net",
        },
      ],
      issues: [],
    });
  });

  test("several sources need an explicit split, and every problem is reported", () => {
    expect(
      manualAllocations({ extraction, targets: [po, job], allocations: [] })
        .issues,
    ).toEqual(["Say how the invoice is split between the sources."]);
    const { issues } = manualAllocations({
      extraction,
      targets: [po, job],
      allocations: [
        { sourceId: "po-55120", sourceLineReference: "9", invoiceLineIndex: 0 },
        { sourceId: "unknown", amount: "1" },
        { sourceId: "po-55120", sourceLineReference: "9", invoiceLineIndex: 0 },
        { sourceId: "po-55120", invoiceLineIndex: 5, amount: "1.234" },
      ],
    });
    expect(issues).toEqual([
      'Allocation 1: Purchase order PO-55120 version 1 has no line "9".',
      "Allocation 2 names a source that is not linked.",
      'Allocation 3: Purchase order PO-55120 version 1 has no line "9".',
      "Allocation 3 repeats an earlier allocation.",
      "Allocation 4: the invoice has no line 6.",
      "Allocation 4: the amount must be a number with at most 2 decimal places.",
      "Allocate part of the invoice to Job JOB-1042, or unlink it.",
    ]);
  });

  test("a valid split keeps line amounts and explicit amounts", () => {
    const { allocations, issues } = manualAllocations({
      extraction,
      targets: [po, job],
      allocations: [
        { sourceId: "po-55120", sourceLineReference: "1", invoiceLineIndex: 0 },
        { sourceId: "job-1042", sourceLineReference: "1", amount: "1000" },
      ],
    });
    expect(issues).toEqual([]);
    expect(allocations.map((a) => [a.sourceId, a.amount, a.basis])).toEqual([
      ["po-55120", "2000.00", "manual"],
      ["job-1042", "1000.00", "manual"],
    ]);
  });
});

describe("semantic judgment", () => {
  test("TypeSafe chooses among the candidates or none, and answers map back to sources", async () => {
    const requests: {
      state: unknown;
      questions: Record<string, TypeSafeQuestion>;
    }[] = [];
    const stub = Layer.succeed(TypeSafe, {
      evaluate: (request) => {
        requests.push(request);
        return Effect.succeed({
          model: "stub",
          answers: {
            authorized_source: {
              type: "choice",
              choice: "source_1",
              probabilities: { source_0: 0.1, source_1: 0.85, none: 0.05 },
              confidence: 0.85,
            },
          },
          usage: { inputTokens: 0, outputTokens: 0 },
        });
      },
    });
    const candidates = [boilerA, boilerB].map((candidate) => ({
      sourceId: candidate.sourceId,
      type: candidate.type,
      reference: candidate.reference,
      title: candidate.current.title,
      scope: candidate.current.scope,
      supplierName: "Warmline Heating Ltd",
      currency: "GBP",
      startsOn: null,
      endsOn: null,
      authorizedTotal: candidate.current.authorizedTotal,
      lines: candidate.current.lines,
    }));
    const judgment = await Effect.runPromise(
      judgeSourceCandidates(
        { description: "Boiler service Block B", lineItems: [] },
        candidates,
      ).pipe(Effect.provide(stub)),
    );
    expect(judgment).toEqual({
      status: "answered",
      model: "stub",
      probabilities: { "job-2001": 0.1, "job-2002": 0.85 },
      none: 0.05,
    });
    const question = requests[0]!.questions.authorized_source!;
    expect(question.type).toBe("choice");
    expect(Object.keys(question.criteria as object)).toEqual([
      "source_0",
      "source_1",
      "none",
    ]);
    // Only the workspace's candidates are shown; nothing is generated.
    expect(JSON.stringify(requests[0]!.state)).not.toContain("PO-9001");
  });
});
