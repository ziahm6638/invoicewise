import { describe, expect, test } from "bun:test";
import type { InboxQueryDatabase } from "@invoicewise/db/queries";
import type { AcceptInboundEmailInput } from "@invoicewise/jobs/inbound-email";
import {
  type InboundMessage,
  REJECTIONS,
  handleEmail,
} from "../../../inbound-email/src/handler";
import {
  INBOUND_HEADERS,
  type InboundEmailHttpDeps,
  handleInboundEmail,
  signInboundRequest,
} from "./http";

const SECRET = "inbound-http-test-secret";
const NOW = 1_790_000_000_000;
const RAW = new TextEncoder().encode(
  "From: billing@supplier.example\r\nMessage-ID: <m1@supplier.example>\r\n\r\nbody\r\n",
);
const RECIPIENT = "abcdefghjkmnpqrs@in.invoicewise.uk";

type Accept = NonNullable<InboundEmailHttpDeps["accept"]>;

function depsWith(accept: Accept) {
  const calls: AcceptInboundEmailInput[] = [];
  const deps: InboundEmailHttpDeps = {
    db: {} as InboxQueryDatabase,
    secret: SECRET,
    domain: "in.invoicewise.uk",
    now: () => NOW,
    accept: async (db, input) => {
      calls.push(input);
      return accept(db, input);
    },
  };
  return { deps, calls };
}

const accepted: Accept = async () => ({
  status: "accepted",
  id: "email-1",
  teamId: "team-1",
  deduplicated: false,
});

async function signedRequest(
  overrides: {
    body?: Uint8Array;
    timestamp?: string;
    recipient?: string;
    signature?: string;
    secret?: string;
    contentLength?: string | null;
  } = {},
) {
  const body = overrides.body ?? RAW;
  const timestamp = overrides.timestamp ?? String(NOW / 1000);
  const recipient = overrides.recipient ?? encodeURIComponent(RECIPIENT);
  const sender = encodeURIComponent("billing@supplier.example");
  const bodySha256 = new Bun.CryptoHasher("sha256").update(body).digest("hex");
  const signature =
    overrides.signature ??
    signInboundRequest(overrides.secret ?? SECRET, {
      timestamp,
      recipient,
      sender,
      bodySha256,
    });
  return new Request("http://api.test/inbound/email", {
    method: "POST",
    headers: {
      "content-type": "message/rfc822",
      [INBOUND_HEADERS.timestamp]: timestamp,
      [INBOUND_HEADERS.recipient]: recipient,
      [INBOUND_HEADERS.sender]: sender,
      [INBOUND_HEADERS.signature]: signature,
      // As on the wire: the Worker always sends a fixed-length body.
      ...(overrides.contentLength === null
        ? {}
        : {
            "content-length":
              overrides.contentLength ?? String(body.byteLength),
          }),
      // A forwarded-for header proves nothing and is ignored.
      "x-forwarded-for": "127.0.0.1",
    },
    body,
  });
}

/** A request whose body records whether anything read it. */
function unreadRequest(request: Request, headers = request.headers) {
  let pulled = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulled = true;
        controller.enqueue(RAW);
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  return {
    request: new Request(request.url, {
      method: "POST",
      headers,
      body,
    }),
    pulled: () => pulled,
  };
}

describe("inbound email endpoint", () => {
  test("a correctly signed message is committed with its decoded envelope", async () => {
    const { deps, calls } = depsWith(accepted);
    const response = await handleInboundEmail(await signedRequest(), deps);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      status: "accepted",
      id: "email-1",
      deduplicated: false,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.recipient).toBe(RECIPIENT);
    expect(calls[0]!.sender).toBe("billing@supplier.example");
    expect(new TextDecoder().decode(calls[0]!.raw)).toBe(
      new TextDecoder().decode(RAW),
    );
  });

  test("a wrong secret, a forged signature, a stale timestamp or a changed body is refused before any work", async () => {
    const { deps, calls } = depsWith(accepted);
    const stale = String(NOW / 1000 - 301);
    const requests = [
      await signedRequest({ secret: "another-secret" }),
      await signedRequest({ signature: `v1=${"0".repeat(64)}` }),
      await signedRequest({ signature: "" }),
      await signedRequest({ timestamp: stale }),
      await signedRequest({ timestamp: "not-a-number" }),
    ];
    // Signed for one body, sent with another.
    const tampered = await signedRequest();
    requests.push(
      new Request(tampered.url, {
        method: "POST",
        headers: tampered.headers,
        body: new TextEncoder().encode("different"),
      }),
    );
    // Signed for one recipient, delivered to another workspace's address.
    const redirected = await signedRequest();
    const headers = new Headers(redirected.headers);
    headers.set(
      INBOUND_HEADERS.recipient,
      encodeURIComponent("zzzzzzzzzzzzzzzz@in.invoicewise.uk"),
    );
    requests.push(
      new Request(redirected.url, { method: "POST", headers, body: RAW }),
    );

    for (const request of requests) {
      const response = await handleInboundEmail(request, deps);
      expect(response.status).toBe(401);
    }
    expect(calls).toHaveLength(0);
  });

  test("a malformed signature or an oversized declared length is refused before the body is read", async () => {
    const { deps, calls } = depsWith(accepted);
    const cases: [Request, number][] = [
      [await signedRequest({ signature: "v1=abc" }), 401],
      [await signedRequest({ signature: `sha256=${"0".repeat(64)}` }), 401],
      [await signedRequest({ signature: `v1=${"G".repeat(64)}` }), 401],
      [
        await signedRequest({ contentLength: String(20 * 1024 * 1024 + 1) }),
        413,
      ],
    ];
    for (const [signed, status] of cases) {
      const { request, pulled } = unreadRequest(signed);
      const response = await handleInboundEmail(request, deps);
      expect(response.status).toBe(status);
      expect(pulled()).toBe(false);
    }
    expect(calls).toHaveLength(0);
  });

  test("a chunked body without a declared length is read with the same bound", async () => {
    const chunked = (signed: Request, body: Uint8Array) => {
      const headers = new Headers(signed.headers);
      headers.delete("content-length");
      const half = Math.floor(body.byteLength / 2);
      return new Request(signed.url, {
        method: "POST",
        headers,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(body.subarray(0, half));
            controller.enqueue(body.subarray(half));
            controller.close();
          },
        }),
      });
    };

    const { deps, calls } = depsWith(accepted);
    const signed = await signedRequest({ contentLength: null });
    expect(signed.headers.get("content-length")).toBeNull();
    const response = await handleInboundEmail(chunked(signed, RAW), deps);
    expect(response.status).toBe(202);
    expect(calls).toHaveLength(1);
    expect(new TextDecoder().decode(calls[0]!.raw)).toBe(
      new TextDecoder().decode(RAW),
    );

    const oversized = new Uint8Array(20 * 1024 * 1024 + 1);
    const tooLarge = await handleInboundEmail(
      chunked(await signedRequest({ body: oversized }), oversized),
      deps,
    );
    expect(tooLarge.status).toBe(413);
    expect(calls).toHaveLength(1);
  });

  test("an unset secret fails closed and temporarily", async () => {
    const { deps, calls } = depsWith(accepted);
    const response = await handleInboundEmail(await signedRequest(), {
      ...deps,
      secret: undefined,
    });
    expect(response.status).toBe(503);
    expect(calls).toHaveLength(0);
  });

  test("an oversized body is refused while it is read, whatever its declared length", async () => {
    const { deps, calls } = depsWith(accepted);
    const body = new Uint8Array(20 * 1024 * 1024 + 1);
    const response = await handleInboundEmail(
      await signedRequest({ body, contentLength: "10" }),
      deps,
    );
    expect(response.status).toBe(413);
    expect(calls).toHaveLength(0);
  });

  test("acceptance outcomes map to the worker's permanent and temporary answers", async () => {
    const cases: [Accept, number][] = [
      [
        async () => ({
          status: "rejected",
          code: "unknown_recipient",
          message: "Unknown recipient",
        }),
        404,
      ],
      [
        async () => ({ status: "rejected", code: "empty", message: "Empty" }),
        400,
      ],
      [
        async () => {
          throw new Error("database unavailable");
        },
        503,
      ],
    ];
    for (const [accept, status] of cases) {
      const { deps } = depsWith(accept);
      const response = await handleInboundEmail(await signedRequest(), deps);
      expect(response.status).toBe(status);
    }
  });

  test("the Email Worker and the endpoint agree end to end", async () => {
    const run = async (accept: Accept) => {
      const { deps, calls } = depsWith(accept);
      const rejections: string[] = [];
      const message: InboundMessage = {
        from: "billing@supplier.example",
        to: RECIPIENT,
        raw: new Response(RAW).body!,
        rawSize: RAW.byteLength,
        setReject: (reason) => rejections.push(reason),
      };
      await handleEmail(
        message,
        {
          INBOUND_EMAIL_SECRET: SECRET,
          INBOUND_EMAIL_ENDPOINT: "http://api.test/inbound/email",
        },
        {
          fetch: (url, init) => {
            const headers = new Headers(init.headers);
            headers.set(
              "content-length",
              String((init.body as Uint8Array).byteLength),
            );
            return handleInboundEmail(
              new Request(url, { ...init, headers }),
              deps,
            );
          },
          now: () => NOW,
          sleep: async () => undefined,
        },
      );
      return { calls, rejections };
    };

    const delivered = await run(accepted);
    expect(delivered.rejections).toEqual([]);
    expect(delivered.calls).toHaveLength(1);
    expect(delivered.calls[0]!.recipient).toBe(RECIPIENT);

    const unknown = await run(async () => ({
      status: "rejected",
      code: "unknown_recipient",
      message: "Unknown recipient",
    }));
    expect(unknown.rejections).toEqual([REJECTIONS.unknownRecipient]);
  });
});
