import type {
  InvoiceExtraction,
  InvoiceJudgment,
  InvoiceJudgmentQuestion,
  PreviousInvoice,
} from "./typesafe/invoice";

export type GetDocumentRequest = {
  content?: string;
  documentUrl?: string;
  mimetype: string;
  companyName?: string | null;
  previousInvoices?: readonly PreviousInvoice[];
  defaultJudgmentQuestions?: readonly InvoiceJudgmentQuestion[];
  judgmentQuestions?: readonly InvoiceJudgmentQuestion[];
};

export type GetInvoiceOrReceiptResponse = {
  name?: string | null;
  date?: string | null;
  amount?: number | null;
  currency?: string | null;
  website?: string | null;
  type?: string | null;
  description?: string | null;
  tax_amount?: number | null;
  tax_rate?: number | null;
  tax_type?: string | null;
  metadata?: Record<string, string | number | boolean | null>;
  extraction?: InvoiceExtraction;
  judgments?: InvoiceJudgment[];
};

export interface Attachment {
  ContentLength: number;
  Content: string;
  Name: string;
  ContentType: string;
  ContentID: string;
}

export type Attachments = Attachment[];

export type DocumentClassifierRequest = {
  content: string;
};

export type DocumentClassifierImageRequest = {
  content: ArrayBuffer;
};
