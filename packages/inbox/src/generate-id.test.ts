import { expect, test } from "bun:test";
import {
  generateDeterministicId,
  gmailAttachmentReferenceIds,
} from "./generate-id";

test("same-named Gmail attachments in one message get distinct references", () => {
  const ids = gmailAttachmentReferenceIds("18c2f0a1b2", [
    "invoice.pdf",
    "invoice.pdf",
    "receipt.pdf",
    "invoice.pdf",
  ]);

  expect(new Set(ids).size).toBe(4);
  // The first occurrence keeps the pre-existing formula, so attachments that
  // were already ingested are still recognised on the next sync.
  expect(ids[0]).toBe(generateDeterministicId("18c2f0a1b2_invoice.pdf"));
  expect(ids[2]).toBe(generateDeterministicId("18c2f0a1b2_receipt.pdf"));
  expect(ids[1]).toBe(generateDeterministicId("18c2f0a1b2:1_invoice.pdf"));
  expect(ids[3]).toBe(generateDeterministicId("18c2f0a1b2:2_invoice.pdf"));
});

test("Gmail attachment references are stable across syncs", () => {
  const filenames = ["invoice.pdf", "invoice.pdf"];
  expect(gmailAttachmentReferenceIds("abc123", filenames)).toEqual(
    gmailAttachmentReferenceIds("abc123", filenames),
  );
  expect(gmailAttachmentReferenceIds("abc124", filenames)[0]).not.toBe(
    gmailAttachmentReferenceIds("abc123", filenames)[0],
  );
});
