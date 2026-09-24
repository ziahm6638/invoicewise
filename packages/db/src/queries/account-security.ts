import type { Database, PrimaryDatabase } from "@db/client";
import { authSessions, authTwoFactors, users } from "@db/schema";
import { eq, sql } from "drizzle-orm";

/**
 * Operator-assisted recovery for an account that has lost both its
 * authenticator and every recovery code.
 *
 * Removes the second factor and ends every session in one transaction, so the
 * account can only continue by signing in again with its password and then
 * enrolling a new factor. Workspace memberships and roles are keyed by user id
 * and are deliberately untouched: recovery restores access to the same
 * workspaces with the same roles, never more.
 *
 * Only run this after the account holder's identity has been confirmed out of
 * band (see docs/development.md, "Lost second factor").
 */
export async function resetAccountSecondFactor(
  db: Database | PrimaryDatabase,
  userId: string,
) {
  return await db.transaction(async (tx) => {
    const [user] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId))
      .for("update")
      .limit(1);

    if (!user) {
      return null;
    }

    const removedFactors = await tx
      .delete(authTwoFactors)
      .where(eq(authTwoFactors.userId, user.id))
      .returning({ id: authTwoFactors.id });

    await tx
      .update(users)
      .set({ twoFactorEnabled: false, updatedAt: sql`now()` })
      .where(eq(users.id, user.id));

    const revokedSessions = await tx
      .delete(authSessions)
      .where(eq(authSessions.userId, user.id))
      .returning({ id: authSessions.id });

    return {
      userId: user.id,
      removedSecondFactor: removedFactors.length > 0,
      revokedSessions: revokedSessions.length,
    };
  });
}
