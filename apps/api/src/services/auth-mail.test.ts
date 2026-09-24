/**
 * Fail-closed transactional-mail checks for roadmap issue #33.
 *
 * Nothing here contacts Purelymail: every SMTP connection goes to the loopback
 * trap, which records connections and messages, and the local cases use the
 * opt-in file sink. Each check passes its own environment, so the result does
 * not depend on test order or on what the process environment holds.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SmtpTrap, startSmtpTrap } from "@invoicewise/utils/smtp-trap";
import {
  assertTransactionalMailConfigured,
  deliverTransactionalMail,
  mailSinkPath,
} from "./auth-mail";
import { deliverMail } from "./mail";

const SENDER = "InvoiceWise <auth@invoicewise.uk>";

const message = {
  to: "person@example.test",
  subject: "Reset your InvoiceWise password",
  url: "https://app.example.test/api/auth/reset-password?token=reset-token",
};

let trap: SmtpTrap;
let directory: string;

const smtpEnv = (overrides: Record<string, string> = {}) =>
  ({
    NODE_ENV: "production",
    SMTP_HOST: trap.host,
    SMTP_PORT: String(trap.port),
    SMTP_USER: "auth@invoicewise.test",
    SMTP_PASS: "synthetic-auth-smtp-password",
    AUTH_EMAIL_FROM: SENDER,
    ...overrides,
  }) as NodeJS.ProcessEnv;

/** Collects everything written to the console while `run` executes. */
const captureConsole = async <T>(run: () => Promise<T>) => {
  const logged: string[] = [];
  const originals = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  for (const level of Object.keys(originals) as (keyof typeof originals)[]) {
    console[level] = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };
  }

  try {
    return { result: await run(), output: logged.join("\n") };
  } finally {
    Object.assign(console, originals);
  }
};

beforeAll(async () => {
  trap = await startSmtpTrap();
  directory = await mkdtemp(join(tmpdir(), "auth-mail-"));
});

afterAll(async () => {
  await trap.stop();
  await rm(directory, { recursive: true, force: true });
});

describe("production transactional mail configuration", () => {
  for (const missing of ["SMTP_USER", "SMTP_PASS", "AUTH_EMAIL_FROM"]) {
    test(`refuses a missing ${missing} before any SMTP connection`, async () => {
      trap.reset();
      const env = smtpEnv({ [missing]: "" });

      expect(() => assertTransactionalMailConfigured(env)).toThrow(
        "Transactional email is not configured: SMTP_USER, SMTP_PASS and AUTH_EMAIL_FROM are required in production",
      );
      await expect(deliverTransactionalMail(message, env)).rejects.toThrow(
        /Transactional email is not configured/,
      );
      expect(trap.connections).toBe(0);
    });
  }

  test("accepts explicit synthetic SMTP settings (the loopback trap)", () => {
    expect(() => assertTransactionalMailConfigured(smtpEnv())).not.toThrow();
  });

  test("never honours the local sink in production", async () => {
    trap.reset();
    const sink = join(directory, "should-not-be-used.jsonl");
    const env = smtpEnv({ AUTH_MAIL_SINK_PATH: sink });

    expect(mailSinkPath(env)).toBeNull();

    const { result } = await captureConsole(() =>
      deliverTransactionalMail(message, env),
    );

    expect(result.transport).toBe("smtp");
    expect(trap.messages).toHaveLength(1);
    expect(await stat(sink).catch(() => null)).toBeNull();
  });

  test("delivers exactly one message from AUTH_EMAIL_FROM and logs no link", async () => {
    trap.reset();

    const { result, output } = await captureConsole(() =>
      deliverTransactionalMail(message, smtpEnv()),
    );

    expect(result.transport).toBe("smtp");
    expect(trap.connections).toBe(1);
    expect(trap.messages).toHaveLength(1);
    const [sent] = trap.messages;
    expect(sent?.authUser).toBe("auth@invoicewise.test");
    expect(sent?.from).toBe(SENDER);
    expect(sent?.recipients).toEqual([message.to]);
    expect(sent?.subject).toBe(message.subject);
    expect(output).not.toContain("reset-token");
  });
});

describe("local development mailbox", () => {
  test("writes the full message to the explicit sink without SMTP", async () => {
    trap.reset();
    const sink = join(directory, "mail.jsonl");

    const result = await deliverTransactionalMail(
      message,
      smtpEnv({ NODE_ENV: "development", AUTH_MAIL_SINK_PATH: sink }),
    );

    expect(result.transport).toBe("sink");
    expect(trap.connections).toBe(0);

    const [line] = (await readFile(sink, "utf8")).trim().split("\n");
    expect(JSON.parse(line!)).toMatchObject({
      to: message.to,
      subject: message.subject,
      url: message.url,
    });
  });

  test("sends through SMTP when it is configured and no sink is set", async () => {
    trap.reset();

    const result = await deliverTransactionalMail(
      message,
      smtpEnv({ NODE_ENV: "development" }),
    );

    expect(result.transport).toBe("smtp");
    expect(trap.messages).toHaveLength(1);
  });

  test("withholds the link instead of logging it", async () => {
    trap.reset();

    const { result, output } = await captureConsole(() =>
      deliverTransactionalMail(message, {
        NODE_ENV: "development",
      } as NodeJS.ProcessEnv),
    );

    expect(result.transport).toBe("log");
    expect(trap.connections).toBe(0);
    expect(output).toContain(message.subject);
    expect(output).not.toContain("reset-token");
    expect(output).not.toContain(message.url);
  });
});

describe("shared API mail", () => {
  test("captures product notifications with the configured sender", async () => {
    trap.reset();
    const sink = join(directory, "product.jsonl");

    const result = await deliverMail(
      {
        to: "admin@example.test",
        subject: "An app has been added to your team",
        html: "<p>Synthetic</p>",
      },
      { env: smtpEnv({ NODE_ENV: "test", AUTH_MAIL_SINK_PATH: sink }) },
    );

    expect(result.transport).toBe("sink");
    expect(trap.connections).toBe(0);
    const [line] = (await readFile(sink, "utf8")).trim().split("\n");
    expect(JSON.parse(line!)).toMatchObject({
      to: "admin@example.test",
      from: SENDER,
      subject: "An app has been added to your team",
      html: "<p>Synthetic</p>",
    });
  });

  test("refuses production without SMTP credentials", async () => {
    trap.reset();

    await expect(
      deliverMail(
        { to: "admin@example.test", subject: "Refused", text: "Refused" },
        { env: smtpEnv({ SMTP_PASS: "" }) },
      ),
    ).rejects.toThrow(/Transactional email is not configured/);
    expect(trap.connections).toBe(0);
  });
});
