import type { IntakeStageSummary } from "@invoicewise/db/queries";
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
  intakeTextP95Seconds: number;
  intakeScanP95Seconds: number;
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
  // docs/operations.md#service-and-load-targets: a text PDF within a minute,
  // a scan within three.
  intakeTextP95Seconds: 60,
  intakeScanP95Seconds: 3 * 60,
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
  intakeTextP95Seconds: "OPS_ALERT_INTAKE_TEXT_P95_SECONDS",
  intakeScanP95Seconds: "OPS_ALERT_INTAKE_SCAN_P95_SECONDS",
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
const duration = (seconds: number) =>
  seconds < 120 ? `${Math.round(seconds)} s` : minutes(seconds);
const stageSummary = (stages: IntakeStageSummary) =>
  (
    [
      ["queue", stages.queueP95Seconds],
      ["text/OCR", stages.readP95Seconds],
      ["TypeSafe", stages.typesafeP95Seconds],
      ["save", stages.persistP95Seconds],
    ] as const
  )
    .map(([stage, seconds]) =>
      seconds === null ? `${stage} -` : `${stage} ${seconds} s`,
    )
    .join(", ");
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

  const intakeTargets = [
    ["text", "Text PDF", thresholds.intakeTextP95Seconds],
    ["scan", "Scanned document", thresholds.intakeScanP95Seconds],
  ] as const;
  for (const [kind, label, target] of intakeTargets) {
    const intake = metrics.latency.intake[kind];
    if (intake.p95Seconds !== null && intake.p95Seconds >= target) {
      alerts.push({
        key: `intake_latency:${kind}`,
        severity: "warning",
        summary: `${label} intake p95 is ${duration(intake.p95Seconds)} (target ${duration(target)}) over ${intake.count} document(s) in the last 24 hours; stage p95s: ${stageSummary(intake.stages)}.`,
      });
    }
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
