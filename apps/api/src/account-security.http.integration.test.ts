/**
 * Real HTTP account-security checks for roadmap issue #49: second factor,
 * recovery codes, session review/revocation, recovery and rate limits.
 *
 * Everything runs through Better Auth's own handler (the one the dashboard
 * mounts at `/api/auth/*`) and the product tRPC/REST routers. Rate limiting is
 * enforced (`AUTH_RATE_LIMIT=enforce`); each request carries its own
 * documentation-range client address unless a test pins one, so only the
 * rate-limit tests share a budget. Mail lands in the explicit local sink and
 * SMTP points at a loopback trap that must receive no connection.
 *
 *   cd apps/api && ACCOUNT_SECURITY_TEST_DATABASE_URL=postgresql://invoicewise:invoicewise@localhost:5432/invoicewise_identity_test \
 *     bun test src/account-security.http.integration.test.ts
 */
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrimaryDatabase } from "@invoicewise/db/client";
import type { resetAccountSecondFactor as ResetAccountSecondFactor } from "@invoicewise/db/queries";
import { type SmtpTrap, startSmtpTrap } from "@invoicewise/utils/smtp-trap";

const testDatabaseUrl = process.env.ACCOUNT_SECURITY_TEST_DATABASE_URL;
const PORT = Number(process.env.ACCOUNT_SECURITY_TEST_PORT ?? 31784);
const BASE = `http://localhost:${PORT}`;

const suite = testDatabaseUrl ? describe : describe.skip;

// Each password check is a cost-12 bcrypt, and the rate-limit test makes
// dozens of them, which outlasts bun's 5s default on a loaded machine.
setDefaultTimeout(60_000);

/** RFC 4648 base32 (no padding), as used in `otpauth://` secrets. */
function base32Decode(value: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let buffer = 0;
  const bytes: number[] = [];

  for (const char of value.replace(/=+$/, "").toUpperCase()) {
    buffer = (buffer << 5) | alphabet.indexOf(char);
    bits += 5;

    if (bits >= 8) {
      bytes.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

/** RFC 6238 TOTP (SHA-1, 6 digits, 30s), what an authenticator app shows. */
function totp(secret: string, at = Date.now()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const digest = createHmac("sha1", base32Decode(secret))
    .update(counter)
    .digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const code = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;

  return code.toString().padStart(6, "0");
}

/**
 * A random documentation-range IPv6 client in its own /64 (Better Auth groups
 * IPv6 clients by subnet), so each request gets its own rate-limit budget.
 */
const randomClientIp = () => {
  const group = () => Math.floor(Math.random() * 0xffff).toString(16);
  return `2001:db8:${group()}:${group()}::1`;
};

type Jar = Map<string, string>;

suite("account security over real HTTP", () => {
  let primaryDb: PrimaryDatabase;
  let schema: typeof import("@invoicewise/db/schema");
  let orm: typeof import("drizzle-orm");
  let superjson: typeof import("superjson").default;
  let resetAccountSecondFactor: typeof ResetAccountSecondFactor;
  let server: ReturnType<typeof Bun.serve>;
  let mailSinkDir: string;
  let mailSinkPath: string;
  let smtpTrap: SmtpTrap;

  const created = {
    userIds: [] as string[],
    teamIds: [] as string[],
  };

  /** Cookie jar: applies every Set-Cookie, dropping expired ones. */
  const absorb = (response: Response, jar: Jar = new Map()) => {
    for (const header of response.headers.getSetCookie()) {
      const [pair, ...attributes] = header.split(";");
      const index = pair!.indexOf("=");
      const name = pair!.slice(0, index).trim();
      const value = pair!.slice(index + 1).trim();
      const expired = attributes.some((attribute) =>
        /^\s*max-age=0\s*$/i.test(attribute),
      );

      if (expired || value === "") {
        jar.delete(name);
      } else {
        jar.set(name, value);
      }
    }

    return jar;
  };

  const cookieHeader = (jar: Jar) =>
    [...jar].map(([name, value]) => `${name}=${value}`).join("; ");

  const sessionTokenOf = (jar: Jar) => {
    const entry = [...jar].find(([name]) => name.endsWith("session_token"));

    if (!entry) {
      throw new Error("No session cookie in the jar");
    }

    return decodeURIComponent(entry[1]);
  };

  const request = (
    method: "GET" | "POST",
    path: string,
    options: { body?: unknown; jar?: Jar; ip?: string; headers?: object } = {},
  ) =>
    fetch(`${BASE}${path}`, {
      method,
      redirect: "manual",
      headers: {
        origin: BASE,
        "x-forwarded-for": options.ip ?? randomClientIp(),
        ...(options.body !== undefined
          ? { "content-type": "application/json" }
          : {}),
        ...(options.jar ? { cookie: cookieHeader(options.jar) } : {}),
        ...options.headers,
      },
      body:
        options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });

  const post = (path: string, body: unknown, jar?: Jar, ip?: string) =>
    request("POST", `/api/auth${path}`, { body, jar, ip });

  const getSession = async (jar: Jar) =>
    (await (await request("GET", "/api/auth/get-session", { jar })).json()) as {
      user: { id: string; twoFactorEnabled?: boolean };
      session: { token: string };
    } | null;

  const trpcQuery = async (jar: Jar, path: string, input: unknown = null) => {
    const serialized = JSON.stringify(superjson.serialize(input));
    const response = await request(
      "GET",
      `/trpc/${path}?input=${encodeURIComponent(serialized)}`,
      { jar },
    );
    const parsed = (await response.json()) as any;

    return {
      status: response.status,
      data: parsed?.result
        ? (superjson.deserialize(parsed.result.data) as any)
        : null,
    };
  };

  type CapturedMail = { to: string; subject: string; url?: string };

  const readMail = async (to: string, after = 0) => {
    const deadline = Date.now() + 5_000;

    while (Date.now() < deadline) {
      const content = await readFile(mailSinkPath, "utf8").catch(() => "");
      const matches = content
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as CapturedMail)
        .filter((message) => message.to === to);

      if (matches.length > after) {
        return matches[matches.length - 1]!;
      }

      await Bun.sleep(50);
    }

    throw new Error(`No captured mail for ${to}`);
  };

  const mailCount = async (to: string) => {
    const content = await readFile(mailSinkPath, "utf8").catch(() => "");

    return content
      .split("\n")
      .filter(Boolean)
      .filter((line) => (JSON.parse(line) as CapturedMail).to === to).length;
  };

  const userRow = (email: string) =>
    primaryDb.query.users.findFirst({
      where: orm.eq(schema.users.email, email),
      columns: { id: true, teamId: true, twoFactorEnabled: true },
    });

  const membershipRows = (userId: string) =>
    primaryDb
      .select({
        teamId: schema.usersOnTeam.teamId,
        role: schema.usersOnTeam.role,
      })
      .from(schema.usersOnTeam)
      .where(orm.eq(schema.usersOnTeam.userId, userId));

  /** Signup plus the verification link, which issues the first session. */
  const createAccount = async (label: string) => {
    const email = `${label}-${crypto.randomUUID()}@example.test`;
    const password = "Password123!";
    const signUp = await post("/sign-up/email", {
      email,
      password,
      name: label,
    });
    expect(signUp.status).toBe(200);

    const user = await userRow(email);
    created.userIds.push(user!.id);
    if (user!.teamId) created.teamIds.push(user!.teamId);

    const link = new URL((await readMail(email)).url!);
    const verified = await request("GET", link.pathname + link.search);
    expect([200, 302]).toContain(verified.status);

    return {
      email,
      password,
      userId: user!.id,
      teamId: user!.teamId!,
      jar: absorb(verified),
    };
  };

  /** Password step of sign-in; returns the response and the resulting jar. */
  const passwordStep = async (email: string, password: string, ip?: string) => {
    const response = await post(
      "/sign-in/email",
      { email, password },
      undefined,
      ip,
    );
    const body = (await response
      .clone()
      .json()
      .catch(() => null)) as {
      twoFactorRedirect?: boolean;
    } | null;

    return { response, body, jar: absorb(response) };
  };

  /** Full sign-in for an enrolled account using the authenticator. */
  const signInWithTotp = async (
    email: string,
    password: string,
    secret: string,
  ) => {
    const step = await passwordStep(email, password);
    expect(step.response.status).toBe(200);
    expect(step.body?.twoFactorRedirect).toBe(true);

    const verified = await post(
      "/two-factor/verify-totp",
      { code: totp(secret) },
      step.jar,
    );
    expect(verified.status).toBe(200);

    return absorb(verified, step.jar);
  };

  /** Enrolls the authenticator for a signed-in account. */
  const enroll = async (account: { password: string; jar: Jar }) => {
    const enabled = await post(
      "/two-factor/enable",
      { password: account.password },
      account.jar,
    );
    expect(enabled.status).toBe(200);
    const { totpURI, backupCodes } = (await enabled.json()) as {
      totpURI: string;
      backupCodes: string[];
    };
    const secret = new URL(totpURI).searchParams.get("secret")!;

    const confirmed = await post(
      "/two-factor/verify-totp",
      { code: totp(secret) },
      account.jar,
    );
    expect(confirmed.status).toBe(200);
    absorb(confirmed, account.jar);

    return { secret, backupCodes };
  };

  beforeAll(async () => {
    if (!testDatabaseUrl) return;

    mailSinkDir = await mkdtemp(join(tmpdir(), "account-security-mail-"));
    mailSinkPath = join(mailSinkDir, "mail.jsonl");
    smtpTrap = await startSmtpTrap();

    process.env.DATABASE_PRIMARY_URL = testDatabaseUrl;
    process.env.BETTER_AUTH_SECRET ??= "account-security-integration-secret";
    process.env.BETTER_AUTH_URL = BASE;
    process.env.NEXT_PUBLIC_URL = BASE;
    process.env.SMTP_HOST = smtpTrap.host;
    process.env.SMTP_PORT = String(smtpTrap.port);
    process.env.SMTP_USER = "identity@invoicewise.test";
    process.env.SMTP_PASS = "synthetic-account-security-smtp-password";
    process.env.AUTH_EMAIL_FROM = "InvoiceWise <auth@invoicewise.test>";
    process.env.AUTH_MAIL_SINK_PATH = mailSinkPath;
    process.env.AUTH_RATE_LIMIT = "enforce";
    process.env.POLAR_ACCESS_TOKEN ??= "polar_account_security_test";
    process.env.REDIS_URL ??= "redis://localhost:6379";
    process.env.MIDDAY_ENCRYPTION_KEY ??=
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    process.env.NODE_ENV = "test";

    const client = await import("@invoicewise/db/client");
    schema = await import("@invoicewise/db/schema");
    orm = await import("drizzle-orm");
    superjson = (await import("superjson")).default;
    ({ resetAccountSecondFactor } = await import("@invoicewise/db/queries"));
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

  test("proof: enroll, two sessions, revoke one, recover with a single-use code, revoked session stays invalid", async () => {
    const account = await createAccount("mfa-proof");
    const membershipBefore = await membershipRows(account.userId);

    // Enrollment needs the password; a wrong one changes nothing.
    const wrongPassword = await post(
      "/two-factor/enable",
      { password: "not-it" },
      account.jar,
    );
    expect(wrongPassword.status).toBe(400);

    const enabled = await post(
      "/two-factor/enable",
      { password: account.password },
      account.jar,
    );
    expect(enabled.status).toBe(200);
    const { totpURI, backupCodes } = (await enabled.json()) as {
      totpURI: string;
      backupCodes: string[];
    };
    expect(backupCodes).toHaveLength(10);
    const secret = new URL(totpURI).searchParams.get("secret")!;

    // Not required until an authenticator code proves the app was set up.
    expect((await userRow(account.email))!.twoFactorEnabled).toBe(false);
    const badCode = await post(
      "/two-factor/verify-totp",
      { code: "000000" },
      account.jar,
    );
    expect(badCode.status).toBe(401);
    expect((await userRow(account.email))!.twoFactorEnabled).toBe(false);

    const confirmed = await post(
      "/two-factor/verify-totp",
      { code: totp(secret) },
      account.jar,
    );
    expect(confirmed.status).toBe(200);
    absorb(confirmed, account.jar);
    expect((await userRow(account.email))!.twoFactorEnabled).toBe(true);
    expect((await getSession(account.jar))?.user.twoFactorEnabled).toBe(true);

    // Secrets and recovery codes are stored encrypted, never in the clear.
    const [stored] = await primaryDb
      .select()
      .from(schema.authTwoFactors)
      .where(orm.eq(schema.authTwoFactors.userId, account.userId));
    expect(stored!.secret).not.toContain(base32Decode(secret).toString());
    for (const code of backupCodes) {
      expect(stored!.backupCodes).not.toContain(code);
    }

    // The password alone no longer issues a session.
    const passwordOnly = await passwordStep(account.email, account.password);
    expect(passwordOnly.body?.twoFactorRedirect).toBe(true);
    expect(
      [...passwordOnly.jar.keys()].some((name) =>
        name.endsWith("session_token"),
      ),
    ).toBe(false);
    expect(await getSession(passwordOnly.jar)).toBeNull();

    // Two concurrent sessions, each through the second factor.
    const sessionA = await signInWithTotp(
      account.email,
      account.password,
      secret,
    );
    const sessionB = await signInWithTotp(
      account.email,
      account.password,
      secret,
    );
    const tokenB = (await getSession(sessionB))!.session.token;

    const listed = await request("GET", "/api/auth/list-sessions", {
      jar: sessionA,
    });
    const tokens = ((await listed.json()) as { token: string }[]).map(
      (s) => s.token,
    );
    expect(tokens).toContain(tokenB);
    expect(tokens).toContain((await getSession(sessionA))!.session.token);

    // Session A revokes session B.
    const revoked = await post("/revoke-session", { token: tokenB }, sessionA);
    expect(revoked.status).toBe(200);
    expect(await getSession(sessionB)).toBeNull();

    // API authentication rejects it too: tRPC by cookie, REST by bearer token.
    expect((await trpcQuery(sessionB, "user.me")).status).toBe(401);
    const bearerB = await request("GET", "/teams", {
      headers: { authorization: `Bearer ${sessionTokenOf(sessionB)}` },
    });
    expect(bearerB.status).toBe(401);
    const bearerA = await request("GET", "/teams", {
      headers: { authorization: `Bearer ${sessionTokenOf(sessionA)}` },
    });
    expect(bearerA.status).toBe(200);

    // Authenticator lost: a single-use recovery code completes sign-in.
    const recoveryCode = backupCodes[0]!;
    const recoveryStep = await passwordStep(account.email, account.password);
    const recovered = await post(
      "/two-factor/verify-backup-code",
      { code: recoveryCode },
      recoveryStep.jar,
    );
    expect(recovered.status).toBe(200);
    const recoveredJar = absorb(recovered, recoveryStep.jar);
    expect((await getSession(recoveredJar))?.user.id).toBe(account.userId);

    // Replaying the used code fails, with or without a pending challenge.
    const replayStep = await passwordStep(account.email, account.password);
    const replay = await post(
      "/two-factor/verify-backup-code",
      { code: recoveryCode },
      replayStep.jar,
    );
    expect(replay.status).toBe(401);
    expect(await getSession(absorb(replay, replayStep.jar))).toBeNull();
    const noChallenge = await post("/two-factor/verify-backup-code", {
      code: backupCodes[1]!,
    });
    expect(noChallenge.status).toBe(401);

    // The revoked session is still invalid after recovery, the recovered and
    // the revoking sessions still work, and roles are unchanged.
    expect(await getSession(sessionB)).toBeNull();
    expect((await trpcQuery(sessionB, "user.me")).status).toBe(401);
    expect((await trpcQuery(recoveredJar, "user.me")).status).toBe(200);
    expect(await getSession(sessionA)).not.toBeNull();
    expect(await membershipRows(account.userId)).toEqual(membershipBefore);
  });

  test("enrollment ends every other session; turning the factor off does too", async () => {
    const account = await createAccount("mfa-enroll-revokes");
    const other = (await passwordStep(account.email, account.password)).jar;
    expect(await getSession(other)).not.toBeNull();

    const { secret } = await enroll(account);
    expect(await getSession(other)).toBeNull();
    expect(await getSession(account.jar)).not.toBeNull();

    const second = await signInWithTotp(
      account.email,
      account.password,
      secret,
    );
    const disabled = await post(
      "/two-factor/disable",
      { password: account.password },
      account.jar,
    );
    expect(disabled.status).toBe(200);
    absorb(disabled, account.jar);
    expect(await getSession(second)).toBeNull();
    expect((await getSession(account.jar))?.user.twoFactorEnabled).toBe(false);

    // Re-enroll issues a new secret and new codes; the old secret is dead.
    const reenrolled = await enroll(account);
    expect(reenrolled.secret).not.toBe(secret);
    const step = await passwordStep(account.email, account.password);
    const oldSecret = await post(
      "/two-factor/verify-totp",
      { code: totp(secret) },
      step.jar,
    );
    expect(oldSecret.status).toBe(401);
    const newSecret = await post(
      "/two-factor/verify-totp",
      { code: totp(reenrolled.secret) },
      step.jar,
    );
    expect(newSecret.status).toBe(200);
  });

  test("regenerating recovery codes invalidates the previous set", async () => {
    const account = await createAccount("mfa-regenerate");
    const { backupCodes: first } = await enroll(account);

    const regenerated = await post(
      "/two-factor/generate-backup-codes",
      { password: account.password },
      account.jar,
    );
    expect(regenerated.status).toBe(200);
    const { backupCodes: second } = (await regenerated.json()) as {
      backupCodes: string[];
    };
    expect(second).toHaveLength(10);

    const oldStep = await passwordStep(account.email, account.password);
    const old = await post(
      "/two-factor/verify-backup-code",
      { code: first[0]! },
      oldStep.jar,
    );
    expect(old.status).toBe(401);

    const newStep = await passwordStep(account.email, account.password);
    const fresh = await post(
      "/two-factor/verify-backup-code",
      { code: second[0]! },
      newStep.jar,
    );
    expect(fresh.status).toBe(200);
  });

  test("second-factor changes need a recent sign-in, and trusted devices are refused", async () => {
    const account = await createAccount("mfa-stale");
    const { secret } = await enroll(account);
    const token = (await getSession(account.jar))!.session.token;

    // Age the session past the one-day recent-authentication window.
    await primaryDb
      .update(schema.authSessions)
      .set({ createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) })
      .where(orm.eq(schema.authSessions.token, token));

    for (const path of [
      "/two-factor/disable",
      "/two-factor/generate-backup-codes",
    ]) {
      const response = await post(
        path,
        { password: account.password },
        account.jar,
      );
      expect(response.status).toBe(403);
    }
    expect((await userRow(account.email))!.twoFactorEnabled).toBe(true);

    const step = await passwordStep(account.email, account.password);
    const trusted = await post(
      "/two-factor/verify-totp",
      { code: totp(secret), trustDevice: true },
      step.jar,
    );
    expect(trusted.status).toBe(400);
    expect(
      trusted.headers.getSetCookie().some((c) => c.includes("trust_device")),
    ).toBe(false);
  });

  test("lost second factor: operator reset keeps workspace roles and ends every session", async () => {
    const owner = await createAccount("mfa-lost-owner");
    const member = await createAccount("mfa-lost-member");
    await primaryDb.insert(schema.usersOnTeam).values({
      userId: member.userId,
      teamId: owner.teamId,
      role: "member",
    });
    const { secret } = await enroll(member);
    const memberSession = await signInWithTotp(
      member.email,
      member.password,
      secret,
    );
    const rolesBefore = await membershipRows(member.userId);

    const result = await resetAccountSecondFactor(primaryDb, member.userId);
    expect(result).toMatchObject({
      userId: member.userId,
      removedSecondFactor: true,
    });
    expect(result!.revokedSessions).toBeGreaterThanOrEqual(2);
    expect(await getSession(memberSession)).toBeNull();
    expect(await getSession(member.jar)).toBeNull();

    // Password sign-in works again, with exactly the same roles: recovery
    // never grants the owner's role or any new workspace.
    const signedIn = await passwordStep(member.email, member.password);
    expect(signedIn.body?.twoFactorRedirect).toBeUndefined();
    expect(await getSession(signedIn.jar)).not.toBeNull();
    expect(await membershipRows(member.userId)).toEqual(rolesBefore);
    expect(rolesBefore.find((row) => row.teamId === owner.teamId)?.role).toBe(
      "member",
    );
  });

  test("owners see members' second-factor state; other members do not", async () => {
    const owner = await createAccount("mfa-state-owner");
    const member = await createAccount("mfa-state-member");
    await primaryDb.insert(schema.usersOnTeam).values({
      userId: member.userId,
      teamId: owner.teamId,
      role: "member",
    });
    await enroll(member);

    const asOwner = await trpcQuery(owner.jar, "team.members");
    expect(asOwner.status).toBe(200);
    const byId = new Map(
      (
        asOwner.data as {
          user: { id: string; twoFactorEnabled: boolean | null };
        }[]
      ).map((row) => [row.user.id, row.user.twoFactorEnabled]),
    );
    expect(byId.get(member.userId)).toBe(true);
    expect(byId.get(owner.userId)).toBe(false);

    const switched = await post(
      "/organization/set-active",
      { organizationId: owner.teamId },
      member.jar,
    );
    expect(switched.status).toBe(200);
    absorb(switched, member.jar);
    const asMember = await trpcQuery(member.jar, "team.members");
    expect(asMember.status).toBe(200);
    for (const row of asMember.data as {
      user: { twoFactorEnabled: unknown };
    }[]) {
      expect(row.user.twoFactorEnabled).toBeNull();
    }
  });

  test("a password change ends the other sessions even when not asked to", async () => {
    const account = await createAccount("password-compromise");
    const other = (await passwordStep(account.email, account.password)).jar;

    const changed = await post(
      "/change-password",
      {
        currentPassword: account.password,
        newPassword: "Rotated-Password-456!",
      },
      account.jar,
    );
    expect(changed.status).toBe(200);
    absorb(changed, account.jar);
    expect(await getSession(other)).toBeNull();
    expect(await getSession(account.jar)).not.toBeNull();
  });

  test("a reset link works once and not after it expires", async () => {
    const account = await createAccount("reset-expiry");

    const requestReset = async () => {
      const before = await mailCount(account.email);
      const requested = await post("/request-password-reset", {
        email: account.email,
        redirectTo: "/reset-password",
      });
      expect(requested.status).toBe(200);
      const link = new URL((await readMail(account.email, before)).url!);
      const followed = await request("GET", link.pathname + link.search);
      return new URL(followed.headers.get("location")!, BASE).searchParams.get(
        "token",
      )!;
    };

    const expiredToken = await requestReset();
    await primaryDb
      .update(schema.authVerifications)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(
        orm.eq(
          schema.authVerifications.identifier,
          `reset-password:${expiredToken}`,
        ),
      );
    const expired = await post("/reset-password", {
      newPassword: "Expired-Password-1!",
      token: expiredToken,
    });
    expect(expired.status).toBe(400);
    // An expired link neither changes the password nor ends sessions.
    expect(await getSession(account.jar)).not.toBeNull();

    const token = await requestReset();
    const reset = await post("/reset-password", {
      newPassword: "Fresh-Password-2!",
      token,
    });
    expect(reset.status).toBe(200);
    const replayed = await post("/reset-password", {
      newPassword: "Replay-Password-3!",
      token,
    });
    expect(replayed.status).toBe(400);
    expect(
      (await passwordStep(account.email, "Fresh-Password-2!")).response.status,
    ).toBe(200);
  });

  test("sign-in and second-factor attempts are rate limited per client, without revealing accounts", async () => {
    const account = await createAccount("rate-limit");
    const unknown = `nobody-${crypto.randomUUID()}@example.test`;

    // Unknown address and wrong password are indistinguishable.
    const wrong = await passwordStep(account.email, "Wrong-Password-1!");
    const missing = await passwordStep(unknown, "Wrong-Password-1!");
    expect(wrong.response.status).toBe(missing.response.status);
    expect(await wrong.response.json()).toEqual(await missing.response.json());

    // Reset requests answer the same for known and unknown addresses.
    const knownReset = await post("/request-password-reset", {
      email: account.email,
      redirectTo: "/reset-password",
    });
    const unknownReset = await post("/request-password-reset", {
      email: unknown,
      redirectTo: "/reset-password",
    });
    expect(knownReset.status).toBe(unknownReset.status);
    expect(await knownReset.json()).toEqual(await unknownReset.json());

    const attacker = "203.0.113.77";
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 12; attempt++) {
      statuses.push(
        (await passwordStep(account.email, "Guess-Password-1!", attacker))
          .response.status,
      );
    }
    expect(statuses.slice(0, 10).every((status) => status === 401)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);

    // The correct password from the limited address is still refused, while
    // the account holder elsewhere is unaffected.
    expect(
      (await passwordStep(account.email, account.password, attacker)).response
        .status,
    ).toBe(429);
    expect(
      (await passwordStep(account.email, account.password, "198.51.100.9"))
        .response.status,
    ).toBe(200);

    // Second-factor guesses share a per-client budget too.
    const { secret } = await enroll(account);
    const guesser = "203.0.113.78";
    const step = await passwordStep(
      account.email,
      account.password,
      "198.51.100.10",
    );
    const codeStatuses: number[] = [];
    for (let attempt = 0; attempt < 11; attempt++) {
      codeStatuses.push(
        (
          await post(
            "/two-factor/verify-totp",
            { code: "000000" },
            step.jar,
            guesser,
          )
        ).status,
      );
    }
    expect(codeStatuses).toContain(429);
    expect(secret).toBeTruthy();
  });

  test("only budgeted paths write rate-limit rows, and expired rows are pruned", async () => {
    const { authRateLimits } = schema;
    const rateLimitRowsFor = (ip: string) =>
      primaryDb
        .select({ key: authRateLimits.key, count: authRateLimits.count })
        .from(authRateLimits)
        .where(orm.like(authRateLimits.key, `${ip}|%`));
    const account = await createAccount("rate-limit-rows");

    const reader = "198.51.100.41";
    for (let poll = 0; poll < 3; poll++) {
      const session = await request("GET", "/api/auth/get-session", {
        jar: account.jar,
        ip: reader,
      });
      expect(session.status).toBe(200);
    }
    expect(await rateLimitRowsFor(reader)).toEqual([]);

    const now = Date.now();
    const abandoned = "198.51.100.42";
    const returning = "198.51.100.43";
    await primaryDb.insert(authRateLimits).values([
      {
        key: `${abandoned}|/sign-up/email`,
        count: 5,
        lastRequest: now - 60 * 60 * 1000,
      },
      {
        key: `${returning}|/sign-in/email`,
        count: 10,
        lastRequest: now - 61 * 1000,
      },
    ]);

    const signedIn = await passwordStep(
      account.email,
      account.password,
      returning,
    );
    expect(signedIn.response.status).toBe(200);
    expect(await rateLimitRowsFor(returning)).toEqual([
      { key: `${returning}|/sign-in/email`, count: 1 },
    ]);
    expect(await rateLimitRowsFor(abandoned)).toEqual([]);
  });

  test("no account-security message reached an SMTP server", () => {
    expect(smtpTrap.connections).toBe(0);
  });
});
