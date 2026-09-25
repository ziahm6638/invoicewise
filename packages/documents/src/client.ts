import { InvoiceProcessor } from "./processors/invoice/invoice-processor";
import type { GetDocumentRequest, GetInvoiceResponse } from "./types";
import type { StoredInvoiceJudgmentRequest } from "./typesafe/invoice";

/**
 * Entry point for document processing. Every supported input (text PDF,
 * scanned PDF, JPEG and PNG) goes through the same TypeSafe extraction and
 * judgment pipeline and yields the same response shape; there is no alternate
 * per-format path.
 */
export class DocumentClient {
  public async getInvoice(
    params: GetDocumentRequest,
  ): Promise<GetInvoiceResponse> {
    return new InvoiceProcessor().getInvoice(params);
  }

  /**
   * Answers the configured questions again for a stored extraction, reading
   * the document only for its text.
   */
  public async getJudgments(params: StoredInvoiceJudgmentRequest) {
    return new InvoiceProcessor().getJudgments(params);
  }
}
