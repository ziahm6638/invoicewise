import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Shared transactional-mail policy for the API (Better Auth identity mail) and
 * the workflow queue (invitation and onboarding mail).
 *
 * Transactional messages carry bearer tokens, so the policy is deliberately
 * fail-closed: production refuses to start without a usable sender, and a
 * token-bearing link is never written to a log or a file there. Local journeys
 * use an explicit sink file instead of a provider.
 */
export type MailSinkRecord = {
  to: string;
  subject: string;
  at: string;
  [key: string]: unknown;
};

/**
 * The committed development placeholder. It is not a deliverable sender, so
 * production refuses it and local development treats it as "no provider".
 */
export const DEVELOPMENT_PLACEHOLDER_API_KEY = "re_local_development";

const readEnv = (env: NodeJS.ProcessEnv, key: string) =>
  (env[key] ?? "").trim();

export const isProductionEnv = (env: NodeJS.ProcessEnv = process.env) =>
  env.NODE_ENV === "production";

/** The configured sender, or null when the environment does not set one. */
export const resolveMailSender = (env: NodeJS.ProcessEnv = process.env) =>
  readEnv(env, "AUTH_EMAIL_FROM") || null;

/**
 * The provider key, or null when mail must not be sent: a missing key and the
 * committed development placeholder both mean "not configured".
 */
export const resolveProviderApiKey = (env: NodeJS.ProcessEnv = process.env) => {
  const key = readEnv(env, "RESEND_API_KEY");

  return !key || key === DEVELOPMENT_PLACEHOLDER_API_KEY ? null : key;
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
 * Presence check only. Usability against the real provider is owner-gated
 * evidence, so verification uses the loopback provider seam with explicit
 * synthetic values rather than contacting Resend.
 */
export function assertTransactionalMailConfigured(
  env: NodeJS.ProcessEnv = process.env,
) {
  if (!resolveProviderApiKey(env) || !resolveMailSender(env)) {
    throw new Error(
      "Transactional email is not configured: RESEND_API_KEY (not the local development placeholder) and AUTH_EMAIL_FROM are required in production",
    );
  }
}

/** Appends one JSONL record for the local mail sink, creating its directory. */
export async function writeMailSinkRecord(
  sinkPath: string,
  record: MailSinkRecord,
) {
  await mkdir(dirname(sinkPath), { recursive: true });
  await appendFile(sinkPath, `${JSON.stringify(record)}\n`);
}
