import { createHash, timingSafeEqual } from "node:crypto";
import { getConnectionPoolStats } from "@invoicewise/db/client";
import type { Database } from "@invoicewise/db/client";
import type { Hono } from "hono";
import { alertThresholdsFromEnv, evaluateAlerts } from "./alerts";
import { collectOpsMetrics } from "./metrics";

/**
 * Public health and operator diagnostics.
 *
 * - `/health/live`: the process is serving. No dependency is touched.
 * - `/health` and `/health/ready`: the database answers; kamal-proxy gates
 *   traffic on this. Only `ok`/`unavailable`, never pools, timings or errors.
 * - `/ops/metrics`: queue, latency, provider, capacity and cost aggregates
 *   plus the alerts they raise. Requires `Authorization: Bearer $OPS_TOKEN`;
 *   without a configured token the route does not exist.
 */

const READINESS_TIMEOUT_MS = 3000;

const noStore = { "cache-control": "no-store" };

const digest = (value: string) => createHash("sha256").update(value).digest();

/** Constant-time bearer check; false whenever no token is configured. */
export function isOperatorAuthorized(
  authorization: string | null | undefined,
  token: string | undefined,
) {
  if (!token || !authorization?.startsWith("Bearer ")) return false;
  return timingSafeEqual(
    digest(authorization.slice("Bearer ".length)),
    digest(token),
  );
}

export async function isReady(check: () => Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      check(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("readiness timeout")),
          READINESS_TIMEOUT_MS,
        );
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function registerHealthRoutes(
  app: Hono<any>,
  deps: {
    db: Database;
    checkDatabase: () => Promise<unknown>;
    env?: Record<string, string | undefined>;
  },
) {
  const env = deps.env ?? process.env;

  app.get("/health/live", (c) => c.json({ status: "ok" }, 200, noStore));

  const readiness = async () =>
    (await isReady(deps.checkDatabase))
      ? Response.json({ status: "ok" }, { status: 200, headers: noStore })
      : Response.json(
          { status: "unavailable" },
          { status: 503, headers: noStore },
        );
  app.get("/health", readiness);
  app.get("/health/ready", readiness);

  app.get("/ops/metrics", async (c) => {
    if (!env.OPS_TOKEN) return c.notFound();
    if (!isOperatorAuthorized(c.req.header("authorization"), env.OPS_TOKEN)) {
      return c.json({ error: "Unauthorized" }, 401, noStore);
    }
    try {
      const metrics = await collectOpsMetrics({
        db: deps.db,
        poolStats: getConnectionPoolStats,
        env,
      });
      return c.json(
        {
          ...metrics,
          alerts: evaluateAlerts(metrics, alertThresholdsFromEnv(env)),
        },
        200,
        noStore,
      );
    } catch (error) {
      // A dependency failed mid-collection. The monitor alerts on this
      // status; the cause goes to the API log, never into the response.
      console.error(
        JSON.stringify({
          event: "ops_metrics_failed",
          error: error instanceof Error ? error.message : "unknown",
        }),
      );
      return c.json({ error: "metrics_unavailable" }, 503, noStore);
    }
  });
}
