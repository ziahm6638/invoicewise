import {
  assertTransactionalMailConfigured,
  deliverTransactionalMail,
} from "@api/services/auth-mail";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { db, primaryDb } from "@invoicewise/db/client";
import { ensurePersonalWorkspace } from "@invoicewise/db/queries/teams";
import {
  authAccounts,
  authSessions,
  authVerifications,
  teams,
  userInvites,
  users,
  usersOnTeam,
} from "@invoicewise/db/schema";
import bcrypt from "bcryptjs";
import { betterAuth } from "better-auth";
import {
  APIError,
  type AuthMiddleware,
  createAuthMiddleware,
  getSessionFromCtx,
} from "better-auth/api";
import { signJWT, verifyJWT } from "better-auth/crypto";
import { bearer, organization } from "better-auth/plugins";
import { and, eq, ne } from "drizzle-orm";

const baseURL =
  process.env.BETTER_AUTH_URL ??
  process.env.NEXT_PUBLIC_URL ??
  "http://localhost:3001";

const localAuthSecret =
  "invoicewise-local-development-auth-secret-change-in-production";
const configuredAuthSecret =
  process.env.BETTER_AUTH_SECRET ??
  (process.env.NODE_ENV === "production" ? undefined : localAuthSecret);
const cookieDomain = process.env.BETTER_AUTH_COOKIE_DOMAIN;

if (!configuredAuthSecret) {
  throw new Error("BETTER_AUTH_SECRET is required in production");
}

const authSecret: string = configuredAuthSecret;

// Verification, invitation and reset links carry bearer tokens, so a
// production process refuses to start rather than fall back to printing them.
if (process.env.NODE_ENV === "production") {
  assertTransactionalMailConfigured();
}

/**
 * Native organization endpoints that mutate membership, roles or invitations.
 * They are disabled in favour of the secured workspace flows; see the `hooks`
 * comment on the `betterAuth` options below.
 */
const NATIVE_MEMBERSHIP_MUTATIONS = new Set([
  "/organization/add-member",
  "/organization/remove-member",
  "/organization/update-member-role",
  "/organization/invite-member",
  "/organization/accept-invitation",
  "/organization/reject-invitation",
  "/organization/cancel-invitation",
  "/organization/leave",
  "/organization/update",
]);

/** Recent-authentication window for sensitive identity operations. */
const SESSION_FRESH_AGE_SECONDS = 60 * 60 * 24;

/**
 * Endpoints that need a recent sign-in on top of a valid session.
 *
 * Better Auth's `/change-email` only requires an authoritative session, so the
 * recent-authentication requirement for moving a verified address is enforced
 * here, for every caller of the authoritative flow.
 */
const SENSITIVE_IDENTITY_PATHS = new Set(["/change-email"]);

/** Origins Better Auth may redirect to after an identity flow. */
const trustedOrigins = [
  baseURL,
  ...(process.env.ALLOWED_API_ORIGINS?.split(",").filter(Boolean) ?? []),
];

async function sendAuthEmail(message: {
  to: string;
  subject: string;
  url: string;
}) {
  await deliverTransactionalMail(message);
}

/** Reads the verification token from the request that completed the flow. */
const verificationTokenFromRequest = (request?: Request) => {
  if (!request) {
    return null;
  }

  try {
    return new URL(request.url).searchParams.get("token");
  } catch {
    return null;
  }
};

/** Verification/change-email token payload Better Auth signs for us. */
type IdentityTokenPayload = {
  email?: string;
  updateTo?: string;
  requestType?: string;
  /**
   * Stable issuing account. Better Auth's own payload only carries the mutable
   * email address, which can be released and re-registered by another account;
   * every link we send is re-signed with this claim so completion can bind the
   * capability to the account it was issued for.
   */
  userId?: string;
  exp?: number;
};

/** Context the framework hands to `hooks.before` / `hooks.after`. */
type AuthHookContext = Parameters<AuthMiddleware>[0];

/**
 * The token of the flow that produced this request, from the parsed query when
 * the router has one and from the request URL otherwise.
 */
const identityTokenFromContext = (context: AuthHookContext) => {
  const query = context.query as { token?: unknown } | undefined;

  if (typeof query?.token === "string" && query.token.length > 0) {
    return query.token;
  }

  return verificationTokenFromRequest(context.request);
};

const readIdentityToken = async (token: string | null) =>
  token ? await verifyJWT<IdentityTokenPayload>(token, authSecret) : null;

/**
 * Ends every session for an account. Session rows are the authoritative
 * session record (no cookie cache is configured), so a revoked session is
 * rejected on its next request. Workspace memberships are keyed by user id and
 * are deliberately untouched.
 */
async function revokeAllSessionsForUser(userId: string) {
  await primaryDb.delete(authSessions).where(eq(authSessions.userId, userId));
}

/**
 * Best-effort repair of a missing personal workspace.
 *
 * Better Auth commits the user row before the `user.create.after` hook runs, so
 * a failed provisioning attempt can leave a verified account with no
 * workspace. Signup, verification and sign-in all pass through here; the
 * underlying insert is idempotent and serialized on the user row, so retries
 * and concurrent callbacks settle on exactly one workspace. A failure here is
 * logged and retried on the next supported path rather than surfacing as a
 * failed sign-in.
 */
async function ensureUserHasWorkspace(userId: string) {
  try {
    const [user] = await primaryDb
      .select({
        id: users.id,
        email: users.email,
        fullName: users.fullName,
        teamId: users.teamId,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user || user.teamId) {
      return;
    }

    await ensurePersonalWorkspace(db, {
      userId: user.id,
      email: user.email ?? "",
      name: `${user.fullName ?? user.email ?? "Personal"}'s workspace`,
    });
  } catch (error) {
    console.error(
      "[identity] workspace provisioning repair failed",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Re-signs a verification token with the stable issuing account.
 *
 * Better Auth's own payload identifies the account only by its mutable email
 * address. When that address is released and a different account registers it,
 * a still-valid link would otherwise complete against the wrong account. The
 * capability is therefore re-signed — with the same secret, payload and
 * remaining lifetime Better Auth uses, so its own verification route still
 * accepts it — carrying the account id it was issued for.
 */
async function bindVerificationToken(
  payload: IdentityTokenPayload,
  userId: string,
) {
  const expiresIn = payload.exp
    ? Math.max(1, payload.exp - Math.floor(Date.now() / 1000))
    : 3600;

  return await signJWT({ ...payload, userId }, authSecret, expiresIn);
}

/**
 * Resolves the flow's callback URL against the trusted origins, because
 * short-circuiting the endpoint skips Better Auth's own `originCheck`. Relative
 * paths get no fast path: the URL parser reads `\` as `/` and drops tabs and
 * newlines, so `/\evil.com` would resolve off-site. Such raw values are refused
 * outright and every resolved URL must land on a trusted origin.
 */
function resolveCallbackUrl(
  context: AuthHookContext,
): URL | "untrusted" | null {
  const raw = (context.query as { callbackURL?: unknown } | undefined)
    ?.callbackURL;

  if (typeof raw !== "string" || raw.length === 0) {
    return null;
  }

  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what this guard rejects.
  if (/[\\\s\x00-\x1f\x7f]/.test(raw)) {
    return "untrusted";
  }

  let target: URL;

  try {
    target = new URL(raw, baseURL);
  } catch {
    return "untrusted";
  }

  const trusted = trustedOrigins.some((origin) => {
    try {
      return new URL(origin).origin === target.origin;
    } catch {
      return false;
    }
  });

  return trusted ? target : "untrusted";
}

/** The response a short-circuited verification request returns. */
function verificationResponse(context: AuthHookContext, ok: boolean) {
  const callback = resolveCallbackUrl(context);

  if (callback === "untrusted") {
    return Response.json(
      { status: false, message: "Untrusted callback URL" },
      { status: 403 },
    );
  }

  if (callback) {
    if (!ok) {
      callback.searchParams.set("error", "INVALID_TOKEN");
    }

    return Response.redirect(callback.toString(), 302);
  }

  return ok
    ? Response.json({ status: true, user: null })
    : Response.json(
        { status: false, message: "Invalid verification link" },
        { status: 401 },
      );
}

/**
 * Applies a completed email change.
 *
 * The address write and the session revocation share one transaction, so the
 * sensitive identity change and the end of every previously issued session
 * either both commit or neither does. There is no post-mutation revocation step
 * left to fail, and no new session is issued for the completion itself: the
 * account signs in again with the new address.
 */
async function applyEmailChange(params: {
  userId: string;
  currentEmail: string;
  newEmail: string;
}) {
  return await db.transaction(async (tx) => {
    const [user] = await tx
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.id, params.userId))
      .for("update")
      .limit(1);

    // Re-check the binding under the row lock: a concurrent request may have
    // completed the same or an earlier change in the meantime.
    if (
      !user ||
      (user.email ?? "").toLowerCase() !== params.currentEmail.toLowerCase()
    ) {
      return false;
    }

    const [taken] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, params.newEmail))
      .limit(1);

    if (taken && taken.id !== user.id) {
      return false;
    }

    await tx
      .update(users)
      .set({ email: params.newEmail, emailVerified: true })
      .where(eq(users.id, user.id));

    await tx.delete(authSessions).where(eq(authSessions.userId, user.id));

    return true;
  });
}

/**
 * Handles a verification capability before the framework endpoint runs.
 *
 * Returns a response to short-circuit the request, or null to let Better Auth
 * complete a signup verification itself. Every path rejects a stale or
 * mismatched binding before any identity write, revocation or session issue.
 */
async function handleVerificationCapability(context: AuthHookContext) {
  const payload = await readIdentityToken(identityTokenFromContext(context));

  // An unreadable or expired token is the framework's to reject.
  if (!payload?.email) {
    return null;
  }

  // A capability issued before the stable binding existed can no longer prove
  // which account it belongs to.
  if (!payload.userId) {
    return verificationResponse(context, false);
  }

  const [user] = await primaryDb
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.id, payload.userId))
    .limit(1);

  if (
    !user ||
    (user.email ?? "").toLowerCase() !== payload.email.toLowerCase()
  ) {
    return verificationResponse(context, false);
  }

  if (!payload.updateTo) {
    // Signup verification: the binding holds, so the framework may complete it
    // (and auto-sign-in) exactly as before.
    return null;
  }

  // Only the new-address verification link completes a change. No other
  // change-email kind is issued here (no `sendChangeEmailConfirmation`), and
  // applying one would move the address without the new mailbox confirming it.
  if (payload.requestType !== "change-email-verification") {
    return verificationResponse(context, false);
  }

  const applied = await applyEmailChange({
    userId: user.id,
    currentEmail: payload.email,
    newEmail: payload.updateTo,
  });

  if (!applied) {
    return verificationResponse(context, false);
  }

  return verificationResponse(context, true);
}

/**
 * Revokes the account's sessions before a password reset is applied.
 *
 * Better Auth updates the password hash and deletes sessions afterwards, so a
 * deletion failure would leave the old password gone and old sessions alive.
 * The reset token is the credential here, so revoking first is safe: an invalid
 * or consumed token is ignored and the endpoint still rejects it.
 */
async function revokeSessionsBeforePasswordReset(context: AuthHookContext) {
  const body = context.body as { token?: unknown } | undefined;
  const query = context.query as { token?: unknown } | undefined;
  const token =
    typeof body?.token === "string"
      ? body.token
      : typeof query?.token === "string"
        ? query.token
        : null;

  if (!token) {
    return;
  }

  const [verification] = await primaryDb
    .select({
      value: authVerifications.value,
      expiresAt: authVerifications.expiresAt,
    })
    .from(authVerifications)
    .where(eq(authVerifications.identifier, `reset-password:${token}`))
    .limit(1);

  if (!verification || verification.expiresAt.getTime() <= Date.now()) {
    return;
  }

  await revokeAllSessionsForUser(verification.value);
}

/**
 * Revokes the caller's other sessions before a password change is applied.
 *
 * The current password is verified first so a failed attempt cannot sign the
 * user out of their other devices; the endpoint still performs its own check
 * and keeps the caller's rotated session. If the revocation cannot complete,
 * the request fails before the password changes.
 */
async function revokeOtherSessionsBeforePasswordChange(
  context: AuthHookContext,
) {
  const body = context.body as
    | { revokeOtherSessions?: unknown; currentPassword?: unknown }
    | undefined;

  if (
    body?.revokeOtherSessions !== true ||
    typeof body.currentPassword !== "string"
  ) {
    return;
  }

  // The framework types hooks as middleware but dispatches the endpoint
  // context, which is what session resolution expects.
  const session = await getSessionFromCtx(
    context as unknown as Parameters<typeof getSessionFromCtx>[0],
    { disableCookieCache: true, disableRefresh: true },
  );

  if (!session?.session) {
    return;
  }

  const [account] = await primaryDb
    .select({ password: authAccounts.password })
    .from(authAccounts)
    .where(
      and(
        eq(authAccounts.userId, session.user.id),
        eq(authAccounts.providerId, "credential"),
      ),
    )
    .limit(1);

  if (!account?.password) {
    return;
  }

  if (!(await bcrypt.compare(body.currentPassword, account.password))) {
    return;
  }

  await primaryDb
    .delete(authSessions)
    .where(
      and(
        eq(authSessions.userId, session.user.id),
        ne(authSessions.token, session.session.token),
      ),
    );
}

/**
 * Repairs signup provisioning when a verification request completes.
 *
 * Better Auth short-circuits an already-verified account before
 * `afterEmailVerification`, so the retry a customer actually performs (tapping
 * the link again) must repair here instead.
 */
async function repairWorkspaceAfterVerification(context: AuthHookContext) {
  const payload = await readIdentityToken(identityTokenFromContext(context));

  if (!payload?.userId || payload.updateTo) {
    return;
  }

  await ensureUserHasWorkspace(payload.userId);
}

export const auth = betterAuth({
  appName: "InvoiceWise",
  baseURL,
  secret: authSecret,
  /**
   * The organization plugin exposes a second mutation surface for membership
   * and invitations. Its hooks do not report the acting user for every
   * operation (removing a member only reports the member), so rather than keep
   * a parallel copy of the permission matrix we disable those endpoints and
   * route all membership changes through the secured tRPC team flows, which
   * serialize on the team row and share one permission matrix.
   *
   * Read endpoints and active-workspace switching stay enabled.
   */
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (NATIVE_MEMBERSHIP_MUTATIONS.has(ctx.path)) {
        throw new APIError("FORBIDDEN", {
          message:
            "Membership and invitation changes must go through the workspace API",
        });
      }

      if (SENSITIVE_IDENTITY_PATHS.has(ctx.path)) {
        const session = await getSessionFromCtx(ctx, {
          disableCookieCache: true,
          disableRefresh: true,
        });
        const createdAt = session?.session?.createdAt;

        if (!createdAt) {
          throw new APIError("UNAUTHORIZED", {
            message: "Authentication required",
          });
        }

        if (
          Date.now() - new Date(createdAt).getTime() >=
          SESSION_FRESH_AGE_SECONDS * 1000
        ) {
          throw new APIError("FORBIDDEN", {
            message:
              "Sign in again before changing the email address on this account",
          });
        }
      }

      // Sensitive mutations happen after these revocations. A revocation
      // failure therefore aborts the request with the credential or verified
      // address unchanged, instead of committing a change that leaves old
      // sessions authorized.
      if (ctx.path === "/verify-email") {
        // Binds the capability to its issuing account and completes an email
        // change atomically; a signup verification continues to the framework.
        const capabilityResponse = await handleVerificationCapability(ctx);

        if (capabilityResponse) {
          return capabilityResponse;
        }
      }

      if (ctx.path === "/reset-password") {
        await revokeSessionsBeforePasswordReset(ctx);
      }

      if (ctx.path === "/change-password") {
        await revokeOtherSessionsBeforePasswordChange(ctx);
      }
    }),
    after: createAuthMiddleware(async (ctx) => {
      // Runs for the responses `afterEmailVerification` never sees, including
      // the already-verified short-circuit a retried link hits.
      if (ctx.path === "/verify-email") {
        await repairWorkspaceAfterVerification(ctx);
      }
    }),
  },
  trustedOrigins,
  database: drizzleAdapter(primaryDb, {
    provider: "pg",
    schema: {
      user: users,
      session: authSessions,
      account: authAccounts,
      verification: authVerifications,
      organization: teams,
      member: usersOnTeam,
      invitation: userInvites,
    },
  }),
  advanced: {
    database: {
      generateId: "uuid",
    },
    crossSubDomainCookies: cookieDomain
      ? { enabled: true, domain: cookieDomain }
      : undefined,
  },
  user: {
    fields: {
      name: "fullName",
      image: "avatarUrl",
    },
    /**
     * Changing the verified address is a sensitive identity operation. Better
     * Auth's own `/change-email` endpoint verifies the new address and is the
     * only supported write path; the generic profile endpoints accept no email
     * field at all, and the `hooks.before` guard above requires a recent
     * sign-in (Better Auth's own middleware only requires an authoritative
     * session).
     *
     * `updateEmailWithoutVerification` stays off so an unverified account
     * cannot have its address swapped without confirming the new one, and no
     * `sendChangeEmailConfirmation` is configured so the confirmation goes to
     * the *new* mailbox — an account can still move off a mailbox the user has
     * lost.
     */
    changeEmail: {
      enabled: true,
    },
  },
  session: {
    /**
     * Recent-authentication window for sensitive operations (the value Better
     * Auth defaults to, stated explicitly because the identity policy below
     * depends on it). A session older than this cannot request an email change.
     */
    freshAge: SESSION_FRESH_AGE_SECONDS,
  },
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    maxPasswordLength: 128,
    requireEmailVerification: true,
    revokeSessionsOnPasswordReset: true,
    password: {
      hash: (password) => bcrypt.hash(password, 12),
      verify: ({ hash, password }) => bcrypt.compare(password, hash),
    },
    async sendResetPassword({ user, url }) {
      await sendAuthEmail({
        to: user.email,
        subject: "Reset your InvoiceWise password",
        url,
      });
    },
  },
  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    async sendVerificationEmail({ user, url, token }) {
      // Re-sign with the stable issuing account before the link leaves the
      // system: a link may only ever complete against the account it was
      // issued for, never against whoever holds that address later.
      const payload = await verifyJWT<IdentityTokenPayload>(token, authSecret);
      let link = url;

      if (payload) {
        const boundToken = await bindVerificationToken(payload, user.id);
        const parsed = new URL(url);
        parsed.searchParams.set("token", boundToken);
        link = parsed.toString();
      }

      await sendAuthEmail({
        to: user.email,
        subject: "Verify your InvoiceWise email",
        url: link,
      });
    },
    /**
     * Runs when a signup verification or a completed email change lands.
     *
     * A change-email token never reaches this hook: `handleVerificationCapability`
     * completes it atomically before the endpoint runs, so the identity write and
     * the session revocation cannot be separated. This branch stays as a
     * defence in depth for a framework version that routes a bound change-email
     * token differently, and it deliberately does not swallow a failure.
     *
     * A signup verification repairs a workspace whose creation failed after
     * the user row was already committed, so the session issued by
     * auto-sign-in already points at it.
     */
    async afterEmailVerification(user, request) {
      const payload = await readIdentityToken(
        verificationTokenFromRequest(request),
      );

      const completedEmailChange = Boolean(
        payload?.updateTo ?? payload?.requestType?.startsWith("change-email"),
      );

      if (completedEmailChange) {
        await revokeAllSessionsForUser(user.id);
        return;
      }

      await ensureUserHasWorkspace(user.id);
    },
  },
  databaseHooks: {
    user: {
      create: {
        async after(user) {
          // Provisioning is retried on verification and sign-in, so a failure
          // here must not fail signup and strand the customer behind an
          // "account already exists" retry.
          await ensureUserHasWorkspace(user.id);
        },
      },
    },
    session: {
      create: {
        async before(session) {
          // Supported recovery path: a verified account can never be left
          // without a workspace because sign-in repairs it before the session
          // is created.
          await ensureUserHasWorkspace(session.userId);

          const [user] = await primaryDb
            .select({ teamId: users.teamId })
            .from(users)
            .where(eq(users.id, session.userId))
            .limit(1);

          return {
            data: {
              ...session,
              activeOrganizationId: user?.teamId ?? null,
            },
          };
        },
      },
    },
  },
  plugins: [
    organization({
      allowUserToCreateOrganization: false,
      disableOrganizationDeletion: true,
      requireEmailVerificationOnInvitation: true,
      schema: {
        organization: {
          fields: {
            logo: "logoUrl",
          },
        },
        member: {
          fields: {
            organizationId: "teamId",
          },
        },
        invitation: {
          fields: {
            organizationId: "teamId",
            inviterId: "invitedBy",
          },
        },
      },
      async sendInvitationEmail({ id, email, organization }) {
        await sendAuthEmail({
          to: email,
          subject: `Join ${organization.name} on InvoiceWise`,
          url: `${baseURL}/teams?invitationId=${id}`,
        });
      },
    }),
    bearer({ requireSignature: true }),
  ],
});

export type Session = {
  user: {
    id: string;
    email?: string;
    full_name?: string;
  };
  teamId: string | null;
  /**
   * How the caller authenticated. API keys and OAuth tokens are bound to the
   * workspace they were issued for; only a browser session may act across the
   * workspaces its user belongs to.
   */
  authType?: "session" | "api_key" | "oauth";
  oauth?: {
    applicationId: string;
    clientId?: string | null;
    applicationName?: string | null;
  };
};

export async function getAuthSession(
  requestHeaders: Headers,
): Promise<Session | null> {
  const sessionHeaders = new Headers(requestHeaders);

  if (sessionHeaders.has("authorization")) {
    sessionHeaders.delete("cookie");
  }

  const result = await auth.api.getSession({ headers: sessionHeaders });

  if (!result) {
    return null;
  }

  return {
    user: {
      id: result.user.id,
      email: result.user.email,
      full_name: result.user.name,
    },
    teamId: result.session.activeOrganizationId ?? null,
    authType: "session",
  };
}
