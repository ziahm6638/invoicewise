import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import {
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

const delivery = {
  id: "delivery-1",
  teamId: event.teamId,
  endpointId: endpoint.id,
  endpointUrl: endpoint.url,
  endpointSecret: endpoint.secret,
  event: event.type,
  invoiceId: event.invoiceId,
  payload: event,
};

describe("webhook delivery", () => {
  test("rejects private delivery targets outside local development", () => {
    expect(isAllowedWebhookUrl("https://customer.example/webhooks")).toBe(true);
    expect(isAllowedWebhookUrl("https://10.0.0.1/internal")).toBe(false);
    expect(isAllowedWebhookUrl("http://127.0.0.1:3014/hook", true)).toBe(true);
  });

  test("signs the exact payload sent to the customer", async () => {
    const sent: Array<{ body: string; headers: Record<string, string> }> = [];
    const attempts: Array<{ attempt: number; succeeded: boolean }> = [];

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
                  attempts.push({
                    attempt: record.attempt,
                    succeeded: record.succeeded,
                  }),
                ).pipe(Effect.asVoid),
              deliveryFailed: () => Effect.void,
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

    expect(attempts).toEqual([{ attempt: 1, succeeded: true }]);
    expect(sent).toHaveLength(1);
    expect(
      verifyWebhookSignature(
        endpoint.secret,
        sent[0]!.headers["invoicewise-signature"]!,
        sent[0]!.body,
      ),
    ).toBe(true);
    expect(sent[0]!.headers["invoicewise-event"]).toBe("invoice.processed");
  });

  test("records a bounded retry and a final failure", async () => {
    const attempts: Array<{ attempt: number; succeeded: boolean }> = [];
    const failures: string[] = [];

    const layer = Layer.mergeAll(
      Layer.succeed(WebhookDeliveryRepository, {
        load: () => Effect.succeed(delivery),
        recordAttempt: (record) =>
          Effect.sync(() =>
            attempts.push({
              attempt: record.attempt,
              succeeded: record.succeeded,
            }),
          ).pipe(Effect.asVoid),
        deliveryFailed: (_delivery, error) =>
          Effect.sync(() => failures.push(error)).pipe(Effect.asVoid),
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
      { attempt: 1, succeeded: false },
      { attempt: 2, succeeded: false },
    ]);
    expect(failures).toEqual(["Webhook returned HTTP 503"]);
  });

  test("does not recursively emit when delivery.failed cannot be delivered", async () => {
    const failures: string[] = [];
    const failedDelivery = { ...delivery, event: "delivery.failed" as const };
    const layer = Layer.mergeAll(
      Layer.succeed(WebhookDeliveryRepository, {
        load: () => Effect.succeed(failedDelivery),
        recordAttempt: () => Effect.void,
        deliveryFailed: (_delivery, error) =>
          Effect.sync(() => failures.push(error)).pipe(Effect.asVoid),
      }),
      Layer.succeed(WebhookTransport, {
        post: () => Effect.succeed({ status: 503 }),
      }),
    );

    await Effect.runPromise(
      deliverWebhook({
        deliveryId: failedDelivery.id,
        teamId: failedDelivery.teamId,
        attempt: 4,
        maxAttempts: 4,
      }).pipe(Effect.provide(layer), Effect.either),
    );

    expect(failures).toEqual([]);
  });
});
