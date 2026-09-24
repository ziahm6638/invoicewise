/**
 * Transactional-mail policy checks for the workflow mailer.
 *
 * The worker runs without the API's auth import, so it enforces the same
 * fail-closed production configuration and the same explicit non-production
 * capture. Every SMTP connection in these checks goes to the loopback trap;
 * nothing contacts Purelymail. The mailer reads its configuration when the
 * layer is built, so each check sets its own environment first and the result
 * does not depend on which test file loaded the workflows module earlier.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SmtpTrap, startSmtpTrap } from "@invoicewise/utils/smtp-trap";
import { Effect } from "effect";
import type {
  WorkflowExecutionError,
  WorkflowMail,
  WorkflowMailer,
} from "./workflows.js";

const SENDER = "InvoiceWise <auth@invoicewise.test>";
const TOKEN_LINK = "https://app.example.test/teams?token=invite-token";
const MAIL_KEYS = [
  "NODE_ENV",
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USER",
  "SMTP_PASS",
  "AUTH_EMAIL_FROM",
  "AUTH_MAIL_SINK_PATH",
  "RESEND_API_KEY",
  "RESEND_AUDIENCE_ID",
] as const;

const previousEnv = { ...process.env };
let trap: SmtpTrap;
let sinkDir: string;

/** Replaces every mail-related variable, so no earlier value leaks in. */
const useMailEnv = (
  values: Partial<Record<(typeof MAIL_KEYS)[number], string>>,
) => {
  for (const key of MAIL_KEYS) {
    delete process.env[key];
  }
  Object.assign(process.env, values);
};

const configuredProduction = () => ({
  NODE_ENV: "production",
  SMTP_HOST: trap.host,
  SMTP_PORT: String(trap.port),
  SMTP_USER: "worker@invoicewise.test",
  SMTP_PASS: "synthetic-worker-smtp-password",
  AUTH_EMAIL_FROM: SENDER,
});

const invitation: WorkflowMail = {
  from: "Inherited Sender <hello@example.test>",
  to: ["invitee@example.test"],
  subject: "Invitation",
  html: `<a href="${TOKEN_LINK}">Join</a>`,
};

const runMailer = async (
  use: (
    mailer: WorkflowMailer["Type"],
  ) => Effect.Effect<void, WorkflowExecutionError>,
) => {
  // Loaded on first use, after the check has set its environment.
  const { WorkflowMailer, WorkflowMailerLive } = await import("./workflows.js");

  return await Effect.runPromise(
    Effect.gen(function* () {
      const mailer = yield* WorkflowMailer;
      yield* use(mailer);
    }).pipe(Effect.provide(WorkflowMailerLive)),
  );
};

const sendOnce = (message: WorkflowMail) =>
  runMailer((mailer) => mailer.send(message));

describe("workflow mailer transactional-mail policy", () => {
  beforeAll(async () => {
    trap = await startSmtpTrap();
    sinkDir = await mkdtemp(join(tmpdir(), "jobs-mailer-policy-"));
  });

  afterAll(async () => {
    process.env = previousEnv;
    await trap.stop();
    await rm(sinkDir, { recursive: true, force: true });
  });

  for (const missing of [
    "SMTP_USER",
    "SMTP_PASS",
    "AUTH_EMAIL_FROM",
  ] as const) {
    test(`refuses production without ${missing} and opens no SMTP connection`, async () => {
      trap.reset();
      useMailEnv({ ...configuredProduction(), [missing]: "" });

      await expect(sendOnce(invitation)).rejects.toThrow(
        /Transactional email is not configured: SMTP_USER, SMTP_PASS and AUTH_EMAIL_FROM/,
      );

      expect(trap.connections).toBe(0);
    });
  }

  test("captures non-production mail locally without an SMTP connection", async () => {
    trap.reset();
    const sink = join(sinkDir, "local.jsonl");
    useMailEnv({
      ...configuredProduction(),
      NODE_ENV: "test",
      AUTH_MAIL_SINK_PATH: sink,
    });

    await sendOnce(invitation);

    const [line] = (await readFile(sink, "utf8")).trim().split("\n");
    const record = JSON.parse(line!) as {
      to?: string;
      from?: string | null;
      subject?: string;
    };

    expect(record.to).toBe("invitee@example.test");
    expect(record.from).toBe(SENDER);
    expect(record.subject).toBe("Invitation");
    expect(trap.connections).toBe(0);
  });

  test("sends configured production mail through SMTP, ignoring the sink", async () => {
    trap.reset();
    const sink = join(sinkDir, "production.jsonl");
    useMailEnv({ ...configuredProduction(), AUTH_MAIL_SINK_PATH: sink });

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
      await sendOnce(invitation);
    } finally {
      Object.assign(console, originals);
    }

    expect(trap.connections).toBe(1);
    expect(trap.messages).toHaveLength(1);
    const [message] = trap.messages;
    expect(message?.from).toBe(SENDER);
    expect(message?.recipients).toEqual(["invitee@example.test"]);
    expect(message?.subject).toBe("Invitation");
    expect(await stat(sink).catch(() => null)).toBeNull();
    expect(logged.join("\n")).not.toContain("invite-token");
  });

  test("sends a batch as one SMTP message per recipient", async () => {
    trap.reset();
    useMailEnv(configuredProduction());

    await runMailer((mailer) =>
      mailer.batch([
        invitation,
        { ...invitation, to: ["second@example.test"] },
      ]),
    );

    expect(trap.messages.map((message) => message.recipients)).toEqual([
      ["invitee@example.test"],
      ["second@example.test"],
    ]);
    expect(trap.messages.every((message) => message.from === SENDER)).toBe(
      true,
    );
  });

  test("skips the marketing audience when Resend is not configured", async () => {
    useMailEnv(configuredProduction());
    const originalFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      return Response.json({});
    }) as unknown as typeof fetch;

    try {
      await runMailer((mailer) =>
        mailer.createContact({ email: "person@example.test" }),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requests).toBe(0);
  });
});
