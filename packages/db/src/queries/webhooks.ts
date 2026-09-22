import { randomBytes } from "node:crypto";
import type { Database } from "@db/client";
import {
  webhookDeliveries,
  webhookDeliveryAttempts,
  webhookEndpoints,
} from "@db/schema";
import { encrypt } from "@invoicewise/encryption";
import { and, desc, eq, sql } from "drizzle-orm";

export const WEBHOOK_EVENTS = [
  "invoice.processed",
  "invoice.judgments.attached",
  "delivery.failed",
] as const;

export type WebhookEventName = (typeof WEBHOOK_EVENTS)[number];

export type WebhookEvent = {
  id: string;
  type: WebhookEventName;
  createdAt: string;
  teamId: string;
  invoiceId?: string;
  data: Record<string, unknown>;
};

export type WebhookEndpointForDelivery = {
  id: string;
  teamId: string;
  url: string;
  secretEncrypted: string;
  events: string[];
};

export async function createWebhookEndpoint(
  db: Database,
  input: {
    teamId: string;
    userId: string;
    url: string;
    events: WebhookEventName[];
  },
) {
  const secret = `whsec_${randomBytes(32).toString("hex")}`;
  const [endpoint] = await db
    .insert(webhookEndpoints)
    .values({
      teamId: input.teamId,
      createdBy: input.userId,
      url: input.url,
      events: input.events,
      secretEncrypted: encrypt(secret),
    })
    .returning({
      id: webhookEndpoints.id,
      url: webhookEndpoints.url,
      events: webhookEndpoints.events,
      active: webhookEndpoints.active,
      createdAt: webhookEndpoints.createdAt,
    });

  return endpoint ? { ...endpoint, secret } : undefined;
}

export function getWebhookEndpoints(db: Database, teamId: string) {
  return db
    .select({
      id: webhookEndpoints.id,
      url: webhookEndpoints.url,
      events: webhookEndpoints.events,
      active: webhookEndpoints.active,
      createdAt: webhookEndpoints.createdAt,
      updatedAt: webhookEndpoints.updatedAt,
    })
    .from(webhookEndpoints)
    .where(eq(webhookEndpoints.teamId, teamId))
    .orderBy(desc(webhookEndpoints.createdAt));
}

export async function getWebhookEndpointById(
  db: Database,
  input: { id: string; teamId: string },
) {
  const [endpoint] = await db
    .select({
      id: webhookEndpoints.id,
      url: webhookEndpoints.url,
      events: webhookEndpoints.events,
      active: webhookEndpoints.active,
      createdAt: webhookEndpoints.createdAt,
      updatedAt: webhookEndpoints.updatedAt,
    })
    .from(webhookEndpoints)
    .where(
      and(
        eq(webhookEndpoints.id, input.id),
        eq(webhookEndpoints.teamId, input.teamId),
      ),
    )
    .limit(1);
  return endpoint;
}

export async function disableWebhookEndpoint(
  db: Database,
  input: { id: string; teamId: string },
) {
  const [endpoint] = await db
    .update(webhookEndpoints)
    .set({ active: false, updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(webhookEndpoints.id, input.id),
        eq(webhookEndpoints.teamId, input.teamId),
      ),
    )
    .returning({ id: webhookEndpoints.id });
  return endpoint;
}

export function getWebhookEndpointsForEvent(
  db: Database,
  input: {
    teamId: string;
    event: WebhookEventName;
    excludeEndpointId?: string;
  },
) {
  const conditions = [
    eq(webhookEndpoints.teamId, input.teamId),
    eq(webhookEndpoints.active, true),
    sql`${input.event} = ANY(${webhookEndpoints.events})`,
  ];
  if (input.excludeEndpointId) {
    conditions.push(sql`${webhookEndpoints.id} <> ${input.excludeEndpointId}`);
  }
  return db
    .select({
      id: webhookEndpoints.id,
      teamId: webhookEndpoints.teamId,
      url: webhookEndpoints.url,
      secretEncrypted: webhookEndpoints.secretEncrypted,
      events: webhookEndpoints.events,
    })
    .from(webhookEndpoints)
    .where(and(...conditions));
}

export async function createWebhookDelivery(
  db: Database,
  input: {
    endpoint: WebhookEndpointForDelivery;
    event: WebhookEvent;
  },
) {
  const [delivery] = await db
    .insert(webhookDeliveries)
    .values({
      endpointId: input.endpoint.id,
      teamId: input.endpoint.teamId,
      invoiceId: input.event.invoiceId,
      event: input.event.type,
      payload: input.event,
    })
    .returning();
  return delivery;
}

export async function getWebhookDelivery(
  db: Database,
  input: { deliveryId: string; teamId: string },
) {
  const [delivery] = await db
    .select({
      id: webhookDeliveries.id,
      teamId: webhookDeliveries.teamId,
      endpointId: webhookDeliveries.endpointId,
      endpointUrl: webhookEndpoints.url,
      endpointSecretEncrypted: webhookEndpoints.secretEncrypted,
      event: webhookDeliveries.event,
      invoiceId: webhookDeliveries.invoiceId,
      payload: webhookDeliveries.payload,
      status: webhookDeliveries.status,
      attempts: webhookDeliveries.attempts,
    })
    .from(webhookDeliveries)
    .innerJoin(
      webhookEndpoints,
      eq(webhookDeliveries.endpointId, webhookEndpoints.id),
    )
    .where(
      and(
        eq(webhookDeliveries.id, input.deliveryId),
        eq(webhookDeliveries.teamId, input.teamId),
        eq(webhookEndpoints.teamId, input.teamId),
      ),
    )
    .limit(1);
  return delivery;
}

export async function recordWebhookAttempt(
  db: Database,
  input: {
    deliveryId: string;
    endpointId: string;
    teamId: string;
    attempt: number;
    statusCode?: number;
    error?: string;
    durationMs: number;
    final: boolean;
    succeeded: boolean;
  },
) {
  await db.transaction(async (tx) => {
    await tx.insert(webhookDeliveryAttempts).values({
      deliveryId: input.deliveryId,
      endpointId: input.endpointId,
      teamId: input.teamId,
      attempt: input.attempt,
      statusCode: input.statusCode,
      error: input.error,
      durationMs: input.durationMs,
    });
    await tx
      .update(webhookDeliveries)
      .set({
        attempts: input.attempt,
        status: input.succeeded
          ? "succeeded"
          : input.final
            ? "failed"
            : "delivering",
        lastError: input.error ?? null,
        deliveredAt: input.succeeded ? new Date().toISOString() : null,
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(webhookDeliveries.id, input.deliveryId),
          eq(webhookDeliveries.teamId, input.teamId),
        ),
      );
  });
}

export function getWebhookAttemptsByEndpoint(
  db: Database,
  input: { endpointId: string; teamId: string },
) {
  return db
    .select({
      id: webhookDeliveryAttempts.id,
      deliveryId: webhookDeliveryAttempts.deliveryId,
      event: webhookDeliveries.event,
      invoiceId: webhookDeliveries.invoiceId,
      attempt: webhookDeliveryAttempts.attempt,
      statusCode: webhookDeliveryAttempts.statusCode,
      error: webhookDeliveryAttempts.error,
      durationMs: webhookDeliveryAttempts.durationMs,
      createdAt: webhookDeliveryAttempts.createdAt,
    })
    .from(webhookDeliveryAttempts)
    .innerJoin(
      webhookDeliveries,
      eq(webhookDeliveryAttempts.deliveryId, webhookDeliveries.id),
    )
    .where(
      and(
        eq(webhookDeliveryAttempts.endpointId, input.endpointId),
        eq(webhookDeliveryAttempts.teamId, input.teamId),
      ),
    )
    .orderBy(desc(webhookDeliveryAttempts.createdAt));
}

export function getInvoiceDeliveryStatus(
  db: Database,
  input: { invoiceId: string; teamId: string },
) {
  return db
    .select({
      id: webhookDeliveries.id,
      endpointId: webhookDeliveries.endpointId,
      endpointUrl: webhookEndpoints.url,
      event: webhookDeliveries.event,
      status: webhookDeliveries.status,
      attempts: webhookDeliveries.attempts,
      lastError: webhookDeliveries.lastError,
      deliveredAt: webhookDeliveries.deliveredAt,
      createdAt: webhookDeliveries.createdAt,
    })
    .from(webhookDeliveries)
    .innerJoin(
      webhookEndpoints,
      eq(webhookDeliveries.endpointId, webhookEndpoints.id),
    )
    .where(
      and(
        eq(webhookDeliveries.invoiceId, input.invoiceId),
        eq(webhookDeliveries.teamId, input.teamId),
      ),
    )
    .orderBy(desc(webhookDeliveries.createdAt));
}
