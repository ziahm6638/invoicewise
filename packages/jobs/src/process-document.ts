import type { Database } from "@invoicewise/db/client";
import {
  getInvoicesByDocumentNumber,
  getProcessedInvoiceHistory,
  getUserQuestions,
  updateInboxWithProcessedData,
} from "@invoicewise/db/queries";
import {
  DocumentClient,
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
      excludeId: input.inboxId,
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

  // Duplicate identity and credit-note links look across the whole
  // workspace, not only the recent history the judgments read: every earlier
  // document carrying this document's number or the number it credits.
  const { invoiceNumber, originalInvoiceNumber } = result.extraction;
  const sameNumber = await getInvoicesByDocumentNumber(db, {
    teamId: input.teamId,
    excludeId: input.inboxId,
    numbers: [invoiceNumber, originalInvoiceNumber].filter(
      (number): number is string => Boolean(number),
    ),
  });
  const known = new Set(previousInvoices.map((invoice) => invoice.id));
  const validation = validateInvoice(result.extraction, [
    ...sameNumber.filter((invoice) => !known.has(invoice.id)),
    ...previousInvoices,
  ]);

  const record = await updateInboxWithProcessedData(db, {
    id: input.inboxId,
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
    validation,
    processingError: null,
    status: "pending",
  });

  if (record) await emitInvoiceProcessedWebhooks(db, record);

  return { record, result: { ...result, validation } };
}
