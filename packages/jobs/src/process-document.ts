import type { Database } from "@invoicewise/db/client";
import {
  type UpdateInboxWithProcessedDataParams,
  getLaterDocumentsByNumber,
  getUserQuestions,
  lockDocumentIdentities,
  saveDocumentText,
} from "@invoicewise/db/queries";
import {
  DocumentClient,
  type InvoiceExtraction,
  type InvoiceJudgmentQuestion,
  type RetainedSourceText,
} from "@invoicewise/documents";
import { completeAndSchedule } from "./delivery";
import { schedulePaymentMatchingForRevision } from "./payment-matching";
import { scheduleInvoiceMatch } from "./source-matching";
import {
  loadJudgmentHistory,
  recordSupplierChecks,
  reevaluateDocument,
  resolveDocumentSupplier,
  validateAgainstEarlierDocuments,
} from "./suppliers";

type WorkspaceQuestion = Awaited<ReturnType<typeof getUserQuestions>>[number];

/** A stored question revision as TypeSafe judgments ask it. */
export function toJudgmentQuestion(
  question: Pick<
    WorkspaceQuestion,
    | "id"
    | "questionKey"
    | "version"
    | "label"
    | "question"
    | "context"
    | "type"
    | "options"
    | "numberFormat"
  >,
): InvoiceJudgmentQuestion {
  const common = {
    id: question.questionKey,
    versionId: question.id,
    version: question.version,
    label: question.label,
    question: question.question,
    context: question.context,
  };
  switch (question.type) {
    case "choice":
      return { ...common, type: "choice", options: question.options ?? [] };
    case "score":
      return { ...common, type: "score", levels: question.options ?? [] };
    case "number":
      return {
        ...common,
        type: "number",
        format: question.numberFormat ?? { unit: "other" },
      };
    default:
      return { ...common, type: "boolean" };
  }
}

/**
 * The workspace's enabled questions, as a processing run and a question
 * rerun both ask them: its default checks and its own custom questions.
 */
export async function loadJudgmentQuestions(db: Database, teamId: string) {
  const enabled = (await getUserQuestions(db, teamId)).filter(
    (question) => question.enabled,
  );
  return {
    defaultQuestions: enabled
      .filter((question) => question.isDefault)
      .map(toJudgmentQuestion),
    customQuestions: enabled
      .filter((question) => !question.isDefault)
      .map(toJudgmentQuestion),
  };
}

export async function processDocumentAttachment(
  db: Database,
  input: {
    inboxId: string;
    teamId: string;
    documentUrl: string;
    mimetype: string;
    companyName?: string | null;
    judgmentQuestions?: readonly InvoiceJudgmentQuestion[];
  },
) {
  const questions = await loadJudgmentQuestions(db, input.teamId);
  const result = await new DocumentClient().getInvoice({
    documentUrl: input.documentUrl,
    mimetype: input.mimetype,
    companyName: input.companyName,
    // Judgments compare with the invoice's own supplier's history, chosen
    // once the supplier has been read.
    loadHistory: (extraction) =>
      loadJudgmentHistory(db, {
        teamId: input.teamId,
        documentId: input.inboxId,
        extraction,
      }),
    defaultJudgmentQuestions: questions.defaultQuestions,
    judgmentQuestions: input.judgmentQuestions ?? questions.customQuestions,
  });

  // The result, its validation, its revision and every destination's delivery
  // intent commit together; a null completion means another worker already
  // completed this document.
  const savingAt = performance.now();
  const { completion, validation } = await saveProcessedDocument(db, {
    id: input.inboxId,
    teamId: input.teamId,
    amount: result.amount,
    currency: result.currency,
    displayName: result.name,
    website: result.website,
    date: result.date,
    description: result.description,
    taxAmount: result.tax_amount,
    taxRate: result.tax_rate,
    taxType: result.tax_type,
    type: result.type,
    extraction: result.extraction,
    judgments: result.judgments,
    sourceText: result.sourceText,
    processingError: null,
  });

  return {
    completion,
    result: { ...result, validation },
    timings: {
      ...result.timings,
      persistMs: Math.round(performance.now() - savingAt),
    },
  };
}

/**
 * Saves a processed document with its supplier, validation and supplier
 * history checks as the next revision and schedules its deliveries, in one
 * transaction. Duplicate identity and credit-note links look across the
 * whole workspace (every earlier live document with this number or the
 * number it credits). The earliest-received copy of an invoice is its
 * original whatever order the copies are processed in: later copies and
 * credit notes processed before this one are checked again in the same
 * transaction, before their accounting post can read them.
 */
export async function saveProcessedDocument(
  db: Database,
  input: Omit<UpdateInboxWithProcessedDataParams, "validation" | "status"> & {
    teamId: string;
    extraction: InvoiceExtraction;
    /** The text the run read, kept as the invoice's source evidence. */
    sourceText?: RetainedSourceText;
  },
) {
  const { sourceText, ...processed } = input;
  return db.transaction(async (tx) => {
    const executor = tx as unknown as Database;
    await lockDocumentIdentities(executor, input.teamId);
    const supplier = await resolveDocumentSupplier(executor, {
      teamId: input.teamId,
      documentId: input.id,
      extraction: input.extraction,
    });
    const validation = await validateAgainstEarlierDocuments(executor, {
      teamId: input.teamId,
      documentId: input.id,
      extraction: input.extraction,
      supplierId: supplier.supplierId,
    });
    // The supplier-history checks are recorded before the deliveries are
    // scheduled, because the delivery decision reads them.
    let supplierChecks: Awaited<
      ReturnType<typeof recordSupplierChecks>
    > | null = null;
    const completion = await completeAndSchedule(
      executor,
      { ...processed, validation },
      async () => {
        supplierChecks = await recordSupplierChecks(executor, {
          teamId: input.teamId,
          documentId: input.id,
          extraction: input.extraction,
          validation,
          supplier,
        });
      },
    );
    if (completion && sourceText) {
      await saveDocumentText(executor, {
        inboxId: input.id,
        teamId: input.teamId,
        revision: completion.revision,
        ...sourceText,
      });
    }
    // Matching to authorization sources follows in its own job (it may ask
    // TypeSafe), queued with the revision so it cannot be lost.
    if (completion) {
      await scheduleInvoiceMatch(executor, {
        teamId: input.teamId,
        invoiceId: input.id,
        revision: completion.revision,
      });
      // Bank payments (optional): the revision is matched to the
      // workspace's bank transactions in its own job.
      await schedulePaymentMatchingForRevision(executor, {
        teamId: input.teamId,
        invoiceId: input.id,
        revision: completion.revision,
      });
    }
    if (completion && input.extraction.invoiceNumber) {
      await reevaluateLaterDocuments(executor, input.teamId, input.id, [
        input.extraction.invoiceNumber,
      ]);
    }
    return { completion, validation, supplierChecks };
  });
}

/**
 * Checks again the later documents, not yet sent to accounting, whose
 * duplicate identity or credit link depends on this document carrying (or
 * no longer carrying) one of `numbers`. Runs in the caller's transaction,
 * under `lockDocumentIdentities`.
 */
export async function reevaluateLaterDocuments(
  executor: Database,
  teamId: string,
  documentId: string,
  numbers: readonly string[],
) {
  const seen = new Set<string>();
  for (const number of numbers) {
    const later = await getLaterDocumentsByNumber(executor, {
      teamId,
      documentId,
      number,
    });
    for (const document of later) {
      if (seen.has(document.id)) continue;
      seen.add(document.id);
      await reevaluateDocument(executor, { teamId, documentId: document.id });
    }
  }
}
