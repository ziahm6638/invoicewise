/**
 * Invitation delivery across retries. Each invitation is its own queued job,
 * so an SMTP failure for one recipient is retried without resending mail
 * that was already delivered to another.
 */
import { describe, expect, test } from "bun:test";
import type { WorkflowJob } from "@invoicewise/db/queries";
import { Effect, Layer, LogLevel, Logger } from "effect";
import {
  WorkflowRepository,
  WorkflowRunnerSettings,
  runWorkflowBatch,
} from "./runner";
import {
  WorkflowDatabase,
  WorkflowExecutionError,
  WorkflowHandlerLive,
  type WorkflowMail,
  WorkflowMailer,
  WorkflowStorage,
} from "./workflows";

const TEAM_ID = "00000000-0000-0000-0000-000000000002";

const invite = (email: string) => ({
  email,
  invitedByName: "Owner",
  invitedByEmail: "owner@example.test",
  teamName: "Acme",
  inviteCode: `code-${email}`,
});

const inviteJob = (id: string, payload: Record<string, unknown>) =>
  ({
    id,
    name: "invite-team-members",
    teamId: TEAM_ID,
    payload,
    status: "queued",
    attempts: 0,
    maxAttempts: 3,
    runAt: new Date(0).toISOString(),
    lockedBy: null,
    lockedAt: null,
    heartbeatAt: null,
    leaseExpiresAt: null,
    finishedAt: null,
    result: null,
    lastError: null,
    idempotencyKey: id,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  }) as WorkflowJob;

/** An in-memory queue with the runner's claim/retry/complete/fail contract. */
const memoryQueue = (jobs: WorkflowJob[]) => {
  const repository = Layer.succeed(WorkflowRepository, {
    claim: (workerId, limit) =>
      Effect.sync(() =>
        jobs
          .filter((job) => job.status === "queued")
          .slice(0, limit)
          .map((job) => {
            job.status = "running";
            job.attempts += 1;
            job.lockedBy = workerId;
            return { ...job };
          }),
      ),
    heartbeat: () => Effect.void,
    complete: (id) =>
      Effect.sync(() => {
        jobs.find((job) => job.id === id)!.status = "succeeded";
      }),
    retry: (id, _workerId, error) =>
      Effect.sync(() => {
        const job = jobs.find((candidate) => candidate.id === id)!;
        job.status = "queued";
        job.lastError = error;
      }),
    fail: (id, _workerId, error) =>
      Effect.sync(() => {
        const job = jobs.find((candidate) => candidate.id === id)!;
        job.status = "failed";
        job.lastError = error;
      }),
    release: () => Effect.void,
    providerCallsSince: () => Effect.succeed(0),
  } as WorkflowRepository["Type"]);
  return repository;
};

/** Records delivered recipients; fails the first send to `failOnce`. */
const flakyMailer = (failOnce: string) => {
  const delivered: string[] = [];
  let failed = false;
  const layer = Layer.succeed(WorkflowMailer, {
    send: (message: WorkflowMail) => {
      const to = [message.to].flat().join(",");
      if (to === failOnce && !failed) {
        failed = true;
        return Effect.fail(
          new WorkflowExecutionError({
            reason: "SMTP 451 temporary failure",
            retryable: true,
          }),
        );
      }
      return Effect.sync(() => {
        delivered.push(to);
      });
    },
    createContact: () => Effect.void,
  });
  return { delivered, layer };
};

const settings = Layer.succeed(WorkflowRunnerSettings, {
  workerId: "test-worker",
  concurrency: 10,
  pollMs: 1,
  leaseMs: 60_000,
  retryBaseMs: 1,
  retryMaxMs: 1,
});

const runUntilSettled = async (
  jobs: WorkflowJob[],
  mailer: Layer.Layer<WorkflowMailer>,
) => {
  const handler = WorkflowHandlerLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        mailer,
        Layer.succeed(WorkflowDatabase, { db: {} as never }),
        Layer.succeed(WorkflowStorage, { client: {} as never }),
      ),
    ),
  );
  const runtime = Layer.mergeAll(memoryQueue(jobs), handler, settings);
  for (
    let round = 0;
    round < 5 && jobs.some((job) => job.status === "queued");
    round += 1
  ) {
    await Effect.runPromise(
      runWorkflowBatch.pipe(
        Effect.provide(runtime),
        Effect.provide(Logger.minimumLogLevel(LogLevel.None)),
      ),
    );
  }
};

describe("invitation delivery", () => {
  test("a mid-invite SMTP failure retries only the failed recipient", async () => {
    const jobs = ["first@example.test", "second@example.test"].map(
      (email, index) =>
        inviteJob(`invite-${index}`, {
          teamId: TEAM_ID,
          ip: "127.0.0.1",
          locale: "en",
          invite: invite(email),
        }),
    );
    const mailer = flakyMailer("second@example.test");

    await runUntilSettled(jobs, mailer.layer);

    expect(jobs.map((job) => job.status)).toEqual(["succeeded", "succeeded"]);
    expect(jobs.map((job) => job.attempts)).toEqual([1, 2]);
    expect(
      mailer.delivered.filter((to) => to === "first@example.test"),
    ).toHaveLength(1);
    expect(
      mailer.delivered.filter((to) => to === "second@example.test"),
    ).toHaveLength(1);
  });

  test("a multi-recipient invitation payload is refused without sending", async () => {
    const jobs = [
      inviteJob("invite-batch", {
        teamId: TEAM_ID,
        ip: "127.0.0.1",
        locale: "en",
        invites: [invite("first@example.test"), invite("second@example.test")],
      }),
    ];
    const mailer = flakyMailer("second@example.test");

    await runUntilSettled(jobs, mailer.layer);

    expect(jobs[0]!.status).toBe("failed");
    expect(jobs[0]!.attempts).toBe(1);
    expect(mailer.delivered).toEqual([]);
  });
});
