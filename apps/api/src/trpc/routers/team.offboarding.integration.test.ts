/**
 * Offboarding checks for roadmap issue #35: account removal, workspace deletion
 * and the resumable cleanup behind them, against a disposable Postgres
 * database.
 *
 *   cd apps/api && PERMISSIONS_TEST_DATABASE_URL=postgresql://invoicewise:invoicewise@localhost:5432/invoicewise_perms_test \
 *     bun test src/trpc/routers/team.offboarding.integration.test.ts
 *
 * Provider revocation is injected; nothing leaves the machine. Private objects
 * go to a temporary local storage root.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database, PrimaryDatabase } from "@invoicewise/db/client";
import type { DeletionConnection } from "@invoicewise/db/schema";

const testDatabaseUrl = process.env.PERMISSIONS_TEST_DATABASE_URL;

// Must be set before the database client and auth modules are imported.
if (testDatabaseUrl) {
  process.env.DATABASE_PRIMARY_URL = testDatabaseUrl;
  process.env.BETTER_AUTH_SECRET ??= "offboarding-integration-test-secret";
  process.env.BETTER_AUTH_URL ??= "http://localhost:3001";
  // Placeholders only: the suite never calls a provider.
  process.env.RESEND_API_KEY ??= "re_offboarding_integration_test";
  process.env.POLAR_ACCESS_TOKEN ??= "polar_offboarding_integration_test";
  process.env.REDIS_URL ??= "redis://localhost:6379";
  process.env.MIDDAY_ENCRYPTION_KEY ??=
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  process.env.NODE_ENV ??= "test";
}

const suite = testDatabaseUrl ? describe : describe.skip;

suite("offboarding (integration)", () => {
  let db: Database;
  let primaryDb: PrimaryDatabase;
  let queries: typeof import("@invoicewise/db/queries");
  let schema: typeof import("@invoicewise/db/schema");
  let orm: typeof import("drizzle-orm");
  let deletion: typeof import("@invoicewise/jobs/deletion");
  let storageModule: typeof import("@invoicewise/db/storage");
  let caller: (ctx: any) => Record<string, any>;
  let storageRoot: string;

  const createdTeams: string[] = [];
  const createdUsers: string[] = [];

  beforeAll(async () => {
    const client = await import("@invoicewise/db/client");
    schema = await import("@invoicewise/db/schema");
    orm = await import("drizzle-orm");
    queries = await import("@invoicewise/db/queries");
    deletion = await import("@invoicewise/jobs/deletion");
    storageModule = await import("@invoicewise/db/storage");
    const { appRouter } = await import("@api/trpc/routers/_app");
    const { createCallerFactory } = await import("@api/trpc/init");

    db = client.db;
    primaryDb = client.primaryDb;
    caller = createCallerFactory(appRouter);
    storageRoot = await mkdtemp(join(tmpdir(), "invoicewise-offboarding-"));
  });

  afterAll(async () => {
    if (!primaryDb) return;
    if (createdTeams.length) {
      await primaryDb
        .delete(schema.teams)
        .where(orm.inArray(schema.teams.id, createdTeams));
    }
    if (createdUsers.length) {
      await primaryDb
        .delete(schema.users)
        .where(orm.inArray(schema.users.id, createdUsers));
    }
    await primaryDb
      .delete(schema.deletionRequests)
      .where(
        orm.inArray(schema.deletionRequests.subjectId, [
          ...createdTeams,
          ...createdUsers,
        ]),
      );
    await rm(storageRoot, { recursive: true, force: true });
  });

  const seedUser = async (label: string, teamId: string | null = null) => {
    const id = crypto.randomUUID();
    const email = `${label}-${id}@example.test`;
    await primaryDb
      .insert(schema.users)
      .values({ id, email, fullName: label, teamId });
    createdUsers.push(id);
    return { id, email };
  };

  const seedTeam = async (
    name: string,
    members: { userId: string; role: "owner" | "admin" | "member" }[],
  ) => {
    const id = crypto.randomUUID();
    await primaryDb.insert(schema.teams).values({ id, name });
    createdTeams.push(id);
    if (members.length) {
      await primaryDb
        .insert(schema.usersOnTeam)
        .values(members.map((member) => ({ ...member, teamId: id })));
    }
    return id;
  };

  const seedInvoices = async (teamId: string, count: number) => {
    const ids = Array.from({ length: count }, () => crypto.randomUUID());
    await primaryDb.insert(schema.inbox).values(
      ids.map((id) => ({
        id,
        teamId,
        filePath: [teamId, "inbox", id, "invoice.pdf"],
        fileName: "invoice.pdf",
        displayName: `Invoice ${id}`,
        contentType: "application/pdf",
        size: 1,
        status: "done" as const,
      })),
    );
    return ids;
  };

  const ctx = (user: { id: string; email: string }, teamId: string | null) => ({
    session: {
      user: { id: user.id, email: user.email, full_name: "Test User" },
      teamId,
    },
    db,
    geo: { ip: "127.0.0.1", country: null, locale: null, timezone: null },
    requestHeaders: new Headers(),
  });

  const rowsNamingTeam = async (teamId: string) => {
    // Every table with a `team_id` column, so a table added later cannot be
    // silently left behind by workspace deletion.
    const tables = (await primaryDb.execute(orm.sql`
      select table_name from information_schema.columns
      where table_schema = 'public' and column_name = 'team_id'
    `)) as unknown as { rows: { table_name: string }[] };

    const leftovers: Record<string, number> = {};
    for (const { table_name } of tables.rows) {
      const result = (await primaryDb.execute(
        orm.sql`select count(*)::int as count from ${orm.sql.identifier(
          table_name,
        )} where team_id = ${teamId}`,
      )) as unknown as { rows: { count: number }[] };
      const count = result.rows[0]?.count ?? 0;
      if (count > 0) leftovers[table_name] = count;
    }
    return leftovers;
  };

  const deletionRequestFor = async (subjectId: string) =>
    primaryDb.query.deletionRequests.findFirst({
      where: orm.eq(schema.deletionRequests.subjectId, subjectId),
    });

  describe("account deletion", () => {
    test("deleting one of two users keeps the survivor's workspace, invoices and access", async () => {
      const survivor = await seedUser("survivor");
      const leaver = await seedUser("leaver");
      const teamId = await seedTeam("Two person workspace", [
        { userId: survivor.id, role: "owner" },
        { userId: leaver.id, role: "member" },
      ]);
      await primaryDb
        .update(schema.users)
        .set({ teamId })
        .where(orm.inArray(schema.users.id, [survivor.id, leaver.id]));
      const invoiceIds = await seedInvoices(teamId, 3);

      const before = await caller(ctx(survivor, teamId)).inbox.get({
        pageSize: 100,
      });
      expect(before.data.map((row: { id: string }) => row.id).sort()).toEqual(
        [...invoiceIds].sort(),
      );

      const result = await queries.deleteUser(db, leaver.id);
      expect(result).toMatchObject({ id: leaver.id });

      // The leaver's identity and membership are gone.
      expect(
        await primaryDb.query.users.findFirst({
          where: orm.eq(schema.users.id, leaver.id),
          columns: { id: true },
        }),
      ).toBeUndefined();
      expect(await queries.getTeamRole(db, teamId, leaver.id)).toBeNull();

      // The workspace, its invoices and the survivor's access are untouched.
      expect(await queries.getTeamById(db, teamId)).toMatchObject({
        id: teamId,
      });
      expect(await queries.getTeamRole(db, teamId, survivor.id)).toBe("owner");
      const after = await caller(ctx(survivor, teamId)).inbox.get({
        pageSize: 100,
      });
      expect(after.data.map((row: { id: string }) => row.id).sort()).toEqual(
        [...invoiceIds].sort(),
      );
      expect((await caller(ctx(survivor, teamId)).team.current()).id).toBe(
        teamId,
      );

      // The account's own cleanup is durable and queued, but never names the
      // shared workspace.
      const request = await deletionRequestFor(leaver.id);
      expect(request).toMatchObject({
        subject: "account",
        status: "pending",
        connections: [],
      });
      expect(await deletionRequestFor(teamId)).toBeUndefined();
    });

    test("an owner in several workspaces must transfer the sole-owned one first", async () => {
      const owner = await seedUser("multi-owner");
      const coOwner = await seedUser("co-owner");
      const successor = await seedUser("successor");
      const colleague = await seedUser("colleague");

      const coOwned = await seedTeam("Co-owned workspace", [
        { userId: owner.id, role: "owner" },
        { userId: coOwner.id, role: "owner" },
      ]);
      const soleOwned = await seedTeam("Sole-owned workspace", [
        { userId: owner.id, role: "owner" },
        { userId: successor.id, role: "member" },
      ]);
      const joined = await seedTeam("Joined workspace", [
        { userId: colleague.id, role: "owner" },
        { userId: owner.id, role: "member" },
      ]);
      await seedInvoices(soleOwned, 2);

      await expect(queries.deleteUser(db, owner.id)).rejects.toThrow(
        /Transfer ownership/,
      );
      expect(await queries.getTeamRole(db, soleOwned, owner.id)).toBe("owner");
      expect(await queries.getTeamRole(db, coOwned, owner.id)).toBe("owner");
      expect(await deletionRequestFor(owner.id)).toBeUndefined();

      await queries.updateTeamMember(db, {
        actorUserId: owner.id,
        teamId: soleOwned,
        userId: successor.id,
        role: "owner",
      });

      await expect(queries.deleteUser(db, owner.id)).resolves.toMatchObject({
        id: owner.id,
      });

      // Every workspace survives with its remaining members.
      for (const [teamId, userId] of [
        [coOwned, coOwner.id],
        [soleOwned, successor.id],
        [joined, colleague.id],
      ] as const) {
        expect(await queries.getTeamById(db, teamId)).toMatchObject({
          id: teamId,
        });
        expect(await queries.getTeamRole(db, teamId, userId)).toBe("owner");
        expect(await queries.getTeamRole(db, teamId, owner.id)).toBeNull();
      }
      const invoices = await primaryDb
        .select({ id: schema.inbox.id })
        .from(schema.inbox)
        .where(orm.eq(schema.inbox.teamId, soleOwned));
      expect(invoices).toHaveLength(2);
    });
  });

  describe("sole owner of a single workspace (#97)", () => {
    test("deletes their unshared workspace with their account in one confirmed step", async () => {
      const soloist = await seedUser("soloist");
      const teamId = await seedTeam("Solo Ltd", [
        { userId: soloist.id, role: "owner" },
      ]);
      await primaryDb
        .update(schema.users)
        .set({ teamId })
        .where(orm.eq(schema.users.id, soloist.id));
      await seedInvoices(teamId, 2);
      const api = caller(ctx(soloist, teamId));

      expect(await api.user.soleOwnedWorkspaces()).toEqual([
        {
          id: teamId,
          name: "Solo Ltd",
          confirmation: "Solo Ltd",
          shared: false,
        },
      ]);

      // Without naming the workspace back, nothing is deleted.
      await expect(api.user.delete()).rejects.toMatchObject({
        code: "CONFLICT",
      });
      for (const confirmName of ["DELETE", "solo ltd", ""]) {
        await expect(
          api.user.delete({ deleteWorkspaces: [{ teamId, confirmName }] }),
        ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      }
      expect(await queries.getTeamById(db, teamId)).toMatchObject({
        id: teamId,
      });
      expect(await queries.getTeamRole(db, teamId, soloist.id)).toBe("owner");
      expect(await deletionRequestFor(teamId)).toBeUndefined();
      expect(await deletionRequestFor(soloist.id)).toBeUndefined();

      const result = await api.user.delete({
        deleteWorkspaces: [{ teamId, confirmName: " Solo Ltd " }],
      });
      expect(result).toMatchObject({
        id: soloist.id,
        deletedWorkspaces: [teamId],
      });

      // Account and workspace are both gone, exactly as each deletion alone
      // would leave them, and each has its own durable cleanup.
      expect(
        await primaryDb.query.users.findFirst({
          where: orm.eq(schema.users.id, soloist.id),
          columns: { id: true },
        }),
      ).toBeUndefined();
      expect(await queries.getTeamById(db, teamId)).toBeUndefined();
      expect(await rowsNamingTeam(teamId)).toEqual({});
      expect(await deletionRequestFor(teamId)).toMatchObject({
        subject: "workspace",
        status: "pending",
      });
      expect(await deletionRequestFor(soloist.id)).toMatchObject({
        subject: "account",
        status: "pending",
      });
    });

    test("a shared or co-owned workspace is never deleted with the account", async () => {
      const owner = await seedUser("shared-sole-owner");
      const member = await seedUser("shared-member");
      const coOwner = await seedUser("shared-co-owner");
      const shared = await seedTeam("Shared Ltd", [
        { userId: owner.id, role: "owner" },
        { userId: member.id, role: "member" },
      ]);
      const coOwned = await seedTeam("Co-owned Ltd", [
        { userId: owner.id, role: "owner" },
        { userId: coOwner.id, role: "owner" },
      ]);
      const api = caller(ctx(owner, shared));

      expect(await api.user.soleOwnedWorkspaces()).toEqual([
        {
          id: shared,
          name: "Shared Ltd",
          confirmation: "Shared Ltd",
          shared: true,
        },
      ]);

      await expect(
        api.user.delete({
          deleteWorkspaces: [{ teamId: shared, confirmName: "Shared Ltd" }],
        }),
      ).rejects.toMatchObject({
        code: "CONFLICT",
        message: expect.stringMatching(/Transfer ownership/),
      });
      await expect(
        api.user.delete({
          deleteWorkspaces: [{ teamId: coOwned, confirmName: "Co-owned Ltd" }],
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });

      for (const teamId of [shared, coOwned]) {
        expect(await queries.getTeamById(db, teamId)).toMatchObject({
          id: teamId,
        });
        expect(await queries.getTeamRole(db, teamId, owner.id)).toBe("owner");
        expect(await deletionRequestFor(teamId)).toBeUndefined();
      }
      expect(await queries.getTeamRole(db, shared, member.id)).toBe("member");
      expect(await deletionRequestFor(owner.id)).toBeUndefined();
    });

    test("someone who already deleted their last workspace can still delete their account", async () => {
      const stranded = await seedUser("stranded");
      const teamId = await seedTeam("Deleted first", [
        { userId: stranded.id, role: "owner" },
      ]);
      await queries.deleteTeam(db, {
        teamId,
        userId: stranded.id,
        confirmName: "Deleted first",
      });
      const api = caller(ctx(stranded, null));

      expect(await api.user.soleOwnedWorkspaces()).toEqual([]);
      await expect(api.user.delete()).resolves.toMatchObject({
        id: stranded.id,
        deletedWorkspaces: [],
      });
      expect(await deletionRequestFor(stranded.id)).toMatchObject({
        subject: "account",
      });
    });
  });

  describe("workspace deletion", () => {
    test("is owner-only and needs the workspace named back", async () => {
      const owner = await seedUser("confirm-owner");
      const admin = await seedUser("confirm-admin");
      const teamId = await seedTeam("Acme Ltd", [
        { userId: owner.id, role: "owner" },
        { userId: admin.id, role: "admin" },
      ]);

      await expect(
        queries.deleteTeam(db, {
          teamId,
          userId: admin.id,
          confirmName: "Acme Ltd",
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });

      for (const confirmName of ["DELETE", "acme ltd", "Acme", ""]) {
        await expect(
          caller(ctx(owner, teamId)).team.delete({ teamId, confirmName }),
        ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      }
      expect(await queries.getTeamById(db, teamId)).toMatchObject({
        id: teamId,
      });
      expect(await deletionRequestFor(teamId)).toBeUndefined();

      await expect(
        caller(ctx(owner, teamId)).team.delete({
          teamId,
          confirmName: "  Acme Ltd ",
        }),
      ).resolves.toMatchObject({ id: teamId });
      expect(await queries.getTeamById(db, teamId)).toBeUndefined();
    });

    test("revokes access at once and leaves nothing that can recreate data", async () => {
      const owner = await seedUser("revoke-owner");
      const member = await seedUser("revoke-member");
      const teamId = await seedTeam("Doomed workspace", [
        { userId: owner.id, role: "owner" },
        { userId: member.id, role: "member" },
      ]);
      const otherTeam = await seedTeam("Member's other workspace", [
        { userId: member.id, role: "owner" },
      ]);
      await primaryDb
        .update(schema.users)
        .set({ teamId })
        .where(orm.inArray(schema.users.id, [owner.id, member.id]));

      await seedInvoices(teamId, 2);
      const sessionId = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
      await primaryDb.insert(schema.authSessions).values({
        id: sessionId,
        token: `offboarding-${sessionId}`,
        expiresAt,
        createdAt: new Date(),
        updatedAt: new Date(),
        userId: member.id,
        activeOrganizationId: teamId,
      });
      await primaryDb.insert(schema.apiKeys).values({
        keyEncrypted: "encrypted",
        name: "Doomed key",
        userId: owner.id,
        teamId,
        keyHash: `hash-${teamId}`,
      });
      const mailboxId = crypto.randomUUID();
      await primaryDb.insert(schema.inboxAccounts).values({
        id: mailboxId,
        teamId,
        provider: "gmail",
        externalId: `external-${mailboxId}`,
        email: `mailbox-${mailboxId}@example.test`,
        accessToken: "stub-access-token",
        refreshToken: "stub-refresh-token",
        expiryDate: "2030-01-01T00:00:00.000Z",
        lastAccessed: new Date().toISOString(),
      });
      await primaryDb.insert(schema.accountingConnections).values({
        teamId,
        provider: "xero",
        integrationId: "xero-test",
        connectionId: `connection-${teamId}`,
      });
      const leaseExpiresAt = new Date(Date.now() + 60 * 60 * 1000);
      await primaryDb.insert(schema.workflowJobs).values([
        {
          name: "process-attachment",
          teamId,
          payload: { teamId },
          idempotencyKey: `queued-${teamId}`,
        },
        {
          name: "process-attachment",
          teamId,
          payload: { teamId },
          idempotencyKey: `running-${teamId}`,
          status: "running",
          leaseExpiresAt: leaseExpiresAt.toISOString(),
        },
      ]);

      const result = await queries.deleteTeam(db, {
        teamId,
        userId: owner.id,
        confirmName: "Doomed workspace",
      });
      expect(result).toMatchObject({ id: teamId });

      // Tenant-wide: no row anywhere still names the workspace — invoices,
      // keys, mailbox and accounting records, and queued or retrying jobs.
      expect(await rowsNamingTeam(teamId)).toEqual({});

      // Sessions and stored pointers move off the workspace immediately.
      const session = await primaryDb.query.authSessions.findFirst({
        where: orm.eq(schema.authSessions.id, sessionId),
      });
      expect(session?.activeOrganizationId).toBe(otherTeam);
      const pointers = await primaryDb
        .select({ id: schema.users.id, teamId: schema.users.teamId })
        .from(schema.users)
        .where(orm.inArray(schema.users.id, [owner.id, member.id]));
      expect(pointers.every((row) => row.teamId !== teamId)).toBe(true);
      await expect(
        caller(ctx(member, teamId)).inbox.get({ pageSize: 10 }),
      ).resolves.toMatchObject({ data: [] });

      // Cleanup is recorded durably with the connections to revoke, and waits
      // for the running job's lease before purging objects.
      const request = await deletionRequestFor(teamId);
      expect(request).toMatchObject({
        id: result.deletionRequestId,
        subject: "workspace",
        requestedBy: owner.id,
        status: "pending",
      });
      expect(request?.connections).toEqual([
        {
          kind: "accounting",
          provider: "xero",
          connectionId: `connection-${teamId}`,
          integrationId: "xero-test",
        },
        {
          kind: "mailbox",
          provider: "gmail",
          accountId: mailboxId,
          refreshToken: "stub-refresh-token",
        },
      ]);
      expect(Date.parse(request!.quiesceUntil)).toBeGreaterThanOrEqual(
        leaseExpiresAt.getTime(),
      );
      const purgeJobs = await primaryDb
        .select()
        .from(schema.workflowJobs)
        .where(
          orm.eq(schema.workflowJobs.name, queries.PURGE_DELETED_DATA_WORKFLOW),
        );
      expect(
        purgeJobs.find(
          (job) => job.payload.deletionId === result.deletionRequestId,
        ),
      ).toMatchObject({ status: "queued", teamId: null });

      // Late writers — a job that was already running, a provider callback,
      // incoming mail — fail on the removed workspace instead of recreating it.
      await expect(
        primaryDb
          .insert(schema.inbox)
          .values({
            teamId,
            filePath: [teamId, "inbox", "late.pdf"],
            fileName: "late.pdf",
            contentType: "application/pdf",
            size: 1,
          })
          .execute(),
      ).rejects.toThrow();
      await expect(
        queries.enqueueWorkflowJob(db, {
          name: "process-attachment",
          teamId,
          payload: { teamId },
          idempotencyKey: `late-${teamId}`,
        }),
      ).rejects.toThrow();
      await expect(
        primaryDb
          .insert(schema.accountingConnections)
          .values({
            teamId,
            provider: "xero",
            integrationId: "xero-test",
            connectionId: `late-${teamId}`,
          })
          .execute(),
      ).rejects.toThrow();
      expect(await rowsNamingTeam(teamId)).toEqual({});
    });

    test("a membership change racing deletion never outlives the workspace", async () => {
      const owner = await seedUser("race-owner");
      const invitee = await seedUser("race-invitee");
      const teamId = await seedTeam("Racing workspace", [
        { userId: owner.id, role: "owner" },
      ]);
      await queries.createTeamInvites(db, {
        teamId,
        actorUserId: owner.id,
        invites: [
          { email: invitee.email, role: "member", invitedBy: owner.id },
        ],
      });
      const inviteId = (await primaryDb.query.userInvites.findFirst({
        where: orm.eq(schema.userInvites.email, invitee.email),
        columns: { id: true },
      }))!.id;

      // Hold the team row so the deletion and the acceptance queue behind it.
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

      const settled = <T>(promise: Promise<T>) =>
        promise.then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );

      const removal = settled(
        queries.deleteTeam(db, {
          teamId,
          userId: owner.id,
          confirmName: "Racing workspace",
        }),
      );
      await Bun.sleep(150);
      const acceptance = settled(
        queries.acceptTeamInvite(db, {
          id: inviteId,
          userId: invitee.id,
          email: invitee.email,
        }),
      );
      await Bun.sleep(150);

      release();
      await holder;

      expect((await removal).ok).toBe(true);
      expect((await acceptance).ok).toBe(false);
      expect(await rowsNamingTeam(teamId)).toEqual({});
      const inviteeRow = await primaryDb.query.users.findFirst({
        where: orm.eq(schema.users.id, invitee.id),
        columns: { teamId: true },
      });
      expect(inviteeRow?.teamId).not.toBe(teamId);
    });
  });

  describe("resumable cleanup", () => {
    test("an interrupted cleanup keeps the request and resumes where it stopped", async () => {
      const storage = storageModule.createStorageClient({
        backend: "local",
        rootPath: storageRoot,
        signingSecret: "offboarding-test-secret",
        publicUrl: "http://localhost:3003",
      });

      const owner = await seedUser("cleanup-owner");
      const neighbour = await seedUser("cleanup-neighbour");
      const teamId = await seedTeam("Cleanup workspace", [
        { userId: owner.id, role: "owner" },
      ]);
      const neighbourTeam = await seedTeam("Neighbour workspace", [
        { userId: neighbour.id, role: "owner" },
      ]);
      await primaryDb.insert(schema.accountingConnections).values({
        teamId,
        provider: "quickbooks",
        integrationId: "quickbooks-test",
        connectionId: `qb-${teamId}`,
      });
      const mailboxId = crypto.randomUUID();
      await primaryDb.insert(schema.inboxAccounts).values({
        id: mailboxId,
        teamId,
        provider: "outlook",
        externalId: `external-${mailboxId}`,
        email: `mailbox-${mailboxId}@example.test`,
        accessToken: "stub-access-token",
        refreshToken: "stub-refresh-token",
        expiryDate: "2030-01-01T00:00:00.000Z",
        lastAccessed: new Date().toISOString(),
      });

      const put = (path: string[]) =>
        storage.upload({ bucket: "vault", path, file: Buffer.from("pdf") });
      const doomedObject = [teamId, "inbox", "one", "invoice.pdf"];
      const doomedLogo = [teamId, "assets", "logo", "two", "logo.png"];
      const neighbourObject = [neighbourTeam, "inbox", "three", "invoice.pdf"];
      await put(doomedObject);
      await put(doomedLogo);
      await put(neighbourObject);

      const { deletionRequestId } = await queries.deleteTeam(db, {
        teamId,
        userId: owner.id,
        confirmName: "Cleanup workspace",
      });

      const revoked: string[] = [];
      let failRevocation = true;
      let failStorage = false;
      const deps = (now: Date) => ({
        db,
        now: () => now,
        revokeConnection: async (connection: DeletionConnection) => {
          if (connection.kind === "mailbox" && failRevocation) {
            throw new Error("provider unavailable");
          }
          revoked.push(connection.kind);
        },
        storage: {
          removePrefix: async (input: { bucket: string; prefix: string[] }) => {
            if (failStorage) throw new Error("storage unavailable");
            await storage.removePrefix(input);
          },
        },
      });
      const request = () =>
        queries.getDeletionRequest(primaryDb, deletionRequestId);
      const exists = (path: string[]) =>
        storage.download({ bucket: "vault", path }).then(
          () => true,
          () => false,
        );

      // Run 1: the accounting connection is revoked, then the mailbox fails.
      await expect(
        deletion.runDeletionCleanup(deps(new Date()), deletionRequestId),
      ).rejects.toThrow(/Unable to revoke mailbox connection/);
      let state = await request();
      expect(state).toMatchObject({ status: "pending", attempts: 1 });
      expect(state?.connections[0]?.revokedAt).toBeString();
      expect(state?.connections[1]?.revokedAt).toBeUndefined();
      expect(state?.connectionsRevokedAt).toBeNull();
      expect(revoked).toEqual(["accounting"]);

      // The job gives up: the request is marked failed for operators, with
      // its progress and the reason kept.
      await queries.recordDeletionFailure(primaryDb, {
        id: deletionRequestId,
        error: "Unable to revoke mailbox connection (outlook)",
        final: true,
      });
      await primaryDb
        .update(schema.workflowJobs)
        .set({ status: "failed" })
        .where(
          orm.sql`${schema.workflowJobs.payload} ->> 'deletionId' = ${deletionRequestId}`,
        );
      state = await request();
      expect(state).toMatchObject({
        status: "failed",
        lastError: "Unable to revoke mailbox connection (outlook)",
      });

      // An operator resumes it once; a second resume finds a live job.
      expect(await queries.resumeDeletionRequests(primaryDb)).toContain(
        deletionRequestId,
      );
      expect(await queries.resumeDeletionRequests(primaryDb)).not.toContain(
        deletionRequestId,
      );
      expect((await request())?.status).toBe("pending");

      // Run 2, before the quiesce time: the mailbox is revoked (the accounting
      // connection is not revoked twice) and object purge is deferred.
      failRevocation = false;
      await expect(
        deletion.runDeletionCleanup(deps(new Date()), deletionRequestId),
      ).resolves.toMatchObject({ status: "waiting" });
      expect(revoked).toEqual(["accounting", "mailbox"]);
      state = await request();
      expect(state?.connectionsRevokedAt).toBeString();
      // A revoked mailbox no longer keeps its token.
      expect(state?.connections[1]).toMatchObject({ refreshToken: null });
      expect(await exists(doomedObject)).toBe(true);

      // Run 3, after quiesce: storage fails and nothing is marked purged.
      const later = new Date(Date.parse(state!.quiesceUntil) + 1000);
      failStorage = true;
      await expect(
        deletion.runDeletionCleanup(deps(later), deletionRequestId),
      ).rejects.toThrow(/Unable to purge stored objects/);
      state = await request();
      expect(state?.storagePurgedAt).toBeNull();
      expect(state?.status).toBe("pending");

      // Run 4 completes: every object under the workspace is gone, the
      // neighbour's are untouched, and only ids and timestamps are kept.
      failStorage = false;
      await expect(
        deletion.runDeletionCleanup(deps(later), deletionRequestId),
      ).resolves.toMatchObject({ status: "completed" });
      expect(revoked).toEqual(["accounting", "mailbox"]);
      expect(await exists(doomedObject)).toBe(false);
      expect(await exists(doomedLogo)).toBe(false);
      expect(await exists(neighbourObject)).toBe(true);
      state = await request();
      expect(state).toMatchObject({
        status: "completed",
        connections: [],
        lastError: null,
        attempts: 4,
      });
      expect(state?.storagePurgedAt).toBeString();

      // A completed request is never resumed or re-run.
      expect(await queries.resumeDeletionRequests(primaryDb)).not.toContain(
        deletionRequestId,
      );
      await expect(
        deletion.runDeletionCleanup(deps(later), deletionRequestId),
      ).resolves.toMatchObject({ status: "skipped" });
    });
  });
});
