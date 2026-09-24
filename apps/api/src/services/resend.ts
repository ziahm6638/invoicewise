import { Resend } from "resend";

let client: Resend | undefined;

/**
 * Resend is only used for the optional marketing audience (contact removal on
 * account deletion); transactional mail goes through `./mail` over SMTP. The
 * client is created on first use, so importing this module never requires a
 * key or dials anything.
 */
function getClient(): Resend {
  if (!client) {
    client = new Resend(process.env.RESEND_API_KEY);
  }

  return client;
}

export const resend = new Proxy({} as Resend, {
  get: (_target, property) => getClient()[property as keyof Resend],
});
