/**
 * Operator recovery for an account that lost its authenticator and every
 * recovery code. Removes the second factor and ends every session; workspace
 * memberships and roles are unchanged. Confirm the account holder's identity
 * out of band first (docs/development.md, "Lost second factor").
 *
 *   bun src/scripts/reset-second-factor.ts --email person@example.com
 *
 * In production, inside the API container:
 *
 *   kamal app exec --roles api --reuse \
 *     "bun apps/api/src/scripts/reset-second-factor.ts --email person@example.com"
 */
import { parseArgs } from "node:util";
import { primaryDb } from "@invoicewise/db/client";
import { resetAccountSecondFactor } from "@invoicewise/db/queries";
import { users } from "@invoicewise/db/schema";
import { eq } from "drizzle-orm";

const { values } = parseArgs({
  options: { email: { type: "string" } },
});

const email = values.email?.trim().toLowerCase();

if (!email) {
  console.error("usage: reset-second-factor.ts --email <address>");
  process.exit(2);
}

const [user] = await primaryDb
  .select({ id: users.id })
  .from(users)
  .where(eq(users.email, email))
  .limit(1);

if (!user) {
  console.error("No account uses that address");
  process.exit(1);
}

const result = await resetAccountSecondFactor(primaryDb, user.id);

console.log(
  JSON.stringify({
    userId: result?.userId ?? user.id,
    removedSecondFactor: result?.removedSecondFactor ?? false,
    revokedSessions: result?.revokedSessions ?? 0,
  }),
);

process.exit(0);
