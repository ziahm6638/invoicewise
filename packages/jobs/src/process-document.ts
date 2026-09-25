import type { Database } from "@invoicewise/db/client";
import {
  type UpdateInboxWithProcessedDataParams,
  getInvoicesByDocumentNumber,
  getLaterDocumentsByNumber,
  getProcessedInvoiceHistory,
  getUserQuestions,
  lockDocumentIdentities,
  updateInboxValidation,
  updateInboxWithProcessedData,
} from "@invoicewise/db/queries";
import {
  DocumentClient,
  type InvoiceExtraction,
  type InvoiceJudgmentQuestion,
  validateInvoice,
} from "@invoicewise/documents";
import { emitInvoiceProcessedWebhooks } from "./webhooks";

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
  const [previousInvoices, workspaceQuestions] = await Promise.all([
    getProcessedInvoiceHistory(db, {
      teamId: input.teamId,
      documentId: input.inboxId,
    }),
    getUserQuestions(db, input.teamId),
  ]);
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
    previousInvoices,
    defaultJudgmentQuestions: configuredQuestions
      .filter((question) => question.isDefault && question.enabled)
      .map(({ question }) => question),
    judgmentQuestions:
      input.judgmentQuestions ??
      configuredQuestions
        .filter((question) => !question.isDefault && question.enabled)
        .map(({ question }) => question),
  });

  const { record, validation } = await saveProcessedDocument(db, {
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
    status: "pending",
  });

  if (record) await emitInvoiceProcessedWebhooks(db, record);

  return { record, result: { ...result, validation } };
}

/**
 * Duplicate identity and credit-note links look across the whole workspace:
 * every earlier live document carrying this document's number or the number
 * it credits.
 */
const validateAgainstEarlierDocuments = async (
  db: Database,
  teamId: string,
  documentId: string,
  extraction: unknown,
) => {
  const { invoiceNumber, originalInvoiceNumber } = (extraction ??
    {}) as Partial<InvoiceExtraction>;
  const earlier = await getInvoicesByDocumentNumber(db, {
    teamId,
    documentId,
    numbers: [invoiceNumber, originalInvoiceNumber].filter(
      (number): number is string => typeof number === "string",
    ),
  });
  return validateInvoice(extraction, earlier);
};

/**
 * Saves a processed document with its validation. The earliest-received copy
 * of an invoice is its original whatever order the copies are processed in:
 * later copies and credit notes processed before this one are validated
 * again in the same transaction, before their accounting post can read them.
 */
export async function saveProcessedDocument(
  db: Database,
  input: Omit<UpdateInboxWithProcessedDataParams, "validation"> & {
    teamId: string;
    extraction: InvoiceExtraction;
  },
) {
  return db.transaction(async (tx) => {
    const executor = tx as unknown as Database;
    await lockDocumentIdentities(executor, input.teamId);
    const validation = await validateAgainstEarlierDocuments(
      executor,
      input.teamId,
      input.id,
      input.extraction,
    );
    const record = await updateInboxWithProcessedData(executor, {
      ...input,
      validation,
    });
    if (record && input.extraction.invoiceNumber) {
      const later = await getLaterDocumentsByNumber(executor, {
        teamId: input.teamId,
        documentId: input.id,
        number: input.extraction.invoiceNumber,
      });
      for (const document of later) {
        await updateInboxValidation(executor, {
          id: document.id,
          teamId: input.teamId,
          validation: await validateAgainstEarlierDocuments(
            executor,
            input.teamId,
            document.id,
            document.extraction,
          ),
        });
      }
    }
    return { record, validation };
  });
}
