import { randomBytes } from "node:crypto";
import type { Database } from "@db/client";
import { authVerifications } from "@db/schema";
import { hash } from "@invoicewise/encryption";
import { and, eq, gt, sql } from "drizzle-orm";

/** How long a mailbox-connect `state` stays redeemable. */
export const CONNECTOR_STATE_TTL_MS = 10 * 60 * 1000;

/**
 * Who started a mailbox OAuth connect. The callback must come back to the same
 * browser session, user and workspace.
 */
export type ConnectorStateBinding = {
  userId: string;
  teamId: string;
  sessionId: string;
};

// Only a hash of the state is stored, so a database read cannot forge one.
const identifierFor = (state: string) => `inbox-connector-state:${hash(state)}`;

// Ids are UUIDs, so the ":"-joined prefix is unambiguous and the provider,
// which the callback does not carry, is recovered from the stored value.
const bindingPrefix = (binding: ConnectorStateBinding) =>
  `${binding.userId}:${binding.teamId}:${binding.sessionId}:`;

/**
 * Issues an unguessable, expiring OAuth `state` bound to the initiating
 * session. Stored in the verification table Better Auth already uses for its
 * own short-lived tokens.
 */
export async function createConnectorState(
  db: Database,
  params: ConnectorStateBinding & { provider: string },
): Promise<string> {
  const { provider, ...binding } = params;
  const state = randomBytes(32).toString("base64url");

  await db.insert(authVerifications).values({
    identifier: identifierFor(state),
    value: `${bindingPrefix(binding)}${provider}`,
    expiresAt: new Date(Date.now() + CONNECTOR_STATE_TTL_MS),
  });

  return state;
}

/**
 * Redeems a `state` exactly once and returns the provider it was issued for.
 * The delete matches the hash, the binding and the expiry in one statement, so
 * a replayed, expired or foreign state (another session, user or workspace)
 * returns null, and two concurrent callbacks cannot both succeed.
 */
export async function consumeConnectorState(
  db: Database,
  params: ConnectorStateBinding & { state: string },
): Promise<string | null> {
  const { state, ...binding } = params;

  if (!state) {
    return null;
  }

  const prefix = bindingPrefix(binding);

  const [row] = await db
    .delete(authVerifications)
    .where(
      and(
        eq(authVerifications.identifier, identifierFor(state)),
        sql`left(${authVerifications.value}, ${prefix.length}) = ${prefix}`,
        gt(authVerifications.expiresAt, new Date()),
      ),
    )
    .returning({ value: authVerifications.value });

  return row ? row.value.slice(prefix.length) || null : null;
}
