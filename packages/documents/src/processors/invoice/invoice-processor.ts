import { Effect } from "effect";
import type { GetDocumentRequest } from "../../types";
import { TypeSafeLive } from "../../typesafe/client";
import { processInvoice } from "../../typesafe/invoice";

export class InvoiceProcessor {
  public async getInvoice(params: GetDocumentRequest) {
    const { extraction, judgments } = await Effect.runPromise(
      processInvoice(params).pipe(Effect.provide(TypeSafeLive)),
    );
    const taxRate =
      extraction.netAmount && extraction.vatAmount !== null
        ? (extraction.vatAmount / extraction.netAmount) * 100
        : null;

    return {
      type: "invoice" as const,
      name: extraction.supplierName,
      date: extraction.dueDate ?? extraction.invoiceDate,
      amount: extraction.grossAmount,
      currency: extraction.currency,
      website: null,
      description: extraction.description,
      tax_amount: extraction.vatAmount,
      tax_rate: taxRate,
      tax_type: extraction.vatAmount === null ? null : "vat",
      extraction,
      judgments,
      metadata: {
        invoice_number: extraction.invoiceNumber,
        invoice_date: extraction.invoiceDate,
        due_date: extraction.dueDate,
        supplier_vat_number: extraction.supplierVatNumber,
        purchase_order_reference: extraction.purchaseOrderReference,
      },
    };
  }
}
