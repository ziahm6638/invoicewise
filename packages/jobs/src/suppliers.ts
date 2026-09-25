/**
 * Workspace supplier identity: resolving each processed document to a
 * supplier, retrieving that supplier's history for its checks, and the
 * audited corrections (reassign an invoice, merge suppliers, revert either).
 *
 * Everything that reads or changes supplier identity runs under the
 * workspace's document-identity lock, so resolution, duplicate validation and
 * corrections are serialised. The rules are in
 * `packages/documents/src/supplier.ts`; `docs/document-intake.md` publishes them.
 */
import type { Database } from "@invoicewise/db/client";
import {
  createSupplier,
  findSupplierCandidates,
  getCanonicalSupplier,
  getInboxSupplierState,
  getInvoicesByDocumentNumber,
  getSupplierEventForUpdate,
  getSupplierHistory,
  getSupplierHistorySummary,
  getSupplierRecord,
  learnSupplierIdentifiers,
  listDocumentsWithoutSupplier,
  lockDocumentIdentities,
  markSupplierEventReverted,
  mergeSupplierRecords,
  recordSupplierEvent,
  setInboxSupplier,
  setInboxSupplierChecks,
  unmergeSupplierRecords,
  updateInboxValidation,
} from "@invoicewise/db/queries";
import {
  type InvoiceExtraction,
  type InvoiceValidation,
  type JudgmentHistoryScope,
  type PreviousInvoice,
  SUPPLIER_HISTORY_LIMITS,
  type SupplierCheckSupplier,
  type SupplierResolution,
  bankAccountKeysOf,
  checkSupplierHistory,
  resolveSupplier,
  supplierIdentifiersOf,
  validateInvoice,
} from "@invoicewise/documents";

/** Legacy documents given a supplier per processing run, oldest first. */
const BACKFILL_BATCH = 200;

export class SupplierCorrectionError extends Error {
  override readonly name = "SupplierCorrectionError";
  constructor(
    message: string,
    readonly code: "not_found" | "conflict" | "invalid",
  ) {
    super(message);
  }
}

/** What `inbox.supplier_resolution` holds. */
export type StoredSupplierResolution = {
  status: SupplierCheckSupplier["status"];
  method: SupplierCheckSupplier["method"];
  message: string;
  reason?: string;
  candidateIds?: string[];
  /** For a manual assignment: who made it and the event that records it. */
  assignedBy?: string | null;
  eventId?: string;
  resolvedAt: string;
};

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};

const text = (value: unknown) =>
  typeof value === "string" && value.trim() !== "" ? value : null;

const resolutionFrom = (
  resolution: SupplierResolution,
): StoredSupplierResolution => ({
  status: resolution.status,
  method: resolution.status === "unresolved" ? null : resolution.method,
  message: resolution.message,
  ...(resolution.status === "unresolved"
    ? { reason: resolution.reason, candidateIds: resolution.candidateIds }
    : {}),
  resolvedAt: new Date().toISOString(),
});

const decide = async (db: Database, teamId: string, extraction: unknown) => {
  const identifiers = supplierIdentifiersOf(extraction);
  const candidates = await findSupplierCandidates(db, {
    teamId,
    nameKey: identifiers.nameKey,
    vatKey: identifiers.vatKey,
    companyKey: identifiers.companyKey,
  });
  return { identifiers, resolution: resolveSupplier(identifiers, candidates) };
};

/**
 * Resolves a document to a supplier and records it, creating the supplier
 * when the invoice introduces one. A manual assignment is kept. Call under
 * the identity lock.
 */
async function assignSupplier(
  db: Database,
  input: { teamId: string; documentId: string; extraction: unknown },
): Promise<{ supplierId: string | null; stored: StoredSupplierResolution }> {
  const current = await getInboxSupplierState(db, {
    teamId: input.teamId,
    inboxId: input.documentId,
  });
  const existing = asRecord(current?.supplierResolution);
  if (existing.status === "manual" && current?.supplierId) {
    return {
      supplierId: current.supplierId,
      stored: existing as unknown as StoredSupplierResolution,
    };
  }

  const { identifiers, resolution } = await decide(
    db,
    input.teamId,
    input.extraction,
  );
  let supplierId: string | null = null;
  if (resolution.status === "matched") {
    supplierId = resolution.supplierId;
    await learnSupplierIdentifiers(db, {
      teamId: input.teamId,
      supplierId,
      ...resolution.learn,
    });
  } else if (resolution.status === "new") {
    supplierId = await createSupplier(db, {
      teamId: input.teamId,
      name:
        identifiers.name ??
        text(asRecord(input.extraction).supplierVatNumber) ??
        "Unnamed supplier",
      nameKey: identifiers.nameKey,
      vatKey: identifiers.vatKey || null,
      companyKey: identifiers.companyKey || null,
    });
  }
  const stored = resolutionFrom(resolution);
  await setInboxSupplier(db, {
    teamId: input.teamId,
    inboxId: input.documentId,
    supplierId,
    resolution: stored,
  });
  return { supplierId, stored };
}

/**
 * Gives documents processed before supplier identity existed their supplier,
 * oldest first, so the history a new invoice is compared with includes them.
 */
export async function backfillSuppliers(
  db: Database,
  input: { teamId: string; excludeId: string },
) {
  const pending = await listDocumentsWithoutSupplier(db, {
    teamId: input.teamId,
    excludeId: input.excludeId,
    limit: BACKFILL_BATCH,
  });
  for (const document of pending) {
    await assignSupplier(db, {
      teamId: input.teamId,
      documentId: document.id,
      extraction: document.extraction,
    });
  }
  return pending.length;
}

const checkSupplierOf = async (
  db: Database,
  teamId: string,
  supplierId: string | null,
  stored: StoredSupplierResolution,
): Promise<SupplierCheckSupplier> => {
  const canonical = supplierId
    ? await getCanonicalSupplier(db, { teamId, supplierId })
    : null;
  return {
    status: stored.status,
    supplierId: canonical?.id ?? null,
    name: canonical?.name ?? null,
    method: stored.method,
    message: stored.message,
    ...(stored.candidateIds ? { candidateIds: stored.candidateIds } : {}),
  };
};

/** The supplier's earlier documents, however far back, within the retrieval bounds. */
const supplierHistory = (
  db: Database,
  input: {
    teamId: string;
    documentId: string;
    supplierId: string;
    extraction: unknown;
  },
) => {
  const record = asRecord(input.extraction);
  const bank = bankAccountKeysOf(input.extraction);
  const gross = record.grossAmount;
  return getSupplierHistory(db, {
    teamId: input.teamId,
    documentId: input.documentId,
    supplierId: input.supplierId,
    numbers: [record.invoiceNumber, record.originalInvoiceNumber].filter(
      (value): value is string => typeof value === "string",
    ),
    grossAmount:
      typeof gross === "number" && Number.isFinite(gross) ? gross : null,
    invoiceDate: text(record.invoiceDate),
    iban: bank.iban,
    ukAccount: bank.ukAccount,
    limits: SUPPLIER_HISTORY_LIMITS,
  });
};

/**
 * Validates a document against every earlier same-numbered document in the
 * workspace, deciding "same supplier" by resolved supplier where both have one.
 */
export async function validateAgainstEarlierDocuments(
  db: Database,
  input: {
    teamId: string;
    documentId: string;
    extraction: unknown;
    supplierId: string | null;
  },
) {
  const { invoiceNumber, originalInvoiceNumber } = (input.extraction ??
    {}) as Partial<InvoiceExtraction>;
  const earlier = await getInvoicesByDocumentNumber(db, {
    teamId: input.teamId,
    documentId: input.documentId,
    numbers: [invoiceNumber, originalInvoiceNumber].filter(
      (number): number is string => typeof number === "string",
    ),
  });
  return validateInvoice(input.extraction, earlier, {
    supplierId: input.supplierId,
  });
}

/**
 * Resolves a document's supplier (under the identity lock) and returns the
 * canonical supplier id its validation and checks use.
 */
export async function resolveDocumentSupplier(
  db: Database,
  input: { teamId: string; documentId: string; extraction: unknown },
) {
  await backfillSuppliers(db, {
    teamId: input.teamId,
    excludeId: input.documentId,
  });
  const { supplierId, stored } = await assignSupplier(db, input);
  const supplier = await checkSupplierOf(db, input.teamId, supplierId, stored);
  return supplier;
}

/**
 * Computes and stores a document's supplier-history checks with the records
 * they were computed from, so the result stays explainable later.
 */
export async function recordSupplierChecks(
  db: Database,
  input: {
    teamId: string;
    documentId: string;
    extraction: unknown;
    validation: InvoiceValidation | null;
    supplier: SupplierCheckSupplier;
  },
) {
  const supplierId = input.supplier.supplierId;
  const history = supplierId
    ? await supplierHistory(db, { ...input, supplierId })
    : [];
  const summary = supplierId
    ? await getSupplierHistorySummary(db, {
        teamId: input.teamId,
        documentId: input.documentId,
        supplierId,
      })
    : { count: 0, first: null };
  const checks = checkSupplierHistory({
    extraction: input.extraction,
    validation: input.validation,
    supplier: input.supplier,
    history,
    earlierInvoices: summary.count,
    firstInvoice: summary.first,
  });
  await setInboxSupplierChecks(db, {
    teamId: input.teamId,
    inboxId: input.documentId,
    checks,
  });
  return checks;
}

/**
 * The earlier invoices a new document's judgments compare with: its
 * supplier's history only (never another supplier's), chosen without
 * changing anything. Suppliers are created when the document is saved.
 */
export async function loadJudgmentHistory(
  db: Database,
  input: { teamId: string; documentId: string; extraction: unknown },
): Promise<{
  previousInvoices: readonly PreviousInvoice[];
  scope: JudgmentHistoryScope;
}> {
  await db.transaction(async (tx) => {
    const executor = tx as unknown as Database;
    await lockDocumentIdentities(executor, input.teamId);
    await backfillSuppliers(executor, {
      teamId: input.teamId,
      excludeId: input.documentId,
    });
  });
  const current = await getInboxSupplierState(db, {
    teamId: input.teamId,
    inboxId: input.documentId,
  });
  let supplierId: string | null = null;
  let unresolved: string | null = null;
  if (
    asRecord(current?.supplierResolution).status === "manual" &&
    current?.supplierId
  ) {
    supplierId =
      (
        await getCanonicalSupplier(db, {
          teamId: input.teamId,
          supplierId: current.supplierId,
        })
      )?.id ?? null;
  } else {
    const { resolution } = await decide(db, input.teamId, input.extraction);
    if (resolution.status === "matched") supplierId = resolution.supplierId;
    if (resolution.status === "unresolved") unresolved = resolution.message;
  }
  if (!supplierId) {
    return {
      previousInvoices: [],
      scope: {
        scoped: true,
        emptyReason: unresolved
          ? `${unresolved} There is no supplier history to compare with.`
          : "This is the first invoice from this supplier in this workspace.",
      },
    };
  }
  const history = await supplierHistory(db, {
    teamId: input.teamId,
    documentId: input.documentId,
    supplierId,
    extraction: input.extraction,
  });
  return {
    previousInvoices: history.map(({ id, extraction }) => ({
      id,
      extraction,
      supplierId,
    })),
    scope: {
      scoped: true,
      emptyReason:
        "There are no earlier invoices from this supplier in this workspace yet.",
    },
  };
}

/**
 * Re-runs the deterministic checks of one document against its current
 * supplier: supplier history always, validation only while the document has
 * not been sent to accounting (a posted bill's recorded verdict stands).
 */
export async function reevaluateDocument(
  db: Database,
  input: { teamId: string; documentId: string },
) {
  const state = await getInboxSupplierState(db, {
    teamId: input.teamId,
    inboxId: input.documentId,
  });
  if (!state?.extraction || state.status === "deleted") return null;
  const stored = asRecord(
    state.supplierResolution,
  ) as unknown as StoredSupplierResolution;
  const supplier = state.supplierResolution
    ? await checkSupplierOf(db, input.teamId, state.supplierId, stored)
    : await resolveDocumentSupplier(db, {
        teamId: input.teamId,
        documentId: input.documentId,
        extraction: state.extraction,
      });
  let validation = state.validation as InvoiceValidation | null;
  if (!state.accountingProviderId) {
    validation = await validateAgainstEarlierDocuments(db, {
      teamId: input.teamId,
      documentId: input.documentId,
      extraction: state.extraction,
      supplierId: supplier.supplierId,
    });
    await updateInboxValidation(db, {
      id: input.documentId,
      teamId: input.teamId,
      validation,
    });
  }
  return recordSupplierChecks(db, {
    teamId: input.teamId,
    documentId: input.documentId,
    extraction: state.extraction,
    validation,
    supplier,
  });
}

const inTransaction = <T>(
  db: Database,
  teamId: string,
  work: (tx: Database) => Promise<T>,
) =>
  db.transaction(async (tx) => {
    const executor = tx as unknown as Database;
    await lockDocumentIdentities(executor, teamId);
    return work(executor);
  });

/**
 * Assigns an invoice to an existing supplier, or to a new one named by the
 * user, recording the change so it can be reverted. The invoice's checks are
 * re-run against the chosen supplier.
 */
export async function reassignInvoiceSupplier(
  db: Database,
  input: {
    teamId: string;
    inboxId: string;
    actorId: string;
    supplierId?: string;
    newSupplierName?: string;
  },
) {
  return inTransaction(db, input.teamId, async (tx) => {
    const state = await getInboxSupplierState(tx, {
      teamId: input.teamId,
      inboxId: input.inboxId,
    });
    if (!state?.extraction || state.status === "deleted") {
      throw new SupplierCorrectionError("Invoice not found", "not_found");
    }
    let targetId: string;
    if (input.supplierId) {
      const target = await getCanonicalSupplier(tx, {
        teamId: input.teamId,
        supplierId: input.supplierId,
      });
      if (!target) {
        throw new SupplierCorrectionError("Supplier not found", "not_found");
      }
      targetId = target.id;
    } else {
      const name = input.newSupplierName?.trim();
      if (!name) {
        throw new SupplierCorrectionError(
          "Choose a supplier or name a new one",
          "invalid",
        );
      }
      // Identifiers stay with the supplier that holds them: a registration
      // number belongs to one supplier, so the new one is known by name.
      targetId = await createSupplier(tx, {
        teamId: input.teamId,
        name,
        nameKey: supplierIdentifiersOf({ supplierName: name }).nameKey,
      });
    }
    const event = await recordSupplierEvent(tx, {
      teamId: input.teamId,
      action: "assign_invoice",
      supplierId: state.supplierId,
      targetSupplierId: targetId,
      inboxId: input.inboxId,
      actorId: input.actorId,
      data: {
        previousSupplierId: state.supplierId,
        previousResolution: state.supplierResolution,
        createdSupplier: !input.supplierId,
      },
    });
    await setInboxSupplier(tx, {
      teamId: input.teamId,
      inboxId: input.inboxId,
      supplierId: targetId,
      resolution: {
        status: "manual",
        method: "manual",
        message: "Assigned to this supplier by a workspace admin.",
        assignedBy: input.actorId,
        eventId: event.id,
        resolvedAt: event.createdAt,
      } satisfies StoredSupplierResolution,
    });
    await reevaluateDocument(tx, {
      teamId: input.teamId,
      documentId: input.inboxId,
    });
    return { eventId: event.id, supplierId: targetId };
  });
}

/**
 * Merges one supplier into another: every invoice of the source now counts
 * as the target's history. The source keeps its identifiers, so an unmerge
 * restores it exactly. `inboxId`, when given, is re-checked straight away.
 */
export async function mergeSuppliers(
  db: Database,
  input: {
    teamId: string;
    sourceId: string;
    targetId: string;
    actorId: string;
    inboxId?: string;
  },
) {
  return inTransaction(db, input.teamId, async (tx) => {
    const source = await getCanonicalSupplier(tx, {
      teamId: input.teamId,
      supplierId: input.sourceId,
    });
    const target = await getCanonicalSupplier(tx, {
      teamId: input.teamId,
      supplierId: input.targetId,
    });
    if (!source || !target) {
      throw new SupplierCorrectionError("Supplier not found", "not_found");
    }
    if (source.id === target.id) {
      throw new SupplierCorrectionError(
        "These are already the same supplier",
        "invalid",
      );
    }
    const movedIds = await mergeSupplierRecords(tx, {
      teamId: input.teamId,
      sourceId: source.id,
      targetId: target.id,
    });
    const event = await recordSupplierEvent(tx, {
      teamId: input.teamId,
      action: "merge",
      supplierId: source.id,
      targetSupplierId: target.id,
      inboxId: input.inboxId ?? null,
      actorId: input.actorId,
      data: { sourceName: source.name, targetName: target.name, movedIds },
    });
    if (input.inboxId) {
      await reevaluateDocument(tx, {
        teamId: input.teamId,
        documentId: input.inboxId,
      });
    }
    return { eventId: event.id, supplierId: target.id };
  });
}

/**
 * Reverts a merge or an invoice assignment, as long as nothing since has
 * built on it (the supplier was merged again, or the invoice reassigned).
 */
export async function revertSupplierChange(
  db: Database,
  input: {
    teamId: string;
    eventId: string;
    actorId: string;
    inboxId?: string;
  },
) {
  return inTransaction(db, input.teamId, async (tx) => {
    const event = await getSupplierEventForUpdate(tx, {
      teamId: input.teamId,
      eventId: input.eventId,
    });
    if (!event || event.action === "revert") {
      throw new SupplierCorrectionError("Change not found", "not_found");
    }
    if (event.revertedAt) {
      throw new SupplierCorrectionError(
        "This change was already undone",
        "conflict",
      );
    }
    const data = asRecord(event.data);
    let recheck = input.inboxId ?? event.inboxId;
    if (event.action === "merge") {
      const source = await getSupplierRecord(tx, {
        teamId: input.teamId,
        supplierId: event.supplierId!,
      });
      if (!source || source.mergedIntoId !== event.targetSupplierId) {
        throw new SupplierCorrectionError(
          "The supplier has changed since this merge; undo the later changes first",
          "conflict",
        );
      }
      await unmergeSupplierRecords(tx, {
        teamId: input.teamId,
        sourceId: event.supplierId!,
        targetId: event.targetSupplierId!,
        movedIds: Array.isArray(data.movedIds)
          ? (data.movedIds as string[])
          : [],
      });
    } else {
      const state = await getInboxSupplierState(tx, {
        teamId: input.teamId,
        inboxId: event.inboxId!,
      });
      if (
        !state ||
        asRecord(state.supplierResolution).eventId !== event.id ||
        state.supplierId !== event.targetSupplierId
      ) {
        throw new SupplierCorrectionError(
          "The invoice has been reassigned since; undo the later change first",
          "conflict",
        );
      }
      const previousSupplierId = text(data.previousSupplierId);
      const previousSupplier = previousSupplierId
        ? await getSupplierRecord(tx, {
            teamId: input.teamId,
            supplierId: previousSupplierId,
          })
        : null;
      await setInboxSupplier(tx, {
        teamId: input.teamId,
        inboxId: event.inboxId!,
        supplierId: previousSupplier?.id ?? null,
        // A document assigned before it was ever resolved is resolved again.
        resolution: (data.previousResolution ?? null) as Record<
          string,
          unknown
        > | null,
      });
      recheck = event.inboxId;
    }
    await markSupplierEventReverted(tx, {
      teamId: input.teamId,
      eventId: event.id,
    });
    const revert = await recordSupplierEvent(tx, {
      teamId: input.teamId,
      action: "revert",
      supplierId: event.supplierId,
      targetSupplierId: event.targetSupplierId,
      inboxId: event.inboxId,
      actorId: input.actorId,
      data: { revertedAction: event.action },
      revertsEventId: event.id,
    });
    if (recheck) {
      await reevaluateDocument(tx, {
        teamId: input.teamId,
        documentId: recheck,
      });
    }
    return { eventId: revert.id };
  });
}
