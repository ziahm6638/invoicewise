import { readBoundedBody } from "@api/intake/http";
import type { Database } from "@invoicewise/db/client";
import {
  type SaltEdgeCallbackType,
  handleSaltEdgeCallback,
} from "@invoicewise/jobs/bank-feeds";
import {
  SALT_EDGE_CALLBACK_PUBLIC_KEY_V6,
  bankPaymentsAvailability,
  verifySaltEdgeCallback,
} from "@invoicewise/jobs/salt-edge";

const TYPES = new Set<SaltEdgeCallbackType>([
  "success",
  "fail",
  "notify",
  "destroy",
  "service",
]);

const MAX_CALLBACK_BYTES = 64 * 1024;

const json = (status: number, body: Record<string, unknown>) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

/**
 * `POST /webhooks/saltedge/:type`: a Salt Edge callback. Each type is
 * registered with Salt Edge at `${SALT_EDGE_CALLBACK_URL}/<type>`, and Salt
 * Edge signs `<that URL>|<raw body>` with its private key; an unsigned or
 * mis-signed request is refused before anything is read from it. The
 * workspace is the one whose own Salt Edge customer the callback names.
 */
export async function handleSaltEdgeCallbackRequest(
  request: Request,
  type: string,
  deps: { db: Database; env?: NodeJS.ProcessEnv },
) {
  const env = deps.env ?? process.env;
  const base = env.SALT_EDGE_CALLBACK_URL?.trim().replace(/\/+$/, "");
  if (
    !TYPES.has(type as SaltEdgeCallbackType) ||
    !base ||
    !bankPaymentsAvailability(env).available
  ) {
    return json(404, { error: "Not found" });
  }
  const read = await readBoundedBody(request, MAX_CALLBACK_BYTES);
  if (!read.ok) return json(413, { error: read.message });
  const body = new TextDecoder().decode(read.bytes);
  const verified = verifySaltEdgeCallback({
    publicKeyPem:
      env.SALT_EDGE_CALLBACK_PUBLIC_KEY?.replace(/\\n/g, "\n").trim() ||
      SALT_EDGE_CALLBACK_PUBLIC_KEY_V6,
    callbackUrl: `${base}/${type}`,
    body,
    signature: request.headers.get("signature") ?? "",
  });
  if (!verified) return json(401, { error: "Invalid signature" });
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return json(400, { error: "Invalid JSON" });
  }
  const result = await handleSaltEdgeCallback(deps.db, {
    type: type as SaltEdgeCallbackType,
    payload,
  });
  return json(200, { status: "ok", outcome: result.outcome });
}
