/**
 * The waitlist sends a confirmation email to whatever address is submitted, so
 * the per-IP rate limit must fail closed: without it, no email goes out.
 * PocketBase, SMTP and request headers are stubbed.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

mock.module("next/headers", () => ({
  headers: async () =>
    new Headers({
      "x-forwarded-for": "203.0.113.7",
      "user-agent": "bun-test",
    }),
}));

const sent: string[] = [];
const created: string[] = [];
let countAttempts: () => Promise<number> = async () => 0;

mock.module("./email", () => ({
  sendConfirmationEmail: async ({ email }: { email: string }) => {
    sent.push(`confirmation:${email}`);
  },
  sendNotificationEmail: async ({ email }: { email: string }) => {
    sent.push(`notification:${email}`);
  },
}));

mock.module("./pocketbase", () => ({
  countRecentIpAttempts: () => countAttempts(),
  recordIpAttempt: async () => {},
  createLeadRecord: async ({ email }: { email: string }) => {
    created.push(email);
  },
  findLeadByEmailProduct: async () => null,
  toPocketBaseDate: (date: Date) => date.toISOString(),
}));

const { createLead } = await import("./leads.server");

const submit = () =>
  createLead({ email: "person@example.com", source: "test" });
const originalSalt = process.env.IP_HASH_SALT;
const originalConsoleError = console.error;

beforeEach(() => {
  sent.length = 0;
  created.length = 0;
  countAttempts = async () => 0;
  process.env.IP_HASH_SALT = "test-salt";
  console.error = () => {};
});

afterEach(() => {
  process.env.IP_HASH_SALT = originalSalt;
  console.error = originalConsoleError;
});

describe("createLead rate limit", () => {
  test("accepts and emails when the rate limit check passes", async () => {
    expect(await submit()).toEqual({ status: "ok" });
    expect(created).toEqual(["person@example.com"]);
    expect(sent).toContain("confirmation:person@example.com");
  });

  test("rejects without emailing when IP_HASH_SALT is unset", async () => {
    Reflect.deleteProperty(process.env, "IP_HASH_SALT");

    const result = await submit();

    expect(result.status).toBe("error");
    expect(result).toMatchObject({ code: "server_error" });
    expect(created).toEqual([]);
    expect(sent).toEqual([]);
  });

  test("rejects without emailing when the attempt query fails", async () => {
    countAttempts = async () => {
      throw new Error("pocketbase unavailable");
    };

    const result = await submit();

    expect(result.status).toBe("error");
    expect(result).toMatchObject({ code: "server_error" });
    expect(created).toEqual([]);
    expect(sent).toEqual([]);
  });
});
