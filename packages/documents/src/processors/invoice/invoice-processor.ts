import { Cause, Effect, Exit } from "effect";
import { invoiceColumnsFromExtraction } from "../../correction";
import type { GetDocumentRequest, GetInvoiceResponse } from "../../types";
import {
  type TypeSafe,
  TypeSafeError,
  TypeSafeLive,
} from "../../typesafe/client";
import {
  type StoredInvoiceJudgmentRequest,
  judgeStoredInvoice,
  processInvoice,
} from "../../typesafe/invoice";

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

/**
 * Runs a TypeSafe program and unwraps its typed failure: a rejected
 * `runPromise` would hide the reason inside a FiberFailure and drop the
 * retryable flag.
 */
async function run<A>(
  program: Effect.Effect<A, TypeSafeError, TypeSafe>,
): Promise<A> {
  const exit = await Effect.runPromiseExit(
    program.pipe(Effect.provide(TypeSafeLive)),
  );
  if (Exit.isSuccess(exit)) return exit.value;
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

export class InvoiceProcessor {
  public async getInvoice(
    params: GetDocumentRequest,
  ): Promise<GetInvoiceResponse> {
    const { extraction, validation, judgments, timings } = await run(
      processInvoice(params),
    );
    const columns = invoiceColumnsFromExtraction(extraction);

    return {
      type: "invoice",
      name: columns.displayName,
      date: columns.date,
      amount: columns.amount,
      currency: columns.currency,
      website: null,
      description: columns.description,
      tax_amount: columns.taxAmount,
      tax_rate: columns.taxRate,
      tax_type: columns.taxType,
      extraction,
      validation,
      judgments,
      timings,
      metadata: {
        invoice_number: extraction.invoiceNumber,
        invoice_date: extraction.invoiceDate,
        due_date: extraction.dueDate,
        supplier_vat_number: extraction.supplierVatNumber,
        purchase_order_reference: extraction.purchaseOrderReference,
        document_type: extraction.documentType,
        payment_reference: extraction.paymentReference,
        validation_status: validation.status,
      },
    };
  }

  /** Answers the configured questions again for a stored extraction. */
  public async getJudgments(params: StoredInvoiceJudgmentRequest) {
    return run(judgeStoredInvoice(params));
  }
}
