/**
 * Loopback stand-ins for every external provider the running app talks to.
 *
 * - TypeSafe: the verifiers' deterministic stub (`startTypeSafeStub`), which
 *   answers like a correct model for the committed synthetic invoice. No real
 *   TypeSafe call and no API spend, ever.
 * - Nango + Xero: a Nango API that binds a connection to the workspace that
 *   opened the connect session, in front of the stateful Xero fake the
 *   accounting verifiers use. Nothing reaches Xero or QuickBooks.
 * - Polar and anything else with a base URL: the release verifier's provider
 *   trap (a recording loopback server). No money moves.
 *
 * Every request is recorded so the evidence shows exactly what left the app.
 */

import { startTypeSafeStub } from "../../packages/jobs/src/verify-support";
import { createXeroFake } from "../../packages/jobs/src/xero-fake";

export type StubRequest = {
  provider: string;
  method: string;
  path: string;
  at: string;
};

export const NANGO_SECRET = "nango_verify_stub";
export const XERO_INTEGRATION = "xero-invoicewise-e2e";
export const XERO_ORGANISATION = {
  id: "7d0c0a3e-0000-4000-8000-0000000e2e01",
  name: "E2E Demo Trading Ltd",
};

export type Stubs = Awaited<ReturnType<typeof startStubs>>;

export async function startStubs() {
  const requests: StubRequest[] = [];
  const record = (provider: string, request: Request) => {
    const url = new URL(request.url);
    requests.push({
      provider,
      method: request.method,
      path: url.pathname,
      at: new Date().toISOString(),
    });
  };

  // TypeSafe: record, then forward to the verifiers' stub.
  const typeSafeStub = startTypeSafeStub();
  const typeSafe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      record("typesafe", request);
      const url = new URL(request.url);
      return fetch(
        `http://127.0.0.1:${typeSafeStub.port}${url.pathname}${url.search}`,
        {
          method: request.method,
          headers: request.headers,
          body: request.method === "GET" ? undefined : await request.text(),
        },
      );
    },
  });

  // Nango + Xero.
  const xero = createXeroFake([XERO_ORGANISATION]);
  /** connection id -> workspace id, created when a connect session opens. */
  const connections = new Map<string, string>();
  /** workspace id -> the connection its Connect UI session produced. */
  const sessions = new Map<string, string>();
  const unauthorized = () =>
    Response.json({ error: { message: "Unauthorized" } }, { status: 401 });

  let nangoOrigin = "";
  const nango = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request): Promise<Response> {
      record("nango", request);
      const url = new URL(request.url);
      if (request.headers.get("authorization") !== `Bearer ${NANGO_SECRET}`) {
        return unauthorized();
      }
      if (url.pathname.startsWith("/integrations/")) {
        return Response.json({
          data: {
            unique_key: decodeURIComponent(url.pathname.split("/")[2] ?? ""),
            provider: "xero",
          },
        });
      }
      if (request.method === "POST" && url.pathname === "/connect/sessions") {
        const body = (await request.json()) as {
          tags?: { workspace_id?: string };
        };
        const workspace = body.tags?.workspace_id ?? "";
        // What the user finishing Nango's Connect UI produces: one
        // connection tagged with the workspace that opened the session.
        const connectionId = `e2e-xero-${crypto.randomUUID()}`;
        connections.set(connectionId, workspace);
        sessions.set(workspace, connectionId);
        return Response.json({
          data: {
            token: `e2e-session-${crypto.randomUUID()}`,
            expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
            connect_link: `${nangoOrigin}/connect?session=e2e`,
          },
        });
      }
      if (request.method === "GET" && url.pathname === "/connections") {
        const id = url.searchParams.get("connectionId") ?? "";
        const tag = url.searchParams.get("tags[workspace_id]");
        const owner = connections.get(id);
        return Response.json({
          connections:
            owner && owner === tag
              ? [
                  {
                    connection_id: id,
                    provider_config_key: XERO_INTEGRATION,
                    tags: { workspace_id: owner },
                  },
                ]
              : [],
        });
      }
      const lookup = url.pathname.match(/^\/connection\/([^/]+)$/);
      if (lookup) {
        const id = decodeURIComponent(lookup[1] ?? "");
        if (!connections.has(id)) {
          return Response.json(
            { error: { message: "Unknown connection" } },
            { status: 404 },
          );
        }
        return Response.json({
          connection_id: id,
          connection_config: { tenant_id: XERO_ORGANISATION.id },
          credentials: {
            expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
          },
        });
      }
      const deleted = url.pathname.match(/^\/connections\/([^/]+)$/);
      if (request.method === "DELETE" && deleted) {
        connections.delete(decodeURIComponent(deleted[1] ?? ""));
        return Response.json({ success: true });
      }
      if (url.pathname.startsWith("/proxy/")) {
        if (
          !connections.has(request.headers.get("connection-id") ?? "") ||
          request.headers.get("provider-config-key") !== XERO_INTEGRATION
        ) {
          return Response.json(
            { error: { message: "Unknown connection" } },
            { status: 404 },
          );
        }
        const type = request.headers.get("content-type") ?? "";
        const answer = await xero.handle(
          request,
          url.pathname.slice("/proxy".length),
          url,
          type.startsWith("application/json")
            ? { json: (await request.json()) as Record<string, unknown> }
            : request.method === "GET"
              ? {}
              : { bytes: (await request.arrayBuffer()).byteLength },
        );
        if (answer) return answer;
      }
      return new Response("Not found", { status: 404 });
    },
  });

  nangoOrigin = `http://127.0.0.1:${nango.port}`;

  return {
    requests,
    typeSafeUrl: `http://127.0.0.1:${typeSafe.port}`,
    nangoUrl: nangoOrigin,
    xero,
    /** The Nango connection a workspace's connect session produced. */
    nangoConnectionFor: (teamId: string) => sessions.get(teamId),
    stop() {
      typeSafe.stop(true);
      typeSafeStub.stop(true);
      nango.stop(true);
    },
  };
}
