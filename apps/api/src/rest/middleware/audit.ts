import type { AuditTarget } from "@api/trpc/audit";
import { type Database, db as sharedDb } from "@invoicewise/db/client";
import {
  type AuditActorType,
  type AuditOutcome,
  settleAuditEvent,
  startAuditEvent,
} from "@invoicewise/db/queries";
import { AUDIT_ACTIONS, type AuditAction } from "@invoicewise/jobs/activity";
import type { MiddlewareHandler } from "hono";
import { v1Error } from "../v1-errors";

/**
 * The audit trail for REST changes made with API keys, OAuth tokens or a
 * browser session (docs/operations.md#audit-trail). Every write request to a
 * workspace route is recorded: listed routes with their action and target,
 * any other with the generic `api.request` action, so a new route is never
 * silently unaudited. Only the route, identifiers from the path and the HTTP
 * status are kept: never request or response bodies.
 */

type RestAuditRoute = {
  method: string;
  pattern: RegExp;
  action: AuditAction;
  target?: (match: RegExpMatchArray) => AuditTarget | null;
  detail?: (match: RegExpMatchArray) => Record<string, unknown>;
};

const id =
  (type: string, group = 1) =>
  (match: RegExpMatchArray) => ({
    type,
    id: match[group] ?? null,
  });

const created = (type: string) => () => ({ type, id: null });

export const REST_AUDIT_ROUTES: RestAuditRoute[] = [
  // The versioned public API (apps/api/src/rest/v1.ts).
  {
    method: "POST",
    pattern: /^\/v1\/invoices\/?$/,
    action: "invoice.submit",
    target: created("invoice"),
  },
  {
    method: "POST",
    pattern: /^\/v1\/invoices\/([^/]+)\/reextract$/,
    action: "invoice.reextract",
    target: id("invoice"),
  },
  {
    method: "POST",
    pattern: /^\/v1\/invoices\/([^/]+)\/questions\/rerun$/,
    action: "invoice.rerun_questions",
    target: id("invoice"),
  },
  {
    method: "POST",
    pattern: /^\/v1\/invoices\/([^/]+)\/delivery\/retry$/,
    action: "delivery.retry",
    target: id("invoice"),
  },
  {
    method: "POST",
    pattern: /^\/webhooks\/?$/,
    action: "webhook.create",
    target: created("webhook_endpoint"),
  },
  {
    method: "DELETE",
    pattern: /^\/webhooks\/([^/]+)$/,
    action: "webhook.disable",
    target: id("webhook_endpoint"),
  },
  {
    method: "POST",
    pattern: /^\/webhooks\/([^/]+)\/rotate-secret$/,
    action: "webhook.rotate_secret",
    target: id("webhook_endpoint"),
  },
  {
    method: "POST",
    pattern: /^\/webhooks\/([^/]+)\/test$/,
    action: "webhook.test",
    target: id("webhook_endpoint"),
  },
  {
    method: "POST",
    pattern: /^\/webhooks\/([^/]+)\/deliveries\/([^/]+)\/redeliver$/,
    action: "webhook.redeliver",
    target: id("webhook_delivery", 2),
    detail: (match) => ({ endpointId: match[1] }),
  },
  {
    method: "POST",
    pattern: /^\/invoices\/([^/]+)\/delivery\/retry$/,
    action: "delivery.retry",
    target: id("invoice"),
  },
  {
    method: "POST",
    pattern: /^\/invoices\/([^/]+)\/delivery\/release$/,
    action: "delivery.release",
    target: id("invoice"),
  },
  {
    method: "POST",
    pattern: /^\/invoices\/([^/]+)\/delivery\/dismiss$/,
    action: "delivery.dismiss",
    target: id("invoice"),
  },
  {
    method: "PUT",
    pattern: /^\/delivery-policy\/?$/,
    action: "delivery_rules.update",
    target: created("delivery_policy"),
  },
  {
    method: "POST",
    pattern: /^\/accounting\/connect-sessions$/,
    action: "accounting.connect_start",
  },
  {
    method: "POST",
    pattern: /^\/accounting\/connections$/,
    action: "accounting.connect",
  },
  {
    method: "DELETE",
    pattern: /^\/accounting\/connections\/([^/]+)$/,
    action: "accounting.disconnect",
    detail: (match) => ({ provider: match[1] }),
  },
  {
    method: "POST",
    pattern: /^\/accounting\/invoices\/([^/]+)\/retry$/,
    action: "accounting.retry",
    target: id("invoice"),
  },
  {
    method: "POST",
    pattern: /^\/authorization-sources\/?$/,
    action: "authorization_source.create",
    target: created("authorization_source"),
  },
  {
    method: "POST",
    pattern: /^\/authorization-sources\/import$/,
    action: "authorization_source.import",
  },
  {
    method: "POST",
    pattern: /^\/authorization-sources\/([^/]+)\/documents$/,
    action: "authorization_source.attach_document",
    target: id("authorization_source"),
  },
  {
    method: "PATCH",
    pattern: /^\/teams\/([^/]+)$/,
    action: "workspace.update",
  },
  {
    method: "DELETE",
    pattern: /^\/inbox\/([^/]+)$/,
    action: "invoice.delete",
    target: id("invoice"),
  },
  {
    method: "PATCH",
    pattern: /^\/inbox\/([^/]+)$/,
    action: "invoice.update",
    target: id("invoice"),
  },
  {
    method: "POST",
    pattern: /^\/inbox\/([^/]+)\/presigned-url$/,
    action: "invoice.document_link",
    target: id("invoice"),
  },
];

/** Writes to the caller's own account, not a workspace. */
const NOT_WORKSPACE = [/^\/users\/me$/];

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** The route with identifiers replaced, for the generic action's detail. */
const routeShape = (path: string) => path.replace(UUID, ":id").slice(0, 120);

export const restOutcome = (
  status: number,
): Exclude<AuditOutcome, "started"> =>
  status < 400
    ? "succeeded"
    : status === 401 || status === 403
      ? "denied"
      : status < 500
        ? "refused"
        : "failed";

const ACTOR_TYPE: Record<string, AuditActorType> = {
  api_key: "api_key",
  oauth: "oauth",
  session: "user",
};

export const withRestAuditTrail: MiddlewareHandler = async (c, next) => {
  const method = c.req.method.toUpperCase();
  const path = c.req.path;
  const teamId = c.get("teamId") as string | null | undefined;
  if (
    !WRITE_METHODS.has(method) ||
    !teamId ||
    NOT_WORKSPACE.some((pattern) => pattern.test(path))
  ) {
    await next();
    return;
  }

  const route = REST_AUDIT_ROUTES.find(
    (candidate) => candidate.method === method && candidate.pattern.test(path),
  );
  const match = route ? path.match(route.pattern) : null;
  const action: AuditAction = route?.action ?? "api.request";
  const target = route && match ? (route.target?.(match) ?? null) : null;
  const session = c.get("session") as
    | {
        user: { id: string };
        authType?: string;
      }
    | undefined;
  // The /v1 chain attaches no request database; the shared client is the same.
  const db = (c.get("db") as Database | undefined) ?? sharedDb;

  let started: { id: string };
  try {
    started = await startAuditEvent(db, {
      teamId,
      actor: {
        type: ACTOR_TYPE[session?.authType ?? "session"] ?? "user",
        userId: session?.user.id ?? null,
        ref: (c.get("credentialId") as string | null | undefined) ?? null,
      },
      surface: "api",
      action,
      category: AUDIT_ACTIONS[action].category,
      targetType: target?.type ?? null,
      targetId: target?.id ?? null,
      detail: {
        ...(route && match ? route.detail?.(match) : {}),
        ...(route ? {} : { method, route: routeShape(path) }),
      },
    });
  } catch {
    const message = "The action could not be recorded, so it was not run.";
    return path.startsWith("/v1/")
      ? v1Error("internal_error", message, 500)
      : c.json({ error: message }, 500);
  }

  await next();

  const status = c.res.status;
  let createdId: string | null = null;
  if ((status === 201 || status === 202) && target && !target.id) {
    // The created record's id only; the body can hold a one-time secret.
    const body = (await c.res
      .clone()
      .json()
      .catch(() => null)) as { id?: unknown } | null;
    createdId = typeof body?.id === "string" ? body.id : null;
  }
  await settleAuditEvent(db, {
    id: started.id,
    outcome: restOutcome(status),
    detail: { status },
    targetId: createdId,
  }).catch((error) =>
    console.error(
      JSON.stringify({
        event: "audit_settle_failed",
        action,
        error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
      }),
    ),
  );
};
