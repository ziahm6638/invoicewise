/**
 * SMTP transactional-mail policy checks.
 *
 * Every send goes to the loopback SMTP trap; nothing contacts Purelymail.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type SmtpTrap, startSmtpTrap } from "./smtp-trap";
import {
  assertTransactionalMailConfigured,
  resolveSmtpConfig,
  sendTransactionalSmtp,
} from "./transactional-mail";

const SENDER = "InvoiceWise <auth@invoicewise.test>";

let trap: SmtpTrap;

const trapEnv = (overrides: Record<string, string> = {}) =>
  ({
    NODE_ENV: "production",
    SMTP_HOST: trap.host,
    SMTP_PORT: String(trap.port),
    SMTP_USER: "trap-user@invoicewise.test",
    SMTP_PASS: "synthetic-trap-password",
    AUTH_EMAIL_FROM: SENDER,
    ...overrides,
  }) as NodeJS.ProcessEnv;

beforeAll(async () => {
  trap = await startSmtpTrap();
});

afterAll(async () => {
  await trap.stop();
});

describe("SMTP configuration", () => {
  test("defaults to Purelymail with implicit TLS", () => {
    expect(
      resolveSmtpConfig({ SMTP_USER: "user", SMTP_PASS: "pass" } as never),
    ).toEqual({
      host: "smtp.purelymail.com",
      port: 465,
      secure: true,
      user: "user",
      pass: "pass",
    });
  });

  test("uses a plain connection on a non-465 port", () => {
    expect(resolveSmtpConfig(trapEnv())?.secure).toBe(false);
  });

  test("is not configured without both credentials", () => {
    expect(resolveSmtpConfig({ SMTP_USER: "user" } as never)).toBeNull();
    expect(resolveSmtpConfig({ SMTP_PASS: "pass" } as never)).toBeNull();
  });

  test("production refusal names every required variable", () => {
    expect(() =>
      assertTransactionalMailConfigured(trapEnv({ AUTH_EMAIL_FROM: "" })),
    ).toThrow("SMTP_USER, SMTP_PASS and AUTH_EMAIL_FROM");
  });
});

describe("sendTransactionalSmtp", () => {
  test("delivers one message from AUTH_EMAIL_FROM", async () => {
    trap.reset();

    await sendTransactionalSmtp(
      {
        to: "person@example.test",
        subject: "Synthetic subject",
        text: "Synthetic body",
      },
      trapEnv(),
    );

    expect(trap.connections).toBe(1);
    expect(trap.messages).toHaveLength(1);
    const [message] = trap.messages;
    expect(message?.authUser).toBe("trap-user@invoicewise.test");
    expect(message?.from).toBe(SENDER);
    expect(message?.envelopeFrom).toBe("auth@invoicewise.test");
    expect(message?.recipients).toEqual(["person@example.test"]);
    expect(message?.subject).toBe("Synthetic subject");
  });

  test("refuses without configuration and opens no connection", async () => {
    trap.reset();

    await expect(
      sendTransactionalSmtp(
        { to: "person@example.test", subject: "Refused", text: "Refused" },
        trapEnv({ SMTP_PASS: "" }),
      ),
    ).rejects.toThrow(/not configured/);
    expect(trap.connections).toBe(0);
  });
});
