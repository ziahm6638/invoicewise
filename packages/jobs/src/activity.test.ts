import { describe, expect, test } from "bun:test";
import type { InvoiceActivitySources } from "@invoicewise/db/queries";
import { AUDIT_ACTIONS, buildInvoiceActivity } from "./activity";

const invoiceId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";

const job = (
  id: string,
  extra: Partial<InvoiceActivitySources["jobs"][number]>,
): InvoiceActivitySources["jobs"][number] => ({
  id,
  name: "process-attachment",
  status: "succeeded",
  attempts: 1,
  maxAttempts: 3,
  runAt: "2026-09-25T10:00:00.000Z",
  leaseExpiresAt: null,
  finishedAt: null,
  lastError: null,
  createdAt: "2026-09-25T10:00:00.000Z",
  updatedAt: "2026-09-25T10:00:00.000Z",
  deliveryId: null,
  correctionId: null,
  revision: null,
  ...extra,
});

const sources = (): InvoiceActivitySources => ({
  invoice: {
    id: invoiceId,
    createdAt: "2026-09-25T09:59:00.000Z",
    status: "pending",
    intakeState: "accepted",
    contentType: "application/pdf",
    processingRevision: 1,
    processingError: null,
    intakeError: null,
    inboxAccountId: null,
    inboundEmailId: "33333333-3333-4333-8333-333333333333",
    validationStatus: "valid",
    accountingProvider: null,
    accountingPostStatus: null,
    accountingProviderId: null,
    accountingPostError: null,
    accountingPostRetryable: null,
    accountingPostedAt: null,
    accountingRevision: null,
    judgmentsRerunStatus: null,
    judgmentsRerunError: null,
    judgmentsRerunRevision: null,
  },
  email: {
    id: "33333333-3333-4333-8333-333333333333",
    createdAt: "2026-09-25T09:58:00.000Z",
    messageId: "<m1@acme.example>",
    sender: "Acme <billing@acme.example>",
    status: "processed",
    detail: null,
  },
  redeliveries: [],
  jobs: [
    // Newest first, as the query returns them.
    job("job-2", {
      status: "succeeded",
      attempts: 1,
      finishedAt: "2026-09-25T10:20:00.000Z",
    }),
    job("job-1", {
      status: "failed",
      attempts: 3,
      lastError:
        "TypeSafe returned 503 (Authorization: Bearer sk_live_abcdefghij)",
      finishedAt: "2026-09-25T10:05:00.000Z",
    }),
  ],
  deliveries: [
    {
      id: "44444444-4444-4444-8444-444444444444",
      endpointId: "55555555-5555-4555-8555-555555555555",
      endpointUrl: "https://hooks.example.com/in?token=secret-token",
      event: "invoice.processed",
      eventId: "66666666-6666-4666-8666-666666666666",
      revision: 1,
      status: "failed",
      attempts: 4,
      lastError: "HTTP 500",
      retryable: true,
      deliveredAt: null,
      createdAt: "2026-09-25T10:20:00.000Z",
      updatedAt: "2026-09-25T10:25:00.000Z",
    },
  ],
  corrections: [],
  answers: [],
  failedRuns: [],
  audit: [
    {
      id: "77777777-7777-4777-8777-777777777777",
      teamId: "88888888-8888-4888-8888-888888888888",
      actorType: "operator",
      actorRef: "on-call",
      surface: "ops",
      action: "operator.job_retry",
      category: "operator",
      targetType: "invoice",
      targetId: invoiceId,
      revision: null,
      outcome: "succeeded",
      detail: { jobId: "job-1" },
      purpose: "incident",
      createdAt: "2026-09-25T10:10:00.000Z",
      settledAt: "2026-09-25T10:10:01.000Z",
      actor: null,
    },
    {
      id: "99999999-9999-4999-8999-999999999999",
      teamId: "88888888-8888-4888-8888-888888888888",
      actorType: "user",
      actorRef: null,
      surface: "app",
      action: "delivery.retry",
      category: "delivery",
      targetType: "invoice",
      targetId: invoiceId,
      revision: 1,
      outcome: "denied",
      detail: { code: "FORBIDDEN" },
      purpose: null,
      createdAt: "2026-09-25T10:30:00.000Z",
      settledAt: "2026-09-25T10:30:00.000Z",
      actor: { id: userId, fullName: "Morgan", email: "morgan@example.test" },
    },
  ],
});

describe("invoice activity", () => {
  test("traces receipt, runs, actions and destinations in time order", () => {
    const activity = buildInvoiceActivity(sources(), {
      audience: "customer",
      now: new Date("2026-09-25T11:00:00.000Z"),
    });
    expect(
      activity.entries.map((entry) => [entry.stage, entry.status]),
    ).toEqual([
      ["receipt", "ok"],
      ["extraction", "failed"],
      ["action", "ok"],
      ["extraction", "ok"],
      ["delivery", "failed"],
      ["action", "refused"],
    ]);
    const [receipt, failed, operator, , delivery, denied] = activity.entries;
    expect(receipt?.title).toBe(
      "Received by email from Acme <billing@acme.example>",
    );
    expect(receipt?.refs.messageId).toBe("<m1@acme.example>");
    // Failure reasons are understandable and redacted.
    expect(failed?.reason).toContain("TypeSafe returned 503");
    expect(failed?.reason).toContain("after 3 attempts");
    expect(failed?.reason).not.toContain("sk_live_abcdefghij");
    expect(failed?.refs.jobId).toBe("job-1");
    expect(operator).toMatchObject({
      title: "Operator retried a job",
      actor: { type: "operator", name: "on-call" },
      reason: "Purpose: incident",
    });
    // Endpoint shown by origin only; the query string can carry a token.
    expect(delivery?.title).toBe(
      "Webhook invoice.processed to https://hooks.example.com failed",
    );
    expect(delivery?.reason).toBe("HTTP 500 · Retry may succeed · 4 attempts");
    expect(delivery?.refs).toMatchObject({
      deliveryId: "44444444-4444-4444-8444-444444444444",
      eventId: "66666666-6666-4666-8666-666666666666",
      revision: 1,
    });
    expect(denied).toMatchObject({
      actor: { type: "user", name: "Morgan" },
      reason: "Not permitted",
    });
    expect(JSON.stringify(activity)).not.toContain("secret-token");
  });

  test("operators get ids instead of names and no sender address", () => {
    const activity = buildInvoiceActivity(sources(), { audience: "operator" });
    const text = JSON.stringify(activity);
    expect(text).not.toContain("billing@acme.example");
    expect(text).not.toContain("Morgan");
    expect(activity.entries.at(-1)?.actor).toEqual({
      type: "user",
      name: null,
      id: userId,
    });
  });

  test("a job whose worker stopped reads as stalled, not in progress", () => {
    const input = sources();
    input.jobs = [
      job("job-3", {
        status: "running",
        attempts: 1,
        leaseExpiresAt: "2026-09-25T10:01:00.000Z",
        updatedAt: "2026-09-25T10:00:30.000Z",
      }),
    ];
    const activity = buildInvoiceActivity(input, {
      audience: "customer",
      now: new Date("2026-09-25T10:05:00.000Z"),
    });
    expect(
      activity.entries.find((entry) => entry.stage === "extraction"),
    ).toMatchObject({
      title: "Reading the document: stalled",
      status: "pending",
      reason: expect.stringContaining("picked up again automatically"),
    });
  });

  test("a failed invoice match reads as a matching failure with its reason", () => {
    const input = sources();
    input.jobs = [
      job("job-4", {
        name: "match-invoice",
        status: "failed",
        attempts: 3,
        lastError: "TypeSafe unavailable: 503",
        finishedAt: "2026-09-25T10:06:00.000Z",
      }),
    ];
    const activity = buildInvoiceActivity(input, { audience: "customer" });
    expect(
      activity.entries.find((entry) => entry.stage === "matching"),
    ).toMatchObject({
      title: "Matching to authorization sources: failed",
      status: "failed",
      reason: expect.stringContaining("TypeSafe unavailable: 503"),
      refs: { jobId: "job-4", attempts: 3 },
    });
  });

  test("every action has a category and a label", () => {
    for (const [action, spec] of Object.entries(AUDIT_ACTIONS)) {
      expect(action).toMatch(/^[a-z_]+\.[a-z_]+$/);
      expect(spec.label.length).toBeGreaterThan(3);
    }
  });
});
