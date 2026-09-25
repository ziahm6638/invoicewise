import type { Database, PrimaryDatabase } from "@db/client";
import { providerUsage, workflowJobs } from "@db/schema";
import { and, eq, gte, inArray, sql } from "drizzle-orm";

/**
 * Operator aggregates for the metrics endpoint, alerts and backpressure.
 * Every query returns counts, ages and sizes only: no invoice content, file
 * names, workspace names or provider error text ever leaves these functions.
 */

export type ProviderCallOutcome = "ok" | "failed" | "throttled";

export type ProviderUsageEvent = {
  provider: string;
  operation: string;
  outcome: ProviderCallOutcome;
  durationMs: number;
  inputTokens?: number;
  outputTokens?: number;
  at?: Date;
};

export async function recordProviderUsage(
  db: Database,
  event: ProviderUsageEvent,
) {
  const durationMs = Math.max(0, Math.round(event.durationMs));
  const hour = new Date(event.at ?? Date.now());
  hour.setUTCMinutes(0, 0, 0);
  const failed = event.outcome === "ok" ? 0 : 1;
  const throttled = event.outcome === "throttled" ? 1 : 0;
  const inputTokens = Math.max(0, Math.round(event.inputTokens ?? 0));
  const outputTokens = Math.max(0, Math.round(event.outputTokens ?? 0));

  await db
    .insert(providerUsage)
    .values({
      hour: hour.toISOString(),
      provider: event.provider,
      operation: event.operation,
      calls: 1,
      failures: failed,
      throttled,
      inputTokens,
      outputTokens,
      totalMs: durationMs,
      maxMs: durationMs,
    })
    .onConflictDoUpdate({
      target: [
        providerUsage.hour,
        providerUsage.provider,
        providerUsage.operation,
      ],
      set: {
        calls: sql`${providerUsage.calls} + 1`,
        failures: sql`${providerUsage.failures} + ${failed}`,
        throttled: sql`${providerUsage.throttled} + ${throttled}`,
        inputTokens: sql`${providerUsage.inputTokens} + ${inputTokens}`,
        outputTokens: sql`${providerUsage.outputTokens} + ${outputTokens}`,
        totalMs: sql`${providerUsage.totalMs} + ${durationMs}`,
        maxMs: sql`greatest(${providerUsage.maxMs}, ${durationMs})`,
      },
    });
}

export type ProviderUsageSummary = {
  provider: string;
  operation: string;
  calls: number;
  failures: number;
  throttled: number;
  inputTokens: number;
  outputTokens: number;
  avgMs: number;
  maxMs: number;
};

export async function getProviderUsageSince(
  db: Database,
  since: Date,
): Promise<ProviderUsageSummary[]> {
  const rows = await db
    .select({
      provider: providerUsage.provider,
      operation: providerUsage.operation,
      calls: sql<number>`coalesce(sum(${providerUsage.calls}), 0)::int`,
      failures: sql<number>`coalesce(sum(${providerUsage.failures}), 0)::int`,
      throttled: sql<number>`coalesce(sum(${providerUsage.throttled}), 0)::int`,
      inputTokens: sql<number>`coalesce(sum(${providerUsage.inputTokens}), 0)::float8`,
      outputTokens: sql<number>`coalesce(sum(${providerUsage.outputTokens}), 0)::float8`,
      totalMs: sql<number>`coalesce(sum(${providerUsage.totalMs}), 0)::float8`,
      maxMs: sql<number>`coalesce(max(${providerUsage.maxMs}), 0)::int`,
    })
    .from(providerUsage)
    .where(gte(providerUsage.hour, hourFloor(since)))
    .groupBy(providerUsage.provider, providerUsage.operation)
    .orderBy(providerUsage.provider, providerUsage.operation);

  return rows.map(({ totalMs, ...row }) => ({
    ...row,
    avgMs: row.calls > 0 ? Math.round(totalMs / row.calls) : 0,
  }));
}

/** Calls to one provider since the start of the given hour bucket. */
export async function countProviderCallsSince(
  db: Database,
  provider: string,
  since: Date,
) {
  const [row] = await db
    .select({
      calls: sql<number>`coalesce(sum(${providerUsage.calls}), 0)::int`,
    })
    .from(providerUsage)
    .where(
      and(
        eq(providerUsage.provider, provider),
        gte(providerUsage.hour, hourFloor(since)),
      ),
    );
  return row?.calls ?? 0;
}

const hourFloor = (at: Date) => {
  const hour = new Date(at);
  hour.setUTCMinutes(0, 0, 0);
  return hour.toISOString();
};

export type WorkflowQueueSummary = {
  workflow: string;
  due: number;
  scheduled: number;
  running: number;
  stuck: number;
  retrying: number;
  oldestDueSeconds: number;
  failedLastHour: number;
  succeededLastHour: number;
};

export async function getWorkflowQueueSummary(
  db: Database,
): Promise<WorkflowQueueSummary[]> {
  const result = await db.execute<{
    workflow: string;
    due: number;
    scheduled: number;
    running: number;
    stuck: number;
    retrying: number;
    oldest_due_seconds: number;
    failed_last_hour: number;
    succeeded_last_hour: number;
  }>(sql`
    select
      name as workflow,
      count(*) filter (where status = 'queued' and run_at <= now())::int as due,
      count(*) filter (where status = 'queued' and run_at > now())::int as scheduled,
      count(*) filter (where status = 'running')::int as running,
      count(*) filter (where status = 'running' and lease_expires_at < now())::int as stuck,
      count(*) filter (where status = 'queued' and attempts > 0)::int as retrying,
      coalesce(extract(epoch from now() - min(run_at) filter (where status = 'queued' and run_at <= now())), 0)::int as oldest_due_seconds,
      count(*) filter (where status = 'failed' and finished_at >= now() - interval '1 hour')::int as failed_last_hour,
      count(*) filter (where status = 'succeeded' and finished_at >= now() - interval '1 hour')::int as succeeded_last_hour
    from workflow_jobs
    where status in ('queued', 'running')
       or finished_at >= now() - interval '1 hour'
    group by name
    order by name
  `);

  return result.rows.map((row) => ({
    workflow: row.workflow,
    due: row.due,
    scheduled: row.scheduled,
    running: row.running,
    stuck: row.stuck,
    retrying: row.retrying,
    oldestDueSeconds: row.oldest_due_seconds,
    failedLastHour: row.failed_last_hour,
    succeededLastHour: row.succeeded_last_hour,
  }));
}

export type LatencySummary = {
  count: number;
  p50Seconds: number | null;
  p95Seconds: number | null;
  maxSeconds: number | null;
};

const latency = (row?: {
  count: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
}): LatencySummary => ({
  count: row?.count ?? 0,
  p50Seconds: row?.p50 ?? null,
  p95Seconds: row?.p95 ?? null,
  maxSeconds: row?.max ?? null,
});

/** p95 seconds of each processing stage, over documents that recorded them. */
export type IntakeStageSummary = {
  queueP95Seconds: number | null;
  readP95Seconds: number | null;
  typesafeP95Seconds: number | null;
  persistP95Seconds: number | null;
};

export type IntakeLatencySummary = LatencySummary & {
  stages: IntakeStageSummary;
};

/**
 * Text-layer PDFs and scans (OCR'd PDFs, images, mixed PDFs) have separate
 * targets: docs/operations.md#service-and-load-targets.
 */
export type IntakeInputKind = "text" | "scan";

const stageP95 = (column: string) =>
  sql.raw(
    `round(percentile_cont(0.95) within group (order by (result->'timings'->>'${column}')::float8 / 1000) filter (where result->'timings'->>'${column}' is not null)::numeric, 1)::float8`,
  );

/**
 * Intake latency (document accepted to extraction finished), overall and
 * split by input kind with the stages of each document's final attempt, and
 * intake-to-delivery latency (document accepted to the first successful
 * webhook delivery or accounting draft), over documents finished since `since`.
 */
export async function getPipelineLatency(db: Database, since: Date) {
  const sinceIso = since.toISOString();
  // Bounds the scan: a document delivered in the window was accepted at most
  // a week before it (retries and backoff never approach that).
  const acceptedAfter = new Date(
    since.getTime() - 7 * 24 * 60 * 60 * 1000,
  ).toISOString();
  const extraction = await db.execute<{
    kind: IntakeInputKind | null;
    count: number;
    p50: number | null;
    p95: number | null;
    max: number | null;
    queue_p95: number | null;
    read_p95: number | null;
    typesafe_p95: number | null;
    persist_p95: number | null;
  }>(sql`
    select
      kind,
      count(*)::int as count,
      round(percentile_cont(0.5) within group (order by seconds))::int as p50,
      round(percentile_cont(0.95) within group (order by seconds))::int as p95,
      round(max(seconds))::int as max,
      ${stageP95("queueMs")} as queue_p95,
      ${stageP95("readMs")} as read_p95,
      ${stageP95("typesafeMs")} as typesafe_p95,
      ${stageP95("persistMs")} as persist_p95
    from (
      select
        extract(epoch from finished_at - created_at) as seconds,
        case when coalesce(
          result->>'textSource',
          -- Jobs finished before the result carried the input kind.
          (select extraction->>'textSource' from inbox
            where inbox.id = (workflow_jobs.payload->>'inboxId')::uuid)
        ) in ('ocr', 'mixed') then 'scan' else 'text' end as kind,
        result
      from workflow_jobs
      where name = 'process-attachment'
        and status = 'succeeded'
        and finished_at >= ${sinceIso}
    ) finished
    group by grouping sets ((), (kind))
  `);

  const intake = (kind: IntakeInputKind | null): IntakeLatencySummary => {
    const row = extraction.rows.find((candidate) => candidate.kind === kind);
    return {
      ...latency(row),
      stages: {
        queueP95Seconds: row?.queue_p95 ?? null,
        readP95Seconds: row?.read_p95 ?? null,
        typesafeP95Seconds: row?.typesafe_p95 ?? null,
        persistP95Seconds: row?.persist_p95 ?? null,
      },
    };
  };

  const delivery = await db.execute<{
    count: number;
    p50: number | null;
    p95: number | null;
    max: number | null;
  }>(sql`
    select
      count(*)::int as count,
      round(percentile_cont(0.5) within group (order by seconds))::int as p50,
      round(percentile_cont(0.95) within group (order by seconds))::int as p95,
      round(max(seconds))::int as max
    from (
      select extract(epoch from delivered - inbox.created_at) as seconds
      from inbox
      join lateral (
        select min(at) as delivered from (
          select min(delivered_at) as at
          from webhook_deliveries
          where invoice_id = inbox.id and status = 'succeeded'
          union all
          select inbox.accounting_posted_at
        ) candidates
      ) first_delivery on true
      where inbox.created_at >= ${acceptedAfter}
        and first_delivery.delivered >= ${sinceIso}
    ) delivered
  `);

  const { stages: _, ...overall } = intake(null);
  return {
    extraction: overall,
    intake: { text: intake("text"), scan: intake("scan") },
    delivery: latency(delivery.rows[0]),
  };
}

export async function getDatabaseSizeBytes(db: Database) {
  const result = await db.execute<{ bytes: number }>(
    sql`select pg_database_size(current_database())::float8 as bytes`,
  );
  return result.rows[0]?.bytes ?? 0;
}

/**
 * Queued or running document-processing jobs, for one workspace and for the
 * whole service. Intake refuses new documents above its bounds so queued
 * work, and the provider spend behind it, stays bounded.
 */
export async function countPendingIntakeJobs(
  db: Database | PrimaryDatabase,
  params: { teamId: string },
) {
  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      team: sql<number>`count(*) filter (where ${workflowJobs.teamId} = ${params.teamId})::int`,
    })
    .from(workflowJobs)
    .where(
      and(
        eq(workflowJobs.name, "process-attachment"),
        inArray(workflowJobs.status, ["queued", "running"]),
      ),
    );
  return { total: row?.total ?? 0, team: row?.team ?? 0 };
}
