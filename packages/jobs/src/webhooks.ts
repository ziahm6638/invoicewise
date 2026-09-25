import { createHmac, timingSafeEqual } from "node:crypto";
import type { Database } from "@invoicewise/db/client";
import {
  WEBHOOK_PAYLOAD_VERSION,
  WEBHOOK_TEST_EVENT,
  type WebhookEvent,
  type WebhookEventName,
  cancelWebhookDelivery,
  getWebhookDelivery,
  recordWebhookAttempt,
} from "@invoicewise/db/queries";
import { decrypt } from "@invoicewise/encryption";
import { Clock, Context, Effect, Schema } from "effect";
import { logicalEventId, scheduleWebhookEvent } from "./delivery";
import {
  EgressError,
  type EgressPolicy,
  checkUrl,
  guardedPost,
  resolveDestination,
} from "./egress";

export type DeliveryRecord = {
  id: string;
  teamId: string;
  endpointId: string;
  endpointUrl: string;
  endpointSecret: string;
  /** The rotated-out secret while its overlap lasts, else null. */
  endpointPreviousSecret?: string | null;
  /** False once the endpoint was disabled; queued work is then cancelled. */
  endpointActive: boolean;
  event: WebhookEventName;
  eventId: string | null;
  revision: number | null;
  invoiceId: string | null;
  /** True when the invoice this delivery describes was deleted. */
  invoiceDeleted: boolean;
  status: "queued" | "delivering" | "succeeded" | "failed" | "cancelled";
  lastError: string | null;
  payload: WebhookEvent;
};

export class WebhookDeliveryError extends Schema.TaggedError<WebhookDeliveryError>()(
  "WebhookDeliveryError",
  { reason: Schema.String, retryable: Schema.Boolean },
) {}

export class WebhookDeliveryRepository extends Context.Tag(
  "invoicewise/WebhookDeliveryRepository",
)<
  WebhookDeliveryRepository,
  {
    /** Null when the delivery (or its endpoint or workspace) no longer exists. */
    readonly load: (
      deliveryId: string,
      teamId: string,
    ) => Effect.Effect<DeliveryRecord | null, WebhookDeliveryError>;
    /**
     * Records the attempt. The attempt that makes the delivery a terminal
     * failure commits the `delivery.failed` notification with it.
     */
    readonly recordAttempt: (input: {
      delivery: DeliveryRecord;
      statusCode?: number;
      error?: string;
      durationMs: number;
      final: boolean;
      succeeded: boolean;
      retryable: boolean;
    }) => Effect.Effect<void, WebhookDeliveryError>;
    readonly cancel: (
      delivery: DeliveryRecord,
      reason: string,
    ) => Effect.Effect<void, WebhookDeliveryError>;
  }
>() {}

export class WebhookTransport extends Context.Tag(
  "invoicewise/WebhookTransport",
)<
  WebhookTransport,
  {
    readonly post: (
      url: string,
      body: string,
      headers: Record<string, string>,
    ) => Effect.Effect<{ status: number }, WebhookDeliveryError>;
  }
>() {}

/**
 * The egress policy for webhook destinations: private, loopback and
 * link-local addresses are refused in production and allowed in local
 * development and tests (the verification listeners are on loopback).
 */
export const webhookEgressPolicy = (): EgressPolicy => ({
  allowPrivate: process.env.NODE_ENV !== "production",
});

/** The static check of a URL as written (scheme, credentials, literals). */
export function isAllowedWebhookUrl(value: string, allowLocal = false) {
  return checkUrl(value, allowLocal).ok;
}

/**
 * Checks a destination at registration: the URL as written and every address
 * its hostname resolves to now. Delivery repeats the resolution check on
 * every connection, so a later DNS change cannot reach a private address.
 */
export async function checkWebhookDestination(
  url: string,
  policy: EgressPolicy = webhookEgressPolicy(),
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await resolveDestination(url, policy);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason:
        error instanceof EgressError
          ? error.message
          : "Webhook destination could not be checked",
    };
  }
}

const hmac = (secret: string, timestamp: number, body: string) =>
  createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");

/**
 * `t=<unix seconds>,v1=<hex>` with one `v1` per secret: during a rotation's
 * overlap the delivery is signed with the new and the previous secret, and a
 * consumer holding either one verifies it.
 */
export const webhookSignature = (
  secret: string | readonly string[],
  timestamp: number,
  body: string,
) =>
  [
    `t=${timestamp}`,
    ...(typeof secret === "string" ? [secret] : secret).map(
      (value) => `v1=${hmac(value, timestamp, body)}`,
    ),
  ].join(",");

export function verifyWebhookSignature(
  secret: string,
  signature: string,
  body: string,
  toleranceSeconds = 300,
) {
  const parts = signature.split(",").map((part) => {
    const index = part.indexOf("=");
    return [part.slice(0, index).trim(), part.slice(index + 1).trim()];
  });
  const timestamp = Number(parts.find(([key]) => key === "t")?.[1]);
  const provided = parts.filter(([key]) => key === "v1").map(([, v]) => v!);
  if (
    !Number.isInteger(timestamp) ||
    provided.length === 0 ||
    Math.abs(Date.now() / 1000 - timestamp) > toleranceSeconds
  ) {
    return false;
  }
  const expectedBytes = Buffer.from(hmac(secret, timestamp, body));
  return provided.some((value) => {
    const providedBytes = Buffer.from(value);
    return (
      expectedBytes.length === providedBytes.length &&
      timingSafeEqual(expectedBytes, providedBytes)
    );
  });
}

/**
 * The body sent for a stored event: the versioned envelope with the logical
 * event id and invoice revision first. Deliveries stored before versioning
 * had the version 1 shape.
 */
export const webhookBody = (payload: WebhookEvent) => {
  const { id, type, version, createdAt, teamId, invoiceId, revision, data } =
    payload;
  return JSON.stringify({
    id,
    type,
    version: version ?? WEBHOOK_PAYLOAD_VERSION,
    createdAt,
    teamId,
    invoiceId,
    revision,
    data,
  });
};

/**
 * Delivers one durable webhook intent. The run is idempotent: a delivery that
 * already succeeded or was cancelled is not sent again (a worker that died
 * after recording the outcome), and one that already failed stays failed until
 * an explicit retry. Queued work for a disabled endpoint or a
 * deleted invoice is cancelled without an HTTP call.
 */
export const deliverWebhook = (input: {
  deliveryId: string;
  teamId: string;
  attempt: number;
  maxAttempts: number;
}) =>
  Effect.gen(function* () {
    const repository = yield* WebhookDeliveryRepository;
    const transport = yield* WebhookTransport;
    const delivery = yield* repository.load(input.deliveryId, input.teamId);
    if (!delivery) {
      return {
        deliveryId: input.deliveryId,
        status: "cancelled",
        reason: "Webhook delivery or endpoint no longer exists",
      };
    }
    if (delivery.status === "succeeded" || delivery.status === "cancelled") {
      return { deliveryId: delivery.id, status: delivery.status };
    }
    if (delivery.status === "failed") {
      return yield* Effect.fail(
        new WebhookDeliveryError({
          reason: delivery.lastError ?? "Webhook delivery failed",
          retryable: false,
        }),
      );
    }
    const cancelReason = !delivery.endpointActive
      ? "Webhook endpoint is disabled"
      : delivery.invoiceDeleted
        ? "Invoice was deleted"
        : !delivery.payload?.id
          ? "Event payload was removed by retention"
          : null;
    if (cancelReason) {
      yield* repository.cancel(delivery, cancelReason);
      return {
        deliveryId: delivery.id,
        status: "cancelled",
        reason: cancelReason,
      };
    }

    const body = webhookBody(delivery.payload);
    const timestamp = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    const startedAt = yield* Clock.currentTimeMillis;
    const outcome = yield* transport
      .post(delivery.endpointUrl, body, {
        "content-type": "application/json",
        "invoicewise-delivery": delivery.id,
        "invoicewise-event": delivery.event,
        "invoicewise-event-id": delivery.payload.id,
        "invoicewise-webhook-version": String(
          delivery.payload.version ?? WEBHOOK_PAYLOAD_VERSION,
        ),
        "invoicewise-signature": webhookSignature(
          delivery.endpointPreviousSecret
            ? [delivery.endpointSecret, delivery.endpointPreviousSecret]
            : [delivery.endpointSecret],
          timestamp,
          body,
        ),
        "user-agent": "InvoiceWise-Webhooks/1.0",
      })
      .pipe(Effect.either);
    const durationMs = (yield* Clock.currentTimeMillis) - startedAt;
    const statusCode =
      outcome._tag === "Right" ? outcome.right.status : undefined;
    const succeeded =
      statusCode !== undefined && statusCode >= 200 && statusCode < 300;
    const error = succeeded
      ? undefined
      : outcome._tag === "Left"
        ? outcome.left.reason
        : statusCode! >= 300 && statusCode! < 400
          ? `Webhook returned HTTP ${statusCode}; redirects are not followed`
          : `Webhook returned HTTP ${statusCode}`;
    const retryable = outcome._tag === "Left" ? outcome.left.retryable : true;
    const final =
      !succeeded && (!retryable || input.attempt >= input.maxAttempts);

    yield* repository.recordAttempt({
      delivery,
      statusCode,
      error,
      durationMs,
      final,
      succeeded,
      retryable,
    });

    if (succeeded) return { deliveryId: delivery.id, statusCode };
    return yield* Effect.fail(
      new WebhookDeliveryError({ reason: error!, retryable: !final }),
    );
  });

const deliveryAttempt = <A>(run: () => Promise<A>, fallback: string) =>
  Effect.tryPromise({
    try: run,
    catch: (error) =>
      new WebhookDeliveryError({
        reason: error instanceof Error ? error.message : fallback,
        retryable: true,
      }),
  });

export const makeWebhookDeliveryRepository = (
  db: Database,
): Context.Tag.Service<WebhookDeliveryRepository> => ({
  load: (deliveryId, teamId) =>
    deliveryAttempt(async () => {
      const delivery = await getWebhookDelivery(db, { deliveryId, teamId });
      if (!delivery) return null;
      return {
        id: delivery.id,
        teamId: delivery.teamId,
        endpointId: delivery.endpointId,
        endpointUrl: delivery.endpointUrl,
        endpointSecret: decrypt(delivery.endpointSecretEncrypted),
        endpointPreviousSecret: delivery.endpointPreviousSecretEncrypted
          ? decrypt(delivery.endpointPreviousSecretEncrypted)
          : null,
        endpointActive: delivery.endpointActive,
        event: delivery.event as WebhookEventName,
        eventId: delivery.eventId,
        revision: delivery.revision,
        invoiceId: delivery.invoiceId,
        invoiceDeleted: delivery.invoiceStatus === "deleted",
        status: delivery.status,
        lastError: delivery.lastError,
        payload: delivery.payload as WebhookEvent,
      };
    }, "Unable to load webhook delivery"),
  recordAttempt: (input) =>
    deliveryAttempt(
      () =>
        db.transaction(async (tx) => {
          const executor = tx as unknown as Database;
          const recorded = await recordWebhookAttempt(executor, {
            deliveryId: input.delivery.id,
            endpointId: input.delivery.endpointId,
            teamId: input.delivery.teamId,
            statusCode: input.statusCode,
            error: input.error,
            durationMs: input.durationMs,
            final: input.final,
            succeeded: input.succeeded,
            retryable: input.retryable,
          });
          if (recorded.failed) {
            await publishDeliveryFailure(
              executor,
              input.delivery,
              input.error ?? "Webhook delivery failed",
              recorded.attempt,
            );
          }
        }),
      "Unable to record webhook attempt",
    ),
  cancel: (delivery, reason) =>
    deliveryAttempt(
      () =>
        cancelWebhookDelivery(db, {
          deliveryId: delivery.id,
          teamId: delivery.teamId,
          reason,
        }).then(() => undefined),
      "Unable to cancel webhook delivery",
    ),
});

/**
 * Every webhook request goes through the guarded egress transport: the
 * destination is resolved and checked on each connection, redirects are not
 * followed, and one deadline bounds the whole exchange.
 */
export const WebhookTransportLive: Context.Tag.Service<WebhookTransport> = {
  post: (url, body, headers) =>
    Effect.tryPromise({
      try: () => guardedPost(url, body, headers, webhookEgressPolicy()),
      catch: (error) =>
        new WebhookDeliveryError({
          reason:
            error instanceof Error ? error.message : "Webhook request failed",
          retryable: error instanceof EgressError ? error.retryable : true,
        }),
    }).pipe(Effect.map(({ status }) => ({ status }))),
};

/**
 * Schedules the notification to the workspace's other endpoints that a
 * delivery failed for good. Runs in the transaction that records the failure.
 * The event id derives from the failed delivery and its attempt count, so a
 * replay of one failure cannot notify twice while a later failure after an
 * explicit retry is a new event. A failed `delivery.failed` notification or
 * test event announces nothing, so failures cannot cascade.
 */
export async function publishDeliveryFailure(
  db: Database,
  delivery: Pick<
    DeliveryRecord,
    "id" | "teamId" | "endpointId" | "event" | "invoiceId" | "revision"
  >,
  error: string,
  attempts: number,
) {
  if (
    delivery.event === "delivery.failed" ||
    delivery.event === WEBHOOK_TEST_EVENT
  ) {
    return;
  }
  await scheduleWebhookEvent(
    db,
    {
      id: logicalEventId(delivery.id, "delivery.failed", attempts),
      type: "delivery.failed",
      version: WEBHOOK_PAYLOAD_VERSION,
      createdAt: new Date().toISOString(),
      teamId: delivery.teamId,
      invoiceId: delivery.invoiceId ?? undefined,
      revision: delivery.revision ?? undefined,
      data: {
        deliveryId: delivery.id,
        endpointId: delivery.endpointId,
        event: delivery.event,
        error,
      },
    },
    delivery.endpointId,
  );
}

/**
 * Publishes a delivery failure found by reconciliation rather than the
 * handler, in the transaction that records it.
 */
export async function publishDeliveryFailureById(
  db: Database,
  deliveryId: string,
  teamId: string,
) {
  const delivery = await getWebhookDelivery(db, { deliveryId, teamId });
  if (!delivery) return;
  await publishDeliveryFailure(
    db,
    {
      id: delivery.id,
      teamId: delivery.teamId,
      endpointId: delivery.endpointId,
      event: delivery.event as WebhookEventName,
      invoiceId: delivery.invoiceId,
      revision: delivery.revision,
    },
    delivery.lastError ?? "Webhook delivery failed",
    delivery.attempts,
  );
}

/**
 * Schedules one event for every subscribed endpoint: each delivery record and
 * its job commit together, and a repeated call with the same event id is a
 * no-op.
 */
export async function emitWebhookEvent(
  db: Database,
  event: WebhookEvent,
  excludeEndpointId?: string,
) {
  await db.transaction((tx) =>
    scheduleWebhookEvent(tx as unknown as Database, event, excludeEndpointId),
  );
}
