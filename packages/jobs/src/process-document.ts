import type { Database } from "@invoicewise/db/client";
import {
  type UpdateInboxWithProcessedDataParams,
  getLaterDocumentsByNumber,
  getUserQuestions,
  lockDocumentIdentities,
} from "@invoicewise/db/queries";
import {
  DocumentClient,
  type InvoiceExtraction,
  type InvoiceJudgmentQuestion,
} from "@invoicewise/documents";
import { completeAndSchedule } from "./delivery";
import {
  loadJudgmentHistory,
  recordSupplierChecks,
  reevaluateDocument,
  resolveDocumentSupplier,
  validateAgainstEarlierDocuments,
} from "./suppliers";

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
  const workspaceQuestions = await getUserQuestions(db, input.teamId);
  const configuredQuestions = workspaceQuestions.map((question) => {
    const common = {
      id: question.questionKey,
      versionId: question.id,
      label: question.label,
      question: question.question,
      context: question.context,
    };
    if (question.type === "choice") {
      return {
        isDefault: question.isDefault,
        enabled: question.enabled,
        question: {
          ...common,
          type: "choice",
          options: question.options ?? [],
        } satisfies InvoiceJudgmentQuestion,
      };
    }
    if (question.type === "score") {
      return {
        isDefault: question.isDefault,
        enabled: question.enabled,
        question: {
          ...common,
          type: "score",
          levels: question.options ?? [],
        } satisfies InvoiceJudgmentQuestion,
      };
    }
    return {
      isDefault: question.isDefault,
      enabled: question.enabled,
      question: {
        ...common,
        type: "boolean",
      } satisfies InvoiceJudgmentQuestion,
    };
  });
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
    defaultJudgmentQuestions: configuredQuestions
      .filter((question) => question.isDefault && question.enabled)
      .map(({ question }) => question),
    judgmentQuestions:
      input.judgmentQuestions ??
      configuredQuestions
        .filter((question) => !question.isDefault && question.enabled)
        .map(({ question }) => question),
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
  },
) {
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
      ...input,
      validation,
    });
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
