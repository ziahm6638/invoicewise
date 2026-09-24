/**
 * Real HTTP authorization checks for roadmap issue #32.
 *
 * Unlike the query/caller-level suite, this boots the actual API app on a
 * disposable local port: Better Auth runs through its own handler, sessions are
 * real signed cookies, tRPC and REST run their real middleware, and the OAuth
 * code/token/refresh/revoke endpoints are exercised end to end.
 *
 * Providers are stubbed. No request can leave the machine.
 *
 *   docker exec invoicewise-postgres-1 psql -U invoicewise -d postgres \
 *     -c "DROP DATABASE IF EXISTS invoicewise_perms_test" \
 *     -c "CREATE DATABASE invoicewise_perms_test"
 *   cd packages/db && DATABASE_PRIMARY_URL=postgresql://invoicewise:invoicewise@localhost:5432/invoicewise_perms_test bunx drizzle-kit migrate
 *   cd apps/api && PERMISSIONS_TEST_DATABASE_URL=postgresql://invoicewise:invoicewise@localhost:5432/invoicewise_perms_test \
 *     bun test src/permissions.http.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import type { Database, PrimaryDatabase } from "@invoicewise/db/client";

const testDatabaseUrl = process.env.PERMISSIONS_TEST_DATABASE_URL;
const PORT = 31777;
const BASE = `http://localhost:${PORT}`;

if (testDatabaseUrl) {
  process.env.DATABASE_PRIMARY_URL = testDatabaseUrl;
  process.env.BETTER_AUTH_SECRET ??= "permissions-http-integration-secret";
  process.env.BETTER_AUTH_URL = BASE;
  process.env.NEXT_PUBLIC_URL = BASE;
  process.env.RESEND_API_KEY ??= "re_permissions_http_test";
  process.env.POLAR_ACCESS_TOKEN ??= "polar_permissions_http_test";
  process.env.REDIS_URL ??= "redis://localhost:6379";
  process.env.MIDDAY_ENCRYPTION_KEY ??=
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  process.env.NODE_ENV ??= "test";
}

// No provider call may ever leave this test.
mock.module("@api/services/resend", () => ({
  resend: {
    emails: { send: async () => ({ data: { id: "stub" }, error: null }) },
    contacts: { remove: async () => ({ data: null, error: null }) },
  },
}));

const suite = testDatabaseUrl ? describe : describe.skip;

suite("workspace permissions over real HTTP", () => {
  let db: Database;
  let primaryDb: PrimaryDatabase;
  let schema: typeof import("@invoicewise/db/schema");
  let orm: typeof import("drizzle-orm");
  let superjson: typeof import("superjson").default;
  let server: ReturnType<typeof Bun.serve>;

  const created = {
    userIds: [] as string[],
    teamIds: [] as string[],
  };

  const post = (path: string, body: unknown, cookie?: string) =>
    fetch(`${BASE}${path}`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/json",
        origin: BASE,
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    });

  const get = (path: string, headers: Record<string, string> = {}) =>
    fetch(`${BASE}${path}`, {
      redirect: "manual",
      headers: { origin: BASE, ...headers },
    });

  const trpc = async (
    cookie: string,
    path: string,
    input: unknown,
    kind: "query" | "mutation" = "query",
  ) => {
    const serialized = JSON.stringify(superjson.serialize(input ?? null));

    const response =
      kind === "query"
        ? await get(`/trpc/${path}?input=${encodeURIComponent(serialized)}`, {
            cookie,
          })
        : await post(`/trpc/${path}`, JSON.parse(serialized), cookie);

    const text = await response.text();
    let parsed: any;

    try {
      parsed = JSON.parse(text);
    } catch {
      return { status: response.status, error: text, data: null };
    }

    if (parsed?.error) {
      return {
        status: response.status,
        error: parsed.error?.json?.message ?? parsed.error,
        data: null,
      };
    }

    return {
      status: response.status,
      error: null,
      data: superjson.deserialize(parsed.result.data),
    };
  };

  const switchTeam = (cookie: string, teamId: string) =>
    trpc(cookie, "user.update", { teamId }, "mutation");

  const sessionCookie = (response: Response) => {
    const cookie = response.headers.getSetCookie()[0];

    if (!cookie) {
      throw new Error("No session cookie was issued");
    }

    return cookie.split(";")[0]!;
  };

  /** Signs a user up through Better Auth, verifies them, and signs in. */
  const createUser = async (label: string) => {
    const email = `${label}-${crypto.randomUUID()}@example.test`;
    const password = "Password123!";

    const signUp = await post("/api/auth/sign-up/email", {
      email,
      password,
      name: label,
    });

    expect(signUp.status).toBe(200);

    // Fixture: mark the synthetic account verified so sign-in succeeds.
    await primaryDb
      .update(schema.users)
      .set({ emailVerified: true })
      .where(orm.eq(schema.users.email, email));

    const signIn = await post("/api/auth/sign-in/email", { email, password });
    expect(signIn.status).toBe(200);

    const user = await primaryDb.query.users.findFirst({
      where: orm.eq(schema.users.email, email),
      columns: { id: true, teamId: true },
    });

    if (!user) {
      throw new Error("User was not created");
    }

    created.userIds.push(user.id);
    if (user.teamId) {
      created.teamIds.push(user.teamId);
    }

    return {
      email,
      userId: user.id,
      personalTeamId: user.teamId!,
      cookie: sessionCookie(signIn),
    };
  };

  beforeAll(async () => {
    const client = await import("@invoicewise/db/client");
    schema = await import("@invoicewise/db/schema");
    orm = await import("drizzle-orm");
    superjson = (await import("superjson")).default;

    db = client.db;
    primaryDb = client.primaryDb;

    const { OpenAPIHono } = await import("@hono/zod-openapi");
    const { trpcServer } = await import("@hono/trpc-server");
    const { auth } = await import("@api/auth");
    const { createTRPCContext } = await import("@api/trpc/init");
    const { appRouter } = await import("@api/trpc/routers/_app");
    const { routers } = await import("@api/rest/routers");

    const app = new OpenAPIHono();

    app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
    app.use(
      "/trpc/*",
      trpcServer({ router: appRouter, createContext: createTRPCContext }),
    );
    app.route("/", routers);

    server = Bun.serve({ port: PORT, fetch: app.fetch });
  });

  afterAll(async () => {
    server?.stop(true);

    if (created.teamIds.length > 0) {
      await primaryDb
        .delete(schema.teams)
        .where(orm.inArray(schema.teams.id, created.teamIds));
    }

    if (created.userIds.length > 0) {
      await primaryDb
        .delete(schema.users)
        .where(orm.inArray(schema.users.id, created.userIds));
    }
  });

  test("three roles over real cookies: member denied, admin allowed, owner allowed", async () => {
    const owner = await createUser("owner");
    const admin = await createUser("admin");
    const member = await createUser("member");

    const teamResult = await trpc(
      owner.cookie,
      "team.create",
      { name: "HTTP Team", baseCurrency: "GBP", switchTeam: true },
      "mutation",
    );
    expect(teamResult.error).toBeNull();

    const teamId = teamResult.data as string;
    created.teamIds.push(teamId);

    for (const [user, role] of [
      [admin, "admin"],
      [member, "member"],
    ] as const) {
      const invited = await trpc(
        owner.cookie,
        "team.invite",
        [{ email: user.email, role }],
        "mutation",
      );
      expect(invited.error).toBeNull();
      expect((invited.data as { sent: number }).sent).toBe(1);

      const pending = await trpc(user.cookie, "team.invitesByEmail", null);
      const inviteId = (pending.data as { id: string }[])[0]!.id;

      const accepted = await trpc(
        user.cookie,
        "team.acceptInvite",
        { id: inviteId },
        "mutation",
      );
      expect(accepted.error).toBeNull();
      expect((accepted.data as { teamId: string }).teamId).toBe(teamId);
    }

    // Member: read is allowed, privileged actions are denied.
    const memberTeam = await switchTeam(member.cookie, teamId);
    expect(memberTeam.error).toBeNull();

    const memberRead = await trpc(member.cookie, "team.members", null);
    expect(memberRead.error).toBeNull();
    expect(memberRead.data).toHaveLength(3);

    expect(
      (await trpc(member.cookie, "team.delete", { teamId }, "mutation")).status,
    ).toBe(403);
    expect(
      (
        await trpc(
          member.cookie,
          "team.invite",
          [{ email: "nobody@example.test", role: "admin" }],
          "mutation",
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await trpc(
          member.cookie,
          "team.updateMember",
          { teamId, userId: admin.userId, role: "member" },
          "mutation",
        )
      ).status,
    ).toBe(403);
    expect((await trpc(member.cookie, "apiKeys.get", null)).status).toBe(403);
    expect((await trpc(member.cookie, "billing.orders", {})).status).toBe(403);

    // Admin: manages ordinary members, can never grant owner.
    await switchTeam(admin.cookie, teamId);

    const promoted = await trpc(
      admin.cookie,
      "team.updateMember",
      { teamId, userId: member.userId, role: "admin" },
      "mutation",
    );
    expect(promoted.error).toBeNull();

    const grantOwner = await trpc(
      admin.cookie,
      "team.updateMember",
      { teamId, userId: admin.userId, role: "owner" },
      "mutation",
    );
    expect(grantOwner.status).toBe(403);

    const demoteOwner = await trpc(
      admin.cookie,
      "team.updateMember",
      { teamId, userId: owner.userId, role: "member" },
      "mutation",
    );
    expect(demoteOwner.status).toBe(403);

    // Owner restores the member role and proves ownership transfer works.
    await switchTeam(owner.cookie, teamId);
    const restored = await trpc(
      owner.cookie,
      "team.updateMember",
      { teamId, userId: member.userId, role: "member" },
      "mutation",
    );
    expect(restored.error).toBeNull();

    const transfer = await trpc(
      owner.cookie,
      "team.updateMember",
      { teamId, userId: admin.userId, role: "owner" },
      "mutation",
    );
    expect(transfer.error).toBeNull();
    await trpc(
      admin.cookie,
      "team.updateMember",
      { teamId, userId: owner.userId, role: "owner" },
      "mutation",
    );
  });

  test("workspace switching works for a cookie and is refused for a foreign team", async () => {
    const user = await createUser("switcher");
    const owner = await createUser("switch-owner");

    const teamResult = await trpc(
      owner.cookie,
      "team.create",
      { name: "Switch Team", baseCurrency: "GBP", switchTeam: true },
      "mutation",
    );
    const teamId = teamResult.data as string;
    created.teamIds.push(teamId);

    await trpc(
      owner.cookie,
      "team.invite",
      [{ email: user.email, role: "member" }],
      "mutation",
    );
    const pending = await trpc(user.cookie, "team.invitesByEmail", null);
    await trpc(
      user.cookie,
      "team.acceptInvite",
      { id: (pending.data as { id: string }[])[0]!.id },
      "mutation",
    );

    const switched = await switchTeam(user.cookie, teamId);
    expect(switched.error).toBeNull();

    const current = await trpc(user.cookie, "team.current", null);
    expect((current.data as { id: string }).id).toBe(teamId);

    const back = await switchTeam(user.cookie, user.personalTeamId);
    expect(back.error).toBeNull();

    const foreign = await switchTeam(user.cookie, crypto.randomUUID());
    expect(foreign.status).toBe(403);
  });

  test("removing a member revokes their live cookie session immediately", async () => {
    const owner = await createUser("removal-owner");
    const member = await createUser("removal-member");

    const teamResult = await trpc(
      owner.cookie,
      "team.create",
      { name: "Removal Team", baseCurrency: "GBP", switchTeam: true },
      "mutation",
    );
    const teamId = teamResult.data as string;
    created.teamIds.push(teamId);

    await trpc(
      owner.cookie,
      "team.invite",
      [{ email: member.email, role: "member" }],
      "mutation",
    );
    const pending = await trpc(member.cookie, "team.invitesByEmail", null);
    await trpc(
      member.cookie,
      "team.acceptInvite",
      { id: (pending.data as { id: string }[])[0]!.id },
      "mutation",
    );
    await switchTeam(member.cookie, teamId);

    // While a member: REST and tRPC both work.
    expect(
      (await get(`/teams/${teamId}`, { cookie: member.cookie })).status,
    ).toBe(200);
    expect((await trpc(member.cookie, "team.members", null)).status).toBe(200);

    await switchTeam(owner.cookie, teamId);
    const removed = await trpc(
      owner.cookie,
      "team.deleteMember",
      { teamId, userId: member.userId },
      "mutation",
    );
    expect(removed.error).toBeNull();

    // The same cookie is refused on the next request, and the workspace is gone
    // from the user's team list.
    expect((await trpc(member.cookie, "team.members", null)).status).toBe(403);
    expect(
      (await get(`/teams/${teamId}`, { cookie: member.cookie })).status,
    ).toBe(404);

    const list = await trpc(member.cookie, "team.list", null);
    expect(
      (list.data as { id: string }[]).some((team) => team.id === teamId),
    ).toBe(false);
  });

  test("a credential is bound to its workspace while a cookie can span workspaces", async () => {
    const owner = await createUser("binding-owner");

    const teamResult = await trpc(
      owner.cookie,
      "team.create",
      { name: "Binding Team", baseCurrency: "GBP", switchTeam: true },
      "mutation",
    );
    const teamId = teamResult.data as string;
    created.teamIds.push(teamId);

    const keyResult = await trpc(
      owner.cookie,
      "apiKeys.upsert",
      { name: "Binding key", scopes: ["teams.read", "teams.write"] },
      "mutation",
    );
    expect(keyResult.error).toBeNull();
    const apiKey = (keyResult.data as { key: string }).key;

    // Cookie: both workspaces are listed, per the deliberate multi-workspace flow.
    const cookieList = await get("/teams", { cookie: owner.cookie });
    expect(cookieList.status).toBe(200);
    const cookieTeams = (await cookieList.json()) as { data: { id: string }[] };
    expect(cookieTeams.data.map((team) => team.id)).toEqual(
      expect.arrayContaining([teamId, owner.personalTeamId]),
    );

    // Credential: only the workspace it was minted for.
    const keyList = await get("/teams", { Authorization: `Bearer ${apiKey}` });
    expect(keyList.status).toBe(200);
    const keyTeams = (await keyList.json()) as { data: { id: string }[] };
    expect(keyTeams.data.map((team) => team.id)).toEqual([teamId]);

    // The credential cannot read, list members of, or update another workspace
    // its user belongs to.
    expect(
      (
        await get(`/teams/${owner.personalTeamId}`, {
          Authorization: `Bearer ${apiKey}`,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await get(`/teams/${owner.personalTeamId}/members`, {
          Authorization: `Bearer ${apiKey}`,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await fetch(`${BASE}/teams/${owner.personalTeamId}`, {
          method: "PATCH",
          redirect: "manual",
          headers: {
            "content-type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({ name: "Hijacked" }),
        })
      ).status,
    ).toBe(404);

    // Its own workspace still works, and a cookie can update it as owner.
    expect(
      (await get(`/teams/${teamId}`, { Authorization: `Bearer ${apiKey}` }))
        .status,
    ).toBe(200);
    expect(
      (
        await fetch(`${BASE}/teams/${teamId}`, {
          method: "PATCH",
          redirect: "manual",
          headers: {
            "content-type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({ name: "Binding Team Renamed" }),
        })
      ).status,
    ).toBe(200);
  });

  test("OAuth tokens are workspace-bound, revocable and refreshable only while a member", async () => {
    const owner = await createUser("oauth-owner");
    const admin = await createUser("oauth-admin");

    const teamResult = await trpc(
      owner.cookie,
      "team.create",
      { name: "OAuth Team", baseCurrency: "GBP", switchTeam: true },
      "mutation",
    );
    const teamId = teamResult.data as string;
    created.teamIds.push(teamId);

    await trpc(
      owner.cookie,
      "team.invite",
      [{ email: admin.email, role: "admin" }],
      "mutation",
    );
    const pending = await trpc(admin.cookie, "team.invitesByEmail", null);
    await trpc(
      admin.cookie,
      "team.acceptInvite",
      { id: (pending.data as { id: string }[])[0]!.id },
      "mutation",
    );
    await switchTeam(admin.cookie, teamId);

    const redirectUri = `${BASE}/oauth/callback`;
    const appResult = await trpc(
      admin.cookie,
      "oauthApplications.create",
      {
        name: `HTTP OAuth App ${crypto.randomUUID()}`,
        redirectUris: [redirectUri],
        scopes: ["teams.read", "teams.write"],
        isPublic: false,
      },
      "mutation",
    );
    expect(appResult.error).toBeNull();
    const application = appResult.data as {
      clientId: string;
      clientSecret: string;
    };

    const authorize = await post(
      "/oauth/authorize",
      {
        client_id: application.clientId,
        decision: "allow",
        scopes: ["teams.read", "teams.write"],
        redirect_uri: redirectUri,
        state: "a".repeat(32),
        teamId,
      },
      admin.cookie,
    );
    expect(authorize.status).toBe(200);
    const authorizeBody = (await authorize.json()) as { redirect_url: string };
    const code = new URL(authorizeBody.redirect_url).searchParams.get("code")!;

    const tokenResponse = await post("/oauth/token", {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: application.clientId,
      client_secret: application.clientSecret,
    });
    expect(tokenResponse.status).toBe(200);
    const tokens = (await tokenResponse.json()) as {
      access_token: string;
      refresh_token: string;
      scope: string;
    };
    expect(tokens.scope).toContain("teams.write");

    // The token sees only its workspace, even though the admin belongs to two.
    const tokenList = await get("/teams", {
      Authorization: `Bearer ${tokens.access_token}`,
    });
    expect(tokenList.status).toBe(200);
    const tokenTeams = (await tokenList.json()) as { data: { id: string }[] };
    expect(tokenTeams.data.map((team) => team.id)).toEqual([teamId]);
    expect(
      (
        await get(`/teams/${admin.personalTeamId}`, {
          Authorization: `Bearer ${tokens.access_token}`,
        })
      ).status,
    ).toBe(404);

    // Refresh while still an admin issues a new token.
    const refreshed = await post("/oauth/token", {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: application.clientId,
      client_secret: application.clientSecret,
    });
    expect(refreshed.status).toBe(200);
    const refreshedTokens = (await refreshed.json()) as {
      access_token: string;
    };

    // Revocation takes effect on the next request.
    const revoke = await post("/oauth/revoke", {
      token: refreshedTokens.access_token,
      client_id: application.clientId,
      client_secret: application.clientSecret,
    });
    expect(revoke.status).toBe(200);
    expect(
      (
        await get("/teams", {
          Authorization: `Bearer ${refreshedTokens.access_token}`,
        })
      ).status,
    ).toBe(401);

    // Removal revokes the grant: the access token stops working and the refresh
    // token can no longer mint one.
    await switchTeam(owner.cookie, teamId);
    await trpc(
      owner.cookie,
      "team.deleteMember",
      { teamId, userId: admin.userId },
      "mutation",
    );

    expect(
      (
        await get("/teams", {
          Authorization: `Bearer ${tokens.access_token}`,
        })
      ).status,
    ).toBe(401);

    const refreshAfterRemoval = await post("/oauth/token", {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: application.clientId,
      client_secret: application.clientSecret,
    });
    expect(refreshAfterRemoval.status).toBeGreaterThanOrEqual(400);
  });

  test("a member cannot grant a write scope through OAuth consent", async () => {
    const owner = await createUser("consent-owner");
    const member = await createUser("consent-member");

    const teamResult = await trpc(
      owner.cookie,
      "team.create",
      { name: "Consent Team", baseCurrency: "GBP", switchTeam: true },
      "mutation",
    );
    const teamId = teamResult.data as string;
    created.teamIds.push(teamId);

    await trpc(
      owner.cookie,
      "team.invite",
      [{ email: member.email, role: "member" }],
      "mutation",
    );
    const pending = await trpc(member.cookie, "team.invitesByEmail", null);
    await trpc(
      member.cookie,
      "team.acceptInvite",
      { id: (pending.data as { id: string }[])[0]!.id },
      "mutation",
    );

    const redirectUri = `${BASE}/oauth/callback`;
    const appResult = await trpc(
      owner.cookie,
      "oauthApplications.create",
      {
        name: `Consent App ${crypto.randomUUID()}`,
        redirectUris: [redirectUri],
        scopes: ["teams.read", "teams.write"],
        isPublic: false,
      },
      "mutation",
    );
    expect(appResult.error).toBeNull();
    const application = appResult.data as { clientId: string };

    const authorize = await post(
      "/oauth/authorize",
      {
        client_id: application.clientId,
        decision: "allow",
        scopes: ["teams.read", "teams.write"],
        redirect_uri: redirectUri,
        state: "b".repeat(32),
        teamId,
      },
      member.cookie,
    );

    expect(authorize.status).toBe(403);
  });

  test("account deletion is refused for a sole owner on every surface", async () => {
    const owner = await createUser("delete-owner");

    // Sole owner of their personal workspace: the guarded flow refuses.
    const guarded = await trpc(owner.cookie, "user.delete", null, "mutation");
    expect(guarded.status).toBe(409);
    expect(String(guarded.error)).toContain("Transfer ownership");

    // Better Auth's own delete endpoint stays disabled.
    const native = await post(
      "/api/auth/delete-user",
      { password: "Password123!" },
      owner.cookie,
    );
    expect(native.status).toBe(404);

    // The account and its workspace are untouched.
    const me = await trpc(owner.cookie, "user.me", null);
    expect(me.data).toBeTruthy();
    expect(
      await trpc(owner.cookie, "team.list", null).then((result) => result.data),
    ).toHaveLength(1);
  });

  test("consent accepts aliases and overlaps for owner and admin, denies member writes", async () => {
    const owner = await createUser("alias-owner");
    const admin = await createUser("alias-admin");
    const member = await createUser("alias-member");

    const teamResult = await trpc(
      owner.cookie,
      "team.create",
      { name: "Alias Team", baseCurrency: "GBP", switchTeam: true },
      "mutation",
    );
    const teamId = teamResult.data as string;
    created.teamIds.push(teamId);

    for (const [user, role] of [
      [admin, "admin"],
      [member, "member"],
    ] as const) {
      await trpc(
        owner.cookie,
        "team.invite",
        [{ email: user.email, role }],
        "mutation",
      );
      const pending = await trpc(user.cookie, "team.invitesByEmail", null);
      await trpc(
        user.cookie,
        "team.acceptInvite",
        { id: (pending.data as { id: string }[])[0]!.id },
        "mutation",
      );
    }

    const redirectUri = `${BASE}/oauth/callback`;
    const appResult = await trpc(
      owner.cookie,
      "oauthApplications.create",
      {
        name: `Alias App ${crypto.randomUUID()}`,
        redirectUris: [redirectUri],
        // The application registers the alias itself.
        scopes: ["apis.all"],
        isPublic: false,
      },
      "mutation",
    );
    expect(appResult.error).toBeNull();
    const application = appResult.data as {
      clientId: string;
      clientSecret: string;
    };

    // Owner consents to the alias: six concrete scopes, contained, allowed.
    const ownerConsent = await post(
      "/oauth/authorize",
      {
        client_id: application.clientId,
        decision: "allow",
        scopes: ["apis.all"],
        redirect_uri: redirectUri,
        state: "c".repeat(32),
        teamId,
      },
      owner.cookie,
    );
    expect(ownerConsent.status).toBe(200);

    const ownerCode = new URL(
      ((await ownerConsent.json()) as { redirect_url: string }).redirect_url,
    ).searchParams.get("code")!;

    const ownerToken = await post("/oauth/token", {
      grant_type: "authorization_code",
      code: ownerCode,
      redirect_uri: redirectUri,
      client_id: application.clientId,
      client_secret: application.clientSecret,
    });
    expect(ownerToken.status).toBe(200);
    const ownerScope = ((await ownerToken.json()) as { scope: string }).scope;

    // The alias expanded to the concrete known scopes, once each.
    expect(ownerScope.split(" ").sort()).toEqual(
      [
        "inbox.read",
        "inbox.write",
        "teams.read",
        "teams.write",
        "users.read",
        "users.write",
      ].sort(),
    );

    // Admin consents to a mix of an alias, a concrete scope and a duplicate.
    await switchTeam(admin.cookie, teamId);
    const adminConsent = await post(
      "/oauth/authorize",
      {
        client_id: application.clientId,
        decision: "allow",
        scopes: ["apis.read", "teams.write", "teams.write"],
        redirect_uri: redirectUri,
        state: "d".repeat(32),
        teamId,
      },
      admin.cookie,
    );
    expect(adminConsent.status).toBe(200);

    // The same request through the tRPC consent endpoint behaves identically.
    const trpcConsent = await trpc(
      admin.cookie,
      "oauthApplications.authorize",
      {
        clientId: application.clientId,
        decision: "allow",
        scopes: ["apis.all", "inbox.read"],
        redirectUri,
        teamId,
      },
      "mutation",
    );
    expect(trpcConsent.error).toBeNull();
    expect(
      new URL(
        (trpcConsent.data as { redirect_url: string }).redirect_url,
      ).searchParams.get("code"),
    ).toBeTruthy();

    // A member asking for the alias (or any team/user write) is refused.
    await switchTeam(member.cookie, teamId);

    const memberAlias = await post(
      "/oauth/authorize",
      {
        client_id: application.clientId,
        decision: "allow",
        scopes: ["apis.all"],
        redirect_uri: redirectUri,
        state: "e".repeat(32),
        teamId,
      },
      member.cookie,
    );
    expect(memberAlias.status).toBe(403);

    const memberWrite = await trpc(
      member.cookie,
      "oauthApplications.authorize",
      {
        clientId: application.clientId,
        decision: "allow",
        scopes: ["teams.write"],
        redirectUri,
        teamId,
      },
      "mutation",
    );
    expect(memberWrite.status).toBeGreaterThanOrEqual(400);

    // A member may still consent to scopes they hold.
    const memberRead = await trpc(
      member.cookie,
      "oauthApplications.authorize",
      {
        clientId: application.clientId,
        decision: "allow",
        scopes: ["apis.read", "inbox.read"],
        redirectUri,
        teamId,
      },
      "mutation",
    );
    expect(memberRead.error).toBeNull();
  });
});
