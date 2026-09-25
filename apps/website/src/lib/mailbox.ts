/**
 * Whether the dedicated inbound mailbox is advertised as available. Off until
 * the Cloudflare receiving setup and its live proof pass
 * (docs/inbound-email.md); read on the server only.
 */
export const mailboxLive = () =>
  process.env.INBOUND_EMAIL_LIVE?.trim().toLowerCase() === "true";
