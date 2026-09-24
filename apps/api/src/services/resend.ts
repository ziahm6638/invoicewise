import { Resend } from "resend";

let client: Resend | undefined;

/**
 * The provider client is created on first use. Transactional mail in a local
 * or test journey is captured by the explicit mail sink, and importing that
 * path must not require a provider key or dial anything.
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
