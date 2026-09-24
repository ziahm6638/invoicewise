/**
 * InvoiceWise authoritative release verification.
 *
 *   bun run verify                 # full local release gate
 *   bun run verify --migrations-only
 *   bun run verify --security-only
 *   bun run verify --e2e-only
 *   bun run verify --preflight-only
 *
 * The command is reproducible and isolated: every product process runs inside a
 * symlink overlay of the repository that contains no `.env` file, every
 * provider SDK base URL points at a loopback trap, transactional mail goes to a
 * loopback SMTP trap, databases are validated as disposable loopback targets
 * before they are created or reset, and a failed safety precondition aborts
 * before any process or database effect.
 */

import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  connectDisposableDatabase,
  databaseUrl,
  dropDisposableDatabase,
  resetDisposableDatabase,
} from "./database";
import { runDependencyRangeCheck } from "./dependency-ranges";
import { E2E_DATABASE, runProductionE2E } from "./e2e";
import {
  ARTIFACTS_ROOT,
  BLOCKED_PROVIDER_KEYS,
  type IsolatedWorkspace,
  LOCAL_MINIO_ENDPOINT,
  LOCAL_REDIS_URL,
  ManagedProcess,
  type ProviderTrap,
  ROOT,
  type SmtpTrap,
  Verification,
  VerificationAborted,
  assertDisposableDatabaseName,
  assertLoopbackUrl,
  assertSyntheticEnvironment,
  createIsolatedWorkspace,
  executablePath,
  redact,
  setProviderStubBaseUrl,
  setSmtpTrapPort,
  startProviderTrap,
  startSmtpTrap,
  syntheticEnv,
  waitForHttp,
} from "./lib";
import {
  FRESH_DATABASE,
  RECOVERY_DATABASE,
  UPGRADE_DATABASE,
  runMigrationVerification,
} from "./migrations";
import { ensurePrivateBucket } from "./minio";
import { parseRetiredMatchingOutcome } from "./scopes";
import { runDependencyCheck, runSecretScan } from "./security";

const flags = new Set(process.argv.slice(2));
const migrationsOnly = flags.has("--migrations-only");
const securityOnly = flags.has("--security-only");
const e2eOnly = flags.has("--e2e-only");
const preflightOnly = flags.has("--preflight-only");

const SMOKE_DATABASE = "invoicewise_verify_smoke_test";
const PERMISSIONS_DATABASE = "invoicewise_perms_test";
const INTAKE_DATABASE = "invoicewise_intake_test";
const IDENTITY_DATABASE = "invoicewise_identity_test";
const JOBS_DATABASE = "invoicewise_jobs_verify_test";
const API_SMOKE_PORT = 31992;
const DASHBOARD_PORT = 31990;

const runId = new Date().toISOString().replace(/[:.]/g, "-");
const v = new Verification(runId);

let workspace: IsolatedWorkspace;
let providerTrap: ProviderTrap;
let smtpTrap: SmtpTrap;

/** Builds and validates the environment for one command. */
function env(overrides: Record<string, string | undefined> = {}) {
  const built = syntheticEnv(overrides);
  assertSyntheticEnvironment(built);
  return built;
}

/** Workspace path for a repository-relative location. */
const ws = (relativePath = "") => workspace.path(relativePath);

const DB_PACKAGE_DIR = "packages/db";
const API_DIR = "apps/api";
const DASHBOARD_DIR = "apps/dashboard";
const WEBSITE_DIR = "apps/website";
const JOBS_DIR = "packages/jobs";

const migrateSpec = (database: string) => ({
  command: "bun",
  args: ["--no-env-file", "x", "drizzle-kit", "migrate"],
  cwd: ws(DB_PACKAGE_DIR),
  env: env({ DATABASE_PRIMARY_URL: databaseUrl(database) }),
});

async function tcpReachable(host: string, port: number, timeoutMs = 3000) {
  let socket: { end: () => void } | undefined;
  try {
    const result = await Promise.race([
      Bun.connect({
        hostname: host,
        port,
        socket: { data() {}, open() {}, close() {} },
      }),
      Bun.sleep(timeoutMs).then(() => undefined),
    ]);
    if (!result) return false;
    socket = result as unknown as { end: () => void };
    return true;
  } catch {
    return false;
  } finally {
    socket?.end();
  }
}

/** Reads the first line an SMTP server sends, then closes the connection. */
async function smtpGreeting(host: string, port: number, timeoutMs = 3000) {
  let received = "";
  let resolveGreeting: (line: string) => void = () => {};
  const greeting = new Promise<string>((resolve) => {
    resolveGreeting = resolve;
  });
  const socket = await Bun.connect({
    hostname: host,
    port,
    socket: {
      data(_socket, chunk) {
        received += chunk.toString();
        const end = received.indexOf("\r\n");
        if (end !== -1) resolveGreeting(received.slice(0, end));
      },
      close() {
        resolveGreeting(received);
      },
    },
  });
  try {
    return await Promise.race([
      greeting,
      Bun.sleep(timeoutMs).then(() => received),
    ]);
  } finally {
    socket.write("QUIT\r\n");
    socket.end();
  }
}

/**
 * Runs a bun child that asks Next's own env loader which dotenv files it would
 * read for a directory. Used to prove both that the probe is sensitive and that
 * the isolated workspace exposes no dotenv file.
 */
async function probeNextEnvFiles(
  directory: string,
  runEnv: Record<string, string>,
  dev: boolean,
) {
  const script = `
    const { loadEnvConfig } = require("@next/env");
    const result = loadEnvConfig(process.cwd(), ${dev ? "true" : "false"});
    console.log(JSON.stringify({
      files: result.loadedEnvFiles.map((file) => file.path),
      canary: process.env.VERIFY_CANARY_MARKER ?? null,
      above: process.env.VERIFY_CANARY_ABOVE_MARKER ?? null,
    }));
  `;
  const child = Bun.spawn({
    cmd: ["bun", "--no-env-file", "-e", script],
    cwd: directory,
    env: runEnv,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`Next env probe failed in ${directory}: ${stderr}`);
  }
  const line = stdout.trim().split("\n").pop() ?? "";
  return JSON.parse(line) as {
    files: string[];
    canary: string | null;
    above: string | null;
  };
}

async function preflight() {
  await v.requireCheck("preflight:isolated-synthetic-environment", async () => {
    const checked = env();
    for (const name of [
      SMOKE_DATABASE,
      PERMISSIONS_DATABASE,
      INTAKE_DATABASE,
      IDENTITY_DATABASE,
      JOBS_DATABASE,
      FRESH_DATABASE,
      UPGRADE_DATABASE,
      RECOVERY_DATABASE,
      E2E_DATABASE,
    ]) {
      assertDisposableDatabaseName(name);
    }

    for (const rejected of ["invoicewise", "postgres", "template1", "appdb"]) {
      let threw = false;
      try {
        assertDisposableDatabaseName(rejected);
      } catch {
        threw = true;
      }
      if (!threw) {
        throw new Error(`disposable-name guard accepted "${rejected}"`);
      }
    }

    for (const rejected of [
      "https://api.resend.com",
      "smtp://smtp.purelymail.com:465",
      "https://api.typesafe.ai",
      "postgresql://db.example.com:5432/invoicewise_x_test",
    ]) {
      let threw = false;
      try {
        assertLoopbackUrl("probe", rejected);
      } catch {
        threw = true;
      }
      if (!threw) {
        throw new Error(`loopback guard accepted "${rejected}"`);
      }
    }

    for (const [label, url] of [
      ["DATABASE_PRIMARY_URL", databaseUrl(SMOKE_DATABASE)],
      ["REDIS_URL", LOCAL_REDIS_URL],
      ["STORAGE_S3_ENDPOINT", LOCAL_MINIO_ENDPOINT],
      ["provider stub", providerTrap.origin],
      ["SMTP", `smtp://${checked.SMTP_HOST}:${checked.SMTP_PORT}`],
    ] as const) {
      assertLoopbackUrl(label, url);
    }
    if (checked.SMTP_PORT !== String(smtpTrap.port)) {
      throw new Error("SMTP_PORT does not point at the verifier's SMTP trap");
    }

    return `loopback-only targets; ${BLOCKED_PROVIDER_KEYS.length} provider/telemetry keys pinned empty; all provider base URLs point at ${providerTrap.origin}; SMTP points at ${smtpTrap.host}:${smtpTrap.port}`;
  });

  await v.requireCheck("preflight:provider-trap-loopback", async () => {
    if (providerTrap.requestCount() !== 0) {
      throw new Error("provider trap received traffic before the gate started");
    }
    const probe = await fetch(`${providerTrap.origin}/probe/stub`);
    if (probe.status !== 200) {
      throw new Error(`provider trap answered with ${probe.status}`);
    }
    if (providerTrap.requestCount() !== 1) {
      throw new Error("provider trap did not record the probe request");
    }
    return `loopback provider trap answers and records requests (${providerTrap.origin})`;
  });

  await v.requireCheck("preflight:smtp-trap-loopback", async () => {
    const trafficBeforeGate = smtpTrap.connections + smtpTrap.messages.length;
    if (trafficBeforeGate !== 0) {
      throw new Error("SMTP trap received traffic before the gate started");
    }
    const greeting = await smtpGreeting(smtpTrap.host, smtpTrap.port);
    if (!greeting.startsWith("220 ")) {
      throw new Error(`SMTP trap greeted with "${greeting.slice(0, 40)}"`);
    }
    if (smtpTrap.connections !== 1) {
      throw new Error("SMTP trap did not record the probe connection");
    }
    // The summary then counts product mail only.
    smtpTrap.reset();
    return `loopback SMTP trap answers and records connections (${smtpTrap.host}:${smtpTrap.port})`;
  });

  await v.requireCheck("preflight:canary-dotenv-ignored", async () => {
    const canarySource = join(v.tmpDir, "canary-source");
    await mkdir(join(canarySource, "apps", "app"), { recursive: true });
    // Sensitivity: dotenv files at the app directory and at the workspace root
    // are both read by Next's loader when they exist.
    await writeFile(
      join(canarySource, ".env"),
      "VERIFY_CANARY_ROOT_MARKER=loaded\n",
    );
    await writeFile(
      join(canarySource, "apps", "app", ".env"),
      "VERIFY_CANARY_MARKER=loaded\n",
    );
    await writeFile(join(canarySource, "apps", "app", "keep.txt"), "keep\n");
    await writeFile(join(canarySource, "package.json"), "{}\n");

    const canaryOverlay = createIsolatedWorkspace(
      join(v.tmpDir, "canary-overlay"),
      canarySource,
    );
    if (canaryOverlay.skippedEnvFiles.length !== 2) {
      throw new Error(
        `canary overlay did not exclude both canary .env files: ${JSON.stringify(canaryOverlay.skippedEnvFiles)}`,
      );
    }

    for (const dev of [true, false]) {
      const sensitive = await probeNextEnvFiles(
        join(canarySource, "apps", "app"),
        env(),
        dev,
      );
      if (sensitive.canary !== "loaded" || sensitive.files.length === 0) {
        throw new Error(
          `Next env probe is not sensitive (dev=${dev}): ${JSON.stringify(sensitive)}`,
        );
      }
    }

    for (const dev of [true, false]) {
      const isolated = await probeNextEnvFiles(
        join(canaryOverlay.root, "apps", "app"),
        env(),
        dev,
      );
      if (isolated.canary !== null || isolated.files.length !== 0) {
        throw new Error(
          `isolated overlay still exposed dotenv (dev=${dev}): ${JSON.stringify(isolated)}`,
        );
      }
    }

    // A dotenv file above the overlay (where the real repository root sits)
    // must not be reachable from the isolated workspace either.
    await writeFile(
      join(v.artifactsDir, ".env"),
      "VERIFY_CANARY_ABOVE_MARKER=loaded\n",
    );

    for (const dev of [true, false]) {
      const appProbe = await probeNextEnvFiles(ws(DASHBOARD_DIR), env(), dev);
      if (
        appProbe.canary !== null ||
        appProbe.above !== null ||
        appProbe.files.length !== 0
      ) {
        throw new Error(
          `verification workspace loaded dotenv (dev=${dev}): ${JSON.stringify(appProbe)}`,
        );
      }
    }

    if (workspace.skippedEnvFiles.length === 0) {
      throw new Error(
        "workspace overlay reported no skipped .env entries; isolation is not proven",
      );
    }

    return `Next env loader is dotenv-sensitive (control loaded a canary) while the verification workspace exposed none; ${workspace.skippedEnvFiles.length} .env file(s) excluded`;
  });

  await v.requireCheck("preflight:isolated-workspace", async () => {
    const required = [
      "package.json",
      "bun.lock",
      "apps/dashboard/next.config.mjs",
      "apps/website/next.config.mjs",
      "packages/db/migrations/meta/_journal.json",
      "node_modules",
    ];
    for (const relativePath of required) {
      const target = ws(relativePath);
      if (!existsSync(target)) {
        throw new Error(`verification workspace is missing ${relativePath}`);
      }
    }
    return `symlink overlay ready (${workspace.linkedEntries} linked entries, ${workspace.skippedEnvFiles.length} dotenv files excluded)`;
  });

  await v.requireCheck("preflight:local-services", async () => {
    const postgresUrl = new URL(databaseUrl(SMOKE_DATABASE));
    const results = {
      postgres: await tcpReachable(
        postgresUrl.hostname,
        Number(postgresUrl.port || 5432),
      ),
      redis: await tcpReachable(
        new URL(LOCAL_REDIS_URL).hostname,
        Number(new URL(LOCAL_REDIS_URL).port || 6379),
      ),
      minio: await fetch(`${LOCAL_MINIO_ENDPOINT}/minio/health/live`)
        .then((response) => response.status === 200)
        .catch(() => false),
    };

    const missing = Object.entries(results)
      .filter(([, ok]) => !ok)
      .map(([name]) => name);
    if (missing.length > 0) {
      throw new Error(
        `local services unavailable: ${missing.join(", ")}. Start them with: docker compose up -d --wait postgres redis minio`,
      );
    }
    return "disposable Postgres 17 + pgvector, Redis and MinIO are reachable on loopback";
  });

  await v.requireCheck("preflight:private-bucket", async () => {
    const result = await ensurePrivateBucket();
    return `private bucket "${result.bucket}" ${result.created ? "created" : "present"} (no objects listed or removed)`;
  });

  // Proves the disposable-service bootstrap refuses a name it does not own and
  // leaves that container untouched. Only a labelled decoy container on
  // loopback-free settings is involved.
  const bootstrapSafety = await v.runStep(
    "preflight:ci-bootstrap-collision-refusal",
    {
      command: "bash",
      args: ["scripts/verify/ci-services.sh", "--self-check"],
      cwd: ws(),
      env: env(),
      timeoutMs: 5 * 60 * 1000,
    },
  );
  await v.runCheck("preflight:ci-bootstrap-collision-proof", async () => {
    if (
      !bootstrapSafety.output.includes("refusing to remove existing container")
    ) {
      throw new Error(
        "the bootstrap self-check did not report a refusal for an unowned container",
      );
    }
    return "the disposable-service bootstrap refuses unowned name collisions, leaves them untouched and binds published ports to 127.0.0.1";
  });

  // Regression for the destructive self-check lifecycle: an unowned container
  // that already exists under the caller's prefix must survive byte-for-byte.
  await v.runStep("preflight:ci-bootstrap-caller-prefix-safety", {
    command: "bash",
    args: ["scripts/verify/ci-services-caller-check.sh"],
    cwd: ws(),
    env: env(),
    timeoutMs: 5 * 60 * 1000,
  });
}

async function installAndStaticGates() {
  await v.runStep("install:frozen-lockfile", {
    command: "bun",
    args: ["install", "--frozen-lockfile"],
    cwd: ROOT,
    env: env(),
    timeoutMs: 10 * 60 * 1000,
  });

  await v.runStep("lint:workspaces", {
    command: "bun",
    args: ["--no-env-file", "x", "turbo", "lint"],
    cwd: ws(),
    env: env(),
  });

  await v.runStep("lint:verifier-scripts", {
    command: "bun",
    args: ["--no-env-file", "x", "biome", "check", "scripts"],
    cwd: ws(),
    env: env(),
  });

  await v.runStep("hygiene:workspace-dependencies", {
    command: "bun",
    args: ["--no-env-file", "x", "manypkg", "check"],
    cwd: ws(),
    env: env(),
  });

  await runDependencyRangeCheck(
    v,
    env(),
    ws(),
    join(v.tmpDir, "manypkg-probe"),
  );

  await v.runStep("typecheck:workspaces", {
    command: "bun",
    args: ["--no-env-file", "x", "turbo", "typecheck"],
    cwd: ws(),
    env: env(),
    timeoutMs: 15 * 60 * 1000,
  });

  await v.runStep("typecheck:verifier-scripts", {
    command: "bun",
    args: [
      "--no-env-file",
      "x",
      "tsc",
      "--noEmit",
      "-p",
      "scripts/tsconfig.json",
    ],
    cwd: ws(),
    env: env(),
    timeoutMs: 10 * 60 * 1000,
  });
}

const UNIT_SUITES: { name: string; dir: string; args: string[] }[] = [
  {
    name: "db",
    dir: DB_PACKAGE_DIR,
    args: [
      "test",
      "src/storage.test.ts",
      "src/storage.s3.test.ts",
      "src/replicas.test.ts",
      "src/queries",
    ],
  },
  { name: "documents", dir: "packages/documents", args: ["test", "src"] },
  { name: "jobs", dir: JOBS_DIR, args: ["test", "src"] },
  { name: "encryption", dir: "packages/encryption", args: ["test", "src"] },
  { name: "inbox", dir: "packages/inbox", args: ["test", "src"] },
  { name: "api", dir: API_DIR, args: ["test"] },
  { name: "dashboard", dir: DASHBOARD_DIR, args: ["test"] },
];

async function unitSuites() {
  for (const suite of UNIT_SUITES) {
    await v.runStep(`test:unit-${suite.name}`, {
      command: "bun",
      args: ["--no-env-file", ...suite.args],
      cwd: ws(suite.dir),
      env: env(),
      timeoutMs: 10 * 60 * 1000,
    });
  }

  await v.runStep("test:verifier-negative-controls", {
    command: "bun",
    args: ["--no-env-file", "test", "scripts/verify/verify-selftest.test.ts"],
    cwd: ws(),
    env: env(),
    timeoutMs: 10 * 60 * 1000,
  });
}

async function buildWorkspace() {
  await v.runStep("build:dashboard-production", {
    command: "bun",
    args: ["--no-env-file", "x", "next", "build"],
    cwd: ws(DASHBOARD_DIR),
    env: env({
      DATABASE_PRIMARY_URL: databaseUrl(SMOKE_DATABASE),
      BETTER_AUTH_URL: `http://localhost:${DASHBOARD_PORT}`,
      NEXT_PUBLIC_URL: `http://localhost:${DASHBOARD_PORT}`,
      NEXT_PUBLIC_API_URL: `http://localhost:${API_SMOKE_PORT}`,
      NODE_ENV: "production",
    }),
    timeoutMs: 20 * 60 * 1000,
  });

  await v.runStep("build:website-production", {
    command: "bun",
    args: ["--no-env-file", "x", "next", "build"],
    cwd: ws(WEBSITE_DIR),
    env: env({
      DATABASE_PRIMARY_URL: databaseUrl(SMOKE_DATABASE),
      NODE_ENV: "production",
    }),
    timeoutMs: 20 * 60 * 1000,
  });

  await v.runStep("build:api-executable", {
    command: "bun",
    args: [
      "--no-env-file",
      "build",
      "./src/index.ts",
      "--target=bun",
      "--packages=external",
      `--outfile=${executablePath(ws(API_DIR), "api-server.js")}`,
    ],
    cwd: ws(API_DIR),
    env: env({ NODE_ENV: "production" }),
  });

  await v.runStep("build:worker-executable", {
    command: "bun",
    args: [
      "--no-env-file",
      "build",
      "./src/worker.ts",
      "--target=bun",
      "--packages=external",
      `--outfile=${executablePath(ws(JOBS_DIR), "worker.js")}`,
    ],
    cwd: ws(JOBS_DIR),
    env: env({ NODE_ENV: "production" }),
  });
}

/**
 * Queues one real workflow row so the worker must claim and process it. The
 * delivery target does not exist, so the row records a failed attempt: that is
 * durable evidence of an actual claim rather than a startup log line.
 */
async function queueClaimProbe(database: string) {
  const jobId = crypto.randomUUID();
  const { client, query } = await connectDisposableDatabase(database);
  try {
    await query(
      `insert into workflow_jobs
         (id, name, team_id, payload, status, idempotency_key, run_at)
       values ($1, 'deliver-webhook', null, $2::jsonb, 'queued', $3, now())`,
      [
        jobId,
        JSON.stringify({
          deliveryId: crypto.randomUUID(),
          teamId: null,
        }),
        `verify-claim-${jobId}`,
      ],
    );
  } finally {
    await client.end();
  }
  return jobId;
}

async function awaitClaimedJob(database: string, jobId: string) {
  const deadline = Date.now() + 30_000;
  const { client, query } = await connectDisposableDatabase(database);
  try {
    while (Date.now() < deadline) {
      const [row] = await query<{
        attempts: number;
        locked_by: string | null;
        last_error: string | null;
      }>(
        "select attempts, locked_by, last_error from workflow_jobs where id = $1",
        [jobId],
      );
      if (row && row.attempts > 0) return row;
      await Bun.sleep(250);
    }
    throw new Error(`worker did not claim queued job ${jobId}`);
  } finally {
    await client.end();
  }
}

async function runtimeSmoke() {
  const smokeEnv = env({
    DATABASE_PRIMARY_URL: databaseUrl(SMOKE_DATABASE),
    BETTER_AUTH_URL: `http://localhost:${API_SMOKE_PORT}`,
    NEXT_PUBLIC_URL: `http://localhost:${API_SMOKE_PORT}`,
    PORT: String(API_SMOKE_PORT),
    ALLOWED_API_ORIGINS: `http://localhost:${DASHBOARD_PORT}`,
    // Test mode: loopback webhook endpoints are only accepted outside
    // production. The production-mode entrypoints are exercised by the e2e.
    NODE_ENV: "test",
  });

  const api = await ManagedProcess.start(v, "start:api-executable", {
    command: "bun",
    args: ["--no-env-file", executablePath(ws(API_DIR), "api-server.js")],
    cwd: ws(API_DIR),
    env: smokeEnv,
  });

  await v.runCheck("start:api-executable-health", async () => {
    const origin = `http://localhost:${API_SMOKE_PORT}`;
    const health = await waitForHttp(
      `${origin}/health`,
      (response) => response.status === 200,
      "API executable /health",
    );
    const healthBody = (await health.json()) as { status?: string };
    if (healthBody.status !== "ok") {
      throw new Error(`/health returned ${JSON.stringify(healthBody)}`);
    }
    const healthDb = await fetch(`${origin}/health/db`);
    const dbBody = (await healthDb.json()) as { status?: string };
    if (healthDb.status !== 200 || dbBody.status !== "healthy") {
      throw new Error(`/health/db returned ${JSON.stringify(dbBody)}`);
    }
    const openapi = await fetch(`${origin}/openapi`);
    if (openapi.status !== 200) {
      throw new Error(`/openapi returned ${openapi.status}`);
    }
    return "compiled API executable served health, database and OpenAPI routes";
  });

  await v.runStep("start:api-delivery-verifier", {
    command: "bun",
    args: ["--no-env-file", "run", "verify:delivery"],
    cwd: ws(API_DIR),
    env: env({
      ...smokeEnv,
      INVOICEWISE_API_URL: `http://localhost:${API_SMOKE_PORT}`,
    }),
    timeoutMs: 10 * 60 * 1000,
  });

  // Stop the API before the worker proof so the API's embedded workflow runner
  // cannot claim the probe job; the claim must belong to the worker executable.
  await api.stop();

  const workerEnv = env({
    ...smokeEnv,
    NODE_ENV: "test",
  });
  const worker = await ManagedProcess.start(v, "start:worker-executable", {
    command: "bun",
    args: ["--no-env-file", executablePath(ws(JOBS_DIR), "worker.js")],
    cwd: ws(JOBS_DIR),
    env: workerEnv,
  });
  const workerStarted = await worker.waitForOutput(
    "workflow_runner_started",
    30_000,
  );
  const jobId = await queueClaimProbe(SMOKE_DATABASE);
  const claimed = await awaitClaimedJob(SMOKE_DATABASE, jobId);
  await worker.stop();
  await v.runCheck("start:worker-executable", async () => {
    if (!workerStarted || !worker.output.includes("workflow_runner_started")) {
      throw new Error(
        `worker executable did not start: ${worker.output.slice(0, 400)}`,
      );
    }
    if (!worker.output.includes(jobId)) {
      throw new Error(
        `the probe job ${jobId} was not processed by the worker executable: ${worker.output.slice(0, 400)}`,
      );
    }
    if (!worker.stoppedGracefully) {
      throw new Error(
        "worker executable required SIGKILL; graceful shutdown is not proven",
      );
    }
    return `claimed queued job ${jobId} (attempt ${claimed.attempts}, locked_by ${
      claimed.locked_by ? "set" : "cleared"
    }, error recorded ${claimed.last_error ? "yes" : "no"}) and exited on SIGTERM with code ${worker.stoppedWithCode}`;
  });
}

async function workflowAndStorageVerifiers() {
  await v.runStep("verify:jobs-workflows", {
    command: "bun",
    args: ["--no-env-file", "run", "verify"],
    cwd: ws(JOBS_DIR),
    env: env({
      DATABASE_PRIMARY_URL: databaseUrl(JOBS_DATABASE),
      LOCAL_STORAGE_PATH: join(v.tmpDir, "jobs-storage"),
    }),
    timeoutMs: 10 * 60 * 1000,
  });

  await v.runStep("verify:jobs-accounting", {
    command: "bun",
    args: ["--no-env-file", "run", "verify:accounting"],
    cwd: ws(JOBS_DIR),
    env: env({
      DATABASE_PRIMARY_URL: databaseUrl(JOBS_DATABASE),
      LOCAL_STORAGE_PATH: join(v.tmpDir, "jobs-storage"),
    }),
    timeoutMs: 10 * 60 * 1000,
  });

  await v.runStep("verify:storage-s3-minio", {
    command: "bun",
    args: ["--no-env-file", "test", "src/storage.s3.test.ts"],
    cwd: ws(DB_PACKAGE_DIR),
    env: env({
      STORAGE_S3_INTEGRATION: "1",
      STORAGE_BACKEND: "s3",
      STORAGE_SIGNING_SECRET: "invoicewise-verify-storage-signing-secret",
    }),
    timeoutMs: 5 * 60 * 1000,
  });
}

async function securityRegressionSuites() {
  await v.runStep("verify:security-permissions-integration", {
    command: "bun",
    args: [
      "--no-env-file",
      "test",
      "src/trpc/routers/team.permissions.integration.test.ts",
    ],
    cwd: ws(API_DIR),
    env: env({
      PERMISSIONS_TEST_DATABASE_URL: databaseUrl(PERMISSIONS_DATABASE),
    }),
    timeoutMs: 10 * 60 * 1000,
  });

  await v.runStep("verify:security-deletion-races", {
    command: "bun",
    args: [
      "--no-env-file",
      "test",
      "src/trpc/routers/team.deletion-races.integration.test.ts",
    ],
    cwd: ws(API_DIR),
    env: env({
      PERMISSIONS_TEST_DATABASE_URL: databaseUrl(PERMISSIONS_DATABASE),
    }),
    timeoutMs: 10 * 60 * 1000,
  });

  // The HTTP suites boot their own server on a fixed port and must run
  // sequentially; the intake helpers scan the shared disposable database.
  await v.runStep("verify:security-http-regressions", {
    command: "bun",
    args: ["--no-env-file", "test", "src/permissions.http.integration.test.ts"],
    cwd: ws(API_DIR),
    env: env({
      PERMISSIONS_TEST_DATABASE_URL: databaseUrl(PERMISSIONS_DATABASE),
    }),
    timeoutMs: 20 * 60 * 1000,
  });

  await v.runStep("verify:intake-http-regressions", {
    command: "bun",
    args: ["--no-env-file", "test", "src/intake.http.integration.test.ts"],
    cwd: ws(API_DIR),
    env: env({ INTAKE_TEST_DATABASE_URL: databaseUrl(INTAKE_DATABASE) }),
    timeoutMs: 20 * 60 * 1000,
  });

  await v.runStep("verify:identity-http-regressions", {
    command: "bun",
    args: ["--no-env-file", "test", "src/identity.http.integration.test.ts"],
    cwd: ws(API_DIR),
    env: env({ IDENTITY_TEST_DATABASE_URL: databaseUrl(IDENTITY_DATABASE) }),
    timeoutMs: 20 * 60 * 1000,
  });
}

/**
 * The retired bank/transaction matching suites are explicitly out of product
 * scope. They still run so the recorded failure set is real evidence, but an
 * unparseable or crashed run fails the gate instead of reading as zero.
 */
async function retiredMatchingScope() {
  const result = await v.runStep("scope:retired-bank-matching-suites", {
    command: "bun",
    args: ["--no-env-file", "test", "src/test/transaction-matching.test.ts"],
    cwd: ws(DB_PACKAGE_DIR),
    env: env(),
    timeoutMs: 5 * 60 * 1000,
    allowFailure: true,
  });

  await v.runCheck("scope:retired-bank-matching-scope", async () => {
    const outcome = parseRetiredMatchingOutcome(result.output);
    if (!outcome.ok) {
      throw new Error(`${outcome.reason}; see ${result.logPath}`);
    }
    return `${outcome.failures} recorded failures in the retired bank/transaction matching suite (excluded from the product test script; bank-line matching is retired product scope)`;
  });
}

async function main() {
  await mkdir(ARTIFACTS_ROOT, { recursive: true });
  await v.init();

  const mode = securityOnly
    ? "security-only"
    : migrationsOnly
      ? "migrations-only"
      : e2eOnly
        ? "e2e-only"
        : preflightOnly
          ? "preflight-only"
          : "full";

  providerTrap = startProviderTrap();
  setProviderStubBaseUrl(providerTrap.origin);
  v.onCleanup("stop provider trap", async () => providerTrap.stop());
  smtpTrap = await startSmtpTrap();
  setSmtpTrapPort(smtpTrap.port);
  v.onCleanup("stop SMTP trap", () => smtpTrap.stop());
  workspace = createIsolatedWorkspace(join(v.artifactsDir, "workspace"), ROOT);
  // The overlay contains real build output (hundreds of megabytes of `.next`),
  // so it is removed at the end of the run; the retained evidence is the
  // redacted logs plus summary.json.
  v.onCleanup("remove verification workspace overlay", async () => {
    await rm(workspace.root, { recursive: true, force: true });
    await rm(v.tmpDir, { recursive: true, force: true });
    await rm(join(v.artifactsDir, ".env"), { force: true });
  });

  console.log(
    `InvoiceWise verification ${runId} (bun ${Bun.version}); artifacts in ${v.artifactsDir}`,
  );

  let aborted: VerificationAborted | undefined;
  let thrown: unknown;
  try {
    if (securityOnly) {
      await runDependencyCheck(v, env());
      await runSecretScan(v);
    } else if (migrationsOnly) {
      await preflight();
      await v.runStep("install:frozen-lockfile", {
        command: "bun",
        args: ["install", "--frozen-lockfile"],
        cwd: ROOT,
        env: env(),
        timeoutMs: 10 * 60 * 1000,
      });
      await runMigrationVerification(v, env(), ws());
    } else if (e2eOnly) {
      await preflight();
      await v.runStep("install:frozen-lockfile", {
        command: "bun",
        args: ["install", "--frozen-lockfile"],
        cwd: ROOT,
        env: env(),
        timeoutMs: 10 * 60 * 1000,
      });
      for (const database of [SMOKE_DATABASE]) {
        v.onCleanup(`drop ${database}`, () => dropDisposableDatabase(database));
        await resetDisposableDatabase(database);
        await v.runStep(
          `migrations:prepare-${database}`,
          migrateSpec(database),
        );
      }
      await buildWorkspace();
      await runProductionE2E(v, { env, ws });
    } else if (preflightOnly) {
      await preflight();
    } else {
      await preflight();
      await installAndStaticGates();
      await unitSuites();
      await runMigrationVerification(v, env(), ws());

      for (const database of [
        SMOKE_DATABASE,
        PERMISSIONS_DATABASE,
        INTAKE_DATABASE,
        IDENTITY_DATABASE,
        JOBS_DATABASE,
      ]) {
        v.onCleanup(`drop ${database}`, () => dropDisposableDatabase(database));
        await resetDisposableDatabase(database);
        await v.runStep(
          `migrations:prepare-${database}`,
          migrateSpec(database),
        );
      }

      await buildWorkspace();
      await runtimeSmoke();
      await workflowAndStorageVerifiers();
      await securityRegressionSuites();
      await runProductionE2E(v, { env, ws });
      await runDependencyCheck(v, env());
      await runSecretScan(v);
      await retiredMatchingScope();
    }
  } catch (error) {
    if (error instanceof VerificationAborted) {
      aborted = error;
      console.error(`[abort] ${error.message}`);
    } else {
      thrown = error;
      console.error(
        `[error] ${redact(
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error),
        )}`,
      );
    }
  } finally {
    await v.cleanup();
  }

  const summary = await v.writeSummary({
    mode,
    aborted: aborted
      ? { step: aborted.stepName, detail: aborted.detail }
      : null,
    error:
      thrown instanceof Error
        ? { message: redact(thrown.message), stack: redact(thrown.stack ?? "") }
        : thrown
          ? { message: redact(String(thrown)) }
          : null,
    providerTrapRequests: providerTrap.requests,
    // Counts only: captured mail carries verification links.
    smtpTrap: {
      connections: smtpTrap.connections,
      messages: smtpTrap.messages.length,
    },
    workspace: {
      linkedEntries: workspace.linkedEntries,
      skippedEnvFiles: workspace.skippedEnvFiles,
    },
    workspaceExcluded: BLOCKED_PROVIDER_KEYS,
  });

  const failures = v.failures;
  console.log(
    `\n${summary.steps.length - failures.length}/${summary.steps.length} verification steps passed`,
  );
  if (aborted || thrown || failures.length > 0) {
    if (failures.length > 0) {
      console.error("\nFailed steps:");
      for (const failure of failures) {
        console.error(
          `  - ${failure.name}: ${redact(
            failure.note ?? `exit ${failure.exitCode}`,
          )} (${failure.logPath.replace(`${ROOT}/`, "")})`,
        );
      }
    }
    console.error(
      `\nVerification failed. Redacted evidence: ${v.artifactsDir}`,
    );
    process.exit(1);
  }
  console.log(`Verification passed. Evidence: ${v.artifactsDir}`);
}

await main();
