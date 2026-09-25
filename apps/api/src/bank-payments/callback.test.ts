import { describe, expect, test } from "bun:test";
import { createSign, generateKeyPairSync } from "node:crypto";
import type { Database } from "@invoicewise/db/client";
import { handleSaltEdgeCallbackRequest } from "./callback";

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const other = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const BASE = "https://api.invoicewise.test/webhooks/saltedge";
const env = {
  BANK_PAYMENTS_ENABLED: "true",
  SALT_EDGE_APP_ID: "app",
  SALT_EDGE_SECRET: "secret",
  SALT_EDGE_CALLBACK_URL: BASE,
  SALT_EDGE_CALLBACK_PUBLIC_KEY: publicKey,
};

const sign = (key: string, value: string) => {
  const signer = createSign("SHA256");
  signer.update(value);
  signer.end();
  return signer.sign(key, "base64");
};

// Any database use means the request got past verification.
const db = new Proxy(
  {},
  {
    get() {
      throw new Error("the database must not be reached");
    },
  },
) as unknown as Database;

const request = (body: string, signature?: string) =>
  new Request(`${BASE}/service`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(signature ? { signature } : {}),
    },
    body,
  });

describe("Salt Edge callbacks", () => {
  const body = JSON.stringify({
    data: { connection_id: "1", customer_id: "2" },
  });

  test("a correctly signed callback is accepted", async () => {
    const response = await handleSaltEdgeCallbackRequest(
      request(body, sign(privateKey, `${BASE}/service|${body}`)),
      "service",
      { db, env },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", outcome: "ignored" });
  });

  test("unsigned, mis-signed, re-targeted or altered callbacks are refused", async () => {
    const cases = [
      request(body),
      request(body, sign(other.privateKey, `${BASE}/service|${body}`)),
      // Signed for another callback type's URL.
      request(body, sign(privateKey, `${BASE}/success|${body}`)),
      // The body changed after signing.
      request(
        body.replace('"1"', '"9"'),
        sign(privateKey, `${BASE}/service|${body}`),
      ),
    ];
    for (const item of cases) {
      const response = await handleSaltEdgeCallbackRequest(item, "service", {
        db,
        env,
      });
      expect(response.status).toBe(401);
    }
  });

  test("nothing is answered when bank payments are off or the type is unknown", async () => {
    const signed = () =>
      request(body, sign(privateKey, `${BASE}/service|${body}`));
    for (const [type, settings] of [
      ["service", { ...env, BANK_PAYMENTS_ENABLED: "false" }],
      ["service", { ...env, SALT_EDGE_CALLBACK_URL: "" }],
      ["unknown", env],
    ] as const) {
      const response = await handleSaltEdgeCallbackRequest(signed(), type, {
        db,
        env: settings,
      });
      expect(response.status).toBe(404);
    }
  });
});
