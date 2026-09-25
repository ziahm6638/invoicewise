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
 * The workspace's enabled questions, as a processing run asks them: its
 * default checks and its own custom questions.
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
    const completion = await completeAndSchedule(executor, {
      ...processed,
      validation,
    });
    if (completion && sourceText) {
      await saveDocumentText(executor, {
        inboxId: input.id,
        teamId: input.teamId,
        revision: completion.revision,
        ...sourceText,
      });
    }
    const supplierChecks = completion
      ? await recordSupplierChecks(executor, {
          teamId: input.teamId,
          documentId: input.id,
          extraction: input.extraction,
          validation,
          supplier,
        })
      : null;
    if (completion && input.extraction.invoiceNumber) {
      const later = await getLaterDocumentsByNumber(executor, {
        teamId: input.teamId,
        documentId: input.id,
        number: input.extraction.invoiceNumber,
      });
      for (const document of later) {
        await reevaluateDocument(executor, {
          teamId: input.teamId,
          documentId: document.id,
        });
      }
    }
    return { completion, validation, supplierChecks };
  });
}
