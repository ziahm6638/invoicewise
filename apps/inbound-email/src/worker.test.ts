import { describe, expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import {
  DELIVERY_ATTEMPTS,
  type Env,
  type InboundMessage,
  MAX_MESSAGE_BYTES,
  REJECTIONS,
  type WorkerDeps,
  handleEmail,
} from "./worker";

const TEST_SECRET = "test-inbound-secret";

const env: Env = {
  INBOUND_EMAIL_SECRET: TEST_SECRET,
  INBOUND_EMAIL_ENDPOINT: "https://api.example.test/inbound/email",
};

const RAW =
  "From: Supplier <billing@supplier.example>\r\nTo: abc@in.invoicewise.uk\r\nSubject: Invoice\r\nMessage-ID: <m1@supplier.example>\r\n\r\nHello\r\n";

function message(overrides: Partial<InboundMessage> = {}) {
  const rejections: string[] = [];
  const bytes = new TextEncoder().encode(RAW);
  const value: InboundMessage = {
    from: "billing@supplier.example",
    to: "abcdefghjkmnpqrs@in.invoicewise.uk",
    raw: new Response(bytes).body!,
    rawSize: bytes.byteLength,
    setReject: (reason) => rejections.push(reason),
    ...overrides,
  };
  return { value, rejections };
}

function deps(responses: Array<Response | Error>) {
  const requests: { url: string; init: RequestInit }[] = [];
  const sleeps: number[] = [];
  const value: WorkerDeps = {
    fetch: async (url, init) => {
      requests.push({ url, init });
      const next = responses.shift();
      if (!next) throw new Error("unexpected request");
      if (next instanceof Error) throw next;
      return next;
    },
    now: () => 1_790_000_000_000,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
  return { value, requests, sleeps };
}

const status = (code: number) => new Response(null, { status: code });

describe("inbound email worker", () => {
  test("signs the envelope and exact body and lets an accepted message through", async () => {
    const mail = message();
    const http = deps([status(202)]);

    await handleEmail(mail.value, env, http.value);

    expect(mail.rejections).toEqual([]);
    expect(http.requests).toHaveLength(1);
    const { url, init } = http.requests[0]!;
    expect(url).toBe(env.INBOUND_EMAIL_ENDPOINT!);
    const headers = init.headers as Record<string, string>;
    const body = init.body as Uint8Array;
    expect(new TextDecoder().decode(body)).toBe(RAW);

    // The API verifies exactly this construction (apps/api/src/inbound-email/http.ts).
    const expected = createHmac("sha256", env.INBOUND_EMAIL_SECRET!)
      .update(
        [
          "v1",
          "1790000000",
          encodeURIComponent("abcdefghjkmnpqrs@in.invoicewise.uk"),
          encodeURIComponent("billing@supplier.example"),
          createHash("sha256").update(body).digest("hex"),
        ].join("\n"),
      )
      .digest("hex");
    expect(headers["x-invoicewise-inbound-signature"]).toBe(`v1=${expected}`);
    expect(headers["x-invoicewise-inbound-timestamp"]).toBe("1790000000");
  });

  test("refuses an unknown recipient permanently, once", async () => {
    const mail = message();
    const http = deps([status(404)]);
    await handleEmail(mail.value, env, http.value);
    expect(mail.rejections).toEqual([REJECTIONS.unknownRecipient]);
    expect(http.requests).toHaveLength(1);
  });

  test("refuses an oversized message before reading or posting it", async () => {
    const mail = message({ rawSize: MAX_MESSAGE_BYTES + 1 });
    const http = deps([]);
    await handleEmail(mail.value, env, http.value);
    expect(mail.rejections).toEqual([REJECTIONS.tooLarge]);
    expect(http.requests).toHaveLength(0);
  });

  test("passes the API's size and malformed refusals on as permanent rejections", async () => {
    for (const [code, reason] of [
      [413, REJECTIONS.tooLarge],
      [400, REJECTIONS.refused],
    ] as const) {
      const mail = message();
      await handleEmail(mail.value, env, deps([status(code)]).value);
      expect(mail.rejections).toEqual([reason]);
    }
  });

  test("retries a temporary failure and succeeds without rejecting", async () => {
    const mail = message();
    const http = deps([
      status(503),
      new Error("connection reset"),
      status(202),
    ]);
    await handleEmail(mail.value, env, http.value);
    expect(mail.rejections).toEqual([]);
    expect(http.requests).toHaveLength(3);
    expect(http.sleeps).toHaveLength(2);
  });

  test("fails the delivery temporarily, never permanently, when the API stays unavailable or unauthorised", async () => {
    for (const failure of [status(503), status(401), new Error("timeout")]) {
      const mail = message();
      const http = deps(
        Array.from({ length: DELIVERY_ATTEMPTS }, () => failure),
      );
      await expect(handleEmail(mail.value, env, http.value)).rejects.toThrow(
        "InvoiceWise did not accept the message",
      );
      expect(mail.rejections).toEqual([]);
      expect(http.requests).toHaveLength(DELIVERY_ATTEMPTS);
    }
  });

  test("an unconfigured worker fails temporarily instead of dropping mail", async () => {
    const mail = message();
    await expect(
      handleEmail(mail.value, { INBOUND_EMAIL_ENDPOINT: "x" }, deps([]).value),
    ).rejects.toThrow("not configured");
    expect(mail.rejections).toEqual([]);
  });
});
