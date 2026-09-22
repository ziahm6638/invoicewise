import type { Database } from "@db/client";
import { workflowJobs } from "@db/schema";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";

export type WorkflowJob = typeof workflowJobs.$inferSelect;

export type EnqueueWorkflowJobParams = {
  name: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  teamId?: string;
  runAt?: Date;
  maxAttempts?: number;
};

export async function enqueueWorkflowJob(
  db: Database,
  params: EnqueueWorkflowJobParams,
) {
  const [inserted] = await db
    .insert(workflowJobs)
    .values({
      name: params.name,
      payload: params.payload,
      idempotencyKey: params.idempotencyKey,
      teamId: params.teamId,
      runAt: params.runAt?.toISOString(),
      maxAttempts: params.maxAttempts,
    })
    .onConflictDoNothing({
      target: [workflowJobs.name, workflowJobs.idempotencyKey],
    })
    .returning();

  if (inserted) return { job: inserted, deduplicated: false };

  const [existing] = await db
    .select()
    .from(workflowJobs)
    .where(
      and(
        eq(workflowJobs.name, params.name),
        eq(workflowJobs.idempotencyKey, params.idempotencyKey),
      ),
    )
    .limit(1);

  if (!existing) throw new Error("Unable to enqueue workflow");
  return { job: existing, deduplicated: true };
}

export async function claimWorkflowJobs(
  db: Database,
  params: { workerId: string; limit: number; leaseMs: number },
) {
  return db.transaction(async (tx) => {
    const now = new Date();
    const nowIso = now.toISOString();

    await tx
      .update(workflowJobs)
      .set({
        status: "failed",
        finishedAt: nowIso,
        lastError: "Workflow lease expired after its final attempt",
        lockedBy: null,
        lockedAt: null,
        heartbeatAt: null,
        leaseExpiresAt: null,
        updatedAt: nowIso,
      })
      .where(
        and(
          eq(workflowJobs.status, "running"),
          lte(workflowJobs.leaseExpiresAt, nowIso),
          sql`${workflowJobs.attempts} >= ${workflowJobs.maxAttempts}`,
        ),
      );

    const claimable = await tx
      .select({ id: workflowJobs.id })
      .from(workflowJobs)
      .where(
        and(
          lt(workflowJobs.attempts, workflowJobs.maxAttempts),
          or(
            and(
              eq(workflowJobs.status, "queued"),
              lte(workflowJobs.runAt, nowIso),
            ),
            and(
              eq(workflowJobs.status, "running"),
              lte(workflowJobs.leaseExpiresAt, nowIso),
            ),
          ),
        ),
      )
      .orderBy(asc(workflowJobs.runAt), asc(workflowJobs.createdAt))
      .limit(params.limit)
      .for("update", { skipLocked: true });

    if (claimable.length === 0) return [];

    return tx
      .update(workflowJobs)
      .set({
        status: "running",
        attempts: sql`${workflowJobs.attempts} + 1`,
        lockedBy: params.workerId,
        lockedAt: nowIso,
        heartbeatAt: nowIso,
        leaseExpiresAt: new Date(now.getTime() + params.leaseMs).toISOString(),
        updatedAt: nowIso,
      })
      .where(
        inArray(
          workflowJobs.id,
          claimable.map(({ id }) => id),
        ),
      )
      .returning();
  });
}

export async function heartbeatWorkflowJob(
  db: Database,
  params: { id: string; workerId: string; leaseMs: number },
) {
  const now = new Date();
  const [job] = await db
    .update(workflowJobs)
    .set({
      heartbeatAt: now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() + params.leaseMs).toISOString(),
      updatedAt: now.toISOString(),
    })
    .where(
      and(
        eq(workflowJobs.id, params.id),
        eq(workflowJobs.status, "running"),
        eq(workflowJobs.lockedBy, params.workerId),
      ),
    )
    .returning({ id: workflowJobs.id });
  return job;
}

export async function completeWorkflowJob(
  db: Database,
  params: {
    id: string;
    workerId: string;
    result: Record<string, unknown>;
  },
) {
  const now = new Date().toISOString();
  const [job] = await db
    .update(workflowJobs)
    .set({
      status: "succeeded",
      result: params.result,
      finishedAt: now,
      lockedBy: null,
      lockedAt: null,
      heartbeatAt: null,
      leaseExpiresAt: null,
      lastError: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(workflowJobs.id, params.id),
        eq(workflowJobs.lockedBy, params.workerId),
      ),
    )
    .returning();
  return job;
}

export async function retryWorkflowJob(
  db: Database,
  params: { id: string; workerId: string; error: string; delayMs: number },
) {
  const now = new Date();
  const [job] = await db
    .update(workflowJobs)
    .set({
      status: "queued",
      runAt: new Date(now.getTime() + params.delayMs).toISOString(),
      lockedBy: null,
      lockedAt: null,
      heartbeatAt: null,
      leaseExpiresAt: null,
      lastError: params.error,
      updatedAt: now.toISOString(),
    })
    .where(
      and(
        eq(workflowJobs.id, params.id),
        eq(workflowJobs.lockedBy, params.workerId),
      ),
    )
    .returning();
  return job;
}

export async function failWorkflowJob(
  db: Database,
  params: { id: string; workerId: string; error: string },
) {
  const now = new Date().toISOString();
  const [job] = await db
    .update(workflowJobs)
    .set({
      status: "failed",
      finishedAt: now,
      lockedBy: null,
      lockedAt: null,
      heartbeatAt: null,
      leaseExpiresAt: null,
      lastError: params.error,
      updatedAt: now,
    })
    .where(
      and(
        eq(workflowJobs.id, params.id),
        eq(workflowJobs.lockedBy, params.workerId),
      ),
    )
    .returning();
  return job;
}

export async function getWorkflowJob(
  db: Database,
  params: { id: string; teamId?: string },
) {
  const [job] = await db
    .select()
    .from(workflowJobs)
    .where(
      and(
        eq(workflowJobs.id, params.id),
        params.teamId
          ? eq(workflowJobs.teamId, params.teamId)
          : isNull(workflowJobs.teamId),
      ),
    )
    .limit(1);
  return job;
}

export async function getWorkflowJobByKey(
  db: Database,
  params: { name: string; idempotencyKey: string; teamId: string },
) {
  const [job] = await db
    .select()
    .from(workflowJobs)
    .where(
      and(
        eq(workflowJobs.name, params.name),
        eq(workflowJobs.idempotencyKey, params.idempotencyKey),
        eq(workflowJobs.teamId, params.teamId),
      ),
    )
    .limit(1);
  return job;
}

export async function restartFailedWorkflowJob(
  db: Database,
  params: { id: string; teamId: string },
) {
  const now = new Date().toISOString();
  const [job] = await db
    .update(workflowJobs)
    .set({
      status: "queued",
      attempts: 0,
      runAt: now,
      lockedBy: null,
      lockedAt: null,
      heartbeatAt: null,
      leaseExpiresAt: null,
      finishedAt: null,
      lastError: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(workflowJobs.id, params.id),
        eq(workflowJobs.teamId, params.teamId),
        eq(workflowJobs.status, "failed"),
      ),
    )
    .returning();
  return job;
}

export function listWorkflowJobs(db: Database, limit = 50) {
  return db
    .select()
    .from(workflowJobs)
    .orderBy(desc(workflowJobs.createdAt))
    .limit(limit);
}
