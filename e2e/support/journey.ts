/**
 * The journey contract and the context every journey receives.
 *
 * A journey is one user flow driven against the RUNNING app (production
 * build, real database, stubbed providers). Journeys own their tenants: each
 * signs up its own users and workspaces with unique ids, so journeys run in
 * any order and in parallel. Every HTTP exchange is recorded to the journey's
 * `requests.json`; browser journeys also leave a Playwright `trace.zip` and
 * screenshots. Add a journey by dropping `<name>.journey.ts` into
 * `e2e/journeys/` and listing it on its features in `docs/feature-map.json`.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import type { DbQuery } from "../../scripts/verify/database";
import type { SmtpTrap } from "../../scripts/verify/lib";
import type { Stubs } from "./stubs";

export type Journey = {
  /** Kebab-case id; must equal the file name before `.journey.ts`. */
  id: string;
  name: string;
  /** Feature ids from docs/feature-map.json this journey covers. */
  features: string[];
  /** Drives the flow; throw to fail. Returns a one-line outcome. */
  run: (ctx: JourneyContext) => Promise<string>;
};

export type Tenant = {
  label: string;
  email: string;
  password: string;
  cookie: string;
  userId: string;
  teamId: string;
};

export type TraceEntry = {
  at: string;
  step: string;
  method: string;
  url: string;
  status: number;
  durationMs: number;
  request?: string;
  response?: string;
};

export type JourneyContext = {
  id: string;
  appOrigin: string;
  apiOrigin: string;
  websiteOrigin: string;
  /** This journey's evidence directory. */
  dir: string;
  /** Names the current step in the trace and on failure. */
  step: (name: string) => void;
  /** fetch() that records the exchange in requests.json. */
  http: (url: string, init?: RequestInit) => Promise<Response>;
  /** Read-only assertions against this run's database. */
  query: DbQuery;
  smtp: SmtpTrap;
  stubs: Stubs;
  /** The verification link emailed to `email` (waits for the SMTP trap). */
  verificationLink: (email: string) => Promise<string>;
  /** A unique address for this journey. */
  email: (label: string) => string;
  /** Signs up, verifies (through the emailed link) and signs in a new user. */
  tenant: (label: string) => Promise<Tenant>;
  trpcQuery: (
    tenant: Tenant,
    path: string,
    input?: unknown,
  ) => Promise<{ status: number; text: string; json: any }>;
  trpcMutation: (
    tenant: Tenant,
    path: string,
    input?: unknown,
  ) => Promise<{ status: number; text: string; json: any }>;
  /** A traced browser page (Playwright); the trace is saved after the run. */
  page: () => Promise<Page>;
  /** Saves a named screenshot of the current page into the evidence. */
  screenshot: (page: Page, name: string) => Promise<string>;
};

export const PASSWORD = "E2eJourneyPassword123!";
const MAX_BODY = 4000;

const clip = (text: string) =>
  text.length > MAX_BODY
    ? `${text.slice(0, MAX_BODY)}…[${text.length - MAX_BODY} more chars]`
    : text;

export function createJourneyContext(input: {
  id: string;
  dir: string;
  appOrigin: string;
  apiOrigin: string;
  websiteOrigin: string;
  query: DbQuery;
  smtp: SmtpTrap;
  stubs: Stubs;
  browser: () => Promise<Browser>;
  redact: (text: string) => string;
  /**
   * This journey's client address, sent as X-Forwarded-For (loopback is a
   * trusted proxy, as cloudflared is in production). Production rate limits
   * are per client IP, so each journey is its own client, like real users.
   */
  clientIp: string;
}) {
  const trace: TraceEntry[] = [];
  const screenshots: string[] = [];
  let currentStep = "start";
  let context: BrowserContext | undefined;
  let lastPage: Page | undefined;

  const describeBody = (body: RequestInit["body"]) => {
    if (body == null) return undefined;
    if (typeof body === "string") return clip(input.redact(body));
    if (body instanceof FormData) {
      return `[form-data: ${[...body.keys()].join(", ")}]`;
    }
    return "[binary body]";
  };

  const http = async (url: string, init: RequestInit = {}) => {
    const started = Date.now();
    const headers = new Headers(init.headers);
    if (!headers.has("x-forwarded-for")) {
      headers.set("x-forwarded-for", input.clientIp);
    }
    const response = await fetch(url, { redirect: "manual", ...init, headers });
    const type = response.headers.get("content-type") ?? "";
    let responseText: string | undefined;
    if (/json|text|html|csv/.test(type)) {
      responseText = clip(input.redact(await response.clone().text()));
    } else if (type) {
      responseText = `[${type}]`;
    }
    trace.push({
      at: new Date(started).toISOString(),
      step: currentStep,
      method: init.method ?? "GET",
      url: input.redact(url),
      status: response.status,
      durationMs: Date.now() - started,
      request: describeBody(init.body),
      response: responseText,
    });
    return response;
  };

  const trpc = async (
    tenant: Tenant,
    path: string,
    body: unknown,
    method: "GET" | "POST",
  ) => {
    const headers: Record<string, string> = {
      origin: input.appOrigin,
      cookie: tenant.cookie,
    };
    let url = `${input.apiOrigin}/trpc/${path}`;
    let requestBody: string | undefined;
    if (method === "GET") {
      if (body !== undefined) {
        url += `?input=${encodeURIComponent(JSON.stringify({ json: body }))}`;
      }
    } else {
      headers["content-type"] = "application/json";
      requestBody = JSON.stringify(body === undefined ? {} : { json: body });
    }
    const response = await http(url, { method, headers, body: requestBody });
    const text = await response.text();
    let json: any = null;
    try {
      json = JSON.parse(text)?.result?.data?.json ?? null;
    } catch {
      json = null;
    }
    return { status: response.status, text, json };
  };

  const cookieFrom = (response: Response) => {
    const cookies = response.headers.getSetCookie();
    const cookie =
      cookies.find((value) => value.includes("session_token")) ?? cookies[0];
    if (!cookie) throw new Error("sign-in issued no session cookie");
    return cookie.split(";")[0]!;
  };

  const verificationLink = async (email: string) => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const message = input.smtp.messages.find((candidate) =>
        candidate.recipients.includes(email),
      );
      if (message) {
        const decoded = message.raw
          .replace(/=\r?\n/g, "")
          .replace(/=3D/g, "=")
          .replace(/&amp;/g, "&");
        const link = decoded.match(
          /https?:\/\/[^\s"'<>]*verify-email[^\s"'<>]*/,
        )?.[0];
        if (link) return link;
      }
      await Bun.sleep(200);
    }
    throw new Error(`no verification email reached ${email}`);
  };

  const email = (label: string) =>
    `${input.id}-${label}-${crypto.randomUUID().slice(0, 8)}@example.test`;

  const tenant = async (label: string): Promise<Tenant> => {
    const address = email(label);
    currentStep = `sign up ${label}`;
    const signUp = await http(`${input.appOrigin}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: input.appOrigin },
      body: JSON.stringify({ email: address, password: PASSWORD, name: label }),
    });
    if (signUp.status !== 200) {
      throw new Error(
        `sign-up for ${label} failed with ${signUp.status}: ${await signUp.text()}`,
      );
    }
    currentStep = `verify email ${label}`;
    const link = await verificationLink(address);
    const verified = await http(link);
    if (verified.status >= 400) {
      throw new Error(`verification link returned ${verified.status}`);
    }
    currentStep = `sign in ${label}`;
    const signIn = await http(`${input.appOrigin}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: input.appOrigin },
      body: JSON.stringify({ email: address, password: PASSWORD }),
    });
    if (signIn.status !== 200) {
      throw new Error(
        `sign-in for ${label} failed with ${signIn.status}: ${await signIn.text()}`,
      );
    }
    const [row] = await input.query<{ id: string; team_id: string | null }>(
      "select id, team_id from users where email = $1",
      [address],
    );
    if (!row?.team_id) {
      throw new Error(`sign-up for ${label} did not provision a workspace`);
    }
    return {
      label,
      email: address,
      password: PASSWORD,
      cookie: cookieFrom(signIn),
      userId: row.id,
      teamId: row.team_id,
    };
  };

  const page = async () => {
    if (!context) {
      const browser = await input.browser();
      context = await browser.newContext({
        baseURL: input.appOrigin,
        viewport: { width: 1440, height: 900 },
      });
      // Only same-origin dashboard requests carry the client address: an
      // extra header on the browser's cross-origin API calls would fail CORS.
      await context.route(`${input.appOrigin}/**`, (route) =>
        route.continue({
          headers: {
            ...route.request().headers(),
            "x-forwarded-for": input.clientIp,
          },
        }),
      );
      await context.tracing.start({
        screenshots: true,
        snapshots: true,
        title: input.id,
      });
    }
    lastPage = await context.newPage();
    return lastPage;
  };

  const screenshot = async (target: Page, name: string) => {
    await mkdir(join(input.dir, "screenshots"), { recursive: true });
    const path = join(
      input.dir,
      "screenshots",
      `${String(screenshots.length + 1).padStart(2, "0")}-${name}.png`,
    );
    await target.screenshot({ path, fullPage: true });
    screenshots.push(path);
    return path;
  };

  const ctx: JourneyContext = {
    id: input.id,
    appOrigin: input.appOrigin,
    apiOrigin: input.apiOrigin,
    websiteOrigin: input.websiteOrigin,
    dir: input.dir,
    step: (name) => {
      currentStep = name;
    },
    http,
    query: input.query,
    smtp: input.smtp,
    stubs: input.stubs,
    verificationLink,
    email,
    tenant,
    trpcQuery: (t, path, body) => trpc(t, path, body, "GET"),
    trpcMutation: (t, path, body) => trpc(t, path, body, "POST"),
    page,
    screenshot,
  };

  /** Persists requests.json and the browser trace; returns artifact paths. */
  const finish = async (failed = false) => {
    if (failed && lastPage && !lastPage.isClosed()) {
      await screenshot(lastPage, "failure").catch(() => undefined);
    }
    await mkdir(input.dir, { recursive: true });
    const artifacts: string[] = [];
    const requestsPath = join(input.dir, "requests.json");
    await writeFile(
      requestsPath,
      input.redact(`${JSON.stringify(trace, null, 2)}\n`),
    );
    artifacts.push(requestsPath);
    if (context) {
      const tracePath = join(input.dir, "trace.zip");
      await context.tracing.stop({ path: tracePath }).catch(() => undefined);
      await context.close().catch(() => undefined);
      artifacts.push(tracePath);
    }
    artifacts.push(...screenshots);
    return {
      artifacts,
      currentStep: () => currentStep,
      requests: trace.length,
    };
  };

  return { ctx, finish, currentStep: () => currentStep };
}
