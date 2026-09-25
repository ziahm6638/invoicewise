/**
 * Seeds a freshly migrated e2e database (run by `bun run e2e` after migrating).
 *
 * Journeys create their own users and workspaces through the product's
 * sign-up, so the seed holds only shared reference data every run needs: one
 * pre-existing "bystander" workspace with an owner. Its id is looked up by
 * slug; journeys that prove tenant isolation assert they can never see it.
 * Synthetic data only, never a production dump.
 *
 * Usage: DATABASE_PRIMARY_URL=<disposable e2e database> bun --no-env-file e2e/seed.ts
 */

import { closeDatabase, db } from "@invoicewise/db/client";
import { teams, users, usersOnTeam } from "@invoicewise/db/schema";

export const SEED_WORKSPACE_SLUG = "e2e-seed-bystander";

const url = process.env.DATABASE_PRIMARY_URL ?? "";
if (!/\/e2e_[0-9]+_[0-9a-f]+$/.test(url.replace(/\?.*$/, ""))) {
  throw new Error(
    "e2e/seed.ts only seeds a per-run e2e_<epoch>_<hex> database",
  );
}

try {
  const [team] = await db
    .insert(teams)
    .values({ name: "Bystander Ltd (seed)", slug: SEED_WORKSPACE_SLUG })
    .returning({ id: teams.id });
  if (!team) throw new Error("seed workspace was not created");
  const [owner] = await db
    .insert(users)
    .values({
      email: "bystander-owner@example.test",
      fullName: "Bystander Owner",
      teamId: team.id,
    })
    .returning({ id: users.id });
  if (!owner) throw new Error("seed owner was not created");
  await db
    .insert(usersOnTeam)
    .values({ userId: owner.id, teamId: team.id, role: "owner" });
  console.log(`seeded workspace ${SEED_WORKSPACE_SLUG}`);
} finally {
  await closeDatabase();
}
