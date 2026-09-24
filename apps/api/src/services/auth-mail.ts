import {
  assertTransactionalMailConfigured,
  isProductionEnv,
  resolveMailSinkPath,
} from "@invoicewise/utils/transactional-mail";
import { type MailTransport, deliverMail } from "./mail";

/**
 * Transactional mail for the identity lifecycle (verification, invitations,
 * password reset and email change).
 *
 * A verification link carries a bearer token, so the delivery path is
 * fail-closed: production refuses to start without SMTP credentials and a
 * sender and never writes a token-bearing URL to a log or a file. Local
 * journeys use the opt-in file sink (`AUTH_MAIL_SINK_PATH`) instead, which
 * captures the real message without contacting a mail server.
 */
export type TransactionalMail = {
  to: string;
  subject: string;
  url: string;
};

export type { MailTransport };

export const isProduction = isProductionEnv;
export const mailSinkPath = resolveMailSinkPath;
export { assertTransactionalMailConfigured };

export async function deliverTransactionalMail(
  message: TransactionalMail,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ transport: MailTransport }> {
  return deliverMail(
    {
      to: message.to,
      subject: message.subject,
      text: `${message.subject}: ${message.url}`,
      html: `<p><a href="${message.url.replaceAll("&", "&amp;")}">${message.subject}</a></p>`,
    },
    { env, sinkRecord: message, label: "auth-mail" },
  );
}
