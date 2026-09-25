import { afterEach, describe, expect, test } from "bun:test";
import {
  type Server,
  type Socket,
  createServer,
  connect as netConnect,
} from "node:net";
import {
  type ConnectOptions,
  EgressError,
  type Resolver,
  checkUrl,
  guardedPost,
  isPublicAddress,
  parseStatus,
  resolveDestination,
} from "./egress";
import { checkWebhookDestination } from "./webhooks";

const production = { allowPrivate: false };
const resolveTo =
  (...addresses: string[]): Resolver =>
  async () =>
    addresses.map((address) => ({
      address,
      family: address.includes(":") ? 6 : 4,
    }));

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

/** A raw TCP listener on loopback that answers each connection with `reply`. */
const listen = async (reply: (socket: Socket) => void) => {
  const connections: string[] = [];
  const server = createServer((socket) => {
    connections.push(socket.remoteAddress ?? "");
    socket.once("data", () => reply(socket));
    socket.on("error", () => {});
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return { port: address.port, connections };
};

describe("destination addresses", () => {
  test.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "fe80::1",
    "fe80::1%lo0",
    "fc00::1",
    "fd00:ec2::254",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:169.254.169.254",
    "64:ff9b::a9fe:a9fe",
    "2002:7f00:1::1",
    "2001:db8::1",
    "2001::1",
    "ff02::1",
    "::127.0.0.1",
  ])("refuses %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  test.each([
    "93.184.215.14",
    "8.8.8.8",
    "2606:4700:10::ac42:93f3",
    "2a00:1450:4009:81f::200e",
    "::ffff:8.8.8.8",
    "64:ff9b::808:808",
  ])("allows public %s", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  test("the URL as written: scheme, credentials, literals and local names", () => {
    expect(checkUrl("https://hooks.example.com/in", false).ok).toBe(true);
    for (const url of [
      "http://hooks.example.com/in",
      "https://user:pass@hooks.example.com/in",
      "ftp://hooks.example.com/in",
      "https://localhost/in",
      "https://metadata.google.internal/computeMetadata",
      "https://intranet/in",
      "https://printer.local/in",
      "https://[::1]/in",
      "https://[::ffff:127.0.0.1]/in",
      "https://[fd00:ec2::254]/in",
      // The URL parser normalizes these to 127.0.0.1 before the check.
      "https://2130706433/in",
      "https://0x7f.1/in",
      "https://127.1/in",
    ]) {
      expect({ url, ok: checkUrl(url, false).ok }).toEqual({ url, ok: false });
    }
    // Local development may use loopback over plain HTTP.
    expect(checkUrl("http://127.0.0.1:3014/hook", true).ok).toBe(true);
    expect(checkUrl("http://hooks.example.com/in", true).ok).toBe(false);
  });
});

describe("DNS resolution", () => {
  test("a public-looking hostname that resolves to a private address is refused", async () => {
    for (const address of ["127.0.0.1", "169.254.169.254", "10.0.0.5", "::1"]) {
      const error = await resolveDestination("https://hooks.example.com/in", {
        ...production,
        resolver: resolveTo(address),
      }).catch((caught) => caught);
      expect(error).toBeInstanceOf(EgressError);
      expect(error.retryable).toBe(false);
      expect(error.message).toContain("private");
    }
    expect(
      await checkWebhookDestination("https://hooks.example.com/in", {
        ...production,
        resolver: resolveTo("192.168.0.10"),
      }),
    ).toEqual({
      ok: false,
      reason:
        "hooks.example.com resolves to a private, loopback, link-local or reserved address",
    });
  });

  test("a record set that mixes public and private addresses is refused", async () => {
    const error = await resolveDestination("https://hooks.example.com/in", {
      ...production,
      resolver: resolveTo("93.184.215.14", "127.0.0.1"),
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(EgressError);
  });

  test("a resolution failure is retryable, not a refusal", async () => {
    const error = await resolveDestination("https://hooks.example.com/in", {
      ...production,
      resolver: async () => {
        throw new Error("ENOTFOUND");
      },
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(EgressError);
    expect(error.retryable).toBe(true);
  });

  test("DNS rebinding: an answer that turns private after registration never connects", async () => {
    const answers = ["93.184.215.14", "169.254.169.254"];
    let lookups = 0;
    const resolver: Resolver = async () => [
      { address: answers[lookups++]!, family: 4 },
    ];
    const connects: ConnectOptions[] = [];

    // Registration sees the public answer.
    expect(
      await checkWebhookDestination("https://rebind.example.com/in", {
        ...production,
        resolver,
      }),
    ).toEqual({ ok: true });

    // Delivery resolves again, sees the private answer and refuses before
    // opening any connection.
    const error = await guardedPost(
      "https://rebind.example.com/in",
      "{}",
      {},
      {
        ...production,
        resolver,
        connect: (options) => {
          connects.push(options);
          throw new Error("must not connect");
        },
      },
    ).catch((caught) => caught);
    expect(error).toBeInstanceOf(EgressError);
    expect(error.retryable).toBe(false);
    expect(connects).toEqual([]);
    expect(lookups).toBe(2);
  });

  test("the connection is pinned to the validated address and verifies the hostname", async () => {
    let lookups = 0;
    const connects: ConnectOptions[] = [];
    const error = await guardedPost(
      "https://hooks.example.com:8443/in?x=1",
      "{}",
      {},
      {
        ...production,
        resolver: async () => {
          lookups += 1;
          return [{ address: "93.184.215.14", family: 4 }];
        },
        connect: (options) => {
          connects.push(options);
          throw new Error("stop here");
        },
      },
    ).catch((caught) => caught);
    expect(error).toBeInstanceOf(Error);
    // One resolution per connection; the socket gets the address, never the
    // name, so it cannot resolve again.
    expect(lookups).toBe(1);
    expect(connects).toEqual([
      {
        address: "93.184.215.14",
        port: 8443,
        servername: "hooks.example.com",
        tls: true,
      },
    ]);
  });
  test("a connection that cannot be opened falls back to the next validated address", async () => {
    const { port, connections } = await listen((socket) =>
      socket.end("HTTP/1.1 204 No Content\r\n\r\n"),
    );
    const connects: string[] = [];
    const result = await guardedPost(
      "https://hooks.example.com/in",
      "{}",
      {},
      {
        ...production,
        resolver: resolveTo("2606:2800:220:1::1", "93.184.215.14"),
        connect: ({ address }) => {
          connects.push(address);
          if (address === "93.184.215.14") {
            return netConnect({ host: "127.0.0.1", port: 1 });
          }
          // A loopback socket standing in for a TLS connection to the
          // pinned IPv6 address.
          const socket = netConnect({ host: "127.0.0.1", port });
          Object.defineProperty(socket, "remoteAddress", { value: address });
          socket.once("connect", () => socket.emit("secureConnect"));
          return socket;
        },
      },
    );
    // IPv4 is tried first; it refuses the connection, so the validated IPv6
    // address is used and the request is sent exactly once.
    expect(connects).toEqual(["93.184.215.14", "2606:2800:220:1::1"]);
    expect(result).toEqual({ status: 204, address: "2606:2800:220:1::1" });
    expect(connections).toHaveLength(1);
  });

  test("a refused address set is never connected to, even with a fallback", async () => {
    const connects: string[] = [];
    const error = await guardedPost(
      "https://hooks.example.com/in",
      "{}",
      {},
      {
        ...production,
        resolver: resolveTo("93.184.215.14", "10.0.0.5"),
        connect: ({ address }) => {
          connects.push(address);
          throw new Error("must not connect");
        },
      },
    ).catch((caught) => caught);
    expect(error).toBeInstanceOf(EgressError);
    expect(error.retryable).toBe(false);
    expect(connects).toEqual([]);
  });
});

describe("guarded transport", () => {
  const local = { allowPrivate: true, resolver: resolveTo("127.0.0.1") };

  test("posts the exact body and returns the status", async () => {
    let request = "";
    const server = createServer((socket) => {
      socket.on("data", (chunk) => {
        request += chunk.toString();
        if (request.endsWith('{"id":"evt"}')) {
          socket.end("HTTP/1.1 204 No Content\r\n\r\n");
        }
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as { port: number };
    const result = await guardedPost(
      `http://hooks.localhost:${port}/in?a=1`,
      '{"id":"evt"}',
      { "content-type": "application/json", "x-test": "1" },
      local,
    );
    expect(result).toEqual({ status: 204, address: "127.0.0.1" });
    expect(request).toStartWith("POST /in?a=1 HTTP/1.1\r\n");
    expect(request).toContain(`host: hooks.localhost:${port}\r\n`);
    expect(request).toContain("x-test: 1\r\n");
    expect(request).toContain("content-length: 12\r\n");
    expect(request).toContain("connection: close\r\n");
  });

  test("a redirect is returned as a status and never followed", async () => {
    const target = await listen((socket) =>
      socket.end("HTTP/1.1 204 No Content\r\n\r\n"),
    );
    const redirecting = await listen((socket) =>
      socket.end(
        "HTTP/1.1 307 Temporary Redirect\r\nlocation: http://169.254.169.254/latest/meta-data\r\n\r\n",
      ),
    );
    const result = await guardedPost(
      `http://hooks.localhost:${redirecting.port}/in`,
      "{}",
      {},
      local,
    );
    expect(result.status).toBe(307);
    expect(redirecting.connections).toHaveLength(1);
    expect(target.connections).toHaveLength(0);
  });

  test("interim 1xx responses are skipped", () => {
    expect(parseStatus("HTTP/1.1 103 Early Hints\r\nlink: x\r\n\r\n")).toBe(
      null,
    );
    expect(
      parseStatus(
        "HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 202 Accepted\r\ncontent-length: 0\r\n",
      ),
    ).toBe(202);
    expect(() => parseStatus("SSH-2.0-OpenSSH\r\n")).toThrow(EgressError);
  });

  test("an endless response body is never read", async () => {
    const { port } = await listen((socket) => {
      socket.write("HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\n\r\n");
      const chunk = Buffer.alloc(64 * 1024, "x");
      const flood = setInterval(() => {
        if (socket.destroyed) clearInterval(flood);
        else socket.write(chunk);
      }, 1);
      socket.on("close", () => clearInterval(flood));
    });
    const started = Date.now();
    const result = await guardedPost(
      `http://hooks.localhost:${port}/in`,
      "{}",
      {},
      local,
    );
    expect(result.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("a response head that never completes is refused at the byte limit", async () => {
    const { port } = await listen((socket) =>
      socket.write(`HTTP/1.1 200 ${"a".repeat(64 * 1024)}`),
    );
    const error = await guardedPost(
      `http://hooks.localhost:${port}/in`,
      "{}",
      {},
      { ...local, limits: { timeoutMs: 5_000, maxResponseHeadBytes: 1024 } },
    ).catch((caught) => caught);
    expect(error).toBeInstanceOf(EgressError);
    expect(error.message).toContain("exceeded 1024 bytes");
  });

  test("a silent endpoint is cut off at the deadline", async () => {
    const { port } = await listen(() => {});
    const started = Date.now();
    const error = await guardedPost(
      `http://hooks.localhost:${port}/in`,
      "{}",
      {},
      { ...local, limits: { timeoutMs: 300, maxResponseHeadBytes: 1024 } },
    ).catch((caught) => caught);
    expect(error).toBeInstanceOf(EgressError);
    expect(error.retryable).toBe(true);
    expect(error.message).toContain("timed out after 300ms");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("a resolver that hangs is cut off at the deadline", async () => {
    const error = await guardedPost(
      "https://hooks.example.com/in",
      "{}",
      {},
      {
        ...production,
        resolver: () => new Promise(() => {}),
        limits: { timeoutMs: 200, maxResponseHeadBytes: 1024 },
      },
    ).catch((caught) => caught);
    expect(error).toBeInstanceOf(EgressError);
    expect(error.message).toContain("timed out");
  });

  test("header injection is refused", async () => {
    const error = await guardedPost(
      "https://hooks.example.com/in",
      "{}",
      { "x-evil": "a\r\nhost: internal" },
      {
        ...production,
        resolver: resolveTo("93.184.215.14"),
        connect: () => {
          throw new Error("must not connect");
        },
      },
    ).catch((caught) => caught);
    expect(error).toBeInstanceOf(EgressError);
    expect(error.message).toContain("Invalid request header");
  });

  test("private destinations are refused in production even on loopback listeners", async () => {
    const { port, connections } = await listen((socket) =>
      socket.end("HTTP/1.1 204 No Content\r\n\r\n"),
    );
    const error = await guardedPost(
      `https://hooks.example.com:${port}/in`,
      "{}",
      {},
      { ...production, resolver: resolveTo("127.0.0.1") },
    ).catch((caught) => caught);
    expect(error).toBeInstanceOf(EgressError);
    expect(connections).toHaveLength(0);
  });
});
