/**
 * Controlled concurrency tests for account deletion (roadmap issue #32).
 *
 * Deletion locks the user row before it snapshots memberships, so a concurrent
 * membership grant either waits and commits against a live user, or fails and
 * rolls back. These tests drive that interleaving deterministically by holding a
 * team row while the deletion and the competing write queue behind it.
 *
 *   cd apps/api && PERMISSIONS_TEST_DATABASE_URL=postgresql://invoicewise:invoicewise@localhost:5432/invoicewise_perms_test \
 *     bun test src/trpc/routers/team.deletion-races.integration.test.ts
 */
import { beforeAll, describe, expect, test } from "bun:test";
import type { Database, PrimaryDatabase } from "@invoicewise/db/client";

const testDatabaseUrl = process.env.PERMISSIONS_TEST_DATABASE_URL;

if (testDatabaseUrl) {
  process.env.DATABASE_PRIMARY_URL = testDatabaseUrl;
  process.env.BETTER_AUTH_SECRET ??= "permissions-race-integration-secret";
  process.env.BETTER_AUTH_URL ??= "http://localhost:3001";
  process.env.RESEND_API_KEY ??= "re_permissions_race_test";
  process.env.POLAR_ACCESS_TOKEN ??= "polar_permissions_race_test";
  process.env.REDIS_URL ??= "redis://localhost:6379";
  process.env.MIDDAY_ENCRYPTION_KEY ??=
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  process.env.NODE_ENV ??= "test";
}

const suite = testDatabaseUrl ? describe : describe.skip;

suite("account deletion races", () => {
  let db: Database;
  let primaryDb: PrimaryDatabase;
  let schema: typeof import("@invoicewise/db/schema");
  let orm: typeof import("drizzle-orm");
  let queries: typeof import("@invoicewise/db/queries");

  beforeAll(async () => {
    const client = await import("@invoicewise/db/client");
    schema = await import("@invoicewise/db/schema");
    orm = await import("drizzle-orm");
    queries = await import("@invoicewise/db/queries");

    db = client.db;
    primaryDb = client.primaryDb;
  });

  /** Seeds a member of one workspace plus a second workspace's owner. */
  const seed = async () => {
    const userId = crypto.randomUUID();
    const ownerId = crypto.randomUUID();
    const otherOwnerId = crypto.randomUUID();
    const memberTeamId = crypto.randomUUID();
    const otherTeamId = crypto.randomUUID();
    const email = `race-${userId}@example.test`;

    await primaryDb.insert(schema.teams).values([
      { id: memberTeamId, name: "Race member team" },
      { id: otherTeamId, name: "Race other team" },
    ]);
    await primaryDb.insert(schema.users).values([
      // The racing user has the workspace active, so `leaveTeam` also writes the
      // user row and a deletion/leave race can form a real lock cycle.
      { id: userId, email, fullName: "Racing user", teamId: memberTeamId },
      {
        id: ownerId,
        email: `owner-${ownerId}@example.test`,
        fullName: "Owner",
      },
      {
        id: otherOwnerId,
        email: `owner2-${otherOwnerId}@example.test`,
        fullName: "Other owner",
      },
    ]);
    await primaryDb.insert(schema.usersOnTeam).values([
      { teamId: memberTeamId, userId, role: "member" },
      { teamId: memberTeamId, userId: ownerId, role: "owner" },
      { teamId: otherTeamId, userId: otherOwnerId, role: "owner" },
    ]);

    const cleanup = async () => {
      await primaryDb
        .delete(schema.teams)
        .where(orm.inArray(schema.teams.id, [memberTeamId, otherTeamId]));
      await primaryDb
        .delete(schema.users)
        .where(orm.inArray(schema.users.id, [userId, ownerId, otherOwnerId]));
    };

    return {
      userId,
      email,
      ownerId,
      otherOwnerId,
      memberTeamId,
      otherTeamId,
      cleanup,
    };
  };

  /** Holds a team row `FOR UPDATE` until the returned release is called. */
  const holdTeam = async (teamId: string) => {
    let release = () => {};
    let acquired = () => {};

    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      acquired = resolve;
    });

    const holder = primaryDb.transaction(async (tx) => {
      await tx
        .select({ id: schema.teams.id })
        .from(schema.teams)
        .where(orm.eq(schema.teams.id, teamId))
        .for("update");
      acquired();
      await released;
    });

    await locked;

    return {
      release: () => release(),
      done: holder,
    };
  };

  /**
   * Attaches settlement handlers in the same tick the query is launched, so a
   * rejected side (for example the deadlock victim) is never an unhandled
   * rejection while the test awaits the other side. The returned promise always
   * resolves; callers still assert on the typed error value.
   */
  const settled = <T>(promise: Promise<T>) =>
    promise.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );

  /**
   * Runs one race and always releases the held team row and removes the seeded
   * fixtures, even when an assertion or a query fails.
   */
  const withRace = async (
    run: (context: {
      fixture: Awaited<ReturnType<typeof seed>>;
      hold: Awaited<ReturnType<typeof holdTeam>>;
    }) => Promise<void>,
  ) => {
    const fixture = await seed();
    const hold = await holdTeam(fixture.memberTeamId);
    try {
      await run({ fixture, hold });
    } finally {
      hold.release();
      try {
        await hold.done;
      } finally {
        await fixture.cleanup();
      }
    }
  };

  const ownerlessTeamsCreatedAfter = async (since: Date) => {
    const result = await primaryDb.execute(orm.sql`
      select t.id from teams t
      where t.created_at >= ${since}
        and not exists (
          select 1 from users_on_team m where m.team_id = t.id
        )
    `);

    return (result as unknown as { rows?: unknown[] }).rows ?? [];
  };

  test("workspace creation racing deletion rolls back instead of orphaning", async () => {
    await withRace(async ({ fixture, hold }) => {
      const startedAt = new Date();

      // The deletion locks the user row, then waits for the held team row.
      const deletion = settled(queries.deleteUser(db, fixture.userId));
      await Bun.sleep(150);

      // Creation now blocks on the user's foreign-key lock, so it cannot slip a
      // new membership past the deletion.
      const creation = settled(
        queries.createTeam(db, {
          name: `Race workspace ${fixture.userId}`,
          userId: fixture.userId,
          email: fixture.email,
          baseCurrency: "GBP",
        }),
      );
      await Bun.sleep(150);

      hold.release();
      await hold.done;

      const deletionResult = await deletion;
      const creationResult = await creation;

      expect(deletionResult).toEqual({
        ok: true,
        value: { id: fixture.userId },
      });
      expect(creationResult.ok).toBe(false);

      expect(
        await primaryDb.query.users.findFirst({
          where: orm.eq(schema.users.id, fixture.userId),
          columns: { id: true },
        }),
      ).toBeUndefined();

      expect(
        await queries.getTeamRole(
          primaryDb,
          fixture.memberTeamId,
          fixture.ownerId,
        ),
      ).toBe("owner");

      // Nothing created during the race is left without members.
      expect(await ownerlessTeamsCreatedAfter(startedAt)).toHaveLength(0);
    });
  });

  test("invitation acceptance racing deletion leaves no accepted membership", async () => {
    await withRace(async ({ fixture, hold }) => {
      await queries.createTeamInvites(db, {
        teamId: fixture.otherTeamId,
        actorUserId: fixture.otherOwnerId,
        invites: [
          {
            email: fixture.email,
            role: "member",
            invitedBy: fixture.otherOwnerId,
          },
        ],
      });

      const inviteId = (await primaryDb.query.userInvites.findFirst({
        where: orm.eq(schema.userInvites.email, fixture.email),
        columns: { id: true },
      }))!.id;

      const deletion = settled(queries.deleteUser(db, fixture.userId));
      await Bun.sleep(150);

      const acceptance = settled(
        queries.acceptTeamInvite(db, {
          id: inviteId,
          userId: fixture.userId,
          email: fixture.email,
        }),
      );
      await Bun.sleep(150);

      hold.release();
      await hold.done;

      const deletionResult = await deletion;
      const acceptanceResult = await acceptance;

      expect(deletionResult.ok).toBe(true);
      expect(acceptanceResult.ok).toBe(false);

      // No orphaned membership, and the invited workspace keeps its owner.
      expect(
        await primaryDb.query.usersOnTeam.findFirst({
          where: orm.and(
            orm.eq(schema.usersOnTeam.teamId, fixture.otherTeamId),
            orm.eq(schema.usersOnTeam.userId, fixture.userId),
          ),
          columns: { id: true },
        }),
      ).toBeUndefined();
      expect(
        await queries.getTeamRole(
          primaryDb,
          fixture.otherTeamId,
          fixture.otherOwnerId,
        ),
      ).toBe("owner");
    });
  });

  test("a concurrent role change racing deletion leaves no orphan state", async () => {
    await withRace(async ({ fixture, hold }) => {
      const deletion = settled(queries.deleteUser(db, fixture.userId));
      await Bun.sleep(150);

      const roleChange = settled(
        queries.updateTeamMember(db, {
          actorUserId: fixture.ownerId,
          teamId: fixture.memberTeamId,
          userId: fixture.userId,
          role: "admin",
        }),
      );
      await Bun.sleep(150);

      hold.release();
      await hold.done;

      const deletionResult = await deletion;
      const roleChangeResult = await roleChange;

      // Whichever order they serialize in, the user is deleted, the membership is
      // gone and the workspace keeps its owner.
      expect(deletionResult.ok).toBe(true);
      expect(
        await primaryDb.query.users.findFirst({
          where: orm.eq(schema.users.id, fixture.userId),
          columns: { id: true },
        }),
      ).toBeUndefined();
      expect(
        await primaryDb.query.usersOnTeam.findFirst({
          where: orm.and(
            orm.eq(schema.usersOnTeam.teamId, fixture.memberTeamId),
            orm.eq(schema.usersOnTeam.userId, fixture.userId),
          ),
          columns: { id: true },
        }),
      ).toBeUndefined();
      expect(
        await queries.getTeamRole(
          primaryDb,
          fixture.memberTeamId,
          fixture.ownerId,
        ),
      ).toBe("owner");

      if (!roleChangeResult.ok) {
        // The losing side is a typed conflict or not-found, never a driver error.
        expect(roleChangeResult.error).toBeInstanceOf(
          queries.TeamPermissionError,
        );
      }
    });
  });

  test("a deletion that deadlocks against a leave fails retryably, not silently", async () => {
    await withRace(async ({ fixture, hold }) => {
      // Queue the leave first so it wins the team row when released and then asks
      // for the user row the deletion is holding. Both settlement handlers are
      // attached at launch: whichever side Postgres picks as the deadlock victim
      // is observed as a typed result, never as an unhandled rejection.
      const leave = settled(
        queries.leaveTeam(db, {
          userId: fixture.userId,
          teamId: fixture.memberTeamId,
        }),
      );
      await Bun.sleep(100);

      const deletion = settled(queries.deleteUser(db, fixture.userId));
      // Let the deletion wait on the team row long enough for the Postgres
      // deadlock detector to fire once the cycle forms.
      await Bun.sleep(1400);

      hold.release();
      await hold.done;

      const deletionResult = await deletion;
      const leaveResult = await leave;

      console.log(
        `[deletion-race] deadlock victim: ${
          deletionResult.ok ? (leaveResult.ok ? "none" : "leave") : "deletion"
        }`,
      );

      // The deadlock victim reports a retryable conflict rather than a raw driver
      // error, and the workspace keeps its owner either way.
      if (!deletionResult.ok) {
        const error = deletionResult.error as InstanceType<
          typeof queries.TeamPermissionError
        >;

        expect(error).toBeInstanceOf(queries.TeamPermissionError);
        expect(error.code).toBe("CONFLICT");
        expect(error.message.toLowerCase()).toContain("retry");
      }

      expect(deletionResult.ok || leaveResult.ok).toBe(true);
      expect(
        await queries.getTeamRole(
          primaryDb,
          fixture.memberTeamId,
          fixture.ownerId,
        ),
      ).toBe("owner");

      if (leaveResult.ok) {
        expect(
          await queries.getTeamRole(
            primaryDb,
            fixture.memberTeamId,
            fixture.userId,
          ),
        ).toBeNull();
      }
    });
  });
});
