import { describe, expect, test } from "bun:test";
import { DeletionCleanupError, revokeGoogleToken } from "./deletion";

const respond = (status: number, body: unknown) =>
  (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;

describe("revokeGoogleToken", () => {
  test("sends the token to Google's revocation endpoint", async () => {
    let request: { url: string; body: string } | undefined;
    const fetcher = (async (url: string, init: RequestInit) => {
      request = { url, body: String(init.body) };
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;

    await revokeGoogleToken("refresh-token", fetcher);

    expect(request?.url).toBe("https://oauth2.googleapis.com/revoke");
    expect(request?.body).toBe("token=refresh-token");
  });

  test("treats a token Google no longer honours as revoked", async () => {
    await expect(
      revokeGoogleToken("stale", respond(400, { error: "invalid_token" })),
    ).resolves.toBeUndefined();
  });

  test("retries provider outages but not rejected requests", async () => {
    const outage = await revokeGoogleToken(
      "token",
      respond(503, { error: "backend_error" }),
    ).catch((error: unknown) => error);
    expect(outage).toBeInstanceOf(DeletionCleanupError);
    expect((outage as DeletionCleanupError).retryable).toBe(true);

    const rejected = await revokeGoogleToken(
      "token",
      respond(400, { error: "invalid_request" }),
    ).catch((error: unknown) => error);
    expect(rejected).toBeInstanceOf(DeletionCleanupError);
    expect((rejected as DeletionCleanupError).retryable).toBe(false);
  });
});
