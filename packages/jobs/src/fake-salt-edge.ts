/**
 * An in-memory Salt Edge v6 for the bank-payments verifier and tests: the
 * endpoints `salt-edge.ts` calls, answered from state the test controls. It
 * checks the App-id/Secret headers and serves small pages so pagination and
 * cursors are exercised. It never touches the network.
 */
import { SALT_EDGE_DEFAULT_BASE_URL } from "./salt-edge";

type FakeConnection = {
  id: string;
  customer_id: string;
  status: "active" | "inactive" | "disabled";
  provider_name: string;
  finished: boolean;
};

type FakeTransaction = {
  id: string;
  account_id: string;
  status: "posted" | "pending";
  duplicated?: boolean;
  mode?: "normal" | "fee" | "transfer";
  made_on: string;
  amount: number;
  currency_code: string;
  description: string;
  extra?: Record<string, unknown>;
};

export type FakeSaltEdge = ReturnType<typeof createFakeSaltEdge>;

export function createFakeSaltEdge(options: {
  appId: string;
  secret: string;
  pageSize?: number;
  /**
   * Where connect URLs point. The e2e stub serves a loopback "bank sign-in"
   * there that finishes the session (`finishSession`) and returns the
   * browser to the app, as Salt Edge's hosted page does.
   */
  connectBaseUrl?: string;
}) {
  const connectBaseUrl = options.connectBaseUrl ?? "https://fake.saltedge.test";
  /** Open bank sign-ins: token -> who started it and where to return. */
  const sessions = new Map<
    string,
    { customerId: string; returnTo: string; connectionId: string | null }
  >();
  const openSession = (
    customerId: string,
    connectionId: string | null,
    attempt: unknown,
  ) => {
    const token = nextId();
    const returnTo = String(
      (attempt as { return_to?: unknown } | null)?.return_to ?? "",
    );
    sessions.set(token, { customerId, returnTo, connectionId });
    return token;
  };
  const pageSize = options.pageSize ?? 3;
  let sequence = 1_000;
  const nextId = () => String((sequence += 1));
  const customers = new Map<string, { identifier: string }>();
  const connections = new Map<string, FakeConnection>();
  const consents = new Map<
    string,
    { id: string; status: string; expires_at: string | null }[]
  >();
  const accounts = new Map<
    string,
    { id: string; name: string; nature: string; currency_code: string }[]
  >();
  const transactions = new Map<string, FakeTransaction[]>();
  const calls: { method: string; path: string; body: unknown }[] = [];

  const ok = (data: unknown, meta: Record<string, unknown> = {}) =>
    Response.json({ data, meta });
  const error = (status: number, errorClass: string, message: string) =>
    Response.json({ error: { class: errorClass, message } }, { status });

  const page = <T extends { id: string }>(rows: T[], fromId: string | null) => {
    const sorted = [...rows].sort((a, b) => Number(a.id) - Number(b.id));
    const start = fromId
      ? sorted.findIndex((row) => Number(row.id) >= Number(fromId))
      : 0;
    const slice = start < 0 ? [] : sorted.slice(start, start + pageSize);
    const next = start < 0 ? undefined : sorted[start + pageSize];
    return { slice, nextId: next?.id ?? null };
  };

  const fetcher = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const path = url.pathname.replace(
      new URL(SALT_EDGE_DEFAULT_BASE_URL).pathname,
      "",
    );
    calls.push({ method, path, body });
    if (
      headers.get("App-id") !== options.appId ||
      headers.get("Secret") !== options.secret
    ) {
      return error(401, "WrongClientSecret", "Wrong App-id or Secret");
    }
    const data =
      (body as { data?: Record<string, unknown> } | null)?.data ?? {};
    const segments = path.split("/").filter(Boolean);

    if (path === "/customers" && method === "POST") {
      const identifier = String(data.identifier);
      if (
        [...customers.values()].some((row) => row.identifier === identifier)
      ) {
        return error(409, "DuplicatedCustomer", "Customer exists");
      }
      const id = nextId();
      customers.set(id, { identifier });
      return ok({ customer_id: id, identifier });
    }
    if (path === "/customers" && method === "GET") {
      return ok(
        [...customers].map(([id, row]) => ({ customer_id: id, ...row })),
      );
    }
    if (segments[0] === "customers" && method === "DELETE") {
      const id = segments[1]!;
      if (!customers.delete(id)) {
        return error(404, "CustomerNotFound", "No customer");
      }
      for (const [connectionId, row] of connections) {
        if (row.customer_id === id) connections.delete(connectionId);
      }
      return ok({ deleted: true, id });
    }
    if (path === "/connections/connect" && method === "POST") {
      if (!customers.has(String(data.customer_id))) {
        return error(404, "CustomerNotFound", "No customer");
      }
      const token = openSession(String(data.customer_id), null, data.attempt);
      return ok({
        connect_url: `${connectBaseUrl}/connect?customer=${data.customer_id}&session=${token}`,
        expires_at: "2099-01-01T00:00:00Z",
        customer_id: data.customer_id,
      });
    }
    if (segments[0] === "connections" && segments[2] === "reconnect") {
      const existing = connections.get(segments[1]!);
      if (!existing) {
        return error(404, "ConnectionNotFound", "No connection");
      }
      const token = openSession(
        existing.customer_id,
        existing.id,
        data.attempt,
      );
      return ok({
        connect_url: `${connectBaseUrl}/reconnect/${segments[1]}?session=${token}`,
      });
    }
    if (segments[0] === "connections" && segments[2] === "refresh") {
      return connections.has(segments[1]!)
        ? ok({ refreshed: true })
        : error(404, "ConnectionNotFound", "No connection");
    }
    if (path === "/connections" && method === "GET") {
      const customer = url.searchParams.get("customer_id");
      return ok(
        [...connections.values()]
          .filter((row) => row.customer_id === customer)
          .map(({ finished, ...row }) => ({
            ...row,
            last_attempt: { finished },
          })),
      );
    }
    if (segments[0] === "connections" && segments.length === 2) {
      const row = connections.get(segments[1]!);
      if (!row) return error(404, "ConnectionNotFound", "No connection");
      if (method === "DELETE") {
        connections.delete(row.id);
        return ok({ removed: true, id: row.id });
      }
      const { finished, ...rest } = row;
      return ok({ ...rest, last_attempt: { finished } });
    }
    if (path === "/consents") {
      const connectionId = url.searchParams.get("connection_id")!;
      if (!connections.has(connectionId)) {
        return error(404, "ConnectionNotFound", "No connection");
      }
      return ok(consents.get(connectionId) ?? []);
    }
    if (path === "/accounts") {
      const connectionId = url.searchParams.get("connection_id")!;
      if (!connections.has(connectionId)) {
        return error(404, "ConnectionNotFound", "No connection");
      }
      return ok(accounts.get(connectionId) ?? []);
    }
    if (path === "/transactions") {
      const accountId = url.searchParams.get("account_id")!;
      const connectionId = url.searchParams.get("connection_id")!;
      const connection = connections.get(connectionId);
      if (!connection) return error(404, "ConnectionNotFound", "No connection");
      const consent = consents.get(connectionId)?.at(-1);
      if (consent && consent.status !== "active") {
        return error(
          406,
          consent.status === "revoked" ? "ConsentRevoked" : "ConsentExpired",
          "Consent is not active",
        );
      }
      const pending = url.searchParams.get("pending") === "true";
      const rows = (transactions.get(accountId) ?? []).filter(
        (row) => (row.status === "pending") === pending,
      );
      const { slice, nextId: next } = page(
        rows,
        url.searchParams.get("from_id"),
      );
      return ok(
        slice.map((row) => ({
          duplicated: false,
          mode: "normal",
          extra: {},
          ...row,
        })),
        { next_id: next },
      );
    }
    return error(404, "RouteNotFound", `${method} ${path}`);
  }) as typeof fetch;

  return {
    fetcher,
    calls,
    customers,
    connections,
    /**
     * The customer finishing the bank sign-in a connect or reconnect URL
     * opened: a new connection (or renewed consent) and the URL the browser
     * returns to, with `connection_id` appended as Salt Edge does. Null for
     * an unknown or already used session.
     */
    finishSession(token: string) {
      const session = sessions.get(token);
      if (!session) return null;
      sessions.delete(token);
      let connectionId = session.connectionId;
      if (connectionId && connections.has(connectionId)) {
        this.setConsent(connectionId, "active");
      } else {
        connectionId = this.completeConnect({
          customerId: session.customerId,
        }).connectionId;
      }
      const url = new URL(session.returnTo);
      url.searchParams.set("connection_id", connectionId);
      return { connectionId, returnTo: url.toString() };
    },
    /** The account of a connection (the first one). */
    accountOf(connectionId: string) {
      return accounts.get(connectionId)?.[0]?.id ?? null;
    },
    /** The customer's bank sign-in finishing: a connection with one account. */
    completeConnect(input: {
      customerId: string;
      providerName?: string;
      currency?: string;
      consentExpiresAt?: string;
    }) {
      const id = nextId();
      connections.set(id, {
        id,
        customer_id: input.customerId,
        status: "active",
        provider_name: input.providerName ?? "Fake Bank Simple",
        finished: true,
      });
      consents.set(id, [
        {
          id: nextId(),
          status: "active",
          expires_at: input.consentExpiresAt ?? "2099-01-01T00:00:00Z",
        },
      ]);
      const accountId = nextId();
      accounts.set(id, [
        {
          id: accountId,
          name: "Business current account",
          nature: "account",
          currency_code: input.currency ?? "GBP",
        },
      ]);
      transactions.set(accountId, []);
      return { connectionId: id, accountId };
    },
    addTransaction(
      accountId: string,
      row: Omit<FakeTransaction, "id" | "account_id"> & { id?: string },
    ) {
      const id = row.id ?? nextId();
      transactions.get(accountId)!.push({ ...row, id, account_id: accountId });
      return id;
    },
    removeTransaction(accountId: string, id: string) {
      transactions.set(
        accountId,
        (transactions.get(accountId) ?? []).filter((row) => row.id !== id),
      );
    },
    setConsent(connectionId: string, status: "active" | "expired" | "revoked") {
      const list = consents.get(connectionId) ?? [];
      if (status === "active") {
        list.push({ id: nextId(), status, expires_at: "2099-01-01T00:00:00Z" });
      } else {
        const last = list.at(-1);
        if (last) last.status = status;
      }
      consents.set(connectionId, list);
    },
  };
}
