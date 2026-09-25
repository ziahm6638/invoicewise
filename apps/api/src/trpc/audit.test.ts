import { describe, expect, test } from "bun:test";
import { AUDIT_ACTIONS } from "@invoicewise/jobs/activity";
import { TRPCError } from "@trpc/server";
import { Hono } from "hono";
import { publicApiContract } from "../effect/public-api-http";
import {
  REST_AUDIT_ROUTES,
  restOutcome,
  withRestAuditTrail,
} from "../rest/middleware/audit";
import { routers } from "../rest/routers";
import { TRPC_AUDIT, auditOutcomeForError } from "./audit";
import { appRouter } from "./routers/_app";

const procedures = appRouter._def.procedures as unknown as Record<
  string,
  { _def: { type: string } }
>;

describe("audit trail coverage", () => {
  test("every tRPC mutation is audited or explicitly excluded", () => {
    const mutations = Object.entries(procedures)
      .filter(([, procedure]) => procedure._def.type === "mutation")
      .map(([path]) => path);
    expect(mutations.length).toBeGreaterThan(40);
    const missing = mutations.filter((path) => !(path in TRPC_AUDIT));
    expect(missing).toEqual([]);
  });

  test("every registry entry names a real procedure and a known action", () => {
    for (const [path, spec] of Object.entries(TRPC_AUDIT)) {
      expect(procedures[path]).toBeDefined();
      if (spec) expect(AUDIT_ACTIONS[spec.action]).toBeDefined();
    }
  });

  test("every REST write route under a workspace path has an action", () => {
    const writes = routers.routes.filter(
      (route) =>
        ["POST", "PUT", "PATCH", "DELETE"].includes(route.method) &&
        !route.path.startsWith("/oauth") &&
        route.path !== "/users/me" &&
        route.path !== "/*",
    );
    expect(writes.length).toBeGreaterThan(10);
    const unmapped = writes.filter((route) => {
      const sample = route.path.replace(
        /:[A-Za-z]+/g,
        "00000000-0000-4000-8000-000000000000",
      );
      return !REST_AUDIT_ROUTES.some(
        (candidate) =>
          candidate.method === route.method && candidate.pattern.test(sample),
      );
    });
    expect(unmapped.map((route) => `${route.method} ${route.path}`)).toEqual(
      [],
    );
  });

  test("every /v1 public API write has an action", () => {
    const contract = publicApiContract() as {
      paths: Record<string, Record<string, unknown>>;
    };
    const writes = Object.entries(contract.paths).flatMap(([path, methods]) =>
      Object.keys(methods)
        .map((method) => method.toUpperCase())
        .filter((method) => ["POST", "PUT", "PATCH", "DELETE"].includes(method))
        .map((method) => ({ method, path })),
    );
    expect(writes.length).toBeGreaterThanOrEqual(4);
    const unmapped = writes.filter(({ method, path }) => {
      const sample = `${path.startsWith("/v1") ? "" : "/v1"}${path.replace(/\{[^}]+\}/g, "00000000-0000-4000-8000-000000000000")}`;
      return !REST_AUDIT_ROUTES.some(
        (candidate) =>
          candidate.method === method && candidate.pattern.test(sample),
      );
    });
    expect(unmapped).toEqual([]);
  });

  test("maps refusals, role denials and failures to outcomes", () => {
    expect(auditOutcomeForError(new TRPCError({ code: "FORBIDDEN" }))).toBe(
      "denied",
    );
    expect(auditOutcomeForError(new TRPCError({ code: "CONFLICT" }))).toBe(
      "refused",
    );
    expect(auditOutcomeForError(new Error("boom"))).toBe("failed");
    expect([200, 202, 403, 409, 502].map(restOutcome)).toEqual([
      "succeeded",
      "succeeded",
      "denied",
      "refused",
      "failed",
    ]);
  });

  test("a write whose audit record cannot start is not run, in each surface's error shape", async () => {
    let ran = 0;
    const unavailable = new Proxy(
      {},
      {
        get() {
          throw new Error("database unavailable");
        },
      },
    );
    const app = new Hono()
      .use("*", async (c, next) => {
        c.set("teamId" as never, "team-1" as never);
        c.set("db" as never, unavailable as never);
        await next();
      })
      .use("*", withRestAuditTrail)
      .all("*", (c) => {
        ran += 1;
        return c.json({ ok: true });
      });

    const v1 = await app.request("/v1/invoices/inv-1/reextract", {
      method: "POST",
    });
    expect(v1.status).toBe(500);
    expect(await v1.json()).toEqual({
      error: {
        code: "internal_error",
        message: "The action could not be recorded, so it was not run.",
      },
    });

    const rest = await app.request("/webhooks", { method: "POST" });
    expect(rest.status).toBe(500);
    expect(await rest.json()).toEqual({
      error: "The action could not be recorded, so it was not run.",
    });
    expect(ran).toBe(0);
  });
});
