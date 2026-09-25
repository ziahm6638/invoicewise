import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { InboxQueryDatabase } from "@invoicewise/db/queries";
import {
  INBOUND_EMAIL_LIMITS,
  acceptInboundEmail,
} from "@invoicewise/jobs/inbound-email";

/**
 * Receiving endpoint for the Cloudflare Email Worker (apps/inbound-email).
 *
 * The request is authenticated by an HMAC over the envelope and the exact
 * body, keyed with INBOUND_EMAIL_SECRET, which only the Worker and the API
 * hold. Nothing about the network path is trusted: behind the Cloudflare
 * Tunnel and kamal-proxy any client address or forwarded-for header can be
 * supplied by the caller. See docs/inbound-email.md for the full contract.
 */
export const INBOUND_HEADERS = {
  timestamp: "x-invoicewise-inbound-timestamp",
  recipient: "x-invoicewise-inbound-recipient",
  sender: "x-invoicewise-inbound-sender",
  signature: "x-invoicewise-inbound-signature",
} as const;

/** A signed request older or newer than this is refused. */
export const INBOUND_SIGNATURE_TOLERANCE_SECONDS = 300;

/** The exact string both sides sign. */
export const inboundSignaturePayload = (input: {
  timestamp: string;
  recipient: string;
  sender: string;
  bodySha256: string;
}) =>
  ["v1", input.timestamp, input.recipient, input.sender, input.bodySha256].join(
    "\n",
  );

export const signInboundRequest = (
  secret: string,
  input: Parameters<typeof inboundSignaturePayload>[0],
) =>
  `v1=${createHmac("sha256", secret).update(inboundSignaturePayload(input)).digest("hex")}`;

export type InboundEmailHttpDeps = {
  db: InboxQueryDatabase;
  /** Unset means the endpoint refuses everything (fails closed). */
  secret: string | undefined;
  domain: string;
  now?: () => number;
  /** Test seam; defaults to the real acceptance transaction. */
  accept?: typeof acceptInboundEmail;
};

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const safeEqual = (left: string, right: string) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
};

/** Reads the body with a real byte bound, whatever content-length claims. */
async function readBoundedBody(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array | "too_large" | "unreadable"> {
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return "too_large";
      }
      chunks.push(value);
    }
  } catch {
    return "unreadable";
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/**
 * Status codes are the Worker's instructions: 202 accept the message; 404,
 * 413 and 400 refuse it permanently at SMTP time (the sending server reports
 * it to its own user, so nothing here can bounce in a loop); 401, 411 and 503
 * are temporary, so a misconfigured secret or an outage never loses mail.
 *
 * Nothing is buffered before the cheap checks pass: a well-formed signature
 * header and a declared length within the limit (the Worker always sends a
 * fixed-length body). The HMAC over the exact body is still the only proof.
 */
export async function handleInboundEmail(
  request: Request,
  deps: InboundEmailHttpDeps,
): Promise<Response> {
  if (!deps.secret) {
    return json(
      { error: "Inbound email is not configured", code: "not_configured" },
      503,
    );
  }

  const timestamp = request.headers.get(INBOUND_HEADERS.timestamp) ?? "";
  const recipient = request.headers.get(INBOUND_HEADERS.recipient) ?? "";
  const sender = request.headers.get(INBOUND_HEADERS.sender) ?? "";
  const signature = request.headers.get(INBOUND_HEADERS.signature) ?? "";
  const nowSeconds = Math.floor((deps.now?.() ?? Date.now()) / 1000);
  const signedAt = /^\d{1,12}$/.test(timestamp)
    ? Number(timestamp)
    : Number.NaN;

  if (
    !recipient ||
    !/^v1=[0-9a-f]{64}$/.test(signature) ||
    !Number.isFinite(signedAt) ||
    Math.abs(nowSeconds - signedAt) > INBOUND_SIGNATURE_TOLERANCE_SECONDS
  ) {
    return json({ error: "Unauthorized", code: "unauthorized" }, 401);
  }

  const declaredLength = request.headers.get("content-length") ?? "";
  if (!/^\d{1,12}$/.test(declaredLength)) {
    return json(
      { error: "A content-length is required", code: "length_required" },
      411,
    );
  }
  if (Number(declaredLength) > INBOUND_EMAIL_LIMITS.maxMessageBytes) {
    return json({ error: "Message too large", code: "too_large" }, 413);
  }

  const body = await readBoundedBody(
    request,
    INBOUND_EMAIL_LIMITS.maxMessageBytes,
  );
  if (body === "too_large") {
    return json({ error: "Message too large", code: "too_large" }, 413);
  }
  if (body === "unreadable") {
    return json(
      { error: "The message body could not be read", code: "unreadable" },
      503,
    );
  }

  const expected = signInboundRequest(deps.secret, {
    timestamp,
    recipient,
    sender,
    bodySha256: createHash("sha256").update(body).digest("hex"),
  });
  if (!safeEqual(signature, expected)) {
    return json({ error: "Unauthorized", code: "unauthorized" }, 401);
  }

  // Envelope addresses travel percent-encoded (an SMTPUTF8 address is not a
  // valid header value); the signature covers the encoded form.
  const decode = (value: string) => {
    try {
      return decodeURIComponent(value);
    } catch {
      return null;
    }
  };
  const envelopeRecipient = decode(recipient);
  const envelopeSender = decode(sender);
  if (envelopeRecipient === null) {
    return json({ error: "Unknown recipient", code: "unknown_recipient" }, 404);
  }

  try {
    const result = await (deps.accept ?? acceptInboundEmail)(deps.db, {
      recipient: envelopeRecipient,
      sender: envelopeSender || null,
      raw: body,
      domain: deps.domain,
    });
    if (result.status === "rejected") {
      const status =
        result.code === "unknown_recipient"
          ? 404
          : result.code === "too_large"
            ? 413
            : 400;
      return json({ error: result.message, code: result.code }, status);
    }
    return json(
      {
        status: "accepted",
        id: result.id,
        deduplicated: result.deduplicated,
      },
      202,
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "inbound_email_accept_failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return json(
      {
        error: "The message could not be stored; retry the delivery",
        code: "temporarily_unavailable",
      },
      503,
    );
  }
}
