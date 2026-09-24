import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { Database } from "@invoicewise/db/client";
import {
  type WebhookEvent,
  type WebhookEventName,
  cancelWebhookDelivery,
  getWebhookDelivery,
  recordWebhookAttempt,
} from "@invoicewise/db/queries";
import { decrypt } from "@invoicewise/encryption";
import { Clock, Context, Effect, Schema } from "effect";
import { logicalEventId, scheduleWebhookEvent } from "./delivery";

export type DeliveryRecord = {
  id: string;
  teamId: string;
  endpointId: string;
  endpointUrl: string;
  endpointSecret: string;
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
    readonly deliveryFailed: (
      delivery: DeliveryRecord,
      error: string,
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

const isPrivateIpAddress = (hostname: string) => {
  if (isIP(hostname) === 4) {
    const [first = 0, second = 0] = hostname.split(".").map(Number);
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      first >= 224
    );
  }
  if (isIP(hostname) === 6) {
    const address = hostname.toLowerCase();
    return (
      address === "::" ||
      address === "::1" ||
      address.startsWith("fc") ||
      address.startsWith("fd") ||
      /^fe[89ab]/.test(address) ||
      address.startsWith("::ffff:")
    );
  }
  return false;
};

export function isAllowedWebhookUrl(value: string, allowLocal = false) {
  try {
    const url = new URL(value);
    const hostname = url.hostname
      .replace(/^\[|\]$/g, "")
      .replace(/\.$/, "")
      .toLowerCase();
    const local =
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      isPrivateIpAddress(hostname);
    if (url.username || url.password) return false;
    if (local) {
      return (
        allowLocal && (url.protocol === "http:" || url.protocol === "https:")
      );
    }
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

export const webhookSignature = (
  secret: string,
  timestamp: number,
  body: string,
) =>
  `t=${timestamp},v1=${createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex")}`;

export function verifyWebhookSignature(
  secret: string,
  signature: string,
  body: string,
  toleranceSeconds = 300,
) {
  const parts = Object.fromEntries(
    signature.split(",").map((part) => part.split("=", 2)),
  );
  const timestamp = Number(parts.t);
  const provided = parts.v1;
  if (
    !Number.isInteger(timestamp) ||
    !provided ||
    Math.abs(Date.now() / 1000 - timestamp) > toleranceSeconds
  ) {
    return false;
  }
  const expectedHeader = webhookSignature(secret, timestamp, body);
  const expected = expectedHeader.slice(expectedHeader.indexOf("v1=") + 3);
  const expectedBytes = Buffer.from(expected);
  const providedBytes = Buffer.from(provided);
  return (
    expectedBytes.length === providedBytes.length &&
    timingSafeEqual(expectedBytes, providedBytes)
  );
}

/**
 * Delivers one durable webhook intent. The run is idempotent: a delivery that
 * already succeeded or was cancelled is not sent again (a worker that died
 * after recording the outcome), and one that already failed only finishes its
 * `delivery.failed` notification. Queued work for a disabled endpoint or a
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
      const error = delivery.lastError ?? "Webhook delivery failed";
      if (delivery.event !== "delivery.failed") {
        yield* repository.deliveryFailed(delivery, error);
      }
      return yield* Effect.fail(
        new WebhookDeliveryError({ reason: error, retryable: false }),
      );
    }
    const cancelReason = !delivery.endpointActive
      ? "Webhook endpoint is disabled"
      : delivery.invoiceDeleted
        ? "Invoice was deleted"
        : null;
    if (cancelReason) {
      yield* repository.cancel(delivery, cancelReason);
      return {
        deliveryId: delivery.id,
        status: "cancelled",
        reason: cancelReason,
      };
    }

    const body = JSON.stringify(delivery.payload);
    const timestamp = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    const startedAt = yield* Clock.currentTimeMillis;
    const outcome = yield* transport
      .post(delivery.endpointUrl, body, {
        "content-type": "application/json",
        "invoicewise-delivery": delivery.id,
        "invoicewise-event": delivery.event,
        "invoicewise-event-id": delivery.payload.id,
        "invoicewise-signature": webhookSignature(
          delivery.endpointSecret,
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
    if (final && delivery.event !== "delivery.failed") {
      yield* repository.deliveryFailed(delivery, error!);
    }
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
        recordWebhookAttempt(db, {
          deliveryId: input.delivery.id,
          endpointId: input.delivery.endpointId,
          teamId: input.delivery.teamId,
          statusCode: input.statusCode,
          error: input.error,
          durationMs: input.durationMs,
          final: input.final,
          succeeded: input.succeeded,
          retryable: input.retryable,
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
  deliveryFailed: (delivery, error) =>
    deliveryAttempt(
      () => publishDeliveryFailure(db, delivery, error),
      "Unable to publish delivery failure",
    ),
});

export const WebhookTransportLive: Context.Tag.Service<WebhookTransport> = {
  post: (url, body, headers) =>
    !isAllowedWebhookUrl(url, process.env.NODE_ENV !== "production")
      ? Effect.fail(
          new WebhookDeliveryError({
            reason: "Webhook URL is not allowed",
            retryable: false,
          }),
        )
      : deliveryAttempt(async () => {
          const response = await fetch(url, {
            method: "POST",
            headers,
            body,
            redirect: "error",
            signal: AbortSignal.timeout(10_000),
          });
          return { status: response.status };
        }, "Webhook request failed"),
};

/**
 * Notifies the workspace's other endpoints that a delivery failed for good.
 * The event id derives from the failed delivery, so a crash and retry while
 * publishing it cannot notify twice.
 */
export async function publishDeliveryFailure(
  db: Database,
  delivery: Pick<
    DeliveryRecord,
    "id" | "teamId" | "endpointId" | "event" | "invoiceId" | "revision"
  >,
  error: string,
) {
  await emitWebhookEvent(
    db,
    {
      id: logicalEventId(delivery.id, "delivery.failed"),
      type: "delivery.failed",
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

/** Publishes a delivery failure found by reconciliation rather than the handler. */
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
