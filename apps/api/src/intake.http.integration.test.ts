/**
 * Real HTTP intake checks for roadmap issue #34.
 *
 * Boots the actual API app on a disposable local port on top of a disposable
 * Postgres database plus a temporary local storage root, and drives the real
 * boundaries: intake upload -> durable reservation -> immutable object ->
 * Effect queue -> worker binding -> capability download -> delete.
 *
 * Providers are stubbed. Nothing leaves the machine and no paid provider is
 * contacted.
 *
 *   docker exec invoicewise-postgres-1 psql -U invoicewise -d postgres \
 *     -c "DROP DATABASE IF EXISTS invoicewise_intake_test" \
 *     -c "CREATE DATABASE invoicewise_intake_test"
 *   cd packages/db && DATABASE_PRIMARY_URL=postgresql://invoicewise:invoicewise@localhost:5432/invoicewise_intake_test bunx drizzle-kit migrate
 *   cd apps/api && INTAKE_TEST_DATABASE_URL=postgresql://invoicewise:invoicewise@localhost:5432/invoicewise_intake_test \
 *     bun test src/intake.http.integration.test.ts
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";

const testDatabaseUrl = process.env.INTAKE_TEST_DATABASE_URL;
const PORT = Number(process.env.INTAKE_TEST_PORT ?? 31781);
const BASE = `http://localhost:${PORT}`;
const storageRoot = join(
  tmpdir(),
  `invoicewise-intake-test-${crypto.randomUUID()}`,
);

if (testDatabaseUrl) {
  process.env.DATABASE_PRIMARY_URL = testDatabaseUrl;
  process.env.BETTER_AUTH_SECRET ??= "intake-http-integration-secret";
  process.env.BETTER_AUTH_URL = BASE;
  process.env.NEXT_PUBLIC_URL = BASE;
  process.env.RESEND_API_KEY ??= "re_intake_http_test";
  process.env.POLAR_ACCESS_TOKEN ??= "polar_intake_http_test";
  process.env.REDIS_URL ??= "redis://localhost:6379";
  process.env.MIDDAY_ENCRYPTION_KEY ??=
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  process.env.NODE_ENV ??= "test";
  process.env.STORAGE_BACKEND = "local";
  process.env.LOCAL_STORAGE_PATH = storageRoot;
  process.env.STORAGE_SIGNING_SECRET ??= "intake-storage-test-secret";
  process.env.STORAGE_PUBLIC_URL = BASE;
  process.env.WORKFLOW_RETRY_BASE_MS = "10";
  process.env.WORKFLOW_RETRY_MAX_MS = "10";
}

// No provider call may ever leave this test.
mock.module("@api/services/resend", () => ({
  resend: {
    emails: { send: async () => ({ data: { id: "stub" }, error: null }) },
    contacts: { remove: async () => ({ data: null, error: null }) },
  },
}));

type RealDocuments = typeof import("@invoicewise/documents");
let realDocuments: RealDocuments;

const extraction = {
  supplierName: "Acme Supplies Ltd",
  invoiceNumber: "INV-2026-0042",
  invoiceDate: "2026-09-01",
  dueDate: "2026-09-30",
  currency: "GBP",
  netAmount: 1000,
  taxAmount: 200,
  grossAmount: 1200,
  lineItems: [],
  bankDetails: null,
};

class FakeDocumentClient {
  async getInvoice() {
    return {
      name: "Acme Supplies Ltd",
      date: "2026-09-01",
      amount: 1200,
      currency: "GBP",
      website: null,
      type: "invoice",
      description: "September consulting services",
      tax_amount: 200,
      tax_rate: 20,
      tax_type: "VAT",
      extraction,
      judgments: [],
    };
  }
}

/** Minimal deterministic PDF builder for page-bound fixtures. */
function buildPdf(
  pageCount: number,
  options: { encrypt?: boolean } = {},
): Uint8Array {
  const objects: string[] = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
  ];
  const kids = Array.from(
    { length: pageCount },
    (_, index) => `${index + 3} 0 R`,
  ).join(" ");
  objects.push(
    `2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>\nendobj\n`,
  );
  for (let index = 0; index < pageCount; index++) {
    objects.push(
      `${index + 3} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>\nendobj\n`,
    );
  }
  let encryption = "";
  if (options.encrypt) {
    const encryptId = pageCount + 3;
    objects.push(
      `${encryptId} 0 obj\n<< /Filter /Standard /V 1 /R 2 /O <${"ab".repeat(32)}> /U <${"cd".repeat(32)}> /P -1 >>\nendobj\n`,
    );
    encryption = ` /Encrypt ${encryptId} 0 R /ID [<${"11".repeat(16)}> <${"11".repeat(16)}>]`;
  }
  let output = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const object of objects) {
    offsets.push(output.length);
    output += object;
  }
  const xrefStart = output.length;
  const size = objects.length + 1;
  output += `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    output += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  output += `trailer\n<< /Size ${size} /Root 1 0 R${encryption} >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return new TextEncoder().encode(output);
}

function buildPng(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

const suite = testDatabaseUrl ? describe : describe.skip;

suite("document intake ownership over real HTTP", () => {
  let schema: typeof import("@invoicewise/db/schema");
  let orm: typeof import("drizzle-orm");
  let superjson: typeof import("superjson").default;
  let client: typeof import("@invoicewise/db/client");
  let storage: ReturnType<
    typeof import("@invoicewise/db/storage").createStorageClient
  >;
  let queries: typeof import("@invoicewise/db/queries");
  let intake: typeof import("@invoicewise/jobs/intake");
  let server: ReturnType<typeof Bun.serve>;
  let runBatch: () => Promise<void>;
  type IntakeHttpModule = typeof import("@api/intake/http");
  let handleInvoiceIntakeForTest: IntakeHttpModule["handleInvoiceIntake"];

  const created = { userIds: [] as string[], teamIds: [] as string[] };
  let invoicePdf: Uint8Array;

  const post = (path: string, body: unknown, cookie?: string) =>
    fetch(`${BASE}${path}`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/json",
        origin: BASE,
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    });

  const get = (path: string, headers: Record<string, string> = {}) =>
    fetch(`${BASE}${path}`, {
      redirect: "manual",
      headers: { origin: BASE, ...headers },
    });

  const trpc = async (
    cookie: string,
    path: string,
    input: unknown,
    kind: "query" | "mutation" = "query",
  ) => {
    const serialized = JSON.stringify(superjson.serialize(input ?? null));
    const response =
      kind === "query"
        ? await get(`/trpc/${path}?input=${encodeURIComponent(serialized)}`, {
            cookie,
          })
        : await post(`/trpc/${path}`, JSON.parse(serialized), cookie);

    const text = await response.text();
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { status: response.status, error: text, data: null };
    }
    if (parsed?.error) {
      return {
        status: response.status,
        error: parsed.error?.json?.message ?? parsed.error,
        data: null,
      };
    }
    return {
      status: response.status,
      error: null,
      data: superjson.deserialize(parsed.result.data),
    };
  };

  const sessionCookie = (response: Response) => {
    const cookie = response.headers.getSetCookie()[0];
    if (!cookie) throw new Error("No session cookie was issued");
    return cookie.split(";")[0]!;
  };

  const createUser = async (label: string) => {
    const email = `${label}-${crypto.randomUUID()}@example.test`;
    const password = "Password123!";

    const signUp = await post("/api/auth/sign-up/email", {
      email,
      password,
      name: label,
    });
    expect(signUp.status).toBe(200);

    await client.primaryDb
      .update(schema.users)
      .set({ emailVerified: true })
      .where(orm.eq(schema.users.email, email));

    const signIn = await post("/api/auth/sign-in/email", { email, password });
    expect(signIn.status).toBe(200);

    const user = await client.primaryDb.query.users.findFirst({
      where: orm.eq(schema.users.email, email),
      columns: { id: true, teamId: true },
    });
    if (!user) throw new Error("User was not created");

    created.userIds.push(user.id);
    if (user.teamId) created.teamIds.push(user.teamId);

    return {
      email,
      userId: user.id,
      personalTeamId: user.teamId!,
      cookie: sessionCookie(signIn),
    };
  };

  /** Uploads one file through the real intake HTTP handler. */
  const upload = async (
    cookie: string,
    bytes: Uint8Array,
    fileName: string,
    declaredType: string,
  ) => {
    const formData = new FormData();
    formData.set(
      "file",
      new File([Buffer.from(bytes)], fileName, { type: declaredType }),
    );
    // A forged path/bucket field must be ignored by the server.
    formData.set("path", JSON.stringify(["other-team", "inbox", "evil.pdf"]));
    formData.set("bucket", "vault");

    const response = await fetch(`${BASE}/api/storage/upload`, {
      method: "POST",
      headers: { origin: BASE, cookie },
      body: formData,
    });

    return {
      status: response.status,
      body: (await response.json().catch(() => null)) as {
        id?: string;
        path?: string[];
        error?: string;
        code?: string;
        deduplicated?: boolean;
      } | null,
    };
  };

  const workflowJobsFor = async (teamId: string) =>
    client.primaryDb
      .select()
      .from(schema.workflowJobs)
      .where(orm.eq(schema.workflowJobs.teamId, teamId));

  const inboxRowsFor = async (teamId: string) =>
    client.primaryDb
      .select()
      .from(schema.inbox)
      .where(orm.eq(schema.inbox.teamId, teamId));

  /** Lets a failed attempt's publication lease lapse so cleanup may claim its rows. */
  const expirePublicationLeases = async (teamId: string) =>
    client.primaryDb
      .update(schema.inbox)
      .set({ intakePublishingUntil: new Date(Date.now() - 1000).toISOString() })
      .where(orm.eq(schema.inbox.teamId, teamId));

  /**
   * Runs worker batches until `done` holds, so unrelated queued jobs cannot
   * starve a test. Waits on observable state rather than a fixed number of
   * rounds: a loaded host gets the full wall-clock budget, and a genuine
   * regression still fails by exhausting it.
   */
  const WORKER_WAIT_MS = 20_000;
  const runWorker = async (done: () => Promise<boolean>) => {
    const deadline = Date.now() + WORKER_WAIT_MS;
    while (Date.now() < deadline) {
      if (await done()) return true;
      await runBatch();
      await Bun.sleep(25);
    }
    return done();
  };

  /** Storage adapter handed to the intake service in tests. */
  const intakeStorage = () => ({
    uploadIfAbsent: storage.uploadIfAbsent.bind(storage),
    remove: storage.remove.bind(storage),
    download: storage.download.bind(storage),
  });

  beforeAll(async () => {
    invoicePdf = new Uint8Array(
      await Bun.file(
        join(
          import.meta.dir,
          "../../../packages/documents/src/test/fixtures/synthetic-invoice.pdf",
        ),
      ).arrayBuffer(),
    );

    realDocuments = await import("@invoicewise/documents");
    mock.module("@invoicewise/documents", () => ({
      ...realDocuments,
      DocumentClient: FakeDocumentClient,
    }));

    // Local mailbox connector stub: one PDF attachment per sync, no provider
    // call ever leaves this test.
    mock.module("@invoicewise/inbox/connector", () => ({
      InboxConnector: class {
        async getAttachments() {
          return [
            {
              id: "attachment-1",
              filename: "invoice.pdf",
              mimeType: "application/pdf",
              size: invoicePdf.byteLength,
              referenceId: "message-1_0_invoice.pdf",
              data: Buffer.from(invoicePdf),
            },
          ];
        }
      },
    }));

    schema = await import("@invoicewise/db/schema");
    orm = await import("drizzle-orm");
    superjson = (await import("superjson")).default;
    client = await import("@invoicewise/db/client");
    queries = await import("@invoicewise/db/queries");
    intake = await import("@invoicewise/jobs/intake");
    storage = (await import("@invoicewise/db/storage")).createStorageClient({
      backend: "local",
      rootPath: storageRoot,
      signingSecret: process.env.STORAGE_SIGNING_SECRET!,
      publicUrl: BASE,
    });

    const { OpenAPIHono } = await import("@hono/zod-openapi");
    const { trpcServer } = await import("@hono/trpc-server");
    const { auth } = await import("@api/auth");
    const { getAuthSession } = await import("@api/auth");
    const { createTRPCContext } = await import("@api/trpc/init");
    const { appRouter } = await import("@api/trpc/routers/_app");
    const { routers } = await import("@api/rest/routers");
    const { storageCapabilityResponse } = await import("@api/storage/route");
    const intakeHttp = await import("@api/intake/http");
    handleInvoiceIntakeForTest = intakeHttp.handleInvoiceIntake;
    const { WorkflowRuntimeLive, runWorkflowBatch } = await import(
      "@invoicewise/jobs/runner"
    );
    const { Effect, LogLevel, Logger } = await import("effect");

    runBatch = async () => {
      await Effect.runPromise(
        runWorkflowBatch.pipe(
          Effect.provide(WorkflowRuntimeLive),
          Effect.provide(Logger.minimumLogLevel(LogLevel.None)),
          Effect.scoped,
        ),
      );
    };

    const app = new OpenAPIHono();

    app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
    app.use(
      "/trpc/*",
      trpcServer({ router: appRouter, createContext: createTRPCContext }),
    );
    app.get("/storage/*", (c) => storageCapabilityResponse(c.req.raw));
    app.post("/api/storage/upload", async (c) => {
      const session = await getAuthSession(c.req.raw.headers);
      if (!session?.teamId) {
        return c.json({ error: "Unauthorized" }, 401);
      }
      return intakeHttp.handleInvoiceIntake(c.req.raw, {
        teamId: session.teamId,
        db: client.primaryDb,
        storage: {
          ...intakeStorage(),
        },
      });
    });
    app.route("/", routers);

    server = Bun.serve({ port: PORT, fetch: app.fetch });
  });

  afterAll(async () => {
    server?.stop(true);
    await rm(storageRoot, { recursive: true, force: true });

    if (created.teamIds.length > 0) {
      await client.primaryDb
        .delete(schema.teams)
        .where(orm.inArray(schema.teams.id, created.teamIds));
    }
    if (created.userIds.length > 0) {
      await client.primaryDb
        .delete(schema.users)
        .where(orm.inArray(schema.users.id, created.userIds));
    }
    await client.closeDatabase();
  });

  // Keep unrelated queued work from earlier tests from starving later batches.
  afterEach(async () => {
    if (created.teamIds.length === 0) return;
    await client.primaryDb
      .delete(schema.workflowJobs)
      .where(orm.inArray(schema.workflowJobs.teamId, created.teamIds));
  });

  test("intake, worker, capability download and delete work end to end", async () => {
    const owner = await createUser("intake-owner");
    const teamId = owner.personalTeamId;

    const uploaded = await upload(
      owner.cookie,
      invoicePdf,
      "invoice.pdf",
      "application/pdf",
    );
    expect(uploaded.status).toBe(200);
    expect(uploaded.body?.id).toBeTruthy();
    expect(uploaded.body?.path?.[0]).toBe(teamId);
    expect(uploaded.body?.path?.[1]).toBe("inbox");

    const rows = await inboxRowsFor(teamId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.intakeState).toBe("accepted");
    expect(rows[0]?.status).toBe("processing");
    expect(rows[0]?.fileName).toBe("invoice.pdf");
    // The forged client path was ignored: the stored object is server-owned.
    expect(rows[0]?.filePath?.join("/")).toBe(uploaded.body?.path?.join("/"));

    const jobs = await workflowJobsFor(teamId);
    expect(jobs).toHaveLength(1);
    expect((jobs[0]?.payload as { inboxId?: string })?.inboxId).toBe(
      rows[0]?.id,
    );

    const processedOk = await runWorker(async () => {
      const [row] = await inboxRowsFor(teamId);
      return Boolean(row?.extraction);
    });
    expect(processedOk).toBe(true);
    const processed = (await inboxRowsFor(teamId))[0];
    expect(processed?.status).toBe("pending");

    const detail = await trpc(owner.cookie, "inbox.getById", {
      id: rows[0]!.id,
    });
    expect(detail.error).toBeNull();
    const signedUrl = (detail.data as { attachmentUrl: string }).attachmentUrl;
    expect(signedUrl).toContain(`inbox=${rows[0]!.id}`);

    const signed = new URL(signedUrl);
    const download = await get(signed.pathname + signed.search);
    expect(download.status).toBe(200);
    expect(download.headers.get("cache-control")).toBe("private, no-store");
    expect(download.headers.get("x-content-type-options")).toBe("nosniff");
    expect(download.headers.get("content-security-policy")).toContain(
      "sandbox",
    );
    expect(Buffer.from(await download.arrayBuffer()).length).toBe(
      invoicePdf.byteLength,
    );

    const deleted = await trpc(
      owner.cookie,
      "inbox.delete",
      { id: rows[0]!.id },
      "mutation",
    );
    expect(deleted.error).toBeNull();

    // Ordinary settled deletion has no unresolved publication outcome and
    // clears its removal tombstone after the object is removed.
    const [deletedRow] = await inboxRowsFor(teamId);
    expect(deletedRow?.objectRemovalPending).toBe(false);
    expect(deletedRow?.objectRemovalAmbiguous).toBe(false);

    // The capability URL stops working the moment the record is deleted.
    const afterDelete = await get(signed.pathname + signed.search);
    expect(afterDelete.status).toBe(401);

    const retry = await trpc(
      owner.cookie,
      "inbox.retry",
      { id: rows[0]!.id },
      "mutation",
    );
    expect(retry.data).toBeNull();
  }, 60_000);

  test("same filename survives twice, replay is idempotent and conflict never overwrites", async () => {
    const owner = await createUser("intake-dupe");
    const teamId = owner.personalTeamId;
    const otherBytes = buildPdf(1);

    const first = await upload(
      owner.cookie,
      invoicePdf,
      "invoice.pdf",
      "application/pdf",
    );
    expect(first.status).toBe(200);

    // A different document with the same original filename is a new document.
    const second = await upload(
      owner.cookie,
      otherBytes,
      "invoice.pdf",
      "application/pdf",
    );
    expect(second.status).toBe(200);
    expect(second.body?.id).not.toBe(first.body?.id);

    const rows = await inboxRowsFor(teamId);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.filePath?.join("/"))).size).toBe(2);
    expect(rows.every((row) => row.fileName === "invoice.pdf")).toBe(true);

    const storedFirst = Buffer.from(
      await (
        await storage.download({ bucket: "vault", path: first.body!.path! })
      ).arrayBuffer(),
    );
    expect(storedFirst.length).toBe(invoicePdf.byteLength);

    // Replaying the accepted bytes is the same workspace document.
    const replay = await upload(
      owner.cookie,
      invoicePdf,
      "invoice.pdf",
      "application/pdf",
    );
    expect(replay.status).toBe(200);
    expect(replay.body?.id).toBe(first.body?.id);
    expect(replay.body?.deduplicated).toBe(true);
    expect(await inboxRowsFor(teamId)).toHaveLength(2);
    expect(await workflowJobsFor(teamId)).toHaveLength(2);

    const afterReplay = Buffer.from(
      await (
        await storage.download({ bucket: "vault", path: first.body!.path! })
      ).arrayBuffer(),
    );
    expect(afterReplay.length).toBe(invoicePdf.byteLength);
  }, 60_000);

  test("a second workspace cannot process, sign, read or delete another workspace document", async () => {
    const ownerA = await createUser("intake-owner-a");
    const ownerB = await createUser("intake-owner-b");

    const uploaded = await upload(
      ownerB.cookie,
      invoicePdf,
      "invoice.pdf",
      "application/pdf",
    );
    expect(uploaded.status).toBe(200);
    const inboxId = uploaded.body!.id!;
    const objectPath = uploaded.body!.path!;

    // A cannot read or retry B's document by exact id.
    const read = await trpc(ownerA.cookie, "inbox.getById", { id: inboxId });
    expect(read.data ?? null).toBeNull();

    const retryByA = await trpc(
      ownerA.cookie,
      "inbox.retry",
      { id: inboxId },
      "mutation",
    );
    expect(retryByA.data).toBeNull();

    // A cannot delete B's document.
    const removeByA = await trpc(
      ownerA.cookie,
      "inbox.delete",
      { id: inboxId },
      "mutation",
    );
    expect(removeByA.error).not.toBeNull();
    const stillThere = await client.primaryDb
      .select({ status: schema.inbox.status })
      .from(schema.inbox)
      .where(orm.eq(schema.inbox.id, inboxId));
    expect(stillThere[0]?.status).not.toBe("deleted");

    // An unsigned or forged capability for the exact object path is refused.
    const forged = await get(
      `/storage/vault/${objectPath.map(encodeURIComponent).join("/")}?expires=9999999999&signature=deadbeef&inbox=${inboxId}`,
    );
    expect(forged.status).toBe(401);

    // A valid signature for B's object does not transfer to another record.
    const signed = new URL(
      await storage.signedUrl({
        bucket: "vault",
        path: objectPath,
        expireIn: 60,
        inboxId,
      }),
    );
    const swapped = new URL(signed);
    swapped.searchParams.set("inbox", crypto.randomUUID());
    const swappedResponse = await get(swapped.pathname + swapped.search);
    expect(swappedResponse.status).toBe(401);

    // Traversal-shaped paths are refused before any object read.
    const traversal = await get(
      `/storage/vault/..%2F..%2Fetc%2Fpasswd?expires=9999999999&signature=deadbeef&inbox=${inboxId}`,
    );
    expect(traversal.status).toBe(401);

    // An expired capability is refused even with a real signature.
    const shortLived = new URL(
      await storage.signedUrl({
        bucket: "vault",
        path: objectPath,
        expireIn: 1,
        inboxId,
      }),
    );
    shortLived.searchParams.set(
      "expires",
      String(Number(shortLived.searchParams.get("expires")) - 3600),
    );
    const expired = await get(shortLived.pathname + shortLived.search);
    expect(expired.status).toBe(401);
  }, 60_000);

  test("real bytes, declared type, size and parser bounds are enforced", async () => {
    const owner = await createUser("intake-validation");
    const teamId = owner.personalTeamId;

    const cases: {
      label: string;
      bytes: Uint8Array;
      fileName: string;
      declaredType: string;
      status: number;
      code: string;
    }[] = [
      {
        label: "MIME spoof",
        bytes: buildPng(64, 64),
        fileName: "invoice.pdf",
        declaredType: "application/pdf",
        status: 400,
        code: "content_mismatch",
      },
      {
        label: "unsupported image format",
        bytes: new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0]),
        fileName: "invoice.webp",
        declaredType: "image/webp",
        status: 400,
        code: "unsupported_type",
      },
      {
        label: "oversized document",
        bytes: new Uint8Array(5_000_001).fill(0x20),
        fileName: "big.pdf",
        declaredType: "application/pdf",
        status: 413,
        code: "too_large",
      },
      {
        label: "too many pages",
        bytes: buildPdf(51),
        fileName: "long.pdf",
        declaredType: "application/pdf",
        status: 400,
        code: "too_many_pages",
      },
      {
        label: "image pixel bound",
        bytes: new Uint8Array(
          await sharp({
            create: {
              width: 10_001,
              height: 10,
              channels: 3,
              background: "white",
            },
          })
            .png()
            .toBuffer(),
        ),
        fileName: "huge.png",
        declaredType: "image/png",
        status: 413,
        code: "image_too_large",
      },
      {
        label: "header-only image",
        bytes: buildPng(64, 64),
        fileName: "fake.png",
        declaredType: "image/png",
        status: 400,
        code: "malformed",
      },
      {
        label: "password protected",
        bytes: buildPdf(1, { encrypt: true }),
        fileName: "locked.pdf",
        declaredType: "application/pdf",
        status: 400,
        code: "password_protected",
      },
      {
        label: "malformed",
        bytes: new TextEncoder().encode("%PDF-1.4\nnope"),
        fileName: "broken.pdf",
        declaredType: "application/pdf",
        status: 400,
        code: "malformed",
      },
    ];

    for (const testCase of cases) {
      const response = await upload(
        owner.cookie,
        testCase.bytes,
        testCase.fileName,
        testCase.declaredType,
      );
      expect(`${testCase.label}: status ${response.status}`).toBe(
        `${testCase.label}: status ${testCase.status}`,
      );
      expect(`${testCase.label}: code ${response.body?.code}`).toBe(
        `${testCase.label}: code ${testCase.code}`,
      );
    }

    // Nothing was accepted or queued for the rejected attempts.
    expect(await inboxRowsFor(teamId)).toHaveLength(0);
    expect(await workflowJobsFor(teamId)).toHaveLength(0);

    // A traversal-shaped original filename is metadata only.
    const traversalName = await upload(
      owner.cookie,
      invoicePdf,
      "../../escape.pdf",
      "application/pdf",
    );
    expect(traversalName.status).toBe(200);
    const [row] = await inboxRowsFor(teamId);
    expect(row?.fileName).toBe("escape.pdf");
    expect(row?.filePath?.[0]).toBe(teamId);
    expect(row?.filePath?.join("/")).not.toContain("..");
  }, 60_000);

  test("parser admission is retryable through the upload HTTP boundary", async () => {
    const owner = await createUser("intake-admission-http");
    const teamId = owner.personalTeamId;

    const previousAdmission = process.env.IW_PDF_MAX_CONCURRENT;
    const previousQueued = process.env.IW_PDF_MAX_QUEUED;
    process.env.IW_PDF_MAX_CONCURRENT = "0";
    process.env.IW_PDF_MAX_QUEUED = "0";

    try {
      const blocked = await upload(
        owner.cookie,
        invoicePdf,
        "invoice.pdf",
        "application/pdf",
      );
      expect(blocked.status).toBe(503);
      expect(blocked.body?.code).toBe("temporarily_unavailable");
      expect(await inboxRowsFor(teamId)).toHaveLength(0);
    } finally {
      if (previousAdmission === undefined) {
        process.env.IW_PDF_MAX_CONCURRENT = "";
      } else {
        process.env.IW_PDF_MAX_CONCURRENT = previousAdmission;
      }
      if (previousQueued === undefined) {
        process.env.IW_PDF_MAX_QUEUED = "";
      } else {
        process.env.IW_PDF_MAX_QUEUED = previousQueued;
      }
    }

    const recovered = await upload(
      owner.cookie,
      invoicePdf,
      "invoice.pdf",
      "application/pdf",
    );
    expect(recovered.status).toBe(200);
    const [row] = await inboxRowsFor(teamId);
    expect(row?.intakeState).toBe("accepted");
  }, 60_000);

  test("saturated previews leave upload parser admission free", async () => {
    const owner = await createUser("intake-preview-saturation");
    const teamId = owner.personalTeamId;

    // Two preview slots and no preview queue: the same capacity the intake
    // pool has by default, so a shared pool would leave uploads waiting.
    const previousConcurrent = process.env.IW_PDF_PREVIEW_MAX_CONCURRENT;
    const previousQueued = process.env.IW_PDF_PREVIEW_MAX_QUEUED;
    process.env.IW_PDF_PREVIEW_MAX_CONCURRENT = "2";
    process.env.IW_PDF_PREVIEW_MAX_QUEUED = "0";
    let previewsSettled = false;
    const held = Promise.all(
      [0, 1].map(() =>
        realDocuments.runBusyProcessForTest({
          // Hold every preview slot far longer than the upload below can
          // plausibly take, so the "upload finished while previews were still
          // busy" assertion is a state check, not a race against the host's
          // wall-clock speed.
          spinMs: 20_000,
          timeoutMs: 60_000,
          admission: "preview",
        }),
      ),
    ).then((outcomes) => {
      previewsSettled = true;
      return outcomes;
    });

    try {
      const preview = await realDocuments.renderPdfPageIsolated(
        invoicePdf,
        {
          timeoutMs: 12_000,
          maxPages: 50,
          maxPageDimension: 10_000,
          maxTotalPixels: 25_000_000,
          maxChars: 0,
          admission: "preview",
        },
        { page: 1 },
      );
      expect(preview.ok).toBe(false);
      if (!preview.ok) expect(preview.code).toBe("busy");

      const accepted = await upload(
        owner.cookie,
        invoicePdf,
        "invoice.pdf",
        "application/pdf",
      );
      expect(accepted.status).toBe(200);
      // The upload finished while every preview slot was still occupied.
      expect(previewsSettled).toBe(false);
    } finally {
      process.env.IW_PDF_PREVIEW_MAX_CONCURRENT = previousConcurrent ?? "";
      process.env.IW_PDF_PREVIEW_MAX_QUEUED = previousQueued ?? "";
    }

    for (const { result } of await held) expect(result.ok).toBe(true);
    const [row] = await inboxRowsFor(teamId);
    expect(row?.intakeState).toBe("accepted");
  }, 90_000);

  test("no database connection is held while bytes move to or from storage", async () => {
    const owner = await createUser("intake-slow-storage");
    const teamId = owner.personalTeamId;

    // A one-connection pool: if intake held its connection (or a
    // transaction) across storage I/O, nothing else could use the pool
    // until the slow storage call returned.
    const narrow = client.createDatabaseClient({
      primaryUrl: testDatabaseUrl!,
      maxConnections: 1,
    });
    const observed: {
      stage: string;
      activeConnections: number;
      probe: "ran" | "blocked";
    }[] = [];

    const slowly = async <T>(stage: string, work: () => Promise<T>) => {
      const { active } = narrow.getConnectionPoolStats().pools.primary!;
      const probe = await Promise.race([
        narrow.primaryDb.execute(orm.sql`select 1`).then(() => "ran" as const),
        // Generous guard: a free connection answers in milliseconds even on a
        // loaded host, so only a genuinely held connection reaches this bound.
        Bun.sleep(10_000).then(() => "blocked" as const),
      ]);
      observed.push({ stage, activeConnections: active, probe });
      await Bun.sleep(500);
      return work();
    };

    try {
      const result = await intake.acceptIntakeUpload(
        narrow.primaryDb,
        {
          ...intakeStorage(),
          uploadIfAbsent: (input) =>
            slowly("upload", () => storage.uploadIfAbsent(input)),
          download: (input) =>
            slowly("download", () => storage.download(input)),
        },
        {
          teamId,
          bytes: invoicePdf,
          declaredMimeType: "application/pdf",
          fileName: "invoice.pdf",
        },
      );

      expect(result.status).toBe("accepted");
      expect(observed.map(({ stage }) => stage)).toEqual([
        "upload",
        "download",
      ]);
      for (const stage of observed) {
        expect(stage.activeConnections).toBe(0);
        expect(stage.probe).toBe("ran");
      }
    } finally {
      await narrow.close();
    }

    const [row] = await inboxRowsFor(teamId);
    expect(row?.intakeState).toBe("accepted");
    expect(await workflowJobsFor(teamId)).toHaveLength(1);
  }, 60_000);

  test("reservation and enqueue boundaries recover without an orphaned accepted invoice", async () => {
    const owner = await createUser("intake-recovery");
    const teamId = owner.personalTeamId;
    const bytes = buildPdf(1);

    // Crash after reserving but before the object is written.
    const reservedId = crypto.randomUUID();
    const filePath = [
      teamId,
      "inbox",
      reservedId,
      `${crypto.randomUUID()}.pdf`,
    ];
    const reserved = await queries.reserveInboxIntake(client.primaryDb, {
      id: reservedId,
      teamId,
      filePath,
      fileName: "invoice.pdf",
      displayName: "invoice.pdf",
      contentType: "application/pdf",
      size: bytes.byteLength,
      contentHash: intake.intakeContentHash(bytes),
    });
    expect(reserved?.id).toBe(reservedId);

    // Retrying the same content resumes the same reservation and path.
    const resumed = await upload(
      owner.cookie,
      bytes,
      "invoice.pdf",
      "application/pdf",
    );
    expect(resumed.status).toBe(200);
    expect(resumed.body?.id).toBe(reservedId);
    expect(resumed.body?.path?.join("/")).toBe(filePath.join("/"));
    expect(await workflowJobsFor(teamId)).toHaveLength(1);

    // Crash after the object is stored but before finalization.
    const storedBytes = buildPdf(2);
    const pendingId = crypto.randomUUID();
    const pendingPath = [
      teamId,
      "inbox",
      pendingId,
      `${crypto.randomUUID()}.pdf`,
    ];
    await queries.reserveInboxIntake(client.primaryDb, {
      id: pendingId,
      teamId,
      filePath: pendingPath,
      fileName: "pending.pdf",
      displayName: "pending.pdf",
      contentType: "application/pdf",
      size: storedBytes.byteLength,
      contentHash: intake.intakeContentHash(storedBytes),
    });
    await storage.uploadIfAbsent({
      bucket: "vault",
      path: pendingPath,
      file: storedBytes,
    });

    const recovered = await intake.acceptIntakeUpload(
      client.primaryDb,
      intakeStorage(),
      {
        teamId,
        bytes: storedBytes,
        declaredMimeType: "application/pdf",
        fileName: "pending.pdf",
      },
    );
    expect(recovered.status).toBe("accepted");
    if (recovered.status === "accepted") {
      expect(recovered.inboxId).toBe(pendingId);
      expect(recovered.filePath.join("/")).toBe(pendingPath.join("/"));
    }

    // Enqueue failure: the acceptance and the processing intent share one
    // transaction, so the failed attempt leaves no accepted invoice behind.
    const failingBytes = buildPdf(3);
    const failingId = crypto.randomUUID();
    const failingPath = [
      teamId,
      "inbox",
      failingId,
      `${crypto.randomUUID()}.pdf`,
    ];
    await queries.reserveInboxIntake(client.primaryDb, {
      id: failingId,
      teamId,
      filePath: failingPath,
      fileName: "failing.pdf",
      displayName: "failing.pdf",
      contentType: "application/pdf",
      size: failingBytes.byteLength,
      contentHash: intake.intakeContentHash(failingBytes),
    });

    await client.primaryDb.execute(
      orm.sql`CREATE OR REPLACE FUNCTION intake_test_fail_enqueue() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'intake test enqueue failure'; END;
      $$ LANGUAGE plpgsql`,
    );
    await client.primaryDb.execute(
      orm.sql`CREATE TRIGGER intake_test_fail_enqueue BEFORE INSERT ON workflow_jobs
        FOR EACH ROW EXECUTE FUNCTION intake_test_fail_enqueue()`,
    );

    let failed: Awaited<ReturnType<typeof intake.acceptIntakeUpload>>;
    try {
      failed = await intake.acceptIntakeUpload(
        client.primaryDb,
        intakeStorage(),
        {
          teamId,
          bytes: failingBytes,
          declaredMimeType: "application/pdf",
          fileName: "failing.pdf",
        },
      );
    } finally {
      await client.primaryDb.execute(
        orm.sql`DROP TRIGGER IF EXISTS intake_test_fail_enqueue ON workflow_jobs`,
      );
      await client.primaryDb.execute(
        orm.sql`DROP FUNCTION IF EXISTS intake_test_fail_enqueue()`,
      );
    }
    expect(failed.status).toBe("rejected");

    const afterFailure = await queries.getInboxIntakeBinding(client.primaryDb, {
      id: failingId,
      teamId,
    });
    // The acceptance and the processing intent share one transaction, so the
    // failed attempt leaves a resumable reservation rather than an accepted
    // invoice without queued work.
    expect(afterFailure?.intakeState).toBe("reserved");
    // The failure is durable: the row stays resumable and carries both the
    // reason and the outstanding removal intent for anything already written.
    expect(afterFailure?.intakeError).toContain("workflow_jobs");
    expect(afterFailure?.objectRemovalPending).toBe(true);

    const retried = await intake.acceptIntakeUpload(
      client.primaryDb,
      intakeStorage(),
      {
        teamId,
        bytes: failingBytes,
        declaredMimeType: "application/pdf",
        fileName: "failing.pdf",
      },
    );
    expect(retried.status).toBe("accepted");
    if (retried.status === "accepted") {
      expect(retried.inboxId).toBe(failingId);
    }
    const acceptedRow = await queries.getInboxIntakeBinding(client.primaryDb, {
      id: failingId,
      teamId,
    });
    expect(acceptedRow?.intakeState).toBe("accepted");

    // Explicit cleanup of an abandoned reservation removes its object.
    const abandonedId = crypto.randomUUID();
    const abandonedPath = [
      teamId,
      "inbox",
      abandonedId,
      `${crypto.randomUUID()}.pdf`,
    ];
    await queries.reserveInboxIntake(client.primaryDb, {
      id: abandonedId,
      teamId,
      filePath: abandonedPath,
      fileName: "abandoned.pdf",
      displayName: "abandoned.pdf",
      contentType: "application/pdf",
      size: 10,
      contentHash: crypto.randomUUID().replaceAll("-", ""),
    });
    await storage.uploadIfAbsent({
      bucket: "vault",
      path: abandonedPath,
      file: Buffer.from("abandoned"),
    });
    const cleanup = await intake.discardStaleReservations(
      client.primaryDb,
      intakeStorage(),
      { olderThanMs: -1 },
    );
    expect(cleanup.discarded).toContain(abandonedId);
    expect(cleanup.failed).toHaveLength(0);
    expect(
      storage.download({ bucket: "vault", path: abandonedPath }),
    ).rejects.toThrow();
  }, 60_000);

  test("the worker refuses missing, deleted and foreign bindings", async () => {
    const owner = await createUser("intake-worker");
    const teamId = owner.personalTeamId;

    const uploaded = await upload(
      owner.cookie,
      invoicePdf,
      "invoice.pdf",
      "application/pdf",
    );
    expect(uploaded.status).toBe(200);
    const inboxId = uploaded.body!.id!;

    // Missing binding: the payload id does not exist for this workspace.
    await queries.enqueueWorkflowJob(client.primaryDb, {
      name: "process-attachment",
      teamId,
      idempotencyKey: `${teamId}:foreign`,
      payload: { inboxId: crypto.randomUUID(), teamId },
    });
    const jobByKey = async (key: string) => {
      const [job] = await client.primaryDb
        .select()
        .from(schema.workflowJobs)
        .where(orm.eq(schema.workflowJobs.idempotencyKey, key));
      return job;
    };
    await runWorker(
      async () => (await jobByKey(`${teamId}:foreign`))?.status === "failed",
    );
    const foreignJob = await jobByKey(`${teamId}:foreign`);
    expect(foreignJob?.status).toBe("failed");
    expect(foreignJob?.lastError).toContain("not authorized");

    // Legacy serialized path that matches no persisted binding also fails.
    await queries.enqueueWorkflowJob(client.primaryDb, {
      name: "process-attachment",
      teamId,
      idempotencyKey: `${teamId}:legacy`,
      payload: {
        teamId,
        filePath: ["other-team", "inbox", "invoice.pdf"],
        mimetype: "application/pdf",
        size: invoicePdf.byteLength,
      },
    });
    await runWorker(
      async () => (await jobByKey(`${teamId}:legacy`))?.status === "failed",
    );
    const legacyJob = await jobByKey(`${teamId}:legacy`);
    expect(legacyJob?.status).toBe("failed");

    // Deleted binding: an accepted document that is then deleted stops work.
    const deleted = await trpc(
      owner.cookie,
      "inbox.delete",
      { id: inboxId },
      "mutation",
    );
    expect(deleted.error).toBeNull();

    await queries.enqueueWorkflowJob(client.primaryDb, {
      name: "process-attachment",
      teamId,
      idempotencyKey: `${teamId}:deleted`,
      payload: { inboxId, teamId },
    });
    await runWorker(
      async () => (await jobByKey(`${teamId}:deleted`))?.status === "failed",
    );
    const deletedJob = await jobByKey(`${teamId}:deleted`);
    expect(deletedJob?.status).toBe("failed");
  }, 60_000);

  test("a legacy queued job without an inbox row still runs for its own workspace", async () => {
    const owner = await createUser("intake-legacy-job");
    const teamId = owner.personalTeamId;
    const legacyPath = [teamId, "inbox", "legacy-mail.pdf"];
    await storage.uploadIfAbsent({
      bucket: "vault",
      path: legacyPath,
      file: invoicePdf,
    });

    const legacyPayload = {
      teamId,
      filePath: legacyPath,
      mimetype: "application/pdf",
      size: invoicePdf.byteLength,
      referenceId: `legacy-message-${crypto.randomUUID()}`,
    };
    const jobByKey = async (key: string) => {
      const [job] = await client.primaryDb
        .select()
        .from(schema.workflowJobs)
        .where(orm.eq(schema.workflowJobs.idempotencyKey, key));
      return job;
    };

    await queries.enqueueWorkflowJob(client.primaryDb, {
      name: "process-attachment",
      teamId,
      idempotencyKey: `${teamId}:legacy-first`,
      payload: legacyPayload,
    });
    const processed = await runWorker(
      async () =>
        (await jobByKey(`${teamId}:legacy-first`))?.status === "succeeded",
    );
    expect(processed).toBe(true);

    const rows = await inboxRowsFor(teamId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.filePath).toEqual(legacyPath);
    expect(rows[0]?.intakeState).toBeNull();
    expect(rows[0]?.extraction).toBeTruthy();

    // A retried legacy job for the finished row is idempotent: nothing is
    // extracted or posted again.
    await queries.enqueueWorkflowJob(client.primaryDb, {
      name: "process-attachment",
      teamId,
      idempotencyKey: `${teamId}:legacy-again`,
      payload: legacyPayload,
    });
    await queries.enqueueWorkflowJob(client.primaryDb, {
      name: "process-attachment",
      teamId,
      idempotencyKey: `${teamId}:legacy-by-id`,
      payload: { teamId, inboxId: rows[0]!.id },
    });
    for (const key of [`${teamId}:legacy-again`, `${teamId}:legacy-by-id`]) {
      expect(
        await runWorker(
          async () => (await jobByKey(key))?.status === "succeeded",
        ),
      ).toBe(true);
      expect((await jobByKey(key))?.result).toMatchObject({
        inboxId: rows[0]!.id,
        idempotent: true,
      });
    }
    expect(await inboxRowsFor(teamId)).toHaveLength(1);

    // A legacy path outside this workspace's document namespace never
    // creates a row.
    await queries.enqueueWorkflowJob(client.primaryDb, {
      name: "process-attachment",
      teamId,
      idempotencyKey: `${teamId}:legacy-assets`,
      payload: { ...legacyPayload, filePath: [teamId, "assets", "logo.pdf"] },
    });
    await runWorker(
      async () =>
        (await jobByKey(`${teamId}:legacy-assets`))?.status === "failed",
    );
    expect((await jobByKey(`${teamId}:legacy-assets`))?.status).toBe("failed");
    expect(await inboxRowsFor(teamId)).toHaveLength(1);
  }, 60_000);

  test("a missing stored object is retried instead of inventing a record", async () => {
    const owner = await createUser("intake-missing-object");
    const teamId = owner.personalTeamId;

    const uploaded = await upload(
      owner.cookie,
      invoicePdf,
      "invoice.pdf",
      "application/pdf",
    );
    expect(uploaded.status).toBe(200);

    await storage.remove({ bucket: "vault", path: uploaded.body!.path! });

    const retriedOnce = await runWorker(async () => {
      const [job] = await workflowJobsFor(teamId);
      return Boolean(job?.attempts);
    });
    expect(retriedOnce).toBe(true);

    const [job] = await workflowJobsFor(teamId);
    expect(job?.status).toBe("queued");
    expect(job?.attempts).toBe(1);

    const [row] = await inboxRowsFor(teamId);
    expect(row?.extraction).toBeNull();

    // Restoring the object lets the retry complete.
    await storage.upload({
      bucket: "vault",
      path: uploaded.body!.path!,
      file: invoicePdf,
    });
    await Bun.sleep(
      Math.max(0, new Date(job!.runAt).getTime() - Date.now() + 20),
    );
    const completed = await runWorker(async () => {
      const [current] = await workflowJobsFor(teamId);
      return current?.status === "succeeded";
    });
    expect(completed).toBe(true);

    const [recoveredJob] = await workflowJobsFor(teamId);
    expect(recoveredJob?.status).toBe("succeeded");
    const [processed] = await inboxRowsFor(teamId);
    expect(processed?.extraction).toBeTruthy();
  }, 60_000);

  test("bounds the actual HTTP body before parsing", async () => {
    const owner = await createUser("intake-body-bound");
    const teamId = owner.personalTeamId;

    // A multipart body with padding far above the bound and no content-length:
    // the bytes are counted while reading, so the request never reaches the
    // parser.
    const formData = new FormData();
    formData.set("padding", "x".repeat(6_000_001));
    formData.set(
      "file",
      new File([Buffer.from(invoicePdf)], "invoice.pdf", {
        type: "application/pdf",
      }),
    );
    const request = new Request(`${BASE}/api/storage/upload`, {
      method: "POST",
      body: formData,
    });
    expect(request.headers.get("content-length")).toBeNull();

    const response = await handleInvoiceIntakeForTest(request, {
      teamId,
      db: client.primaryDb,
      storage: intakeStorage(),
    });
    expect(response.status).toBe(413);
    expect(await inboxRowsFor(teamId)).toHaveLength(0);
    expect(await workflowJobsFor(teamId)).toHaveLength(0);
  }, 60_000);

  test("rejects an existing object whose bytes do not match the reservation", async () => {
    const owner = await createUser("intake-conflict-object");
    const teamId = owner.personalTeamId;

    const inboxId = crypto.randomUUID();
    const filePath = [teamId, "inbox", inboxId, `${crypto.randomUUID()}.pdf`];
    await queries.reserveInboxIntake(client.primaryDb, {
      id: inboxId,
      teamId,
      filePath,
      fileName: "invoice.pdf",
      displayName: "invoice.pdf",
      contentType: "application/pdf",
      size: invoicePdf.byteLength,
      contentHash: intake.intakeContentHash(invoicePdf),
    });

    // Same size, different bytes: an earlier attempt or a third party left a
    // conflicting object at the reserved path.
    const conflicting = new Uint8Array(invoicePdf);
    conflicting[conflicting.byteLength - 1] =
      conflicting[conflicting.byteLength - 1] === 10 ? 32 : 10;
    await storage.uploadIfAbsent({
      bucket: "vault",
      path: filePath,
      file: conflicting,
    });

    const result = await intake.acceptIntakeUpload(
      client.primaryDb,
      intakeStorage(),
      {
        teamId,
        bytes: invoicePdf,
        declaredMimeType: "application/pdf",
        fileName: "invoice.pdf",
      },
    );

    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.code).toBe("content_mismatch");
    }
    expect(await workflowJobsFor(teamId)).toHaveLength(0);

    const binding = await queries.getInboxIntakeBinding(client.primaryDb, {
      id: inboxId,
      teamId,
    });
    const stored = new Uint8Array(
      await (
        await storage.download({ bucket: "vault", path: filePath })
      ).arrayBuffer(),
    );
    expect(binding).toBeDefined();
    expect(intake.verifyStoredIntake(binding!, stored).ok).toBe(false);
    expect(binding?.intakeState).not.toBe("accepted");
  }, 60_000);

  test("concurrent replay of the same bytes creates one document and one job", async () => {
    const owner = await createUser("intake-concurrent");
    const teamId = owner.personalTeamId;

    // Publication is immutable and acceptance serializes on the canonical
    // row, so two simultaneous attempts with different provider references
    // cannot double-publish.
    const results = await Promise.all(
      ["ref-a", "ref-b"].map((referenceId) =>
        intake.acceptIntakeUpload(client.primaryDb, intakeStorage(), {
          teamId,
          bytes: invoicePdf,
          declaredMimeType: "application/pdf",
          fileName: "invoice.pdf",
          referenceId,
        }),
      ),
    );

    expect(results.every((result) => result.status === "accepted")).toBe(true);
    expect(
      new Set(
        results.map((result) =>
          result.status === "accepted" ? result.inboxId : result.code,
        ),
      ).size,
    ).toBe(1);
    expect(await inboxRowsFor(teamId)).toHaveLength(1);
    expect(await workflowJobsFor(teamId)).toHaveLength(1);
  }, 60_000);

  test("cleanup never deletes a reservation that finished accepting", async () => {
    const owner = await createUser("intake-cleanup");
    const teamId = owner.personalTeamId;

    const first = await queries.reserveInboxIntake(client.primaryDb, {
      id: crypto.randomUUID(),
      teamId,
      filePath: [teamId, "inbox", crypto.randomUUID(), "first.pdf"],
      fileName: "invoice.pdf",
      displayName: "invoice.pdf",
      contentType: "application/pdf",
      size: invoicePdf.byteLength,
      contentHash: intake.intakeContentHash(invoicePdf),
    });
    expect(first).toBeDefined();

    // Acceptance happens inside the cleanup remove hook, i.e. after the
    // cleanup has chosen its candidates.
    let acceptedDuringCleanup: string | null = null;
    const cleanup = await intake.discardStaleReservations(
      client.primaryDb,
      {
        ...intakeStorage(),
        remove: async (input) => {
          const accepted = await intake.acceptIntakeUpload(
            client.primaryDb,
            intakeStorage(),
            {
              teamId,
              bytes: invoicePdf,
              declaredMimeType: "application/pdf",
              fileName: "invoice.pdf",
            },
          );
          acceptedDuringCleanup =
            accepted.status === "accepted" ? accepted.inboxId : null;
          return storage.remove(input);
        },
      },
      { olderThanMs: 1, limit: 100 },
    );

    expect(acceptedDuringCleanup).not.toBeNull();
    const survivor = await queries.getInboxIntakeBinding(client.primaryDb, {
      id: acceptedDuringCleanup!,
      teamId,
    });
    expect(survivor?.intakeState).toBe("accepted");
    expect(cleanup.failed).toHaveLength(0);
    expect(cleanup.discarded).not.toContain(acceptedDuringCleanup);
    if (survivor?.filePath?.length) {
      const bytes = await storage.download({
        bucket: "vault",
        path: survivor.filePath,
      });
      expect(bytes.size).toBe(invoicePdf.byteLength);
    }
  }, 60_000);

  test("a claimed reservation cannot be accepted and later bytes are not lost", async () => {
    const owner = await createUser("intake-cleanup-claim");
    const teamId = owner.personalTeamId;

    const reservation = await queries.reserveInboxIntake(client.primaryDb, {
      id: crypto.randomUUID(),
      teamId,
      filePath: [teamId, "inbox", crypto.randomUUID(), "claimed.pdf"],
      fileName: "invoice.pdf",
      displayName: "invoice.pdf",
      contentType: "application/pdf",
      size: invoicePdf.byteLength,
      contentHash: intake.intakeContentHash(invoicePdf),
    });
    expect(reservation).toBeDefined();
    await storage.uploadIfAbsent({
      bucket: "vault",
      path: reservation!.filePath!,
      file: invoicePdf,
    });

    const claimed = await queries.claimReservedIntakeForDiscard(
      client.primaryDb,
      { id: reservation!.id, teamId },
    );
    expect(claimed?.id).toBe(reservation!.id);

    // The claimed record is dead: accepting the same bytes creates a new
    // document rather than resurrecting it, and the new bytes stay readable.
    const later = await intake.acceptIntakeUpload(
      client.primaryDb,
      intakeStorage(),
      {
        teamId,
        bytes: invoicePdf,
        declaredMimeType: "application/pdf",
        fileName: "invoice.pdf",
      },
    );
    expect(later.status).toBe("accepted");
    if (later.status === "accepted") {
      expect(later.inboxId).not.toBe(reservation!.id);
      const bytes = await storage.download({
        bucket: "vault",
        path: later.filePath,
      });
      expect(bytes.size).toBe(invoicePdf.byteLength);
    }
  }, 60_000);

  test("provider references are workspace scoped and occurrences are distinct", async () => {
    const ownerA = await createUser("intake-ref-a");
    const ownerB = await createUser("intake-ref-b");

    const first = await intake.acceptIntakeUpload(
      client.primaryDb,
      intakeStorage(),
      {
        teamId: ownerA.personalTeamId,
        bytes: invoicePdf,
        declaredMimeType: "application/pdf",
        fileName: "invoice.pdf",
        referenceId: "shared-provider-reference",
      },
    );
    const otherTeam = await intake.acceptIntakeUpload(
      client.primaryDb,
      intakeStorage(),
      {
        teamId: ownerB.personalTeamId,
        bytes: invoicePdf,
        declaredMimeType: "application/pdf",
        fileName: "invoice.pdf",
        referenceId: "shared-provider-reference",
      },
    );
    expect(first.status).toBe("accepted");
    expect(otherTeam.status).toBe("accepted");

    // The same reference in one workspace with different bytes is a visible
    // conflict rather than a malformed binding.
    const sameTeamConflict = await intake.acceptIntakeUpload(
      client.primaryDb,
      intakeStorage(),
      {
        teamId: ownerA.personalTeamId,
        bytes: new Uint8Array([...invoicePdf, 10]),
        declaredMimeType: "application/pdf",
        fileName: "invoice.pdf",
        referenceId: "shared-provider-reference",
      },
    );
    expect(sameTeamConflict.status).toBe("rejected");
    if (sameTeamConflict.status === "rejected") {
      expect(sameTeamConflict.code).toBe("reference_conflict");
    }

    // Two same-named attachments in one message are separate occurrences.
    const occurrenceOne = await intake.acceptIntakeUpload(
      client.primaryDb,
      intakeStorage(),
      {
        teamId: ownerA.personalTeamId,
        bytes: new Uint8Array([...invoicePdf, 1]),
        declaredMimeType: "application/pdf",
        fileName: "invoice.pdf",
        referenceId: "message-1_0_invoice.pdf",
      },
    );
    const occurrenceTwo = await intake.acceptIntakeUpload(
      client.primaryDb,
      intakeStorage(),
      {
        teamId: ownerA.personalTeamId,
        bytes: new Uint8Array([...invoicePdf, 2]),
        declaredMimeType: "application/pdf",
        fileName: "invoice.pdf",
        referenceId: "message-1_1_invoice.pdf",
      },
    );
    expect(occurrenceOne.status).toBe("accepted");
    expect(occurrenceTwo.status).toBe("accepted");
  }, 60_000);

  test("reserved mailbox attachments are retried, not treated as handled", async () => {
    const owner = await createUser("intake-reserved-attachment");
    const teamId = owner.personalTeamId;

    const reserved = await queries.reserveInboxIntake(client.primaryDb, {
      id: crypto.randomUUID(),
      teamId,
      filePath: [teamId, "inbox", crypto.randomUUID(), "reserved.pdf"],
      fileName: "invoice.pdf",
      displayName: "invoice.pdf",
      contentType: "application/pdf",
      size: invoicePdf.byteLength,
      contentHash: intake.intakeContentHash(invoicePdf),
      referenceId: "message-9_0_invoice.pdf",
    });
    expect(reserved).toBeDefined();

    expect(
      await queries.getExistingInboxAttachments(client.primaryDb, teamId, [
        "message-9_0_invoice.pdf",
      ]),
    ).toHaveLength(0);

    const accepted = await intake.acceptIntakeUpload(
      client.primaryDb,
      intakeStorage(),
      {
        teamId,
        bytes: invoicePdf,
        declaredMimeType: "application/pdf",
        fileName: "invoice.pdf",
        referenceId: "message-9_0_invoice.pdf",
      },
    );
    expect(accepted.status).toBe("accepted");
    expect(
      await queries.getExistingInboxAttachments(client.primaryDb, teamId, [
        "message-9_0_invoice.pdf",
      ]),
    ).toHaveLength(1);
  }, 60_000);

  test("retry is accepted-only and idempotent while work is pending", async () => {
    const owner = await createUser("intake-retry");
    const teamId = owner.personalTeamId;

    const accepted = await intake.acceptIntakeUpload(
      client.primaryDb,
      intakeStorage(),
      {
        teamId,
        bytes: invoicePdf,
        declaredMimeType: "application/pdf",
        fileName: "invoice.pdf",
      },
    );
    expect(accepted.status).toBe("accepted");
    if (accepted.status !== "accepted") return;

    const first = await intake.retryIntakeProcessing(client.primaryDb, {
      teamId,
      inboxId: accepted.inboxId,
    });
    const second = await intake.retryIntakeProcessing(client.primaryDb, {
      teamId,
      inboxId: accepted.inboxId,
    });
    expect(first?.jobId).toBe(second?.jobId);
    expect(second?.deduplicated).toBe(true);
    // The pending initial job is reused instead of queueing a second one.
    expect(await workflowJobsFor(teamId)).toHaveLength(1);

    const reserved = await queries.reserveInboxIntake(client.primaryDb, {
      id: crypto.randomUUID(),
      teamId,
      filePath: [teamId, "inbox", crypto.randomUUID(), "reserved.pdf"],
      fileName: "invoice.pdf",
      displayName: "invoice.pdf",
      contentType: "application/pdf",
      size: invoicePdf.byteLength,
      contentHash: intake.intakeContentHash(new Uint8Array([...invoicePdf, 3])),
    });
    expect(
      await intake.retryIntakeProcessing(client.primaryDb, {
        teamId,
        inboxId: reserved!.id,
      }),
    ).toBeNull();
  }, 60_000);

  test("a legacy row cannot read or delete another workspace's object", async () => {
    const ownerA = await createUser("intake-legacy-a");
    const ownerB = await createUser("intake-legacy-b");
    const teamA = ownerA.personalTeamId;
    const teamB = ownerB.personalTeamId;

    // B owns real bytes at a path A's legacy row will point at.
    const victimPath = [teamB, "inbox", "victim.pdf"];
    await storage.uploadIfAbsent({
      bucket: "vault",
      path: victimPath,
      file: invoicePdf,
    });

    const legacyId = crypto.randomUUID();
    await client.primaryDb.insert(schema.inbox).values({
      id: legacyId,
      teamId: teamA,
      filePath: victimPath,
      fileName: "legacy.pdf",
      displayName: "legacy.pdf",
      contentType: "application/pdf",
      size: invoicePdf.byteLength,
      status: "processing",
    });

    // Neither resolver may hand this row to a read or a worker.
    expect(
      await intake.resolveTeamDocumentBinding(client.primaryDb, {
        teamId: teamA,
        id: legacyId,
      }),
    ).toBeNull();
    expect(
      await intake.resolveWorkerIntakeBinding(client.primaryDb, {
        teamId: teamA,
        inboxId: legacyId,
      }),
    ).toBeNull();

    // A valid signature for the mismatched row still fails closed.
    const signed = new URL(
      await storage.signedUrl({
        bucket: "vault",
        path: victimPath,
        expireIn: 60,
        inboxId: legacyId,
      }),
    );
    expect((await get(signed.pathname + signed.search)).status).toBe(401);

    // The dashboard read path must not sign it either.
    const read = await trpc(ownerA.cookie, "inbox.getById", { id: legacyId });
    expect(
      (read.data as { attachmentUrl?: string | null } | null)?.attachmentUrl,
    ).toBeFalsy();

    // Deleting A's row must never remove B's object.
    await queries
      .deleteInbox(client.primaryDb, { id: legacyId, teamId: teamA })
      .catch(() => undefined);
    expect(
      await storage
        .download({ bucket: "vault", path: victimPath })
        .then(() => true)
        .catch(() => false),
    ).toBe(true);

    // Cleanup must not select the unbound row either.
    const cleanup = await intake.discardStaleReservations(
      client.primaryDb,
      intakeStorage(),
      { olderThanMs: -1, limit: 100 },
    );
    expect(cleanup.discarded).not.toContain(legacyId);
    expect(
      await storage
        .download({ bucket: "vault", path: victimPath })
        .then(() => true)
        .catch(() => false),
    ).toBe(true);
  }, 60_000);

  test("concurrent retries serialize on the inbox row", async () => {
    const owner = await createUser("intake-retry-race");
    const teamId = owner.personalTeamId;

    const accepted = await intake.acceptIntakeUpload(
      client.primaryDb,
      intakeStorage(),
      {
        teamId,
        bytes: invoicePdf,
        declaredMimeType: "application/pdf",
        fileName: "invoice.pdf",
      },
    );
    expect(accepted.status).toBe("accepted");
    if (accepted.status !== "accepted") return;

    // Clear the initial job so every retry has to decide for itself.
    await client.primaryDb
      .delete(schema.workflowJobs)
      .where(orm.eq(schema.workflowJobs.teamId, teamId));

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        intake.retryIntakeProcessing(client.primaryDb, {
          teamId,
          inboxId: accepted.inboxId,
        }),
      ),
    );

    const jobIds = new Set(
      results.map((result) => result?.jobId).filter(Boolean),
    );
    expect(jobIds.size).toBe(1);
    expect(await workflowJobsFor(teamId)).toHaveLength(1);
  }, 60_000);

  test("a failed cleanup removal is durably retried", async () => {
    const owner = await createUser("intake-cleanup-retry");
    const teamId = owner.personalTeamId;

    const reservation = await queries.reserveInboxIntake(client.primaryDb, {
      id: crypto.randomUUID(),
      teamId,
      filePath: [teamId, "inbox", crypto.randomUUID(), "retry.pdf"],
      fileName: "invoice.pdf",
      displayName: "invoice.pdf",
      contentType: "application/pdf",
      size: invoicePdf.byteLength,
      contentHash: intake.intakeContentHash(invoicePdf),
    });
    expect(reservation).toBeDefined();
    await storage.uploadIfAbsent({
      bucket: "vault",
      path: reservation!.filePath!,
      file: invoicePdf,
    });

    const failing = await intake.discardStaleReservations(
      client.primaryDb,
      {
        ...intakeStorage(),
        remove: async () => {
          throw new Error("synthetic temporary removal failure");
        },
      },
      { olderThanMs: -1, limit: 100 },
    );
    expect(failing.failed.map((entry) => entry.id)).toContain(reservation!.id);
    expect(
      await storage
        .download({ bucket: "vault", path: reservation!.filePath! })
        .then(() => true)
        .catch(() => false),
    ).toBe(true);

    const binding = await queries.getInboxIntakeBinding(client.primaryDb, {
      id: reservation!.id,
      teamId,
    });
    expect(binding?.objectRemovalPending).toBe(true);

    // The next pass revisits the recorded failure and finishes the removal.
    const retried = await intake.discardStaleReservations(
      client.primaryDb,
      intakeStorage(),
      { olderThanMs: -1, limit: 100 },
    );
    expect(retried.discarded).toContain(reservation!.id);
    expect(retried.failed).toHaveLength(0);
    expect(
      await storage
        .download({ bucket: "vault", path: reservation!.filePath! })
        .then(() => true)
        .catch(() => false),
    ).toBe(false);
  }, 60_000);

  test("a crash after the discard claim still removes the object", async () => {
    const owner = await createUser("intake-crash-claim");
    const teamId = owner.personalTeamId;

    const reservation = await queries.reserveInboxIntake(client.primaryDb, {
      id: crypto.randomUUID(),
      teamId,
      filePath: [teamId, "inbox", crypto.randomUUID(), "crash.pdf"],
      fileName: "invoice.pdf",
      displayName: "invoice.pdf",
      contentType: "application/pdf",
      size: invoicePdf.byteLength,
      contentHash: intake.intakeContentHash(invoicePdf),
    });
    expect(reservation).toBeDefined();
    await storage.uploadIfAbsent({
      bucket: "vault",
      path: reservation!.filePath!,
      file: invoicePdf,
    });

    // Durable claim, then simulate process death before the object is removed.
    const claimed = await queries.claimReservedIntakeForDiscard(
      client.primaryDb,
      { id: reservation!.id, teamId },
    );
    expect(claimed?.id).toBe(reservation!.id);
    const afterClaim = await queries.getInboxIntakeBinding(client.primaryDb, {
      id: reservation!.id,
      teamId,
    });
    expect(afterClaim?.objectRemovalPending).toBe(true);
    expect(afterClaim?.intakeState).toBe("cancelled");

    // The next cleanup pass recovers the intent and removes the bytes.
    const recovery = await intake.discardStaleReservations(
      client.primaryDb,
      intakeStorage(),
      { olderThanMs: -1, limit: 100 },
    );
    expect(recovery.discarded).toContain(reservation!.id);
    expect(
      await storage
        .download({ bucket: "vault", path: reservation!.filePath! })
        .then(() => true)
        .catch(() => false),
    ).toBe(false);
  }, 60_000);

  test("ambiguous publication stays pending through later passes until explicit settlement", async () => {
    const owner = await createUser("intake-ambiguous-reconciliation");
    const teamId = owner.personalTeamId;
    let latePath: string[] = [];

    const firstAttempt = await intake.acceptIntakeUpload(
      client.primaryDb,
      {
        ...intakeStorage(),
        uploadIfAbsent: async (input) => {
          latePath = input.path as string[];
          throw new Error("synthetic transport abort; remote outcome unknown");
        },
      },
      {
        teamId,
        bytes: invoicePdf,
        declaredMimeType: "application/pdf",
        fileName: "invoice.pdf",
      },
    );
    expect(firstAttempt.status).toBe("rejected");
    if (firstAttempt.status === "rejected") {
      expect(firstAttempt.code).toBe("storage_unavailable");
    }

    const [reserved] = await inboxRowsFor(teamId);
    expect(reserved?.objectRemovalPending).toBe(true);
    expect(reserved?.objectRemovalAmbiguous).toBe(true);
    await expirePublicationLeases(teamId);

    // Two immediate passes cannot establish settlement: the remote write may
    // still arrive later. Both passes must leave the ambiguous intent intact.
    for (let pass = 0; pass < 2; pass++) {
      const cleanup = await intake.discardStaleReservations(
        client.primaryDb,
        intakeStorage(),
        { olderThanMs: -1, limit: 100 },
      );
      expect(cleanup.discarded).toContain(reserved!.id);
      expect(cleanup.unresolved).toContain(reserved!.id);
      const [afterPass] = await inboxRowsFor(teamId);
      expect(afterPass?.objectRemovalPending).toBe(true);
      expect(afterPass?.objectRemovalAmbiguous).toBe(true);
    }

    // The remote publication arrives after both passes; the third pass must
    // still revisit the row and remove the late bytes.
    await storage.uploadIfAbsent({
      bucket: "vault",
      path: latePath,
      file: invoicePdf,
    });
    const lateCleanup = await intake.discardStaleReservations(
      client.primaryDb,
      intakeStorage(),
      { olderThanMs: -1, limit: 100 },
    );
    expect(lateCleanup.discarded).toContain(reserved!.id);
    expect(lateCleanup.unresolved).toContain(reserved!.id);
    expect(
      await storage
        .download({ bucket: "vault", path: latePath })
        .then(() => true)
        .catch(() => false),
    ).toBe(false);
    const [afterLatePass] = await inboxRowsFor(teamId);
    expect(afterLatePass?.objectRemovalPending).toBe(true);
    expect(afterLatePass?.objectRemovalAmbiguous).toBe(true);

    // Explicit provider/operator settlement is the only path that clears the
    // ambiguity marker; verified accepted retry is the other accepted path.
    const settlement = await queries.settleAmbiguousObjectRemoval(
      client.primaryDb,
      {
        id: reserved!.id,
        teamId,
        evidence: "synthetic provider reconciliation: no in-flight write",
      },
    );
    expect(settlement?.id).toBe(reserved!.id);
    const [settled] = await inboxRowsFor(teamId);
    expect(settled?.objectRemovalPending).toBe(false);
    expect(settled?.objectRemovalAmbiguous).toBe(false);

    const afterSettlement = await intake.discardStaleReservations(
      client.primaryDb,
      intakeStorage(),
      { olderThanMs: -1, limit: 100 },
    );
    expect(afterSettlement.discarded).not.toContain(reserved!.id);
  }, 60_000);

  test("delete and cancel preserve unresolved publication ambiguity across late writes", async () => {
    const deleteOwner = await createUser("intake-delete-ambiguous");
    const deleteTeamId = deleteOwner.personalTeamId;
    let deletePath: string[] = [];

    const deleteAttempt = await intake.acceptIntakeUpload(
      client.primaryDb,
      {
        ...intakeStorage(),
        uploadIfAbsent: async (input) => {
          deletePath = input.path as string[];
          throw new Error("synthetic transport abort; remote outcome unknown");
        },
      },
      {
        teamId: deleteTeamId,
        bytes: invoicePdf,
        declaredMimeType: "application/pdf",
        fileName: "invoice.pdf",
      },
    );
    expect(deleteAttempt.status).toBe("rejected");
    await expirePublicationLeases(deleteTeamId);
    const [beforeDelete] = await inboxRowsFor(deleteTeamId);
    await queries.deleteInbox(client.primaryDb, {
      id: beforeDelete!.id,
      teamId: deleteTeamId,
    });

    // Delete must not erase the failed-write ambiguity, and must not clear it
    // after immediate cleanup passes have no object to remove.
    for (let pass = 0; pass < 2; pass++) {
      const cleanup = await intake.discardStaleReservations(
        client.primaryDb,
        intakeStorage(),
        { olderThanMs: -1, limit: 100 },
      );
      expect(cleanup.unresolved).toContain(beforeDelete!.id);
    }
    await storage.uploadIfAbsent({
      bucket: "vault",
      path: deletePath,
      file: invoicePdf,
    });
    const deleteLateCleanup = await intake.discardStaleReservations(
      client.primaryDb,
      intakeStorage(),
      { olderThanMs: -1, limit: 100 },
    );
    expect(deleteLateCleanup.discarded).toContain(beforeDelete!.id);
    expect(
      await storage
        .download({ bucket: "vault", path: deletePath })
        .then(() => true)
        .catch(() => false),
    ).toBe(false);
    const [afterDeleteLate] = await inboxRowsFor(deleteTeamId);
    expect(afterDeleteLate?.intakeState).toBe("cancelled");
    expect(afterDeleteLate?.objectRemovalPending).toBe(true);
    expect(afterDeleteLate?.objectRemovalAmbiguous).toBe(true);

    const cancelOwner = await createUser("intake-cancel-ambiguous");
    const cancelTeamId = cancelOwner.personalTeamId;
    let cancelPath: string[] = [];

    const cancelAttempt = await intake.acceptIntakeUpload(
      client.primaryDb,
      {
        ...intakeStorage(),
        uploadIfAbsent: async (input) => {
          cancelPath = input.path as string[];
          throw new Error("synthetic transport abort; remote outcome unknown");
        },
      },
      {
        teamId: cancelTeamId,
        bytes: invoicePdf,
        declaredMimeType: "application/pdf",
        fileName: "invoice.pdf",
      },
    );
    expect(cancelAttempt.status).toBe("rejected");
    await expirePublicationLeases(cancelTeamId);
    const [beforeCancel] = await inboxRowsFor(cancelTeamId);
    await queries.cancelInboxIntake(client.primaryDb, {
      id: beforeCancel!.id,
      teamId: cancelTeamId,
      error: "operator cancellation after ambiguous publication",
    });

    for (let pass = 0; pass < 2; pass++) {
      const cleanup = await intake.discardStaleReservations(
        client.primaryDb,
        intakeStorage(),
        { olderThanMs: -1, limit: 100 },
      );
      expect(cleanup.unresolved).toContain(beforeCancel!.id);
    }
    await storage.uploadIfAbsent({
      bucket: "vault",
      path: cancelPath,
      file: invoicePdf,
    });
    const cancelLateCleanup = await intake.discardStaleReservations(
      client.primaryDb,
      intakeStorage(),
      { olderThanMs: -1, limit: 100 },
    );
    expect(cancelLateCleanup.discarded).toContain(beforeCancel!.id);
    expect(
      await storage
        .download({ bucket: "vault", path: cancelPath })
        .then(() => true)
        .catch(() => false),
    ).toBe(false);
    const [afterCancelLate] = await inboxRowsFor(cancelTeamId);
    expect(afterCancelLate?.intakeState).toBe("cancelled");
    expect(afterCancelLate?.objectRemovalPending).toBe(true);
    expect(afterCancelLate?.objectRemovalAmbiguous).toBe(true);

    // A plain reserved cancellation is also conservatively ambiguous because
    // the reservation may have had an in-flight writer.
    const reservedOwner = await createUser("intake-cancel-reserved");
    const reservedTeamId = reservedOwner.personalTeamId;
    const reservedId = crypto.randomUUID();
    await queries.reserveInboxIntake(client.primaryDb, {
      id: reservedId,
      teamId: reservedTeamId,
      filePath: [reservedTeamId, "inbox", reservedId, "reserved.pdf"],
      fileName: "reserved.pdf",
      displayName: "reserved.pdf",
      contentType: "application/pdf",
      size: invoicePdf.byteLength,
      contentHash: intake.intakeContentHash(invoicePdf),
    });
    await queries.cancelInboxIntake(client.primaryDb, {
      id: reservedId,
      teamId: reservedTeamId,
      error: "plain reserved cancellation",
    });
    const [afterReservedCancel] = await inboxRowsFor(reservedTeamId);
    expect(afterReservedCancel?.objectRemovalPending).toBe(true);
    expect(afterReservedCancel?.objectRemovalAmbiguous).toBe(true);
  }, 60_000);

  test("explicit cleanup paginates unresolved removals without starving later rows", async () => {
    const owner = await createUser("intake-cleanup-pagination");
    const teamId = owner.personalTeamId;
    const reservations: { id: string }[] = [];

    for (let index = 0; index < 3; index++) {
      const id = crypto.randomUUID();
      const reservation = await queries.reserveInboxIntake(client.primaryDb, {
        id,
        teamId,
        filePath: [teamId, "inbox", id, `paginated-${index}.pdf`],
        fileName: `paginated-${index}.pdf`,
        displayName: `paginated-${index}.pdf`,
        contentType: "application/pdf",
        size: 10,
        contentHash: crypto.randomUUID().replaceAll("-", ""),
      });
      expect(reservation).toBeDefined();
      await queries.recordInboxIntakeRemovalIntent(client.primaryDb, {
        id,
        teamId,
        error: "synthetic ambiguous removal",
      });
      reservations.push({ id });
      await Bun.sleep(5);
    }

    const processed = new Set<string>();
    const unresolved = new Set<string>();
    let cursor: Awaited<
      ReturnType<typeof intake.discardStaleReservations>
    >["nextPendingCursor"] = null;
    let exhausted = false;

    // Follow the deterministic cursor to the end of the pending-removal pass.
    // A page may contain only legacy/invalid rows, so the assertion is on the
    // full traversal rather than on the first page.
    for (let page = 0; page < 20; page++) {
      const cleanup = await intake.discardStaleReservations(
        client.primaryDb,
        intakeStorage(),
        {
          olderThanMs: -1,
          limit: 1,
          ...(cursor ? { pendingAfter: cursor } : {}),
        },
      );
      for (const id of cleanup.discarded) processed.add(id);
      for (const id of cleanup.unresolved) unresolved.add(id);
      if (!cleanup.hasMorePending) {
        expect(cleanup.nextPendingCursor).toBeNull();
        exhausted = true;
        break;
      }
      expect(cleanup.nextPendingCursor).not.toBeNull();
      cursor = cleanup.nextPendingCursor;
    }
    expect(exhausted).toBe(true);

    for (const { id } of reservations) {
      expect(processed.has(id)).toBe(true);
      expect(unresolved.has(id)).toBe(true);
    }
  }, 60_000);

  test("cleanup cannot claim a row while a publication is writing it", async () => {
    const owner = await createUser("intake-late-write");
    const teamId = owner.personalTeamId;

    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let latePath: string[] = [];

    const writing = intake.acceptIntakeUpload(
      client.primaryDb,
      {
        ...intakeStorage(),
        uploadIfAbsent: async (input: {
          bucket: string;
          path: string[];
          file: Uint8Array;
        }) => {
          latePath = input.path;
          started();
          await gate;
          return storage.uploadIfAbsent(input);
        },
      },
      {
        teamId,
        bytes: invoicePdf,
        declaredMimeType: "application/pdf",
        fileName: "invoice.pdf",
      },
    );

    // Cleanup runs while the writer holds the publication lease; it must leave
    // the row alone instead of tombstoning it underneath the publication.
    await startedPromise;
    const cleanup = intake.discardStaleReservations(
      client.primaryDb,
      intakeStorage(),
      { olderThanMs: -1, limit: 100 },
    );
    await Bun.sleep(200);
    release();

    const [lateResult, cleanupResult] = await Promise.all([writing, cleanup]);
    expect(lateResult.status).toBe("accepted");
    expect(cleanupResult.discarded).not.toContain(
      lateResult.status === "accepted" ? lateResult.inboxId : "",
    );

    // The accepted document keeps its bytes; nothing was tombstoned or removed.
    const [row] = await inboxRowsFor(teamId);
    expect(row?.intakeState).toBe("accepted");
    expect(
      await storage
        .download({ bucket: "vault", path: latePath })
        .then(() => true)
        .catch(() => false),
    ).toBe(true);
  }, 60_000);

  test("pending cleanup cannot delete a retry that holds the publication lease", async () => {
    const owner = await createUser("intake-pending-retry-race");
    const teamId = owner.personalTeamId;

    const reservation = await queries.reserveInboxIntake(client.primaryDb, {
      id: crypto.randomUUID(),
      teamId,
      filePath: [teamId, "inbox", crypto.randomUUID(), "pending-retry.pdf"],
      fileName: "invoice.pdf",
      displayName: "invoice.pdf",
      contentType: "application/pdf",
      size: invoicePdf.byteLength,
      contentHash: intake.intakeContentHash(invoicePdf),
    });
    expect(reservation).toBeDefined();
    await storage.uploadIfAbsent({
      bucket: "vault",
      path: reservation!.filePath!,
      file: invoicePdf,
    });
    await queries.recordInboxIntakeRemovalIntent(client.primaryDb, {
      id: reservation!.id,
      teamId,
      error: "synthetic ambiguous publication",
    });

    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const writing = intake.acceptIntakeUpload(
      client.primaryDb,
      {
        ...intakeStorage(),
        uploadIfAbsent: async (input) => {
          started();
          await gate;
          return storage.uploadIfAbsent(input);
        },
      },
      {
        teamId,
        bytes: invoicePdf,
        declaredMimeType: "application/pdf",
        fileName: "invoice.pdf",
      },
    );

    await startedPromise;
    // The retry holds the publication lease. Cleanup can read the pending
    // tombstone but its claim must skip the leased row, and once the retry
    // accepts it clears the tombstone.
    const cleanup = intake.discardStaleReservations(
      client.primaryDb,
      intakeStorage(),
      { olderThanMs: -1, limit: 100 },
    );
    await Bun.sleep(200);
    release();

    const [lateResult, cleanupResult] = await Promise.all([writing, cleanup]);
    expect(lateResult.status).toBe("accepted");
    expect(cleanupResult.discarded).not.toContain(reservation!.id);

    const [row] = await inboxRowsFor(teamId);
    expect(row?.intakeState).toBe("accepted");
    expect(row?.objectRemovalPending).toBe(false);
    expect(row?.objectRemovalAmbiguous).toBe(false);
    expect(
      await storage
        .download({ bucket: "vault", path: reservation!.filePath! })
        .then(() => true)
        .catch(() => false),
    ).toBe(true);
  }, 60_000);

  test("a failed attempt does not release the lease a concurrent attempt still holds", async () => {
    const owner = await createUser("intake-shared-lease");
    const teamId = owner.personalTeamId;

    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let path: string[] = [];

    const writing = intake.acceptIntakeUpload(
      client.primaryDb,
      {
        ...intakeStorage(),
        uploadIfAbsent: async (input) => {
          path = input.path as string[];
          started();
          await gate;
          return storage.uploadIfAbsent(input);
        },
      },
      {
        teamId,
        bytes: invoicePdf,
        declaredMimeType: "application/pdf",
        fileName: "invoice.pdf",
      },
    );
    await startedPromise;

    // A second attempt for the same content fails its write while the first
    // is still writing, leaving an ambiguous removal intent on the shared row.
    const failed = await intake.acceptIntakeUpload(
      client.primaryDb,
      {
        ...intakeStorage(),
        uploadIfAbsent: async () => {
          throw new Error("synthetic storage timeout");
        },
      },
      {
        teamId,
        bytes: invoicePdf,
        declaredMimeType: "application/pdf",
        fileName: "invoice.pdf",
      },
    );
    expect(failed.status).toBe("rejected");
    const [pending] = await inboxRowsFor(teamId);
    expect(pending?.objectRemovalPending).toBe(true);
    expect(pending?.objectRemovalAmbiguous).toBe(true);

    // Cleanup must still treat the row as leased by the writing attempt.
    const cleanup = await intake.discardStaleReservations(
      client.primaryDb,
      intakeStorage(),
      { olderThanMs: -1, limit: 100 },
    );
    expect(cleanup.discarded).not.toContain(pending!.id);

    release();
    const result = await writing;
    expect(result.status).toBe("accepted");
    const [row] = await inboxRowsFor(teamId);
    expect(row?.intakeState).toBe("accepted");
    expect(row?.objectRemovalPending).toBe(false);
    expect(row?.objectRemovalAmbiguous).toBe(false);
    expect(
      await storage
        .download({ bucket: "vault", path })
        .then(() => true)
        .catch(() => false),
    ).toBe(true);
  }, 60_000);

  test("a publication that lands after its record was deleted is reclaimed", async () => {
    const owner = await createUser("intake-late-publication");
    const teamId = owner.personalTeamId;

    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let latePath: string[] = [];
    const exists = () =>
      storage
        .download({ bucket: "vault", path: latePath })
        .then(() => true)
        .catch(() => false);

    // A slow attempt starts writing, then a second attempt with the same
    // content accepts the document, which is deleted and fully cleaned up
    // before the slow write finally lands.
    const late = intake.acceptIntakeUpload(
      client.primaryDb,
      {
        ...intakeStorage(),
        uploadIfAbsent: async (input) => {
          latePath = input.path as string[];
          started();
          await gate;
          return storage.uploadIfAbsent(input);
        },
      },
      {
        teamId,
        bytes: invoicePdf,
        declaredMimeType: "application/pdf",
        fileName: "invoice.pdf",
      },
    );
    await startedPromise;

    const accepted = await intake.acceptIntakeUpload(
      client.primaryDb,
      intakeStorage(),
      {
        teamId,
        bytes: invoicePdf,
        declaredMimeType: "application/pdf",
        fileName: "invoice.pdf",
      },
    );
    expect(accepted.status).toBe("accepted");
    if (accepted.status !== "accepted") return;
    await queries.cancelInboxIntake(client.primaryDb, {
      id: accepted.inboxId,
      teamId,
      error: "deleted by the workspace",
    });
    const settled = await intake.discardStaleReservations(
      client.primaryDb,
      intakeStorage(),
      { olderThanMs: -1, limit: 100 },
    );
    expect(settled.discarded).toContain(accepted.inboxId);
    expect(await exists()).toBe(false);

    release();
    const lateResult = await late;
    expect(lateResult.status).toBe("rejected");
    if (lateResult.status === "rejected") {
      expect(lateResult.code).toBe("superseded");
    }

    // The late bytes belong to no live record: removal intent is durable.
    expect(await exists()).toBe(true);
    const [row] = await inboxRowsFor(teamId);
    expect(row?.intakeState).toBe("cancelled");
    expect(row?.objectRemovalPending).toBe(true);
    expect(row?.objectRemovalAmbiguous).toBe(true);

    const reclaimed = await intake.discardStaleReservations(
      client.primaryDb,
      intakeStorage(),
      { olderThanMs: -1, limit: 100 },
    );
    expect(reclaimed.discarded).toContain(accepted.inboxId);
    expect(await exists()).toBe(false);
  }, 60_000);

  test("a publication that fails after writing records durable removal intent", async () => {
    const owner = await createUser("intake-late-write-failure");
    const teamId = owner.personalTeamId;

    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let latePath: string[] = [];

    const writing = intake.acceptIntakeUpload(
      client.primaryDb,
      {
        ...intakeStorage(),
        uploadIfAbsent: async (input: {
          bucket: string;
          path: string[];
          file: Uint8Array;
        }) => {
          latePath = input.path;
          started();
          await gate;
          return storage.uploadIfAbsent(input);
        },
        download: async () => {
          throw new Error("synthetic temporary read failure");
        },
      },
      {
        teamId,
        bytes: invoicePdf,
        declaredMimeType: "application/pdf",
        fileName: "invoice.pdf",
      },
    );

    await startedPromise;
    release();
    const result = await writing;
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.code).toBe("storage_unavailable");
    }

    // The bytes were published before the failure, so the failure path must
    // have recorded removal intent instead of relying on a compensation catch.
    const [row] = await inboxRowsFor(teamId);
    expect(row?.objectRemovalPending).toBe(true);
    expect(row?.id).toBeTruthy();

    // The failed attempt leaves its lease to expire rather than clearing it.
    const leased = await intake.discardStaleReservations(
      client.primaryDb,
      intakeStorage(),
      { olderThanMs: -1, limit: 100 },
    );
    expect(leased.discarded).not.toContain(row!.id);
    await expirePublicationLeases(teamId);

    const cleanup = await intake.discardStaleReservations(
      client.primaryDb,
      intakeStorage(),
      { olderThanMs: -1, limit: 100 },
    );
    expect(cleanup.discarded).toContain(row!.id);
    expect(
      await storage
        .download({ bucket: "vault", path: latePath })
        .then(() => true)
        .catch(() => false),
    ).toBe(false);
  }, 60_000);

  test("a transient readback failure stays transient and recoverable", async () => {
    const owner = await createUser("intake-readback");
    const teamId = owner.personalTeamId;

    const readFailure = await intake.acceptIntakeUpload(
      client.primaryDb,
      {
        ...intakeStorage(),
        download: async () => {
          throw new Error("synthetic temporary read failure");
        },
      },
      {
        teamId,
        bytes: invoicePdf,
        declaredMimeType: "application/pdf",
        fileName: "invoice.pdf",
      },
    );

    expect(readFailure.status).toBe("rejected");
    if (readFailure.status === "rejected") {
      expect(readFailure.code).toBe("storage_unavailable");
    }
    // No job was queued and the reservation is still resumable.
    expect(await workflowJobsFor(teamId)).toHaveLength(0);
    const [row] = await inboxRowsFor(teamId);
    expect(row?.intakeState).toBe("reserved");

    // The same bytes succeed once the read works again.
    const recovered = await intake.acceptIntakeUpload(
      client.primaryDb,
      intakeStorage(),
      {
        teamId,
        bytes: invoicePdf,
        declaredMimeType: "application/pdf",
        fileName: "invoice.pdf",
      },
    );
    expect(recovered.status).toBe("accepted");
    if (recovered.status !== "accepted") return;

    // The retry must clear the removal intent atomically. A later cleanup pass
    // must not treat the accepted bytes as an orphan.
    const [acceptedAfterRetry] = await inboxRowsFor(teamId);
    expect(acceptedAfterRetry?.intakeState).toBe("accepted");
    expect(acceptedAfterRetry?.objectRemovalPending).toBe(false);
    expect(acceptedAfterRetry?.objectRemovalAmbiguous).toBe(false);

    const cleanupAfterRetry = await intake.discardStaleReservations(
      client.primaryDb,
      intakeStorage(),
      { olderThanMs: -1, limit: 100 },
    );
    expect(cleanupAfterRetry.discarded).not.toContain(recovered.inboxId);
    expect(
      await storage
        .download({ bucket: "vault", path: recovered.filePath })
        .then(() => true)
        .catch(() => false),
    ).toBe(true);
  }, 60_000);

  test("a failed intake stays retryable after a cleanup pass", async () => {
    const owner = await createUser("intake-cleanup-reference");
    const teamId = owner.personalTeamId;
    const input = {
      teamId,
      bytes: invoicePdf,
      declaredMimeType: "application/pdf",
      fileName: "invoice.pdf",
      referenceId: `message-${crypto.randomUUID()}_0_invoice.pdf`,
    };

    const failed = await intake.acceptIntakeUpload(
      client.primaryDb,
      {
        ...intakeStorage(),
        download: async () => {
          throw new Error("synthetic temporary read failure");
        },
      },
      input,
    );
    expect(failed.status).toBe("rejected");
    if (failed.status === "rejected") {
      expect(failed.code).toBe("storage_unavailable");
    }
    const [reserved] = await inboxRowsFor(teamId);
    expect(reserved?.intakeState).toBe("reserved");

    const cleanup = await intake.discardStaleReservations(
      client.primaryDb,
      intakeStorage(),
      { olderThanMs: 60 * 60 * 1000, limit: 10_000 },
    );
    expect(cleanup.discarded).not.toContain(reserved!.id);

    const retried = await intake.acceptIntakeUpload(
      client.primaryDb,
      intakeStorage(),
      input,
    );
    expect(retried.status).toBe("accepted");
  }, 60_000);

  test("a transient mailbox sync failure is retried instead of advancing the account", async () => {
    const owner = await createUser("intake-mailbox-transient");
    const teamId = owner.personalTeamId;

    const accountId = crypto.randomUUID();
    const initialAccess = "2026-01-01T00:00:00.000Z";
    await client.primaryDb.insert(schema.inboxAccounts).values({
      id: accountId,
      teamId,
      provider: "gmail",
      externalId: `external-${accountId}`,
      email: `mailbox-${accountId}@example.test`,
      accessToken: "stub-access-token",
      refreshToken: "stub-refresh-token",
      expiryDate: "2030-01-01T00:00:00.000Z",
      lastAccessed: initialAccess,
      status: "connected",
    });

    const [beforeSync] = await client.primaryDb
      .select()
      .from(schema.inboxAccounts)
      .where(orm.eq(schema.inboxAccounts.id, accountId));
    const accessBeforeFailure = beforeSync?.lastAccessed;

    // Make the vault write fail deterministically: the team's vault directory
    // is a file, so the local backend cannot create the object path.
    await Bun.write(join(storageRoot, "vault", teamId), "not a directory");

    await queries.enqueueWorkflowJob(client.primaryDb, {
      name: "sync-inbox-account",
      teamId,
      idempotencyKey: `${teamId}:mailbox-transient`,
      payload: { id: accountId },
    });

    const attempted = await runWorker(async () => {
      const [job] = await client.primaryDb
        .select()
        .from(schema.workflowJobs)
        .where(
          orm.eq(
            schema.workflowJobs.idempotencyKey,
            `${teamId}:mailbox-transient`,
          ),
        );
      return Boolean(job?.attempts);
    });
    expect(attempted).toBe(true);

    const [job] = await client.primaryDb
      .select()
      .from(schema.workflowJobs)
      .where(
        orm.eq(
          schema.workflowJobs.idempotencyKey,
          `${teamId}:mailbox-transient`,
        ),
      );
    // Retryable failure, not a completed sync.
    expect(job?.status).toBe("queued");
    expect(job?.attempts).toBe(1);
    expect(job?.lastError ?? "").toContain("could not store");

    // The account was not advanced and no intake record was accepted.
    const [account] = await client.primaryDb
      .select()
      .from(schema.inboxAccounts)
      .where(orm.eq(schema.inboxAccounts.id, accountId));
    expect(account?.lastAccessed).toBe(accessBeforeFailure);
    expect(account?.status).toBe("connected");

    // The failed attempt left a resumable reservation (with durable removal
    // intent for anything it may have written), not an accepted invoice.
    const [reservation] = await inboxRowsFor(teamId);
    expect(reservation?.intakeState).toBe("reserved");
    expect(reservation?.objectRemovalPending).toBe(true);

    // The recovery path works once storage is writable again.
    await storage
      .remove({ bucket: "vault", path: [teamId] })
      .catch(() => undefined);
    await rm(join(storageRoot, "vault", teamId), { force: true });
    const recovered = await runWorker(async () => {
      const [current] = await client.primaryDb
        .select()
        .from(schema.workflowJobs)
        .where(
          orm.eq(
            schema.workflowJobs.idempotencyKey,
            `${teamId}:mailbox-transient`,
          ),
        );
      return current?.status === "succeeded";
    });
    expect(recovered).toBe(true);
    const [acceptedRow] = await inboxRowsFor(teamId);
    expect(acceptedRow?.intakeState).toBe("accepted");
    const teamJobs = await workflowJobsFor(teamId);
    expect(
      teamJobs.filter((job) => job.name === "process-attachment"),
    ).toHaveLength(1);
    const [advanced] = await client.primaryDb
      .select()
      .from(schema.inboxAccounts)
      .where(orm.eq(schema.inboxAccounts.id, accountId));
    expect(advanced?.lastAccessed).not.toBe(accessBeforeFailure);
  }, 60_000);

  test("a valid invoice rejected by parser admission is retried through mailbox sync", async () => {
    const owner = await createUser("intake-mailbox-admission");
    const teamId = owner.personalTeamId;

    const accountId = crypto.randomUUID();
    const initialAccess = "2026-01-01T00:00:00.000Z";
    await client.primaryDb.insert(schema.inboxAccounts).values({
      id: accountId,
      teamId,
      provider: "gmail",
      externalId: `external-${accountId}`,
      email: `mailbox-${accountId}@example.test`,
      accessToken: "stub-access-token",
      refreshToken: "stub-refresh-token",
      expiryDate: "2030-01-01T00:00:00.000Z",
      lastAccessed: initialAccess,
      status: "connected",
    });

    const [beforeSync] = await client.primaryDb
      .select()
      .from(schema.inboxAccounts)
      .where(orm.eq(schema.inboxAccounts.id, accountId));
    const accessBeforeFailure = beforeSync?.lastAccessed;

    const previousAdmission = process.env.IW_PDF_MAX_CONCURRENT;
    process.env.IW_PDF_MAX_CONCURRENT = "0";

    try {
      await queries.enqueueWorkflowJob(client.primaryDb, {
        name: "sync-inbox-account",
        teamId,
        idempotencyKey: `${teamId}:mailbox-admission`,
        payload: { id: accountId },
      });

      const attempted = await runWorker(async () => {
        const [job] = await client.primaryDb
          .select()
          .from(schema.workflowJobs)
          .where(
            orm.eq(
              schema.workflowJobs.idempotencyKey,
              `${teamId}:mailbox-admission`,
            ),
          );
        return Boolean(job?.attempts);
      });
      expect(attempted).toBe(true);

      const [failedJob] = await client.primaryDb
        .select()
        .from(schema.workflowJobs)
        .where(
          orm.eq(
            schema.workflowJobs.idempotencyKey,
            `${teamId}:mailbox-admission`,
          ),
        );
      expect(failedJob?.status).toBe("queued");
      expect(failedJob?.lastError ?? "").toContain("temporarily");

      // Capacity failure happens before reservation. The next mailbox sync
      // must still see the attachment as unhandled and must not advance the
      // account cursor.
      expect(await inboxRowsFor(teamId)).toHaveLength(0);
      const [notAdvanced] = await client.primaryDb
        .select()
        .from(schema.inboxAccounts)
        .where(orm.eq(schema.inboxAccounts.id, accountId));
      expect(notAdvanced?.lastAccessed).toBe(accessBeforeFailure);
    } finally {
      if (previousAdmission === undefined) {
        process.env.IW_PDF_MAX_CONCURRENT = "";
      } else {
        process.env.IW_PDF_MAX_CONCURRENT = previousAdmission;
      }
    }

    // The same valid invoice succeeds through the real sync workflow once
    // admission is available.
    const recovered = await runWorker(async () => {
      const [job] = await client.primaryDb
        .select()
        .from(schema.workflowJobs)
        .where(
          orm.eq(
            schema.workflowJobs.idempotencyKey,
            `${teamId}:mailbox-admission`,
          ),
        );
      return job?.status === "succeeded";
    });
    expect(recovered).toBe(true);

    const [acceptedRow] = await inboxRowsFor(teamId);
    expect(acceptedRow?.intakeState).toBe("accepted");
    expect(
      (await workflowJobsFor(teamId)).filter(
        (job) => job.name === "process-attachment",
      ),
    ).toHaveLength(1);
    const [advanced] = await client.primaryDb
      .select()
      .from(schema.inboxAccounts)
      .where(orm.eq(schema.inboxAccounts.id, accountId));
    expect(advanced?.lastAccessed).not.toBe(accessBeforeFailure);
  }, 60_000);

  test("capability URLs fail closed for malformed, legacy and retained bytes", async () => {
    const owner = await createUser("intake-capability");
    const other = await createUser("intake-capability-other");
    const teamId = owner.personalTeamId;

    // Malformed percent-encoding must not escape the error boundary.
    const malformed = await get(
      `/storage/vault/%E0%A4%A?expires=9999999999&signature=deadbeef&inbox=${crypto.randomUUID()}`,
    );
    expect(malformed.status).toBe(401);

    // A legacy row (null intake state) whose persisted path points into another
    // workspace is never served, even with a valid signature.
    const legacyId = crypto.randomUUID();
    const legacyPath = [other.personalTeamId, "inbox", "legacy.pdf"];
    await client.primaryDb.insert(schema.inbox).values({
      id: legacyId,
      teamId,
      filePath: legacyPath,
      fileName: "legacy.pdf",
      displayName: "legacy.pdf",
      contentType: "application/pdf",
      size: 3,
      status: "pending",
    });
    await storage.uploadIfAbsent({
      bucket: "vault",
      path: legacyPath,
      file: Buffer.from("abc"),
    });
    const legacyUrl = new URL(
      await storage.signedUrl({
        bucket: "vault",
        path: legacyPath,
        expireIn: 60,
        inboxId: legacyId,
      }),
    );
    expect((await get(legacyUrl.pathname + legacyUrl.search)).status).toBe(401);

    // Retained bytes after a cancelled record are not readable.
    const accepted = await intake.acceptIntakeUpload(
      client.primaryDb,
      intakeStorage(),
      {
        teamId,
        bytes: invoicePdf,
        declaredMimeType: "application/pdf",
        fileName: "invoice.pdf",
      },
    );
    expect(accepted.status).toBe("accepted");
    if (accepted.status !== "accepted") return;

    const signed = new URL(
      await storage.signedUrl({
        bucket: "vault",
        path: accepted.filePath,
        expireIn: 60,
        inboxId: accepted.inboxId,
      }),
    );
    expect((await get(signed.pathname + signed.search)).status).toBe(200);

    await queries.cancelInboxIntake(client.primaryDb, {
      id: accepted.inboxId,
      teamId,
      error: "simulated failed removal",
    });
    // The object is intentionally left behind: the binding check still refuses.
    expect(
      await storage
        .download({ bucket: "vault", path: accepted.filePath })
        .then(() => true)
        .catch(() => false),
    ).toBe(true);
    expect((await get(signed.pathname + signed.search)).status).toBe(401);
  }, 60_000);

  test("two same-named Gmail attachments in one message are both accepted", async () => {
    const owner = await createUser("intake-gmail-occurrence");
    const teamId = owner.personalTeamId;
    const { generateDeterministicId, gmailAttachmentReferenceIds } =
      await import("../../../packages/inbox/src/generate-id");

    const messageId = "18c2f0a1b2c3d4e5";
    const [firstRef, secondRef] = gmailAttachmentReferenceIds(messageId, [
      "invoice.pdf",
      "invoice.pdf",
    ]);
    // Mail synced before occurrence identity keeps deduplicating.
    expect(firstRef).toBe(generateDeterministicId(`${messageId}_invoice.pdf`));

    const results = [];
    for (const [index, referenceId] of [firstRef!, secondRef!].entries()) {
      results.push(
        await intake.acceptIntakeUpload(client.primaryDb, intakeStorage(), {
          teamId,
          bytes: new Uint8Array([...invoicePdf, 10 + index]),
          declaredMimeType: "application/pdf",
          fileName: "invoice.pdf",
          referenceId,
        }),
      );
    }
    expect(results.map((result) => result.status)).toEqual([
      "accepted",
      "accepted",
    ]);
    const rows = await inboxRowsFor(teamId);
    expect(new Set(rows.map((row) => row.referenceId))).toEqual(
      new Set<string | null>([firstRef!, secondRef!]),
    );
  }, 60_000);

  test("an update cannot delete; deletion runs the delete lifecycle", async () => {
    const owner = await createUser("intake-update-delete");
    const teamId = owner.personalTeamId;
    const { updateInboxSchema } = await import("@api/schemas/inbox");

    const accepted = await intake.acceptIntakeUpload(
      client.primaryDb,
      intakeStorage(),
      {
        teamId,
        bytes: invoicePdf,
        declaredMimeType: "application/pdf",
        fileName: "invoice.pdf",
      },
    );
    expect(accepted.status).toBe("accepted");
    if (accepted.status !== "accepted") return;

    // REST PATCH and tRPC share the schema; neither accepts `deleted`.
    expect(
      updateInboxSchema.safeParse({ id: accepted.inboxId, status: "deleted" })
        .success,
    ).toBe(false);
    const rejected = await trpc(
      owner.cookie,
      "inbox.update",
      { id: accepted.inboxId, status: "deleted" },
      "mutation",
    );
    expect(rejected.status).toBe(400);
    const [unchanged] = await inboxRowsFor(teamId);
    expect(unchanged?.status).not.toBe("deleted");
    expect(unchanged?.intakeState).toBe("accepted");

    // The delete procedure tombstones the binding and removes the object, so
    // the same bytes can be uploaded again as a new document.
    const deleted = await trpc(
      owner.cookie,
      "inbox.delete",
      { id: accepted.inboxId },
      "mutation",
    );
    expect(deleted.error).toBeNull();
    expect(
      await storage
        .download({ bucket: "vault", path: accepted.filePath })
        .then(() => true)
        .catch(() => false),
    ).toBe(false);
    const again = await intake.acceptIntakeUpload(
      client.primaryDb,
      intakeStorage(),
      {
        teamId,
        bytes: invoicePdf,
        declaredMimeType: "application/pdf",
        fileName: "invoice.pdf",
      },
    );
    expect(again.status).toBe("accepted");
    if (again.status === "accepted") {
      expect(again.inboxId).not.toBe(accepted.inboxId);
    }
  }, 60_000);

  test("deleting a legacy row keeps an object another live row still uses", async () => {
    const owner = await createUser("intake-legacy-shared");
    const teamId = owner.personalTeamId;
    const sharedPath = [teamId, "inbox", "shared-invoice.pdf"];
    await storage.uploadIfAbsent({
      bucket: "vault",
      path: sharedPath,
      file: invoicePdf,
    });

    const [firstId, secondId, thirdId] = [
      crypto.randomUUID(),
      crypto.randomUUID(),
      crypto.randomUUID(),
    ];
    for (const id of [firstId, secondId, thirdId]) {
      await client.primaryDb.insert(schema.inbox).values({
        id,
        teamId,
        filePath: sharedPath,
        fileName: "shared-invoice.pdf",
        displayName: "shared-invoice.pdf",
        contentType: "application/pdf",
        size: invoicePdf.byteLength,
        status: "pending",
      });
    }
    const objectExists = () =>
      storage
        .download({ bucket: "vault", path: sharedPath })
        .then(() => true)
        .catch(() => false);

    await queries.deleteInbox(client.primaryDb, { id: firstId, teamId });
    expect(await objectExists()).toBe(true);
    const [first] = (await inboxRowsFor(teamId)).filter(
      (row) => row.id === firstId,
    );
    expect(first?.status).toBe("deleted");
    expect(first?.objectRemovalPending).toBe(false);

    // A pending removal for a legacy row (for example one whose earlier
    // removal failed) is not completed by cleanup while a sharer is live.
    await client.primaryDb
      .update(schema.inbox)
      .set({
        status: "deleted",
        intakeState: "cancelled",
        objectRemovalPending: true,
      })
      .where(orm.eq(schema.inbox.id, secondId));
    const cleanup = await intake.discardStaleReservations(
      client.primaryDb,
      intakeStorage(),
      { olderThanMs: 60 * 60 * 1000, limit: 1_000 },
    );
    expect(cleanup.retained).toContain(secondId);
    expect(cleanup.discarded).not.toContain(secondId);
    expect(await objectExists()).toBe(true);

    // The live sharer still reads its bytes; the last delete removes them.
    const read = await trpc(owner.cookie, "inbox.getById", { id: thirdId });
    expect(
      (read.data as { attachmentUrl?: string | null } | null)?.attachmentUrl,
    ).toBeTruthy();
    await queries.deleteInbox(client.primaryDb, { id: thirdId, teamId });
    expect(await objectExists()).toBe(false);
  }, 60_000);

  test("unaccepted reservations are hidden from reads, exports and signing", async () => {
    const owner = await createUser("intake-reserved-hidden");
    const teamId = owner.personalTeamId;

    const accepted = await intake.acceptIntakeUpload(
      client.primaryDb,
      intakeStorage(),
      {
        teamId,
        bytes: invoicePdf,
        declaredMimeType: "application/pdf",
        fileName: "invoice.pdf",
      },
    );
    expect(accepted.status).toBe("accepted");
    if (accepted.status !== "accepted") return;

    const reservedId = crypto.randomUUID();
    const reservedPath = [teamId, "inbox", reservedId, "reserved.pdf"];
    await client.primaryDb.insert(schema.inbox).values({
      id: reservedId,
      teamId,
      filePath: reservedPath,
      fileName: "reserved.pdf",
      displayName: "reserved.pdf",
      contentType: "application/pdf",
      size: invoicePdf.byteLength,
      status: "processing",
      intakeState: "reserved",
    });
    await storage.uploadIfAbsent({
      bucket: "vault",
      path: reservedPath,
      file: invoicePdf,
    });

    const listed = await trpc(owner.cookie, "inbox.get", {});
    const listedIds = (
      listed.data as { data: { id: string }[] } | null
    )?.data.map((row) => row.id);
    expect(listedIds).toContain(accepted.inboxId);
    expect(listedIds).not.toContain(reservedId);

    // REST/MCP listings, detail reads and the CSV export share these queries.
    const apiList = await queries.getInbox(client.db, { teamId });
    expect(apiList.data.map((row) => row.id)).not.toContain(reservedId);
    expect(
      await queries.getInboxById(client.db, { id: reservedId, teamId }),
    ).toBeUndefined();
    const exported = await queries.getInvoiceExportRows(client.db, teamId);
    expect(exported.map((row) => row.id)).toContain(accepted.inboxId);
    expect(exported.map((row) => row.id)).not.toContain(reservedId);

    const detail = await trpc(owner.cookie, "inbox.getById", {
      id: reservedId,
    });
    expect(detail.data ?? null).toBeNull();
    expect(
      await intake.resolveTeamDocumentBinding(client.primaryDb, {
        teamId,
        id: reservedId,
      }),
    ).toBeNull();
    const signed = new URL(
      await storage.signedUrl({
        bucket: "vault",
        path: reservedPath,
        expireIn: 60,
        inboxId: reservedId,
      }),
    );
    expect((await get(signed.pathname + signed.search)).status).toBe(401);
  }, 60_000);

  test("a scheduled sync that exhausts its retries still schedules the next run", async () => {
    const owner = await createUser("intake-sync-chain");
    const teamId = owner.personalTeamId;

    const accountId = crypto.randomUUID();
    const initialAccess = "2026-01-01T00:00:00.000Z";
    await client.primaryDb.insert(schema.inboxAccounts).values({
      id: accountId,
      teamId,
      provider: "gmail",
      externalId: `external-${accountId}`,
      email: `mailbox-${accountId}@example.test`,
      accessToken: "stub-access-token",
      refreshToken: "stub-refresh-token",
      expiryDate: "2030-01-01T00:00:00.000Z",
      lastAccessed: initialAccess,
      status: "connected",
    });
    const [beforeSync] = await client.primaryDb
      .select()
      .from(schema.inboxAccounts)
      .where(orm.eq(schema.inboxAccounts.id, accountId));

    // Deterministic transient failure: the vault directory is a file.
    await Bun.write(join(storageRoot, "vault", teamId), "not a directory");
    try {
      await queries.enqueueWorkflowJob(client.primaryDb, {
        name: "sync-inbox-account",
        teamId,
        idempotencyKey: `${teamId}:sync-chain`,
        payload: { id: accountId, scheduleNext: true },
        maxAttempts: 1,
      });

      const failed = await runWorker(async () => {
        const [job] = await client.primaryDb
          .select()
          .from(schema.workflowJobs)
          .where(
            orm.eq(schema.workflowJobs.idempotencyKey, `${teamId}:sync-chain`),
          );
        return job?.status === "failed";
      });
      expect(failed).toBe(true);
    } finally {
      await rm(join(storageRoot, "vault", teamId), { force: true });
    }

    // The final failure enqueued the next slot, so the mailbox keeps syncing.
    const next = (await workflowJobsFor(teamId)).filter(
      (job) =>
        job.name === "sync-inbox-account" &&
        job.idempotencyKey !== `${teamId}:sync-chain`,
    );
    expect(next).toHaveLength(1);
    expect(next[0]?.status).toBe("queued");
    expect(next[0]?.idempotencyKey.startsWith(`${accountId}:`)).toBe(true);
    // The next slot is scheduled ahead of the job that scheduled it, so the
    // mailboxes keep syncing without this assertion depending on how long the
    // loaded host took to reach it.
    expect(new Date(next[0]!.runAt).getTime()).toBeGreaterThan(
      new Date(next[0]!.createdAt).getTime(),
    );
    expect(next[0]?.payload).toEqual({ id: accountId, scheduleNext: true });

    // The failed attempt did not advance the account cursor.
    const [account] = await client.primaryDb
      .select()
      .from(schema.inboxAccounts)
      .where(orm.eq(schema.inboxAccounts.id, accountId));
    expect(account?.lastAccessed).toBe(beforeSync?.lastAccessed);
  }, 60_000);
});
