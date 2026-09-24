import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { logicalEventId } from "./delivery";
import {
  type DeliveryRecord,
  WebhookDeliveryError,
  WebhookDeliveryRepository,
  WebhookTransport,
  deliverWebhook,
  isAllowedWebhookUrl,
  verifyWebhookSignature,
} from "./webhooks";

const event = {
  id: "evt_test",
  type: "invoice.processed" as const,
  createdAt: "2026-09-22T12:00:00.000Z",
  teamId: "team-1",
  invoiceId: "invoice-1",
  data: { amount: 125.5, currency: "GBP" },
};

const endpoint = {
  id: "endpoint-1",
  teamId: "team-1",
  url: "https://customer.example/webhooks",
  secret: "whsec_test-secret",
  events: ["invoice.processed"],
};

const delivery: DeliveryRecord = {
  id: "delivery-1",
  teamId: event.teamId,
  endpointId: endpoint.id,
  endpointUrl: endpoint.url,
  endpointSecret: endpoint.secret,
  endpointActive: true,
  event: event.type,
  eventId: event.id,
  revision: 1,
  invoiceId: event.invoiceId,
  invoiceDeleted: false,
  status: "queued",
  lastError: null,
  payload: event,
};

/** A repository double that records every ledger write. */
const recordingRepository = (loaded: DeliveryRecord | null) => {
  const writes = {
    attempts: [] as Array<{ succeeded: boolean; retryable: boolean }>,
    cancelled: [] as string[],
  };
  const layer = Layer.succeed(WebhookDeliveryRepository, {
    load: () => Effect.succeed(loaded),
    recordAttempt: (record) =>
      Effect.sync(() =>
        writes.attempts.push({
          succeeded: record.succeeded,
          retryable: record.retryable,
        }),
      ).pipe(Effect.asVoid),
    cancel: (_delivery, reason) =>
      Effect.sync(() => writes.cancelled.push(reason)).pipe(Effect.asVoid),
  });
  return { writes, layer };
};

const countingTransport = (status = 204) => {
  const sent: Array<Record<string, string>> = [];
  const layer = Layer.succeed(WebhookTransport, {
    post: (_url, _body, headers) =>
      Effect.sync(() => {
        sent.push(headers);
        return { status };
      }),
  });
  return { sent, layer };
};

const run = (
  repository: Layer.Layer<WebhookDeliveryRepository>,
  transport: Layer.Layer<WebhookTransport>,
  attempt = 1,
) =>
  Effect.runPromise(
    deliverWebhook({
      deliveryId: delivery.id,
      teamId: delivery.teamId,
      attempt,
      maxAttempts: 4,
    }).pipe(
      Effect.provide(Layer.mergeAll(repository, transport)),
      Effect.either,
    ),
  );

describe("webhook delivery", () => {
  test("rejects private delivery targets outside local development", () => {
    expect(isAllowedWebhookUrl("https://customer.example/webhooks")).toBe(true);
    expect(isAllowedWebhookUrl("https://10.0.0.1/internal")).toBe(false);
    expect(isAllowedWebhookUrl("http://127.0.0.1:3014/hook", true)).toBe(true);
  });

  test("signs the exact payload sent to the customer", async () => {
    const sent: Array<{ body: string; headers: Record<string, string> }> = [];
    const attempts: Array<{ succeeded: boolean }> = [];

    await Effect.runPromise(
      deliverWebhook({
        deliveryId: delivery.id,
        teamId: delivery.teamId,
        attempt: 1,
        maxAttempts: 4,
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(WebhookDeliveryRepository, {
              load: () => Effect.succeed(delivery),
              recordAttempt: (record) =>
                Effect.sync(() =>
                  attempts.push({ succeeded: record.succeeded }),
                ).pipe(Effect.asVoid),
              cancel: () => Effect.void,
            }),
            Layer.succeed(WebhookTransport, {
              post: (_url, body, headers) =>
                Effect.sync(() => {
                  sent.push({ body, headers });
                  return { status: 204 };
                }),
            }),
          ),
        ),
      ),
    );

    expect(attempts).toEqual([{ succeeded: true }]);
    expect(sent).toHaveLength(1);
    expect(
      verifyWebhookSignature(
        endpoint.secret,
        sent[0]!.headers["invoicewise-signature"]!,
        sent[0]!.body,
      ),
    ).toBe(true);
    expect(sent[0]!.headers["invoicewise-event"]).toBe("invoice.processed");
    expect(sent[0]!.headers["invoicewise-event-id"]).toBe(event.id);
  });

  test("records a bounded retry and a final failure", async () => {
    const attempts: Array<{ final: boolean; succeeded: boolean }> = [];

    const layer = Layer.mergeAll(
      Layer.succeed(WebhookDeliveryRepository, {
        load: () => Effect.succeed(delivery),
        recordAttempt: (record) =>
          Effect.sync(() =>
            attempts.push({
              final: record.final,
              succeeded: record.succeeded,
            }),
          ).pipe(Effect.asVoid),
        cancel: () => Effect.void,
      }),
      Layer.succeed(WebhookTransport, {
        post: () => Effect.succeed({ status: 503 }),
      }),
    );

    for (const attempt of [1, 2]) {
      await Effect.runPromise(
        deliverWebhook({
          deliveryId: delivery.id,
          teamId: delivery.teamId,
          attempt,
          maxAttempts: 2,
        }).pipe(Effect.provide(layer), Effect.either),
      );
    }

    expect(attempts).toEqual([
      { final: false, succeeded: false },
      { final: true, succeeded: false },
    ]);
  });

  test("a delivery settled before a worker restart is never sent again", async () => {
    for (const status of ["succeeded", "cancelled"] as const) {
      const { writes, layer } = recordingRepository({ ...delivery, status });
      const transport = countingTransport();
      const outcome = await run(layer, transport.layer);
      expect(outcome._tag).toBe("Right");
      expect(transport.sent).toHaveLength(0);
      expect(writes.attempts).toHaveLength(0);
    }
  });

  test("a recorded final failure is not sent again", async () => {
    const { writes, layer } = recordingRepository({
      ...delivery,
      status: "failed",
      lastError: "Webhook returned HTTP 500",
    });
    const transport = countingTransport();
    const outcome = await run(layer, transport.layer);
    expect(outcome._tag).toBe("Left");
    expect(transport.sent).toHaveLength(0);
    expect(writes.attempts).toHaveLength(0);
  });

  test("queued work for a disabled endpoint or deleted invoice is cancelled", async () => {
    for (const [loaded, reason] of [
      [{ ...delivery, endpointActive: false }, "Webhook endpoint is disabled"],
      [{ ...delivery, invoiceDeleted: true }, "Invoice was deleted"],
    ] as const) {
      const { writes, layer } = recordingRepository(loaded);
      const transport = countingTransport();
      const outcome = await run(layer, transport.layer);
      expect(outcome._tag).toBe("Right");
      expect(transport.sent).toHaveLength(0);
      expect(writes.cancelled).toEqual([reason]);
    }
  });

  test("a removed endpoint or workspace settles the job without sending", async () => {
    const { writes, layer } = recordingRepository(null);
    const transport = countingTransport();
    const outcome = await run(layer, transport.layer);
    expect(outcome._tag).toBe("Right");
    expect(transport.sent).toHaveLength(0);
    expect(writes.attempts).toHaveLength(0);
  });

  test("a non-retryable transport error is a terminal, non-retryable failure", async () => {
    const { writes, layer } = recordingRepository(delivery);
    const transport = Layer.succeed(WebhookTransport, {
      post: () =>
        Effect.fail(
          new WebhookDeliveryError({
            reason: "Webhook URL is not allowed",
            retryable: false,
          }),
        ),
    });
    const outcome = await run(layer, transport);
    expect(outcome._tag).toBe("Left");
    expect(writes.attempts).toEqual([{ succeeded: false, retryable: false }]);
  });
});

describe("logical event identity", () => {
  test("is stable for one invoice revision and event", () => {
    const first = logicalEventId("invoice-1", 1, "invoice.processed");
    expect(logicalEventId("invoice-1", 1, "invoice.processed")).toBe(first);
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  test("differs across revisions, events and invoices", () => {
    const ids = new Set([
      logicalEventId("invoice-1", 1, "invoice.processed"),
      logicalEventId("invoice-1", 2, "invoice.processed"),
      logicalEventId("invoice-1", 1, "invoice.judgments.attached"),
      logicalEventId("invoice-2", 1, "invoice.processed"),
    ]);
    expect(ids.size).toBe(4);
  });
});
