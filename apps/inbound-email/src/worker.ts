/**
 * Cloudflare Email Worker for the workspaces' dedicated addresses
 * (`<local part>@in.invoicewise.uk`). Email Routing hands it every message
 * for the receiving subdomain, one invocation per envelope recipient.
 *
 * It does not parse, route or store mail. It signs the envelope and the exact
 * raw message with INBOUND_EMAIL_SECRET and posts them to the InvoiceWise
 * API, which owns the address mapping, deduplication and processing. The
 * API's answer decides the SMTP outcome (docs/inbound-email.md):
 *
 * - 2xx: the message is committed; Cloudflare accepts it.
 * - 404 / 413 / 400: refused permanently with `setReject`, so the sending
 *   server reports it to its own user. InvoiceWise never sends a bounce or
 *   reply itself, so there is no loop.
 * - anything else (401, 5xx, a network error): retried here, then the
 *   invocation throws so the delivery fails temporarily and the sending
 *   server retries it later instead of the message being lost.
 */

/** Cloudflare's ForwardableEmailMessage, reduced to what this Worker uses. */
export interface InboundMessage {
  readonly from: string;
  readonly to: string;
  readonly raw: ReadableStream<Uint8Array>;
  readonly rawSize: number;
  setReject(reason: string): void;
}

export interface Env {
  /** Shared with the API; set with `wrangler secret put`. */
  INBOUND_EMAIL_SECRET?: string;
  /** `https://api.invoicewise.uk/inbound/email` (wrangler.toml). */
  INBOUND_EMAIL_ENDPOINT?: string;
}

/** Matches INBOUND_EMAIL_LIMITS.maxMessageBytes in @invoicewise/jobs. */
export const MAX_MESSAGE_BYTES = 20 * 1024 * 1024;

export const DELIVERY_ATTEMPTS = 3;
const ATTEMPT_TIMEOUT_MS = 20_000;
const RETRY_DELAYS_MS = [1_000, 4_000];

export const REJECTIONS = {
  unknownRecipient: "550 5.1.1 Unknown recipient",
  tooLarge: `552 5.3.4 Message exceeds ${MAX_MESSAGE_BYTES} bytes`,
  refused: "550 5.6.0 Message refused",
} as const;

const HEADERS = {
  timestamp: "x-invoicewise-inbound-timestamp",
  recipient: "x-invoicewise-inbound-recipient",
  sender: "x-invoicewise-inbound-sender",
  signature: "x-invoicewise-inbound-signature",
} as const;

const hex = (buffer: ArrayBuffer) =>
  [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

export async function signInbound(
  secret: string,
  input: {
    timestamp: string;
    recipient: string;
    sender: string;
    bodySha256: string;
  },
) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const payload = [
    "v1",
    input.timestamp,
    input.recipient,
    input.sender,
    input.bodySha256,
  ].join("\n");
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload),
  );
  return `v1=${hex(mac)}`;
}

export type WorkerDeps = {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

const defaultDeps: WorkerDeps = {
  fetch: (url, init) => fetch(url, init),
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const log = (event: string, fields: Record<string, unknown>) =>
  console.log(JSON.stringify({ event, ...fields }));

export async function handleEmail(
  message: InboundMessage,
  env: Env,
  deps: WorkerDeps = defaultDeps,
): Promise<void> {
  const secret = env.INBOUND_EMAIL_SECRET?.trim();
  const endpoint = env.INBOUND_EMAIL_ENDPOINT?.trim();
  if (!secret || !endpoint) {
    // Misconfiguration must never turn into a permanent loss.
    throw new Error("inbound email worker is not configured");
  }

  if (message.rawSize > MAX_MESSAGE_BYTES) {
    log("inbound_email_rejected", {
      reason: "too_large",
      size: message.rawSize,
    });
    message.setReject(REJECTIONS.tooLarge);
    return;
  }

  const body = new Uint8Array(await new Response(message.raw).arrayBuffer());
  if (body.byteLength > MAX_MESSAGE_BYTES) {
    log("inbound_email_rejected", {
      reason: "too_large",
      size: body.byteLength,
    });
    message.setReject(REJECTIONS.tooLarge);
    return;
  }

  // Envelope addresses may be SMTPUTF8, which is not a valid header value.
  const recipient = encodeURIComponent(message.to);
  const sender = encodeURIComponent(message.from ?? "");
  const bodySha256 = hex(await crypto.subtle.digest("SHA-256", body));

  let lastFailure = "no attempt made";
  for (let attempt = 1; attempt <= DELIVERY_ATTEMPTS; attempt++) {
    const timestamp = String(Math.floor(deps.now() / 1000));
    const signature = await signInbound(secret, {
      timestamp,
      recipient,
      sender,
      bodySha256,
    });

    let response: Response;
    try {
      response = await deps.fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "message/rfc822",
          [HEADERS.timestamp]: timestamp,
          [HEADERS.recipient]: recipient,
          [HEADERS.sender]: sender,
          [HEADERS.signature]: signature,
        },
        body,
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      });
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
      log("inbound_email_attempt_failed", { attempt, failure: lastFailure });
      if (attempt < DELIVERY_ATTEMPTS) {
        await deps.sleep(RETRY_DELAYS_MS[attempt - 1] ?? 4_000);
      }
      continue;
    }

    await response.body?.cancel().catch(() => undefined);

    if (response.ok) {
      log("inbound_email_accepted", { status: response.status, attempt });
      return;
    }
    if (response.status === 404) {
      log("inbound_email_rejected", { reason: "unknown_recipient" });
      message.setReject(REJECTIONS.unknownRecipient);
      return;
    }
    if (response.status === 413) {
      log("inbound_email_rejected", { reason: "too_large" });
      message.setReject(REJECTIONS.tooLarge);
      return;
    }
    if (response.status === 400) {
      log("inbound_email_rejected", { reason: "refused" });
      message.setReject(REJECTIONS.refused);
      return;
    }

    lastFailure = `HTTP ${response.status}`;
    log("inbound_email_attempt_failed", { attempt, failure: lastFailure });
    if (attempt < DELIVERY_ATTEMPTS) {
      await deps.sleep(RETRY_DELAYS_MS[attempt - 1] ?? 4_000);
    }
  }

  // Temporary failure: the sending server keeps the message and retries.
  throw new Error(`InvoiceWise did not accept the message (${lastFailure})`);
}

export default {
  async email(message: InboundMessage, env: Env) {
    await handleEmail(message, env);
  },
};
