import { createHash } from "node:crypto";
import type { Database } from "@invoicewise/db/client";
import {
  type TeamRole,
  type UpdateInboxWithProcessedDataParams,
  WEBHOOK_PAYLOAD_VERSION,
  WEBHOOK_TEST_EVENT,
  type WebhookEndpointForDelivery,
  type WebhookEvent,
  canPostToAccounting,
  canResolveHeldDeliveries,
  completeInboxProcessing,
  createWebhookDelivery,
  enqueueWorkflowJob,
  failStalledAccountingPost,
  failWebhookDelivery,
  getActiveAccountingConnection,
  getActiveWebhookEndpointForDelivery,
  getCompletedInvoiceForUpdate,
  getDeliveryDecision,
  getInvoiceForDeliveryUpdate,
  getLatestBillUpdate,
  getRevisionWebhookDeliveries,
  getWebhookDeliveryForUpdate,
  getWebhookEndpointsForEvent,
  listStalledAccountingPosts,
  listStalledBillUpdates,
  listStalledWebhookDeliveries,
  recordAccountingPostQueued,
  recordBillUpdateOutcome,
  releaseAccountingPostForReview,
  requeueBillUpdate,
  requeueFinishedWorkflowJob,
  requeueWebhookDelivery,
  resolveDeliveryDecision,
  supersedeBillUpdates,
} from "@invoicewise/db/queries";
import { DELIVERY_POLICY_LIMITS } from "@invoicewise/documents";
import { InvoiceActionError } from "./action-error";

export { InvoiceActionError } from "./action-error";
import { workflowKey } from "./client";
import {
  decideRevision,
  decisionHeld,
  decisionSummary,
} from "./delivery-rules";

/**
 * Handoff from processing to delivery.
 *
 * A processing result, the next revision number and one durable delivery
 * intent per configured destination (webhook endpoint × event, accounting
 * post) are written in a single transaction together with the workflow jobs
 * that carry them out. The queue lives in the same database, so either all of
 * it commits or none of it does: a failed enqueue rolls the result back and
 * the processing job retries, and a crash after the commit leaves every
 * destination scheduled. Delivery outcome is then tracked per destination,
 * separately from extraction.
 */

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

// Queries take the pool type; an open transaction exposes the same builders.
const asDatabase = (tx: Transaction) => tx as unknown as Database;

/**
 * Deterministic logical event id. The same invoice revision and event always
 * yield the same id, across worker retries, replays and endpoints, so a
 * consumer can deduplicate at-least-once deliveries on it.
 */
export const logicalEventId = (...parts: readonly (string | number)[]) => {
  const hex = createHash("sha256")
    .update(`invoicewise:${parts.join(":")}`)
    .digest("hex");
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  // RFC 9562 layout: version 8 (name-based, custom hash) and variant 10.
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

export const WEBHOOK_MAX_ATTEMPTS = 4;

/** One webhook intent plus its job, idempotent per (event id, endpoint). */
export async function scheduleWebhookDelivery(
  db: Database,
  event: WebhookEvent,
  endpoint: WebhookEndpointForDelivery,
) {
  const delivery = await createWebhookDelivery(db, { event, endpoint });
  if (!delivery) throw new Error("Unable to create webhook delivery");
  await enqueueWorkflowJob(db, {
    name: "deliver-webhook",
    teamId: event.teamId,
    payload: { deliveryId: delivery.id, teamId: event.teamId },
    idempotencyKey: workflowKey.webhook(event.id, endpoint.id),
    maxAttempts: WEBHOOK_MAX_ATTEMPTS,
  });
  return delivery;
}

/** Schedules one event for every subscribed, active endpoint, atomically. */
export async function scheduleWebhookEvent(
  db: Database,
  event: WebhookEvent,
  excludeEndpointId?: string,
) {
  const endpoints = await getWebhookEndpointsForEvent(db, {
    teamId: event.teamId,
    event: event.type,
    excludeEndpointId,
  });
  for (const endpoint of endpoints) {
    await scheduleWebhookDelivery(db, event, endpoint);
  }
  return endpoints.length;
}

export type CompletedInvoice = NonNullable<
  Awaited<ReturnType<typeof completeInboxProcessing>>
>;

/**
 * The revision's `invoice.processed` event, and `invoice.judgments.attached`
 * when it has judgments, to every subscribed endpoint. The event ids derive
 * from the invoice, revision and type, so scheduling a revision again (a
 * release after a hold) reaches each endpoint once.
 */
async function scheduleRevisionEvents(
  db: Database,
  invoice: CompletedInvoice & { teamId: string },
  data: Record<string, unknown>,
) {
  const revision = invoice.processingRevision;
  const createdAt = new Date().toISOString();
  const event = (type: WebhookEvent["type"]): WebhookEvent => ({
    id: logicalEventId(invoice.id, revision, type),
    type,
    version: WEBHOOK_PAYLOAD_VERSION,
    createdAt,
    teamId: invoice.teamId,
    invoiceId: invoice.id,
    revision,
    data,
  });
  let webhooks = await scheduleWebhookEvent(db, event("invoice.processed"));
  if (invoice.judgments?.length) {
    webhooks += await scheduleWebhookEvent(
      db,
      event("invoice.judgments.attached"),
    );
  }
  return webhooks;
}

/** The record a revision's webhook events carry. */
const eventRecord = (invoice: CompletedInvoice) => {
  const { accountingPostStatus, accountingProviderId, ...record } = invoice;
  return record;
};

/**
 * Decides the revision under the workspace's delivery rules and writes a
 * durable intent for every destination the decision lets through. Must run
 * inside the transaction that commits the revision. A user revision that
 * cannot change the bill (a question rerun) or that decides the bill itself
 * (a correction) passes `accounting: false`; `data` adds to what the webhook
 * events carry; `approval` holds the revision for an admin's release.
 */
export async function scheduleInvoiceDeliveries(
  db: Database,
  invoice: CompletedInvoice,
  options: {
    accounting?: boolean;
    data?: Record<string, unknown>;
    approval?: string | null;
  } = {},
) {
  if (!invoice.teamId) {
    return { webhooks: 0, accounting: false, decision: null };
  }
  const teamId = invoice.teamId;
  const decision = await decideRevision(
    db,
    { ...invoice, teamId },
    { approval: options.approval, accounting: options.accounting },
  );
  const data = {
    ...eventRecord(invoice),
    ...options.data,
    deliveryDecision: decisionSummary(decision),
  };

  const webhooks =
    decision.webhooks === "deliver"
      ? await scheduleRevisionEvents(db, { ...invoice, teamId }, data)
      : 0;

  if (decision.accounting !== "deliver") {
    return { webhooks, accounting: false, decision };
  }
  const accounting = await scheduleAccountingPost(db, {
    invoiceId: invoice.id,
    teamId,
    revision: invoice.processingRevision,
    status: invoice.accountingPostStatus,
    providerId: invoice.accountingProviderId,
  });
  return { webhooks, accounting: accounting !== null, decision };
}

/**
 * The accounting intent of one revision plus its job, when the workspace has
 * an active connection. One logical bill per invoice: a revision never
 * schedules a second post once one exists or while one is in flight.
 */
export async function scheduleAccountingPost(
  db: Database,
  input: {
    invoiceId: string;
    teamId: string;
    revision: number;
    status: string | null;
    providerId: string | null;
  },
) {
  if (
    input.providerId ||
    input.status === "posted" ||
    input.status === "already_posted" ||
    input.status === "queued"
  ) {
    return null;
  }
  const connection = await getActiveAccountingConnection(db, input.teamId);
  if (!connection) return null;
  await recordAccountingPostQueued(db, {
    invoiceId: input.invoiceId,
    teamId: input.teamId,
    revision: input.revision,
    provider: connection.provider,
  });
  const { job } = await enqueueWorkflowJob(db, {
    name: "post-accounting-draft",
    teamId: input.teamId,
    payload: { invoiceId: input.invoiceId, teamId: input.teamId },
    idempotencyKey: workflowKey.accounting(
      input.teamId,
      input.invoiceId,
      input.revision,
    ),
  });
  return job;
}

/**
 * Persists a processing result as the next revision and schedules its
 * deliveries in one transaction. Returns null when the record is no longer
 * `processing` (another worker completed it, or it was deleted).
 */
export async function completeInvoiceProcessing(
  db: Database,
  params: CompleteInvoiceParams,
) {
  return db.transaction((tx) => completeAndSchedule(asDatabase(tx), params));
}

type CompleteInvoiceParams = Omit<
  UpdateInboxWithProcessedDataParams,
  "status"
> & {
  teamId: string;
};

/**
 * The body of `completeInvoiceProcessing` for a caller that already holds the
 * transaction the completion must share (document validation, for one).
 * `beforeSchedule` records what the delivery decision reads beyond the
 * completed record (the supplier-history checks) once the revision exists.
 */
export async function completeAndSchedule(
  executor: Database,
  params: CompleteInvoiceParams,
  beforeSchedule?: (invoice: CompletedInvoice) => Promise<void>,
) {
  const invoice = await completeInboxProcessing(executor, params);
  if (!invoice) return null;
  await supersedeBillUpdates(executor, {
    invoiceId: invoice.id,
    teamId: params.teamId,
  });
  await beforeSchedule?.(invoice);
  const scheduled = await scheduleInvoiceDeliveries(executor, invoice);
  return { invoice, revision: invoice.processingRevision, scheduled };
}

/**
 * Settles delivery intents whose job disappeared or failed without the
 * handler recording an outcome (for example a lease that expired after the
 * final attempt). A missing job is enqueued again under its original key; a
 * failed one becomes a visible, retryable delivery failure. A failure is
 * only recorded while its job is still failed, so an explicit retry that
 * restarted the job in the meantime wins, and `onWebhookFailed` commits with
 * the failure it announces.
 */
export async function reconcileDeliveries(
  db: Database,
  input: { teamId?: string; invoiceId?: string; limit?: number } = {},
  onWebhookFailed?: (
    db: Database,
    deliveryId: string,
    teamId: string,
  ) => Promise<void>,
) {
  const limit = input.limit ?? 100;
  const [webhooks, accounting] = await Promise.all([
    listStalledWebhookDeliveries(db, { ...input, limit }),
    listStalledAccountingPosts(db, { ...input, limit }),
  ]);
  let rescheduled = 0;
  let failed = 0;

  for (const delivery of webhooks) {
    if (delivery.jobStatus === "failed") {
      const settled = await db.transaction(async (tx) => {
        const executor = asDatabase(tx);
        const settled = await failWebhookDelivery(executor, {
          deliveryId: delivery.id,
          teamId: delivery.teamId,
          error: delivery.jobError ?? "Webhook delivery workflow failed",
        });
        if (
          settled &&
          onWebhookFailed &&
          delivery.event !== "delivery.failed"
        ) {
          await onWebhookFailed(executor, delivery.id, delivery.teamId);
        }
        return settled;
      });
      if (settled) failed += 1;
      continue;
    }
    await enqueueWorkflowJob(db, {
      name: "deliver-webhook",
      teamId: delivery.teamId,
      payload: { deliveryId: delivery.id, teamId: delivery.teamId },
      idempotencyKey: workflowKey.webhook(
        delivery.eventId!,
        delivery.endpointId,
      ),
      maxAttempts: WEBHOOK_MAX_ATTEMPTS,
    });
    rescheduled += 1;
  }

  for (const post of accounting) {
    if (post.jobStatus === "failed") {
      const settled = await failStalledAccountingPost(db, {
        invoiceId: post.invoiceId,
        teamId: post.teamId,
        revision: post.revision,
        error: post.jobError ?? "Accounting post workflow failed",
      });
      if (settled) failed += 1;
      continue;
    }
    await enqueueWorkflowJob(db, {
      name: "post-accounting-draft",
      teamId: post.teamId,
      payload: { invoiceId: post.invoiceId, teamId: post.teamId },
      idempotencyKey: workflowKey.accounting(
        post.teamId,
        post.invoiceId,
        post.revision,
      ),
    });
    rescheduled += 1;
  }

  const updates = await listStalledBillUpdates(db, { ...input, limit });
  for (const update of updates) {
    if (update.jobStatus === "failed") {
      const settled = await recordBillUpdateOutcome(db, {
        correctionId: update.correctionId,
        teamId: update.teamId,
        status: "failed",
        error: update.jobError ?? "Bill update workflow failed",
        retryable: true,
      });
      if (settled) failed += 1;
      continue;
    }
    await enqueueBillUpdate(db, update);
    rescheduled += 1;
  }

  return { rescheduled, failed };
}

/** The job that updates a posted bill in place for one correction. */
export async function enqueueBillUpdate(
  db: Database,
  input: { correctionId: string; invoiceId: string; teamId: string },
) {
  const key = workflowKey.billUpdate(
    input.teamId,
    input.invoiceId,
    input.correctionId,
  );
  const restarted = await requeueFinishedWorkflowJob(db, {
    name: "update-accounting-bill",
    idempotencyKey: key,
    teamId: input.teamId,
  });
  if (restarted) return;
  await enqueueWorkflowJob(db, {
    name: "update-accounting-bill",
    teamId: input.teamId,
    payload: {
      correctionId: input.correctionId,
      invoiceId: input.invoiceId,
      teamId: input.teamId,
    },
    idempotencyKey: key,
  });
}

export type DeliveryRetryResult = {
  invoiceId: string;
  revision: number;
  webhooks: { requeued: number; skipped: number };
  accounting:
    | "requeued"
    | "already_posted"
    | "in_progress"
    | "no_active_connection"
    | "not_scheduled"
    | "admin_required"
    /** The current revision's delivery decision holds it: release it instead. */
    | "held"
    /** The current revision's hold was dismissed: nothing is sent. */
    | "dismissed";
  /** The in-place update of a posted bill after a correction, if one failed. */
  billUpdate:
    | "requeued"
    | "in_progress"
    | "not_needed"
    | "no_active_connection"
    | "admin_required";
};

/**
 * The supported recovery action. Re-drives the failed or cancelled
 * destinations of the invoice's current revision, honoring current
 * authorization: a disabled endpoint or a disconnected accounting connection
 * is skipped, never recreated, and destinations added after the revision
 * completed are not included. Re-posting to the accounting provider keeps the
 * admin role it requires everywhere else: for a lower role the accounting
 * intent is left as it is and reported as `admin_required`. A post the
 * delivery rules hold for the current revision is never re-driven here: it
 * is sent by an owner's or admin's release. Returns null for an unknown or
 * deleted invoice. With `expectedRevision`, a caller who saw an earlier
 * revision is refused with a conflict instead of re-driving a revision it
 * has not seen.
 */
export async function retryInvoiceDelivery(
  db: Database,
  input: {
    invoiceId: string;
    teamId: string;
    teamRole: TeamRole | null;
    expectedRevision?: number;
  },
): Promise<DeliveryRetryResult | null> {
  return db.transaction(async (tx) => {
    const executor = asDatabase(tx);
    const invoice = await getInvoiceForDeliveryUpdate(executor, {
      id: input.invoiceId,
      teamId: input.teamId,
    });
    if (
      !invoice ||
      invoice.status === "deleted" ||
      invoice.intakeState === "reserved" ||
      invoice.intakeState === "cancelled"
    ) {
      return null;
    }
    const revision = invoice.processingRevision;
    if (
      input.expectedRevision !== undefined &&
      input.expectedRevision !== revision
    ) {
      throw new InvoiceActionError(
        "conflict",
        "This invoice changed since you read it. Read it again before retrying its delivery.",
      );
    }

    let requeued = 0;
    let skipped = 0;
    const deliveries = await getRevisionWebhookDeliveries(executor, {
      invoiceId: invoice.id,
      teamId: input.teamId,
      revision,
    });
    for (const delivery of deliveries) {
      if (delivery.status !== "failed" && delivery.status !== "cancelled") {
        continue;
      }
      if (
        !delivery.endpointActive ||
        !delivery.eventId ||
        delivery.payloadExpired
      ) {
        skipped += 1;
        continue;
      }
      await redriveWebhookDelivery(executor, {
        deliveryId: delivery.id,
        eventId: delivery.eventId,
        endpointId: delivery.endpointId,
        teamId: input.teamId,
      });
      requeued += 1;
    }

    const permitted = canPostToAccounting(input.teamRole);
    return {
      invoiceId: invoice.id,
      revision,
      webhooks: { requeued, skipped },
      billUpdate:
        invoice.status === "processing"
          ? "not_needed"
          : await requeueFailedBillUpdate(executor, {
              invoiceId: invoice.id,
              teamId: input.teamId,
              permitted,
            }),
      accounting: await requeueAccountingIntent(executor, {
        invoiceId: invoice.id,
        teamId: input.teamId,
        status: invoice.accountingPostStatus,
        providerId: invoice.accountingProviderId,
        revision: invoice.accountingRevision ?? revision,
        currentRevision: revision,
        permitted,
      }),
    };
  });
}

/**
 * Moves one settled webhook delivery back to queued and restarts its job
 * under the original key, so the retry keeps the delivery row, its attempt
 * history and the logical event id.
 */
async function redriveWebhookDelivery(
  db: Database,
  delivery: {
    deliveryId: string;
    eventId: string;
    endpointId: string;
    teamId: string;
  },
) {
  await requeueWebhookDelivery(db, {
    deliveryId: delivery.deliveryId,
    teamId: delivery.teamId,
  });
  const key = workflowKey.webhook(delivery.eventId, delivery.endpointId);
  const restarted = await requeueFinishedWorkflowJob(db, {
    name: "deliver-webhook",
    idempotencyKey: key,
    teamId: delivery.teamId,
  });
  if (!restarted) {
    await enqueueWorkflowJob(db, {
      name: "deliver-webhook",
      teamId: delivery.teamId,
      payload: { deliveryId: delivery.deliveryId, teamId: delivery.teamId },
      idempotencyKey: key,
      maxAttempts: WEBHOOK_MAX_ATTEMPTS,
    });
  }
}

export type WebhookRedeliveryResult =
  | { status: "requeued"; deliveryId: string; eventId: string }
  | {
      status:
        | "not_found"
        | "not_failed"
        | "endpoint_disabled"
        | "payload_expired";
    };

/**
 * Explicit redelivery of one failed webhook delivery of the workspace
 * (optionally of one endpoint). The same delivery row and logical event id
 * are sent again, so a consumer that already processed the event
 * deduplicates it. Only a failed delivery on an active endpoint whose payload
 * retention has not yet emptied is redriven:
 * delivered, in-flight and cancelled deliveries are left alone. If it fails
 * again, the failure is announced as a new `delivery.failed` event.
 */
export async function redeliverWebhook(
  db: Database,
  input: { deliveryId: string; teamId: string; endpointId?: string },
): Promise<WebhookRedeliveryResult> {
  return db.transaction(async (tx) => {
    const executor = asDatabase(tx);
    const delivery = await getWebhookDeliveryForUpdate(executor, input);
    if (!delivery || !delivery.eventId) return { status: "not_found" };
    if (delivery.status !== "failed") return { status: "not_failed" };
    if (!delivery.endpointActive) return { status: "endpoint_disabled" };
    if (delivery.payloadExpired) return { status: "payload_expired" };
    await redriveWebhookDelivery(executor, {
      deliveryId: delivery.id,
      eventId: delivery.eventId,
      endpointId: delivery.endpointId,
      teamId: input.teamId,
    });
    return {
      status: "requeued",
      deliveryId: delivery.id,
      eventId: delivery.eventId,
    };
  });
}

/**
 * Queues a synthetic `webhook.test` event to one active endpoint of the
 * workspace, through the same ledger, signing and transport as real events.
 * Each request is a new event; its failure is visible on the endpoint but is
 * never announced as `delivery.failed`. Returns null for an unknown or
 * disabled endpoint.
 */
export async function sendWebhookTestEvent(
  db: Database,
  input: { endpointId: string; teamId: string },
) {
  return db.transaction(async (tx) => {
    const executor = asDatabase(tx);
    const endpoint = await getActiveWebhookEndpointForDelivery(executor, {
      id: input.endpointId,
      teamId: input.teamId,
    });
    if (!endpoint) return null;
    const event: WebhookEvent = {
      id: crypto.randomUUID(),
      type: WEBHOOK_TEST_EVENT,
      version: WEBHOOK_PAYLOAD_VERSION,
      createdAt: new Date().toISOString(),
      teamId: input.teamId,
      data: {
        endpointId: endpoint.id,
        message: "Test event from InvoiceWise. No invoice changed.",
      },
    };
    const delivery = await scheduleWebhookDelivery(executor, event, endpoint);
    return { deliveryId: delivery.id, eventId: event.id };
  });
}

/**
 * Re-drives the newest bill update when it failed or was cancelled. Only an
 * admin may change the bill at the provider, as for any accounting post.
 */
async function requeueFailedBillUpdate(
  db: Database,
  input: { invoiceId: string; teamId: string; permitted: boolean },
): Promise<DeliveryRetryResult["billUpdate"]> {
  const update = await getLatestBillUpdate(db, input);
  if (!update) return "not_needed";
  if (update.updateStatus === "queued") return "in_progress";
  if (update.updateStatus !== "failed" && update.updateStatus !== "cancelled") {
    return "not_needed";
  }
  if (!input.permitted) return "admin_required";
  const connection = await getActiveAccountingConnection(db, input.teamId);
  if (!connection) return "no_active_connection";
  await requeueBillUpdate(db, {
    correctionId: update.id,
    teamId: input.teamId,
  });
  await enqueueBillUpdate(db, {
    correctionId: update.id,
    invoiceId: input.invoiceId,
    teamId: input.teamId,
  });
  return "requeued";
}

/**
 * Re-drives a failed or cancelled accounting intent on the active connection,
 * unless the delivery rules hold the invoice's current revision.
 */
export async function requeueAccountingIntent(
  db: Database,
  input: {
    invoiceId: string;
    teamId: string;
    status: string | null;
    providerId: string | null;
    /** The revision the intent posts. */
    revision: number;
    /** The invoice's current revision, whose delivery decision applies. */
    currentRevision: number;
    /** Whether the caller may re-post to the accounting provider. */
    permitted: boolean;
  },
): Promise<DeliveryRetryResult["accounting"]> {
  if (
    input.providerId ||
    input.status === "posted" ||
    input.status === "already_posted"
  ) {
    return "already_posted";
  }
  if (input.status === "queued") return "in_progress";
  const decision = await getDeliveryDecision(db, {
    invoiceId: input.invoiceId,
    teamId: input.teamId,
    revision: input.currentRevision,
  });
  if (decision?.outcome === "hold" && decision.resolution !== "released") {
    return decision.resolution === "dismissed" ? "dismissed" : "held";
  }
  if (
    input.status !== "failed" &&
    input.status !== "cancelled" &&
    input.status !== "needs_review"
  ) {
    return "not_scheduled";
  }
  if (!input.permitted) return "admin_required";
  const connection = await getActiveAccountingConnection(db, input.teamId);
  if (!connection) return "no_active_connection";
  // Retrying a post held for review is the user's decision that it is not a
  // duplicate: it is sent as its own bill.
  if (input.status === "needs_review") {
    await releaseAccountingPostForReview(db, input);
  }
  await recordAccountingPostQueued(db, {
    invoiceId: input.invoiceId,
    teamId: input.teamId,
    revision: input.revision,
    provider: connection.provider,
  });
  const key = workflowKey.accounting(
    input.teamId,
    input.invoiceId,
    input.revision,
  );
  const restarted = await requeueFinishedWorkflowJob(db, {
    name: "post-accounting-draft",
    idempotencyKey: key,
    teamId: input.teamId,
  });
  if (!restarted) {
    await enqueueWorkflowJob(db, {
      name: "post-accounting-draft",
      teamId: input.teamId,
      payload: { invoiceId: input.invoiceId, teamId: input.teamId },
      idempotencyKey: key,
    });
  }
  return "requeued";
}

// --- Held deliveries -------------------------------------------------------------

export type HeldDeliveryInput = {
  invoiceId: string;
  teamId: string;
  actorId: string;
  teamRole: TeamRole | null;
  /** The processing revision whose decision the user saw. */
  expectedRevision: number;
  reason: string;
};

const refuse = (code: InvoiceActionError["code"], message: string) =>
  new InvoiceActionError(code, message);

/**
 * The invoice at the revision the user saw, locked, with that revision's
 * held and unresolved decision. Refuses anything else as the user would
 * need to know: a changed invoice, a decision already resolved, or one
 * that held nothing.
 */
async function lockHeldDecision(db: Database, input: HeldDeliveryInput) {
  if (!canResolveHeldDeliveries(input.teamRole)) {
    throw refuse(
      "forbidden",
      "Only workspace owners and admins can release or dismiss a held invoice.",
    );
  }
  const reason = input.reason.trim();
  if (
    reason.length < 3 ||
    reason.length > DELIVERY_POLICY_LIMITS.maxResolutionReasonLength
  ) {
    throw new InvoiceActionError(
      "invalid",
      `Give a reason (3 to ${DELIVERY_POLICY_LIMITS.maxResolutionReasonLength} characters); it is kept in the invoice's history.`,
      [{ field: "reason", message: "Give a reason" }],
    );
  }
  const invoice = await getCompletedInvoiceForUpdate(db, {
    id: input.invoiceId,
    teamId: input.teamId,
  });
  if (
    !invoice?.teamId ||
    invoice.status === "deleted" ||
    (invoice.intakeState !== null && invoice.intakeState !== "accepted")
  ) {
    throw refuse("not_found", "Invoice not found");
  }
  if (
    invoice.status === "processing" ||
    invoice.processingRevision !== input.expectedRevision
  ) {
    throw refuse(
      "conflict",
      "This invoice changed since you opened it. Reload it to see its current decision, then try again.",
    );
  }
  const decision = await getDeliveryDecision(db, {
    invoiceId: invoice.id,
    teamId: input.teamId,
    revision: invoice.processingRevision,
  });
  if (!decision || decision.outcome !== "hold" || !decisionHeld(decision)) {
    throw refuse("conflict", "This invoice is not held.");
  }
  if (decision.resolution) {
    throw refuse(
      "conflict",
      `This invoice was already ${decision.resolution} by another user.`,
    );
  }
  const { intakeState, processingError, ...record } = invoice;
  return { invoice: { ...record, teamId: invoice.teamId }, decision, reason };
}

/**
 * Releases an invoice the delivery rules held: the owner's or admin's
 * decision, with its reason, is recorded on the revision's decision and the
 * destinations it held are scheduled now, under the same event ids and bill
 * key they would have had. A hold only a corrected or re-read invoice can
 * clear (missing fields, invalid totals, a duplicate) is refused.
 */
export async function releaseHeldDelivery(
  db: Database,
  input: HeldDeliveryInput,
) {
  return db.transaction(async (tx) => {
    const executor = asDatabase(tx);
    const { invoice, decision, reason } = await lockHeldDecision(
      executor,
      input,
    );
    const locked = (
      decision.reasons as { locked?: unknown; message?: unknown }[]
    )
      .filter((held) => held.locked === true)
      .map((held) => String(held.message));
    if (locked.length > 0) {
      throw new InvoiceActionError(
        "invalid",
        `This invoice cannot be released: ${locked.join(" ")} Correct or re-extract it, or dismiss it.`,
      );
    }
    const released = await resolveDeliveryDecision(executor, {
      id: decision.id,
      teamId: input.teamId,
      resolution: "released",
      reason,
      resolvedBy: input.actorId,
    });
    if (!released) {
      throw refuse("conflict", "This invoice was already resolved.");
    }
    const webhooks =
      released.webhooks === "held"
        ? await scheduleRevisionEvents(executor, invoice, {
            ...eventRecord(invoice),
            deliveryDecision: decisionSummary(released),
          })
        : 0;
    const accounting =
      released.accounting === "held"
        ? (await scheduleAccountingPost(executor, {
            invoiceId: invoice.id,
            teamId: input.teamId,
            revision: invoice.processingRevision,
            status: invoice.accountingPostStatus,
            providerId: invoice.accountingProviderId,
          }))
          ? ("queued" as const)
          : ("not_scheduled" as const)
        : ("not_held" as const);
    return {
      invoiceId: invoice.id,
      revision: invoice.processingRevision,
      decisionId: released.id,
      webhooks,
      accounting,
    };
  });
}

/**
 * Dismisses an invoice the delivery rules held: nothing is delivered for
 * this revision, and the decision records who decided so and why. A
 * correction or re-extraction later is decided afresh.
 */
export async function dismissHeldDelivery(
  db: Database,
  input: HeldDeliveryInput,
) {
  return db.transaction(async (tx) => {
    const executor = asDatabase(tx);
    const { invoice, decision, reason } = await lockHeldDecision(
      executor,
      input,
    );
    const dismissed = await resolveDeliveryDecision(executor, {
      id: decision.id,
      teamId: input.teamId,
      resolution: "dismissed",
      reason,
      resolvedBy: input.actorId,
    });
    if (!dismissed) {
      throw refuse("conflict", "This invoice was already resolved.");
    }
    return {
      invoiceId: invoice.id,
      revision: invoice.processingRevision,
      decisionId: dismissed.id,
    };
  });
}
