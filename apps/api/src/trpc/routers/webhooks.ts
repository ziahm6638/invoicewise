import {
  createWebhookEndpointSchema,
  rotateWebhookSecretSchema,
  webhookDeliveryParamsSchema,
  webhookEndpointIdSchema,
} from "@api/schemas/webhooks";
import {
  type WebhookServiceError,
  registerWebhookEndpoint,
  rotateEndpointSecret,
} from "@api/services/webhooks";
import { adminProcedure, createTRPCRouter } from "@api/trpc/init";
import {
  WEBHOOK_EVENTS,
  WEBHOOK_SECRET_OVERLAP_MS,
  disableWebhookEndpoint,
  getWebhookAttemptsByEndpoint,
  getWebhookEndpointById,
  getWebhookEndpointDeliveries,
  getWebhookEndpoints,
} from "@invoicewise/db/queries";
import {
  redeliverWebhook,
  sendWebhookTestEvent,
} from "@invoicewise/jobs/delivery";
import { TRPCError } from "@trpc/server";

const serviceError = ({ error, status }: WebhookServiceError) =>
  new TRPCError({
    code:
      status === 404
        ? "NOT_FOUND"
        : status === 409
          ? "CONFLICT"
          : "BAD_REQUEST",
    message: error,
  });

/** Webhook endpoints are workspace integrations: admin and up. */
export const webhooksRouter = createTRPCRouter({
  list: adminProcedure.query(async ({ ctx: { db, teamId } }) => ({
    endpoints: await getWebhookEndpoints(db, teamId!),
    events: WEBHOOK_EVENTS,
    secretOverlapHours: WEBHOOK_SECRET_OVERLAP_MS / 3_600_000,
  })),

  create: adminProcedure
    .input(createWebhookEndpointSchema)
    .mutation(async ({ ctx: { db, teamId, session }, input }) => {
      const result = await registerWebhookEndpoint(db, {
        ...input,
        teamId: teamId!,
        userId: session.user.id,
      });
      if ("error" in result) throw serviceError(result);
      return result.endpoint;
    }),

  disable: adminProcedure
    .input(webhookEndpointIdSchema)
    .mutation(async ({ ctx: { db, teamId }, input }) => {
      const endpoint = await disableWebhookEndpoint(db, {
        id: input.id,
        teamId: teamId!,
      });
      if (!endpoint) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Webhook endpoint not found",
        });
      }
      return { id: endpoint.id, active: false };
    }),

  rotateSecret: adminProcedure
    .input(webhookEndpointIdSchema.merge(rotateWebhookSecretSchema))
    .mutation(async ({ ctx: { db, teamId }, input }) => {
      const result = await rotateEndpointSecret(db, {
        id: input.id,
        teamId: teamId!,
        revokePrevious: input.revokePrevious,
      });
      if ("error" in result) throw serviceError(result);
      return result.rotated;
    }),

  sendTest: adminProcedure
    .input(webhookEndpointIdSchema)
    .mutation(async ({ ctx: { db, teamId }, input }) => {
      const queued = await sendWebhookTestEvent(db, {
        endpointId: input.id,
        teamId: teamId!,
      });
      if (!queued) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Webhook endpoint not found or disabled",
        });
      }
      return queued;
    }),

  deliveries: adminProcedure
    .input(webhookEndpointIdSchema)
    .query(async ({ ctx: { db, teamId }, input }) => {
      if (
        !(await getWebhookEndpointById(db, { id: input.id, teamId: teamId! }))
      ) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Webhook endpoint not found",
        });
      }
      return getWebhookEndpointDeliveries(db, {
        endpointId: input.id,
        teamId: teamId!,
      });
    }),

  attempts: adminProcedure
    .input(webhookDeliveryParamsSchema)
    .query(async ({ ctx: { db, teamId }, input }) =>
      getWebhookAttemptsByEndpoint(db, {
        endpointId: input.id,
        teamId: teamId!,
        deliveryId: input.deliveryId,
      }),
    ),

  redeliver: adminProcedure
    .input(webhookDeliveryParamsSchema)
    .mutation(async ({ ctx: { db, teamId }, input }) => {
      const result = await redeliverWebhook(db, {
        deliveryId: input.deliveryId,
        endpointId: input.id,
        teamId: teamId!,
      });
      switch (result.status) {
        case "requeued":
          return result;
        case "not_found":
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Webhook delivery not found",
          });
        case "not_failed":
          throw new TRPCError({
            code: "CONFLICT",
            message: "Only a failed delivery can be redelivered",
          });
        case "endpoint_disabled":
          throw new TRPCError({
            code: "CONFLICT",
            message: "Webhook endpoint is disabled",
          });
        case "payload_expired":
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "The event payload was removed by retention and cannot be sent again",
          });
      }
    }),
});
