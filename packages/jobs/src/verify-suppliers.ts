/**
 * Supplier identity and history, end to end against Postgres.
 *
 * Two same-named suppliers (different VAT numbers) send repeated, revised
 * and genuinely different invoices, a credit note and a bank-detail change,
 * behind more than 50 other invoices; a second workspace receives the same
 * invoice. Every stored result must cite only its own supplier's history in
 * its own workspace, find evidence beyond the latest 50 invoices, and stay
 * explainable after later invoices arrive. Corrections (merge, reassign)
 * must be audited and reversible, and an identical re-delivery must be
 * recorded without a second processing job.
 *
 *   DATABASE_PRIMARY_URL=... bun run verify:suppliers
 */
import { resolve } from "node:path";
import { createDatabaseClient } from "@invoicewise/db/client";
import {
  getInboxRedeliveries,
  listSupplierEvents,
} from "@invoicewise/db/queries";
import {
  inbox,
  supplierEvents,
  suppliers,
  teams,
  users,
  workflowJobs,
} from "@invoicewise/db/schema";
import { createStorageClientFromEnv } from "@invoicewise/db/storage";
import type {
  InvoiceExtraction,
  InvoiceValidation,
  SupplierChecks,
} from "@invoicewise/documents";
import { and, eq, inArray } from "drizzle-orm";
import { acceptIntakeUpload } from "./intake";
import { saveProcessedDocument } from "./process-document";
import {
  loadJudgmentHistory,
  mergeSuppliers,
  reassignInvoiceSupplier,
  recheckInvoiceSupplier,
  revertSupplierChange,
} from "./suppliers";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const ACME_ONE = {
  supplierName: "Acme Supplies Ltd",
  supplierVatNumber: "GB111111111",
};
const ACME_TWO = {
  supplierName: "Acme Supplies Limited",
  supplierVatNumber: "GB222222222",
};
const OLD_ACCOUNT = { sortCode: "11-22-33", accountNumber: "44556677" };
const NEW_ACCOUNT = { sortCode: "99-88-77", accountNumber: "66554433" };

type BankDetails = InvoiceExtraction["bankDetails"];

const extractionOf = (
  value: Omit<Partial<InvoiceExtraction>, "bankDetails"> & {
    invoiceNumber: string;
    bankDetails?: Partial<BankDetails>;
  },
): InvoiceExtraction =>
  ({
    documentType: "invoice",
    supplierAddress: null,
    supplierCompanyNumber: null,
    originalInvoiceNumber: null,
    invoiceDate: "2026-09-01",
    dueDate: null,
    currency: "GBP",
    netAmount: 100,
    discountAmount: null,
    vatAmount: 20,
    taxRate: 20,
    grossAmount: 120,
    amountsIncludeTax: null,
    lineItems: [],
    description: null,
    purchaseOrderReference: null,
    paymentReference: null,
    textSource: "text-layer",
    pageSources: ["text-layer"],
    evidence: { fields: {}, lineItems: [] },
    ...ACME_ONE,
    ...value,
    bankDetails: {
      accountName: null,
      accountNumber: null,
      sortCode: null,
      iban: null,
      bic: null,
      ...(value.bankDetails ?? {}),
    },
  }) as InvoiceExtraction;

const assert = (condition: unknown, message: string, detail?: unknown) => {
  if (!condition) {
    throw new Error(
      `${message}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`,
    );
  }
};

async function main() {
  const database = createDatabaseClient({
    primaryUrl: required("DATABASE_PRIMARY_URL"),
    isDevelopment: true,
  });
  const db = database.db;
  const storage = createStorageClientFromEnv();
  const teamIds: string[] = [];
  let userId: string | undefined;
  let clock = Date.parse("2026-01-01T00:00:00Z");

  const receive = async (
    teamId: string,
    extraction: InvoiceExtraction,
  ): Promise<{ id: string; checks: SupplierChecks }> => {
    clock += 60_000;
    const [row] = await db
      .insert(inbox)
      .values({
        teamId,
        createdAt: new Date(clock).toISOString(),
        displayName: extraction.invoiceNumber ?? "invoice",
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
    return { id: row!.id, checks: await checksOf(row!.id) };
  };
  const stateOf = async (id: string) => {
    const [row] = await db
      .select({
        supplierId: inbox.supplierId,
        supplierChecks: inbox.supplierChecks,
        validation: inbox.validation,
      })
      .from(inbox)
      .where(eq(inbox.id, id));
    return row!;
  };
  const checksOf = async (id: string) =>
    (await stateOf(id)).supplierChecks as unknown as SupplierChecks;
  const cited = (checks: SupplierChecks) =>
    [
      ...checks.known.evidence,
      ...checks.duplicate.evidence,
      ...checks.bankDetails.evidence,
    ].map((item) => item.invoiceId);

  try {
    for (const name of ["Supplier history A", "Supplier history B"]) {
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
        fullName: "Supplier verifier",
        email: `suppliers-${teamA}@invoicewise.local`,
        teamId: teamA,
      })
      .returning({ id: users.id });
    userId = user!.id;

    // --- Supplier one: a first invoice with bank details, then 60 others.
    const first = await receive(
      teamA,
      extractionOf({ invoiceNumber: "A-001", bankDetails: OLD_ACCOUNT }),
    );
    assert(
      first.checks.known.outcome === "first_invoice" &&
        first.checks.duplicate.outcome === "none" &&
        first.checks.bankDetails.outcome === "insufficient_evidence",
      "A first invoice is new, not a duplicate, with no bank history",
      first.checks,
    );
    const supplierOne = first.checks.supplier.supplierId!;
    for (let index = 0; index < 60; index++) {
      await receive(
        teamA,
        extractionOf({
          invoiceNumber: `A-F${index}`,
          invoiceDate: `2026-06-${String((index % 28) + 1).padStart(2, "0")}`,
          grossAmount: 200 + index,
          netAmount: null,
          vatAmount: null,
        }),
      );
    }

    // --- Repeated: A-001 again, 61 invoices later.
    const repeated = await receive(
      teamA,
      extractionOf({ invoiceNumber: "A-001", bankDetails: OLD_ACCOUNT }),
    );
    assert(
      repeated.checks.duplicate.outcome === "likely_duplicate" &&
        repeated.checks.duplicate.evidence[0]?.invoiceId === first.id,
      "A repeated invoice beyond the latest 50 is found as a duplicate",
      repeated.checks.duplicate,
    );
    assert(
      repeated.checks.bankDetails.outcome === "consistent" &&
        repeated.checks.bankDetails.evidence[0]?.invoiceId === first.id,
      "Bank details beyond the latest 50 are still compared",
      repeated.checks.bankDetails,
    );
    assert(
      repeated.checks.known.earlierInvoices === 61,
      "Every earlier invoice counts toward a known supplier",
      repeated.checks.known,
    );
    const repeatedValidation = (await stateOf(repeated.id))
      .validation as unknown as InvoiceValidation;
    assert(
      repeatedValidation.identity.duplicateOf === first.id &&
        !repeatedValidation.accounting.ready,
      "The repeated invoice is held back from accounting",
      repeatedValidation.identity,
    );

    // --- Revised: same number, a different total.
    await receive(teamA, extractionOf({ invoiceNumber: "A-002" }));
    const revised = await receive(
      teamA,
      extractionOf({
        invoiceNumber: "A-002",
        netAmount: 150,
        vatAmount: 30,
        grossAmount: 180,
      }),
    );
    assert(
      revised.checks.duplicate.outcome === "revision",
      "A revised invoice is told apart from a copy",
      revised.checks.duplicate,
    );

    // --- Genuinely different, then a bank-detail change and a credit note.
    const different = await receive(
      teamA,
      extractionOf({
        invoiceNumber: "A-100",
        invoiceDate: "2026-09-10",
        netAmount: 500,
        vatAmount: 100,
        grossAmount: 600,
      }),
    );
    assert(
      different.checks.duplicate.outcome === "none" &&
        different.checks.known.outcome === "known",
      "A genuinely different invoice is neither duplicate nor revision",
      different.checks,
    );
    const changedBank = await receive(
      teamA,
      extractionOf({
        invoiceNumber: "A-101",
        invoiceDate: "2026-09-11",
        grossAmount: 60,
        netAmount: 50,
        vatAmount: 10,
        bankDetails: NEW_ACCOUNT,
      }),
    );
    assert(
      changedBank.checks.bankDetails.outcome === "changed" &&
        changedBank.checks.bankDetails.evidence[0]?.invoiceId === repeated.id,
      "A bank-detail change is reported against the supplier's latest details",
      changedBank.checks.bankDetails,
    );
    const serialized = JSON.stringify(changedBank.checks);
    assert(
      !serialized.includes("66554433") && !serialized.includes("44556677"),
      "Stored bank evidence is masked",
    );
    const credit = await receive(
      teamA,
      extractionOf({
        documentType: "credit_note",
        invoiceNumber: "CN-1",
        originalInvoiceNumber: "A-100",
        netAmount: -500,
        vatAmount: -100,
        grossAmount: -600,
      }),
    );
    assert(
      credit.checks.duplicate.outcome === "credit_note" &&
        credit.checks.duplicate.evidence[0]?.invoiceId === different.id,
      "A credit note is linked to the invoice it credits, not flagged as a duplicate",
      credit.checks.duplicate,
    );

    // --- Supplier two: same name, its own VAT number, the same number A-001.
    const other = await receive(
      teamA,
      extractionOf({
        ...ACME_TWO,
        invoiceNumber: "A-001",
        bankDetails: NEW_ACCOUNT,
      }),
    );
    assert(
      other.checks.supplier.supplierId !== supplierOne &&
        other.checks.known.outcome === "first_invoice" &&
        other.checks.duplicate.outcome === "none" &&
        other.checks.bankDetails.outcome === "insufficient_evidence" &&
        other.checks.historyIds.length === 0,
      "A same-named supplier with another VAT number shares no history",
      other.checks,
    );
    const otherValidation = (await stateOf(other.id))
      .validation as unknown as InvoiceValidation;
    assert(
      otherValidation.identity.duplicateOf === null,
      "Another supplier's invoice number is not a duplicate",
      otherValidation.identity,
    );
    const supplierTwo = other.checks.supplier.supplierId!;
    const judgmentHistory = await loadJudgmentHistory(db, {
      teamId: teamA,
      documentId: other.id,
      extraction: extractionOf({ ...ACME_TWO, invoiceNumber: "A-001" }),
    });
    assert(
      judgmentHistory.previousInvoices.length === 0,
      "Judgments never see another supplier's invoices",
      judgmentHistory.previousInvoices.map((invoice) => invoice.id),
    );
    const oneHistory = await loadJudgmentHistory(db, {
      teamId: teamA,
      documentId: changedBank.id,
      extraction: extractionOf({
        invoiceNumber: "A-101",
        bankDetails: NEW_ACCOUNT,
      }),
    });
    assert(
      oneHistory.previousInvoices.some((invoice) => invoice.id === first.id) &&
        oneHistory.previousInvoices.length <= 60,
      "Judgment history is bounded yet reaches beyond the latest 50",
      oneHistory.previousInvoices.length,
    );

    // --- A name alone that two suppliers share stays unresolved.
    const ambiguous = await receive(
      teamA,
      extractionOf({
        supplierName: "ACME Supplies",
        supplierVatNumber: null,
        invoiceNumber: "X-1",
        bankDetails: OLD_ACCOUNT,
      }),
    );
    assert(
      ambiguous.checks.supplier.supplierId === null &&
        ambiguous.checks.known.outcome === "insufficient_evidence" &&
        ambiguous.checks.bankDetails.outcome === "insufficient_evidence",
      "An ambiguous name is not merged into either supplier",
      ambiguous.checks,
    );

    // --- Workspace B receives supplier one's invoice: nothing crosses over.
    const isolated = await receive(
      teamB,
      extractionOf({ invoiceNumber: "A-001", bankDetails: NEW_ACCOUNT }),
    );
    assert(
      isolated.checks.known.outcome === "first_invoice" &&
        isolated.checks.duplicate.outcome === "none" &&
        isolated.checks.bankDetails.outcome === "insufficient_evidence" &&
        isolated.checks.supplier.supplierId !== supplierOne,
      "Another workspace's history is never used",
      isolated.checks,
    );

    // --- Stored results stay as recorded after new invoices arrive.
    assert(
      JSON.stringify(await checksOf(repeated.id)) ===
        JSON.stringify(repeated.checks),
      "A stored result is unchanged by later invoices",
    );
    const allIds = new Set(
      (
        await db
          .select({ id: inbox.id })
          .from(inbox)
          .where(
            and(eq(inbox.teamId, teamA), eq(inbox.supplierId, supplierOne)),
          )
      ).map((row) => row.id),
    );
    for (const result of [repeated, revised, different, changedBank, credit]) {
      for (const id of [...cited(result.checks), ...result.checks.historyIds]) {
        assert(
          allIds.has(id),
          "Evidence cites only the supplier's own documents",
          { id, result: result.id },
        );
      }
      assert(
        result.checks.version === 1 && result.checks.supplier.supplierId,
        "A stored result records its rules version and supplier",
      );
    }

    // --- Corrections: merge the two suppliers, check, then undo the merge.
    const merged = await mergeSuppliers(db, {
      teamId: teamA,
      sourceId: supplierTwo,
      targetId: supplierOne,
      actorId: userId,
      inboxId: other.id,
    });
    const afterMerge = await checksOf(other.id);
    assert(
      afterMerge.supplier.supplierId === supplierOne &&
        afterMerge.duplicate.outcome === "likely_duplicate" &&
        afterMerge.duplicate.evidence.some(
          (item) => item.invoiceId === first.id,
        ),
      "After a merge the invoice is compared with the kept supplier's history",
      afterMerge,
    );
    await revertSupplierChange(db, {
      teamId: teamA,
      eventId: merged.eventId,
      actorId: userId,
    });
    await recheckInvoiceSupplier(db, { teamId: teamA, inboxId: other.id });
    const afterUnmerge = await checksOf(other.id);
    assert(
      afterUnmerge.supplier.supplierId === supplierTwo &&
        afterUnmerge.duplicate.outcome === "none",
      "Undoing a mistaken merge restores the supplier's own history",
      afterUnmerge,
    );

    // --- Assign the ambiguous invoice to supplier one, then undo it.
    const assigned = await reassignInvoiceSupplier(db, {
      teamId: teamA,
      inboxId: ambiguous.id,
      supplierId: supplierOne,
      actorId: userId,
    });
    const afterAssign = await checksOf(ambiguous.id);
    assert(
      afterAssign.supplier.status === "manual" &&
        afterAssign.supplier.supplierId === supplierOne &&
        afterAssign.known.outcome === "known" &&
        afterAssign.bankDetails.outcome === "changed",
      "A manual assignment is used for the invoice's checks",
      afterAssign,
    );
    const events = await listSupplierEvents(db, {
      teamId: teamA,
      supplierIds: [supplierOne, supplierTwo],
    });
    assert(
      events.some(
        (event) => event.action === "merge" && event.actor?.id === userId,
      ) &&
        events.some((event) => event.action === "assign_invoice") &&
        events.some((event) => event.action === "revert"),
      "Every correction is recorded with who made it",
      events.map((event) => event.action),
    );
    await revertSupplierChange(db, {
      teamId: teamA,
      eventId: assigned.eventId,
      actorId: userId,
    });
    const afterRevert = await checksOf(ambiguous.id);
    assert(
      afterRevert.supplier.supplierId === null,
      "Undoing an assignment restores the unresolved supplier",
      afterRevert.supplier,
    );
    let refused = false;
    await revertSupplierChange(db, {
      teamId: teamA,
      eventId: assigned.eventId,
      actorId: userId,
    }).catch(() => {
      refused = true;
    });
    assert(refused, "A change cannot be undone twice");
    const foreign = await revertSupplierChange(db, {
      teamId: teamB,
      eventId: merged.eventId,
      actorId: userId,
    }).catch(() => "refused");
    assert(foreign === "refused", "Another workspace cannot undo a change");

    // --- An identical re-delivery is recorded, not processed again.
    const bytes = new Uint8Array(
      await Bun.file(
        resolve(
          process.cwd(),
          "../documents/src/test/fixtures/synthetic-invoice.pdf",
        ),
      ).arrayBuffer(),
    );
    const upload = await acceptIntakeUpload(db, storage, {
      teamId: teamA,
      bytes,
      declaredMimeType: "application/pdf",
      fileName: "synthetic-invoice.pdf",
    });
    const again = await acceptIntakeUpload(db, storage, {
      teamId: teamA,
      bytes,
      declaredMimeType: "application/pdf",
      fileName: "synthetic-invoice (copy).pdf",
      referenceId: "mail-redelivery-1",
    });
    const replayed = await acceptIntakeUpload(db, storage, {
      teamId: teamA,
      bytes,
      declaredMimeType: "application/pdf",
      fileName: "synthetic-invoice (copy).pdf",
      referenceId: "mail-redelivery-1",
    });
    assert(
      upload.status === "accepted" &&
        again.status === "accepted" &&
        replayed.status === "accepted" &&
        again.deduplicated &&
        again.inboxId === upload.inboxId,
      "An identical re-delivery returns the same document",
      { upload, again },
    );
    const redeliveries = await getInboxRedeliveries(db, {
      teamId: teamA,
      inboxId: upload.status === "accepted" ? upload.inboxId : "",
    });
    const jobs = await db
      .select({ id: workflowJobs.id })
      .from(workflowJobs)
      .where(eq(workflowJobs.teamId, teamA));
    assert(
      redeliveries.length === 1 &&
        redeliveries[0]?.referenceId === "mail-redelivery-1" &&
        jobs.length === 1,
      "The re-delivery is kept as one occurrence and not processed twice",
      { redeliveries, jobs: jobs.length },
    );

    console.log(
      JSON.stringify({
        ok: true,
        invoices: 70,
        suppliers: 2,
        duplicateBeyondLatest50: true,
        bankChangeBeyondLatest50: true,
        crossSupplierContamination: false,
        crossWorkspaceContamination: false,
        mergeReverted: true,
        assignmentReverted: true,
        redeliveriesRecorded: redeliveries.length,
      }),
    );
  } finally {
    if (teamIds.length > 0) {
      await db
        .delete(workflowJobs)
        .where(inArray(workflowJobs.teamId, teamIds));
      await db
        .delete(supplierEvents)
        .where(inArray(supplierEvents.teamId, teamIds));
      await db.delete(inbox).where(inArray(inbox.teamId, teamIds));
      await db.delete(suppliers).where(inArray(suppliers.teamId, teamIds));
    }
    if (userId) await db.delete(users).where(eq(users.id, userId));
    if (teamIds.length > 0) {
      await db.delete(teams).where(inArray(teams.id, teamIds));
    }
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
