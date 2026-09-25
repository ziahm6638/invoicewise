/**
 * Shared helpers for the InvoiceWise release verification command.
 *
 * The verification run is deliberately isolated: every child process receives
 * an explicit environment with synthetic provider values, disposable service
 * targets and no implicit application `.env` loading. Nothing here reads or
 * writes development or production data.
 */

import { mkdirSync, readdirSync, symlinkSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export {
  type SmtpTrap,
  type SmtpTrapMessage,
  startSmtpTrap,
} from "../../packages/utils/src/smtp-trap";

export const ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

export const ARTIFACTS_ROOT = join(ROOT, ".verify-artifacts");

export const API_DIR = join(ROOT, "apps", "api");
export const DASHBOARD_DIR = join(ROOT, "apps", "dashboard");
export const WEBSITE_DIR = join(ROOT, "apps", "website");
export const DB_PACKAGE_DIR = join(ROOT, "packages", "db");
export const JOBS_DIR = join(ROOT, "packages", "jobs");

/**
 * Executables are bundled inside their own workspace package so the package
 * tsconfig path aliases (for example `@api/*`) resolve when the artifact runs.
 */
export const executablePath = (packageDir: string, name: string) =>
  join(packageDir, ".verify-artifacts", name);

/** Local, documented loopback service endpoints only. */
export const LOCAL_POSTGRES_BASE =
  process.env.VERIFY_POSTGRES_BASE ??
  "postgresql://invoicewise:invoicewise@localhost:5432";
export const LOCAL_REDIS_URL =
  process.env.VERIFY_REDIS_URL ?? "redis://127.0.0.1:6379/9";
export const LOCAL_MINIO_ENDPOINT =
  process.env.VERIFY_MINIO_ENDPOINT ?? "http://127.0.0.1:9000";
export const LOCAL_MINIO_ACCESS_KEY = "invoicewise";
export const LOCAL_MINIO_SECRET_KEY = "invoicewise-secret";
export const LOCAL_MINIO_BUCKET = "invoicewise";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

const SYNTHETIC_SECRETS = {
  BETTER_AUTH_SECRET: "invoicewise-verify-auth-secret-0123456789abcdef",
  MIDDAY_ENCRYPTION_KEY:
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  STORAGE_SIGNING_SECRET: "invoicewise-verify-storage-signing-secret",
  SMTP_PASS: "invoicewise-verify-smtp-password",
  POLAR_ACCESS_TOKEN: "polar_verify_stub",
  TYPESAFE_API_KEY: "ts_verify_stub",
  NANGO_SECRET_KEY: "nango_verify_stub",
  STORAGE_S3_SECRET_ACCESS_KEY: LOCAL_MINIO_SECRET_KEY,
  OPS_TOKEN: "invoicewise-verify-ops-token-0123456789abcdef",
} as const;

/** Operator token the verification API processes accept at /ops/metrics. */
export const VERIFY_OPS_TOKEN = SYNTHETIC_SECRETS.OPS_TOKEN;

/**
 * Provider/telemetry keys that must be defined-but-empty for verification
 * children. Bun and Next only apply `.env` values for keys that are not already
 * present, so defining them (even empty) means a developer's real `.env` can
 * never inject live provider configuration into a verification process.
 */
export const BLOCKED_PROVIDER_KEYS = [
  "DATABASE_FRA_URL",
  "DATABASE_SJC_URL",
  "DATABASE_IAD_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_KEY",
  "NEXT_PUBLIC_OPENPANEL_CLIENT_ID",
  "OPENPANEL_SECRET_KEY",
  "PLAIN_API_KEY",
  "GMAIL_CLIENT_ID",
  "GMAIL_CLIENT_SECRET",
  "GMAIL_REDIRECT_URI",
  "MISTRAL_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "POLAR_WEBHOOK_SECRET",
  // Resend only serves the optional marketing audience; transactional mail
  // goes to the loopback SMTP trap.
  "RESEND_API_KEY",
  "RESEND_AUDIENCE_ID",
  "NEXT_PUBLIC_SENTRY_DSN",
  "INVOICE_JWT_SECRET",
  "SENTRY_AUTH_TOKEN",
  "SENTRY_ORG",
  "SENTRY_PROJECT",
] as const;

export type StepResult = {
  name: string;
  commandLine: string;
  exitCode: number;
  durationMs: number;
  ok: boolean;
  expectedFailure: boolean;
  logPath: string;
  stdout: string;
  stderr: string;
  output: string;
  note?: string;
};

export type StepSpec = {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Milliseconds before the child is terminated. Defaults to 15 minutes. */
  timeoutMs?: number;
  /**
   * The command is required to exit non-zero (migration failure injection).
   * The step fails if it unexpectedly succeeds.
   */
  expectFailure?: boolean;
  /** Assertion run against captured output; the step fails when absent. */
  outputIncludes?: string;
  outputExcludes?: string;
  /**
   * Records the outcome without gating the run (used for the documented
   * inherited-gap baselines, which are then compared by a ratchet check).
   */
  allowFailure?: boolean;
};

export const isLoopbackHostname = (hostname: string) =>
  LOOPBACK_HOSTNAMES.has(hostname);

/** Fails before any side effect when a target is not a local loopback service. */
export function assertLoopbackUrl(label: string, rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    // Never echo the raw value: it may itself be a credential-shaped string.
    throw new Error(
      `${label} is not a valid URL (value withheld; ${rawUrl.length} characters)`,
    );
  }
  if (!isLoopbackHostname(parsed.hostname)) {
    throw new Error(
      `${label} must point at a loopback service, received host "${parsed.hostname}"`,
    );
  }
  return parsed;
}

const DISPOSABLE_DB_PATTERN = /^invoicewise_[a-z0-9_]+_test$/;
const PROTECTED_DATABASE_NAMES = new Set([
  "postgres",
  "template0",
  "template1",
  "invoicewise",
]);

/**
 * Disposable database names are validated before any create/reset so the
 * verification run can never drop a development or production database.
 */
export function assertDisposableDatabaseName(name: string): string {
  if (PROTECTED_DATABASE_NAMES.has(name)) {
    throw new Error(
      `refusing to touch a protected database name (${name.length} characters)`,
    );
  }
  if (!DISPOSABLE_DB_PATTERN.test(name)) {
    throw new Error(
      `refusing to touch a database name that does not match ${DISPOSABLE_DB_PATTERN} (value withheld)`,
    );
  }
  return name;
}

export function syntheticEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: process.env.HOME ?? "/tmp",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    LANG: "en_US.UTF-8",
    TERM: "dumb",
    CI: "1",
    // Test semantics for the verification suites (Better Auth only enables its
    // production rate limiter outside test/development). Production build and
    // production-entrypoint steps set NODE_ENV=production explicitly.
    NODE_ENV: "test",
    ...SYNTHETIC_SECRETS,
    // Every provider SDK that supports a base URL is pointed at the loopback
    // provider trap. The jobs verifiers replace theirs with their own loopback
    // stubs; nothing can dial a paid provider.
    TYPESAFE_BASE_URL: providerStubBaseUrl,
    TYPESAFE_MODEL: "verify-stub",
    NANGO_BASE_URL: providerStubBaseUrl,
    POLAR_SERVER_URL: providerStubBaseUrl,
    POLAR_ENVIRONMENT: "sandbox",
    // Transactional mail is fully configured, but only against the loopback
    // SMTP trap: production-mode steps ignore AUTH_MAIL_SINK_PATH and send.
    SMTP_HOST: SMTP_TRAP_HOST,
    SMTP_PORT: String(smtpTrapPort),
    SMTP_USER: "verify@localhost.test",
    AUTH_EMAIL_FROM: "InvoiceWise Verify <verify@localhost.test>",
    LOG_LEVEL: "info",
    BETTER_AUTH_URL: "http://localhost:31990",
    NEXT_PUBLIC_URL: "http://localhost:31990",
    NEXT_PUBLIC_API_URL: "http://localhost:31991",
    REDIS_URL: LOCAL_REDIS_URL,
    STORAGE_BACKEND: "local",
    LOCAL_STORAGE_PATH: join(ARTIFACTS_ROOT, "tmp", "storage"),
    STORAGE_PUBLIC_URL: "http://localhost:31991",
    STORAGE_S3_ENDPOINT: LOCAL_MINIO_ENDPOINT,
    STORAGE_S3_BUCKET: LOCAL_MINIO_BUCKET,
    STORAGE_S3_ACCESS_KEY_ID: LOCAL_MINIO_ACCESS_KEY,
    STORAGE_S3_REGION: "us-east-1",
    STORAGE_S3_FORCE_PATH_STYLE: "true",
    WORKFLOW_RETRY_BASE_MS: "10",
    WORKFLOW_RETRY_MAX_MS: "20",
    NEXT_TELEMETRY_DISABLED: "1",
  };

  for (const key of BLOCKED_PROVIDER_KEYS) {
    env[key] = "";
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }

  return env;
}

let providerStubBaseUrl = "http://127.0.0.1:9";

const SMTP_TRAP_HOST = "127.0.0.1";
/** A closed loopback port until the verifier starts its SMTP trap. */
let smtpTrapPort = 9;

/** Points every supported provider SDK base URL at the loopback trap. */
export function setProviderStubBaseUrl(url: string) {
  const parsed = assertLoopbackUrl("provider stub base URL", url);
  providerStubBaseUrl = parsed.origin;
}

export const providerStubOrigin = () => providerStubBaseUrl;

/** Points SMTP_PORT at the verifier's loopback SMTP trap. */
export function setSmtpTrapPort(port: number) {
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`SMTP trap port must be a TCP port, received ${port}`);
  }
  smtpTrapPort = port;
}

/**
 * Verification must never be able to reach a live provider or a shared
 * service. This runs before the first command and fails fast on any override
 * that would leave the machine or touch a real credential.
 */
export function assertSyntheticEnvironment(env: Record<string, string>) {
  const providerUrls = [
    "TYPESAFE_BASE_URL",
    "NANGO_BASE_URL",
    "POLAR_SERVER_URL",
  ] as const;
  for (const key of providerUrls) {
    const value = env[key];
    if (!value) {
      throw new Error(`${key} must be set to a closed loopback URL`);
    }
    assertLoopbackUrl(key, value);
  }

  const smtpHost = env.SMTP_HOST ?? "";
  if (!isLoopbackHostname(smtpHost)) {
    throw new Error(
      `SMTP_HOST must be the loopback SMTP trap, received host "${smtpHost}"`,
    );
  }
  if (!/^\d+$/.test(env.SMTP_PORT ?? "")) {
    throw new Error("SMTP_PORT must be the loopback SMTP trap port");
  }

  for (const key of BLOCKED_PROVIDER_KEYS) {
    if (env[key] !== "") {
      throw new Error(
        `${key} must be defined-but-empty so a real .env value cannot be injected`,
      );
    }
  }

  const expectedSecrets: Record<string, string> = {
    SMTP_PASS: SYNTHETIC_SECRETS.SMTP_PASS,
    POLAR_ACCESS_TOKEN: SYNTHETIC_SECRETS.POLAR_ACCESS_TOKEN,
    TYPESAFE_API_KEY: SYNTHETIC_SECRETS.TYPESAFE_API_KEY,
    NANGO_SECRET_KEY: SYNTHETIC_SECRETS.NANGO_SECRET_KEY,
  };
  for (const [key, expected] of Object.entries(expectedSecrets)) {
    if (env[key] !== expected) {
      throw new Error(
        `${key} must be the synthetic verification value (no live provider credentials)`,
      );
    }
  }

  const databaseUrl = env.DATABASE_PRIMARY_URL;
  if (databaseUrl) {
    const parsed = assertLoopbackUrl("DATABASE_PRIMARY_URL", databaseUrl);
    assertDisposableDatabaseName(parsed.pathname.replace(/^\//, ""));
  }

  assertLoopbackUrl("REDIS_URL", env.REDIS_URL ?? "");
  assertLoopbackUrl("STORAGE_S3_ENDPOINT", env.STORAGE_S3_ENDPOINT ?? "");
}

const SECRET_PATTERNS: [RegExp, string][] = [
  [
    /postgres(?:ql)?:\/\/([^:@/\s]+):([^@/\s]+)@/g,
    "postgresql://$1:[redacted]@",
  ],
  [/\bre_[A-Za-z0-9_]{12,}/g, "[redacted-resend-key]"],
  [/\bSMTP_PASS=[^\s"']+/g, "SMTP_PASS=[redacted]"],
  [/\bpolar_[A-Za-z0-9_]{8,}/g, "[redacted-polar-token]"],
  [/\bnango_[A-Za-z0-9_]{8,}/g, "[redacted-nango-key]"],
  [/\bts_[A-Za-z0-9_]{8,}/g, "[redacted-typesafe-key]"],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "[redacted-api-key]"],
  [/Bearer\s+[A-Za-z0-9._-]{16,}/g, "Bearer [redacted]"],
  [/signature=[A-Za-z0-9%._-]{16,}/g, "signature=[redacted]"],
  [
    /(__Secure-)?better-auth[.-][\w-]*=[^\s;"']+/g,
    "better-auth-cookie=[redacted]",
  ],
];

export function redact(text: string): string {
  let output = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    output = output.replace(pattern, replacement);
  }
  for (const secret of Object.values(SYNTHETIC_SECRETS)) {
    if (secret.length >= 12) {
      output = output.split(secret).join("[redacted]");
    }
  }
  return output;
}

const MAX_CAPTURED_OUTPUT = 4 * 1024 * 1024;

/**
 * Step names use `group:step`; CI's artifact upload rejects `:` in file names,
 * so log files use `_` instead.
 */
const logFileName = (name: string) => name.replaceAll(":", "_");

export class VerificationAborted extends Error {
  readonly stepName: string;
  readonly detail?: string;

  constructor(stepName: string, detail?: string) {
    const safeStep = redact(stepName);
    const safeDetail = detail ? redact(detail) : undefined;
    super(
      `verification aborted at "${safeStep}"${safeDetail ? `: ${safeDetail}` : ""}`,
    );
    this.name = "VerificationAborted";
    this.stepName = safeStep;
    this.detail = safeDetail;
  }
}

export class Verification {
  readonly artifactsDir: string;
  readonly results: StepResult[] = [];
  private readonly cleanupFns: { name: string; fn: () => Promise<void> }[] = [];
  private stepIndex = 0;

  constructor(runId: string) {
    this.artifactsDir = join(ARTIFACTS_ROOT, runId);
  }

  get tmpDir() {
    return join(this.artifactsDir, "tmp");
  }

  /** Stable, unique log path for a long-running managed process. */
  logPathFor(name: string) {
    return join(this.artifactsDir, "logs", `process-${logFileName(name)}.log`);
  }

  async init() {
    await mkdir(join(this.artifactsDir, "logs"), { recursive: true });
    await mkdir(this.tmpDir, { recursive: true });
  }

  private async ensureArtifactDirs() {
    await mkdir(join(this.artifactsDir, "logs"), { recursive: true });
  }

  onCleanup(name: string, fn: () => Promise<void>) {
    this.cleanupFns.push({ name, fn });
  }

  get failures() {
    return this.results.filter((result) => !result.ok);
  }

  async runStep(name: string, spec: StepSpec): Promise<StepResult> {
    await this.ensureArtifactDirs();
    const index = String(this.stepIndex++).padStart(3, "0");
    const startedAt = Date.now();
    const cwd = spec.cwd ?? ROOT;
    const env = spec.env ?? syntheticEnv();
    const args = spec.args ?? [];
    const commandLine = [spec.command, ...args].join(" ");
    const logPath = join(
      this.artifactsDir,
      "logs",
      `${index}-${logFileName(name)}.log`,
    );

    const child = Bun.spawn({
      cmd: [spec.command, ...args],
      cwd,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    const timeoutMs = spec.timeoutMs ?? 15 * 60 * 1000;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000);
    }, timeoutMs);

    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const exitCode = await child.exited;
    clearTimeout(timer);

    const durationMs = Date.now() - startedAt;
    const redactedStdout = redact(stdout).slice(-MAX_CAPTURED_OUTPUT);
    const redactedStderr = redact(stderr).slice(-MAX_CAPTURED_OUTPUT);
    const combined = redact(`${stdout}${stderr}`).slice(-MAX_CAPTURED_OUTPUT);
    await writeFile(
      logPath,
      `# ${commandLine}\n# cwd ${cwd}\n# exit ${exitCode}${
        timedOut ? " (timeout)" : ""
      }\n\n${combined}\n`,
    );

    let ok = spec.expectFailure ? exitCode !== 0 : exitCode === 0;
    let note: string | undefined;
    if (timedOut) {
      ok = false;
      note = `timed out after ${timeoutMs}ms`;
    } else if (spec.expectFailure && exitCode === 0) {
      note = "expected a non-zero exit from the injected fault";
    }
    if (ok && spec.outputIncludes && !combined.includes(spec.outputIncludes)) {
      ok = false;
      note = `missing expected output: ${spec.outputIncludes}`;
    }
    if (ok && spec.outputExcludes && combined.includes(spec.outputExcludes)) {
      ok = false;
      note = `unexpected output: ${spec.outputExcludes}`;
    }
    if (spec.allowFailure) {
      ok = !timedOut;
      if (timedOut) note = `timed out after ${timeoutMs}ms`;
    }

    const result: StepResult = {
      name,
      commandLine,
      exitCode,
      durationMs,
      ok,
      expectedFailure: Boolean(spec.expectFailure),
      logPath,
      stdout: redactedStdout,
      stderr: redactedStderr,
      output: combined,
      note: note ? redact(note) : undefined,
    };
    this.results.push(result);
    this.report(result);
    return result;
  }

  /**
   * Records an in-process assertion (schema checks, database invariants) as a
   * first-class verification step so failures are visible and logged with the
   * same evidence trail as external commands.
   */
  async runCheck(
    name: string,
    fn: () => Promise<string | undefined>,
  ): Promise<StepResult> {
    await this.ensureArtifactDirs();
    const index = String(this.stepIndex++).padStart(3, "0");
    const startedAt = Date.now();
    const logPath = join(
      this.artifactsDir,
      "logs",
      `${index}-${logFileName(name)}.log`,
    );
    let ok = true;
    let note: string | undefined;
    let output = "";
    try {
      const detail = await fn();
      if (detail) output = detail;
    } catch (error) {
      ok = false;
      output =
        error instanceof Error ? (error.stack ?? error.message) : String(error);
      note = error instanceof Error ? error.message : String(error);
    }

    const result: StepResult = {
      name,
      commandLine: `check: ${name}`,
      exitCode: ok ? 0 : 1,
      durationMs: Date.now() - startedAt,
      ok,
      expectedFailure: false,
      logPath,
      stdout: redact(output),
      stderr: "",
      output: redact(output),
      note: note ? redact(note) : undefined,
    };
    await writeFile(logPath, `# ${result.commandLine}\n\n${result.output}\n`);
    this.results.push(result);
    this.report(result);
    return result;
  }

  /**
   * A safety precondition. Unlike `runCheck` it aborts the run immediately, so
   * a rejected target can never reach a later process, database or build step.
   */
  async requireCheck(
    name: string,
    fn: () => Promise<string | undefined>,
  ): Promise<StepResult> {
    const result = await this.runCheck(name, fn);
    if (!result.ok) {
      throw new VerificationAborted(name, result.note);
    }
    return result;
  }

  private report(result: StepResult) {
    const seconds = (result.durationMs / 1000).toFixed(1);
    const note = result.note ? ` - ${redact(result.note)}` : "";
    if (result.ok && result.exitCode !== 0) {
      console.log(
        `[note] ${result.name} (${seconds}s, exit ${result.exitCode}, recorded baseline)`,
      );
      return;
    }
    if (result.ok) {
      console.log(`[ok]   ${result.name} (${seconds}s)`);
      return;
    }
    console.error(
      `[FAIL] ${result.name} (${seconds}s, exit ${result.exitCode})${note}`,
    );
    const tail = result.output.trimEnd().split("\n").slice(-25).join("\n");
    if (tail) console.error(tail);
    console.error(`       full log: ${result.logPath}`);
  }

  async cleanup() {
    for (const entry of [...this.cleanupFns].reverse()) {
      try {
        await entry.fn();
      } catch (error) {
        console.error(
          `[warn] cleanup failed for ${entry.name}: ${redact(
            error instanceof Error ? error.message : String(error),
          )}`,
        );
      }
    }
  }

  async writeSummary(extra: Record<string, unknown>) {
    const payload = {
      generatedAt: new Date().toISOString(),
      bun: Bun.version,
      platform: `${process.platform}-${process.arch}`,
      steps: this.results.map((result) => ({
        name: result.name,
        command: result.commandLine,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        ok: result.ok,
        note: result.note,
        log: result.logPath.replace(`${ROOT}/`, ""),
      })),
      ...extra,
    };
    // Redact the serialized summary as well as the individual fields: any
    // credential-shaped text that reached a note, error or step name must not
    // be persisted.
    await writeFile(
      join(this.artifactsDir, "summary.json"),
      redact(`${JSON.stringify(payload, null, 2)}\n`),
    );
    return payload;
  }
}

export async function waitForHttp(
  url: string,
  predicate: (response: Response) => boolean,
  label: string,
  timeoutMs = 60_000,
) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (predicate(response)) return response;
      lastError = `status ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await Bun.sleep(250);
  }
  throw new Error(`${label} did not become ready: ${lastError}`);
}

/**
 * A long-running process (API executable, worker, Next.js server) whose output
 * is captured for the redacted evidence trail and which is always stopped
 * during cleanup.
 */
export class ManagedProcess {
  private readonly chunks: string[] = [];
  private readonly readers: Promise<void>[] = [];
  private exited = false;
  private exitCode: number | null = null;
  private persisted = false;
  private escalated = false;

  private constructor(
    readonly name: string,
    private readonly child: Bun.Subprocess<"ignore", "pipe", "pipe">,
    readonly logPath: string,
  ) {
    const collect = async (stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        this.chunks.push(decoder.decode(value, { stream: true }));
        if (this.chunks.length > 4000) this.chunks.splice(0, 2000);
      }
    };
    this.readers.push(collect(child.stdout), collect(child.stderr));
    void child.exited.then((code) => {
      this.exited = true;
      this.exitCode = code;
      void this.persist();
    });
  }

  static async start(
    v: Verification,
    name: string,
    spec: StepSpec,
  ): Promise<ManagedProcess> {
    const logPath = v.logPathFor(name);
    const child = Bun.spawn({
      cmd: [spec.command, ...(spec.args ?? [])],
      cwd: spec.cwd ?? ROOT,
      env: spec.env ?? syntheticEnv(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const process_ = new ManagedProcess(name, child, logPath);
    v.onCleanup(name, () => process_.stop());
    return process_;
  }

  get output() {
    return this.chunks.join("");
  }

  get running() {
    return !this.exited;
  }

  get stoppedWithCode() {
    return this.exitCode;
  }

  /** True when the process exited on SIGTERM without a SIGKILL escalation. */
  get stoppedGracefully() {
    return this.exited && !this.escalated;
  }

  async waitForOutput(pattern: string, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.output.includes(pattern)) return true;
      if (this.exited) return false;
      await Bun.sleep(200);
    }
    return this.output.includes(pattern);
  }

  async stop(signal: "SIGTERM" | "SIGKILL" = "SIGTERM") {
    if (!this.exited) {
      this.child.kill(signal);
      const deadline = Date.now() + 8000;
      while (!this.exited && Date.now() < deadline) {
        await Bun.sleep(100);
      }
      if (!this.exited) {
        this.escalated = true;
        this.child.kill("SIGKILL");
        await this.child.exited;
      }
    }
    await this.persist();
  }

  private async persist() {
    if (this.persisted) return;
    this.persisted = true;
    await Promise.all(this.readers);
    await writeFile(this.logPath, redact(this.output));
  }
}

export type ProviderTrapRequest = { method: string; path: string; at: string };

export type ProviderTrap = {
  origin: string;
  requests: ProviderTrapRequest[];
  requestCount: () => number;
  stop: () => void;
};

/**
 * Reserves one free loopback TCP port for a product server.
 *
 * Verification runs must not collide when two worktrees run at once, so app
 * servers no longer bind fixed ports: a run asks for a free port here and
 * passes it to the child through its environment. A `VERIFY_*_PORT` override
 * pins a port when a caller needs one.
 */
export async function freePort(): Promise<number> {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(null, { status: 204 }),
  });
  const port = server.port;
  await server.stop(true);
  if (port === undefined) {
    throw new Error("could not reserve a free verification port");
  }
  return port;
}

/**
 * Loopback stub for every provider SDK base URL. Providers that support a base
 * URL override are redirected here, so a verification run cannot reach a paid
 * endpoint even by accident; the recorded requests are part of the evidence.
 */
export function startProviderTrap(): ProviderTrap {
  const requests: ProviderTrapRequest[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      requests.push({
        method: request.method,
        path: url.pathname,
        at: new Date().toISOString(),
      });
      return Response.json({ id: `verify-stub-${requests.length}` });
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    requests,
    requestCount: () => requests.length,
    stop: () => server.stop(true),
  };
}

export type IsolatedWorkspace = {
  root: string;
  path: (relativePath: string) => string;
  skippedEnvFiles: string[];
  linkedEntries: number;
};

const WORKSPACE_EXCLUDED_DIRS = new Set([
  ".next",
  ".turbo",
  ".verify-artifacts",
  ".vercel",
  "dist",
  "build",
  "coverage",
  "storybook-static",
]);

/**
 * Builds a real directory tree whose entries are symlinks into the repository,
 * with every `.env*` file excluded. Because the directories themselves are real
 * directories (not symlinks), `process.cwd()` and dotenv lookup resolve inside
 * this overlay: Bun and Next cannot load any developer `.env`, while source,
 * config and lockfiles are the working tree's own bytes.
 */
export function createIsolatedWorkspace(
  targetRoot: string,
  sourceRoot: string,
): IsolatedWorkspace {
  const skippedEnvFiles: string[] = [];
  let linkedEntries = 0;

  const walk = (relative: string) => {
    const sourceDir = join(sourceRoot, relative);
    const targetDir = join(targetRoot, relative);
    mkdirSync(targetDir, { recursive: true });

    for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
      const name = entry.name;
      const childRelative = relative ? join(relative, name) : name;

      if (name.startsWith(".env")) {
        skippedEnvFiles.push(childRelative);
        continue;
      }
      if (entry.isDirectory()) {
        if (WORKSPACE_EXCLUDED_DIRS.has(name)) continue;
        if (name === "node_modules" || name === ".git") {
          symlinkSync(join(sourceDir, name), join(targetDir, name));
          linkedEntries += 1;
          continue;
        }
        walk(childRelative);
        continue;
      }
      symlinkSync(join(sourceDir, name), join(targetDir, name));
      linkedEntries += 1;
    }
  };

  walk("");

  return {
    root: targetRoot,
    path: (relativePath: string) =>
      relativePath ? join(targetRoot, relativePath) : targetRoot,
    skippedEnvFiles: skippedEnvFiles.sort(),
    linkedEntries,
  };
}

/**
 * The public health contract and operator diagnostics of a running API:
 * readiness and liveness answer only `{"status":"ok"}`, the inherited pool
 * and database diagnostics are gone, and `/ops/metrics` refuses anonymous
 * callers but serves real aggregates to the operator token.
 */
export async function assertHealthContract(origin: string) {
  for (const path of ["/health", "/health/ready", "/health/live"]) {
    const response = await fetch(`${origin}${path}`);
    const body = await response.text();
    if (response.status !== 200 || body !== '{"status":"ok"}') {
      throw new Error(`${path} returned ${response.status} ${body}`);
    }
  }
  for (const path of ["/health/db", "/health/pools"]) {
    const response = await fetch(`${origin}${path}`);
    const body = await response.text();
    if (response.status < 400 || /pool|timing|region/i.test(body)) {
      throw new Error(`${path} is still public (${response.status})`);
    }
  }
  const anonymous = await fetch(`${origin}/ops/metrics`);
  if (anonymous.status !== 401) {
    throw new Error(
      `/ops/metrics without a token returned ${anonymous.status}`,
    );
  }
  const operator = await fetch(`${origin}/ops/metrics`, {
    headers: { authorization: `Bearer ${VERIFY_OPS_TOKEN}` },
  });
  const metrics = (await operator.json().catch(() => null)) as {
    database?: { ok?: boolean };
    queue?: unknown;
    alerts?: unknown;
  } | null;
  if (
    operator.status !== 200 ||
    metrics?.database?.ok !== true ||
    !Array.isArray(metrics.queue) ||
    !Array.isArray(metrics.alerts)
  ) {
    throw new Error(`/ops/metrics returned ${operator.status}`);
  }
}
