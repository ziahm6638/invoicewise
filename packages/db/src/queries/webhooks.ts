import { randomBytes } from "node:crypto";
import type { Database } from "@db/client";
import {
  inbox,
  webhookDeliveries,
  webhookDeliveryAttempts,
  webhookEndpoints,
  workflowJobs,
} from "@db/schema";
import { encrypt } from "@invoicewise/encryption";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  ne,
  or,
  sql,
} from "drizzle-orm";

export const WEBHOOK_EVENTS = [
  "invoice.processed",
  "invoice.judgments.attached",
  "delivery.failed",
] as const;

/** Sent only on request to one endpoint, whatever events it subscribes to. */
export const WEBHOOK_TEST_EVENT = "webhook.test";

export type WebhookEventName =
  | (typeof WEBHOOK_EVENTS)[number]
  | typeof WEBHOOK_TEST_EVENT;

/**
 * Payload schema version, sent in the body and the
 * `invoicewise-webhook-version` header. A breaking payload change gets a new
 * version; deliveries stored before versioning had this same shape.
 */
export const WEBHOOK_PAYLOAD_VERSION = 1;

/** How long a rotated-out secret keeps signing deliveries by default. */
export const WEBHOOK_SECRET_OVERLAP_MS = 24 * 60 * 60 * 1000;

export type WebhookEvent = {
  /** Logical event id: identical for every endpoint and every redelivery. */
  id: string;
  type: WebhookEventName;
  version?: number;
  createdAt: string;
  teamId: string;
  invoiceId?: string;
  /** Processing revision of the invoice the event describes. */
  revision?: number;
  data: Record<string, unknown>;
};

/**
 * True once the retention job emptied the delivery's payload
 * (docs/data-lifecycle.md): the event can no longer be sent again.
 */
const payloadExpired = () =>
  sql<boolean>`${webhookDeliveries.payload} = '{}'::jsonb`;

/** Any executor a query can run on: the pool or an open transaction. */
type Executor = Pick<Database, "select" | "insert" | "update">;

export type WebhookEndpointForDelivery = {
  id: string;
  teamId: string;
  url: string;
  secretEncrypted: string;
  events: string[];
};

const generateWebhookSecret = () => `whsec_${randomBytes(32).toString("hex")}`;

export async function createWebhookEndpoint(
  db: Database,
  input: {
    teamId: string;
    userId: string;
    url: string;
    events: WebhookEventName[];
  },
) {
  const secret = generateWebhookSecret();
  const secretEncrypted = encrypt(secret);
  // Registering the URL of a disabled endpoint enables it again with a new
  // secret and the chosen events; an active duplicate returns nothing.
  const [endpoint] = await db
    .insert(webhookEndpoints)
    .values({
      teamId: input.teamId,
      createdBy: input.userId,
      url: input.url,
      events: input.events,
      secretEncrypted,
    })
    .onConflictDoUpdate({
      target: [webhookEndpoints.teamId, webhookEndpoints.url],
      set: {
        active: true,
        createdBy: input.userId,
        events: input.events,
        secretEncrypted,
        previousSecretEncrypted: null,
        previousSecretExpiresAt: null,
        secretRotatedAt: null,
        updatedAt: sql`now()`,
      },
      setWhere: sql`${webhookEndpoints.active} = false`,
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

const endpointColumns = {
  id: webhookEndpoints.id,
  url: webhookEndpoints.url,
  events: webhookEndpoints.events,
  active: webhookEndpoints.active,
  secretRotatedAt: webhookEndpoints.secretRotatedAt,
  // When the previous secret stops signing deliveries; null once expired.
  previousSecretExpiresAt: sql<
    string | null
  >`case when ${webhookEndpoints.previousSecretExpiresAt} > now() then ${webhookEndpoints.previousSecretExpiresAt} end`,
  createdAt: webhookEndpoints.createdAt,
  updatedAt: webhookEndpoints.updatedAt,
};

export function getWebhookEndpoints(db: Database, teamId: string) {
  return db
    .select(endpointColumns)
    .from(webhookEndpoints)
    .where(eq(webhookEndpoints.teamId, teamId))
    .orderBy(desc(webhookEndpoints.createdAt));
}

export async function getWebhookEndpointById(
  db: Database,
  input: { id: string; teamId: string },
) {
  const [endpoint] = await db
    .select(endpointColumns)
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

/** The endpoints a workspace may have registered at once. */
export const MAX_WEBHOOK_ENDPOINTS = 20;

export async function countActiveWebhookEndpoints(
  db: Database,
  teamId: string,
) {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(webhookEndpoints)
    .where(
      and(
        eq(webhookEndpoints.teamId, teamId),
        eq(webhookEndpoints.active, true),
      ),
    );
  return row?.count ?? 0;
}

/**
 * Replaces the endpoint's signing secret and returns the new one, once. By
 * default the replaced secret keeps signing deliveries (alongside the new
 * one) for `overlapMs`, so a consumer can deploy the new secret without
 * rejecting events; `overlapMs: 0` revokes it at once, for a leaked secret.
 * Rotating again inside the overlap replaces the previous secret. Only an
 * active endpoint can be rotated.
 */
export async function rotateWebhookSecret(
  db: Database,
  input: { id: string; teamId: string; overlapMs: number },
) {
  const secret = generateWebhookSecret();
  const overlapMs = Math.max(0, Math.floor(input.overlapMs));
  const [endpoint] = await db
    .update(webhookEndpoints)
    .set({
      secretEncrypted: encrypt(secret),
      previousSecretEncrypted:
        overlapMs > 0 ? sql`${webhookEndpoints.secretEncrypted}` : null,
      previousSecretExpiresAt:
        overlapMs > 0
          ? sql`now() + ${overlapMs}::integer * interval '1 millisecond'`
          : null,
      secretRotatedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(webhookEndpoints.id, input.id),
        eq(webhookEndpoints.teamId, input.teamId),
        eq(webhookEndpoints.active, true),
      ),
    )
    .returning({
      id: webhookEndpoints.id,
      secretRotatedAt: webhookEndpoints.secretRotatedAt,
      previousSecretExpiresAt: webhookEndpoints.previousSecretExpiresAt,
    });
  return endpoint ? { ...endpoint, secret } : undefined;
}

/** An active endpoint of the workspace, with what delivery needs. */
export async function getActiveWebhookEndpointForDelivery(
  db: Executor,
  input: { id: string; teamId: string },
): Promise<WebhookEndpointForDelivery | undefined> {
  const [endpoint] = await db
    .select({
      id: webhookEndpoints.id,
      teamId: webhookEndpoints.teamId,
      url: webhookEndpoints.url,
      secretEncrypted: webhookEndpoints.secretEncrypted,
      events: webhookEndpoints.events,
    })
    .from(webhookEndpoints)
    .where(
      and(
        eq(webhookEndpoints.id, input.id),
        eq(webhookEndpoints.teamId, input.teamId),
        eq(webhookEndpoints.active, true),
      ),
    )
    .limit(1);
  return endpoint;
}

export function getWebhookEndpointsForEvent(
  db: Executor,
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

/**
 * Records the durable intent to deliver one logical event to one endpoint.
 * Idempotent per (endpoint, event id): rescheduling returns the existing row.
 */
export async function createWebhookDelivery(
  db: Executor,
  input: {
    endpoint: WebhookEndpointForDelivery;
    event: WebhookEvent;
  },
) {
  const [inserted] = await db
    .insert(webhookDeliveries)
    .values({
      endpointId: input.endpoint.id,
      teamId: input.endpoint.teamId,
      invoiceId: input.event.invoiceId,
      event: input.event.type,
      eventId: input.event.id,
      revision: input.event.revision,
      payload: input.event,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted) return inserted;
  const [existing] = await db
    .select()
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.endpointId, input.endpoint.id),
        eq(webhookDeliveries.eventId, input.event.id),
      ),
    )
    .limit(1);
  return existing;
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
      // Null once the overlap after a rotation has ended.
      endpointPreviousSecretEncrypted: sql<
        string | null
      >`case when ${webhookEndpoints.previousSecretExpiresAt} > now() then ${webhookEndpoints.previousSecretEncrypted} end`,
      endpointActive: webhookEndpoints.active,
      event: webhookDeliveries.event,
      eventId: webhookDeliveries.eventId,
      revision: webhookDeliveries.revision,
      invoiceId: webhookDeliveries.invoiceId,
      invoiceStatus: inbox.status,
      payload: webhookDeliveries.payload,
      status: webhookDeliveries.status,
      attempts: webhookDeliveries.attempts,
      lastError: webhookDeliveries.lastError,
    })
    .from(webhookDeliveries)
    .innerJoin(
      webhookEndpoints,
      eq(webhookDeliveries.endpointId, webhookEndpoints.id),
    )
    .leftJoin(inbox, eq(webhookDeliveries.invoiceId, inbox.id))
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

/**
 * Stores one HTTP attempt and the delivery outcome. Attempts are numbered per
 * delivery (not per job run), so an explicitly retried delivery continues its
 * history. A settled delivery is never downgraded: a stale worker that lost
 * its lease cannot turn a succeeded or cancelled delivery back into a failure.
 * `failed` is true only for the attempt that made the delivery a terminal
 * failure.
 */
export async function recordWebhookAttempt(
  db: Database,
  input: {
    deliveryId: string;
    endpointId: string;
    teamId: string;
    statusCode?: number;
    error?: string;
    durationMs: number;
    final: boolean;
    succeeded: boolean;
    /** For a final failure: whether an explicit retry may succeed. */
    retryable?: boolean;
  },
) {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({
        attempts: webhookDeliveries.attempts,
        status: webhookDeliveries.status,
      })
      .from(webhookDeliveries)
      .where(
        and(
          eq(webhookDeliveries.id, input.deliveryId),
          eq(webhookDeliveries.teamId, input.teamId),
        ),
      )
      .for("update");
    if (!current) throw new Error("Webhook delivery not found");
    const attempt = current.attempts + 1;
    await tx.insert(webhookDeliveryAttempts).values({
      deliveryId: input.deliveryId,
      endpointId: input.endpointId,
      teamId: input.teamId,
      attempt,
      statusCode: input.statusCode,
      error: input.error,
      durationMs: input.durationMs,
    });
    const settled =
      current.status === "succeeded" || current.status === "cancelled";
    const now = new Date().toISOString();
    await tx
      .update(webhookDeliveries)
      .set(
        settled
          ? { attempts: attempt, updatedAt: now }
          : {
              attempts: attempt,
              status: input.succeeded
                ? "succeeded"
                : input.final
                  ? "failed"
                  : "delivering",
              lastError: input.error ?? null,
              retryable:
                !input.succeeded && input.final
                  ? (input.retryable ?? true)
                  : null,
              deliveredAt: input.succeeded ? now : null,
              updatedAt: now,
            },
      )
      .where(
        and(
          eq(webhookDeliveries.id, input.deliveryId),
          eq(webhookDeliveries.teamId, input.teamId),
        ),
      );
    return {
      attempt,
      failed:
        !settled &&
        current.status !== "failed" &&
        !input.succeeded &&
        input.final,
    };
  });
}

/**
 * Settles a delivery whose destination or invoice is gone without sending it.
 * Only unsettled deliveries are cancelled.
 */
export async function cancelWebhookDelivery(
  db: Database,
  input: { deliveryId: string; teamId: string; reason: string },
) {
  const [delivery] = await db
    .update(webhookDeliveries)
    .set({
      status: "cancelled",
      lastError: input.reason,
      retryable: false,
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(webhookDeliveries.id, input.deliveryId),
        eq(webhookDeliveries.teamId, input.teamId),
        inArray(webhookDeliveries.status, ["queued", "delivering"]),
      ),
    )
    .returning({ id: webhookDeliveries.id });
  return delivery;
}

/**
 * Records a terminal failure the delivery handler never saw, such as a job
 * whose lease expired after its final attempt. The delivery row is locked
 * first, so the job state is read after any concurrent explicit retry
 * committed; a job that was restarted in the meantime is left alone.
 */
export async function failWebhookDelivery(
  db: Database,
  input: { deliveryId: string; teamId: string; error: string },
) {
  return db.transaction(async (tx) => {
    await tx
      .select({ id: webhookDeliveries.id })
      .from(webhookDeliveries)
      .where(
        and(
          eq(webhookDeliveries.id, input.deliveryId),
          eq(webhookDeliveries.teamId, input.teamId),
        ),
      )
      .for("update");
    const [delivery] = await tx
      .update(webhookDeliveries)
      .set({
        status: "failed",
        lastError: input.error,
        retryable: true,
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(webhookDeliveries.id, input.deliveryId),
          eq(webhookDeliveries.teamId, input.teamId),
          inArray(webhookDeliveries.status, ["queued", "delivering"]),
          sql`exists (
          select 1 from ${workflowJobs}
          where ${workflowJobs.name} = 'deliver-webhook'
            and ${workflowJobs.idempotencyKey} = ${webhookDeliveries.eventId}::text || ':' || ${webhookDeliveries.endpointId}::text
            and ${workflowJobs.status} = 'failed'
        )`,
        ),
      )
      .returning({ id: webhookDeliveries.id });
    return delivery;
  });
}

/** Moves a failed or cancelled delivery back to queued for an explicit retry. */
export async function requeueWebhookDelivery(
  db: Executor,
  input: { deliveryId: string; teamId: string },
) {
  const [delivery] = await db
    .update(webhookDeliveries)
    .set({
      status: "queued",
      lastError: null,
      retryable: null,
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(webhookDeliveries.id, input.deliveryId),
        eq(webhookDeliveries.teamId, input.teamId),
        inArray(webhookDeliveries.status, ["failed", "cancelled"]),
      ),
    )
    .returning({ id: webhookDeliveries.id });
  return delivery;
}

/**
 * The invoice deliveries of one revision, with the endpoint's current state,
 * for an explicit retry. `delivery.failed` notifications are not retried.
 */
export function getRevisionWebhookDeliveries(
  db: Executor,
  input: { invoiceId: string; teamId: string; revision: number },
) {
  return db
    .select({
      id: webhookDeliveries.id,
      endpointId: webhookDeliveries.endpointId,
      endpointActive: webhookEndpoints.active,
      event: webhookDeliveries.event,
      eventId: webhookDeliveries.eventId,
      status: webhookDeliveries.status,
      payloadExpired: payloadExpired(),
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
        eq(webhookDeliveries.revision, input.revision),
        ne(webhookDeliveries.event, "delivery.failed"),
      ),
    );
}

/**
 * Unsettled deliveries whose workflow job is missing or has failed without
 * the handler recording an outcome. The job key must match
 * `workflowKey.webhook` in packages/jobs/src/client.ts.
 */
export function listStalledWebhookDeliveries(
  db: Database,
  input: { teamId?: string; invoiceId?: string; limit: number },
) {
  const conditions = [
    inArray(webhookDeliveries.status, ["queued", "delivering"]),
    isNotNull(webhookDeliveries.eventId),
    or(sql`${workflowJobs.id} is null`, eq(workflowJobs.status, "failed")),
  ];
  if (input.teamId) conditions.push(eq(webhookDeliveries.teamId, input.teamId));
  if (input.invoiceId) {
    conditions.push(eq(webhookDeliveries.invoiceId, input.invoiceId));
  }
  return db
    .select({
      id: webhookDeliveries.id,
      teamId: webhookDeliveries.teamId,
      endpointId: webhookDeliveries.endpointId,
      eventId: webhookDeliveries.eventId,
      event: webhookDeliveries.event,
      jobStatus: workflowJobs.status,
      jobError: workflowJobs.lastError,
    })
    .from(webhookDeliveries)
    .leftJoin(
      workflowJobs,
      and(
        eq(workflowJobs.name, "deliver-webhook"),
        eq(
          workflowJobs.idempotencyKey,
          sql`${webhookDeliveries.eventId}::text || ':' || ${webhookDeliveries.endpointId}::text`,
        ),
      ),
    )
    .where(and(...conditions))
    .orderBy(asc(webhookDeliveries.updatedAt))
    .limit(input.limit);
}

/**
 * A workspace endpoint's most recent deliveries, newest first, for
 * inspection and explicit redelivery.
 */
export function getWebhookEndpointDeliveries(
  db: Database,
  input: { endpointId: string; teamId: string; limit?: number },
) {
  return db
    .select({
      id: webhookDeliveries.id,
      endpointId: webhookDeliveries.endpointId,
      event: webhookDeliveries.event,
      eventId: webhookDeliveries.eventId,
      invoiceId: webhookDeliveries.invoiceId,
      revision: webhookDeliveries.revision,
      status: webhookDeliveries.status,
      attempts: webhookDeliveries.attempts,
      lastError: webhookDeliveries.lastError,
      retryable: webhookDeliveries.retryable,
      deliveredAt: webhookDeliveries.deliveredAt,
      createdAt: webhookDeliveries.createdAt,
      updatedAt: webhookDeliveries.updatedAt,
    })
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.endpointId, input.endpointId),
        eq(webhookDeliveries.teamId, input.teamId),
      ),
    )
    .orderBy(desc(webhookDeliveries.createdAt))
    .limit(Math.min(Math.max(input.limit ?? 50, 1), 200));
}

/**
 * A delivery locked for an explicit redelivery, scoped to the workspace, with
 * whether its endpoint is still active.
 */
export async function getWebhookDeliveryForUpdate(
  db: Executor,
  input: { deliveryId: string; teamId: string; endpointId?: string },
) {
  const conditions = [
    eq(webhookDeliveries.id, input.deliveryId),
    eq(webhookDeliveries.teamId, input.teamId),
  ];
  if (input.endpointId) {
    conditions.push(eq(webhookDeliveries.endpointId, input.endpointId));
  }
  const [delivery] = await db
    .select({
      id: webhookDeliveries.id,
      endpointId: webhookDeliveries.endpointId,
      endpointActive: webhookEndpoints.active,
      event: webhookDeliveries.event,
      eventId: webhookDeliveries.eventId,
      status: webhookDeliveries.status,
      payloadExpired: payloadExpired(),
    })
    .from(webhookDeliveries)
    .innerJoin(
      webhookEndpoints,
      eq(webhookDeliveries.endpointId, webhookEndpoints.id),
    )
    .where(and(...conditions))
    .limit(1)
    .for("update", { of: webhookDeliveries });
  return delivery;
}

export function getWebhookAttemptsByEndpoint(
  db: Database,
  input: { endpointId: string; teamId: string; deliveryId?: string },
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
        input.deliveryId
          ? eq(webhookDeliveryAttempts.deliveryId, input.deliveryId)
          : undefined,
      ),
    )
    .orderBy(desc(webhookDeliveryAttempts.createdAt))
    .limit(200);
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
      eventId: webhookDeliveries.eventId,
      revision: webhookDeliveries.revision,
      status: webhookDeliveries.status,
      attempts: webhookDeliveries.attempts,
      lastError: webhookDeliveries.lastError,
      retryable: webhookDeliveries.retryable,
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
