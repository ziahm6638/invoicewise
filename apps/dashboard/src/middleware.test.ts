/**
 * The sign-in redirect must send the browser to the public app origin, not
 * the internal origin the request reaches the container with.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { middleware } from "./middleware";

// What the middleware sees behind the production proxy, and where the browser is.
const INTERNAL_ORIGIN = "https://localhost:3000";
const ORIGIN = "https://app.invoicewise.uk";

const configuredUrl = process.env.NEXT_PUBLIC_URL;

beforeAll(() => {
  process.env.NEXT_PUBLIC_URL = ORIGIN;
});

afterAll(() => {
  if (configuredUrl === undefined) {
    Reflect.deleteProperty(process.env, "NEXT_PUBLIC_URL");
  } else {
    process.env.NEXT_PUBLIC_URL = configuredUrl;
  }
});

describe("sign-in redirect", () => {
  test("a signed-out request is sent to the public login page", async () => {
    const response = await middleware(
      new NextRequest(`${INTERNAL_ORIGIN}/en/invoices?status=new`),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      `${ORIGIN}/login?return_to=%2Finvoices%3Fstatus%3Dnew`,
    );
  });

  test("a public auth page is served without a redirect", async () => {
    const response = await middleware(
      new NextRequest(`${INTERNAL_ORIGIN}/login`),
    );

    expect(response.headers.get("location")).toBeNull();
  });
});
