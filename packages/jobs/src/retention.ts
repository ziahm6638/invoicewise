import type { Database } from "@invoicewise/db/client";
import {
  clearExpiredEmailReferences,
  clearExpiredInboundEmailHeaders,
  clearExpiredInboundEmailSources,
  clearExpiredRedeliveryReferences,
  deleteExpiredAuditEvents,
  deleteExpiredCancelledIntake,
  listExpiredDataExports,
  markDataExportExpired,
  redactFinishedJobPayloads,
  redactFinishedWebhookPayloads,
} from "@invoicewise/db/queries";
import {
  defaultExportTempDir,
  isDataExportObjectPath,
  removeStaleExportTempFiles,
} from "./data-export";
import { type IntakeStorage, discardStaleReservations } from "./intake";
import type { RetentionPolicy } from "./retention-policy";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export type RetentionStep =
  | "export-archives"
  | "export-temp-files"
  | "failed-uploads"
  | "failed-upload-records"
  | "failed-inbound-email"
  | "source-email"
  | "job-payloads"
  | "webhook-payloads"
  | "audit-events";

export type RetentionDeps = {
  db: Database;
  storage: IntakeStorage;
  policy: RetentionPolicy;
  now?: () => Date;
  /** Rows changed per statement; each batch commits on its own. */
  batchSize?: number;
  exportTempDir?: string;
  /**
   * Called after every committed batch. Tests use it to interrupt a sweep
   * part-way and prove the next run resumes.
   */
  afterBatch?: (step: RetentionStep, count: number) => Promise<void> | void;
};

export type RetentionSweepResult = {
  counts: Record<RetentionStep, number>;
  failures: { step: RetentionStep; id: string; error: string }[];
  /** Records left alone because they did not pass a safety check. */
  refused: { step: RetentionStep; id: string; reason: string }[];
};

export class RetentionSweepError extends Error {
  constructor(readonly result: RetentionSweepResult) {
    super(
      `Retention sweep finished with ${result.failures.length} failure(s): ${result.failures
        .slice(0, 3)
        .map((failure) => `${failure.step} ${failure.id}: ${failure.error}`)
        .join("; ")}`,
    );
  }
}

/**
 * Applies the retention policy once.
 *
 * Every step works in small batches chosen by a predicate that stops matching
 * once a record has been handled, so a sweep that fails or is interrupted
 * resumes where it stopped on the next run and repeating a finished sweep
 * changes nothing. Steps only remove or empty records; none of them creates
 * or re-queues work, so a sweep can never bring deleted data back. Objects are
 * removed only at paths that belong to the record being expired.
 */
export async function runRetentionSweep(
  deps: RetentionDeps,
): Promise<RetentionSweepResult> {
  const now = (deps.now ?? (() => new Date()))();
  const batchSize = Math.max(1, deps.batchSize ?? 200);
  const result: RetentionSweepResult = {
    counts: {
      "export-archives": 0,
      "export-temp-files": 0,
      "failed-uploads": 0,
      "failed-upload-records": 0,
      "failed-inbound-email": 0,
      "source-email": 0,
      "job-payloads": 0,
      "webhook-payloads": 0,
      "audit-events": 0,
    },
    failures: [],
    refused: [],
  };

  const record = async (step: RetentionStep, count: number) => {
    result.counts[step] += count;
    if (count > 0) await deps.afterBatch?.(step, count);
  };

  const drain = async (step: RetentionStep, run: () => Promise<unknown[]>) => {
    for (;;) {
      const rows = await run();
      await record(step, rows.length);
      if (rows.length < batchSize) return;
    }
  };

  const before = (days: number) => new Date(now.getTime() - days * DAY_MS);

  // 1. Export archives past their download window, and any archive a failed
  //    build left behind.
  const handledExports = new Set<string>();
  for (;;) {
    const expired = (
      await listExpiredDataExports(deps.db, now, batchSize)
    ).filter((row) => !handledExports.has(row.id));
    if (expired.length === 0) break;

    let changed = 0;
    for (const row of expired) {
      handledExports.add(row.id);
      if (
        row.filePath?.length &&
        !isDataExportObjectPath(row.filePath, row.teamId, row.id)
      ) {
        result.refused.push({
          step: "export-archives",
          id: row.id,
          reason: "archive path is not this export's own path",
        });
        continue;
      }
      try {
        if (row.filePath?.length) {
          await deps.storage.remove({ bucket: "vault", path: row.filePath });
        }
        if (
          await markDataExportExpired(deps.db, {
            id: row.id,
            teamId: row.teamId,
            filePath: row.filePath,
          })
        ) {
          changed += 1;
        }
      } catch (error) {
        result.failures.push({
          step: "export-archives",
          id: row.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    await record("export-archives", changed);
  }

  // Build files an interrupted export left on this worker's disk.
  const staleTemp = await removeStaleExportTempFiles(
    deps.exportTempDir ?? defaultExportTempDir(),
    6 * HOUR_MS,
    now.getTime(),
  );
  await record("export-temp-files", staleTemp.length);

  // 2. Failed uploads: stale reservations and pending object removals first
  //    (through the intake's own claim-then-remove path), then the records
  //    of uploads that were cancelled more than the period ago.
  let pendingAfter:
    | Parameters<typeof discardStaleReservations>[2]["pendingAfter"]
    | undefined;
  for (;;) {
    const cleanup = await discardStaleReservations(deps.db, deps.storage, {
      olderThanMs: deps.policy.failedUploadDays * DAY_MS,
      limit: batchSize,
      pendingAfter,
    });
    for (const failure of cleanup.failed) {
      result.failures.push({ step: "failed-uploads", ...failure });
    }
    await record("failed-uploads", cleanup.discarded.length);
    if (!cleanup.hasMorePending || !cleanup.nextPendingCursor) break;
    pendingAfter = cleanup.nextPendingCursor;
  }

  await drain("failed-upload-records", () =>
    deleteExpiredCancelledIntake(deps.db, {
      before: before(deps.policy.failedUploadDays),
      limit: batchSize,
    }),
  );

  await drain("failed-inbound-email", () =>
    clearExpiredInboundEmailSources(deps.db, {
      before: before(deps.policy.failedUploadDays),
      limit: batchSize,
    }),
  );

  // 3. Source email: references on invoices and their re-deliveries, and the
  //    headers kept on received messages.
  await drain("source-email", () =>
    clearExpiredEmailReferences(deps.db, {
      before: before(deps.policy.sourceEmailDays),
      limit: batchSize,
    }),
  );
  await drain("source-email", () =>
    clearExpiredRedeliveryReferences(deps.db, {
      before: before(deps.policy.sourceEmailDays),
      limit: batchSize,
    }),
  );
  await drain("source-email", () =>
    clearExpiredInboundEmailHeaders(deps.db, {
      before: before(deps.policy.sourceEmailDays),
      limit: batchSize,
    }),
  );

  // 4. Job and webhook payloads.
  await drain("job-payloads", () =>
    redactFinishedJobPayloads(deps.db, {
      before: before(deps.policy.jobPayloadDays),
      limit: batchSize,
    }),
  );
  await drain("webhook-payloads", () =>
    redactFinishedWebhookPayloads(deps.db, {
      before: before(deps.policy.jobPayloadDays),
      limit: batchSize,
    }),
  );

  // 5. Audit events past their period.
  await drain("audit-events", () =>
    deleteExpiredAuditEvents(deps.db, {
      before: before(deps.policy.auditEventDays),
      limit: batchSize,
    }),
  );

  return result;
}

/** The next hourly retention slot after `now`, as an ISO timestamp. */
export const nextRetentionSlot = (now = new Date()) => {
  const next = new Date(now);
  next.setUTCMinutes(0, 0, 0);
  next.setUTCHours(next.getUTCHours() + 1);
  return next;
};
