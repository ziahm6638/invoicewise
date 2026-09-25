import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  DEFAULT_ALERT_THRESHOLDS,
  alertThresholdsFromEnv,
  evaluateAlerts,
} from "./alerts";
import type { OpsMetrics } from "./metrics";
import { isOperatorAuthorized, registerHealthRoutes } from "./route";

const quiet: OpsMetrics = {
  service: "invoicewise-api",
  environment: "test",
  version: "abc",
  generatedAt: new Date(0).toISOString(),
  process: { uptimeSeconds: 10, rssBytes: 200_000_000, heapUsedBytes: 1 },
  database: {
    ok: true,
    latencyMs: 1,
    sizeBytes: 50_000_000,
    pool: {
      max: 10,
      open: 2,
      idle: 2,
      active: 0,
      waiting: 0,
      utilizationPercent: 0,
    },
  },
  cache: { ok: true, latencyMs: 1 },
  storage: { backend: "local", freeBytes: 80, totalBytes: 100 },
  queue: [
    {
      workflow: "process-attachment",
      due: 0,
      scheduled: 0,
      running: 1,
      stuck: 0,
      retrying: 0,
      oldestDueSeconds: 0,
      failedLastHour: 0,
      succeededLastHour: 4,
    },
  ],
  latency: {
    extraction: { count: 4, p50Seconds: 20, p95Seconds: 40, maxSeconds: 45 },
    delivery: {
      count: 0,
      p50Seconds: null,
      p95Seconds: null,
      maxSeconds: null,
    },
  },
  providers: {
    lastHour: [
      {
        provider: "typesafe",
        operation: "systemone",
        calls: 8,
        failures: 0,
        throttled: 0,
        inputTokens: 1000,
        outputTokens: 100,
        avgMs: 900,
        maxMs: 1500,
      },
    ],
    today: [],
  },
  budget: { typesafe: { callsToday: 8, dailyLimit: 100, remaining: 92 } },
  cost: {
    typesafe: {
      inputTokensToday: 1000,
      outputTokensToday: 100,
      estimatedGbpToday: null,
    },
  },
};

describe("operator alerts", () => {
  test("a healthy service raises nothing", () => {
    expect(evaluateAlerts(quiet)).toEqual([]);
  });

  test("each rule fires on its own signal with a stable key", () => {
    const loud: OpsMetrics = {
      ...quiet,
      process: { ...quiet.process, rssBytes: 1_700_000_000 },
      database: {
        ...quiet.database,
        sizeBytes: 21 * 1024 ** 3,
        pool: { ...quiet.database.pool, waiting: 3 },
      },
      cache: { ok: false, latencyMs: null },
      storage: { backend: "local", freeBytes: 4, totalBytes: 100 },
      queue: [
        {
          ...quiet.queue[0]!,
          stuck: 2,
          due: 30,
          oldestDueSeconds: 20 * 60,
          failedLastHour: 5,
        },
      ],
      latency: {
        ...quiet.latency,
        extraction: {
          count: 3,
          p50Seconds: 300,
          p95Seconds: 700,
          maxSeconds: 800,
        },
      },
      providers: {
        lastHour: [
          { ...quiet.providers.lastHour[0]!, failures: 4, throttled: 2 },
        ],
        today: [],
      },
      budget: { typesafe: { callsToday: 100, dailyLimit: 100, remaining: 0 } },
    };

    const alerts = evaluateAlerts(loud);
    expect(alerts.map((alert) => `${alert.severity}:${alert.key}`)).toEqual([
      "critical:workflow_stuck:process-attachment",
      "warning:queue_age:process-attachment",
      "warning:workflow_failures:process-attachment",
      "warning:intake_latency",
      "warning:provider_throttled:typesafe/systemone",
      "warning:provider_errors:typesafe/systemone",
      "critical:provider_budget:typesafe",
      "critical:storage_capacity",
      "warning:database_size",
      "warning:database_pool",
      "warning:cache_unavailable",
      "warning:api_memory",
    ]);
  });

  test("budget warns before it is spent", () => {
    const alerts = evaluateAlerts({
      ...quiet,
      budget: { typesafe: { callsToday: 85, dailyLimit: 100, remaining: 15 } },
    });
    expect(alerts).toEqual([
      {
        key: "provider_budget:typesafe",
        severity: "warning",
        summary: "TypeSafe daily budget 85% used (85/100 calls).",
      },
    ]);
  });

  test("thresholds come from positive OPS_ALERT_* values only", () => {
    const thresholds = alertThresholdsFromEnv({
      OPS_ALERT_QUEUE_AGE_SECONDS: "60",
      OPS_ALERT_FAILURES_PER_HOUR: "-1",
      OPS_ALERT_DATABASE_BYTES: "nonsense",
    });
    expect(thresholds.queueAgeSeconds).toBe(60);
    expect(thresholds.failuresPerHour).toBe(
      DEFAULT_ALERT_THRESHOLDS.failuresPerHour,
    );
    expect(thresholds.databaseBytes).toBe(
      DEFAULT_ALERT_THRESHOLDS.databaseBytes,
    );
  });
});

describe("public health and operator diagnostics", () => {
  const appWith = (
    checkDatabase: () => Promise<unknown>,
    env: Record<string, string | undefined> = {},
  ) => {
    const app = new Hono();
    registerHealthRoutes(app, {
      // Never reached by these requests: metrics need a valid token.
      db: undefined as never,
      checkDatabase,
      env,
    });
    return app;
  };

  test("readiness reports ok or unavailable and nothing else", async () => {
    const healthy = await appWith(async () => undefined).request("/health");
    expect(healthy.status).toBe(200);
    expect(await healthy.json()).toEqual({ status: "ok" });

    const failing = appWith(async () => {
      throw new Error(
        "connect ECONNREFUSED postgresql://invoicewise:secret@invoicewise-db:5432",
      );
    });
    for (const path of ["/health", "/health/ready"]) {
      const response = await failing.request(path);
      expect(response.status).toBe(503);
      const body = await response.text();
      expect(JSON.parse(body)).toEqual({ status: "unavailable" });
      expect(body).not.toContain("secret");
      expect(body).not.toContain("ECONNREFUSED");
    }

    // Liveness never touches a dependency.
    const live = await failing.request("/health/live");
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ status: "ok" });
  });

  test("inherited pool and database diagnostics are not public", async () => {
    const app = appWith(async () => undefined, { OPS_TOKEN: "t".repeat(64) });
    for (const path of ["/health/pools", "/health/db"]) {
      expect((await app.request(path)).status).toBe(404);
    }
  });

  test("metrics require the operator token and vanish without one", async () => {
    const unconfigured = appWith(async () => undefined);
    expect((await unconfigured.request("/ops/metrics")).status).toBe(404);

    const token = "a".repeat(64);
    const configured = appWith(async () => undefined, { OPS_TOKEN: token });
    expect((await configured.request("/ops/metrics")).status).toBe(401);
    const wrong = await configured.request("/ops/metrics", {
      headers: { authorization: `Bearer ${"b".repeat(64)}` },
    });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: "Unauthorized" });
  });

  test("the bearer check is exact", () => {
    expect(isOperatorAuthorized("Bearer abc", "abc")).toBe(true);
    expect(isOperatorAuthorized("Bearer abcd", "abc")).toBe(false);
    expect(isOperatorAuthorized("abc", "abc")).toBe(false);
    expect(isOperatorAuthorized("Bearer ", undefined)).toBe(false);
    expect(isOperatorAuthorized(undefined, "abc")).toBe(false);
  });
});
