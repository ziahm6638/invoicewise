import {
  TRUSTED_CALLER_HEADERS,
  publicApiContract,
  publicApiHttp,
} from "@api/effect/public-api-http";
import { handleMcpHttp } from "@api/mcp/http";
import type { Context } from "@api/rest/types";
import type { Scope } from "@api/utils/scopes";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { rateLimiter } from "hono-rate-limiter";
import { HTTPException } from "hono/http-exception";
import { withAuth } from "./middleware/auth";
import { normalizeResponse, unauthorized, v1Error } from "./v1-errors";

/**
 * The versioned public API. Hono authenticates the bearer credential (API
 * key or OAuth token, read from the primary database on every request so a
 * deleted key stops working on its next call), checks the route's scope and
 * applies the rate limit; the Effect handler (`publicApiHttp`) then serves the
 * contract with the caller it is given here. See docs/api.md.
 */

/** Requests per window for one user's credentials in one workspace. */
export const V1_RATE_LIMIT = { limit: 300, windowMs: 10 * 60 * 1000 };

/**
 * Only an explicit bearer credential is accepted: a browser's ambient
 * session cookie never authorizes a v1 call.
 */
const requireBearer: MiddlewareHandler<Context> = async (c, next) => {
  const header = c.req.header("authorization");
  if (!header?.startsWith("Bearer ") || header.length <= "Bearer ".length) {
    return unauthorized(
      "Send an API key as `Authorization: Bearer <key>`. Create one in Settings → Developer.",
    );
  }
  await next();
};

const requireWorkspace: MiddlewareHandler<Context> = async (c, next) => {
  if (!c.get("teamId") || !c.get("teamRole")) {
    return v1Error(
      "no_workspace",
      "This credential has no workspace it can act in.",
      403,
    );
  }
  await next();
};

const requireScope =
  (scope: Scope): MiddlewareHandler<Context> =>
  async (c, next) => {
    const scopes = (c.get("scopes" as never) as Scope[] | undefined) ?? [];
    if (!scopes.includes(scope)) {
      return v1Error(
        "insufficient_scope",
        `This credential needs the \`${scope}\` scope.`,
        403,
      );
    }
    await next();
  };

const limiter = rateLimiter<Context>({
  windowMs: V1_RATE_LIMIT.windowMs,
  limit: V1_RATE_LIMIT.limit,
  standardHeaders: "draft-6",
  keyGenerator: (c) =>
    `v1:${c.get("teamId")}:${c.get("session")?.user?.id ?? "unknown"}`,
  statusCode: 429,
  message: {
    error: {
      code: "rate_limited",
      message: `At most ${V1_RATE_LIMIT.limit} requests per ${V1_RATE_LIMIT.windowMs / 60_000} minutes. Wait for Retry-After seconds.`,
    },
  },
});

/** Replaces any caller-supplied trusted header with the authenticated values. */
const forwardHeaders = (c: {
  req: { raw: Request };
  get: <K extends keyof Context["Variables"]>(
    key: K,
  ) => Context["Variables"][K];
}) => {
  const headers = new Headers(c.req.raw.headers);
  for (const name of Object.values(TRUSTED_CALLER_HEADERS)) {
    headers.delete(name);
  }
  headers.set(TRUSTED_CALLER_HEADERS.teamId, c.get("teamId"));
  headers.set(TRUSTED_CALLER_HEADERS.userId, c.get("session").user.id);
  headers.set(TRUSTED_CALLER_HEADERS.role, c.get("teamRole") ?? "");
  return headers;
};

const v1 = new Hono<Context>();

v1.onError((error) => {
  if (error instanceof HTTPException) {
    if (error.status === 401) return unauthorized(error.message);
    if (error.status === 403) return v1Error("forbidden", error.message, 403);
  }
  return v1Error("internal_error", "The request failed", 500);
});

// The contract itself is public.
v1.get("/openapi.json", (c) => c.json(publicApiContract()));

v1.use("*", requireBearer, withAuth, requireWorkspace, limiter);

// Remote MCP: read-only tools that call this API back with the same bearer.
v1.all("/mcp", requireScope("inbox.read"), (c) => {
  const origin = new URL(c.req.url).origin;
  const authorization = c.req.header("authorization") ?? "";
  return handleMcpHttp(c.req.raw, async (path) =>
    v1.fetch(
      new Request(new URL(path, origin).toString(), {
        headers: { accept: "application/json", authorization },
      }),
    ),
  );
});

v1.on(["GET", "HEAD"], "*", requireScope("inbox.read"));
v1.on(["POST", "PUT", "PATCH", "DELETE"], "*", requireScope("inbox.write"));

v1.all("*", async (c) =>
  normalizeResponse(
    await publicApiHttp.handler(
      new Request(c.req.raw, { headers: forwardHeaders(c) }),
    ),
  ),
);

export { v1 as v1Router };
