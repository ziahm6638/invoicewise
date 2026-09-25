import type {
  InvoiceExtraction,
  InvoiceJudgment,
  InvoiceJudgmentQuestion,
  InvoiceStageTimings,
  JudgmentHistoryScope,
  PreviousInvoice,
} from "./typesafe/invoice";
import type { InvoiceValidation } from "./validation";

export type GetDocumentRequest = {
  content?: string;
  documentUrl?: string;
  mimetype: string;
  companyName?: string | null;
  previousInvoices?: readonly PreviousInvoice[];
  /**
   * Chooses the earlier invoices judgments compare with once the invoice has
   * been read, so they can be limited to its supplier. Takes precedence over
   * `previousInvoices`.
   */
  loadHistory?: (extraction: InvoiceExtraction) => Promise<{
    previousInvoices: readonly PreviousInvoice[];
    scope: JudgmentHistoryScope;
  }>;
  defaultJudgmentQuestions?: readonly InvoiceJudgmentQuestion[];
  judgmentQuestions?: readonly InvoiceJudgmentQuestion[];
};

/** One processed invoice, in the same shape for every supported input format. */
export type GetInvoiceResponse = {
  type: "invoice";
  name: string | null;
  date: string | null;
  amount: number | null;
  currency: string | null;
  website: string | null;
  description: string | null;
  tax_amount: number | null;
  tax_rate: number | null;
  tax_type: string | null;
  metadata: Record<string, string | number | boolean | null>;
  extraction: InvoiceExtraction;
  validation: InvoiceValidation;
  judgments: InvoiceJudgment[];
  timings: InvoiceStageTimings;
};

export interface Attachment {
  ContentLength: number;
  Content: string;
  Name: string;
  ContentType: string;
  ContentID: string;
}

export type Attachments = Attachment[];
