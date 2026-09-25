import type { OpsMetrics } from "./metrics";

/**
 * Actionable alert rules over the operator metrics. Pure, so the thresholds
 * are unit tested; the host monitor (ops/monitor) mails whatever this
 * returns. Summaries name workflows, providers and numbers only, never
 * invoice contents, file names, workspaces or provider error text.
 */

export type AlertSeverity = "warning" | "critical";

export type OpsAlert = {
  /** Stable identity, so the monitor can de-duplicate and report recovery. */
  key: string;
  severity: AlertSeverity;
  summary: string;
};

export type AlertThresholds = {
  queueAgeSeconds: number;
  failuresPerHour: number;
  intakeP95Seconds: number;
  providerFailureRatio: number;
  providerMinCalls: number;
  budgetWarnRatio: number;
  storageFreeWarnRatio: number;
  storageFreeCriticalRatio: number;
  databaseBytes: number;
  rssBytes: number;
};

export const DEFAULT_ALERT_THRESHOLDS: AlertThresholds = {
  queueAgeSeconds: 15 * 60,
  failuresPerHour: 3,
  intakeP95Seconds: 10 * 60,
  providerFailureRatio: 0.25,
  providerMinCalls: 4,
  budgetWarnRatio: 0.8,
  storageFreeWarnRatio: 0.15,
  storageFreeCriticalRatio: 0.05,
  databaseBytes: 20 * 1024 ** 3,
  rssBytes: 1_600_000_000,
};

const ENV_THRESHOLDS: Record<keyof AlertThresholds, string> = {
  queueAgeSeconds: "OPS_ALERT_QUEUE_AGE_SECONDS",
  failuresPerHour: "OPS_ALERT_FAILURES_PER_HOUR",
  intakeP95Seconds: "OPS_ALERT_INTAKE_P95_SECONDS",
  providerFailureRatio: "OPS_ALERT_PROVIDER_FAILURE_RATIO",
  providerMinCalls: "OPS_ALERT_PROVIDER_MIN_CALLS",
  budgetWarnRatio: "OPS_ALERT_BUDGET_WARN_RATIO",
  storageFreeWarnRatio: "OPS_ALERT_STORAGE_FREE_WARN_RATIO",
  storageFreeCriticalRatio: "OPS_ALERT_STORAGE_FREE_CRITICAL_RATIO",
  databaseBytes: "OPS_ALERT_DATABASE_BYTES",
  rssBytes: "OPS_ALERT_RSS_BYTES",
};

/** Defaults, overridden by any positive numeric `OPS_ALERT_*` setting. */
export const alertThresholdsFromEnv = (
  env: Record<string, string | undefined> = process.env,
): AlertThresholds => {
  const thresholds = { ...DEFAULT_ALERT_THRESHOLDS };
  for (const [key, name] of Object.entries(ENV_THRESHOLDS) as [
    keyof AlertThresholds,
    string,
  ][]) {
    const value = Number(env[name]);
    if (env[name] && Number.isFinite(value) && value > 0) {
      thresholds[key] = value;
    }
  }
  return thresholds;
};

const minutes = (seconds: number) => `${Math.round(seconds / 60)} min`;
const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
const percent = (ratio: number) => `${Math.round(ratio * 100)}%`;

export function evaluateAlerts(
  metrics: OpsMetrics,
  thresholds: AlertThresholds = DEFAULT_ALERT_THRESHOLDS,
): OpsAlert[] {
  const alerts: OpsAlert[] = [];

  for (const queue of metrics.queue) {
    if (queue.stuck > 0) {
      alerts.push({
        key: `workflow_stuck:${queue.workflow}`,
        severity: "critical",
        summary: `${queue.stuck} ${queue.workflow} job(s) hold an expired lease: no runner is reclaiming work.`,
      });
    }
    if (queue.oldestDueSeconds >= thresholds.queueAgeSeconds) {
      alerts.push({
        key: `queue_age:${queue.workflow}`,
        severity: "warning",
        summary: `Oldest due ${queue.workflow} job has waited ${minutes(queue.oldestDueSeconds)} (${queue.due} due).`,
      });
    }
    if (queue.failedLastHour >= thresholds.failuresPerHour) {
      alerts.push({
        key: `workflow_failures:${queue.workflow}`,
        severity: "warning",
        summary: `${queue.failedLastHour} ${queue.workflow} job(s) failed permanently in the last hour.`,
      });
    }
  }

  const extraction = metrics.latency.extraction;
  if (
    extraction.p95Seconds !== null &&
    extraction.p95Seconds >= thresholds.intakeP95Seconds
  ) {
    alerts.push({
      key: "intake_latency",
      severity: "warning",
      summary: `Intake p95 is ${minutes(extraction.p95Seconds)} over ${extraction.count} document(s) in the last 24 hours.`,
    });
  }

  for (const usage of metrics.providers.lastHour) {
    const name = `${usage.provider}/${usage.operation}`;
    if (usage.throttled > 0) {
      alerts.push({
        key: `provider_throttled:${name}`,
        severity: "warning",
        summary: `${name} rate-limited ${usage.throttled} of ${usage.calls} call(s) in the last hour.`,
      });
    }
    if (
      usage.calls >= thresholds.providerMinCalls &&
      usage.failures / usage.calls >= thresholds.providerFailureRatio
    ) {
      alerts.push({
        key: `provider_errors:${name}`,
        severity: "warning",
        summary: `${name} failed ${usage.failures} of ${usage.calls} call(s) in the last hour (average ${usage.avgMs} ms, max ${usage.maxMs} ms).`,
      });
    }
  }

  const budget = metrics.budget.typesafe;
  if (budget.dailyLimit > 0) {
    const ratio = budget.callsToday / budget.dailyLimit;
    if (ratio >= 1) {
      alerts.push({
        key: "provider_budget:typesafe",
        severity: "critical",
        summary: `TypeSafe daily budget spent (${budget.callsToday}/${budget.dailyLimit} calls): document processing is paused until 00:00 UTC.`,
      });
    } else if (ratio >= thresholds.budgetWarnRatio) {
      alerts.push({
        key: "provider_budget:typesafe",
        severity: "warning",
        summary: `TypeSafe daily budget ${percent(ratio)} used (${budget.callsToday}/${budget.dailyLimit} calls).`,
      });
    }
  }

  const storage = metrics.storage;
  if (storage.totalBytes && storage.freeBytes !== null) {
    const free = storage.freeBytes / storage.totalBytes;
    if (free <= thresholds.storageFreeWarnRatio) {
      alerts.push({
        key: "storage_capacity",
        severity:
          free <= thresholds.storageFreeCriticalRatio ? "critical" : "warning",
        summary: `Document storage volume has ${percent(free)} free (${gib(storage.freeBytes)} of ${gib(storage.totalBytes)}).`,
      });
    }
  }

  if (metrics.database.sizeBytes >= thresholds.databaseBytes) {
    alerts.push({
      key: "database_size",
      severity: "warning",
      summary: `Database is ${gib(metrics.database.sizeBytes)} (alert at ${gib(thresholds.databaseBytes)}).`,
    });
  }
  if (metrics.database.pool.waiting > 0) {
    alerts.push({
      key: "database_pool",
      severity: "warning",
      summary: `${metrics.database.pool.waiting} request(s) waiting for one of ${metrics.database.pool.max} database connections.`,
    });
  }

  if (!metrics.cache.ok) {
    alerts.push({
      key: "cache_unavailable",
      severity: "warning",
      summary:
        "Redis (session, permission and API-key cache) is not answering.",
    });
  }

  if (metrics.process.rssBytes >= thresholds.rssBytes) {
    alerts.push({
      key: "api_memory",
      severity: "warning",
      summary: `API process memory is ${gib(metrics.process.rssBytes)} (alert at ${gib(thresholds.rssBytes)}).`,
    });
  }

  return alerts;
}
