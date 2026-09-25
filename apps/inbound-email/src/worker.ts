/**
 * Wrangler entry (`main` in wrangler.toml). The Workers runtime treats every
 * named export of this module as an entrypoint, so it exports only the
 * default handler; the logic and its constants live in ./handler.
 */
import { type Env, type InboundMessage, handleEmail } from "./handler";

export default {
  async email(message: InboundMessage, env: Env) {
    await handleEmail(message, env);
  },
};
