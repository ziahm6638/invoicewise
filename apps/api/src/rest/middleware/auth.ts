import { resolveActiveWorkspace } from "@api/utils/active-workspace";
import { type Session, getAuthSession } from "@api/utils/auth";
import { expandScopes } from "@api/utils/scopes";
import { isValidApiKeyFormat } from "@db/utils/api-keys";
import { primaryDb } from "@invoicewise/db/client";
import {
  clampScopesForRole,
  getApiKeyByToken,
  getTeamRole,
  getUserById,
  updateApiKeyLastUsedAt,
  validateAccessToken,
} from "@invoicewise/db/queries";
import { hash } from "@invoicewise/encryption";
import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";

/**
 * Resolves the caller's role for a workspace straight from the primary
 * database. Membership, role and key revocation therefore take effect on the
 * very next request without any cache invalidation protocol.
 */
const resolveRole = async (teamId: string | null, userId: string) => {
  if (!teamId) {
    return null;
  }

  return getTeamRole(primaryDb, teamId, userId);
};

/**
 * Continues as a signed-in session. A stale active-workspace pointer is
 * recovered rather than refused; see `resolveActiveWorkspace`.
 */
const continueWithSession = async (
  c: Parameters<MiddlewareHandler>[0],
  next: Parameters<MiddlewareHandler>[1],
  session: Session,
) => {
  const { teamId, teamRole } = await resolveActiveWorkspace(
    session.user.id,
    session.teamId,
  );

  c.set("session", { ...session, teamId, authType: "session" });
  c.set("teamId", teamId);
  c.set("teamRole", teamRole);
  c.set("scopes", expandScopes(["apis.all"]));
  c.set("credentialId", null);
  await next();
};

export const withAuth: MiddlewareHandler = async (c, next) => {
  const authHeader = c.req.header("Authorization");

  if (!authHeader) {
    const session = await getAuthSession(c.req.raw.headers).catch(() => null);

    if (!session) {
      throw new HTTPException(401, { message: "Authentication required" });
    }

    await continueWithSession(c, next, session);
    return;
  }

  const [scheme, token] = authHeader.split(" ");

  if (scheme !== "Bearer") {
    throw new HTTPException(401, { message: "Invalid authorization scheme" });
  }

  if (!token) {
    throw new HTTPException(401, { message: "Token required" });
  }

  if (!token.startsWith("mid_") && token.includes(".")) {
    const session = await getAuthSession(c.req.raw.headers).catch(() => null);

    if (!session) {
      throw new HTTPException(401, { message: "Invalid session token" });
    }

    await continueWithSession(c, next, session);
    return;
  }

  // Handle OAuth access tokens (start with mid_access_token_)
  if (token.startsWith("mid_access_token_")) {
    const tokenData = await validateAccessToken(primaryDb, token);

    if (!tokenData || !tokenData.user) {
      throw new HTTPException(401, {
        message: "Invalid or expired access token",
      });
    }

    const session = {
      teamId: tokenData.teamId,
      user: {
        id: tokenData.user.id,
        email: tokenData.user.email,
        full_name: tokenData.user.fullName,
      },
      oauth: {
        applicationId: tokenData.applicationId,
        clientId: tokenData.application?.clientId,
        applicationName: tokenData.application?.name,
      },
    };

    const role = await resolveRole(session.teamId, session.user.id);

    if (!role) {
      throw new HTTPException(403, {
        message: "No permission to access this team",
      });
    }

    c.set("session", { ...session, authType: "oauth" });
    c.set("teamId", session.teamId);
    c.set("teamRole", role);
    // Aliases are expanded and unknown scopes dropped inside the clamp.
    c.set("scopes", clampScopesForRole(role, tokenData.scopes ?? []));
    c.set("credentialId", tokenData.applicationId ?? null);

    await next();
    return;
  }

  // Handle API keys (start with mid_ but not mid_access_token_)
  if (!token.startsWith("mid_") || !isValidApiKeyFormat(token)) {
    throw new HTTPException(401, { message: "Invalid token format" });
  }

  const keyHash = hash(token);

  // Always read the key from the primary database: a deleted or edited key
  // must stop working immediately, not after a cache TTL.
  const apiKey = await getApiKeyByToken(primaryDb, keyHash);

  if (!apiKey) {
    throw new HTTPException(401, { message: "Invalid API key" });
  }

  const user = await getUserById(primaryDb, apiKey.userId);

  if (!user) {
    throw new HTTPException(401, { message: "User not found" });
  }

  const role = await resolveRole(apiKey.teamId, apiKey.userId);

  if (!role) {
    throw new HTTPException(403, {
      message: "No permission to access this team",
    });
  }

  const session = {
    teamId: apiKey.teamId,
    user: {
      id: user.id,
      email: user.email,
      full_name: user.fullName,
    },
  };

  c.set("session", { ...session, authType: "api_key" });
  c.set("teamId", session.teamId);
  c.set("teamRole", role);
  c.set("scopes", clampScopesForRole(role, apiKey.scopes ?? []));
  c.set("credentialId", apiKey.id);

  // Update last used at
  updateApiKeyLastUsedAt(primaryDb, apiKey.id);

  await next();
};
