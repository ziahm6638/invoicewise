import {
  isProductionEnv,
  resolveMailSender,
} from "@invoicewise/utils/transactional-mail";

/**
 * Account-security policy for the Better Auth instance in `./auth`.
 *
 * Kept free of database and framework imports so the production preflight and
 * the rate-limit table can be tested without booting the auth server.
 */

/** Local-only fallback secret. It is refused whenever NODE_ENV=production. */
export const LOCAL_AUTH_SECRET =
  "invoicewise-local-development-auth-secret-change-in-production";

const MIN_SECRET_LENGTH = 32;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Per client-IP budgets for every endpoint that checks a credential, sends a
 * token-bearing message or completes one. Better Auth keys each budget by
 * client IP and path and returns `429` with `X-Retry-After` once it is spent.
 * The two-factor plugin additionally caps each sign-in challenge at five
 * attempts and locks an account's second factor for 15 minutes after ten
 * consecutive failures, independent of the caller's IP.
 *
 * Rules match in order, so the trailing catch-all keeps every other path
 * (session reads, sign-out, settings) out of `auth_rate_limits` entirely.
 * Better Auth deletes rows older than the longest window whenever a budget
 * rolls over, which keeps the table bounded without a scheduled job.
 */
export const AUTH_RATE_LIMIT_RULES = {
  "/sign-in/*": { window: 60, max: 10 },
  "/sign-up/*": { window: 600, max: 5 },
  "/request-password-reset": { window: 600, max: 5 },
  "/reset-password": { window: 600, max: 10 },
  "/reset-password/*": { window: 600, max: 10 },
  "/send-verification-email": { window: 600, max: 5 },
  "/verify-email": { window: 60, max: 10 },
  "/change-password": { window: 600, max: 10 },
  "/change-email": { window: 600, max: 5 },
  "/two-factor/*": { window: 60, max: 10 },
  "/**": false,
} as const;

/**
 * Proxy hops stripped from the right of `X-Forwarded-For` before the client IP
 * is read. Production traffic reaches the dashboard through cloudflared and
 * kamal-proxy on the host's loopback and Docker networks, so every private or
 * loopback hop is infrastructure, and the first public address is the client.
 */
export const TRUSTED_PROXY_RANGES = [
  "127.0.0.0/8",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "::1/128",
  "fc00::/7",
];

/**
 * Rate limiting is always on in production. Outside production it is off by
 * default (local suites sign many accounts up from one loopback address) and a
 * suite opts in with `AUTH_RATE_LIMIT=enforce`; no setting can turn it off in
 * production.
 */
export const isAuthRateLimitEnabled = (env: NodeJS.ProcessEnv = process.env) =>
  isProductionEnv(env) || env.AUTH_RATE_LIMIT === "enforce";

/**
 * The signing secret. Outside production a fixed local secret keeps
 * development zero-config; production never falls back to it.
 */
export function resolveAuthSecret(env: NodeJS.ProcessEnv = process.env) {
  const configured = env.BETTER_AUTH_SECRET?.trim();

  if (configured) {
    return configured;
  }

  if (isProductionEnv(env)) {
    throw new Error("BETTER_AUTH_SECRET is required in production");
  }

  return LOCAL_AUTH_SECRET;
}

/** The bare address inside `Name <address>` or a plain address. */
export function mailAddress(value: string) {
  const match =
    /<([^<>\s]+)>\s*$/.exec(value) ?? /^\s*([^<>\s]+)\s*$/.exec(value);
  const address = match?.[1];

  if (!address || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) {
    return null;
  }

  return address.toLowerCase();
}

const domainOf = (address: string) => address.split("@").pop() ?? "";

const isHttpsOrLoopback = (url: URL) =>
  url.protocol === "https:" ||
  (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));

const parseUrl = (value: string) => {
  try {
    return new URL(value);
  } catch {
    return null;
  }
};

/**
 * Production preflight for the identity service. Every problem is collected so
 * one failed boot names all of them; values are never included, only names.
 *
 * - The signing secret is set, at least 32 characters and not the local one.
 * - The auth origin and every trusted origin use https. A loopback origin is
 *   accepted because it cannot serve anyone but the host itself (the release
 *   gate runs production builds on localhost); browsers treat it as secure.
 * - A cross-subdomain cookie domain covers the auth origin.
 * - The sender is an address on the SMTP account's own domain, which is the
 *   domain Purelymail has verified for that mailbox; a message from any other
 *   domain would be rejected or fail SPF/DKIM alignment.
 */
export function productionAuthConfigProblems(
  env: NodeJS.ProcessEnv = process.env,
) {
  const problems: string[] = [];
  const secret = env.BETTER_AUTH_SECRET?.trim() ?? "";

  if (!secret) {
    problems.push("BETTER_AUTH_SECRET is required");
  } else if (secret === LOCAL_AUTH_SECRET) {
    problems.push(
      "BETTER_AUTH_SECRET must not be the local development secret",
    );
  } else if (secret.length < MIN_SECRET_LENGTH) {
    problems.push(
      `BETTER_AUTH_SECRET must be at least ${MIN_SECRET_LENGTH} characters`,
    );
  }

  const baseUrl = parseUrl(env.BETTER_AUTH_URL?.trim() ?? "");

  if (!baseUrl) {
    problems.push("BETTER_AUTH_URL must be an absolute URL");
  } else if (!isHttpsOrLoopback(baseUrl)) {
    problems.push("BETTER_AUTH_URL must use https");
  }

  for (const origin of (env.ALLOWED_API_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)) {
    const parsed = parseUrl(origin);

    if (!parsed || !isHttpsOrLoopback(parsed)) {
      problems.push("ALLOWED_API_ORIGINS entries must be https origins");
      break;
    }
  }

  const cookieDomain = env.BETTER_AUTH_COOKIE_DOMAIN?.trim().replace(/^\./, "");

  if (cookieDomain && baseUrl) {
    const host = baseUrl.hostname;

    if (host !== cookieDomain && !host.endsWith(`.${cookieDomain}`)) {
      problems.push("BETTER_AUTH_COOKIE_DOMAIN must cover BETTER_AUTH_URL");
    }
  }

  const sender = mailAddress(resolveMailSender(env) ?? "");
  const smtpUser = mailAddress(env.SMTP_USER?.trim() ?? "");

  if (!sender) {
    problems.push("AUTH_EMAIL_FROM must be a valid sender address");
  } else if (!smtpUser) {
    problems.push("SMTP_USER must be the sending mailbox address");
  } else if (domainOf(sender) !== domainOf(smtpUser)) {
    problems.push("AUTH_EMAIL_FROM must be on the SMTP_USER mailbox's domain");
  }

  return problems;
}

export function assertProductionAuthConfig(
  env: NodeJS.ProcessEnv = process.env,
) {
  const problems = productionAuthConfigProblems(env);

  if (problems.length > 0) {
    throw new Error(
      `Identity service refusing to start in production: ${problems.join("; ")}`,
    );
  }
}
