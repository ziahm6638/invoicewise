import { describe, expect, test } from "bun:test";
import { redactOperationalText } from "../utils/redact";
import { sanitizeAuditDetail } from "./audit-events";

describe("operational text redaction", () => {
  test("masks credentials, signing secrets and signed URL parameters", () => {
    const text = redactOperationalText(
      [
        "POST failed: Authorization: Bearer abcdef0123456789",
        `key mid_${"a".repeat(64)}`,
        `secret whsec_${"b".repeat(64)}`,
        "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl",
        "url https://user:hunter2@example.com/x?token=abc123&signature=deadbeef",
        '{"client_secret":"s3cr3t","password":"p@ss"}',
      ].join("\n"),
    );
    for (const leaked of [
      "abcdef0123456789",
      "a".repeat(64),
      "b".repeat(64),
      "eyJhbGciOiJIUzI1NiJ9",
      "hunter2",
      "abc123",
      "deadbeef",
      "s3cr3t",
      "p@ss",
    ]) {
      expect(text).not.toContain(leaked);
    }
    expect(text).toContain("[redacted]");
  });

  test("masks bank details and card numbers but keeps identifiers", () => {
    const jobId = "3f1c0a1e-5b7d-4c2a-9e8f-0123456789ab";
    const text = redactOperationalText(
      `job ${jobId}: IBAN GB29 NWBK 6016 1331 9268 19, sort code 60-16-13, account number 31926819, card 4111 1111 1111 1111, invoice INV-2026-0042`,
    );
    expect(text).not.toContain("NWBK");
    expect(text).not.toContain("60-16-13");
    expect(text).not.toContain("31926819");
    expect(text).not.toContain("4111");
    expect(text).toContain(jobId);
    expect(text).toContain("INV-2026-0042");
  });

  test("bounds the length, so quoted documents cannot reach a log", () => {
    const text = redactOperationalText("x".repeat(10_000));
    expect(text.length).toBe(500);
    expect(redactOperationalText("short")).toBe("short");
  });
});

describe("audit detail", () => {
  test("keeps named scalars, redacts strings and bounds size and depth", () => {
    const detail = sanitizeAuditDetail({
      status: 202,
      ok: true,
      reason: "provider said Bearer abcdefghijkl",
      fields: ["iban", "sortCode"],
      nested: { deeper: { deepest: { gone: true } } },
      fn: () => 1,
      ...Object.fromEntries(
        Array.from({ length: 30 }, (_, index) => [`k${index}`, index]),
      ),
    });
    expect(detail).toMatchObject({
      status: 202,
      ok: true,
      reason: "provider said Bearer [redacted]",
      fields: ["iban", "sortCode"],
    });
    expect(detail?.nested).toEqual({ deeper: null });
    expect(detail).not.toHaveProperty("fn");
    expect(Object.keys(detail ?? {}).length).toBeLessThanOrEqual(20);
    expect(sanitizeAuditDetail(null)).toBeNull();
  });
});
