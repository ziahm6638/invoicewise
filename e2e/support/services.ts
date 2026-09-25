/**
 * Finds the project's already-running shared Postgres and Redis.
 *
 * The e2e gate never starts containers. It reuses the one InvoiceWise suite
 * running on this machine (the `docker compose` services, or the verification
 * suite from `scripts/verify/ci-services.sh`) and isolates itself with a
 * per-run database. `E2E_POSTGRES_BASE` / `E2E_REDIS_URL` pin the targets
 * explicitly (both must be loopback).
 *
 * Call `useSharedServices()` BEFORE importing `scripts/verify/lib.ts` or
 * `scripts/verify/database.ts`: those modules read `VERIFY_POSTGRES_BASE` and
 * `VERIFY_REDIS_URL` once, at import time.
 */

type Container = {
  name: string;
  project: string;
  service: string;
  verifyOwned: boolean;
};

const docker = (args: string[]) => {
  const result = Bun.spawnSync(["docker", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) return null;
  return result.stdout.toString().trim();
};

function runningContainers(): Container[] {
  const out = docker([
    "ps",
    "--format",
    '{{.Names}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.service"}}\t{{.Label "invoicewise.verify.service"}}',
  ]);
  if (!out) return [];
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name = "", project = "", service = "", verify = ""] =
        line.split("\t");
      return { name, project, service, verifyOwned: verify === "true" };
    });
}

/** The InvoiceWise container for one service, verification suite first. */
function findContainer(containers: Container[], service: string) {
  const candidates = containers
    .filter(
      (c) =>
        (c.verifyOwned && c.name.endsWith(`-${service}`)) ||
        (c.project === "invoicewise" && c.service === service),
    )
    .sort(
      (a, b) =>
        Number(b.verifyOwned) - Number(a.verifyOwned) ||
        a.name.localeCompare(b.name),
    );
  return candidates[0];
}

function publishedPort(container: string, port: number) {
  const out = docker(["port", container, `${port}/tcp`]);
  const first = out?.split("\n")[0] ?? "";
  const match = first.match(/:(\d+)$/);
  if (!match) {
    throw new Error(
      `container ${container} does not publish ${port}/tcp on the host`,
    );
  }
  return Number(match[1]);
}

function containerEnv(container: string) {
  const out =
    docker([
      "inspect",
      container,
      "--format",
      "{{range .Config.Env}}{{println .}}{{end}}",
    ]) ?? "";
  return Object.fromEntries(
    out
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  ) as Record<string, string>;
}

export type SharedServices = {
  postgresBase: string;
  redisUrl: string;
  /** Human description for the report (never contains credentials). */
  postgresLabel: string;
  redisLabel: string;
};

const MISSING =
  "No InvoiceWise Postgres/Redis is running on this machine. Start the project's suite once with `docker compose up -d --wait postgres redis` (or reuse the verification suite), or set E2E_POSTGRES_BASE and E2E_REDIS_URL to loopback URLs. The e2e gate never starts containers itself.";

export function resolveSharedServices(): SharedServices {
  const containers =
    process.env.E2E_POSTGRES_BASE && process.env.E2E_REDIS_URL
      ? []
      : runningContainers();

  let postgresBase = process.env.E2E_POSTGRES_BASE;
  let postgresLabel = "E2E_POSTGRES_BASE";
  if (!postgresBase) {
    const postgres = findContainer(containers, "postgres");
    if (!postgres) throw new Error(MISSING);
    const env = containerEnv(postgres.name);
    const user = encodeURIComponent(env.POSTGRES_USER || "invoicewise");
    const password = encodeURIComponent(env.POSTGRES_PASSWORD || "invoicewise");
    const port = publishedPort(postgres.name, 5432);
    postgresBase = `postgresql://${user}:${password}@127.0.0.1:${port}`;
    postgresLabel = `container ${postgres.name} (127.0.0.1:${port})`;
  }

  let redisUrl = process.env.E2E_REDIS_URL;
  let redisLabel = "E2E_REDIS_URL";
  if (!redisUrl) {
    const redis = findContainer(containers, "redis");
    if (!redis) throw new Error(MISSING);
    const port = publishedPort(redis.name, 6379);
    // Database 11 keeps e2e cache keys apart from development (0) and the
    // release verifier (9); every key also carries this run's random ids.
    redisUrl = `redis://127.0.0.1:${port}/11`;
    redisLabel = `container ${redis.name} (127.0.0.1:${port}, db 11)`;
  }

  return { postgresBase, redisUrl, postgresLabel, redisLabel };
}

/** Resolves the services and exports them for the verification helpers. */
export function useSharedServices(): SharedServices {
  const services = resolveSharedServices();
  process.env.VERIFY_POSTGRES_BASE = services.postgresBase;
  process.env.VERIFY_REDIS_URL = services.redisUrl;
  return services;
}
