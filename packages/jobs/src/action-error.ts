/**
 * Why a user action on an invoice (correct, re-extract, rerun questions,
 * retry) was refused. `conflict` means the invoice changed or is busy and the
 * caller should reload; `invalid` carries per-field messages for a
 * correction; `forbidden` is a role the action needs.
 */
export class InvoiceActionError extends Error {
  override readonly name = "InvoiceActionError";
  constructor(
    readonly code: "not_found" | "conflict" | "invalid" | "forbidden",
    message: string,
    readonly fields: readonly {
      field: string | null;
      message: string;
    }[] = [],
  ) {
    super(message);
  }
}
