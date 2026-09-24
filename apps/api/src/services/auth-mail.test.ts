/**
 * Fail-closed transactional-mail checks for roadmap issue #33.
 *
 * Nothing here contacts a provider: the production cases assert the refusal
 * before any send, and the local cases use the opt-in file sink.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertTransactionalMailConfigured,
  deliverTransactionalMail,
  mailSinkPath,
} from "./auth-mail";

const productionEnv = (overrides: Record<string, string> = {}) =>
  ({
    NODE_ENV: "production",
    ...overrides,
  }) as NodeJS.ProcessEnv;

const message = {
  to: "person@example.test",
  subject: "Reset your InvoiceWise password",
  url: "https://app.example.test/api/auth/reset-password?token=reset-token",
};

describe("production transactional mail configuration", () => {
  test("refuses a missing key", () => {
    expect(() =>
      assertTransactionalMailConfigured(
        productionEnv({ AUTH_EMAIL_FROM: "InvoiceWise <auth@invoicewise.uk>" }),
      ),
    ).toThrow(/Transactional email is not configured/);
  });

  test("refuses the committed development placeholder key", () => {
    expect(() =>
      assertTransactionalMailConfigured(
        productionEnv({
          RESEND_API_KEY: "re_local_development",
          AUTH_EMAIL_FROM: "InvoiceWise <auth@invoicewise.uk>",
        }),
      ),
    ).toThrow(/Transactional email is not configured/);
  });

  test("refuses a missing sender address", () => {
    expect(() =>
      assertTransactionalMailConfigured(
        productionEnv({ RESEND_API_KEY: "re_synthetic_gate_value" }),
      ),
    ).toThrow(/Transactional email is not configured/);
  });

  test("accepts an explicit synthetic sender (the loopback provider seam)", () => {
    expect(() =>
      assertTransactionalMailConfigured(
        productionEnv({
          RESEND_API_KEY: "re_verify_stub",
          AUTH_EMAIL_FROM: "InvoiceWise Verify <verify@localhost.test>",
        }),
      ),
    ).not.toThrow();
  });

  test("never honours the local sink in production", () => {
    expect(
      mailSinkPath(
        productionEnv({
          AUTH_MAIL_SINK_PATH: join(tmpdir(), "should-not-be-used.jsonl"),
        }),
      ),
    ).toBeNull();
  });
});

describe("local development mailbox", () => {
  test("writes the full message to the explicit sink", async () => {
    const directory = await mkdtemp(join(tmpdir(), "auth-mail-sink-"));
    const sink = join(directory, "mail.jsonl");

    try {
      const result = await deliverTransactionalMail(message, {
        NODE_ENV: "development",
        AUTH_MAIL_SINK_PATH: sink,
      } as NodeJS.ProcessEnv);

      expect(result.transport).toBe("sink");

      const [line] = (await readFile(sink, "utf8")).trim().split("\n");
      expect(JSON.parse(line!)).toMatchObject({
        to: message.to,
        subject: message.subject,
        url: message.url,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("withholds the link instead of logging it", async () => {
    const logged: string[] = [];
    const original = console.info;
    console.info = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };

    try {
      const result = await deliverTransactionalMail(message, {
        NODE_ENV: "development",
      } as NodeJS.ProcessEnv);

      expect(result.transport).toBe("log");
    } finally {
      console.info = original;
    }

    const output = logged.join("\n");
    expect(output).toContain(message.subject);
    expect(output).not.toContain("reset-token");
    expect(output).not.toContain(message.url);
  });
});
