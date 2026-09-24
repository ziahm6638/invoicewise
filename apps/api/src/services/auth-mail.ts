import {
  assertTransactionalMailConfigured,
  isProductionEnv,
  resolveMailSender,
  resolveMailSinkPath,
  resolveProviderApiKey,
  writeMailSinkRecord,
} from "@invoicewise/utils/transactional-mail";
import { resend } from "./resend";

/**
 * Transactional mail for the identity lifecycle (verification, invitations,
 * password reset and email change).
 *
 * A verification link carries a bearer token, so the delivery path is
 * fail-closed: production refuses to start without usable sender
 * configuration and never writes a token-bearing URL to a log or a file. Local
 * journeys use the opt-in file sink (`AUTH_MAIL_SINK_PATH`) instead, which
 * captures the real message without contacting a provider.
 */
export type TransactionalMail = {
  to: string;
  subject: string;
  url: string;
};

export type MailTransport = "sink" | "provider" | "log";

export const isProduction = isProductionEnv;
export const mailSinkPath = resolveMailSinkPath;
export { assertTransactionalMailConfigured };

async function sendViaProvider(
  message: TransactionalMail,
  env: NodeJS.ProcessEnv,
) {
  const { error } = await resend.emails.send({
    from: resolveMailSender(env) ?? "",
    to: message.to,
    subject: message.subject,
    text: `${message.subject}: ${message.url}`,
    html: `<p><a href="${message.url.replaceAll("&", "&amp;")}">${message.subject}</a></p>`,
  });

  if (error) {
    throw new Error(error.message);
  }
}

export async function deliverTransactionalMail(
  message: TransactionalMail,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ transport: MailTransport }> {
  const sink = mailSinkPath(env);

  if (sink) {
    await writeMailSinkRecord(sink, {
      ...message,
      at: new Date().toISOString(),
    });
    return { transport: "sink" };
  }

  if (isProduction(env)) {
    assertTransactionalMailConfigured(env);
    await sendViaProvider(message, env);
    return { transport: "provider" };
  }

  const providerKey = resolveProviderApiKey(env);

  if (providerKey) {
    await sendViaProvider(message, env);
    return { transport: "provider" };
  }

  // No provider and no sink: record that a message exists without printing the
  // token-bearing link.
  console.info(
    `[auth-mail] ${message.subject} for ${message.to} (link withheld; set AUTH_MAIL_SINK_PATH to capture local mail)`,
  );
  return { transport: "log" };
}
