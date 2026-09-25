import type { Database } from "@invoicewise/db/client";
import {
  MAX_WEBHOOK_ENDPOINTS,
  WEBHOOK_SECRET_OVERLAP_MS,
  type WebhookEventName,
  countActiveWebhookEndpoints,
  createWebhookEndpoint,
  rotateWebhookSecret,
} from "@invoicewise/db/queries";
import { checkWebhookDestination } from "@invoicewise/jobs/webhooks";

export type WebhookServiceError = {
  error: string;
  status: 400 | 404 | 409;
};

/**
 * Registers an endpoint after checking where its URL resolves now, and
 * returns its signing secret once. Shared by REST and the dashboard.
 */
export async function registerWebhookEndpoint(
  db: Database,
  input: {
    teamId: string;
    userId: string;
    url: string;
    events: WebhookEventName[];
  },
) {
  const destination = await checkWebhookDestination(input.url);
  if (!destination.ok) {
    return { error: destination.reason, status: 400 } as WebhookServiceError;
  }
  if (
    (await countActiveWebhookEndpoints(db, input.teamId)) >=
    MAX_WEBHOOK_ENDPOINTS
  ) {
    return {
      error: `A workspace can have at most ${MAX_WEBHOOK_ENDPOINTS} active webhook endpoints`,
      status: 409,
    } as WebhookServiceError;
  }
  const endpoint = await createWebhookEndpoint(db, input);
  if (!endpoint) {
    return {
      error: "An active webhook endpoint already uses this URL",
      status: 409,
    } as WebhookServiceError;
  }
  return { endpoint };
}

/**
 * Rotates an endpoint's secret. By default the previous secret keeps signing
 * for `WEBHOOK_SECRET_OVERLAP_MS`; `revokePrevious` ends it at once.
 */
export async function rotateEndpointSecret(
  db: Database,
  input: { id: string; teamId: string; revokePrevious?: boolean },
) {
  const rotated = await rotateWebhookSecret(db, {
    id: input.id,
    teamId: input.teamId,
    overlapMs: input.revokePrevious ? 0 : WEBHOOK_SECRET_OVERLAP_MS,
  });
  if (!rotated) {
    return {
      error: "Webhook endpoint not found or disabled",
      status: 404,
    } as WebhookServiceError;
  }
  return { rotated };
}
