import { lookup } from "node:dns/promises";
import { isIP, connect as netConnect } from "node:net";
import type { Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";

/**
 * The outbound boundary for customer-supplied destinations (webhooks).
 *
 * A URL is checked as written, its hostname is resolved once, every resolved
 * address must be public, and the connection is opened to exactly one of the
 * validated addresses, trying the next one only when a connection cannot be
 * opened: the socket never resolves the name again, so a DNS answer that
 * changes between the check and the connection (rebinding) cannot reach a
 * private address. TLS still verifies the certificate against the
 * hostname. The request is written on that socket directly: no proxy
 * environment variable, redirect or keep-alive pool can route it elsewhere,
 * only the status line and headers are read (bounded), the body is never
 * read, and one deadline covers resolution, connection and response.
 */

export type ResolvedAddress = { address: string; family: 4 | 6 };

export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

export type EgressPolicy = {
  /** Loopback and private destinations, for local development only. */
  allowPrivate: boolean;
  resolver?: Resolver;
};

export class EgressError extends Error {
  constructor(
    message: string,
    /** False when the destination itself is refused: retrying cannot help. */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "EgressError";
  }
}

export const systemResolver: Resolver = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map(
    ({ address, family }) => ({ address, family: family === 6 ? 6 : 4 }),
  );

const ipv4Bytes = (address: string) => address.split(".").map(Number);

type Range = readonly [prefix: readonly number[], bits: number];

const inRange = (bytes: readonly number[], [prefix, bits]: Range) => {
  for (let bit = 0; bit < bits; bit += 8) {
    const byte = bit / 8;
    const width = Math.min(8, bits - bit);
    const mask = (0xff << (8 - width)) & 0xff;
    if (((bytes[byte] ?? 0) & mask) !== ((prefix[byte] ?? 0) & mask)) {
      return false;
    }
  }
  return true;
};

// Special-purpose IPv4 blocks (RFC 6890 and successors): nothing here is a
// public internet destination.
const BLOCKED_IPV4: readonly Range[] = [
  [[0], 8], // "this network"
  [[10], 8], // private
  [[100, 64], 10], // carrier-grade NAT
  [[127], 8], // loopback
  [[169, 254], 16], // link-local, including cloud metadata 169.254.169.254
  [[172, 16], 12], // private
  [[192, 0, 0], 24], // IETF protocol assignments
  [[192, 0, 2], 24], // documentation
  [[192, 88, 99], 24], // 6to4 relay anycast
  [[192, 168], 16], // private
  [[198, 18], 15], // benchmarking
  [[198, 51, 100], 24], // documentation
  [[203, 0, 113], 24], // documentation
  [[224], 4], // multicast
  [[240], 4], // reserved and broadcast
];

const isPublicIpv4 = (bytes: readonly number[]) =>
  bytes.length === 4 && !BLOCKED_IPV4.some((range) => inRange(bytes, range));

/** 16 bytes of an IPv6 address, or null when it cannot be parsed. */
export const ipv6Bytes = (value: string): number[] | null => {
  const address = value.split("%")[0]!.toLowerCase();
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const groups = (part: string) => {
    if (!part) return [] as number[];
    const words: number[] = [];
    const pieces = part.split(":");
    for (const [index, piece] of pieces.entries()) {
      if (piece.includes(".") && index === pieces.length - 1) {
        const v4 = ipv4Bytes(piece);
        if (isIP(piece) !== 4) return null;
        words.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
      } else if (/^[0-9a-f]{1,4}$/.test(piece)) {
        words.push(Number.parseInt(piece, 16));
      } else {
        return null;
      }
    }
    return words;
  };
  const head = groups(halves[0]!);
  const tail = halves.length === 2 ? groups(halves[1]!) : [];
  if (!head || !tail) return null;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const words = [...head, ...Array(missing).fill(0), ...tail];
  return words.flatMap((word) => [word >> 8, word & 0xff]);
};

const isPublicIpv6 = (bytes: readonly number[]) => {
  // IPv4-mapped (::ffff:0:0/96) and NAT64 (64:ff9b::/96) carry an IPv4
  // address that is what the connection actually reaches.
  if (
    inRange(bytes, [[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff], 96]) ||
    inRange(bytes, [[0, 0x64, 0xff, 0x9b], 96])
  ) {
    return isPublicIpv4(bytes.slice(12));
  }
  // Only global unicast (2000::/3) is public. That excludes ::, ::1,
  // IPv4-compatible, discard, unique-local (fc00::/7, including cloud
  // metadata fd00:ec2::254), link-local, site-local and multicast.
  if (!inRange(bytes, [[0x20], 3])) return false;
  return !(
    // Teredo, ORCHID and the other IETF protocol assignments in 2001::/23,
    // documentation, and 6to4 (which tunnels to an arbitrary IPv4 address).
    (
      inRange(bytes, [[0x20, 0x01, 0x00, 0x00], 23]) ||
      inRange(bytes, [[0x20, 0x01, 0x0d, 0xb8], 32]) ||
      inRange(bytes, [[0x20, 0x02], 16]) ||
      inRange(bytes, [[0x3f, 0xff], 20])
    )
  );
};

/** Whether an IP address is a public internet destination. */
export const isPublicAddress = (address: string) => {
  const family = isIP(address.split("%")[0]!);
  if (family === 4) return isPublicIpv4(ipv4Bytes(address));
  if (family === 6) {
    const bytes = ipv6Bytes(address);
    return bytes !== null && isPublicIpv6(bytes);
  }
  return false;
};

const LOCAL_NAMES = /(^|\.)(localhost|local|internal|localdomain)$/;

/**
 * The static check of a URL as written: scheme, no credentials, and a
 * hostname that is not a private literal or a local name. It cannot see
 * what a name resolves to; `resolveDestination` does that.
 */
export function checkUrl(value: string, allowPrivate: boolean) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false as const, reason: "Webhook URL is not a valid URL" };
  }
  if (url.username || url.password) {
    return {
      ok: false as const,
      reason: "Webhook URLs cannot contain credentials",
    };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false as const, reason: "Webhook URLs must use HTTPS" };
  }
  const hostname = url.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
  if (!hostname) {
    return { ok: false as const, reason: "Webhook URL has no host" };
  }
  const local = isIP(hostname)
    ? !isPublicAddress(hostname)
    : LOCAL_NAMES.test(hostname) || !hostname.includes(".");
  if (local && !allowPrivate) {
    return {
      ok: false as const,
      reason: "Webhook URLs must point to a public internet address",
    };
  }
  if (url.protocol !== "https:" && !(allowPrivate && local)) {
    return { ok: false as const, reason: "Webhook URLs must use HTTPS" };
  }
  return { ok: true as const, url, hostname };
}

export type Destination = {
  url: URL;
  hostname: string;
  port: number;
  /** The validated addresses a connection may use, IPv4 first. */
  addresses: ResolvedAddress[];
};

/**
 * Resolves a URL to the addresses the policy allows. Every address the name
 * resolves to must be allowed, so a record set that mixes a public and a
 * private address is refused rather than raced.
 */
export async function resolveDestination(
  value: string,
  policy: EgressPolicy,
): Promise<Destination> {
  const checked = checkUrl(value, policy.allowPrivate);
  if (!checked.ok) throw new EgressError(checked.reason, false);
  const { url, hostname } = checked;
  const port = Number(url.port) || (url.protocol === "https:" ? 443 : 80);

  let addresses: ResolvedAddress[];
  const literal = isIP(hostname);
  if (literal) {
    addresses = [{ address: hostname, family: literal === 6 ? 6 : 4 }];
  } else {
    try {
      addresses = await (policy.resolver ?? systemResolver)(hostname);
    } catch (error) {
      throw new EgressError(
        `Unable to resolve ${hostname}: ${error instanceof Error ? error.message : "lookup failed"}`,
        true,
      );
    }
  }
  if (addresses.length === 0) {
    throw new EgressError(`${hostname} did not resolve to an address`, true);
  }
  if (
    !policy.allowPrivate &&
    addresses.some(({ address }) => !isPublicAddress(address))
  ) {
    throw new EgressError(
      `${hostname} resolves to a private, loopback, link-local or reserved address`,
      false,
    );
  }
  return {
    url,
    hostname,
    port,
    addresses: [...addresses].sort((a, b) => a.family - b.family),
  };
}

export type ConnectOptions = {
  address: string;
  port: number;
  /** TLS server name and certificate identity; absent for plain HTTP. */
  servername?: string;
  tls: boolean;
};

export type Connector = (options: ConnectOptions) => Socket;

const defaultConnector: Connector = ({ address, port, servername, tls }) =>
  tls
    ? tlsConnect({
        host: address,
        port,
        // An IP literal URL has no SNI; its certificate must name the IP.
        servername: servername && !isIP(servername) ? servername : undefined,
        ALPNProtocols: ["http/1.1"],
        rejectUnauthorized: true,
      })
    : netConnect({ host: address, port });

export type PostLimits = {
  /** One deadline for resolution, connection, request and response head. */
  timeoutMs: number;
  /** Bytes of status line and headers read before the response is refused. */
  maxResponseHeadBytes: number;
};

export const DEFAULT_POST_LIMITS: PostLimits = {
  timeoutMs: 10_000,
  maxResponseHeadBytes: 16 * 1024,
};

const HEADER_TOKEN = /^[!#$%&'*+.^_`|~0-9a-z-]+$/i;

/**
 * The final status code in a response head, skipping interim 1xx responses.
 * Null while more bytes are needed.
 */
export const parseStatus = (head: string): number | null => {
  let rest = head;
  for (;;) {
    const lineEnd = rest.indexOf("\r\n");
    if (lineEnd === -1) return null;
    const end = rest.indexOf("\r\n\r\n");
    const match = /^HTTP\/1\.[01] (\d{3})(?: |$)/.exec(rest.slice(0, lineEnd));
    const status = Number(match?.[1]);
    if (!match || status < 100) {
      throw new EgressError("Invalid HTTP response", true);
    }
    if (status >= 200) return status;
    if (end === -1) return null;
    rest = rest.slice(end + 4);
  }
};

/**
 * POSTs a body to a customer destination under the egress policy and returns
 * the response status. Redirects are never followed: a 3xx is returned as its
 * status like any other non-2xx answer.
 */
export async function guardedPost(
  value: string,
  body: string,
  headers: Record<string, string>,
  policy: EgressPolicy & { connect?: Connector; limits?: PostLimits },
): Promise<{ status: number; address: string }> {
  const limits = policy.limits ?? DEFAULT_POST_LIMITS;
  const sockets: Socket[] = [];
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new EgressError(
          `Webhook request timed out after ${limits.timeoutMs}ms`,
          true,
        ),
      );
    }, limits.timeoutMs);
  });

  const toEgressError = (error: Error) =>
    error instanceof EgressError
      ? error
      : new EgressError(`Webhook request failed: ${error.message}`, true);

  /** Opens a connection to one validated address; nothing is written yet. */
  const open = (
    address: string,
    port: number,
    tls: boolean,
    servername: string | undefined,
  ) =>
    new Promise<Socket>((resolve, reject) => {
      if (settled) {
        reject(new EgressError("Webhook request already finished", true));
        return;
      }
      let opened: Socket;
      try {
        opened = (policy.connect ?? defaultConnector)({
          address,
          port,
          servername,
          tls,
        });
      } catch (error) {
        reject(toEgressError(error as Error));
        return;
      }
      sockets.push(opened);
      const failed = (error: Error) => {
        opened.destroy();
        reject(toEgressError(error));
      };
      opened.once("error", failed);
      opened.once(tls ? "secureConnect" : "connect", () => {
        opened.off("error", failed);
        // The socket must be connected to the address that was validated.
        const remote = opened.remoteAddress;
        if (remote && remote !== address) {
          const same =
            isIP(remote) === 6 && isIP(address) === 6
              ? ipv6Bytes(remote)?.join() === ipv6Bytes(address)?.join()
              : remote.replace(/^::ffff:/, "") ===
                address.replace(/^::ffff:/, "");
          if (!same) {
            opened.destroy();
            reject(
              new EgressError(
                "Connection reached an unexpected address",
                false,
              ),
            );
            return;
          }
        }
        resolve(opened);
      });
    });

  const exchange = async () => {
    const destination = await resolveDestination(value, policy);
    const { url, hostname, port, addresses } = destination;
    for (const [name, headerValue] of Object.entries(headers)) {
      if (!HEADER_TOKEN.test(name) || /[\r\n\0]/.test(headerValue)) {
        throw new EgressError(`Invalid request header ${name}`, false);
      }
    }
    const payload = Buffer.from(body);
    const host =
      url.port && Number(url.port) !== (url.protocol === "https:" ? 443 : 80)
        ? `${url.hostname}:${url.port}`
        : url.hostname;
    const head = [
      `POST ${url.pathname}${url.search} HTTP/1.1`,
      `host: ${host}`,
      ...Object.entries(headers).map(([name, v]) => `${name}: ${v}`),
      `content-length: ${payload.length}`,
      "connection: close",
      "",
      "",
    ].join("\r\n");
    const tls = url.protocol === "https:";

    // Only a connection that could not be opened falls through to the next
    // address; once request bytes are written the outcome is final.
    let socket: Socket | undefined;
    let address = addresses[0]!.address;
    let lastError: EgressError | undefined;
    for (const candidate of addresses) {
      try {
        socket = await open(
          candidate.address,
          port,
          tls,
          tls ? hostname : undefined,
        );
        address = candidate.address;
        break;
      } catch (error) {
        lastError = error as EgressError;
        if (!lastError.retryable || settled) throw lastError;
      }
    }
    if (!socket) throw lastError!;
    const connected = socket;

    return new Promise<{ status: number; address: string }>(
      (resolve, reject) => {
        const fail = (error: Error) => reject(toEgressError(error));
        connected.once("error", fail);
        let received = "";
        connected.on("data", (chunk: Buffer) => {
          received += chunk.toString("latin1");
          try {
            const status = parseStatus(received);
            if (status !== null) {
              resolve({ status, address });
              return;
            }
          } catch (error) {
            fail(error as Error);
            return;
          }
          if (received.length > limits.maxResponseHeadBytes) {
            fail(
              new EgressError(
                `Webhook response head exceeded ${limits.maxResponseHeadBytes} bytes`,
                true,
              ),
            );
          }
        });
        connected.once("end", () =>
          fail(new EgressError("Webhook endpoint closed the connection", true)),
        );
        connected.write(head);
        connected.write(payload);
      },
    );
  };

  try {
    return await Promise.race([exchange(), deadline]);
  } finally {
    settled = true;
    clearTimeout(timer);
    // The response body is never read: every connection is closed as soon as
    // the status is known, on success, failure or timeout alike.
    for (const socket of sockets) socket.destroy();
  }
}
