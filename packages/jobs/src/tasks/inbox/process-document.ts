import type { Database } from "@midday/db/client";
import {
  getProcessedInvoiceHistory,
  updateInboxWithProcessedData,
} from "@midday/db/queries";
import {
  DocumentClient,
  type InvoiceJudgmentQuestion,
} from "@midday/documents";

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
  const previousInvoices = await getProcessedInvoiceHistory(db, {
    teamId: input.teamId,
    excludeId: input.inboxId,
  });
  const result = await new DocumentClient().getInvoiceOrReceipt({
    documentUrl: input.documentUrl,
    mimetype: input.mimetype,
    companyName: input.companyName,
    previousInvoices,
    judgmentQuestions: input.judgmentQuestions,
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

  return { record, result };
}
