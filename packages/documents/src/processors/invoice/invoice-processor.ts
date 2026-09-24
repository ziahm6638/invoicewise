import { Cause, Effect, Exit } from "effect";
import type { GetDocumentRequest, GetInvoiceResponse } from "../../types";
import { TypeSafeError, TypeSafeLive } from "../../typesafe/client";
import { processInvoice } from "../../typesafe/invoice";

/**
 * A failed invoice run. `message` is the internal detail for logs,
 * `userMessage` the reason safe to record on the invoice (absent when the
 * failure is not the document's fault) and `retryable` tells the worker
 * whether another attempt can succeed.
 */
export class InvoiceProcessingError extends Error {
  override readonly name = "InvoiceProcessingError";
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly userMessage?: string,
  ) {
    super(message);
  }
}

export class InvoiceProcessor {
  public async getInvoice(
    params: GetDocumentRequest,
  ): Promise<GetInvoiceResponse> {
    const exit = await Effect.runPromiseExit(
      processInvoice(params).pipe(Effect.provide(TypeSafeLive)),
    );
    if (Exit.isFailure(exit)) {
      // Unwrap the typed failure: a rejected `runPromise` would hide the
      // reason inside a FiberFailure and drop the retryable flag.
      const failure = Cause.failureOption(exit.cause);
      if (failure._tag === "None") {
        throw new InvoiceProcessingError(Cause.pretty(exit.cause), true);
      }
      if (failure.value instanceof TypeSafeError) {
        throw new InvoiceProcessingError(
          failure.value.reason,
          failure.value.retryable,
          failure.value.userMessage,
        );
      }
      // Missing TypeSafe configuration: another attempt cannot succeed.
      throw new InvoiceProcessingError(
        `TypeSafe is not configured: ${failure.value.message}`,
        false,
      );
    }

    const { extraction, judgments } = exit.value;
    const taxRate =
      extraction.netAmount && extraction.vatAmount !== null
        ? (extraction.vatAmount / extraction.netAmount) * 100
        : null;

    return {
      type: "invoice",
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
