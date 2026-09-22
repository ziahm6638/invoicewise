import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { Database } from "@midday/db/client";
import {
  type WebhookEndpointForDelivery,
  type WebhookEvent,
  type WebhookEventName,
  createWebhookDelivery,
  getWebhookDelivery,
  getWebhookEndpointsForEvent,
  recordWebhookAttempt,
} from "@midday/db/queries";
import { decrypt } from "@midday/encryption";
import { Clock, Context, Effect, Schema } from "effect";
import { enqueueWorkflow, workflowKey } from "./client";

export type DeliveryRecord = {
  id: string;
  teamId: string;
  endpointId: string;
  endpointUrl: string;
  endpointSecret: string;
  event: WebhookEventName;
  invoiceId: string | null;
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
    readonly load: (
      deliveryId: string,
      teamId: string,
    ) => Effect.Effect<DeliveryRecord, WebhookDeliveryError>;
    readonly recordAttempt: (input: {
      delivery: DeliveryRecord;
      attempt: number;
      statusCode?: number;
      error?: string;
      durationMs: number;
      final: boolean;
      succeeded: boolean;
    }) => Effect.Effect<void, WebhookDeliveryError>;
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
    const body = JSON.stringify(delivery.payload);
    const timestamp = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    const startedAt = yield* Clock.currentTimeMillis;
    const outcome = yield* transport
      .post(delivery.endpointUrl, body, {
        "content-type": "application/json",
        "invoicewise-delivery": delivery.id,
        "invoicewise-event": delivery.event,
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
      attempt: input.attempt,
      statusCode,
      error,
      durationMs,
      final,
      succeeded,
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
      if (!delivery) throw new Error("Webhook delivery not found");
      return {
        id: delivery.id,
        teamId: delivery.teamId,
        endpointId: delivery.endpointId,
        endpointUrl: delivery.endpointUrl,
        endpointSecret: decrypt(delivery.endpointSecretEncrypted),
        event: delivery.event as WebhookEventName,
        invoiceId: delivery.invoiceId,
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
          attempt: input.attempt,
          statusCode: input.statusCode,
          error: input.error,
          durationMs: input.durationMs,
          final: input.final,
          succeeded: input.succeeded,
        }),
      "Unable to record webhook attempt",
    ),
  deliveryFailed: (delivery, error) =>
    deliveryAttempt(
      () =>
        emitWebhookEvent(
          db,
          {
            id: crypto.randomUUID(),
            type: "delivery.failed",
            createdAt: new Date().toISOString(),
            teamId: delivery.teamId,
            invoiceId: delivery.invoiceId ?? undefined,
            data: {
              deliveryId: delivery.id,
              endpointId: delivery.endpointId,
              event: delivery.event,
              error,
            },
          },
          delivery.endpointId,
        ),
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

export async function enqueueWebhookDelivery(
  db: Database,
  event: WebhookEvent,
  endpoint: WebhookEndpointForDelivery,
) {
  const delivery = await createWebhookDelivery(db, { event, endpoint });
  if (!delivery) throw new Error("Unable to create webhook delivery");
  await enqueueWorkflow(db, {
    name: "deliver-webhook",
    teamId: event.teamId,
    payload: { deliveryId: delivery.id, teamId: event.teamId },
    idempotencyKey: workflowKey.webhook(event.id, endpoint.id),
    maxAttempts: 4,
  });
  return delivery;
}

export async function emitWebhookEvent(
  db: Database,
  event: WebhookEvent,
  excludeEndpointId?: string,
) {
  const endpoints = await getWebhookEndpointsForEvent(db, {
    teamId: event.teamId,
    event: event.type,
    excludeEndpointId,
  });
  await Promise.all(
    endpoints.map((endpoint) => enqueueWebhookDelivery(db, event, endpoint)),
  );
}

export async function emitInvoiceProcessedWebhooks(
  db: Database,
  invoice: Record<string, unknown> & {
    id: string;
    teamId?: string | null;
    judgments?: unknown[] | null;
  },
) {
  if (!invoice.teamId) return;
  const common = {
    createdAt: new Date().toISOString(),
    teamId: invoice.teamId,
    invoiceId: invoice.id,
    data: invoice,
  };
  await emitWebhookEvent(db, {
    ...common,
    id: crypto.randomUUID(),
    type: "invoice.processed",
  });
  if (invoice.judgments?.length) {
    await emitWebhookEvent(db, {
      ...common,
      id: crypto.randomUUID(),
      type: "invoice.judgments.attached",
    });
  }
}
