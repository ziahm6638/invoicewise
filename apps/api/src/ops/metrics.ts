import { statfs } from "node:fs/promises";
import { checkHealth as checkCacheHealth } from "@invoicewise/cache/health";
import type { Database } from "@invoicewise/db/client";
import {
  type LatencySummary,
  type ProviderUsageSummary,
  type WorkflowQueueSummary,
  getDatabaseSizeBytes,
  getPipelineLatency,
  getProviderUsageSince,
  getWorkflowQueueSummary,
} from "@invoicewise/db/queries";
import { sql } from "drizzle-orm";

/**
 * The operator view of one API process and its dependencies. Aggregates
 * only: counts, ages, sizes, timings and token totals. Served behind
 * OPS_TOKEN at /ops/metrics; nothing here is safe to reach publicly because
 * it describes capacity and load, but none of it contains customer data.
 */
export type OpsMetrics = {
  service: string;
  environment: string;
  version: string;
  generatedAt: string;
  process: { uptimeSeconds: number; rssBytes: number; heapUsedBytes: number };
  database: {
    ok: boolean;
    latencyMs: number | null;
    sizeBytes: number;
    pool: {
      max: number;
      open: number;
      idle: number;
      active: number;
      waiting: number;
      utilizationPercent: number;
    };
  };
  cache: { ok: boolean; latencyMs: number | null };
  storage: {
    backend: string;
    freeBytes: number | null;
    totalBytes: number | null;
  };
  queue: WorkflowQueueSummary[];
  latency: { extraction: LatencySummary; delivery: LatencySummary };
  providers: {
    lastHour: ProviderUsageSummary[];
    today: ProviderUsageSummary[];
  };
  budget: {
    typesafe: {
      callsToday: number;
      dailyLimit: number;
      remaining: number | null;
    };
  };
  cost: {
    typesafe: {
      inputTokensToday: number;
      outputTokensToday: number;
      /** Only when TYPESAFE_GBP_PER_MILLION_{INPUT,OUTPUT}_TOKENS are set. */
      estimatedGbpToday: number | null;
    };
  };
};

export type MetricsDeps = {
  db: Database;
  poolStats: () => OpsMetrics["database"]["pool"];
  env?: Record<string, string | undefined>;
  checkCache?: () => Promise<void>;
  now?: () => Date;
};

const timed = async (work: () => Promise<unknown>) => {
  const startedAt = performance.now();
  try {
    await work();
    return { ok: true, latencyMs: Math.round(performance.now() - startedAt) };
  } catch {
    return { ok: false, latencyMs: null };
  }
};

const positiveNumber = (value: string | undefined) => {
  const number = Number(value);
  return value && Number.isFinite(number) && number > 0 ? number : null;
};

async function storageCapacity(env: Record<string, string | undefined>) {
  const backend = env.STORAGE_BACKEND ?? "local";
  if (backend !== "local" || !env.LOCAL_STORAGE_PATH) {
    return { backend, freeBytes: null, totalBytes: null };
  }
  try {
    const stats = await statfs(env.LOCAL_STORAGE_PATH);
    return {
      backend,
      freeBytes: Number(stats.bavail) * Number(stats.bsize),
      totalBytes: Number(stats.blocks) * Number(stats.bsize),
    };
  } catch {
    return { backend, freeBytes: null, totalBytes: null };
  }
}

export async function collectOpsMetrics(
  deps: MetricsDeps,
): Promise<OpsMetrics> {
  const env = deps.env ?? process.env;
  const now = deps.now?.() ?? new Date();
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const startOfDay = new Date(now);
  startOfDay.setUTCHours(0, 0, 0, 0);

  const [database, cache, storage, queue, latency, lastHour, today, size] =
    await Promise.all([
      timed(() => deps.db.execute(sql`select 1`)),
      timed(deps.checkCache ?? checkCacheHealth),
      storageCapacity(env),
      getWorkflowQueueSummary(deps.db),
      getPipelineLatency(deps.db, dayAgo),
      getProviderUsageSince(deps.db, hourAgo),
      getProviderUsageSince(deps.db, startOfDay),
      getDatabaseSizeBytes(deps.db),
    ]);

  const typesafeToday = today.filter((usage) => usage.provider === "typesafe");
  const callsToday = typesafeToday.reduce((sum, usage) => sum + usage.calls, 0);
  const inputTokensToday = typesafeToday.reduce(
    (sum, usage) => sum + usage.inputTokens,
    0,
  );
  const outputTokensToday = typesafeToday.reduce(
    (sum, usage) => sum + usage.outputTokens,
    0,
  );
  const dailyLimit = positiveNumber(env.TYPESAFE_DAILY_CALL_LIMIT) ?? 0;
  const inputPrice = positiveNumber(env.TYPESAFE_GBP_PER_MILLION_INPUT_TOKENS);
  const outputPrice = positiveNumber(
    env.TYPESAFE_GBP_PER_MILLION_OUTPUT_TOKENS,
  );
  const memory = process.memoryUsage();

  return {
    service: "invoicewise-api",
    environment: env.INVOICEWISE_ENVIRONMENT ?? "production",
    version: env.KAMAL_VERSION ?? "unknown",
    generatedAt: now.toISOString(),
    process: {
      uptimeSeconds: Math.round(process.uptime()),
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
    },
    database: { ...database, sizeBytes: size, pool: deps.poolStats() },
    cache,
    storage,
    queue,
    latency,
    providers: { lastHour, today },
    budget: {
      typesafe: {
        callsToday,
        dailyLimit,
        remaining: dailyLimit > 0 ? Math.max(0, dailyLimit - callsToday) : null,
      },
    },
    cost: {
      typesafe: {
        inputTokensToday,
        outputTokensToday,
        estimatedGbpToday:
          inputPrice !== null && outputPrice !== null
            ? Math.round(
                ((inputTokensToday * inputPrice +
                  outputTokensToday * outputPrice) /
                  1_000_000) *
                  100,
              ) / 100
            : null,
      },
    },
  };
}
