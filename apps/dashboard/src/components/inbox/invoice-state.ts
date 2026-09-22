export type InvoiceState =
  | "processing"
  | "extracted"
  | "judged"
  | "delivered"
  | "failed";

type InvoiceRecord = {
  status?: string | null;
  extraction?: Record<string, unknown> | null;
  judgments?: Record<string, unknown>[] | null;
};

export function getInvoiceState(invoice: InvoiceRecord): InvoiceState {
  if (["new", "processing", "analyzing"].includes(invoice.status ?? "")) {
    return "processing";
  }

  if (invoice.status === "done") return "delivered";
  if (!invoice.extraction) return "failed";
  if (invoice.judgments?.length) return "judged";
  return "extracted";
}

export const invoiceStateLabel: Record<InvoiceState, string> = {
  processing: "Processing",
  extracted: "Extracted",
  judged: "Judged",
  delivered: "Delivered",
  failed: "Failed",
};

export function getExtractionText(
  extraction: Record<string, unknown> | null | undefined,
  key: string,
) {
  const value = extraction?.[key];
  return typeof value === "string" && value.trim() ? value : null;
}
