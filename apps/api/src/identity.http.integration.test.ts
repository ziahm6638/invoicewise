/**
 * Real HTTP identity-lifecycle checks for roadmap issue #33.
 *
 * The whole journey runs through the supported endpoints: Better Auth's own
 * handler (the same one the dashboard mounts at `/api/auth/*`) for signup,
 * verification, email change and recovery, and the product tRPC/REST routers
 * for invitations and profile writes. Nothing edits `users.email` directly.
 *
 * Transactional mail is captured by the explicit local mail sink, and SMTP is
 * configured against a loopback SMTP trap that must receive no connection, so
 * no message can leave the machine. The database is a disposable local one.
 *
 *   docker exec invoicewise-postgres-1 psql -U invoicewise -d postgres \
 *     -c "DROP DATABASE IF EXISTS invoicewise_identity_test" \
 *     -c "CREATE DATABASE invoicewise_identity_test"
 *   cd packages/db && DATABASE_PRIMARY_URL=postgresql://invoicewise:invoicewise@localhost:5432/invoicewise_identity_test bunx drizzle-kit migrate
 *   cd apps/api && IDENTITY_TEST_DATABASE_URL=postgresql://invoicewise:invoicewise@localhost:5432/invoicewise_identity_test \
 *     bun test src/identity.http.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database, PrimaryDatabase } from "@invoicewise/db/client";
import { type SmtpTrap, startSmtpTrap } from "@invoicewise/utils/smtp-trap";

const testDatabaseUrl = process.env.IDENTITY_TEST_DATABASE_URL;
const PORT = 31783;
const BASE = `http://localhost:${PORT}`;
const AUTH_BASE = `${BASE}/api/auth`;

const suite = testDatabaseUrl ? describe : describe.skip;

suite("identity lifecycle over real HTTP", () => {
  let db: Database;
  let primaryDb: PrimaryDatabase;
  let schema: typeof import("@invoicewise/db/schema");
  let orm: typeof import("drizzle-orm");
  let superjson: typeof import("superjson").default;
  let server: ReturnType<typeof Bun.serve>;
  let mailSinkDir: string;
  let mailSinkPath: string;
  let smtpTrap: SmtpTrap;

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

  const patch = (path: string, body: unknown, cookie?: string) =>
    fetch(`${BASE}${path}`, {
      method: "PATCH",
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

  const sessionCookie = (response: Response) => {
    const cookie = response.headers.getSetCookie()[0];

    if (!cookie) {
      throw new Error("No session cookie was issued");
    }

    return cookie.split(";")[0]!;
  };

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
        code: parsed.error?.json?.code ?? null,
        data: null,
      };
    }

    return {
      status: response.status,
      error: null,
      code: null,
      data: superjson.deserialize(parsed.result.data),
    };
  };

  type CapturedMail = {
    to: string;
    subject: string;
    url?: string;
    html?: string | null;
    from?: string | null;
    at?: string;
  };

  /** All messages the explicit local sink captured for a recipient. */
  const readMails = async (to: string) => {
    const content = await readFile(mailSinkPath, "utf8").catch(() => "");

    return content
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as CapturedMail)
      .filter((message) => message.to === to);
  };

  /** Reads the latest captured message for a recipient from the mail sink. */
  const readMail = async (to: string) => {
    const deadline = Date.now() + 5_000;

    while (Date.now() < deadline) {
      const match = await readMails(to);

      if (match.length > 0) {
        return match[match.length - 1]!;
      }

      await Bun.sleep(50);
    }

    throw new Error(`No captured mail for ${to}`);
  };

  /**
   * Injects a real database failure for one operation and always removes it,
   * so a failing probe cannot leak a trigger into later tests.
   */
  const withFaultTrigger = async (
    name: string,
    table: string,
    timing: "INSERT" | "DELETE",
    run: () => Promise<void>,
  ) => {
    await primaryDb.execute(
      orm.sql.raw(
        `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected ${name} failure'; END $$`,
      ),
    );
    await primaryDb.execute(
      orm.sql.raw(
        `CREATE TRIGGER ${name} BEFORE ${timing} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}()`,
      ),
    );

    try {
      await run();
    } finally {
      await primaryDb.execute(
        orm.sql.raw(`DROP TRIGGER IF EXISTS ${name} ON ${table}`),
      );
      await primaryDb.execute(orm.sql.raw(`DROP FUNCTION IF EXISTS ${name}()`));
    }
  };

  /** Runs the real workflow queue once, as the worker executable would. */
  const runWorkflowBatchOnce = async () => {
    const { WorkflowRuntimeLive, runWorkflowBatch } = await import(
      "@invoicewise/jobs/runner"
    );
    const { Effect, LogLevel, Logger } = await import("effect");

    return await Effect.runPromise(
      runWorkflowBatch.pipe(
        Effect.provide(WorkflowRuntimeLive),
        Effect.provide(Logger.minimumLogLevel(LogLevel.None)),
        Effect.scoped,
      ),
    );
  };

  const userByEmail = (email: string) =>
    primaryDb.query.users.findFirst({
      where: orm.eq(schema.users.email, email),
      columns: { id: true, email: true, emailVerified: true, teamId: true },
    });

  const membershipRows = (userId: string) =>
    primaryDb
      .select({
        teamId: schema.usersOnTeam.teamId,
        role: schema.usersOnTeam.role,
      })
      .from(schema.usersOnTeam)
      .where(orm.eq(schema.usersOnTeam.userId, userId));

  const membershipIn = async (userId: string, teamId: string) => {
    const rows = await membershipRows(userId);
    return rows.filter((row) => row.teamId === teamId);
  };

  const inviteRow = (id: string) =>
    primaryDb.query.userInvites.findFirst({
      where: orm.eq(schema.userInvites.id, id),
      columns: {
        id: true,
        email: true,
        status: true,
        expiresAt: true,
        teamId: true,
      },
    });

  /**
   * Better Auth sign-up through the real endpoint plus the verification link
   * captured from the local mail sink. Verification itself is a separate step
   * so the partial-failure case can be seeded between the two.
   */
  /** Signup through Better Auth for an explicit address, plus its mail. */
  const signUpWithEmail = async (
    email: string,
    name: string,
    password = "Password123!",
  ) => {
    const signUp = await post("/api/auth/sign-up/email", {
      email,
      password,
      name,
    });
    expect(signUp.status).toBe(200);

    const user = await userByEmail(email);
    expect(user).toBeTruthy();
    created.userIds.push(user!.id);
    if (user!.teamId) created.teamIds.push(user!.teamId);

    const verification = await readMail(email);
    expect(verification.subject).toMatch(/verify/i);

    return {
      email,
      password,
      userId: user!.id,
      verificationUrl: verification.url!,
    };
  };

  const signUp = async (label: string, password = "Password123!") =>
    signUpWithEmail(
      `${label}-${crypto.randomUUID()}@example.test`,
      label,
      password,
    );

  /** Follows the captured verification link, which issues the session cookie. */
  const verify = async (account: { verificationUrl: string }) => {
    const verificationLink = new URL(account.verificationUrl);
    const verified = await get(
      verificationLink.pathname + verificationLink.search,
    );
    // Better Auth redirects to the callback URL and issues the session cookie
    // (autoSignInAfterVerification) on the same response.
    expect([200, 302]).toContain(verified.status);

    return {
      cookie: sessionCookie(verified),
    };
  };

  const signUpAndVerify = async (label: string, password = "Password123!") => {
    const account = await signUp(label, password);
    const { cookie } = await verify(account);

    return { ...account, cookie };
  };

  const signIn = async (email: string, password: string) => {
    const response = await post("/api/auth/sign-in/email", {
      email,
      password,
    });

    return response;
  };

  beforeAll(async () => {
    if (!testDatabaseUrl) return;

    mailSinkDir = await mkdtemp(join(tmpdir(), "identity-mail-sink-"));
    mailSinkPath = join(mailSinkDir, "mail.jsonl");

    smtpTrap = await startSmtpTrap();

    process.env.DATABASE_PRIMARY_URL = testDatabaseUrl;
    process.env.BETTER_AUTH_SECRET ??= "identity-http-integration-secret";
    process.env.BETTER_AUTH_URL = BASE;
    process.env.NEXT_PUBLIC_URL = BASE;
    // SMTP is fully configured, but only against the loopback trap, and the
    // explicit sink wins outside production: every identity and workflow
    // message must land in the sink with no SMTP connection at all.
    process.env.SMTP_HOST = smtpTrap.host;
    process.env.SMTP_PORT = String(smtpTrap.port);
    process.env.SMTP_USER = "identity@invoicewise.test";
    process.env.SMTP_PASS = "synthetic-identity-smtp-password";
    process.env.AUTH_EMAIL_FROM = "InvoiceWise <auth@invoicewise.test>";
    process.env.AUTH_MAIL_SINK_PATH = mailSinkPath;
    process.env.POLAR_ACCESS_TOKEN ??= "polar_identity_http_test";
    process.env.REDIS_URL ??= "redis://localhost:6379";
    process.env.MIDDAY_ENCRYPTION_KEY ??=
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    process.env.NODE_ENV = "test";

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
    await smtpTrap?.stop();

    if (!testDatabaseUrl) return;

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

    await rm(mailSinkDir, { recursive: true, force: true });
  });

  test("provisioning failure during signup and verification recovers through the verification link", async () => {
    const email = `provisioning-fault-${crypto.randomUUID()}@example.test`;
    const workspaceName = "Provisioning Fault's workspace";
    let verificationLink = "";
    let userId = "";

    await withFaultTrigger(
      "identity_fail_provision",
      "teams",
      "INSERT",
      async () => {
        const signup = await post("/api/auth/sign-up/email", {
          email,
          password: "Password123!",
          name: "Provisioning Fault",
        });
        // The account is created and the verification mail is queued; a
        // provisioning failure must not fail the customer's signup.
        expect(signup.status).toBe(200);

        const user = await userByEmail(email);
        expect(user).toBeTruthy();
        userId = user!.id;
        created.userIds.push(userId);
        expect(user!.teamId).toBeNull();
        expect(await membershipRows(userId)).toHaveLength(0);

        const mail = await readMail(email);
        expect(mail.url).toBeTruthy();
        const url = new URL(mail.url!);
        verificationLink = url.pathname + url.search;

        // Verification completes and marks the address verified even while
        // provisioning keeps failing.
        const verified = await get(verificationLink);
        expect([200, 302]).toContain(verified.status);
        expect((await userByEmail(email))!.emailVerified).toBe(true);
        expect(await membershipRows(userId)).toHaveLength(0);
      },
    );

    // The trigger is gone. Retrying the link is the supported customer path.
    const retry = await get(verificationLink);
    expect([200, 302]).toContain(retry.status);

    const repaired = await userByEmail(email);
    const memberships = await membershipRows(userId);
    expect(memberships).toHaveLength(1);
    expect(memberships[0]!.role).toBe("owner");
    expect(repaired!.teamId).toBe(memberships[0]!.teamId);
    created.teamIds.push(memberships[0]!.teamId);

    // Exactly one workspace exists, with the owning membership and no orphan.
    const workspaces = await primaryDb
      .select({ id: schema.teams.id })
      .from(schema.teams)
      .where(orm.eq(schema.teams.name, workspaceName));
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]!.id).toBe(memberships[0]!.teamId);
  });

  test("concurrent verification retries after a provisioning failure settle on one workspace", async () => {
    const email = `provisioning-concurrent-${crypto.randomUUID()}@example.test`;
    let verificationLink = "";
    let userId = "";

    await withFaultTrigger(
      "identity_fail_provision_concurrent",
      "teams",
      "INSERT",
      async () => {
        const signup = await post("/api/auth/sign-up/email", {
          email,
          password: "Password123!",
          name: "Concurrent Repair",
        });
        expect(signup.status).toBe(200);

        const user = await userByEmail(email);
        userId = user!.id;
        created.userIds.push(userId);

        const mail = await readMail(email);
        const url = new URL(mail.url!);
        verificationLink = url.pathname + url.search;
        expect([200, 302]).toContain((await get(verificationLink)).status);
        expect(await membershipRows(userId)).toHaveLength(0);
      },
    );

    const [first, second] = await Promise.all([
      get(verificationLink),
      get(verificationLink),
    ]);
    expect([200, 302]).toContain(first.status);
    expect([200, 302]).toContain(second.status);

    const memberships = await membershipRows(userId);
    expect(memberships).toHaveLength(1);
    created.teamIds.push(memberships[0]!.teamId);
    expect((await userByEmail(email))!.teamId).toBe(memberships[0]!.teamId);
  });

  test("sign-in repairs a workspace that provisioning never created", async () => {
    const email = `provisioning-signin-${crypto.randomUUID()}@example.test`;
    let userId = "";

    await withFaultTrigger(
      "identity_fail_provision_signin",
      "teams",
      "INSERT",
      async () => {
        await post("/api/auth/sign-up/email", {
          email,
          password: "Password123!",
          name: "Sign-In Repair",
        });
        const user = await userByEmail(email);
        userId = user!.id;
        created.userIds.push(userId);

        const mail = await readMail(email);
        const url = new URL(mail.url!);
        expect([200, 302]).toContain(
          (await get(url.pathname + url.search)).status,
        );
        expect(await membershipRows(userId)).toHaveLength(0);
      },
    );

    // No link retry: the customer simply signs in.
    const signedIn = await signIn(email, "Password123!");
    expect(signedIn.status).toBe(200);

    const memberships = await membershipRows(userId);
    expect(memberships).toHaveLength(1);
    expect(memberships[0]!.role).toBe("owner");
    created.teamIds.push(memberships[0]!.teamId);

    const session = await get("/api/auth/get-session", {
      cookie: sessionCookie(signedIn),
    });
    const body = (await session.json()) as {
      session?: { activeOrganizationId?: string | null };
    } | null;
    expect(body?.session?.activeOrganizationId).toBe(memberships[0]!.teamId);
  });

  test("invitation acceptance is atomic and rejects replay, revocation, expiry and the wrong recipient", async () => {
    const owner = await signUpAndVerify("invite-owner");
    const ownerTeams = await membershipRows(owner.userId);
    const teamId = ownerTeams[0]!.teamId;

    // Pending invitee fixture accounts (signed up and verified through the real
    // endpoints) plus one pending invite per rejection case.
    const cases = [
      { label: "replay", role: "member" as const },
      { label: "revoked", role: "member" as const },
      { label: "status-revoked", role: "member" as const },
      { label: "expired", role: "member" as const },
      { label: "wrong-recipient", role: "member" as const },
      { label: "concurrent", role: "member" as const },
    ];

    const invitee = async (label: string) => signUpAndVerify(label);
    const invited = new Map<string, Awaited<ReturnType<typeof invitee>>>();

    for (const entry of cases) {
      const account = await invitee(entry.label);
      invited.set(entry.label, account);

      const created = await trpc(
        owner.cookie,
        "team.invite",
        [{ email: account.email, role: entry.role }],
        "mutation",
      );
      expect(created.error).toBeNull();
    }

    const inviteId = async (label: string) => {
      const account = invited.get(label)!;
      const pending = await trpc(account.cookie, "team.invitesByEmail", null);
      expect(pending.error).toBeNull();
      const row = (pending.data as { id: string }[])[0];
      if (!row) throw new Error(`No pending invite for ${label}`);
      return row.id;
    };

    // Happy path first: accept, consume, and replay must fail.
    const replayAccount = invited.get("replay")!;
    const replayInvite = await inviteId("replay");
    const accepted = await trpc(
      replayAccount.cookie,
      "team.acceptInvite",
      { id: replayInvite },
      "mutation",
    );
    expect(accepted.error).toBeNull();
    expect((accepted.data as { teamId: string }).teamId).toBe(teamId);

    const replayAgain = await trpc(
      replayAccount.cookie,
      "team.acceptInvite",
      { id: replayInvite },
      "mutation",
    );
    expect(replayAgain.data).toBeNull();
    expect(replayAgain.error).toMatch(/not found/i);
    expect(await inviteRow(replayInvite)).toBeUndefined();
    expect(await membershipIn(replayAccount.userId, teamId)).toHaveLength(1);

    // Revoked: the workspace cancels the invite before acceptance.
    const revokedAccount = invited.get("revoked")!;
    const revokedInvite = await inviteId("revoked");
    const revoked = await trpc(
      owner.cookie,
      "team.deleteInvite",
      { id: revokedInvite },
      "mutation",
    );
    expect(revoked.error).toBeNull();

    const afterRevoke = await trpc(
      revokedAccount.cookie,
      "team.acceptInvite",
      { id: revokedInvite },
      "mutation",
    );
    expect(afterRevoke.data).toBeNull();
    expect(afterRevoke.error).toMatch(/not found/i);
    expect(await membershipIn(revokedAccount.userId, teamId)).toHaveLength(0);

    // Revoked by status as well as by deletion: the locked acceptance reads the
    // row it will act on, so a non-pending invite can never be spent.
    const statusRevokedAccount = invited.get("status-revoked")!;
    const statusRevokedInvite = await inviteId("status-revoked");
    await primaryDb
      .update(schema.userInvites)
      .set({ status: "revoked" })
      .where(orm.eq(schema.userInvites.id, statusRevokedInvite));

    const afterStatusRevoke = await trpc(
      statusRevokedAccount.cookie,
      "team.acceptInvite",
      { id: statusRevokedInvite },
      "mutation",
    );
    expect(afterStatusRevoke.data).toBeNull();
    expect(afterStatusRevoke.error).toMatch(/not pending|revoked/i);
    expect(
      await membershipIn(statusRevokedAccount.userId, teamId),
    ).toHaveLength(0);

    // Expired: the row is past its expiry (fixture seeding only; acceptance is
    // the real endpoint) and is neither listed nor acceptable.
    const expiredAccount = invited.get("expired")!;
    const expiredInvite = await inviteId("expired");
    await primaryDb
      .update(schema.userInvites)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(orm.eq(schema.userInvites.id, expiredInvite));

    const listed = await trpc(
      expiredAccount.cookie,
      "team.invitesByEmail",
      null,
    );
    expect(listed.data).toEqual([]);

    const afterExpiry = await trpc(
      expiredAccount.cookie,
      "team.acceptInvite",
      { id: expiredInvite },
      "mutation",
    );
    expect(afterExpiry.data).toBeNull();
    expect(afterExpiry.error).toMatch(/expired/i);
    expect(await membershipIn(expiredAccount.userId, teamId)).toHaveLength(0);

    // Wrong recipient: another verified account cannot spend this invite, and
    // the rejected attempt leaves it usable by the real recipient.
    const wrongAccount = invited.get("wrong-recipient")!;
    const wrongInvite = await inviteId("wrong-recipient");
    const intruder = await signUpAndVerify("intruder");

    const stolen = await trpc(
      intruder.cookie,
      "team.acceptInvite",
      { id: wrongInvite },
      "mutation",
    );
    expect(stolen.data).toBeNull();
    expect(stolen.error).toMatch(/different email/i);
    expect(await membershipIn(intruder.userId, teamId)).toHaveLength(0);
    expect(await inviteRow(wrongInvite)).toBeTruthy();

    const rightful = await trpc(
      wrongAccount.cookie,
      "team.acceptInvite",
      { id: wrongInvite },
      "mutation",
    );
    expect(rightful.error).toBeNull();

    // Concurrent acceptance settles exactly once.
    const concurrentAccount = invited.get("concurrent")!;
    const concurrentInvite = await inviteId("concurrent");

    const [a, b] = await Promise.all([
      trpc(
        concurrentAccount.cookie,
        "team.acceptInvite",
        { id: concurrentInvite },
        "mutation",
      ),
      trpc(
        concurrentAccount.cookie,
        "team.acceptInvite",
        { id: concurrentInvite },
        "mutation",
      ),
    ]);

    const outcomes = [a, b];
    expect(outcomes.filter((outcome) => outcome.error === null)).toHaveLength(
      1,
    );
    expect(await membershipIn(concurrentAccount.userId, teamId)).toHaveLength(
      1,
    );
    expect(await inviteRow(concurrentInvite)).toBeUndefined();
  });

  test("generic profile writes cannot change the verified address", async () => {
    const account = await signUpAndVerify("profile-bypass");

    const rest = await patch(
      "/users/me",
      { email: "rest-bypass@example.test" },
      account.cookie,
    );
    expect(rest.status).toBeGreaterThanOrEqual(400);
    expect((await userByEmail(account.email))!.email).toBe(account.email);

    const trpcResult = await trpc(
      account.cookie,
      "user.update",
      { email: "trpc-bypass@example.test" },
      "mutation",
    );
    expect(trpcResult.data).toBeNull();
    expect((await userByEmail(account.email))!.email).toBe(account.email);

    // Sibling path: Better Auth's own profile endpoint must not move the
    // address either (it accepts name and image only).
    const native = await post(
      "/api/auth/update-user",
      { email: "native-bypass@example.test", name: "Renamed" },
      account.cookie,
    );
    // Better Auth's own profile endpoint accepts only the fields it declares
    // (name/image here); the email key cannot move the verified address either
    // way. 200 = ignored, 400 = rejected.
    expect([200, 400]).toContain(native.status);
    expect((await userByEmail(account.email))!.email).toBe(account.email);

    expect(await userByEmail("rest-bypass@example.test")).toBeUndefined();
    expect(await userByEmail("trpc-bypass@example.test")).toBeUndefined();
    expect(await userByEmail("native-bypass@example.test")).toBeUndefined();
  });

  test("email change needs a fresh session, verifies the new address, revokes every session and preserves membership", async () => {
    const owner = await signUpAndVerify("email-owner");
    const teamId = (await membershipRows(owner.userId))[0]!.teamId;

    // A second workspace invites this account's current address so the change
    // cannot silently rebind the pending invitation.
    const otherOwner = await signUpAndVerify("email-other-owner");
    const otherTeamId = (await membershipRows(otherOwner.userId))[0]!.teamId;
    const pending = await trpc(
      otherOwner.cookie,
      "team.invite",
      [{ email: owner.email, role: "member" }],
      "mutation",
    );
    expect(pending.error).toBeNull();
    const pendingInvite = await primaryDb.query.userInvites.findFirst({
      where: orm.eq(schema.userInvites.email, owner.email),
      columns: { id: true, email: true },
    });

    // Stale session: backdate the session beyond the recent-auth window. The
    // request is still the real endpoint with a real cookie.
    await primaryDb
      .update(schema.authSessions)
      .set({ createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) })
      .where(orm.eq(schema.authSessions.userId, owner.userId));

    const stale = await post(
      "/api/auth/change-email",
      { newEmail: `stale-${crypto.randomUUID()}@example.test` },
      owner.cookie,
    );
    expect(stale.status).toBe(403);
    expect((await userByEmail(owner.email))!.email).toBe(owner.email);

    // Recent session: sign in again, then change the address through Better
    // Auth and follow the captured verification link.
    const freshSignIn = await signIn(owner.email, owner.password);
    expect(freshSignIn.status).toBe(200);
    const freshCookie = sessionCookie(freshSignIn);

    const newEmail = `changed-${crypto.randomUUID()}@example.test`;
    const requested = await post(
      "/api/auth/change-email",
      { newEmail },
      freshCookie,
    );
    expect(requested.status).toBe(200);

    const changeMail = await readMail(newEmail);
    const changeLink = new URL(changeMail.url!);
    const completed = await get(changeLink.pathname + changeLink.search);
    expect([200, 302]).toContain(completed.status);

    const changed = await userByEmail(newEmail);
    expect(changed?.id).toBe(owner.userId);
    expect(changed?.emailVerified).toBe(true);
    expect(await userByEmail(owner.email)).toBeUndefined();

    // Every session ends; the account signs in again with the new address.
    const afterChange = await get("/api/auth/get-session", {
      cookie: freshCookie,
    });
    expect(await afterChange.json()).toBeNull();

    // The completion response may issue a cookie; it must not authorize either,
    // because the session it refers to was ended by the same completion.
    expect(completed.headers.getSetCookie()).toHaveLength(0);
    const issued = completed.headers.getSetCookie()[0];
    if (issued) {
      const issuedSession = await get("/api/auth/get-session", {
        cookie: issued.split(";")[0]!,
      });
      expect(await issuedSession.json()).toBeNull();
    }

    const reSignIn = await signIn(newEmail, owner.password);
    expect(reSignIn.status).toBe(200);

    // Workspace membership survived, and the pending invite still belongs to
    // the old address rather than silently following the account.
    const membership = await membershipRows(owner.userId);
    expect(membership).toHaveLength(1);
    expect(membership[0]!.teamId).toBe(teamId);
    expect(membership[0]!.role).toBe("owner");

    const untouchedInvite = await inviteRow(pendingInvite!.id);
    expect(untouchedInvite?.email).toBe(owner.email);
    expect(untouchedInvite?.teamId).toBe(otherTeamId);

    const rebound = await trpc(
      sessionCookie(reSignIn),
      "team.acceptInvite",
      { id: pendingInvite!.id },
      "mutation",
    );
    expect(rebound.data).toBeNull();
    expect(rebound.error).toMatch(/different email/i);
  });

  test("a session-revocation failure cannot move the verified address", async () => {
    const account = await signUpAndVerify("email-revocation-fault");
    const newEmail = `revocation-fault-${crypto.randomUUID()}@example.test`;

    const requested = await post(
      "/api/auth/change-email",
      { newEmail },
      account.cookie,
    );
    expect(requested.status).toBe(200);

    const mail = await readMail(newEmail);
    const link = new URL(mail.url!);
    const changePath = link.pathname + link.search;

    await withFaultTrigger(
      "identity_fail_email_change_revoke",
      "auth_sessions",
      "DELETE",
      async () => {
        const failed = await get(changePath);
        expect(failed.status).toBeGreaterThanOrEqual(500);

        // The revocation is ordered before the identity mutation, so the
        // failure leaves the account on its old verified address.
        expect(await userByEmail(newEmail)).toBeUndefined();
        expect((await userByEmail(account.email))?.id).toBe(account.userId);

        // The failed attempt is consistent: nothing moved and the customer's
        // existing session is still the account's own session.
        const alive = await get("/api/auth/get-session", {
          cookie: account.cookie,
        });
        const body = (await alive.json()) as {
          session?: { userId?: string };
        } | null;
        expect(body?.session?.userId).toBe(account.userId);
      },
    );

    // Retrying the same link now commits the change and the revocation.
    const retried = await get(changePath);
    expect([200, 302]).toContain(retried.status);
    expect((await userByEmail(newEmail))?.id).toBe(account.userId);
    expect(await userByEmail(account.email)).toBeUndefined();

    const staleSession = await get("/api/auth/get-session", {
      cookie: account.cookie,
    });
    expect(await staleSession.json()).toBeNull();

    const issued = retried.headers.getSetCookie()[0];
    if (issued) {
      const issuedSession = await get("/api/auth/get-session", {
        cookie: issued.split(";")[0]!,
      });
      expect(await issuedSession.json()).toBeNull();
    }

    const reSignIn = await signIn(newEmail, account.password);
    expect(reSignIn.status).toBe(200);
    expect(await membershipRows(account.userId)).toHaveLength(1);
  });

  test("a session-revocation failure cannot change the password on reset", async () => {
    const account = await signUpAndVerify("reset-revocation-fault");
    const newPassword = "ResetFaultPassword1!";

    const requested = await post("/api/auth/request-password-reset", {
      email: account.email,
      redirectTo: "/reset-password",
    });
    expect(requested.status).toBe(200);

    const mail = await readMail(account.email);
    const resetLink = new URL(mail.url!);
    const followed = await get(resetLink.pathname + resetLink.search);
    expect(followed.status).toBe(302);
    const token = new URL(
      followed.headers.get("location")!,
      BASE,
    ).searchParams.get("token");
    expect(token).toBeTruthy();

    await withFaultTrigger(
      "identity_fail_reset_revoke",
      "auth_sessions",
      "DELETE",
      async () => {
        const failed = await post("/api/auth/reset-password", {
          newPassword,
          token,
        });
        expect(failed.status).toBeGreaterThanOrEqual(500);
      },
    );

    // The failure aborted before the credential changed, and the token was not
    // consumed, so the customer can simply retry the same link.
    expect((await signIn(account.email, account.password)).status).toBe(200);
    expect((await signIn(account.email, newPassword)).status).toBe(401);

    const retried = await post("/api/auth/reset-password", {
      newPassword,
      token,
    });
    expect(retried.status).toBe(200);
    expect((await signIn(account.email, account.password)).status).toBe(401);
    expect((await signIn(account.email, newPassword)).status).toBe(200);
    expect(await membershipRows(account.userId)).toHaveLength(1);
  });

  test("a session-revocation failure cannot change the password on change-password", async () => {
    const account = await signUpAndVerify("change-revocation-fault");
    const otherSignIn = await signIn(account.email, account.password);
    expect(otherSignIn.status).toBe(200);
    const otherCookie = sessionCookie(otherSignIn);
    const newPassword = "ChangeFaultPassword1!";

    await withFaultTrigger(
      "identity_fail_change_revoke",
      "auth_sessions",
      "DELETE",
      async () => {
        const failed = await post(
          "/api/auth/change-password",
          {
            currentPassword: account.password,
            newPassword,
            revokeOtherSessions: true,
          },
          account.cookie,
        );
        expect(failed.status).toBeGreaterThanOrEqual(500);

        // Nothing was revoked or changed by the failed attempt.
        const stillAlive = await get("/api/auth/get-session", {
          cookie: otherCookie,
        });
        const otherBody = (await stillAlive.json()) as {
          session?: unknown;
        } | null;
        expect(otherBody?.session).toBeTruthy();
      },
    );

    expect((await signIn(account.email, account.password)).status).toBe(200);
    expect((await signIn(account.email, newPassword)).status).toBe(401);

    const retried = await post(
      "/api/auth/change-password",
      {
        currentPassword: account.password,
        newPassword,
        revokeOtherSessions: true,
      },
      account.cookie,
    );
    expect(retried.status).toBe(200);

    const rotated = sessionCookie(retried);
    const rotatedSession = await get("/api/auth/get-session", {
      cookie: rotated,
    });
    expect(
      ((await rotatedSession.json()) as { user?: { email?: string } } | null)
        ?.user?.email,
    ).toBe(account.email);

    const revoked = await get("/api/auth/get-session", { cookie: otherCookie });
    expect(await revoked.json()).toBeNull();
    expect((await signIn(account.email, account.password)).status).toBe(401);
    expect((await signIn(account.email, newPassword)).status).toBe(200);
  });

  test("queued invitation mail is captured locally and the recipient accepts", async () => {
    const owner = await signUpAndVerify("invite-mail-owner");
    const teamId = (await membershipRows(owner.userId))[0]!.teamId;
    const inviteeEmail = `invite-mail-${crypto.randomUUID()}@example.test`;
    const otherEmail = `invite-mail-other-${crypto.randomUUID()}@example.test`;

    const invited = await trpc(
      owner.cookie,
      "team.invite",
      [
        { email: inviteeEmail, role: "member" },
        { email: otherEmail, role: "member" },
      ],
      "mutation",
    );
    expect(invited.error).toBeNull();
    expect((invited.data as { sent: number }).sent).toBe(2);

    // The invitation is delivered by the real queue, not by the request.
    const queued = await primaryDb
      .select({
        id: schema.workflowJobs.id,
        name: schema.workflowJobs.name,
        status: schema.workflowJobs.status,
      })
      .from(schema.workflowJobs)
      .where(
        orm.and(
          orm.eq(schema.workflowJobs.teamId, teamId),
          orm.eq(schema.workflowJobs.name, "invite-team-members"),
        ),
      );
    expect(queued).toHaveLength(1);
    expect(queued[0]!.status).toBe("queued");

    // Earlier tests queue their own invitation mail, so run bounded batches
    // until this job reaches a terminal state rather than assuming one batch
    // claims it.
    const jobStatus = async () => {
      const [row] = await primaryDb
        .select({ status: schema.workflowJobs.status })
        .from(schema.workflowJobs)
        .where(orm.eq(schema.workflowJobs.id, queued[0]!.id));
      return row?.status;
    };

    let status = await jobStatus();
    for (let round = 0; round < 10 && status === "queued"; round += 1) {
      await runWorkflowBatchOnce();
      status = await jobStatus();
      if (status === "queued") await Bun.sleep(25);
    }
    expect(status).toBe("succeeded");

    // The captured message carries the configured sender and the app link.
    const captured = await readMail(inviteeEmail);
    expect(captured.from).toBe(process.env.AUTH_EMAIL_FROM);
    expect(captured.subject).toContain("invited you");
    expect(captured.html).toContain(`${BASE}/teams`);

    const invitee = await signUpWithEmail(
      inviteeEmail,
      "Invite Mail Recipient",
    );
    const { cookie } = await verify(invitee);

    const pending = await trpc(cookie, "team.invitesByEmail", null);
    expect(pending.error).toBeNull();
    const invite = (pending.data as { id: string }[])[0];
    expect(invite).toBeTruthy();

    const accepted = await trpc(
      cookie,
      "team.acceptInvite",
      { id: invite!.id },
      "mutation",
    );
    expect(accepted.error).toBeNull();
    expect(await membershipIn(invitee.userId, teamId)).toHaveLength(1);

    // The other invitation belongs to the other address and cannot be spent by
    // the account that just accepted its own.
    const otherInvite = await primaryDb.query.userInvites.findFirst({
      where: orm.eq(schema.userInvites.email, otherEmail),
      columns: { id: true },
    });
    const stolen = await trpc(
      cookie,
      "team.acceptInvite",
      { id: otherInvite!.id },
      "mutation",
    );
    expect(stolen.data).toBeNull();
    expect(stolen.error).toMatch(/different email/i);
  });

  test("only a new-address verification link can complete an email change", async () => {
    const { signJWT } = await import("better-auth/crypto");
    const account = await signUpAndVerify("request-type");
    const secret = process.env.BETTER_AUTH_SECRET!;
    const linkFor = async (updateTo: string, requestType?: string) =>
      `/api/auth/verify-email?token=${await signJWT(
        {
          email: account.email,
          updateTo,
          userId: account.userId,
          ...(requestType ? { requestType } : {}),
        },
        secret,
      )}`;

    // Correctly bound to the account, but not a new-address verification:
    // neither may move the address without the new mailbox confirming it.
    for (const requestType of ["change-email-confirmation", undefined]) {
      const target = `request-type-${crypto.randomUUID()}@example.test`;
      const response = await get(await linkFor(target, requestType));

      expect(response.status).toBe(401);
      expect(await userByEmail(target)).toBeUndefined();
      expect((await userByEmail(account.email))?.id).toBe(account.userId);
    }

    // The same binding with the verification kind completes, so the refusals
    // above come from the request type alone.
    const target = `request-type-${crypto.randomUUID()}@example.test`;
    expect(
      (await get(await linkFor(target, "change-email-verification"))).status,
    ).toBe(200);
    expect((await userByEmail(target))?.id).toBe(account.userId);
  });

  test("a reused email-change link cannot redirect off-site through its callback", async () => {
    const { signJWT } = await import("better-auth/crypto");
    const account = await signUpAndVerify("callback-redirect");
    const target = `callback-redirect-${crypto.randomUUID()}@example.test`;
    const link = `/api/auth/verify-email?token=${await signJWT(
      {
        email: account.email,
        updateTo: target,
        userId: account.userId,
        requestType: "change-email-verification",
      },
      process.env.BETTER_AUTH_SECRET!,
    )}`;

    expect((await get(link)).status).toBe(200);
    expect((await userByEmail(target))?.id).toBe(account.userId);

    for (const callbackURL of ["/\\evil.com", "/\\\t/evil.com"]) {
      const response = await get(
        `${link}&callbackURL=${encodeURIComponent(callbackURL)}`,
      );

      expect(response.status).toBe(403);
      expect(response.headers.get("location")).toBeNull();
    }

    const settings = await get(`${link}&callbackURL=%2Fsettings`);
    expect(settings.status).toBe(302);
    const location = new URL(settings.headers.get("location")!);
    expect(location.origin).toBe(new URL(BASE).origin);
    expect(location.pathname).toBe("/settings");
    expect(location.searchParams.get("error")).toBe("INVALID_TOKEN");
  });

  test("an old email-change link cannot rebind a later account at the same address", async () => {
    const original = await signUpAndVerify("token-subject");
    const firstTarget = `token-first-${crypto.randomUUID()}@example.test`;
    const staleTarget = `token-stale-${crypto.randomUUID()}@example.test`;

    expect(
      (
        await post(
          "/api/auth/change-email",
          { newEmail: firstTarget },
          original.cookie,
        )
      ).status,
    ).toBe(200);
    const firstMail = await readMail(firstTarget);

    expect(
      (
        await post(
          "/api/auth/change-email",
          { newEmail: staleTarget },
          original.cookie,
        )
      ).status,
    ).toBe(200);
    const staleMail = await readMail(staleTarget);

    // Completing the first change releases the original address.
    const firstLink = new URL(firstMail.url!);
    expect([200, 302]).toContain(
      (await get(firstLink.pathname + firstLink.search)).status,
    );
    expect((await userByEmail(firstTarget))?.id).toBe(original.userId);

    // A different account registers and verifies the released address.
    const victim = await signUpWithEmail(
      original.email,
      "Different account",
      "DifferentPassword123!",
    );
    const { cookie: victimCookie } = await verify(victim);
    expect(victim.userId).not.toBe(original.userId);
    expect((await userByEmail(original.email))?.id).toBe(victim.userId);

    // The stale link must not move the account that now owns that address.
    const staleLink = new URL(staleMail.url!);
    const staleCompletion = await get(staleLink.pathname + staleLink.search);
    expect([302, 401]).toContain(staleCompletion.status);
    expect(await userByEmail(staleTarget)).toBeUndefined();
    expect((await userByEmail(original.email))?.id).toBe(victim.userId);
    expect((await userByEmail(firstTarget))?.id).toBe(original.userId);

    const victimSession = await get("/api/auth/get-session", {
      cookie: victimCookie,
    });
    const victimBody = (await victimSession.json()) as {
      user?: { email?: string };
    } | null;
    expect(victimBody?.user?.email).toBe(original.email);
  });

  test("a stale signup verification link cannot verify a different account at the same address", async () => {
    const first = await signUpAndVerify("signup-binding");
    const movedTo = `binding-moved-${crypto.randomUUID()}@example.test`;

    expect(
      (
        await post(
          "/api/auth/change-email",
          { newEmail: movedTo },
          first.cookie,
        )
      ).status,
    ).toBe(200);
    const changeMail = await readMail(movedTo);
    const changeLink = new URL(changeMail.url!);
    expect([200, 302]).toContain(
      (await get(changeLink.pathname + changeLink.search)).status,
    );

    // A different account now holds the released address and is unverified.
    const second = await signUpWithEmail(
      first.email,
      "Second account",
      "SecondPassword123!",
    );
    expect(first.userId).not.toBe(second.userId);
    expect((await userByEmail(first.email))?.emailVerified).toBe(false);

    // The first account's old signup link must not verify the second account.
    const staleSignup = new URL(first.verificationUrl);
    const staleAttempt = await get(staleSignup.pathname + staleSignup.search);
    expect([302, 401]).toContain(staleAttempt.status);
    expect((await userByEmail(first.email))?.emailVerified).toBe(false);

    // The second account's own link still completes normally.
    const ownLink = new URL(second.verificationUrl);
    expect([200, 302]).toContain(
      (await get(ownLink.pathname + ownLink.search)).status,
    );
    expect((await userByEmail(first.email))?.emailVerified).toBe(true);
  });

  test("a revocation failure after the email change cannot leave a live session", async () => {
    const account = await signUpAndVerify("second-revoke");
    const newEmail = `second-revoke-${crypto.randomUUID()}@example.test`;
    expect(
      (await post("/api/auth/change-email", { newEmail }, account.cookie))
        .status,
    ).toBe(200);
    const mail = await readMail(newEmail);
    const link = new URL(mail.url!);

    // Fail only the second revocation statement, the boundary root reproduced.
    await primaryDb.execute(
      orm.sql.raw("CREATE SEQUENCE identity_revoke_calls"),
    );
    await primaryDb.execute(
      orm.sql.raw(
        "CREATE FUNCTION identity_fail_second_revoke() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF nextval('identity_revoke_calls') = 2 THEN RAISE EXCEPTION 'injected second revocation failure'; END IF; RETURN NULL; END $$",
      ),
    );
    await primaryDb.execute(
      orm.sql.raw(
        "CREATE TRIGGER identity_fail_second_revoke BEFORE DELETE ON auth_sessions FOR EACH STATEMENT EXECUTE FUNCTION identity_fail_second_revoke()",
      ),
    );

    let completed: Response;
    try {
      completed = await get(link.pathname + link.search);
    } finally {
      await primaryDb.execute(
        orm.sql.raw(
          "DROP TRIGGER IF EXISTS identity_fail_second_revoke ON auth_sessions",
        ),
      );
      await primaryDb.execute(
        orm.sql.raw("DROP FUNCTION IF EXISTS identity_fail_second_revoke()"),
      );
      await primaryDb.execute(
        orm.sql.raw("DROP SEQUENCE IF EXISTS identity_revoke_calls"),
      );
    }

    expect([200, 302]).toContain(completed.status);
    expect((await userByEmail(newEmail))?.id).toBe(account.userId);
    // The completion is atomic and never issues its own session.
    expect(completed.headers.getSetCookie()).toHaveLength(0);

    const oldSession = await get("/api/auth/get-session", {
      cookie: account.cookie,
    });
    expect(await oldSession.json()).toBeNull();
  });

  test("an address already in use cannot be taken over", async () => {
    const first = await signUpAndVerify("email-taken-first");
    const second = await signUpAndVerify("email-taken-second");

    const attempt = await post(
      "/api/auth/change-email",
      { newEmail: first.email },
      second.cookie,
    );
    expect(attempt.status).toBe(200);

    // The response is deliberately non-enumerating: nothing changes, and no
    // verification message is sent to the address that already has an owner.
    expect((await userByEmail(second.email))?.id).toBe(second.userId);
    expect((await userByEmail(first.email))?.id).toBe(first.userId);
  });

  test("password reset revokes sessions, preserves membership and keeps the old password dead", async () => {
    const account = await signUpAndVerify("recovery");
    const membershipBefore = await membershipRows(account.userId);

    // A second live session that must not survive the reset.
    const secondSignIn = await signIn(account.email, account.password);
    expect(secondSignIn.status).toBe(200);
    const secondCookie = sessionCookie(secondSignIn);

    const requested = await post("/api/auth/request-password-reset", {
      email: account.email,
      redirectTo: "/reset-password",
    });
    expect(requested.status).toBe(200);

    const resetMail = await readMail(account.email);
    expect(resetMail.subject).toMatch(/reset/i);
    const resetLink = new URL(resetMail.url!);

    const followed = await get(resetLink.pathname + resetLink.search);
    expect(followed.status).toBe(302);
    const token = new URL(
      followed.headers.get("location")!,
      BASE,
    ).searchParams.get("token");
    expect(token).toBeTruthy();

    const newPassword = "NewPassword456!";
    const reset = await post("/api/auth/reset-password", {
      newPassword,
      token,
    });
    expect(reset.status).toBe(200);

    for (const cookie of [account.cookie, secondCookie]) {
      const session = await get("/api/auth/get-session", { cookie });
      expect(await session.json()).toBeNull();
    }

    const oldPassword = await signIn(account.email, account.password);
    expect(oldPassword.status).toBe(401);

    const newPasswordSignIn = await signIn(account.email, newPassword);
    expect(newPasswordSignIn.status).toBe(200);

    const membershipAfter = await membershipRows(account.userId);
    expect(membershipAfter).toEqual(membershipBefore);
  });

  test("change-password keeps the current session, revokes the others and preserves membership", async () => {
    const account = await signUpAndVerify("password-change");
    const membershipBefore = await membershipRows(account.userId);

    const otherSignIn = await signIn(account.email, account.password);
    const otherCookie = sessionCookie(otherSignIn);

    const newPassword = "ChangedPassword789!";
    const changed = await post(
      "/api/auth/change-password",
      {
        currentPassword: account.password,
        newPassword,
        revokeOtherSessions: true,
      },
      account.cookie,
    );
    expect(changed.status).toBe(200);

    // `revokeOtherSessions` ends every session and issues exactly one fresh
    // session for the caller, so the current cookie is rotated.
    const rotatedCookie = sessionCookie(changed);
    const currentSession = await get("/api/auth/get-session", {
      cookie: rotatedCookie,
    });
    const currentBody = (await currentSession.json()) as {
      user?: { email?: string };
    } | null;
    expect(currentBody?.user?.email).toBe(account.email);

    const staleCookie = await get("/api/auth/get-session", {
      cookie: account.cookie,
    });
    expect(await staleCookie.json()).toBeNull();

    const revoked = await get("/api/auth/get-session", { cookie: otherCookie });
    expect(await revoked.json()).toBeNull();

    const signedIn = await signIn(account.email, newPassword);
    expect(signedIn.status).toBe(200);
    expect(await membershipRows(account.userId)).toEqual(membershipBefore);
  });

  test("no identity message reached an SMTP server during the journey", () => {
    expect(smtpTrap.connections).toBe(0);
  });
});
