/**
 * The mailbox OAuth callback must send the browser back to the public app
 * origin, not the internal origin the request reaches the container with.
 * The API exchange and the workflow queue are stubbed: nothing leaves the
 * machine.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";

// What the handler sees behind the production proxy, and where the browser is.
const INTERNAL_ORIGIN = "https://localhost:3000";
const ORIGIN = "https://app.invoicewise.uk";

let exchange: () => Promise<{ id: string; provider: string } | null>;

mock.module("@/trpc/server", () => ({
  getQueryClient: () => ({
    fetchQuery: () => exchange(),
  }),
  trpc: {
    inboxAccounts: {
      exchangeCodeForAccount: { queryOptions: (input: unknown) => input },
    },
  },
}));

mock.module("@invoicewise/jobs", () => ({
  enqueueWorkflow: async () => undefined,
  workflowKey: { inboxSetup: (id: string) => `inbox-setup:${id}` },
}));

mock.module("@invoicewise/db/client", () => ({ db: {}, primaryDb: {} }));

const { GET } = await import("./route");

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

beforeEach(() => {
  exchange = async () => ({ id: "account-1", provider: "gmail" });
});

const locationFor = async () => {
  const response = await GET(
    new Request(`${INTERNAL_ORIGIN}/api/connector/callback?code=c&state=s`),
  );

  expect(response.status).toBe(302);

  return response.headers.get("location");
};

describe("connector/callback redirect", () => {
  test("a connected account lands on the public origin", async () => {
    expect(await locationFor()).toBe(
      `${ORIGIN}/invoices?connected=true&provider=gmail`,
    );
  });

  test("a refused exchange lands on the public origin", async () => {
    exchange = async () => null;

    expect(await locationFor()).toBe(`${ORIGIN}/invoices?connected=failed`);
  });

  test("a failed exchange lands on the public origin", async () => {
    exchange = async () => {
      throw new Error("exchange failed");
    };
    const consoleError = spyOn(console, "error").mockImplementation(() => {});

    try {
      expect(await locationFor()).toBe(`${ORIGIN}/invoices?connected=false`);
    } finally {
      consoleError.mockRestore();
    }
  });
});
