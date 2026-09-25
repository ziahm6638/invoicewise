/**
 * The e2e runner behind `bun run e2e` (entry: scripts/e2e.ts).
 *
 * 1. Sweeps stale e2e databases, then creates this run's `e2e_<epoch>_<hex>`
 *    database on the shared project Postgres, migrates it with drizzle-kit
 *    and seeds it with e2e/seed.ts. The database is dropped on exit, on
 *    failure and on SIGINT/SIGTERM.
 * 2. Builds (or reuses the gate's) production dashboard, website, API and
 *    worker executables inside an isolated, `.env`-free workspace overlay.
 * 3. Starts the API, dashboard and website against the run database on free
 *    ports with every provider stubbed (e2e/support/stubs.ts), waits for
 *    health, runs the journeys in e2e/journeys and stops everything.
 * 4. Writes report.md / report.json plus per-journey traces under
 *    ${E2E_EVIDENCE_ROOT:-~/e2e-evidence}/invoicewise/<run-id>/ and prints
 *    `E2E_REPORT=<report.md>` as its last line.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import { MAX_AGE_SECONDS, sweep } from "../../scripts/e2e-sweep";
import {
  connectDisposableDatabase,
  databaseUrl,
  dropDisposableDatabase,
  resetDisposableDatabase,
} from "../../scripts/verify/database";
import {
  ARTIFACTS_ROOT,
  ManagedProcess,
  ROOT,
  VERIFY_OPS_TOKEN,
  Verification,
  assertHealthContract,
  assertSyntheticEnvironment,
  createIsolatedWorkspace,
  executablePath,
  freePort,
  redact,
  setProviderStubBaseUrl,
  setSmtpTrapPort,
  startProviderTrap,
  startSmtpTrap,
  syntheticEnv,
  waitForHttp,
} from "../../scripts/verify/lib";
import { type Journey, createJourneyContext } from "./journey";
import type { SharedServices } from "./services";
import {
  NANGO_SECRET,
  SALT_EDGE_APP,
  XERO_INTEGRATION,
  startStubs,
} from "./stubs";

export type RunnerOptions = {
  services: SharedServices;
  /** Build only (the gate's build step): write a manifest to this dir. */
  buildOnly?: string;
  /** Reuse a build the gate made (manifest dir). */
  prebuilt?: string;
  /** Only journeys whose id contains one of these. */
  only: string[];
  parallel: boolean;
};

type BuildManifest = {
  workspace: string;
  apiPort: number;
  dashboardPort: number;
  websitePort: number;
  commit: string;
  builtAt: string;
};

type JourneyResult = {
  id: string;
  name: string;
  features: string[];
  ok: boolean;
  durationMs: number;
  outcome: string;
  failedStep?: string;
  error?: string;
  requests: number;
  artifacts: string[];
};

const EVIDENCE_ROOT = join(
  process.env.E2E_EVIDENCE_ROOT ?? join(homedir(), "e2e-evidence"),
  "invoicewise",
);

const hex6 = () =>
  [...crypto.getRandomValues(new Uint8Array(3))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const commitSha = () => {
  const result = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: ROOT });
  const sha = result.stdout.toString().trim();
  const dirty = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: ROOT })
    .stdout.toString()
    .trim();
  return `${sha || "unknown"}${dirty ? " (+ uncommitted changes)" : ""}`;
};

async function loadJourneys(only: string[]) {
  const dir = join(ROOT, "e2e", "journeys");
  const files = (await readdir(dir))
    .filter((file) => file.endsWith(".journey.ts"))
    .sort();
  const journeys: Journey[] = [];
  for (const file of files) {
    const module = (await import(join(dir, file))) as { default?: Journey };
    const journey = module.default;
    if (!journey || journey.id !== file.replace(/\.journey\.ts$/, "")) {
      throw new Error(
        `${file} must default-export a Journey whose id matches its file name`,
      );
    }
    if (only.length === 0 || only.some((part) => journey.id.includes(part))) {
      journeys.push(journey);
    }
  }
  if (journeys.length === 0) throw new Error("no journeys selected");
  return journeys;
}

export async function runE2E(options: RunnerOptions): Promise<number> {
  const epoch = Math.floor(Date.now() / 1000);
  const runId = `e2e_${epoch}_${hex6()}`;
  const database = runId;
  const evidenceDir = options.buildOnly
    ? join(options.buildOnly, "build-evidence")
    : join(EVIDENCE_ROOT, runId);
  const v = new Verification(runId, evidenceDir);
  await v.init();
  const started = Date.now();

  // Every provider base URL points at a loopback stub; mail at an SMTP trap.
  const providerTrap = startProviderTrap();
  setProviderStubBaseUrl(providerTrap.origin);
  v.onCleanup("stop provider trap", async () => providerTrap.stop());
  const smtp = await startSmtpTrap();
  setSmtpTrapPort(smtp.port);
  v.onCleanup("stop SMTP trap", () => smtp.stop());
  const stubs = await startStubs();
  v.onCleanup("stop provider stubs", async () => stubs.stop());

  // Ports and the build workspace: the gate's build, or a fresh one.
  let manifest: BuildManifest;
  if (options.prebuilt) {
    manifest = JSON.parse(
      await readFile(join(options.prebuilt, "manifest.json"), "utf8"),
    ) as BuildManifest;
  } else {
    const buildRoot = options.buildOnly
      ? join(options.buildOnly, "workspace")
      : join(ARTIFACTS_ROOT, `e2e-build-${runId}`, "workspace");
    manifest = {
      workspace: buildRoot,
      apiPort: await freePort(),
      dashboardPort: await freePort(),
      websitePort: await freePort(),
      commit: commitSha(),
      builtAt: "",
    };
  }
  const apiOrigin = `http://localhost:${manifest.apiPort}`;
  const appOrigin = `http://localhost:${manifest.dashboardPort}`;
  const websiteOrigin = `http://localhost:${manifest.websitePort}`;
  const ws = (relative = "") =>
    relative ? join(manifest.workspace, relative) : manifest.workspace;

  const storagePath = join(ARTIFACTS_ROOT, `e2e-storage-${runId}`);
  // The loopback Salt Edge's synthetic app secret (e2e/support/stubs.ts).
  const saltEdgeSecret = SALT_EDGE_APP.secret;
  const env = (overrides: Record<string, string | undefined> = {}) => {
    const built = syntheticEnv({
      BETTER_AUTH_URL: appOrigin,
      NEXT_PUBLIC_URL: appOrigin,
      NEXT_PUBLIC_API_URL: apiOrigin,
      STORAGE_PUBLIC_URL: apiOrigin,
      ALLOWED_API_ORIGINS: appOrigin,
      DATABASE_PRIMARY_URL: databaseUrl(database),
      LOCAL_STORAGE_PATH: storagePath,
      TYPESAFE_BASE_URL: stubs.typeSafeUrl,
      NANGO_BASE_URL: stubs.nangoUrl,
      NANGO_SECRET_KEY: NANGO_SECRET,
      NANGO_XERO_INTEGRATION_ID: XERO_INTEGRATION,
      // Optional bank payments, against the loopback Salt Edge.
      BANK_PAYMENTS_ENABLED: "true",
      SALT_EDGE_BASE_URL: stubs.saltEdgeUrl,
      SALT_EDGE_APP_ID: SALT_EDGE_APP.appId,
      SALT_EDGE_SECRET: saltEdgeSecret,
      WORKFLOW_POLL_MS: "100",
      ...overrides,
    });
    assertSyntheticEnvironment(built);
    return built;
  };

  // Signals: stop processes and drop the run database before exiting.
  let interrupted = false;
  const onSignal = (signal: NodeJS.Signals) => {
    if (interrupted) return;
    interrupted = true;
    console.error(`[e2e] ${signal}: cleaning up`);
    void v
      .cleanup()
      .finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const results: JourneyResult[] = [];
  let fatal: string | undefined;
  let health: Record<string, unknown> = {};
  let browser: Browser | undefined;

  try {
    // 1. Sweep, then this run's database.
    if (!options.buildOnly) {
      await v.runCheck("e2e:sweep-stale-databases", async () => {
        const dropped = await sweep(options.services.postgresBase, {
          log: () => undefined,
        });
        return `dropped ${dropped.length} e2e database(s) older than ${MAX_AGE_SECONDS}s`;
      });
    }
    if (!options.buildOnly) {
      v.onCleanup(`drop ${database}`, () => dropDisposableDatabase(database));
      await resetDisposableDatabase(database);
      const migrated = await v.runStep("e2e:migrate", {
        command: "bun",
        args: ["--no-env-file", "x", "drizzle-kit", "migrate"],
        cwd: join(ROOT, "packages", "db"),
        env: env(),
      });
      if (!migrated.ok) throw new Error("migrating the e2e database failed");
    }

    // 2. Build.
    if (!options.prebuilt) {
      if (!options.buildOnly) {
        v.onCleanup("remove e2e build workspace", async () => {
          await rm(join(manifest.workspace, ".."), {
            recursive: true,
            force: true,
          });
        });
      }
      await rm(manifest.workspace, { recursive: true, force: true });
      createIsolatedWorkspace(manifest.workspace, ROOT);
      await build(v, ws, env);
      manifest.builtAt = new Date().toISOString();
      if (options.buildOnly) {
        await writeFile(
          join(options.buildOnly, "manifest.json"),
          `${JSON.stringify(manifest, null, 2)}\n`,
        );
        console.log(`[e2e] build ready: ${options.buildOnly}/manifest.json`);
        return v.failures.length === 0 ? 0 : 1;
      }
    }

    const seeded = await v.runStep("e2e:seed", {
      command: "bun",
      args: ["--no-env-file", join(ROOT, "e2e", "seed.ts")],
      cwd: ROOT,
      env: env(),
    });
    if (!seeded.ok) throw new Error("seeding the e2e database failed");

    // 3. Start the app.
    const productionEnv = env({ NODE_ENV: "production" });
    await ManagedProcess.start(v, "app:api", {
      command: "bun",
      args: ["--no-env-file", executablePath(ws("apps/api"), "api-server.js")],
      cwd: ws("apps/api"),
      env: { ...productionEnv, PORT: String(manifest.apiPort) },
    });
    await ManagedProcess.start(v, "app:dashboard", {
      command: "bun",
      args: [
        "--no-env-file",
        "x",
        "next",
        "start",
        "-p",
        String(manifest.dashboardPort),
      ],
      cwd: ws("apps/dashboard"),
      env: productionEnv,
    });
    await ManagedProcess.start(v, "app:website", {
      command: "bun",
      args: [
        "--no-env-file",
        "x",
        "next",
        "start",
        "-p",
        String(manifest.websitePort),
      ],
      cwd: ws("apps/website"),
      env: productionEnv,
    });
    const ready = await v.runCheck("app:healthy", async () => {
      await waitForHttp(
        `${apiOrigin}/health`,
        (r) => r.status === 200,
        "API /health",
      );
      await assertHealthContract(apiOrigin);
      await waitForHttp(
        `${appOrigin}/login`,
        (r) => r.status === 200,
        "dashboard /login",
        120_000,
      );
      await waitForHttp(
        `${websiteOrigin}/`,
        (r) => r.status === 200,
        "website /",
        120_000,
      );
      return `API ${apiOrigin}, dashboard ${appOrigin}, website ${websiteOrigin}`;
    });
    if (!ready.ok)
      throw new Error(`the app did not become healthy: ${ready.note}`);

    // 4. Journeys.
    const journeys = await loadJourneys(options.only);
    const { client, query } = await connectDisposableDatabase(database);
    v.onCleanup("close journey database client", () => client.end());
    const launchBrowser = async () => {
      if (!browser) {
        const { chromium } = await import("playwright-core");
        browser = await chromium.launch().catch((error: unknown) => {
          throw new Error(
            `Chromium for Playwright is not installed (run \`bunx playwright-core install chromium\`): ${String(error).slice(0, 300)}`,
          );
        });
      }
      return browser;
    };

    const runJourney = async (
      journey: Journey,
      index: number,
    ): Promise<JourneyResult> => {
      const dir = join(evidenceDir, "journeys", journey.id);
      await mkdir(dir, { recursive: true });
      const { ctx, finish, currentStep } = createJourneyContext({
        id: journey.id,
        dir,
        appOrigin,
        apiOrigin,
        websiteOrigin,
        query,
        smtp,
        stubs,
        browser: launchBrowser,
        redact,
        // TEST-NET-3 (RFC 5737): never a real client.
        clientIp: `203.0.113.${(index % 250) + 1}`,
      });
      const startedAt = Date.now();
      let ok = true;
      let outcome = "";
      let error: string | undefined;
      try {
        outcome = await journey.run(ctx);
      } catch (caught) {
        ok = false;
        error = redact(
          caught instanceof Error ? caught.message : String(caught),
        );
      }
      const failedStep = ok ? undefined : currentStep();
      const finished = await finish(!ok);
      const result: JourneyResult = {
        id: journey.id,
        name: journey.name,
        features: journey.features,
        ok,
        durationMs: Date.now() - startedAt,
        outcome,
        failedStep,
        error,
        requests: finished.requests,
        artifacts: finished.artifacts,
      };
      const seconds = (result.durationMs / 1000).toFixed(1);
      if (ok) {
        console.log(`[pass] ${journey.id} (${seconds}s) ${outcome}`);
      } else {
        console.error(
          `[FAIL] ${journey.id} (${seconds}s) at "${failedStep}": ${error}\n       evidence: ${dir}`,
        );
      }
      return result;
    };

    if (options.parallel) {
      // A bounded pool: the parser pool answers 503 under heavy load, and a
      // developer machine should not run every browser at once.
      const limit = Math.max(1, Number(process.env.E2E_CONCURRENCY ?? 3));
      const slots: JourneyResult[] = [];
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(limit, journeys.length) }, async () => {
          while (next < journeys.length) {
            const index = next++;
            slots[index] = await runJourney(journeys[index]!, index);
          }
        }),
      );
      results.push(...slots);
    } else {
      for (const [index, journey] of journeys.entries()) {
        results.push(await runJourney(journey, index));
      }
    }

    // The standalone worker executable (production runs it beside the API)
    // claims the same queue and stops cleanly on SIGTERM.
    await v.runCheck("app:worker-executable", async () => {
      const worker = await ManagedProcess.start(v, "app:worker", {
        command: "bun",
        args: [
          "--no-env-file",
          executablePath(ws("packages/jobs"), "worker.js"),
        ],
        cwd: ws("packages/jobs"),
        env: productionEnv,
      });
      const started = await worker.waitForOutput(
        "workflow_runner_started",
        30_000,
      );
      await worker.stop();
      if (!started) {
        throw new Error(`worker did not start: ${worker.output.slice(0, 400)}`);
      }
      if (!worker.stoppedGracefully) {
        throw new Error("worker needed SIGKILL; graceful shutdown not proven");
      }
      return "worker executable started the workflow runner and exited on SIGTERM";
    });

    // The health + metrics read of the running app, after the journeys.
    const metrics = await fetch(`${apiOrigin}/ops/metrics`, {
      headers: { authorization: `Bearer ${VERIFY_OPS_TOKEN}` },
    });
    health = {
      health: await (await fetch(`${apiOrigin}/health`)).json(),
      ready: await (await fetch(`${apiOrigin}/health/ready`)).json(),
      metricsStatus: metrics.status,
      metrics: await metrics.json().catch(() => null),
    };
  } catch (error) {
    fatal = redact(error instanceof Error ? error.message : String(error));
    console.error(`[e2e] ${fatal}`);
  } finally {
    await browser?.close().catch(() => undefined);
    await v.cleanup();
    await rm(storagePath, { recursive: true, force: true });
    if (options.prebuilt && !process.env.E2E_KEEP_BUILD) {
      // The gate's build is single-use: remove it once its run is done
      // (E2E_KEEP_BUILD=1 keeps it to rerun journeys against it).
      await rm(options.prebuilt, { recursive: true, force: true });
    }
    await rm(v.tmpDir, { recursive: true, force: true });
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }

  if (options.buildOnly) {
    console.error(
      `[e2e] build failed: ${fatal ?? "see logs"} (${evidenceDir})`,
    );
    return 1;
  }

  const stepFailures = v.failures.map(
    (f) => `${f.name}: ${f.note ?? `exit ${f.exitCode}`}`,
  );
  const passed = results.filter((r) => r.ok).length;
  const ok =
    !fatal &&
    stepFailures.length === 0 &&
    results.length > 0 &&
    passed === results.length;
  const report = {
    project: "invoicewise",
    runId,
    ok,
    commit: manifest.commit,
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    app: { dashboard: appOrigin, api: apiOrigin, website: websiteOrigin },
    database: {
      name: database,
      server: options.services.postgresLabel,
      dropped: true,
    },
    redis: options.services.redisLabel,
    build: options.prebuilt
      ? `gate build ${manifest.builtAt}`
      : "built by this run",
    fatal: fatal ?? null,
    stepFailures,
    journeys: results.map((r) => ({
      ...r,
      artifacts: r.artifacts,
    })),
    health,
    stubs: {
      requests: stubs.requests.length,
      byProvider: countBy(stubs.requests.map((r) => r.provider)),
      providerTrap: providerTrap.requests.length,
      smtpMessages: smtp.messages.map((m) => ({
        to: m.recipients.length,
        subject: m.subject,
      })),
      xeroWrites: stubs.xero.state.writes,
    },
    logs: join(evidenceDir, "logs"),
  };
  await writeFile(
    join(evidenceDir, "report.json"),
    redact(`${JSON.stringify(report, null, 2)}\n`),
  );
  await writeFile(
    join(evidenceDir, "stubs.json"),
    redact(
      `${JSON.stringify({ stubs: stubs.requests, trap: providerTrap.requests }, null, 2)}\n`,
    ),
  );
  const reportPath = join(evidenceDir, "report.md");
  await writeFile(reportPath, redact(renderMarkdown(report, results)));
  console.log(
    `\n${ok ? "E2E PASSED" : "E2E FAILED"}: ${passed}/${results.length} journeys${fatal ? ` (${fatal})` : ""}`,
  );
  console.log(`E2E_REPORT=${reportPath}`);
  return ok ? 0 : 1;
}

async function build(
  v: Verification,
  ws: (relative?: string) => string,
  env: (
    overrides?: Record<string, string | undefined>,
  ) => Record<string, string>,
) {
  const production = env({ NODE_ENV: "production" });
  const steps: [string, string, string[], number][] = [
    [
      "build:dashboard",
      "apps/dashboard",
      ["--no-env-file", "x", "next", "build"],
      20,
    ],
    [
      "build:website",
      "apps/website",
      ["--no-env-file", "x", "next", "build"],
      20,
    ],
    [
      "build:api-executable",
      "apps/api",
      [
        "--no-env-file",
        "build",
        "./src/index.ts",
        "--target=bun",
        "--packages=external",
        `--outfile=${executablePath(ws("apps/api"), "api-server.js")}`,
      ],
      5,
    ],
    [
      "build:worker-executable",
      "packages/jobs",
      [
        "--no-env-file",
        "build",
        "./src/worker.ts",
        "--target=bun",
        "--packages=external",
        `--outfile=${executablePath(ws("packages/jobs"), "worker.js")}`,
      ],
      5,
    ],
  ];
  for (const [name, dir, args, minutes] of steps) {
    const result = await v.runStep(name, {
      command: "bun",
      args,
      cwd: ws(dir),
      env: production,
      timeoutMs: minutes * 60 * 1000,
    });
    if (!result.ok) throw new Error(`${name} failed (log: ${result.logPath})`);
  }
  if (!existsSync(join(ws("apps/dashboard"), ".next", "BUILD_ID"))) {
    throw new Error("the dashboard build left no .next/BUILD_ID");
  }
}

const countBy = (values: string[]) =>
  values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});

function renderMarkdown(report: Record<string, any>, results: JourneyResult[]) {
  const lines = [
    `# InvoiceWise e2e run ${report.runId}`,
    "",
    `- Result: **${report.ok ? "PASSED" : "FAILED"}** (${results.filter((r) => r.ok).length}/${results.length} journeys)`,
    `- Commit: ${report.commit}`,
    `- App: dashboard ${report.app.dashboard}, API ${report.app.api}, website ${report.app.website} (production builds; ${report.build})`,
    `- Database: \`${report.database.name}\` on ${report.database.server} (created, migrated, seeded, dropped at exit)`,
    `- Duration: ${(report.durationMs / 1000).toFixed(1)}s`,
    `- Providers: all stubbed on loopback (TypeSafe, Nango/Xero, Polar, SMTP); ${report.stubs.requests} stub requests, ${report.stubs.providerTrap} provider-trap requests`,
    "",
    "| Journey | Result | Duration | Features | Trace |",
    "| --- | --- | --- | --- | --- |",
    ...results.map(
      (r) =>
        `| ${r.name} (\`${r.id}\`) | ${r.ok ? "pass" : `**FAIL** at "${r.failedStep}"`} | ${(r.durationMs / 1000).toFixed(1)}s | ${r.features.join(", ")} | ${r.artifacts.filter((a) => !a.endsWith(".png")).join("<br>")} |`,
    ),
    "",
  ];
  for (const r of results) {
    lines.push(
      `## ${r.name}`,
      "",
      r.ok ? r.outcome : `Failed at "${r.failedStep}": ${r.error}`,
      "",
    );
    const shots = r.artifacts.filter((a) => a.endsWith(".png"));
    if (shots.length > 0)
      lines.push(...shots.map((s) => `- screenshot: ${s}`), "");
  }
  if (report.fatal) lines.push("## Fatal", "", report.fatal, "");
  if (report.stepFailures.length > 0) {
    lines.push(
      "## Failed steps",
      "",
      ...report.stepFailures.map((f: string) => `- ${f}`),
      "",
    );
  }
  lines.push(
    "## Health and metrics (read after the journeys)",
    "",
    "```json",
    JSON.stringify(report.health, null, 2),
    "```",
    "",
    `Logs: ${report.logs}`,
    "",
  );
  return lines.join("\n");
}
