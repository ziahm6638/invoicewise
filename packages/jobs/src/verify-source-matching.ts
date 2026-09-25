/**
 * Invoice ↔ authorization-source matching, end to end against Postgres.
 *
 * A workspace records a purchase order, a kitchen job, two near-identical
 * boiler-service jobs and another supplier's purchase order; a neighbouring
 * workspace records its own purchase order. Processed invoices then show:
 * an exact PO reference linking on its own (TypeSafe never asked), a
 * free-text invoice proposed semantically for the right job and confirmed, an
 * ambiguous pair resolved by an admin with a reason that survives
 * reprocessing, a reference to another supplier's PO rejected, an invoice
 * with no source left unmatched, and the neighbour's source never considered.
 * It also covers an invoice split across two sources, one source billed by
 * several invoices, unlinking with the history kept, stale
 * edits refused, a provider outage, idempotent reruns, the immutability
 * trigger and the `invoice.matched` webhook intent.
 *
 *   DATABASE_PRIMARY_URL=... bun run verify:source-matching
 */
import { createDatabaseClient } from "@invoicewise/db/client";
import {
  listSourceInvoiceMatches,
  listSourceMatchHistory,
} from "@invoicewise/db/queries";
import {
  inbox,
  invoiceSourceAllocations,
  invoiceSourceLinks,
  invoiceSourceMatches,
  suppliers,
  teams,
  users,
  webhookDeliveries,
  webhookEndpoints,
  workflowJobs,
} from "@invoicewise/db/schema";
import type {
  InvoiceExtraction,
  SemanticSourceCandidate,
  SourceJudge,
  SourceMatchResult,
} from "@invoicewise/documents";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Schema } from "effect";
import {
  amendAuthorizationSource,
  submitAuthorizationSources,
} from "./authorization-sources";
import { saveProcessedDocument } from "./process-document";
import { WorkflowRequest } from "./schema";
import {
  SourceMatchError,
  confirmInvoiceMatch,
  linkInvoiceSources,
  matchInvoice,
  unlinkInvoiceSources,
} from "./source-matching";
import { required } from "./verify-support";

const assert = (condition: unknown, message: string, detail?: unknown) => {
  if (!condition) {
    throw new Error(
      `${message}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`,
    );
  }
};

const rejects = async (work: () => Promise<unknown>, code: string) => {
  try {
    await work();
  } catch (error) {
    if (error instanceof SourceMatchError && error.code === code) return error;
    throw error;
  }
  throw new Error(`expected a SourceMatchError (${code})`);
};

const NORTHWIND = {
  supplierName: "Northwind Joinery Ltd",
  supplierVatNumber: "GB293445512",
};
const WARMLINE = {
  supplierName: "Warmline Heating Ltd",
  supplierVatNumber: "GB555000111",
};
const STATIONERY = {
  supplierName: "Paperclip Stationers Ltd",
  supplierVatNumber: "GB999000333",
};

const extractionOf = (
  value: Partial<InvoiceExtraction> & { invoiceNumber: string },
): InvoiceExtraction =>
  ({
    documentType: "invoice",
    supplierAddress: null,
    supplierCompanyNumber: null,
    originalInvoiceNumber: null,
    invoiceDate: "2026-09-20",
    dueDate: null,
    currency: "GBP",
    netAmount: 100,
    discountAmount: null,
    vatAmount: 20,
    taxRate: 20,
    grossAmount: 120,
    amountsIncludeTax: false,
    lineItems: [],
    description: null,
    purchaseOrderReference: null,
    paymentReference: null,
    bankDetails: {
      accountName: null,
      accountNumber: null,
      sortCode: null,
      iban: null,
      bic: null,
    },
    textSource: "text-layer",
    pageSources: ["text-layer"],
    evidence: { fields: {}, lineItems: [] },
    ...NORTHWIND,
    ...value,
  }) as InvoiceExtraction;

const lineItem = (description: string, total: number) => ({
  description,
  quantity: null,
  unitPrice: null,
  discountAmount: null,
  discountRate: null,
  taxRate: null,
  taxAmount: null,
  total,
});

type JudgeCall = { description: unknown; references: string[] };

/**
 * TypeSafe as a correct model would answer for these invoices. It records
 * what it was shown, so the verifier can prove it was never asked about an
 * exact reference and never shown another workspace's source.
 */
const makeJudge =
  (calls: JudgeCall[], outage = { on: false }): SourceJudge =>
  async (extraction, candidates: readonly SemanticSourceCandidate[]) => {
    const description = String(
      (extraction as InvoiceExtraction).description ?? "",
    ).toLowerCase();
    calls.push({
      description,
      references: candidates.map((candidate) => candidate.reference),
    });
    if (outage.on) {
      return {
        status: "unavailable",
        reason: "TypeSafe is unavailable",
        retryable: true,
      };
    }
    const probabilities: Record<string, number> = {};
    for (const candidate of candidates)
      probabilities[candidate.sourceId] = 0.01;
    const pick = (reference: string, probability: number) => {
      const candidate = candidates.find((c) => c.reference === reference);
      if (candidate) probabilities[candidate.sourceId] = probability;
    };
    let none = 0.9;
    if (description.includes("kitchen")) {
      pick("JOB-1042", 0.93);
      none = 0.03;
    } else if (description.includes("boiler")) {
      pick("JOB-2001", 0.48);
      pick("JOB-2002", 0.45);
      none = 0.05;
    }
    return {
      status: "answered",
      model: "verification-stub",
      probabilities,
      none,
    };
  };

async function main() {
  const database = createDatabaseClient({
    primaryUrl: required("DATABASE_PRIMARY_URL"),
    isDevelopment: true,
  });
  const db = database.db;
  const teamIds: string[] = [];
  let actorId: string | null = null;
  let clock = Date.parse("2026-09-21T08:00:00Z");
  const calls: JudgeCall[] = [];
  const outage = { on: false };
  const judge = makeJudge(calls, outage);

  const receive = async (teamId: string, extraction: InvoiceExtraction) => {
    clock += 60_000;
    const [row] = await db
      .insert(inbox)
      .values({
        teamId,
        createdAt: new Date(clock).toISOString(),
        displayName: extraction.supplierName ?? "invoice",
        fileName: `${extraction.invoiceNumber}.pdf`,
        contentType: "application/pdf",
        type: "invoice",
        status: "processing",
        intakeState: "accepted",
      })
      .returning({ id: inbox.id });
    await saveProcessedDocument(db, {
      id: row!.id,
      teamId,
      displayName: extraction.supplierName,
      type: "invoice",
      extraction,
      judgments: [],
    });
    return row!.id;
  };
  const match = (teamId: string, invoiceId: string, finalAttempt = false) =>
    matchInvoice(db, {
      teamId,
      invoiceId,
      judge,
      finalAttempt,
    });
  const currentOf = async (invoiceId: string) => {
    const [row] = await db
      .select({
        result: invoiceSourceMatches.result,
        match: invoiceSourceMatches,
      })
      .from(inbox)
      .innerJoin(
        invoiceSourceMatches,
        eq(invoiceSourceMatches.id, inbox.sourceMatchId),
      )
      .where(eq(inbox.id, invoiceId));
    assert(row, "invoice has a current match", invoiceId);
    return {
      ...row!.match,
      result: row!.result as unknown as SourceMatchResult,
    };
  };
  const summary = (current: Awaited<ReturnType<typeof currentOf>>) => ({
    status: current.status,
    origin: current.origin,
    action: current.action,
    method: current.method,
    confidence: current.result.confidence,
    needsConfirmation: current.result.needsConfirmation,
    message: current.result.message,
    links: current.result.links.map(
      (link) => `${link.reference} v${link.version}`,
    ),
    allocations: current.result.allocations.map(
      (allocation) =>
        `${allocation.invoiceLineIndex === null ? "invoice" : `line ${allocation.invoiceLineIndex + 1}`} -> ${
          current.result.links.find(
            (link) => link.sourceId === allocation.sourceId,
          )?.reference
        }${allocation.sourceLineReference ? ` line ${allocation.sourceLineReference}` : ""}: ${allocation.amount} ${allocation.currency}`,
    ),
    evidence: current.result.candidates.map((candidate) => ({
      source: candidate.reference,
      eligible: candidate.eligible,
      rejection: candidate.rejection,
      confidence: candidate.confidence,
      evidence: candidate.evidence.map(
        (item) => `${item.kind}/${item.outcome}: ${item.message}`,
      ),
    })),
    reason: current.reason,
  });

  try {
    for (const name of ["Source matching A", "Source matching B"]) {
      const [team] = await db
        .insert(teams)
        .values({ name })
        .returning({ id: teams.id });
      teamIds.push(team!.id);
    }
    const [teamA, teamB] = teamIds as [string, string];
    const [user] = await db
      .insert(users)
      .values({
        fullName: "Matching verifier",
        email: `matching-${teamA}@invoicewise.local`,
        teamId: teamA,
      })
      .returning({ id: users.id });
    const actor: string = user!.id;
    actorId = actor;

    // Suppliers are known from earlier invoices; sources link to them by VAT.
    for (const [teamId, supplier] of [
      [teamA, NORTHWIND],
      [teamA, WARMLINE],
      [
        teamA,
        {
          supplierName: "Tall Order Scaffolds Ltd",
          supplierVatNumber: "GB777000222",
        },
      ],
      [teamA, STATIONERY],
      [teamB, NORTHWIND],
    ] as const) {
      await db.insert(suppliers).values({
        teamId,
        name: supplier.supplierName,
        nameKey: supplier.supplierName.toLowerCase().replace(/ ltd$/, ""),
        vatKey: supplier.supplierVatNumber,
      });
    }

    const submitted = await submitAuthorizationSources(db, {
      teamId: teamA,
      actorId: actor,
      sources: [
        {
          type: "purchase_order",
          reference: "PO-55120",
          title: "Timber",
          supplier: { name: "Northwind Joinery Ltd", vatNumber: "GB293445512" },
          currency: "GBP",
          taxBasis: "exclusive",
          issuedOn: "2026-09-02",
          lines: [
            {
              reference: "1",
              description: "Oak boards",
              quantity: 120,
              unitPrice: "18.50",
            },
          ],
        },
        {
          type: "job",
          reference: "JOB-1042",
          title: "Kitchen refit",
          scope: "Refit the kitchen at 12 High St: labour and materials",
          supplier: { name: "Northwind Joinery Ltd", vatNumber: "GB293445512" },
          currency: "GBP",
          taxBasis: "exclusive",
          issuedOn: "2026-09-01",
          startsOn: "2026-09-07",
          endsOn: "2026-10-31",
          lines: [
            { reference: "1", description: "Labour", amount: "1800.00" },
            { reference: "2", description: "Materials", amount: "2400.00" },
          ],
        },
        {
          type: "job",
          reference: "JOB-2001",
          title: "Boiler service - Block A",
          supplier: { name: "Warmline Heating Ltd", vatNumber: "GB555000111" },
          currency: "GBP",
          issuedOn: "2026-09-01",
          authorizedTotal: "600",
        },
        {
          type: "job",
          reference: "JOB-2002",
          title: "Boiler service - Block B",
          supplier: { name: "Warmline Heating Ltd", vatNumber: "GB555000111" },
          currency: "GBP",
          issuedOn: "2026-09-01",
          authorizedTotal: "600",
        },
        {
          type: "purchase_order",
          reference: "PO-9001",
          title: "Scaffolding",
          supplier: {
            name: "Tall Order Scaffolds Ltd",
            vatNumber: "GB777000222",
          },
          currency: "GBP",
          issuedOn: "2026-09-01",
          authorizedTotal: "900",
        },
      ],
    });
    assert(submitted.status === "applied", "sources applied", submitted);
    const neighbour = await submitAuthorizationSources(db, {
      teamId: teamB,
      actorId: null,
      sources: [
        {
          type: "purchase_order",
          reference: "PO-77001",
          title: "Neighbour timber",
          supplier: { name: "Northwind Joinery Ltd", vatNumber: "GB293445512" },
          currency: "GBP",
          issuedOn: "2026-09-01",
          authorizedTotal: "500",
        },
      ],
    });
    const idOf = (reference: string): string => {
      const id = [...submitted.results, ...neighbour.results].find(
        (result) => result.reference === reference,
      )?.sourceId;
      assert(id, "source was created", reference);
      return id!;
    };
    const neighbourSource = idOf("PO-77001");

    // An endpoint subscribed to match events.
    await db.insert(webhookEndpoints).values({
      teamId: teamA,
      url: "https://example.com/matched",
      secretEncrypted: "unused-by-this-verifier",
      events: ["invoice.matched"],
      createdBy: actor,
    });

    // 1. Exact purchase-order reference: linked by plain code alone.
    const exact = await receive(
      teamA,
      extractionOf({
        invoiceNumber: "NJ-1",
        purchaseOrderReference: "po 55120",
        netAmount: 2220,
        vatAmount: 444,
        grossAmount: 2664,
        lineItems: [lineItem("Oak boards", 2220)],
      }),
    );
    const [queued] = await db
      .select()
      .from(workflowJobs)
      .where(
        and(
          eq(workflowJobs.teamId, teamA),
          eq(workflowJobs.name, "match-invoice"),
        ),
      );
    assert(queued, "processing queued a match job in its own transaction");
    Schema.decodeUnknownSync(WorkflowRequest)({
      name: queued!.name,
      payload: queued!.payload,
    });
    const exactRun = await match(teamA, exact);
    assert(exactRun.outcome === "recorded", "exact match recorded", exactRun);
    const exactMatch = await currentOf(exact);
    assert(
      exactMatch.status === "matched" &&
        exactMatch.method === "reference" &&
        exactMatch.result.confidence === 1 &&
        exactMatch.result.links[0]?.sourceId === idOf("PO-55120") &&
        exactMatch.result.allocations[0]?.sourceLineReference === "1",
      "exact PO links with its evidence",
      summary(exactMatch),
    );
    assert(
      calls.length === 0,
      "TypeSafe is not asked about an exact reference",
      calls,
    );
    assert(
      (await match(teamA, exact)).outcome === "unchanged",
      "rerunning an unchanged match records nothing",
    );
    const [delivery] = await db
      .select({ payload: webhookDeliveries.payload })
      .from(webhookDeliveries)
      .where(
        and(
          eq(webhookDeliveries.teamId, teamA),
          eq(webhookDeliveries.event, "invoice.matched"),
        ),
      );
    assert(
      JSON.stringify(delivery?.payload).includes("PO-55120"),
      "invoice.matched is scheduled with the match",
      delivery,
    );

    // 2. Free text, no reference: TypeSafe proposes the kitchen job; confirmed.
    const freeText = await receive(
      teamA,
      extractionOf({
        invoiceNumber: "NJ-2",
        description: "Kitchen refit at 12 High St - labour weeks 1-3",
        netAmount: 1800,
        vatAmount: 360,
        grossAmount: 2160,
        lineItems: [lineItem("Labour", 1800)],
      }),
    );
    await match(teamA, freeText);
    const proposed = await currentOf(freeText);
    assert(
      proposed.status === "matched" &&
        proposed.method === "semantic" &&
        proposed.result.needsConfirmation &&
        proposed.result.links[0]?.sourceId === idOf("JOB-1042"),
      "free text is proposed for the kitchen job",
      summary(proposed),
    );
    assert(
      calls.at(-1)?.references.sort().join() === "JOB-1042,PO-55120",
      "TypeSafe chooses only among the supplier's own sources",
      calls.at(-1),
    );
    await confirmInvoiceMatch(db, {
      teamId: teamA,
      inboxId: freeText,
      actorId: actor,
      expectedMatchId: proposed.id,
    });
    const confirmed = await currentOf(freeText);
    assert(
      confirmed.origin === "manual" &&
        confirmed.action === "confirm" &&
        !confirmed.result.needsConfirmation,
      "a person confirms the proposal",
      summary(confirmed),
    );

    // 3. Ambiguous pair, resolved by an admin with a reason.
    const ambiguous = await receive(
      teamA,
      extractionOf({
        invoiceNumber: "WH-3",
        ...WARMLINE,
        description: "Annual boiler service",
        netAmount: 600,
        vatAmount: 120,
        grossAmount: 720,
      }),
    );
    await match(teamA, ambiguous);
    const open = await currentOf(ambiguous);
    assert(
      open.status === "ambiguous" && open.result.links.length === 0,
      "two similar boiler jobs are ambiguous, not linked",
      summary(open),
    );
    await rejects(
      () =>
        confirmInvoiceMatch(db, {
          teamId: teamA,
          inboxId: ambiguous,
          actorId: actor,
        }),
      "conflict",
    );
    await rejects(
      () =>
        linkInvoiceSources(db, {
          teamId: teamA,
          inboxId: ambiguous,
          actorId: actor,
          expectedMatchId: exactMatch.id,
          sources: [{ sourceId: idOf("JOB-2002") }],
        }),
      "conflict",
    );
    await linkInvoiceSources(db, {
      teamId: teamA,
      inboxId: ambiguous,
      actorId: actor,
      expectedMatchId: open.id,
      reason: "Site log shows the Block B plant room",
      sources: [{ sourceId: idOf("JOB-2002") }],
    });
    const resolved = await currentOf(ambiguous);
    assert(
      resolved.status === "matched" &&
        resolved.action === "correct" &&
        resolved.reason === "Site log shows the Block B plant room" &&
        resolved.result.links[0]?.sourceId === idOf("JOB-2002") &&
        resolved.result.allocations[0]?.amount === "600.00",
      "the admin's choice links Block B with the whole invoice allocated",
      summary(resolved),
    );
    // Reprocessing the invoice (a new revision) keeps the person's decision.
    await db
      .update(inbox)
      .set({ status: "processing" })
      .where(eq(inbox.id, ambiguous));
    await saveProcessedDocument(db, {
      id: ambiguous,
      teamId: teamA,
      displayName: WARMLINE.supplierName,
      type: "invoice",
      extraction: extractionOf({
        invoiceNumber: "WH-3",
        ...WARMLINE,
        description: "Annual boiler service",
        netAmount: 600,
        vatAmount: 120,
        grossAmount: 720,
      }),
      judgments: [],
    });
    const retried = await match(teamA, ambiguous);
    assert(
      retried.outcome === "kept_override",
      "a retry keeps the override",
      retried,
    );
    const ambiguousHistory = await listSourceMatchHistory(db, {
      teamId: teamA,
      inboxId: ambiguous,
    });
    assert(
      ambiguousHistory
        .map((row) => `${row.sequence}:${row.status}:${row.action}`)
        .join() === "2:matched:correct,1:ambiguous:automatic",
      "earlier decisions and their reasons are kept",
      ambiguousHistory,
    );

    // 4. A printed PO that belongs to another supplier is rejected.
    const wrongSupplier = await receive(
      teamA,
      extractionOf({
        invoiceNumber: "NJ-4",
        purchaseOrderReference: "PO-9001",
      }),
    );
    await match(teamA, wrongSupplier);
    const rejected = await currentOf(wrongSupplier);
    const rejectedCandidate = rejected.result.candidates.find(
      (candidate) => candidate.sourceId === idOf("PO-9001"),
    );
    assert(
      rejected.status === "unmatched" &&
        rejected.result.links.length === 0 &&
        rejectedCandidate?.rejection === "wrong_supplier",
      "another supplier's PO is never linked",
      summary(rejected),
    );

    // 5. No source at all for this supplier.
    const callsBefore = calls.length;
    const noSource = await receive(
      teamA,
      extractionOf({
        invoiceNumber: "PS-5",
        ...STATIONERY,
        description: "Printer paper",
      }),
    );
    await match(teamA, noSource);
    const none = await currentOf(noSource);
    assert(
      none.status === "unmatched" &&
        none.result.candidates.length === 0 &&
        calls.length === callsBefore,
      "an invoice no source relates to is unmatched without TypeSafe",
      summary(none),
    );

    // 6. The neighbour's source is never considered, however it is referenced.
    const crossWorkspace = await receive(
      teamA,
      extractionOf({
        invoiceNumber: "NJ-6",
        purchaseOrderReference: "PO-77001",
      }),
    );
    await match(teamA, crossWorkspace);
    const isolated = await currentOf(crossWorkspace);
    assert(
      !JSON.stringify(isolated.result).includes(neighbourSource) &&
        !calls.some((call) => call.references.includes("PO-77001")),
      "another workspace's source is never a candidate",
      summary(isolated),
    );
    await rejects(
      () =>
        linkInvoiceSources(db, {
          teamId: teamA,
          inboxId: crossWorkspace,
          actorId: actor,
          reason: "try the neighbour's PO",
          sources: [{ sourceId: neighbourSource }],
        }),
      "not_found",
    );
    const neighbourInvoice = await receive(
      teamB,
      extractionOf({
        invoiceNumber: "NB-1",
        purchaseOrderReference: "PO-55120",
      }),
    );
    await match(teamB, neighbourInvoice);
    assert(
      (await currentOf(neighbourInvoice)).status !== "matched",
      "a reference to another workspace's source does not match",
    );
    assert(
      (
        await listSourceInvoiceMatches(db, {
          teamId: teamB,
          sourceId: idOf("PO-55120"),
        })
      ).length === 0,
      "a source's invoices are not readable from another workspace",
    );

    // 7. One invoice covering two sources, allocated line by line.
    const split = await receive(
      teamA,
      extractionOf({
        invoiceNumber: "NJ-7",
        purchaseOrderReference: "PO-55120",
        description: "Timber and kitchen labour (JOB-1042)",
        netAmount: 1900,
        vatAmount: 380,
        grossAmount: 2280,
        lineItems: [
          lineItem("Oak boards PO-55120", 1000),
          lineItem("Labour JOB-1042", 900),
        ],
      }),
    );
    await match(teamA, split);
    const splitMatch = await currentOf(split);
    assert(
      splitMatch.status === "matched" &&
        splitMatch.result.links.length === 2 &&
        splitMatch.result.allocation.complete &&
        splitMatch.result.allocation.allocatedAmount === "1900.00",
      "an invoice covering two sources is allocated to both",
      summary(splitMatch),
    );
    const allocationRows = await db
      .select({
        sourceId: invoiceSourceLinks.sourceId,
        amount: invoiceSourceAllocations.amount,
      })
      .from(invoiceSourceAllocations)
      .innerJoin(
        invoiceSourceLinks,
        eq(invoiceSourceLinks.id, invoiceSourceAllocations.linkId),
      )
      .where(eq(invoiceSourceLinks.matchId, splitMatch.id));
    assert(
      allocationRows.length === 2,
      "allocations are stored per link",
      allocationRows,
    );

    // 8. One source billed by several invoices, as the source view shows it.
    const kitchenInvoices = await listSourceInvoiceMatches(db, {
      teamId: teamA,
      sourceId: idOf("JOB-1042"),
    });
    const timberInvoices = await listSourceInvoiceMatches(db, {
      teamId: teamA,
      sourceId: idOf("PO-55120"),
    });
    assert(
      kitchenInvoices
        .map((row) => row.invoiceId)
        .sort()
        .join() === [freeText, split].sort().join() &&
        timberInvoices
          .map((row) => row.invoiceId)
          .sort()
          .join() === [exact, split].sort().join(),
      "each source lists every invoice billed against it",
      { kitchenInvoices, timberInvoices },
    );

    // 9. An amendment does not change what an earlier match compared.
    const amended = await amendAuthorizationSource(db, {
      teamId: teamA,
      actorId: actor,
      sourceId: idOf("JOB-1042"),
      source: {
        type: "job",
        reference: "JOB-1042",
        title: "Kitchen refit",
        scope: "Refit the kitchen at 12 High St: labour and materials",
        supplier: { name: "Northwind Joinery Ltd", vatNumber: "GB293445512" },
        currency: "GBP",
        taxBasis: "exclusive",
        issuedOn: "2026-09-01",
        startsOn: "2026-09-07",
        endsOn: "2026-10-31",
        effectiveFrom: "2026-10-01",
        changeReason: "Variation 1",
        lines: [
          { reference: "1", description: "Labour", amount: "2400.00" },
          { reference: "2", description: "Materials", amount: "2400.00" },
        ],
      },
    });
    assert(amended.version === 2, "the job is amended", amended);
    assert(
      (await currentOf(freeText)).result.links[0]?.version === 1,
      "a recorded match keeps citing the version it compared",
    );
    // An admin can compare with a named version; one not yet in effect on
    // the invoice date is recorded as such.
    await linkInvoiceSources(db, {
      teamId: teamA,
      inboxId: freeText,
      actorId: actor,
      reason: "Bill against the variation",
      sources: [{ sourceId: idOf("JOB-1042"), version: 2 }],
    });
    const named = await currentOf(freeText);
    const namedCandidate = named.result.candidates.find(
      (candidate) => candidate.sourceId === idOf("JOB-1042"),
    );
    assert(
      named.result.links[0]?.version === 2 &&
        namedCandidate?.versionBasis === "current" &&
        namedCandidate.evidence.some(
          (item) => item.kind === "version" && item.outcome === "conflicts",
        ),
      "a named version not yet in effect is compared and flagged",
      summary(named),
    );

    // 10. Unlink with a reason; reprocessing keeps it and the history.
    await rejects(
      () =>
        unlinkInvoiceSources(db, {
          teamId: teamA,
          inboxId: exact,
          actorId: actor,
          reason: " ",
        }),
      "invalid",
    );
    await unlinkInvoiceSources(db, {
      teamId: teamA,
      inboxId: exact,
      actorId: actor,
      reason: "Billed under the framework contract instead",
    });
    assert((await currentOf(exact)).status === "unmatched", "unlinked");
    assert(
      (await match(teamA, exact)).outcome === "kept_override",
      "processing does not undo an unlink",
    );
    const exactHistory = await listSourceMatchHistory(db, {
      teamId: teamA,
      inboxId: exact,
    });
    assert(
      exactHistory.map((row) => `${row.status}:${row.action}`).join() ===
        "unmatched:unlink,matched:automatic" &&
        exactHistory[0]?.reason ===
          "Billed under the framework contract instead" &&
        exactHistory[0]?.actorName === "Matching verifier",
      "the unlink is recorded, with who and why, above the automatic match",
      exactHistory,
    );

    // 11. A provider outage retries, then records insufficient evidence.
    outage.on = true;
    const outageInvoice = await receive(
      teamA,
      extractionOf({
        invoiceNumber: "WH-11",
        ...WARMLINE,
        description: "Boiler service visit",
      }),
    );
    let retried11 = false;
    try {
      await match(teamA, outageInvoice);
    } catch (error) {
      retried11 = (error as { retryable?: boolean }).retryable === true;
    }
    assert(retried11, "an unavailable TypeSafe retries the job");
    await match(teamA, outageInvoice, true);
    outage.on = false;
    const outageMatch = await currentOf(outageInvoice);
    assert(
      outageMatch.status === "insufficient_evidence" &&
        outageMatch.result.candidates.length === 2,
      "the last attempt records insufficient evidence with the candidates",
      summary(outageMatch),
    );

    // 12. Decisions cannot be edited in place.
    let refused = false;
    try {
      await db
        .update(invoiceSourceMatches)
        .set({ status: "matched" })
        .where(eq(invoiceSourceMatches.id, open.id));
    } catch {
      refused = true;
    }
    assert(refused, "the immutability trigger refuses an edited decision");

    const [{ count } = { count: 0 }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(invoiceSourceMatches)
      .where(inArray(invoiceSourceMatches.teamId, teamIds));

    console.log(
      JSON.stringify(
        {
          ok: true,
          decisions: count,
          proof: {
            exactReference: summary(exactMatch),
            freeTextProposal: summary(proposed),
            freeTextConfirmed: summary(confirmed),
            ambiguous: summary(open),
            ambiguousResolved: summary(resolved),
            wrongSupplier: summary(rejected),
            noSource: summary(none),
            splitAcrossSources: summary(splitMatch),
          },
          crossWorkspaceConsidered: false,
          typeSafeCalls: calls.length,
        },
        null,
        2,
      ),
    );
  } finally {
    if (teamIds.length > 0) {
      await db
        .delete(workflowJobs)
        .where(inArray(workflowJobs.teamId, teamIds));
      await db.delete(teams).where(inArray(teams.id, teamIds));
    }
    if (actorId) await db.delete(users).where(eq(users.id, actorId));
    await database.close();
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
