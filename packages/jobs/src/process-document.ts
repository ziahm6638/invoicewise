import type { Database } from "@midday/db/client";
import {
  getProcessedInvoiceHistory,
  getUserQuestions,
  updateInboxWithProcessedData,
} from "@midday/db/queries";
import {
  DocumentClient,
  type InvoiceJudgmentQuestion,
} from "@midday/documents";
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
  const result = await new DocumentClient().getInvoiceOrReceipt({
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
    type: result.type as "invoice" | "expense" | null | undefined,
    extraction: result.extraction,
    judgments: result.judgments,
    status: "pending",
  });

  if (record) await emitInvoiceProcessedWebhooks(db, record);

  return { record, result };
}
