export type InvoiceState =
  | "processing"
  | "extracted"
  | "judged"
  | "delivering"
  | "delivered"
  | "delivery_failed"
  | "failed";

type InvoiceRecord = {
  status?: string | null;
  extraction?: Record<string, unknown> | null;
  judgments?: Record<string, unknown>[] | null;
  processingError?: string | null;
  /**
   * Server-derived outcome of the current revision's configured
   * destinations (webhooks and accounting). Absent or "none" when no
   * destination is configured.
   */
  delivery?: { state: string } | null;
};

export function getInvoiceState(invoice: InvoiceRecord): InvoiceState {
  if (["new", "processing", "analyzing"].includes(invoice.status ?? "")) {
    return "processing";
  }

  if (invoice.processingError || !invoice.extraction) return "failed";
  // Delivery reflects actual destination outcomes; the legacy `done` status
  // does not mean anything was delivered.
  if (invoice.delivery?.state === "failed") return "delivery_failed";
  if (invoice.delivery?.state === "pending") return "delivering";
  if (invoice.delivery?.state === "delivered") return "delivered";
  if (invoice.judgments?.length) return "judged";
  return "extracted";
}

export const invoiceStateLabel: Record<InvoiceState, string> = {
  processing: "Processing",
  extracted: "Extracted",
  judged: "Judged",
  delivering: "Delivering",
  delivered: "Delivered",
  delivery_failed: "Delivery failed",
  failed: "Failed",
};

export function getExtractionText(
  extraction: Record<string, unknown> | null | undefined,
  key: string,
) {
  const value = extraction?.[key];
  return typeof value === "string" && value.trim() ? value : null;
}
