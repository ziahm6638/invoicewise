import { describe, expect, test } from "bun:test";
import { isTransientIntakeFailure } from "./intake-failure";

describe("intake failure classification", () => {
  test("storage and parser-capacity failures are retryable", () => {
    // Storage unavailable covers both a failed write and a failed read-back:
    // neither proves anything about the document, so the delivery retries.
    expect(isTransientIntakeFailure("storage_unavailable")).toBe(true);
    expect(isTransientIntakeFailure("temporarily_unavailable")).toBe(true);

    // Everything else is permanent for this content and is acknowledged.
    for (const code of [
      "content_mismatch",
      "malformed",
      "password_protected",
      "reference_conflict",
      "resource_limit",
      "superseded",
      "too_large",
      "timeout",
      "unsupported_type",
      null,
      undefined,
    ]) {
      expect(`${code}: ${isTransientIntakeFailure(code)}`).toBe(
        `${code}: false`,
      );
    }
  });
});
