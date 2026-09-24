import type { Attachments } from "./types";

/**
 * Declared content types a mailbox attachment may carry to be handed to
 * intake. They match the supported input matrix (PDF, JPEG, PNG; see
 * `docs/document-intake.md#supported-inputs`); intake still sniffs the real
 * bytes, and a generic `application/octet-stream` body is only accepted when
 * it is a PDF. HEIC, WebP, office documents and other types are not invoice
 * inputs and are never passed on.
 */
export const allowedMimeTypes = [
  "image/png",
  "image/jpeg",
  "image/jpg",
  "application/pdf",
  "application/octet-stream",
];

export function getAllowedAttachments(attachments?: Attachments) {
  return attachments?.filter((attachment) =>
    allowedMimeTypes.includes(attachment.ContentType),
  );
}
