/**
 * DB-backed authorization checks for roadmap issue #32.
 *
 * Runs against a disposable Postgres database, pointed at explicitly:
 *
 *   docker exec invoicewise-postgres-1 psql -U invoicewise -d postgres \
 *     -c "DROP DATABASE IF EXISTS invoicewise_perms_test" \
 *     -c "CREATE DATABASE invoicewise_perms_test"
 *   cd packages/db && DATABASE_PRIMARY_URL=postgresql://invoicewise:invoicewise@localhost:5432/invoicewise_perms_test bunx drizzle-kit migrate
 *   cd apps/api && PERMISSIONS_TEST_DATABASE_URL=postgresql://invoicewise:invoicewise@localhost:5432/invoicewise_perms_test \
 *     bun test src/trpc/routers/team.permissions.integration.test.ts
 *
 * The suite is skipped when PERMISSIONS_TEST_DATABASE_URL is unset so it can
 * never touch a development or production database by accident.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Database, PrimaryDatabase } from "@invoicewise/db/client";

const testDatabaseUrl = process.env.PERMISSIONS_TEST_DATABASE_URL;

// Must be set before the database client and auth modules are imported.
if (testDatabaseUrl) {
  process.env.DATABASE_PRIMARY_URL = testDatabaseUrl;
  process.env.BETTER_AUTH_SECRET ??= "permissions-integration-test-secret";
  process.env.BETTER_AUTH_URL ??= "http://localhost:3001";
  // Placeholders only: the suite never calls a provider.
  process.env.RESEND_API_KEY ??= "re_permissions_integration_test";
  process.env.POLAR_ACCESS_TOKEN ??= "polar_permissions_integration_test";
  // Local-only infrastructure, used for cache writes and key encryption.
  process.env.REDIS_URL ??= "redis://localhost:6379";
  process.env.MIDDAY_ENCRYPTION_KEY ??=
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  process.env.NODE_ENV ??= "test";
}

const suite = testDatabaseUrl ? describe : describe.skip;

suite("workspace permissions (integration)", () => {
  let db: Database;
  let primaryDb: PrimaryDatabase;
  let queries: typeof import("@invoicewise/db/queries");
  let schema: typeof import("@invoicewise/db/schema");
  let orm: typeof import("drizzle-orm");
  // The caller factory is generic over the router; deriving its exact type here
  // means fighting tRPC internals, so the runtime caller is used directly.
  let caller: (ctx: any) => Record<string, any>;

  const ids = {
    teamA: crypto.randomUUID(),
    teamB: crypto.randomUUID(),
    ownerA: crypto.randomUUID(),
    adminA: crypto.randomUUID(),
    memberA: crypto.randomUUID(),
    ownerB: crypto.randomUUID(),
  };
  const emails = {
    ownerA: `owner-a-${ids.teamA}@example.test`,
    adminA: `admin-a-${ids.teamA}@example.test`,
    memberA: `member-a-${ids.teamA}@example.test`,
    ownerB: `owner-b-${ids.teamB}@example.test`,
    invited: `invited-${ids.teamA}@example.test`,
  };

  const ctx = (userId: string, teamId: string | null) => ({
    session: {
      user: {
        id: userId,
        email:
          userId === ids.ownerA
            ? emails.ownerA
            : userId === ids.adminA
              ? emails.adminA
              : userId === ids.memberA
                ? emails.memberA
                : emails.ownerB,
        full_name: "Test User",
      },
      teamId,
    },
    db,
    geo: { ip: "127.0.0.1", country: null, locale: null, timezone: null },
    requestHeaders: new Headers(),
  });

  const roleOf = (teamId: string, userId: string) =>
    queries.getTeamRole(db, teamId, userId);

  beforeAll(async () => {
    const client = await import("@invoicewise/db/client");
    schema = await import("@invoicewise/db/schema");
    orm = await import("drizzle-orm");
    queries = await import("@invoicewise/db/queries");
    const { appRouter } = await import("@api/trpc/routers/_app");
    const { createCallerFactory } = await import("@api/trpc/init");

    db = client.db;
    primaryDb = client.primaryDb;
    caller = createCallerFactory(appRouter);

    await primaryDb.insert(schema.teams).values([
      { id: ids.teamA, name: "Permissions Team A" },
      { id: ids.teamB, name: "Permissions Team B" },
    ]);

    await primaryDb.insert(schema.users).values([
      {
        id: ids.ownerA,
        email: emails.ownerA,
        fullName: "Owner A",
        teamId: ids.teamA,
      },
      {
        id: ids.adminA,
        email: emails.adminA,
        fullName: "Admin A",
        teamId: ids.teamA,
      },
      {
        id: ids.memberA,
        email: emails.memberA,
        fullName: "Member A",
        teamId: ids.teamA,
      },
      {
        id: ids.ownerB,
        email: emails.ownerB,
        fullName: "Owner B",
        teamId: ids.teamB,
      },
    ]);

    await primaryDb.insert(schema.usersOnTeam).values([
      { teamId: ids.teamA, userId: ids.ownerA, role: "owner" },
      { teamId: ids.teamA, userId: ids.adminA, role: "admin" },
      { teamId: ids.teamA, userId: ids.memberA, role: "member" },
      { teamId: ids.teamB, userId: ids.ownerB, role: "owner" },
    ]);
  });

  afterAll(async () => {
    await primaryDb
      .delete(schema.teams)
      .where(orm.inArray(schema.teams.id, [ids.teamA, ids.teamB]));
    await primaryDb
      .delete(schema.users)
      .where(
        orm.inArray(schema.users.id, [
          ids.ownerA,
          ids.adminA,
          ids.memberA,
          ids.ownerB,
        ]),
      );

    await (
      primaryDb as unknown as { $client?: { end: () => Promise<void> } }
    ).$client?.end?.();
  });

  describe("roles", () => {
    test("resolve fresh per workspace and fail closed for unknown values", async () => {
      expect(await roleOf(ids.teamA, ids.ownerA)).toBe("owner");
      expect(await roleOf(ids.teamA, ids.adminA)).toBe("admin");
      expect(await roleOf(ids.teamA, ids.memberA)).toBe("member");
      expect(await roleOf(ids.teamB, ids.memberA)).toBeNull();
      expect(await roleOf(ids.teamA, crypto.randomUUID())).toBeNull();

      expect(queries.normalizeTeamRole("superuser")).toBeNull();
      expect(queries.roleAtLeast("superuser" as never, "member")).toBe(false);
      expect(
        queries.clampScopesForRole("superuser" as never, ["apis.all"]),
      ).toEqual([]);
    });

    test("clamp scopes to what the role may hold", () => {
      // A member keeps invoice use but never workspace management.
      expect(
        queries
          .clampScopesForRole("member", ["inbox.write", "inbox.read"])
          .sort(),
      ).toEqual(["inbox.read", "inbox.write"]);
      expect(queries.clampScopesForRole("admin", ["inbox.write"])).toEqual([
        "inbox.write",
      ]);
      expect(queries.clampScopesForRole("owner", ["apis.all"])).toEqual([
        "inbox.read",
        "inbox.write",
        "sources.read",
        "sources.write",
        "teams.read",
        "teams.write",
        "users.read",
        "users.write",
      ]);
    });

    test("unknown scopes are dropped for every role", () => {
      for (const role of ["owner", "admin", "member"] as const) {
        expect(
          queries.clampScopesForRole(role, [
            "unknown.write",
            "apis.bogus",
            "inbox.read.evil",
          ]),
        ).toEqual([]);
      }

      // A known scope mixed with junk keeps only the known scope.
      expect(
        queries.clampScopesForRole("admin", ["teams.read", "unknown.write"]),
      ).toEqual(["teams.read"]);
    });

    test("aliases expand before the role intersection", () => {
      expect(queries.clampScopesForRole("member", ["apis.all"]).sort()).toEqual(
        [
          "inbox.read",
          "inbox.write",
          "sources.read",
          "teams.read",
          "users.read",
        ],
      );

      expect(
        queries
          .clampScopesForRole("admin", ["apis.read", "teams.write"])
          .sort(),
      ).toEqual([
        "inbox.read",
        "sources.read",
        "teams.read",
        "teams.write",
        "users.read",
      ]);

      // A member can never hold team or user management writes.
      expect(
        queries.clampScopesForRole("member", ["teams.write", "users.write"]),
      ).toEqual([]);
    });

    test("role containment is set based, not count based", () => {
      // Aliases expand to the same set the clamp produces, so an owner/admin
      // grant of `apis.all` is contained rather than "too long".
      expect(queries.scopesWithinRole("owner", ["apis.all"])).toBe(true);
      expect(queries.scopesWithinRole("admin", ["apis.all"])).toBe(true);
      expect(queries.scopesWithinRole("owner", ["apis.read"])).toBe(true);

      // Duplicates and overlaps collapse instead of inflating the comparison.
      expect(
        queries.scopesWithinRole("member", [
          "inbox.read",
          "inbox.read",
          "apis.read",
        ]),
      ).toBe(true);
      expect(
        queries.scopesWithinRole("admin", ["apis.all", "teams.write"]),
      ).toBe(true);

      // A member cannot reach team or user management writes.
      expect(queries.scopesWithinRole("member", ["apis.all"])).toBe(false);
      expect(queries.scopesWithinRole("member", ["teams.write"])).toBe(false);
      expect(queries.scopesWithinRole("member", ["users.write"])).toBe(false);

      // Unknown scopes and unknown roles fail closed.
      expect(queries.scopesWithinRole("owner", ["unknown.write"])).toBe(false);
      expect(
        queries.scopesWithinRole("owner", ["inbox.read", "unknown.write"]),
      ).toBe(false);
      expect(queries.scopesWithinRole(null, ["inbox.read"])).toBe(false);
      expect(queries.scopesWithinRole("member", ["apis.bogus"])).toBe(false);
    });
  });

  describe("tRPC protected paths", () => {
    test("a member cannot escalate, remove, invite an admin or delete", async () => {
      const member = caller(ctx(ids.memberA, ids.teamA));

      await expect(
        member.team.updateMember({
          teamId: ids.teamA,
          userId: ids.adminA,
          role: "member",
        }),
      ).rejects.toThrow();
      await expect(
        member.team.deleteMember({ teamId: ids.teamA, userId: ids.adminA }),
      ).rejects.toThrow();
      await expect(
        member.team.invite([{ email: emails.invited, role: "admin" }]),
      ).rejects.toThrow();
      await expect(
        member.team.delete({
          teamId: ids.teamA,
          confirmName: "Permissions Team A",
        }),
      ).rejects.toThrow();
      await expect(member.team.update({ name: "Hijacked" })).rejects.toThrow();
      await expect(
        member.questions.create({
          question: "Was this approved?",
          type: "boolean",
          enabled: true,
        }),
      ).rejects.toThrow();
      await expect(member.apiKeys.get()).rejects.toThrow();
      await expect(member.billing.orders({})).rejects.toThrow();

      expect(await roleOf(ids.teamA, ids.adminA)).toBe("admin");
      expect(await queries.getTeamById(db, ids.teamA)).toMatchObject({
        name: "Permissions Team A",
      });
    });

    test("only an admin corrects supplier identity, and only in their workspace", async () => {
      // The snapshot processing records; reads return it as stored.
      const storedChecks = {
        version: 1,
        checkedAt: "2026-09-01T09:00:00.000Z",
        supplier: {
          status: "new",
          supplierId: null,
          name: "Harbour Lane Plumbing Ltd",
          method: null,
          message: "A new supplier.",
        },
        known: {
          outcome: "first_invoice",
          message:
            "This is the first document from Harbour Lane Plumbing Ltd in this workspace.",
          earlierInvoices: 0,
          evidence: [],
        },
        duplicate: { outcome: "none", message: "No duplicate.", evidence: [] },
        bankDetails: {
          outcome: "not_present",
          message: "No bank details.",
          current: null,
          evidence: [],
        },
      };
      const [invoice] = await primaryDb
        .insert(schema.inbox)
        .values({
          teamId: ids.teamA,
          displayName: "Supplier check",
          fileName: "supplier-check.pdf",
          contentType: "application/pdf",
          status: "pending",
          extraction: {
            documentType: "invoice",
            supplierName: "Harbour Lane Plumbing Ltd",
            invoiceNumber: "HLP-1",
            invoiceDate: "2026-09-01",
            currency: "GBP",
            grossAmount: 120,
          },
          supplierChecks: storedChecks,
        })
        .returning({ id: schema.inbox.id });
      const inboxId = invoice!.id;
      const member = caller(ctx(ids.memberA, ids.teamA));

      await expect(
        member.suppliers.assignInvoice({ inboxId, newSupplierName: "Other" }),
      ).rejects.toThrow();
      await expect(
        member.suppliers.merge({
          sourceId: crypto.randomUUID(),
          targetId: crypto.randomUUID(),
        }),
      ).rejects.toThrow();
      await expect(
        member.suppliers.revert({ eventId: crypto.randomUUID() }),
      ).rejects.toThrow();

      // A member reads the evidence.
      const read = await member.suppliers.forInvoice({ inboxId });
      expect(read?.canCorrect).toBe(false);
      expect(read?.checks).toEqual(storedChecks);

      // Another workspace neither reads nor corrects it.
      const otherOwner = caller(ctx(ids.ownerB, ids.teamB));
      expect(await otherOwner.suppliers.forInvoice({ inboxId })).toBeNull();
      await expect(
        otherOwner.suppliers.assignInvoice({
          inboxId,
          newSupplierName: "Hijacked",
        }),
      ).rejects.toThrow();

      // An admin's correction is recorded with who made it, and undone.
      const admin = caller(ctx(ids.adminA, ids.teamA));
      const assigned = await admin.suppliers.assignInvoice({
        inboxId,
        newSupplierName: "Harbour Lane Plumbing",
      });
      const corrected = await admin.suppliers.forInvoice({ inboxId });
      expect(corrected?.canCorrect).toBe(true);
      expect(corrected?.events[0]).toMatchObject({
        action: "assign_invoice",
        actor: { id: ids.adminA },
      });
      await admin.suppliers.revert({ eventId: assigned.eventId, inboxId });
      await expect(
        admin.suppliers.revert({ eventId: assigned.eventId, inboxId }),
      ).rejects.toThrow();
    });

    test("only an admin writes authorization sources; members read them; other workspaces see nothing", async () => {
      const member = caller(ctx(ids.memberA, ids.teamA));
      const admin = caller(ctx(ids.adminA, ids.teamA));
      const otherOwner = caller(ctx(ids.ownerB, ids.teamB));
      const source = {
        type: "purchase_order",
        reference: "PO-PERM-1",
        currency: "GBP",
        taxBasis: "exclusive",
        authorizedTotal: "500",
      };
      const csv =
        "source_type,reference,authorized_total\njob,JOB-PERM-1,100\n";

      // A member can neither create, import, amend, close nor link.
      await expect(
        member.authorizationSources.create({ source }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        member.authorizationSources.import({ csv, dryRun: false }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(member.authorizationSources.imports()).rejects.toMatchObject(
        { code: "FORBIDDEN" },
      );

      const created = await admin.authorizationSources.create({ source });
      expect(created).toMatchObject({ outcome: "created", version: 1 });
      const id = created.sourceId!;

      await expect(
        member.authorizationSources.amend({
          id,
          source: { ...source, authorizedTotal: "999" },
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        member.authorizationSources.setStatus({ id, status: "cancelled" }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        member.authorizationSources.linkSupplier({
          id,
          supplierId: crypto.randomUUID(),
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });

      // A member reads the list, the source and each version.
      const listed = await member.authorizationSources.list({});
      expect(listed.data.map((row: { id: string }) => row.id)).toContain(id);
      const read = await member.authorizationSources.get({ id });
      expect(read.canManage).toBe(false);
      expect(
        read.current.gaps.map((gap: { code: string }) => gap.code),
      ).toEqual(["unknown_supplier"]);

      // The admin amends it; the original stays readable.
      await admin.authorizationSources.amend({
        id,
        source: {
          ...source,
          authorizedTotal: "750",
          effectiveFrom: "2026-01-01",
        },
      });
      expect(
        (await member.authorizationSources.version({ id, version: 1 }))
          .authorizedTotal,
      ).toBe("500.00");
      expect(
        (
          await member.authorizationSources.effective({
            id,
            on: "2026-06-01",
          })
        )?.version,
      ).toBe(2);
      expect((await admin.authorizationSources.get({ id })).canManage).toBe(
        true,
      );

      // Another workspace neither reads nor changes it, even by id.
      await expect(
        otherOwner.authorizationSources.get({ id }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(
        otherOwner.authorizationSources.version({ id, version: 1 }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(
        await otherOwner.authorizationSources.effective({
          id,
          on: "2026-06-01",
        }),
      ).toBeNull();
      await expect(
        otherOwner.authorizationSources.amend({ id, source }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(
        otherOwner.authorizationSources.setStatus({ id, status: "cancelled" }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(
        (await otherOwner.authorizationSources.list({})).data.map(
          (row: { id: string }) => row.id,
        ),
      ).not.toContain(id);

      // An admin of the owning workspace imports; a duplicate create conflicts.
      const imported = await admin.authorizationSources.import({
        csv,
        dryRun: false,
      });
      expect(imported).toMatchObject({ status: "applied" });
      await expect(
        admin.authorizationSources.create({ source }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    });

    test("an admin manages members but can never grant owner", async () => {
      const admin = caller(ctx(ids.adminA, ids.teamA));

      await expect(
        admin.team.updateMember({
          teamId: ids.teamA,
          userId: ids.memberA,
          role: "admin",
        }),
      ).resolves.toBeTruthy();
      expect(await roleOf(ids.teamA, ids.memberA)).toBe("admin");

      await expect(
        admin.team.updateMember({
          teamId: ids.teamA,
          userId: ids.adminA,
          role: "owner",
        }),
      ).rejects.toThrow();
      expect(await roleOf(ids.teamA, ids.adminA)).toBe("admin");

      const invited = await admin.team.invite([
        { email: emails.invited, role: "owner" },
      ]);
      expect(invited.sent).toBe(0);
      expect(invited.skippedInvites[0]?.reason).toBe("role_not_allowed");

      await expect(
        admin.team.delete({
          teamId: ids.teamA,
          confirmName: "Permissions Team A",
        }),
      ).rejects.toThrow();

      await caller(ctx(ids.ownerA, ids.teamA)).team.updateMember({
        teamId: ids.teamA,
        userId: ids.memberA,
        role: "member",
      });
    });

    test("an admin cannot touch owners, but the owner can", async () => {
      const admin = caller(ctx(ids.adminA, ids.teamA));

      await expect(
        admin.team.updateMember({
          teamId: ids.teamA,
          userId: ids.ownerA,
          role: "member",
        }),
      ).rejects.toThrow();
      await expect(
        admin.team.deleteMember({ teamId: ids.teamA, userId: ids.ownerA }),
      ).rejects.toThrow();
      expect(await roleOf(ids.teamA, ids.ownerA)).toBe("owner");

      const owner = caller(ctx(ids.ownerA, ids.teamA));
      await expect(
        owner.team.updateMember({
          teamId: ids.teamA,
          userId: ids.adminA,
          role: "member",
        }),
      ).resolves.toBeTruthy();
      expect(await roleOf(ids.teamA, ids.adminA)).toBe("member");

      await owner.team.updateMember({
        teamId: ids.teamA,
        userId: ids.adminA,
        role: "admin",
      });
    });

    test("another workspace's ids cannot be reached", async () => {
      const member = caller(ctx(ids.memberA, ids.teamA));

      await expect(
        member.team.updateMember({
          teamId: ids.teamB,
          userId: ids.ownerB,
          role: "member",
        }),
      ).rejects.toThrow();
      await expect(
        member.team.deleteMember({ teamId: ids.teamB, userId: ids.ownerB }),
      ).rejects.toThrow();
      expect(await roleOf(ids.teamB, ids.ownerB)).toBe("owner");
    });

    test("a stale session for a workspace the user is not in never reads it and recovers to their own", async () => {
      const stale = caller(ctx(ids.memberA, ids.teamB));

      const members = (await stale.team.members()) as {
        user: { id: string };
      }[];
      const memberIds = members.map((member) => member.user.id);
      expect(memberIds).not.toContain(ids.ownerB);
      expect(memberIds).toContain(ids.memberA);

      const current = (await stale.team.current()) as { id: string } | null;
      expect(current?.id).toBe(ids.teamA);
    });
  });

  describe("last owner invariant", () => {
    test("the last owner cannot leave until ownership is transferred", async () => {
      // `teamId: null` keeps the tRPC layer from calling Better Auth's
      // set-active-organization, which needs a real session cookie.
      const owner = caller(ctx(ids.ownerB, null));

      await expect(owner.team.leave({ teamId: ids.teamB })).rejects.toThrow();
      expect(await roleOf(ids.teamB, ids.ownerB)).toBe("owner");

      // Bring a second owner in so the first can leave.
      const promote = await queries.createTeamInvites(db, {
        teamId: ids.teamB,
        actorUserId: ids.ownerB,
        invites: [
          { email: emails.ownerA, role: "owner", invitedBy: ids.ownerB },
        ],
      });
      expect(promote.results).toHaveLength(1);
      await queries.acceptTeamInvite(db, {
        id: (await primaryDb.query.userInvites.findFirst({
          where: (invites, { eq }) => eq(invites.email, emails.ownerA),
          columns: { id: true },
        }))!.id,
        userId: ids.ownerA,
        email: emails.ownerA,
      });
      expect(await roleOf(ids.teamB, ids.ownerA)).toBe("owner");

      await expect(
        owner.team.leave({ teamId: ids.teamB }),
      ).resolves.toBeTruthy();
      expect(await roleOf(ids.teamB, ids.ownerB)).toBeNull();
      expect(await roleOf(ids.teamB, ids.ownerA)).toBe("owner");

      // Restore the original shape: owner B owns team B, owner A does not.
      const restore = await queries.createTeamInvites(db, {
        teamId: ids.teamB,
        actorUserId: ids.ownerA,
        invites: [
          { email: emails.ownerB, role: "owner", invitedBy: ids.ownerA },
        ],
      });
      expect(restore.results).toHaveLength(1);
      await queries.acceptTeamInvite(db, {
        id: (await primaryDb.query.userInvites.findFirst({
          where: (invites, { eq }) => eq(invites.email, emails.ownerB),
          columns: { id: true },
        }))!.id,
        userId: ids.ownerB,
        email: emails.ownerB,
      });
      await queries.deleteTeamMember(db, {
        actorUserId: ids.ownerB,
        teamId: ids.teamB,
        userId: ids.ownerA,
      });
      expect(await roleOf(ids.teamB, ids.ownerB)).toBe("owner");
      expect(await roleOf(ids.teamB, ids.ownerA)).toBeNull();
    });

    test("concurrent demotions never leave the workspace ownerless", async () => {
      const teamId = crypto.randomUUID();
      const first = crypto.randomUUID();
      const second = crypto.randomUUID();

      await primaryDb.insert(schema.teams).values({ id: teamId, name: "Race" });
      await primaryDb.insert(schema.users).values([
        {
          id: first,
          email: `race-1-${teamId}@example.test`,
          fullName: "Race 1",
        },
        {
          id: second,
          email: `race-2-${teamId}@example.test`,
          fullName: "Race 2",
        },
      ]);
      await primaryDb.insert(schema.usersOnTeam).values([
        { teamId, userId: first, role: "owner" },
        { teamId, userId: second, role: "owner" },
      ]);

      const results = await Promise.allSettled([
        queries.updateTeamMember(db, {
          actorUserId: first,
          teamId,
          userId: second,
          role: "member",
        }),
        queries.updateTeamMember(db, {
          actorUserId: second,
          teamId,
          userId: first,
          role: "member",
        }),
      ]);

      const owners = await primaryDb
        .select({ userId: schema.usersOnTeam.userId })
        .from(schema.usersOnTeam)
        .where(
          orm.and(
            orm.eq(schema.usersOnTeam.teamId, teamId),
            orm.eq(schema.usersOnTeam.role, "owner"),
          ),
        );

      // The second transaction re-reads the actor's role under the team lock,
      // so exactly one demotion wins and the workspace keeps an owner.
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
      expect(owners.length).toBeGreaterThanOrEqual(1);

      await primaryDb
        .delete(schema.teams)
        .where(orm.eq(schema.teams.id, teamId));
      await primaryDb
        .delete(schema.users)
        .where(orm.inArray(schema.users.id, [first, second]));
    });
  });

  describe("invitations", () => {
    test("wrong recipient, expired and replayed invitations are rejected", async () => {
      const invite = await queries.createTeamInvites(db, {
        teamId: ids.teamA,
        actorUserId: ids.ownerA,
        invites: [
          { email: emails.invited, role: "member", invitedBy: ids.ownerA },
        ],
      });
      expect(invite.results).toHaveLength(1);
      const inviteId = (await primaryDb.query.userInvites.findFirst({
        where: (invites, { eq }) => eq(invites.email, emails.invited),
        columns: { id: true },
      }))!.id;

      const wrongUser = crypto.randomUUID();
      await primaryDb.insert(schema.users).values({
        id: wrongUser,
        email: `wrong-${ids.teamA}@example.test`,
        fullName: "Wrong Recipient",
      });

      await expect(
        queries.acceptTeamInvite(db, {
          id: inviteId,
          userId: wrongUser,
          email: `wrong-${ids.teamA}@example.test`,
        }),
      ).rejects.toThrow();

      await primaryDb
        .update(schema.userInvites)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(orm.eq(schema.userInvites.id, inviteId));

      await expect(
        queries.acceptTeamInvite(db, {
          id: inviteId,
          userId: wrongUser,
          email: emails.invited,
        }),
      ).rejects.toThrow();

      await primaryDb
        .update(schema.userInvites)
        .set({ expiresAt: new Date(Date.now() + 60_000) })
        .where(orm.eq(schema.userInvites.id, inviteId));

      const invitedUserId = crypto.randomUUID();
      await primaryDb.insert(schema.users).values({
        id: invitedUserId,
        email: emails.invited,
        fullName: "Invited User",
      });

      await expect(
        queries.acceptTeamInvite(db, {
          id: inviteId,
          userId: invitedUserId,
          email: emails.invited,
        }),
      ).resolves.toMatchObject({ teamId: ids.teamA });
      expect(await roleOf(ids.teamA, invitedUserId)).toBe("member");

      // Replay: the invite was consumed by the first accept.
      await expect(
        queries.acceptTeamInvite(db, {
          id: inviteId,
          userId: invitedUserId,
          email: emails.invited,
        }),
      ).rejects.toThrow();

      await primaryDb
        .delete(schema.usersOnTeam)
        .where(
          orm.and(
            orm.eq(schema.usersOnTeam.teamId, ids.teamA),
            orm.eq(schema.usersOnTeam.userId, invitedUserId),
          ),
        );
      await primaryDb
        .delete(schema.users)
        .where(orm.inArray(schema.users.id, [wrongUser, invitedUserId]));
    });

    test("revoked invitations disappear from the recipient's list", async () => {
      const invite = await queries.createTeamInvites(db, {
        teamId: ids.teamA,
        actorUserId: ids.ownerA,
        invites: [
          { email: emails.invited, role: "member", invitedBy: ids.ownerA },
        ],
      });
      const inviteId = (await primaryDb.query.userInvites.findFirst({
        where: (invites, { eq }) => eq(invites.email, emails.invited),
        columns: { id: true },
      }))!.id;

      await primaryDb
        .update(schema.userInvites)
        .set({ status: "revoked" })
        .where(orm.eq(schema.userInvites.id, inviteId));
      expect(invite.results).toHaveLength(1);

      expect(await queries.getInvitesByEmail(db, emails.invited)).toEqual([]);

      await primaryDb
        .delete(schema.userInvites)
        .where(orm.eq(schema.userInvites.id, inviteId));
    });
  });

  describe("inviter-bound invitations", () => {
    // A fresh workspace per test: two owners, an admin and a member, so the
    // shared fixture's roles are never disturbed.
    const seedWorkspace = async (label: string) => {
      const teamId = crypto.randomUUID();
      const user = (role: string) => ({
        id: crypto.randomUUID(),
        email: `${label}-${role}-${teamId}@example.test`,
      });
      const owner = user("owner");
      const secondOwner = user("owner2");
      const admin = user("admin");
      const member = user("member");
      const people = [owner, secondOwner, admin, member];

      await primaryDb.insert(schema.teams).values({ id: teamId, name: label });
      await primaryDb
        .insert(schema.users)
        .values(people.map((p) => ({ ...p, fullName: label, teamId })));
      await primaryDb.insert(schema.usersOnTeam).values([
        { teamId, userId: owner.id, role: "owner" },
        { teamId, userId: secondOwner.id, role: "owner" },
        { teamId, userId: admin.id, role: "admin" },
        { teamId, userId: member.id, role: "member" },
      ]);

      const invitees: string[] = [];

      const invite = async (
        inviterId: string,
        role: "owner" | "admin" | "member",
      ) => {
        const email = `${label}-invitee-${crypto.randomUUID()}@example.test`;
        const created = await queries.createTeamInvites(db, {
          teamId,
          actorUserId: inviterId,
          invites: [{ email, role, invitedBy: inviterId }],
        });
        expect(created.results).toHaveLength(1);

        const inviteeId = crypto.randomUUID();
        await primaryDb
          .insert(schema.users)
          .values({ id: inviteeId, email, fullName: "Invitee" });
        invitees.push(inviteeId);

        const { id } = (await primaryDb.query.userInvites.findFirst({
          where: orm.eq(schema.userInvites.email, email),
          columns: { id: true },
        }))!;

        return { id, email, inviteeId };
      };

      const pendingIds = async () =>
        (
          await primaryDb
            .select({ id: schema.userInvites.id })
            .from(schema.userInvites)
            .where(orm.eq(schema.userInvites.teamId, teamId))
        ).map((row) => row.id);

      const accept = (sent: Awaited<ReturnType<typeof invite>>) =>
        queries.acceptTeamInvite(db, {
          id: sent.id,
          userId: sent.inviteeId,
          email: sent.email,
        });

      const cleanup = async () => {
        await primaryDb
          .delete(schema.teams)
          .where(orm.eq(schema.teams.id, teamId));
        await primaryDb
          .delete(schema.users)
          .where(
            orm.inArray(schema.users.id, [
              ...people.map((p) => p.id),
              ...invitees,
            ]),
          );
      };

      return {
        teamId,
        owner,
        secondOwner,
        admin,
        member,
        invite,
        pendingIds,
        accept,
        cleanup,
      };
    };

    test("removing an inviter revokes their pending invites, and accepting one is refused", async () => {
      const ws = await seedWorkspace("removed-inviter");

      const adminInvite = await ws.invite(ws.admin.id, "admin");
      const memberInvite = await ws.invite(ws.admin.id, "member");
      const ownersInvite = await ws.invite(ws.owner.id, "member");

      await queries.deleteTeamMember(db, {
        teamId: ws.teamId,
        userId: ws.admin.id,
        actorUserId: ws.owner.id,
      });

      expect(await ws.pendingIds()).toEqual([ownersInvite.id]);

      await expect(ws.accept(adminInvite)).rejects.toThrow(/not found/i);
      await expect(ws.accept(memberInvite)).rejects.toThrow(/not found/i);
      expect(await roleOf(ws.teamId, adminInvite.inviteeId)).toBeNull();
      expect(await roleOf(ws.teamId, memberInvite.inviteeId)).toBeNull();

      // Another member's invitation is untouched.
      await expect(ws.accept(ownersInvite)).resolves.toMatchObject({
        role: "member",
      });

      await ws.cleanup();
    });

    test("leaving the workspace revokes the leaver's pending invites", async () => {
      const ws = await seedWorkspace("left-inviter");

      const sent = await ws.invite(ws.admin.id, "admin");

      await queries.leaveTeam(db, { teamId: ws.teamId, userId: ws.admin.id });

      expect(await ws.pendingIds()).toEqual([]);
      await expect(ws.accept(sent)).rejects.toThrow();
      expect(await roleOf(ws.teamId, sent.inviteeId)).toBeNull();

      await ws.cleanup();
    });

    test("demotion revokes only the invites for a role the inviter can no longer grant", async () => {
      const ws = await seedWorkspace("demoted-inviter");

      const ownerRole = await ws.invite(ws.secondOwner.id, "owner");
      const adminRole = await ws.invite(ws.secondOwner.id, "admin");
      const memberRole = await ws.invite(ws.secondOwner.id, "member");

      // Owner -> admin: an admin cannot grant owner.
      await queries.updateTeamMember(db, {
        teamId: ws.teamId,
        userId: ws.secondOwner.id,
        actorUserId: ws.owner.id,
        role: "admin",
      });

      expect((await ws.pendingIds()).sort()).toEqual(
        [adminRole.id, memberRole.id].sort(),
      );
      await expect(ws.accept(ownerRole)).rejects.toThrow(/not found/i);
      expect(await roleOf(ws.teamId, ownerRole.inviteeId)).toBeNull();

      // Admin -> member: a member cannot grant any role.
      await queries.updateTeamMember(db, {
        teamId: ws.teamId,
        userId: ws.secondOwner.id,
        actorUserId: ws.owner.id,
        role: "member",
      });

      expect(await ws.pendingIds()).toEqual([]);
      await expect(ws.accept(adminRole)).rejects.toThrow(/not found/i);
      await expect(ws.accept(memberRole)).rejects.toThrow(/not found/i);
      expect(await roleOf(ws.teamId, adminRole.inviteeId)).toBeNull();
      expect(await roleOf(ws.teamId, memberRole.inviteeId)).toBeNull();

      await ws.cleanup();
    });

    test("a failed membership change leaves the inviter's invites in place", async () => {
      const ws = await seedWorkspace("rolled-back");

      const sent = await ws.invite(ws.admin.id, "admin");

      // A member may not remove an admin; the transaction must not revoke.
      await expect(
        queries.deleteTeamMember(db, {
          teamId: ws.teamId,
          userId: ws.admin.id,
          actorUserId: ws.member.id,
        }),
      ).rejects.toThrow();

      expect(await ws.pendingIds()).toEqual([sent.id]);

      await ws.cleanup();
    });

    test("acceptance refuses an invite whose sender no longer holds the authority", async () => {
      const ws = await seedWorkspace("stale-authority");

      const sent = await ws.invite(ws.admin.id, "admin");

      // Simulate an invite that predates eager revocation: the sender lost the
      // role outside the membership flows, so the row is still pending.
      await primaryDb
        .update(schema.usersOnTeam)
        .set({ role: "member" })
        .where(
          orm.and(
            orm.eq(schema.usersOnTeam.teamId, ws.teamId),
            orm.eq(schema.usersOnTeam.userId, ws.admin.id),
          ),
        );

      await expect(ws.accept(sent)).rejects.toThrow(/revoked/);
      expect(await roleOf(ws.teamId, sent.inviteeId)).toBeNull();

      await ws.cleanup();
    });

    test("owners and admins list pending invites with their sender; members cannot", async () => {
      const ws = await seedWorkspace("invite-list");

      const sent = await ws.invite(ws.admin.id, "member");

      const asActor = (userId: string, email: string) =>
        caller({
          ...ctx(userId, ws.teamId),
          session: {
            user: { id: userId, email, full_name: "Test User" },
            teamId: ws.teamId,
          },
        });

      for (const actor of [ws.owner, ws.admin]) {
        const list = await asActor(actor.id, actor.email).team.teamInvites();
        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({
          id: sent.id,
          email: sent.email,
          role: "member",
          user: { id: ws.admin.id },
        });
        expect(list[0]).not.toHaveProperty("code");
      }

      await expect(
        asActor(ws.member.id, ws.member.email).team.teamInvites(),
      ).rejects.toThrow();

      await asActor(ws.owner.id, ws.owner.email).team.deleteInvite({
        id: sent.id,
      });
      expect(await ws.pendingIds()).toEqual([]);
      await expect(ws.accept(sent)).rejects.toThrow(/not found/i);

      await ws.cleanup();
    });
  });

  describe("API keys", () => {
    test("deletion is effective immediately and foreign ids cannot be updated", async () => {
      const { hash } = await import("@invoicewise/encryption");

      const created = await queries.upsertApiKey(db, {
        name: "Permissions key",
        userId: ids.ownerA,
        teamId: ids.teamA,
        scopes: ["inbox.read"],
      });
      const storedHash = hash(created.key!);

      expect(await queries.getApiKeyByToken(db, storedHash)).toMatchObject({
        teamId: ids.teamA,
      });

      const foreign = await queries.upsertApiKey(db, {
        name: "Foreign key",
        userId: ids.ownerB,
        teamId: ids.teamB,
        scopes: ["inbox.read"],
      });
      const foreignId = (await primaryDb.query.apiKeys.findFirst({
        where: (keys, { eq }) => eq(keys.keyHash, hash(foreign.key!)),
        columns: { id: true },
      }))!.id;

      // A key id from another workspace must not be updateable from this one.
      const crossTenant = await queries.upsertApiKey(db, {
        id: foreignId,
        name: "Renamed from another workspace",
        userId: ids.ownerA,
        teamId: ids.teamA,
        scopes: ["apis.all"],
      });
      expect(crossTenant.keyHash).toBeUndefined();
      expect(
        await primaryDb.query.apiKeys.findFirst({
          where: (keys, { eq }) => eq(keys.id, foreignId),
          columns: { name: true, teamId: true },
        }),
      ).toMatchObject({ name: "Foreign key", teamId: ids.teamB });

      const deletedHash = await queries.deleteApiKey(db, {
        id: (await primaryDb.query.apiKeys.findFirst({
          where: (keys, { eq }) => eq(keys.keyHash, storedHash),
          columns: { id: true },
        }))!.id,
        teamId: ids.teamA,
      });
      expect(deletedHash).toBe(storedHash);
      expect(await queries.getApiKeyByToken(db, storedHash)).toBeUndefined();

      await primaryDb
        .delete(schema.apiKeys)
        .where(orm.eq(schema.apiKeys.id, foreignId));
    });
  });

  describe("account deletion and invitation state", () => {
    test("account deletion: sole owner blocked, shared member allowed", async () => {
      const seedTeam = async (label: string) => {
        const teamId = crypto.randomUUID();
        const ownerId = crypto.randomUUID();
        const memberId = crypto.randomUUID();

        await primaryDb
          .insert(schema.teams)
          .values({ id: teamId, name: label });
        await primaryDb.insert(schema.users).values([
          {
            id: ownerId,
            email: `owner-${teamId}@example.test`,
            fullName: "Owner",
          },
          {
            id: memberId,
            email: `member-${teamId}@example.test`,
            fullName: "Member",
          },
        ]);
        await primaryDb.insert(schema.usersOnTeam).values([
          { teamId, userId: ownerId, role: "owner" },
          { teamId, userId: memberId, role: "member" },
        ]);

        return { teamId, ownerId, memberId };
      };

      const cleanupTeam = async (teamId: string, userIds: string[]) => {
        await primaryDb
          .delete(schema.teams)
          .where(orm.eq(schema.teams.id, teamId));
        await primaryDb
          .delete(schema.users)
          .where(orm.inArray(schema.users.id, userIds));
      };

      const soleOwner = await seedTeam("Sole owner");

      await expect(queries.deleteUser(db, soleOwner.ownerId)).rejects.toThrow(
        /Transfer ownership/,
      );
      expect(
        await primaryDb.query.users.findFirst({
          where: orm.eq(schema.users.id, soleOwner.ownerId),
          columns: { id: true },
        }),
      ).toBeTruthy();
      expect(await roleOf(soleOwner.teamId, soleOwner.ownerId)).toBe("owner");
      expect(await roleOf(soleOwner.teamId, soleOwner.memberId)).toBe("member");

      await cleanupTeam(soleOwner.teamId, [
        soleOwner.ownerId,
        soleOwner.memberId,
      ]);

      const shared = await seedTeam("Shared workspace");

      await expect(
        queries.deleteUser(db, shared.memberId),
      ).resolves.toMatchObject({
        id: shared.memberId,
      });

      // The person is gone, the workspace and its other members are not.
      expect(
        await primaryDb.query.users.findFirst({
          where: orm.eq(schema.users.id, shared.memberId),
          columns: { id: true },
        }),
      ).toBeUndefined();
      expect(await queries.getTeamById(db, shared.teamId)).toMatchObject({
        id: shared.teamId,
      });
      expect(await roleOf(shared.teamId, shared.ownerId)).toBe("owner");
      expect(await roleOf(shared.teamId, shared.memberId)).toBeNull();

      await cleanupTeam(shared.teamId, [shared.ownerId]);
    });

    test("invitations: concurrent accept consumes once, revoked is rejected", async () => {
      const seedInvite = async (label: string) => {
        const teamId = crypto.randomUUID();
        const ownerId = crypto.randomUUID();
        const inviteeId = crypto.randomUUID();
        const email = `${label}-${teamId}@example.test`;

        await primaryDb
          .insert(schema.teams)
          .values({ id: teamId, name: label });
        await primaryDb.insert(schema.users).values([
          {
            id: ownerId,
            email: `owner-${teamId}@example.test`,
            fullName: "Owner",
          },
          { id: inviteeId, email, fullName: "Invitee" },
        ]);
        await primaryDb
          .insert(schema.usersOnTeam)
          .values({ teamId, userId: ownerId, role: "owner" });

        await queries.createTeamInvites(db, {
          teamId,
          actorUserId: ownerId,
          invites: [{ email, role: "member", invitedBy: ownerId }],
        });

        const inviteId = (await primaryDb.query.userInvites.findFirst({
          where: orm.eq(schema.userInvites.email, email),
          columns: { id: true },
        }))!.id;

        const cleanup = async () => {
          await primaryDb
            .delete(schema.teams)
            .where(orm.eq(schema.teams.id, teamId));
          await primaryDb
            .delete(schema.users)
            .where(orm.inArray(schema.users.id, [ownerId, inviteeId]));
        };

        return { teamId, ownerId, inviteeId, email, inviteId, cleanup };
      };

      const concurrent = await seedInvite("concurrent");

      const results = await Promise.allSettled([
        queries.acceptTeamInvite(db, {
          id: concurrent.inviteId,
          userId: concurrent.inviteeId,
          email: concurrent.email,
        }),
        queries.acceptTeamInvite(db, {
          id: concurrent.inviteId,
          userId: concurrent.inviteeId,
          email: concurrent.email,
        }),
      ]);

      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);

      const memberships = await primaryDb
        .select({ id: schema.usersOnTeam.id })
        .from(schema.usersOnTeam)
        .where(
          orm.and(
            orm.eq(schema.usersOnTeam.teamId, concurrent.teamId),
            orm.eq(schema.usersOnTeam.userId, concurrent.inviteeId),
          ),
        );

      expect(memberships).toHaveLength(1);
      expect(
        await primaryDb.query.userInvites.findFirst({
          where: orm.eq(schema.userInvites.id, concurrent.inviteId),
          columns: { id: true },
        }),
      ).toBeUndefined();

      await concurrent.cleanup();

      const revoked = await seedInvite("revoked");

      await primaryDb
        .update(schema.userInvites)
        .set({ status: "revoked" })
        .where(orm.eq(schema.userInvites.id, revoked.inviteId));

      // The row still exists at locate time; the locked read must reject it.
      await expect(
        queries.acceptTeamInvite(db, {
          id: revoked.inviteId,
          userId: revoked.inviteeId,
          email: revoked.email,
        }),
      ).rejects.toThrow(/revoked/);
      expect(await roleOf(revoked.teamId, revoked.inviteeId)).toBeNull();

      await revoked.cleanup();
    });
  });

  describe("REST auth middleware", () => {
    test("keys are re-read per request and revocation takes effect immediately", async () => {
      const { Hono } = await import("hono");
      const { protectedMiddleware } = await import("@api/rest/middleware");

      const app = new Hono<{
        Variables: { teamId: string; scopes: string[] };
      }>();
      app.use("*", ...protectedMiddleware);
      app.get("/probe", (c) =>
        c.json({ teamId: c.get("teamId"), scopes: c.get("scopes") }),
      );

      const created = await queries.upsertApiKey(db, {
        name: "REST owner key",
        userId: ids.ownerA,
        teamId: ids.teamA,
        scopes: ["inbox.write"],
      });

      const ok = await app.request("/probe", {
        headers: { Authorization: `Bearer ${created.key}` },
      });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({
        teamId: ids.teamA,
        scopes: expect.arrayContaining(["inbox.write"]),
      });

      // A legacy/foreign key carrying write scopes for a member is clamped.
      const memberKey = await queries.upsertApiKey(db, {
        name: "Member legacy key",
        userId: ids.memberA,
        teamId: ids.teamA,
        scopes: ["apis.all"],
      });
      const memberProbe = await app.request("/probe", {
        headers: { Authorization: `Bearer ${memberKey.key}` },
      });
      expect(memberProbe.status).toBe(200);
      const memberBody = (await memberProbe.json()) as { scopes: string[] };
      // Member keeps invoice use, but never workspace management.
      expect(memberBody.scopes).toContain("inbox.write");
      expect(memberBody.scopes).toContain("inbox.read");
      expect(memberBody.scopes).not.toContain("teams.write");
      expect(memberBody.scopes).not.toContain("users.write");

      // Removing the member revokes the key and denies the next request.
      await queries.deleteTeamMember(db, {
        actorUserId: ids.ownerA,
        teamId: ids.teamA,
        userId: ids.memberA,
      });
      const removed = await app.request("/probe", {
        headers: { Authorization: `Bearer ${memberKey.key}` },
      });
      expect(removed.status).toBe(401);

      // Deleting a live key stops it on the very next request.
      const { hash: hashKey } = await import("@invoicewise/encryption");
      await queries.deleteApiKey(db, {
        id: (await primaryDb.query.apiKeys.findFirst({
          where: (keys, { eq }) => eq(keys.keyHash, hashKey(created.key!)),
          columns: { id: true },
        }))!.id,
        teamId: ids.teamA,
      });
      const revoked = await app.request("/probe", {
        headers: { Authorization: `Bearer ${created.key}` },
      });
      expect(revoked.status).toBe(401);

      // A key for another workspace resolves to that workspace, never ours.
      const otherKey = await queries.upsertApiKey(db, {
        name: "Team B key",
        userId: ids.ownerB,
        teamId: ids.teamB,
        scopes: ["inbox.read"],
      });
      const other = await app.request("/probe", {
        headers: { Authorization: `Bearer ${otherKey.key}` },
      });
      expect(other.status).toBe(200);
      expect(await other.json()).toMatchObject({ teamId: ids.teamB });
    });
  });

  describe("native Better Auth mutation surface", () => {
    test("organization membership mutations are disabled", async () => {
      const { auth } = await import("@api/auth");

      for (const path of [
        "organization/update-member-role",
        "organization/remove-member",
        "organization/invite-member",
        "organization/accept-invitation",
        "organization/leave",
        "organization/update",
      ]) {
        const response = await auth.handler(
          new Request(`http://localhost:3001/api/auth/${path}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              origin: "http://localhost:3001",
            },
            body: JSON.stringify({}),
          }),
        );

        expect(response.status).toBe(403);
        expect(await response.text()).toContain("workspace API");
      }

      // Read and active-workspace endpoints stay available.
      const list = await auth.handler(
        new Request("http://localhost:3001/api/auth/organization/list", {
          method: "GET",
        }),
      );
      expect([200, 401]).toContain(list.status);
    });
  });
});
