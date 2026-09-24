/**
 * `checkout/success` redirects to a caller-supplied `redirectPath`, so it must
 * only ever land on a same-origin relative path, and on the public app origin
 * rather than the internal origin the request reaches the container with.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { safeRedirectPath } from "@/utils/safe-redirect";
import { NextRequest } from "next/server";
import { GET } from "./route";

// What the handler sees behind the production proxy, and where the browser is.
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

const redirectFor = async (redirectPath: string) => {
  const url = new URL("/api/checkout/success", INTERNAL_ORIGIN);
  url.searchParams.set("redirectPath", redirectPath);

  const response = await GET(new NextRequest(url, { method: "GET" }));

  expect(response.status).toBeGreaterThanOrEqual(300);
  expect(response.status).toBeLessThan(400);

  return new URL(response.headers.get("location")!);
};

describe("checkout/success redirect", () => {
  test("a same-origin relative path is honoured", async () => {
    const location = await redirectFor("/settings/billing?plan=pro#top");

    expect(location.origin).toBe(ORIGIN);
    expect(`${location.pathname}${location.search}${location.hash}`).toBe(
      "/settings/billing?plan=pro#top",
    );
  });

  test("a missing redirectPath goes home", async () => {
    const response = await GET(
      new NextRequest(`${INTERNAL_ORIGIN}/api/checkout/success`, {
        method: "GET",
      }),
    );

    expect(response.headers.get("location")).toBe(`${ORIGIN}/`);
  });

  test.each([
    "https://evil.example/phish",
    "http://evil.example",
    "//evil.example/phish",
    "/\\evil.example",
    "\\\\evil.example",
    "/\t/evil.example",
    "/\n/evil.example",
    " //evil.example",
    "javascript:alert(1)",
    "evil.example",
    "https:/evil.example",
  ])(
    "the absolute or protocol-relative target %p is refused",
    async (target) => {
      const location = await redirectFor(target);

      expect(location.origin).toBe(ORIGIN);
      expect(location.pathname).toBe("/");
    },
  );
});

describe("safeRedirectPath", () => {
  test("keeps relative paths and falls back for anything else", () => {
    expect(safeRedirectPath("/invoices?connected=true")).toBe(
      "/invoices?connected=true",
    );
    expect(safeRedirectPath(null)).toBe("/");
    expect(safeRedirectPath("//evil.example", "/settings")).toBe("/settings");
    expect(safeRedirectPath("/../..//evil.example")).toBe("/");
  });
});
