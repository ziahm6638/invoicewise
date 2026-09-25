/**
 * Data lifecycle checks for roadmap issue #50: owner-only workspace export,
 * the retention sweep and the deletion path, against a disposable Postgres
 * database and a disposable multi-workspace dataset.
 *
 *   cd apps/api && PERMISSIONS_TEST_DATABASE_URL=postgresql://invoicewise:invoicewise@localhost:5432/invoicewise_perms_test \
 *     bun test src/trpc/routers/data.lifecycle.integration.test.ts
 *
 * Objects go to a temporary local storage root; provider revocation is
 * injected, so nothing leaves the machine.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database, PrimaryDatabase } from "@invoicewise/db/client";

const testDatabaseUrl = process.env.PERMISSIONS_TEST_DATABASE_URL;

// Must be set before the database client, auth and storage modules load.
if (testDatabaseUrl) {
  process.env.DATABASE_PRIMARY_URL = testDatabaseUrl;
  process.env.BETTER_AUTH_SECRET ??= "data-lifecycle-integration-test-secret";
  process.env.BETTER_AUTH_URL ??= "http://localhost:3001";
  process.env.RESEND_API_KEY ??= "re_data_lifecycle_integration_test";
  process.env.POLAR_ACCESS_TOKEN ??= "polar_data_lifecycle_integration_test";
  process.env.REDIS_URL ??= "redis://localhost:6379";
  process.env.MIDDAY_ENCRYPTION_KEY ??=
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  process.env.NODE_ENV ??= "test";
}

const suite = testDatabaseUrl ? describe : describe.skip;
const DAY = 86_400_000;
const sha256 = (data: Uint8Array | string) =>
  createHash("sha256").update(data).digest("hex");

suite("data lifecycle (integration)", () => {
  let db: Database;
  let primaryDb: PrimaryDatabase;
  let queries: typeof import("@invoicewise/db/queries");
  let schema: typeof import("@invoicewise/db/schema");
  let orm: typeof import("drizzle-orm");
  let storage: ReturnType<
    typeof import("@invoicewise/db/storage")["createStorageClient"]
  >;
  let dataExport: typeof import("@invoicewise/jobs/data-export");
  let retention: typeof import("@invoicewise/jobs/retention");
  let deletion: typeof import("@invoicewise/jobs/deletion");
  let zip: typeof import("@invoicewise/jobs/zip");
  let policyModule: typeof import("@invoicewise/jobs/retention-policy");
  let exportRoute: typeof import("@api/storage/export-route");
  let runner: typeof import("@invoicewise/jobs/runner");
  let supplierJobs: typeof import("@invoicewise/jobs/suppliers");
  let effect: typeof import("effect");
  let caller: (ctx: any) => Record<string, any>;
  let storageRoot: string;
  let exportTempDir: string;

  const createdTeams: string[] = [];
  const createdUsers: string[] = [];
  const deletionIds: string[] = [];

  beforeAll(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), "invoicewise-lifecycle-"));
    exportTempDir = await mkdtemp(join(tmpdir(), "invoicewise-export-build-"));
    process.env.STORAGE_BACKEND = "local";
    process.env.LOCAL_STORAGE_PATH = storageRoot;
    process.env.STORAGE_SIGNING_SECRET = "data-lifecycle-signing-secret";
    process.env.STORAGE_PUBLIC_URL = "http://localhost:3003";

    const client = await import("@invoicewise/db/client");
    schema = await import("@invoicewise/db/schema");
    orm = await import("drizzle-orm");
    queries = await import("@invoicewise/db/queries");
    const storageModule = await import("@invoicewise/db/storage");
    dataExport = await import("@invoicewise/jobs/data-export");
    retention = await import("@invoicewise/jobs/retention");
    deletion = await import("@invoicewise/jobs/deletion");
    zip = await import("@invoicewise/jobs/zip");
    policyModule = await import("@invoicewise/jobs/retention-policy");
    exportRoute = await import("@api/storage/export-route");
    runner = await import("@invoicewise/jobs/runner");
    supplierJobs = await import("@invoicewise/jobs/suppliers");
    effect = await import("effect");
    const { appRouter } = await import("@api/trpc/routers/_app");
    const { createCallerFactory } = await import("@api/trpc/init");

    db = client.db;
    primaryDb = client.primaryDb;
    storage = storageModule.createStorageClientFromEnv();
    caller = createCallerFactory(appRouter);
    // Cold-loading the app router can exceed bun's 5s default hook timeout.
  }, 60_000);

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
        orm.or(
          orm.inArray(schema.deletionRequests.subjectId, [
            ...createdTeams,
            ...createdUsers,
          ]),
          deletionIds.length
            ? orm.inArray(schema.deletionRequests.id, deletionIds)
            : orm.sql`false`,
        ),
      );
    await rm(storageRoot, { recursive: true, force: true });
    await rm(exportTempDir, { recursive: true, force: true });
  });

  const seedUser = async (label: string) => {
    const id = crypto.randomUUID();
    const email = `${label}-${id}@example.test`;
    await primaryDb.insert(schema.users).values({ id, email, fullName: label });
    createdUsers.push(id);
    return { id, email };
  };

  const seedTeam = async (
    name: string,
    members: {
      user: { id: string };
      role: "owner" | "admin" | "member";
    }[],
  ) => {
    const id = crypto.randomUUID();
    await primaryDb.insert(schema.teams).values({ id, name });
    createdTeams.push(id);
    await primaryDb.insert(schema.usersOnTeam).values(
      members.map((member) => ({
        userId: member.user.id,
        role: member.role,
        teamId: id,
      })),
    );
    await primaryDb
      .update(schema.users)
      .set({ teamId: id })
      .where(
        orm.inArray(
          schema.users.id,
          members.map((member) => member.user.id),
        ),
      );
    return id;
  };

  /** An accepted invoice with its original stored under the workspace. */
  const seedInvoice = async (
    teamId: string,
    options: {
      supplier: string;
      stored?: boolean;
      createdAt?: Date;
      referenceId?: string | null;
      intakeState?: "accepted" | "cancelled" | "reserved";
      status?: "done" | "deleted";
    },
  ) => {
    const id = crypto.randomUUID();
    const bytes = Buffer.from(`%PDF-1.4 ${options.supplier} ${id}`);
    const filePath = [teamId, "inbox", id, `${crypto.randomUUID()}.pdf`];
    if (options.stored !== false) {
      await storage.upload({ bucket: "vault", path: filePath, file: bytes });
    }
    await primaryDb.insert(schema.inbox).values({
      id,
      teamId,
      filePath,
      fileName: `${options.supplier}.pdf`,
      displayName: `Invoice from ${options.supplier}`,
      contentType: "application/pdf",
      size: bytes.byteLength,
      contentHash: sha256(bytes),
      intakeState: options.intakeState ?? "accepted",
      status: options.status ?? "done",
      referenceId: options.referenceId ?? null,
      createdAt: (options.createdAt ?? new Date()).toISOString(),
      extraction: {
        supplierName: options.supplier,
        supplierVatNumber: null,
        grossAmount: 120,
      },
      judgments: [
        { questionId: "duplicate", label: "Duplicate", answer: "no" },
        { questionId: "known_supplier", label: "Known", answer: "yes" },
      ],
    });
    return { id, bytes, filePath };
  };

  /** A message received at the workspace address, settled as given. */
  const seedInboundEmail = async (
    teamId: string,
    options: {
      status: "received" | "processed" | "failed";
      createdAt?: Date;
      subject?: string;
      invoiceId?: string;
    },
  ) => {
    const id = crypto.randomUUID();
    const messageId = `<${id}@sender.example>`;
    const raw = Buffer.from(`Message-ID: ${messageId}\r\n\r\nbody ${id}`);
    await primaryDb.insert(schema.inboundEmails).values({
      id,
      teamId,
      recipient: `${id.slice(0, 16)}@in.invoicewise.uk`,
      envelopeFrom: "bounce@sender.example",
      messageKey: `mid:${sha256(messageId)}`,
      messageId,
      headerFrom: "Sender <billing@sender.example>",
      subject: options.subject ?? `Invoice ${id}`,
      sentAt: "Tue, 01 Sep 2026 10:00:00 +0000",
      authenticationResults: "mx.cloudflare.net; dkim=pass",
      size: raw.byteLength,
      rawSha256: sha256(raw),
      raw: options.status === "processed" ? null : raw,
      status: options.status,
      attachments: options.invoiceId
        ? [
            {
              index: 0,
              fileName: "invoice.pdf",
              contentType: "application/pdf",
              size: 10,
              sha256: null,
              outcome: "accepted" as const,
              inboxId: options.invoiceId,
            },
          ]
        : [],
      createdAt: (options.createdAt ?? new Date()).toISOString(),
    });
    return { id, messageId, raw };
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

  const exists = (path: string[]) =>
    storage.download({ bucket: "vault", path }).then(
      () => true,
      () => false,
    );

  const policy = () => policyModule.resolveRetentionPolicy({});

  /** Two workspaces with the same shape and distinct, recognisable data. */
  const seedWorkspaces = async (label: string) => {
    const owner = await seedUser(`${label}-owner`);
    const admin = await seedUser(`${label}-admin`);
    const member = await seedUser(`${label}-member`);
    const neighbourOwner = await seedUser(`${label}-neighbour`);
    const teamId = await seedTeam(`${label} workspace`, [
      { user: owner, role: "owner" },
      { user: admin, role: "admin" },
      { user: member, role: "member" },
    ]);
    const neighbourTeam = await seedTeam(`${label} neighbour`, [
      { user: neighbourOwner, role: "owner" },
    ]);
    return { owner, admin, member, neighbourOwner, teamId, neighbourTeam };
  };

  test("only the owner can request, list and download exports", async () => {
    const { owner, admin, member, teamId } = await seedWorkspaces("perm");

    for (const user of [admin, member]) {
      const api = caller(ctx(user, teamId));
      await expect(api.data.requestExport()).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      await expect(api.data.exports()).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      await expect(
        api.data.exportDownloadUrl({ id: crypto.randomUUID() }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      // The schedule is readable by every member.
      await expect(api.data.retentionPolicy()).resolves.toMatchObject({
        policy: { exportLinkHours: 24, failedUploadDays: 30 },
      });
    }

    const api = caller(ctx(owner, teamId));
    const request = await api.data.requestExport();
    expect(request).toMatchObject({ teamId, status: "queued" });
    // One build at a time per workspace.
    await expect(api.data.requestExport()).rejects.toMatchObject({
      code: "CONFLICT",
    });
    const job = await primaryDb.query.workflowJobs.findFirst({
      where: orm.eq(schema.workflowJobs.idempotencyKey, request.id),
    });
    expect(job).toMatchObject({ name: "build-data-export", teamId });
    // A queued export cannot be downloaded.
    await expect(
      api.data.exportDownloadUrl({ id: request.id }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  test("exports a complete workspace and nothing from its neighbour, resuming after an interruption", async () => {
    const { owner, neighbourOwner, teamId, neighbourTeam } =
      await seedWorkspaces("export");

    const invoices = [
      await seedInvoice(teamId, { supplier: "Acme Supplies Ltd" }),
      await seedInvoice(teamId, { supplier: "Acme Supplies Ltd" }),
      await seedInvoice(teamId, { supplier: "Bolt Electrical" }),
    ];
    const legacyMissing = await seedInvoice(teamId, {
      supplier: "Lost Paper Co",
      stored: false,
    });
    const excluded = [
      await seedInvoice(teamId, {
        supplier: "Cancelled Upload",
        intakeState: "cancelled",
      }),
      await seedInvoice(teamId, {
        supplier: "Half Upload",
        intakeState: "reserved",
      }),
      await seedInvoice(teamId, { supplier: "Deleted One", status: "deleted" }),
    ];
    const neighbour = await seedInvoice(neighbourTeam, {
      supplier: "Neighbour Secret Supplier",
    });
    // An inconsistent record pointing at the neighbour's object is withheld,
    // never read.
    const crossTenant = crypto.randomUUID();
    await primaryDb.insert(schema.inbox).values({
      id: crossTenant,
      teamId,
      filePath: neighbour.filePath,
      fileName: "pointer.pdf",
      contentType: "application/pdf",
      status: "done",
    });
    await primaryDb.insert(schema.userQuestions).values({
      teamId,
      questionKey: "po_required",
      version: 1,
      label: "PO required",
      question: "Does the invoice cite a purchase order?",
      type: "boolean",
    });
    // Both workspaces resolve their suppliers; an admin then moves the second
    // Acme invoice to Bolt, so its supplier differs from its extraction.
    for (const team of [teamId, neighbourTeam]) {
      await supplierJobs.backfillSuppliers(db, {
        teamId: team,
        excludeId: crypto.randomUUID(),
      });
    }
    const supplierRows = await primaryDb
      .select()
      .from(schema.suppliers)
      .where(orm.eq(schema.suppliers.teamId, teamId));
    const bolt = supplierRows.find((row) => row.name === "Bolt Electrical")!;
    const reassigned = invoices[1]!;
    await caller(ctx(owner, teamId)).suppliers.assignInvoice({
      inboxId: reassigned.id,
      supplierId: bolt.id,
    });
    const assignedSuppliers = new Map(
      (
        await primaryDb
          .select({ id: schema.inbox.id, supplierId: schema.inbox.supplierId })
          .from(schema.inbox)
          .where(orm.eq(schema.inbox.teamId, teamId))
      ).map((row) => [row.id, row.supplierId]),
    );
    expect(assignedSuppliers.get(reassigned.id)).toBe(bolt.id);
    await primaryDb.insert(schema.inboxRedeliveries).values({
      teamId,
      inboxId: invoices[0]!.id,
      referenceId: "msg-redelivered_0_invoice.pdf",
      fileName: "again.pdf",
    });

    const received = await seedInboundEmail(teamId, {
      status: "processed",
      subject: "Invoice from Acme",
      invoiceId: invoices[0]!.id,
    });
    const failedEmail = await seedInboundEmail(teamId, { status: "failed" });
    const neighbourEmail = await seedInboundEmail(neighbourTeam, {
      status: "processed",
      subject: "Neighbour Secret Subject",
    });

    const request = await caller(ctx(owner, teamId)).data.requestExport();

    // Run 1 is interrupted after the archive is built: the upload fails.
    let failUpload = true;
    const deps = {
      db,
      policy: policy(),
      tempDir: exportTempDir,
      storage: {
        download: storage.download,
        remove: storage.remove,
        uploadFile: async (input: Parameters<typeof storage.uploadFile>[0]) => {
          if (failUpload) throw new Error("storage connection reset");
          return storage.uploadFile(input);
        },
      },
    };
    await expect(
      dataExport.buildDataExport(deps, { exportId: request.id, teamId }),
    ).rejects.toMatchObject({ retryable: true });
    let row = await queries.getDataExport(db, { id: request.id, teamId });
    expect(row?.status).toBe("running");
    // The would-be archive is recorded before it is written, and no build
    // file is left on disk.
    expect(row?.filePath?.slice(0, 3)).toEqual([teamId, "exports", request.id]);
    expect(await readdir(exportTempDir)).toEqual([]);

    // Run 2 (the job's retry) starts again and publishes.
    failUpload = false;
    const result = await dataExport.buildDataExport(deps, {
      exportId: request.id,
      teamId,
    });
    expect(result).toMatchObject({ status: "ready" });
    expect(await readdir(exportTempDir)).toEqual([]);
    row = await queries.getDataExport(db, { id: request.id, teamId });
    expect(row).toMatchObject({ status: "ready", attempts: 2 });
    // Expiry and completion come from two clock reads a few ms apart.
    const linkLifetime =
      Date.parse(row!.expiresAt!) - Date.parse(row!.completedAt!);
    expect(linkLifetime).toBeLessThanOrEqual(24 * 3_600_000);
    expect(linkLifetime).toBeGreaterThan(24 * 3_600_000 - 5_000);

    // The owner downloads through a short-lived link.
    const { url } = await caller(ctx(owner, teamId)).data.exportDownloadUrl({
      id: request.id,
    });
    const response = await exportRoute.exportDownloadResponse(new Request(url));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const archive = new Uint8Array(await response.arrayBuffer());
    expect(sha256(archive)).toBe(row!.sha256!);
    const entries = zip.readStoredZip(archive);
    const manifest = JSON.parse(entries.get("manifest.json")!.toString());
    // The archive states exactly the expiry the link and retention enforce.
    expect(Date.parse(manifest.expiresAt)).toBe(Date.parse(row!.expiresAt!));

    // Manifest completeness: every listed file is present with its hash,
    // every accepted invoice is listed once, and every stored original is
    // included byte for byte.
    expect(manifest).toMatchObject({
      format: "invoicewise-workspace-export",
      formatVersion: 1,
      exportId: request.id,
      workspaceId: teamId,
      counts: {
        invoices: 5,
        documents: 3,
        missingDocuments: 2,
        suppliers: 3,
        judgments: 8,
      },
    });
    for (const file of manifest.files) {
      expect(sha256(entries.get(file.path)!)).toBe(file.sha256);
    }
    const exported = JSON.parse(entries.get("invoices.json")!.toString());
    expect(
      exported.map((invoice: { id: string }) => invoice.id).sort(),
    ).toEqual(
      [
        ...invoices.map((invoice) => invoice.id),
        legacyMissing.id,
        crossTenant,
      ].sort(),
    );
    expect(
      manifest.documents.find(
        (entry: { invoiceId: string }) => entry.invoiceId === crossTenant,
      ),
    ).toMatchObject({ status: "withheld", path: null, sha256: null });
    for (const invoice of invoices) {
      const document = manifest.documents.find(
        (entry: { invoiceId: string }) => entry.invoiceId === invoice.id,
      );
      expect(document).toMatchObject({
        status: "included",
        sha256: sha256(invoice.bytes),
        intakeHashMatches: true,
      });
      expect(entries.get(document.path)?.equals(invoice.bytes)).toBe(true);
    }
    expect(
      manifest.documents.find(
        (entry: { invoiceId: string }) => entry.invoiceId === legacyMissing.id,
      ),
    ).toMatchObject({ status: "missing", path: null });
    // Stable identifiers link the records together. Suppliers are the
    // workspace's own records, and every invoice carries the supplier it is
    // assigned to, including the reassigned one.
    const suppliers = JSON.parse(entries.get("suppliers.json")!.toString());
    expect(
      suppliers.map((supplier: { id: string }) => supplier.id).sort(),
    ).toEqual(supplierRows.map((row) => row.id).sort());
    for (const invoice of exported) {
      expect(invoice.supplierId).toBe(
        assignedSuppliers.get(invoice.id) ?? null,
      );
    }
    const byName = (name: string) =>
      suppliers.find((supplier: { name: string }) => supplier.name === name);
    expect(byName("Acme Supplies Ltd").invoiceIds).toEqual([invoices[0]!.id]);
    expect(byName("Bolt Electrical").invoiceIds.sort()).toEqual(
      [reassigned.id, invoices[2]!.id].sort(),
    );
    expect(
      exported.find((invoice: { id: string }) => invoice.id === reassigned.id)
        .supplierResolution,
    ).toMatchObject({ status: "manual" });
    const supplierEvents = JSON.parse(
      entries.get("supplier-events.json")!.toString(),
    );
    expect(supplierEvents).toMatchObject([
      {
        action: "assign_invoice",
        inboxId: reassigned.id,
        targetSupplierId: bolt.id,
        actorId: owner.id,
      },
    ]);
    expect(
      manifest.files.find(
        (file: { path: string }) => file.path === "supplier-events.json",
      ),
    ).toMatchObject({ records: 1 });
    expect(
      exported.find((invoice: { id: string }) => invoice.id === invoices[0]!.id)
        .source.redeliveries,
    ).toMatchObject([
      {
        fileName: "again.pdf",
        messageReference: "msg-redelivered_0_invoice.pdf",
      },
    ]);
    // Received messages are listed with their outcome and invoices, never
    // their MIME source.
    const inboundEmails = JSON.parse(
      entries.get("inbound-emails.json")!.toString(),
    );
    expect(inboundEmails.map((email: { id: string }) => email.id)).toEqual([
      received.id,
      failedEmail.id,
    ]);
    expect(inboundEmails[0]).toMatchObject({
      recipient: `${received.id.slice(0, 16)}@in.invoicewise.uk`,
      sender: "Sender <billing@sender.example>",
      subject: "Invoice from Acme",
      status: "processed",
      invoiceIds: [invoices[0]!.id],
    });
    expect(inboundEmails[1]).toMatchObject({ status: "failed" });
    expect(
      manifest.files.find(
        (file: { path: string }) => file.path === "inbound-emails.json",
      ),
    ).toMatchObject({ records: 2 });
    const judgments = JSON.parse(entries.get("judgments.json")!.toString());
    expect(judgments.map((judgment: { id: string }) => judgment.id)).toContain(
      `${invoices[0]!.id}:known_supplier`,
    );
    expect(
      JSON.parse(entries.get("questions.json")!.toString())[0],
    ).toMatchObject({ questionKey: "po_required" });
    const audit = JSON.parse(entries.get("audit.json")!.toString());
    expect(audit.map((event: { type: string }) => event.type)).toEqual(
      expect.arrayContaining(["export.requested", "supplier.assign_invoice"]),
    );

    // Nothing from the neighbour, and no uploads that never became invoices.
    const everything = Buffer.concat([...entries.values()]).toString("utf8");
    expect(everything).not.toContain(neighbourTeam);
    expect(everything).not.toContain(neighbour.id);
    expect(everything).not.toContain(neighbour.bytes.toString());
    expect(everything).not.toContain("Neighbour Secret Supplier");
    expect(everything).not.toContain(neighbourEmail.id);
    expect(everything).not.toContain("Neighbour Secret Subject");
    expect(everything).not.toContain(failedEmail.raw.toString());
    expect(everything).not.toContain(failedEmail.messageId);
    for (const invoice of excluded) {
      expect(everything).not.toContain(invoice.id);
    }
    // No secrets are exported.
    expect(everything).not.toContain("refresh_token");
    expect(everything).not.toContain("secretEncrypted");

    // The link is bound to the export: tampering or another workspace's
    // owner cannot use it.
    const tampered = new URL(url);
    tampered.searchParams.set("signature", "0".repeat(64));
    expect(
      (
        await exportRoute.exportDownloadResponse(
          new Request(tampered.toString()),
        )
      ).status,
    ).toBe(401);
    await expect(
      caller(ctx(neighbourOwner, neighbourTeam)).data.exportDownloadUrl({
        id: request.id,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // Past its expiry the same, still-signed link stops working at once.
    expect(
      (
        await exportRoute.exportDownloadResponse(new Request(url), {
          db: primaryDb,
          openRead: storage.openRead,
          now: () => Date.parse(row!.expiresAt!) + 1,
        })
      ).status,
    ).toBe(401);
  });

  test("the manifest and the request share one expiry however long the build takes", async () => {
    const { owner, teamId } = await seedWorkspaces("expiry");
    await seedInvoice(teamId, { supplier: "Slow Build Supplier" });
    const request = await caller(ctx(owner, teamId)).data.requestExport();

    // Every clock read is an hour later than the one before, as if each
    // stage of the build took an hour.
    let clock = Date.parse("2026-09-25T00:00:00.000Z");
    await dataExport.buildDataExport(
      {
        db,
        policy: policy(),
        tempDir: exportTempDir,
        storage,
        now: () => {
          clock += 3_600_000;
          return new Date(clock);
        },
      },
      { exportId: request.id, teamId },
    );

    const row = await queries.getDataExport(db, { id: request.id, teamId });
    const archive = await storage.download({
      bucket: "vault",
      path: row!.filePath!,
    });
    const manifest = JSON.parse(
      zip
        .readStoredZip(new Uint8Array(await archive.arrayBuffer()))
        .get("manifest.json")!
        .toString(),
    );
    expect(row?.status).toBe("ready");
    expect(manifest.expiresAt).toBe(new Date(row!.expiresAt!).toISOString());
    expect(
      Date.parse(manifest.expiresAt) - Date.parse(manifest.generatedAt),
    ).toBeGreaterThanOrEqual(24 * 3_600_000);
  });

  test("the runner's reconciler settles an export whose job died on its final attempt, so a new export can start", async () => {
    const { owner, teamId, neighbourOwner, neighbourTeam } =
      await seedWorkspaces("stalled");
    const api = caller(ctx(owner, teamId));
    const stalled = await api.data.requestExport();
    const live = await caller(
      ctx(neighbourOwner, neighbourTeam),
    ).data.requestExport();

    // The worker claimed the build, then died on its final attempt: the
    // queue fails the job when its lease expires (claimWorkflowJobs) without
    // running the handler, so the export row is left `running`.
    await queries.beginDataExport(db, { id: stalled.id, teamId });
    await primaryDb
      .update(schema.workflowJobs)
      .set({
        status: "failed",
        attempts: 3,
        finishedAt: new Date().toISOString(),
        lastError: "Workflow lease expired after its final attempt",
      })
      .where(orm.eq(schema.workflowJobs.idempotencyKey, stalled.id));
    await expect(api.data.requestExport()).rejects.toMatchObject({
      code: "CONFLICT",
    });

    // One pass of the runner's periodic reconciler.
    const outcome = await effect.Effect.runPromise(
      effect.Effect.flatMap(
        runner.DeliveryReconciler,
        (reconciler) => reconciler.run,
      ).pipe(
        effect.Effect.provide(runner.DeliveryReconcilerLive),
        effect.Effect.provide(
          effect.Layer.succeed(runner.WorkflowDatabase, { db }),
        ),
      ),
    );
    expect(outcome.exportsFailed).toBeGreaterThanOrEqual(1);

    // The owner sees the failure and can start again; the export next door,
    // whose job is still queued, is untouched.
    const settled = await queries.getDataExport(db, { id: stalled.id, teamId });
    expect(settled).toMatchObject({
      status: "failed",
      error: queries.STALLED_DATA_EXPORT_ERROR,
    });
    expect(settled?.completedAt).toBeString();
    await expect(
      queries.getDataExport(db, { id: live.id, teamId: neighbourTeam }),
    ).resolves.toMatchObject({ status: "queued", error: null });
    await expect(api.data.requestExport()).resolves.toMatchObject({
      status: "queued",
    });

    // A second pass changes nothing.
    await expect(queries.failStalledDataExports(db)).resolves.toEqual([]);
  });

  test("the retention sweep resumes after an interruption and leaves unrelated data untouched", async () => {
    const { owner, teamId, neighbourTeam } = await seedWorkspaces("retention");
    const now = new Date();
    const ago = (days: number) => new Date(now.getTime() - days * DAY);

    // Active data is kept however old it is.
    const oldActive = await seedInvoice(teamId, {
      supplier: "Old But Active",
      createdAt: ago(400),
    });
    // Failed uploads: old ones go, a recent one stays.
    const oldCancelled = await seedInvoice(teamId, {
      supplier: "Old Cancelled",
      intakeState: "cancelled",
      stored: false,
      createdAt: ago(31),
    });
    const recentCancelled = await seedInvoice(teamId, {
      supplier: "Recent Cancelled",
      intakeState: "cancelled",
      stored: false,
      createdAt: ago(2),
    });
    // A member deleted an old invoice: its file went at once, its record
    // (with the extraction) goes with the failed uploads.
    const deletedInvoice = await seedInvoice(teamId, {
      supplier: "Deleted By Member",
      createdAt: ago(40),
    });
    await queries.deleteInbox(db, { id: deletedInvoice.id, teamId });
    expect(await exists(deletedInvoice.filePath)).toBe(false);
    // Source email references: past 90 days in one workspace, recent in the
    // neighbour.
    const oldEmail = await seedInvoice(teamId, {
      supplier: "Old Email",
      referenceId: "msg-old_0_invoice.pdf",
      createdAt: ago(91),
    });
    const recentEmail = await seedInvoice(neighbourTeam, {
      supplier: "Recent Email",
      referenceId: "msg-new_0_invoice.pdf",
      createdAt: ago(10),
    });
    // Re-delivered source emails follow the same period.
    const [oldRedelivery, recentRedelivery] = await primaryDb
      .insert(schema.inboxRedeliveries)
      .values([
        {
          teamId,
          inboxId: oldActive.id,
          referenceId: "msg-old-again_0_invoice.pdf",
          receivedAt: ago(91).toISOString(),
        },
        {
          teamId: neighbourTeam,
          inboxId: recentEmail.id,
          referenceId: "msg-new-again_0_invoice.pdf",
          receivedAt: ago(10).toISOString(),
        },
      ])
      .returning();
    // Received messages: a failed one's MIME source goes after the
    // failed-upload period and every settled message's headers after the
    // source email period; unsettled and recent messages are untouched.
    const failedEmailOld = await seedInboundEmail(teamId, {
      status: "failed",
      createdAt: ago(31),
    });
    const failedEmailRecent = await seedInboundEmail(teamId, {
      status: "failed",
      createdAt: ago(2),
    });
    const processedEmailOld = await seedInboundEmail(teamId, {
      status: "processed",
      createdAt: ago(91),
      invoiceId: oldActive.id,
    });
    const receivedEmailOld = await seedInboundEmail(neighbourTeam, {
      status: "received",
      createdAt: ago(91),
    });
    // Job payloads: finished and old are emptied; live work is never touched.
    const oldJob = crypto.randomUUID();
    const liveJob = crypto.randomUUID();
    await primaryDb.insert(schema.workflowJobs).values([
      {
        id: oldJob,
        name: "process-attachment",
        teamId,
        payload: { teamId, inboxId: oldActive.id },
        status: "succeeded",
        result: { inboxId: oldActive.id },
        idempotencyKey: `lifecycle-${oldJob}`,
        finishedAt: ago(31).toISOString(),
      },
      {
        id: liveJob,
        name: "process-attachment",
        teamId: neighbourTeam,
        payload: { teamId: neighbourTeam, inboxId: recentEmail.id },
        status: "queued",
        idempotencyKey: `lifecycle-${liveJob}`,
        createdAt: ago(40).toISOString(),
      },
    ]);
    // Deletion records are the operator audit trail and are never removed.
    const [settled, pending] = await primaryDb
      .insert(schema.deletionRequests)
      .values([
        {
          subject: "workspace",
          subjectId: crypto.randomUUID(),
          status: "completed",
          completedAt: ago(31).toISOString(),
        },
        {
          subject: "workspace",
          subjectId: crypto.randomUUID(),
          status: "failed",
        },
      ])
      .returning();
    deletionIds.push(settled!.id, pending!.id);
    // Exports: an expired archive in one workspace, a live one next door.
    const makeReadyExport = async (
      team: string,
      requestedBy: string,
      expiresAt: Date,
    ) => {
      const [row] = await primaryDb
        .insert(schema.dataExports)
        .values({ teamId: team, requestedBy, status: "running" })
        .returning();
      const path = dataExport.dataExportObjectPath(team, row!.id, "e.zip");
      await storage.upload({
        bucket: "vault",
        path,
        file: Buffer.from("zip"),
      });
      await primaryDb
        .update(schema.dataExports)
        .set({
          status: "ready",
          filePath: path,
          expiresAt: expiresAt.toISOString(),
        })
        .where(orm.eq(schema.dataExports.id, row!.id));
      return { id: row!.id, path };
    };
    const expiredExport = await makeReadyExport(
      teamId,
      owner.id,
      new Date(now.getTime() - 1000),
    );
    const liveExport = await makeReadyExport(
      neighbourTeam,
      owner.id,
      new Date(now.getTime() + DAY),
    );

    const jobCount = async () =>
      (
        (await primaryDb.execute(
          orm.sql`select count(*)::int as count from workflow_jobs`,
        )) as unknown as { rows: { count: number }[] }
      ).rows[0]!.count;
    const jobsBefore = await jobCount();

    // Run 1 is interrupted after two committed batches.
    let batches = 0;
    const sweep = (interruptAfter?: number) =>
      retention.runRetentionSweep({
        db,
        storage,
        policy: policy(),
        now: () => now,
        batchSize: 1,
        exportTempDir,
        afterBatch: () => {
          batches += 1;
          if (interruptAfter && batches >= interruptAfter) {
            throw new Error("worker stopped");
          }
        },
      });
    await expect(sweep(2)).rejects.toThrow("worker stopped");
    const afterInterruption = await queries.getDataExport(db, {
      id: expiredExport.id,
      teamId,
    });
    expect(afterInterruption?.status).toBe("expired");
    expect(await exists(expiredExport.path)).toBe(false);

    // Run 2 resumes and finishes; run 3 finds nothing left to do.
    batches = 0;
    const second = await sweep();
    expect(second.failures).toEqual([]);
    const third = await sweep();
    expect(
      Object.entries(third.counts).filter(
        ([step, count]) => step !== "failed-uploads" && count > 0,
      ),
    ).toEqual([]);

    const inboxRow = (id: string) =>
      primaryDb.query.inbox.findFirst({ where: orm.eq(schema.inbox.id, id) });
    expect(await inboxRow(oldActive.id)).toBeDefined();
    expect(await exists(oldActive.filePath)).toBe(true);
    expect(await inboxRow(oldCancelled.id)).toBeUndefined();
    expect(await inboxRow(recentCancelled.id)).toBeDefined();
    expect(await inboxRow(deletedInvoice.id)).toBeUndefined();
    expect((await inboxRow(oldEmail.id))?.referenceId).toBeNull();
    expect((await inboxRow(recentEmail.id))?.referenceId).toBe(
      "msg-new_0_invoice.pdf",
    );
    const redelivery = (id: string) =>
      primaryDb.query.inboxRedeliveries.findFirst({
        where: orm.eq(schema.inboxRedeliveries.id, id),
      });
    expect(await redelivery(oldRedelivery!.id)).toMatchObject({
      inboxId: oldActive.id,
      referenceId: null,
    });
    expect((await redelivery(recentRedelivery!.id))?.referenceId).toBe(
      "msg-new-again_0_invoice.pdf",
    );
    const inboundEmail = (id: string) =>
      primaryDb.query.inboundEmails.findFirst({
        where: orm.eq(schema.inboundEmails.id, id),
      });
    expect(await inboundEmail(failedEmailOld.id)).toMatchObject({
      raw: null,
      status: "failed",
      headerFrom: "Sender <billing@sender.example>",
      messageId: failedEmailOld.messageId,
    });
    expect(
      (await inboundEmail(failedEmailRecent.id))?.raw?.equals(
        failedEmailRecent.raw,
      ),
    ).toBe(true);
    const clearedEmail = await inboundEmail(processedEmailOld.id);
    expect(clearedEmail).toMatchObject({
      envelopeFrom: null,
      messageId: null,
      headerFrom: null,
      subject: null,
      sentAt: null,
      authenticationResults: null,
      raw: null,
      status: "processed",
      recipient: `${processedEmailOld.id.slice(0, 16)}@in.invoicewise.uk`,
      messageKey: `mid:${sha256(processedEmailOld.messageId)}`,
    });
    expect(clearedEmail?.attachments[0]?.inboxId).toBe(oldActive.id);
    expect(await inboundEmail(receivedEmailOld.id)).toMatchObject({
      messageId: receivedEmailOld.messageId,
      headerFrom: "Sender <billing@sender.example>",
    });
    const job = (id: string) =>
      primaryDb.query.workflowJobs.findFirst({
        where: orm.eq(schema.workflowJobs.id, id),
      });
    expect(await job(oldJob)).toMatchObject({
      status: "succeeded",
      payload: {},
      result: null,
    });
    expect((await job(liveJob))?.payload).toEqual({
      teamId: neighbourTeam,
      inboxId: recentEmail.id,
    });
    expect(await queries.getDeletionRequest(db, settled!.id)).toBeDefined();
    expect(await queries.getDeletionRequest(db, pending!.id)).toBeDefined();
    expect(
      await queries.getDataExport(db, {
        id: liveExport.id,
        teamId: neighbourTeam,
      }),
    ).toMatchObject({ status: "ready" });
    expect(await exists(liveExport.path)).toBe(true);
    // Retention never queues work, so it cannot bring anything back.
    expect(await jobCount()).toBe(jobsBefore);
  });

  test("deleting a workspace takes its exports and queued export work with it, resumably, and spares the neighbour", async () => {
    const { owner, teamId, neighbourTeam, neighbourOwner } =
      await seedWorkspaces("delete");
    const doomed = await seedInvoice(teamId, { supplier: "Doomed Supplier" });
    const spared = await seedInvoice(neighbourTeam, {
      supplier: "Spared Supplier",
    });

    // A finished export and a queued one in the doomed workspace; a finished
    // export next door.
    const deps = {
      db,
      policy: policy(),
      tempDir: exportTempDir,
      storage,
    };
    const finished = await caller(ctx(owner, teamId)).data.requestExport();
    await dataExport.buildDataExport(deps, { exportId: finished.id, teamId });
    const finishedRow = await queries.getDataExport(db, {
      id: finished.id,
      teamId,
    });
    const neighbourExport = await caller(
      ctx(neighbourOwner, neighbourTeam),
    ).data.requestExport();
    await dataExport.buildDataExport(deps, {
      exportId: neighbourExport.id,
      teamId: neighbourTeam,
    });
    const neighbourRow = await queries.getDataExport(db, {
      id: neighbourExport.id,
      teamId: neighbourTeam,
    });
    const queued = await caller(ctx(owner, teamId)).data.requestExport();

    await caller(ctx(owner, teamId)).team.delete({
      teamId,
      confirmName: "delete workspace",
    });

    // The rows and the queued build went with the workspace.
    expect(
      await primaryDb.query.dataExports.findMany({
        where: orm.eq(schema.dataExports.teamId, teamId),
      }),
    ).toEqual([]);
    expect(
      await primaryDb.query.workflowJobs.findFirst({
        where: orm.eq(schema.workflowJobs.idempotencyKey, queued.id),
      }),
    ).toBeUndefined();
    // A build that was already running cannot publish into the deleted
    // workspace.
    await expect(
      dataExport.buildDataExport(deps, { exportId: queued.id, teamId }),
    ).resolves.toMatchObject({ status: "skipped" });

    // Cleanup, interrupted by a storage failure, then resumed.
    const request = await primaryDb.query.deletionRequests.findFirst({
      where: orm.eq(schema.deletionRequests.subjectId, teamId),
    });
    let failStorage = true;
    const cleanupDeps = {
      db,
      now: () => new Date(Date.parse(request!.quiesceUntil) + 1000),
      revokeConnection: async () => undefined,
      storage: {
        removePrefix: async (input: { bucket: string; prefix: string[] }) => {
          if (failStorage) throw new Error("storage unavailable");
          await storage.removePrefix(input);
        },
      },
    };
    await expect(
      deletion.runDeletionCleanup(cleanupDeps, request!.id),
    ).rejects.toThrow(/Unable to purge stored objects/);
    expect(await exists(finishedRow!.filePath!)).toBe(true);
    failStorage = false;
    await expect(
      deletion.runDeletionCleanup(cleanupDeps, request!.id),
    ).resolves.toMatchObject({ status: "completed" });

    expect(await exists(doomed.filePath)).toBe(false);
    expect(await exists(finishedRow!.filePath!)).toBe(false);
    expect(await exists(spared.filePath)).toBe(true);
    expect(await exists(neighbourRow!.filePath!)).toBe(true);
    expect(
      await queries.getDataExport(db, {
        id: neighbourExport.id,
        teamId: neighbourTeam,
      }),
    ).toMatchObject({ status: "ready" });
  });
});
