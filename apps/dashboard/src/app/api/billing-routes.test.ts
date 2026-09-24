/**
 * Billing endpoints must gate on the live workspace role, not only on
 * membership, because the dashboard and tRPC gates can be bypassed by calling
 * these routes directly. The Polar client is stubbed: no provider call happens.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { NextRequest } from "next/server";

process.env.POLAR_ENVIRONMENT = "sandbox";

const polarCalls = { checkouts: 0, portals: 0 };
let checkoutSuccessUrl: string | undefined;

mock.module("@/utils/polar", () => ({
  api: {
    checkouts: {
      create: async ({ successUrl }: { successUrl: string }) => {
        polarCalls.checkouts += 1;
        checkoutSuccessUrl = successUrl;
        return { url: "https://polar.test/checkout" };
      },
    },
    customerSessions: {
      create: async () => {
        polarCalls.portals += 1;
        return { customerPortalUrl: "https://polar.test/portal" };
      },
    },
  },
}));

let currentSession: Record<string, unknown> | null = null;

mock.module("@/lib/auth", () => ({
  getSession: async () => currentSession,
}));

// Keep the real permission helper, stub only the database read so the test
// needs no database connection.
const realQueries = await import("@invoicewise/db/queries");

mock.module("@invoicewise/db/queries", () => ({
  ...realQueries,
  getTeamById: async (_db: unknown, id: string) => ({
    id,
    name: "Test workspace",
    logoUrl: null,
    plan: "pro",
  }),
}));

const { GET: checkoutRoute } = await import("./checkout/route");
const { GET: portalRoute } = await import("./portal/route");

const TEAM = "11111111-1111-4111-8111-111111111111";
const OTHER_TEAM = "22222222-2222-4222-8222-222222222222";

const sessionFor = (teamRole: string | null, teamId: string | null = TEAM) => ({
  user: { id: "user-1", email: "owner@example.test", full_name: "Owner" },
  teamId,
  teamRole,
});

const checkoutRequest = (teamId: string = TEAM) =>
  new NextRequest(
    `http://localhost:3000/api/checkout?plan=pro&teamId=${teamId}`,
    { method: "GET" },
  );

const portalRequest = (teamId: string = TEAM) =>
  new NextRequest(`http://localhost:3000/api/portal?id=${teamId}`, {
    method: "GET",
  });

// Requests reach the container on an internal origin behind the proxy.
const PUBLIC_ORIGIN = "https://app.invoicewise.uk";
const configuredUrl = process.env.NEXT_PUBLIC_URL;

beforeAll(() => {
  process.env.NEXT_PUBLIC_URL = PUBLIC_ORIGIN;
});

afterAll(() => {
  if (configuredUrl === undefined) {
    Reflect.deleteProperty(process.env, "NEXT_PUBLIC_URL");
  } else {
    process.env.NEXT_PUBLIC_URL = configuredUrl;
  }
});

afterEach(() => {
  checkoutSuccessUrl = undefined;
  currentSession = null;
  polarCalls.checkouts = 0;
  polarCalls.portals = 0;
});

describe("billing routes require a live owner", () => {
  test("unauthenticated requests are rejected", async () => {
    currentSession = null;

    expect((await checkoutRoute(checkoutRequest())).status).toBe(401);
    expect((await portalRoute(portalRequest())).status).toBe(401);
    expect(polarCalls).toEqual({ checkouts: 0, portals: 0 });
  });

  test("members and admins are rejected before any provider call", async () => {
    for (const role of ["member", "admin"]) {
      currentSession = sessionFor(role);

      expect((await checkoutRoute(checkoutRequest())).status).toBe(403);
      expect((await portalRoute(portalRequest())).status).toBe(403);
    }

    expect(polarCalls).toEqual({ checkouts: 0, portals: 0 });
  });

  test("an owner of another workspace is rejected", async () => {
    currentSession = sessionFor("owner");

    expect((await checkoutRoute(checkoutRequest(OTHER_TEAM))).status).toBe(403);
    expect((await portalRoute(portalRequest(OTHER_TEAM))).status).toBe(403);
    expect(polarCalls).toEqual({ checkouts: 0, portals: 0 });
  });

  test("a demoted owner loses access on the next request", async () => {
    currentSession = sessionFor("owner");
    expect((await checkoutRoute(checkoutRequest())).status).toBe(307);

    // The live role is re-read per request, so the same session is refused.
    currentSession = sessionFor("member");
    expect((await checkoutRoute(checkoutRequest())).status).toBe(403);
    expect(polarCalls.checkouts).toBe(1);
  });

  test("the owner reaches the provider for their own workspace", async () => {
    currentSession = sessionFor("owner");

    const checkout = await checkoutRoute(checkoutRequest());
    const portal = await portalRoute(portalRequest());

    expect(checkout.status).toBe(307);
    expect(checkout.headers.get("location")).toBe(
      "https://polar.test/checkout",
    );
    expect(portal.status).toBe(307);
    expect(portal.headers.get("location")).toBe("https://polar.test/portal");
    expect(polarCalls).toEqual({ checkouts: 1, portals: 1 });
    // Polar returns the browser here, so it must be the public origin.
    expect(checkoutSuccessUrl).toBe(
      `${PUBLIC_ORIGIN}/api/checkout/success?redirectPath=%2F`,
    );
  });
});
