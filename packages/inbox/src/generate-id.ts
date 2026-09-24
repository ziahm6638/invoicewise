import crypto from "node:crypto";

export function generateDeterministicId(input: string): string {
  const hash = crypto.createHash("sha256");
  hash.update(input);
  return hash.digest("hex");
}

/**
 * Provider identity for each attachment of one Gmail message, in part order.
 * The first attachment with a given filename keeps the original
 * `messageId_filename` formula, so mailboxes synced before occurrence
 * indexes existed still deduplicate. Later attachments with the same filename
 * add their occurrence (`messageId:n_filename`); Gmail message ids are hex, so
 * the two shapes can never produce the same input.
 */
export function gmailAttachmentReferenceIds(
  messageId: string,
  filenames: readonly string[],
): string[] {
  const seen = new Map<string, number>();
  return filenames.map((filename) => {
    const occurrence = seen.get(filename) ?? 0;
    seen.set(filename, occurrence + 1);
    return generateDeterministicId(
      occurrence === 0
        ? `${messageId}_${filename}`
        : `${messageId}:${occurrence}_${filename}`,
    );
  });
}
