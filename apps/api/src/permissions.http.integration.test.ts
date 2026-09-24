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
const PORT = Number(process.env.PERMISSIONS_TEST_PORT ?? 31777);
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

// The mailbox connector talks to Google. Stub it so the connect/callback flow
// runs through the real tRPC routes while counting provider code exchanges.
const connectorCalls = { exchanges: 0 };

mock.module("@invoicewise/inbox/connector", () => ({
  InboxConnector: class {
    async connect(state: string) {
      const url = new URL("https://accounts.google.test/o/oauth2/auth");
      url.searchParams.set("state", state);
      return url.toString();
    }

    async exchangeCodeForAccount() {
      connectorCalls.exchanges += 1;
      return {
        id: crypto.randomUUID(),
        provider: "gmail",
        external_id: "stub",
      };
    }
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

  /** Invites `user` into the owner's active workspace and accepts it. */
  const joinTeam = async (
    owner: { cookie: string },
    user: { cookie: string; email: string },
    role: "admin" | "member",
  ) => {
    await trpc(
      owner.cookie,
      "team.invite",
      [{ email: user.email, role }],
      "mutation",
    );
    const pending = await trpc(user.cookie, "team.invitesByEmail", null);
    const accepted = await trpc(
      user.cookie,
      "team.acceptInvite",
      { id: (pending.data as { id: string }[])[0]!.id },
      "mutation",
    );
    expect(accepted.error).toBeNull();
  };

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

    // The same cookie can no longer read the workspace on the next request: it
    // has moved to the member's own workspace, and the removed one is gone from
    // the user's team list.
    const members = await trpc(member.cookie, "team.members", null);
    expect(members.status).toBe(200);
    expect(
      (members.data as { user: { id: string } }[]).map((row) => row.user.id),
    ).not.toContain(owner.userId);
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

  test("consent accepts aliases and overlaps for owner and admin, denies members", async () => {
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

    // Granting API access is an owner/admin capability, so even read scopes
    // a member holds cannot be handed to an app.
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
    expect(memberRead.status).toBe(403);
    expect(memberRead.data).toBeNull();
  });

  test("consent never redirects to an unregistered URI, even on deny", async () => {
    const owner = await createUser("redirect-owner");
    const redirectUri = `${BASE}/oauth/callback`;
    const appResult = await trpc(
      owner.cookie,
      "oauthApplications.create",
      {
        name: `Redirect App ${crypto.randomUUID()}`,
        redirectUris: [redirectUri],
        scopes: ["inbox.read"],
        isPublic: false,
      },
      "mutation",
    );
    expect(appResult.error).toBeNull();
    const application = appResult.data as { clientId: string };

    for (const decision of ["allow", "deny"] as const) {
      const result = await trpc(
        owner.cookie,
        "oauthApplications.authorize",
        {
          clientId: application.clientId,
          decision,
          scopes: ["inbox.read"],
          redirectUri: "https://attacker.example/callback",
          state: "c".repeat(32),
          teamId: owner.personalTeamId,
        },
        "mutation",
      );
      expect(result.data).toBeNull();
      expect(String(result.error)).toContain("Invalid redirect_uri");
    }

    const registered = await trpc(
      owner.cookie,
      "oauthApplications.authorize",
      {
        clientId: application.clientId,
        decision: "deny",
        scopes: ["inbox.read"],
        redirectUri,
        teamId: owner.personalTeamId,
      },
      "mutation",
    );
    expect(registered.error).toBeNull();
  });

  test("REST workspace resources refuse a session with no active workspace", async () => {
    const user = await createUser("no-active-team");
    await primaryDb
      .update(schema.authSessions)
      .set({ activeOrganizationId: null })
      .where(orm.eq(schema.authSessions.userId, user.userId));

    for (const path of ["/inbox", "/invoices", "/webhooks"]) {
      const response = await get(path, { cookie: user.cookie });
      expect(response.status).toBe(403);
    }

    const presigned = await post(
      `/inbox/${crypto.randomUUID()}/presigned-url`,
      {},
      user.cookie,
    );
    expect(presigned.status).toBe(403);

    // Account routes still work without a workspace.
    const me = await get("/users/me", { cookie: user.cookie });
    expect(me.status).toBe(200);
  });

  // Each recovery scenario provisions accounts and a shared workspace over
  // real HTTP, which outlasts bun's default per-test timeout.
  const RECOVERY_TEST_TIMEOUT_MS = 30_000;

  /** Owner creates a shared workspace and brings `member` into it as active. */
  const joinSharedWorkspace = async (label: string) => {
    const owner = await createUser(`${label}-owner`);
    const member = await createUser(`${label}-member`);

    const teamResult = await trpc(
      owner.cookie,
      "team.create",
      { name: `${label} Shared`, baseCurrency: "GBP", switchTeam: true },
      "mutation",
    );
    expect(teamResult.error).toBeNull();
    const teamId = teamResult.data as string;
    created.teamIds.push(teamId);

    const invited = await trpc(
      owner.cookie,
      "team.invite",
      [{ email: member.email, role: "member" }],
      "mutation",
    );
    expect(invited.error).toBeNull();

    const pending = await trpc(member.cookie, "team.invitesByEmail", null);
    const inviteId = (pending.data as { id: string }[])[0]!.id;
    const accepted = await trpc(
      member.cookie,
      "team.acceptInvite",
      { id: inviteId },
      "mutation",
    );
    expect(accepted.error).toBeNull();

    expect((await switchTeam(member.cookie, teamId)).error).toBeNull();
    const active = await trpc(member.cookie, "team.current", null);
    expect((active.data as { id: string }).id).toBe(teamId);

    return { owner, member, teamId };
  };

  const sessionPointers = async (userId: string) => {
    const sessions = await primaryDb
      .select({ teamId: schema.authSessions.activeOrganizationId })
      .from(schema.authSessions)
      .where(orm.eq(schema.authSessions.userId, userId));
    const user = await primaryDb.query.users.findFirst({
      where: orm.eq(schema.users.id, userId),
      columns: { teamId: true },
    });

    return { sessions: sessions.map((row) => row.teamId), user: user?.teamId };
  };

  test(
    "a member removed from their active workspace recovers on their next request",
    async () => {
      const { owner, member, teamId } = await joinSharedWorkspace("removed");

      const removed = await trpc(
        owner.cookie,
        "team.deleteMember",
        { teamId, userId: member.userId },
        "mutation",
      );
      expect(removed.error).toBeNull();

      // The next request lands in the workspace they still belong to.
      const current = await trpc(member.cookie, "team.current", null);
      expect(current.error).toBeNull();
      expect((current.data as { id: string }).id).toBe(member.personalTeamId);

      const me = await trpc(member.cookie, "user.me", null);
      expect(me.error).toBeNull();
      expect((me.data as { teamId: string }).teamId).toBe(
        member.personalTeamId,
      );

      // Nothing from the workspace they were removed from is readable.
      const members = await trpc(member.cookie, "team.members", null);
      expect(members.error).toBeNull();
      expect(
        (members.data as { user: { id: string } }[]).map((row) => row.user.id),
      ).toEqual([member.userId]);

      const inbox = await get("/inbox", { cookie: member.cookie });
      expect(inbox.status).toBe(200);

      expect(await sessionPointers(member.userId)).toEqual({
        sessions: [member.personalTeamId],
        user: member.personalTeamId,
      });
    },
    RECOVERY_TEST_TIMEOUT_MS,
  );

  test(
    "a stale active-workspace pointer is recovered server-side without exposing the stale workspace",
    async () => {
      const { member, teamId } = await joinSharedWorkspace("stale");

      // The membership ends without the pointers being cleared, as a removal
      // racing a workspace switch can leave them.
      await primaryDb
        .delete(schema.usersOnTeam)
        .where(
          orm.and(
            orm.eq(schema.usersOnTeam.teamId, teamId),
            orm.eq(schema.usersOnTeam.userId, member.userId),
          ),
        );
      expect(await sessionPointers(member.userId)).toEqual({
        sessions: [teamId],
        user: teamId,
      });

      // The first request after removal is a workspace read: it is served from
      // the workspace the member still belongs to, never the stale one.
      const members = await trpc(member.cookie, "team.members", null);
      expect(members.error).toBeNull();
      expect(
        (members.data as { user: { id: string } }[]).map((row) => row.user.id),
      ).toEqual([member.userId]);

      const current = await trpc(member.cookie, "team.current", null);
      expect((current.data as { id: string }).id).toBe(member.personalTeamId);

      expect(await sessionPointers(member.userId)).toEqual({
        sessions: [member.personalTeamId],
        user: member.personalTeamId,
      });
    },
    RECOVERY_TEST_TIMEOUT_MS,
  );

  test(
    "a stale pointer with no workspace left sends the user to workspace creation",
    async () => {
      const user = await createUser("stale-last");

      await primaryDb
        .delete(schema.usersOnTeam)
        .where(orm.eq(schema.usersOnTeam.userId, user.userId));

      // REST resources refuse cleanly instead of reading the stale workspace.
      const inbox = await get("/inbox", { cookie: user.cookie });
      expect(inbox.status).toBe(403);

      // The dashboard sees no active workspace and no workspace to choose, so it
      // routes to the chooser and on to workspace creation.
      const me = await trpc(user.cookie, "user.me", null);
      expect(me.error).toBeNull();
      expect((me.data as { teamId: string | null }).teamId).toBeNull();
      expect((me.data as { team: unknown }).team).toBeNull();

      const current = await trpc(user.cookie, "team.current", null);
      expect(current.error).toBeNull();
      expect(current.data).toBeNull();

      const teams = await trpc(user.cookie, "team.list", null);
      expect(teams.data).toEqual([]);

      const members = await trpc(user.cookie, "team.members", null);
      expect(members.status).toBe(403);

      expect(await sessionPointers(user.userId)).toEqual({
        sessions: [null],
        user: null,
      });
    },
    RECOVERY_TEST_TIMEOUT_MS,
  );

  test("OAuth consent follows the consenting user's role in each of two workspaces", async () => {
    const owner = await createUser("grant-owner");
    const admin = await createUser("grant-admin");
    // Owns their personal workspace, but is only a member of the shared one.
    const member = await createUser("grant-member");

    const teamResult = await trpc(
      owner.cookie,
      "team.create",
      { name: "Grant Team", baseCurrency: "GBP", switchTeam: true },
      "mutation",
    );
    const sharedTeamId = teamResult.data as string;
    created.teamIds.push(sharedTeamId);

    await joinTeam(owner, admin, "admin");
    await joinTeam(owner, member, "member");

    const redirectUri = `${BASE}/oauth/callback`;
    const appResult = await trpc(
      owner.cookie,
      "oauthApplications.create",
      {
        name: `Grant App ${crypto.randomUUID()}`,
        redirectUris: [redirectUri],
        scopes: ["inbox.read", "teams.read"],
        isPublic: false,
      },
      "mutation",
    );
    expect(appResult.error).toBeNull();
    const application = appResult.data as { clientId: string };

    const restConsent = (cookie: string, teamId: string) =>
      post(
        "/oauth/authorize",
        {
          client_id: application.clientId,
          decision: "allow",
          scopes: ["inbox.read"],
          redirect_uri: redirectUri,
          state: "g".repeat(32),
          teamId,
        },
        cookie,
      );

    const trpcConsent = (cookie: string, teamId: string) =>
      trpc(
        cookie,
        "oauthApplications.authorize",
        {
          clientId: application.clientId,
          decision: "allow",
          scopes: ["inbox.read"],
          redirectUri,
          teamId,
        },
        "mutation",
      );

    const codesFor = async (userId: string) =>
      (
        await primaryDb
          .select({ id: schema.oauthAuthorizationCodes.id })
          .from(schema.oauthAuthorizationCodes)
          .where(orm.eq(schema.oauthAuthorizationCodes.userId, userId))
      ).length;

    // Workspace 1 (shared): the member is refused on both consent surfaces,
    // even for a scope a member holds, and no code is minted.
    await switchTeam(member.cookie, sharedTeamId);
    const memberRest = await restConsent(member.cookie, sharedTeamId);
    expect(memberRest.status).toBe(403);
    expect(await memberRest.text()).not.toContain("code=");

    const memberTrpc = await trpcConsent(member.cookie, sharedTeamId);
    expect(memberTrpc.status).toBe(403);
    expect(memberTrpc.data).toBeNull();
    expect(await codesFor(member.userId)).toBe(0);

    // Owner and admin of the same workspace may grant.
    expect((await restConsent(owner.cookie, sharedTeamId)).status).toBe(200);
    await switchTeam(admin.cookie, sharedTeamId);
    expect((await restConsent(admin.cookie, sharedTeamId)).status).toBe(200);
    expect((await trpcConsent(admin.cookie, sharedTeamId)).error).toBeNull();

    // Workspace 2 (the member's own): the same person, as owner, may grant.
    expect(
      (await restConsent(member.cookie, member.personalTeamId)).status,
    ).toBe(200);
    expect(
      (await trpcConsent(member.cookie, member.personalTeamId)).error,
    ).toBeNull();
    expect(await codesFor(member.userId)).toBe(2);

    // The consent screen's workspace list carries the same decision.
    const teams = (await trpc(member.cookie, "team.list", null)).data as {
      id: string;
      permissions: { manageIntegrations: boolean };
    }[];
    expect(
      teams.find((team) => team.id === sharedTeamId)?.permissions
        .manageIntegrations,
    ).toBe(false);
    expect(
      teams.find((team) => team.id === member.personalTeamId)?.permissions
        .manageIntegrations,
    ).toBe(true);
  }, 30_000);

  test("a demoted admin can no longer refresh an OAuth grant", async () => {
    const owner = await createUser("refresh-owner");
    const admin = await createUser("refresh-admin");

    const teamResult = await trpc(
      owner.cookie,
      "team.create",
      { name: "Refresh Team", baseCurrency: "GBP", switchTeam: true },
      "mutation",
    );
    const teamId = teamResult.data as string;
    created.teamIds.push(teamId);
    await joinTeam(owner, admin, "admin");
    await switchTeam(admin.cookie, teamId);

    const redirectUri = `${BASE}/oauth/callback`;
    const appResult = await trpc(
      owner.cookie,
      "oauthApplications.create",
      {
        name: `Refresh App ${crypto.randomUUID()}`,
        redirectUris: [redirectUri],
        scopes: ["inbox.read"],
        isPublic: false,
      },
      "mutation",
    );
    const application = appResult.data as {
      clientId: string;
      clientSecret: string;
    };

    const consent = await post(
      "/oauth/authorize",
      {
        client_id: application.clientId,
        decision: "allow",
        scopes: ["inbox.read"],
        redirect_uri: redirectUri,
        state: "r".repeat(32),
        teamId,
      },
      admin.cookie,
    );
    expect(consent.status).toBe(200);
    const code = new URL(
      ((await consent.json()) as { redirect_url: string }).redirect_url,
    ).searchParams.get("code")!;

    const tokenResponse = await post("/oauth/token", {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: application.clientId,
      client_secret: application.clientSecret,
    });
    expect(tokenResponse.status).toBe(200);
    const tokens = (await tokenResponse.json()) as { refresh_token: string };

    // Demote directly so the grant survives and only the role changes; the
    // refresh must then refuse on role alone.
    await primaryDb
      .update(schema.usersOnTeam)
      .set({ role: "member" })
      .where(
        orm.and(
          orm.eq(schema.usersOnTeam.teamId, teamId),
          orm.eq(schema.usersOnTeam.userId, admin.userId),
        ),
      );

    const refreshed = await post("/oauth/token", {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: application.clientId,
      client_secret: application.clientSecret,
    });
    expect(refreshed.status).toBeGreaterThanOrEqual(400);
  }, 30_000);

  test("the profile read exposes no workspace credential", async () => {
    const user = await createUser("profile-read");

    const [team] = await primaryDb
      .select({ inboxId: schema.teams.inboxId })
      .from(schema.teams)
      .where(orm.eq(schema.teams.id, user.personalTeamId));
    const inboxId = team?.inboxId;
    expect(inboxId).toBeTruthy();

    const rest = await get("/users/me", { cookie: user.cookie });
    expect(rest.status).toBe(200);
    const restBody = await rest.text();
    expect(restBody).toContain(user.email);
    expect(restBody).not.toContain(inboxId!);
    expect(restBody).not.toContain("inboxId");

    const me = await trpc(user.cookie, "user.me", null);
    expect(me.error).toBeNull();
    const meBody = JSON.stringify(me.data);
    expect(meBody).toContain(user.email);
    expect(meBody).not.toContain(inboxId!);
    expect(meBody).not.toContain("inboxId");

    // The workspace-scoped read still provides the inbox address.
    const current = await trpc(user.cookie, "team.current", null);
    expect((current.data as { inboxId: string }).inboxId).toBe(inboxId!);
  }, 30_000);

  test("mailbox connect state is unguessable, single-use, session-bound and expiring", async () => {
    const admin = await createUser("connector-admin");
    const other = await createUser("connector-other");

    const connect = async (cookie: string) => {
      const result = await trpc(
        cookie,
        "inboxAccounts.connect",
        { provider: "gmail" },
        "mutation",
      );
      expect(result.error).toBeNull();
      return new URL(result.data as string).searchParams.get("state")!;
    };

    const exchange = (cookie: string, state: string) =>
      trpc(cookie, "inboxAccounts.exchangeCodeForAccount", {
        code: "provider-code",
        state,
      });

    // Unguessable: a fresh 256-bit value each time, never the provider name.
    const first = await connect(admin.cookie);
    const second = await connect(admin.cookie);
    expect(first).not.toBe("gmail");
    expect(first.length).toBeGreaterThanOrEqual(43);
    expect(first).not.toBe(second);

    // Only a hash is stored.
    const stored = await primaryDb
      .select({ identifier: schema.authVerifications.identifier })
      .from(schema.authVerifications)
      .where(
        orm.like(
          schema.authVerifications.identifier,
          "inbox-connector-state:%",
        ),
      );
    expect(stored.some((row) => row.identifier.includes(first))).toBe(false);

    const exchangesBefore = connectorCalls.exchanges;

    // A forged state and a missing binding are refused before the provider.
    expect((await exchange(admin.cookie, "gmail")).status).toBe(403);
    expect((await exchange(admin.cookie, crypto.randomUUID())).status).toBe(
      403,
    );

    // Foreign: another user's session cannot redeem it, and that attempt does
    // not burn it for its owner.
    expect((await exchange(other.cookie, first)).status).toBe(403);

    // Foreign session of the same user: a second sign-in is a different session.
    const secondSignIn = await post("/api/auth/sign-in/email", {
      email: admin.email,
      password: "Password123!",
    });
    expect(secondSignIn.status).toBe(200);
    const otherSession = (() => {
      const cookie = secondSignIn.headers.getSetCookie()[0]!;
      return cookie.split(";")[0]!;
    })();
    expect((await exchange(otherSession, first)).status).toBe(403);
    expect(connectorCalls.exchanges).toBe(exchangesBefore);

    // The initiating session redeems it once.
    const redeemed = await exchange(admin.cookie, first);
    expect(redeemed.error).toBeNull();
    expect((redeemed.data as { provider: string }).provider).toBe("gmail");
    expect(connectorCalls.exchanges).toBe(exchangesBefore + 1);

    // Replay is refused.
    expect((await exchange(admin.cookie, first)).status).toBe(403);

    // Concurrent redemption of one state succeeds at most once.
    const racing = await Promise.all([
      exchange(admin.cookie, second),
      exchange(admin.cookie, second),
    ]);
    expect(racing.filter((result) => result.error === null)).toHaveLength(1);
    expect(connectorCalls.exchanges).toBe(exchangesBefore + 2);

    // An expired state is refused.
    const expiring = await connect(admin.cookie);
    await primaryDb
      .update(schema.authVerifications)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(
        orm.like(
          schema.authVerifications.identifier,
          "inbox-connector-state:%",
        ),
      );
    expect((await exchange(admin.cookie, expiring)).status).toBe(403);
    expect(connectorCalls.exchanges).toBe(exchangesBefore + 2);

    // A state issued for one workspace cannot be redeemed after switching to
    // another.
    const teamResult = await trpc(
      admin.cookie,
      "team.create",
      { name: "Connector Team", baseCurrency: "GBP", switchTeam: false },
      "mutation",
    );
    created.teamIds.push(teamResult.data as string);
    const forPersonal = await connect(admin.cookie);
    await switchTeam(admin.cookie, teamResult.data as string);
    expect((await exchange(admin.cookie, forPersonal)).status).toBe(403);
  }, 30_000);
});
