import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import nodemailer, { type Transporter } from "nodemailer";

/**
 * Shared transactional-mail policy for the API (Better Auth identity mail and
 * the other product notifications) and the workflow queue (invitation and
 * onboarding mail).
 *
 * Transactional mail goes through Purelymail over SMTP. The messages carry
 * bearer tokens, so the policy is deliberately fail-closed: production refuses
 * to start without SMTP credentials and a sender, and a token-bearing link is
 * never written to a log or a file there. Local journeys use an explicit sink
 * file instead of a mail server.
 */
export type MailSinkRecord = {
  to: string;
  subject: string;
  at: string;
  [key: string]: unknown;
};

export type SmtpConfig = {
  host: string;
  port: number;
  /** Implicit TLS. Purelymail's submission port 465 expects it. */
  secure: boolean;
  user: string;
  pass: string;
};

export type TransactionalMessage = {
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
  headers?: Record<string, string>;
};

export const DEFAULT_SMTP_HOST = "smtp.purelymail.com";
export const DEFAULT_SMTP_PORT = 465;

const SMTP_TIMEOUT_MS = 10_000;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

const readEnv = (env: NodeJS.ProcessEnv, key: string) =>
  (env[key] ?? "").trim();

export const isProductionEnv = (env: NodeJS.ProcessEnv = process.env) =>
  env.NODE_ENV === "production";

/** The configured sender, or null when the environment does not set one. */
export const resolveMailSender = (env: NodeJS.ProcessEnv = process.env) =>
  readEnv(env, "AUTH_EMAIL_FROM") || null;

/**
 * The SMTP submission settings, or null when mail must not be sent: without
 * both SMTP_USER and SMTP_PASS there is no usable account.
 */
export const resolveSmtpConfig = (
  env: NodeJS.ProcessEnv = process.env,
): SmtpConfig | null => {
  const user = readEnv(env, "SMTP_USER");
  const pass = readEnv(env, "SMTP_PASS");

  if (!user || !pass) {
    return null;
  }

  const port = Number(readEnv(env, "SMTP_PORT") || DEFAULT_SMTP_PORT);
  const resolvedPort =
    Number.isInteger(port) && port > 0 ? port : DEFAULT_SMTP_PORT;

  return {
    host: readEnv(env, "SMTP_HOST") || DEFAULT_SMTP_HOST,
    port: resolvedPort,
    secure: resolvedPort === 465,
    user,
    pass,
  };
};

/**
 * Explicit local capture. Only honoured outside production: a production
 * process must never persist a reset or verification token to disk.
 */
export const resolveMailSinkPath = (
  env: NodeJS.ProcessEnv = process.env,
): string | null =>
  isProductionEnv(env) ? null : readEnv(env, "AUTH_MAIL_SINK_PATH") || null;

/**
 * Presence check only. Usability against Purelymail is owner-gated evidence,
 * so verification points SMTP_HOST at a loopback SMTP trap with explicit
 * synthetic credentials rather than contacting the real server.
 */
export function assertTransactionalMailConfigured(
  env: NodeJS.ProcessEnv = process.env,
) {
  if (!resolveSmtpConfig(env) || !resolveMailSender(env)) {
    throw new Error(
      "Transactional email is not configured: SMTP_USER, SMTP_PASS and AUTH_EMAIL_FROM are required in production",
    );
  }
}

const transports = new Map<string, Transporter>();

/** One transport per distinct configuration; each send opens its own session. */
function transportFor(config: SmtpConfig): Transporter {
  const key = JSON.stringify([
    config.host,
    config.port,
    config.user,
    config.pass,
  ]);
  let transport = transports.get(key);

  if (!transport) {
    transport = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      // Without implicit TLS, refuse to send credentials unless STARTTLS
      // succeeds; only a loopback test server may be spoken to in plaintext.
      requireTLS: !config.secure && !LOOPBACK_HOSTS.has(config.host),
      auth: { user: config.user, pass: config.pass },
      connectionTimeout: SMTP_TIMEOUT_MS,
      greetingTimeout: SMTP_TIMEOUT_MS,
      socketTimeout: SMTP_TIMEOUT_MS,
    });
    transports.set(key, transport);
  }

  return transport;
}

/**
 * Sends one message through the configured SMTP account. AUTH_EMAIL_FROM is
 * always the sender: Purelymail only relays for its own addresses, so a
 * template's own `from` is never used.
 */
export async function sendTransactionalSmtp(
  message: TransactionalMessage,
  env: NodeJS.ProcessEnv = process.env,
) {
  const config = resolveSmtpConfig(env);
  const sender = resolveMailSender(env);

  if (!config || !sender) {
    throw new Error(
      "Transactional email is not configured: SMTP_USER, SMTP_PASS and AUTH_EMAIL_FROM are required to send",
    );
  }

  await transportFor(config).sendMail({
    from: sender,
    to: message.to,
    subject: message.subject,
    html: message.html,
    text: message.text,
    headers: message.headers,
  });
}

/** Appends one JSONL record for the local mail sink, creating its directory. */
export async function writeMailSinkRecord(
  sinkPath: string,
  record: MailSinkRecord,
) {
  await mkdir(dirname(sinkPath), { recursive: true });
  await appendFile(sinkPath, `${JSON.stringify(record)}\n`);
}
