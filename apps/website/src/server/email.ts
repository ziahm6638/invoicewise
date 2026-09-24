import "server-only";
import nodemailer from "nodemailer";

const SITE_URL = "https://invoicewise.uk";

const COMPANY_LINES = [
  "Sortx Software Ltd",
  "Company number 17132612",
  "Registered office: Flat 9 Lowood House, Bewley Street, London, E1 0BT, England",
  "hello@invoicewise.uk",
].join("\n");

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

/** No send may outlive a serverless invocation, so every stage is bounded. */
const SMTP_TIMEOUT_MS = 8000;

function createTransport() {
  const port = Number(process.env.SMTP_PORT ?? "465");

  return nodemailer.createTransport({
    host: process.env.SMTP_HOST ?? "smtp.purelymail.com",
    port,
    secure: port === 465,
    auth: {
      user: requireEnv("SMTP_USER"),
      pass: requireEnv("SMTP_PASS"),
    },
    connectionTimeout: SMTP_TIMEOUT_MS,
    greetingTimeout: SMTP_TIMEOUT_MS,
    socketTimeout: SMTP_TIMEOUT_MS,
  });
}

function mailFrom(): string {
  return process.env.MAIL_FROM ?? "InvoiceWise <hello@invoicewise.uk>";
}

export interface LeadNotification {
  email: string;
  source: string;
  product: string;
  createdAt?: string | null;
  userAgent?: string | null;
  ipHash?: string | null;
}

export async function sendConfirmationEmail(lead: {
  email: string;
}): Promise<void> {
  const notifyTo = requireEnv("MAIL_NOTIFY_TO");
  const transport = createTransport();

  const body = [
    "Thanks for joining the InvoiceWise waitlist.",
    "",
    "InvoiceWise is invoice middleware: upload an invoice and get typed,",
    "structured data back, with TypeSafe extraction and judgments. A dedicated",
    "inbound mailbox and delivery to Xero and QuickBooks are coming. We will",
    "email you when early access opens.",
    "",
    `You can find out more at ${SITE_URL}`,
    "",
    "Reply to this email if you would like to talk it through with us -",
    "a real reply is the fastest way to reach the team.",
    "",
    COMPANY_LINES,
  ].join("\n");

  await transport.sendMail({
    from: mailFrom(),
    to: lead.email,
    replyTo: notifyTo,
    subject: "You're on the InvoiceWise waitlist",
    text: body,
  });
}

export async function sendNotificationEmail(
  lead: LeadNotification,
): Promise<void> {
  const notifyTo = requireEnv("MAIL_NOTIFY_TO");
  const transport = createTransport();

  const body = [
    `New InvoiceWise lead (${lead.source})`,
    "",
    `Email:      ${lead.email}`,
    `Product:    ${lead.product}`,
    `Source:     ${lead.source}`,
    lead.createdAt ? `Received:   ${lead.createdAt}` : null,
    `User agent: ${lead.userAgent ?? "(unknown)"}`,
    `IP hash:    ${lead.ipHash ?? "(unknown)"}`,
    "",
    COMPANY_LINES,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  await transport.sendMail({
    from: mailFrom(),
    to: notifyTo,
    replyTo: lead.email,
    subject: `New InvoiceWise waitlist lead: ${lead.email}`,
    text: body,
  });
}
