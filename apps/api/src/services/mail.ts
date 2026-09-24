import {
  type TransactionalMessage,
  assertTransactionalMailConfigured,
  isProductionEnv,
  resolveMailSender,
  resolveMailSinkPath,
  resolveSmtpConfig,
  sendTransactionalSmtp,
  writeMailSinkRecord,
} from "@invoicewise/utils/transactional-mail";

/**
 * The one delivery path for mail the API sends: Better Auth identity mail and
 * product notifications (API keys, OAuth applications, inbox forwarding).
 *
 * Mail goes through Purelymail over SMTP with AUTH_EMAIL_FROM as the sender.
 * Production is fail-closed: it requires SMTP credentials and a sender and
 * never captures or logs message content. Outside production, the opt-in file
 * sink (`AUTH_MAIL_SINK_PATH`) wins, then SMTP when it is configured, and
 * otherwise only the subject and recipient are logged.
 */
export type { TransactionalMessage };

export type MailTransport = "sink" | "smtp" | "log";

export type DeliverMailOptions = {
  env?: NodeJS.ProcessEnv;
  /** The record written to the local sink; defaults to the full message. */
  sinkRecord?: { to: string; subject: string; [key: string]: unknown };
  /** Prefix for the local log line. */
  label?: string;
};

const recipientsOf = (to: TransactionalMessage["to"]) =>
  Array.isArray(to) ? to.join(",") : to;

export async function deliverMail(
  message: TransactionalMessage,
  options: DeliverMailOptions = {},
): Promise<{ transport: MailTransport }> {
  const env = options.env ?? process.env;
  const sink = resolveMailSinkPath(env);

  if (sink) {
    await writeMailSinkRecord(sink, {
      ...(options.sinkRecord ?? {
        to: recipientsOf(message.to),
        from: resolveMailSender(env),
        subject: message.subject,
        html: message.html ?? null,
        text: message.text ?? null,
      }),
      at: new Date().toISOString(),
    });
    return { transport: "sink" };
  }

  if (isProductionEnv(env)) {
    assertTransactionalMailConfigured(env);
    await sendTransactionalSmtp(message, env);
    return { transport: "smtp" };
  }

  if (resolveSmtpConfig(env)) {
    await sendTransactionalSmtp(message, env);
    return { transport: "smtp" };
  }

  // No SMTP account and no sink: record that a message exists without
  // printing its content, which may carry a token-bearing link.
  console.info(
    `[${options.label ?? "mail"}] ${message.subject} for ${recipientsOf(message.to)} (content withheld; set AUTH_MAIL_SINK_PATH to capture local mail)`,
  );
  return { transport: "log" };
}
