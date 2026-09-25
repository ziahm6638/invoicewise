/**
 * Real HTTP checks for the dedicated receiving address (issue #7).
 *
 * Boots the API routes on a disposable local port on top of a disposable
 * Postgres database and a temporary local storage root, and drives the real
 * boundaries: signed provider request -> server-owned recipient mapping ->
 * committed message + processing intent -> Effect worker -> shared intake ->
 * invoice processing, plus redelivery, rotation and refusal paths.
 *
 * The Email Worker is exercised through its own code (apps/inbound-email)
 * against the live endpoint. Providers are stubbed; nothing leaves the
 * machine.
 *
 *   cd packages/db && DATABASE_PRIMARY_URL=postgresql://invoicewise:invoicewise@localhost:5432/invoicewise_inbound_test bunx drizzle-kit migrate
 *   cd apps/api && INBOUND_EMAIL_TEST_DATABASE_URL=postgresql://invoicewise:invoicewise@localhost:5432/invoicewise_inbound_test \
 *     bun test src/inbound-email.http.integration.test.ts
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
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testDatabaseUrl = process.env.INBOUND_EMAIL_TEST_DATABASE_URL;
const PORT = Number(process.env.INBOUND_EMAIL_TEST_PORT ?? 31791);
const BASE = `http://localhost:${PORT}`;
const SECRET = "inbound-email-integration-secret";
const DOMAIN = "in.invoicewise.uk";
const storageRoot = join(
  tmpdir(),
  `invoicewise-inbound-test-${crypto.randomUUID()}`,
);

if (testDatabaseUrl) {
  process.env.DATABASE_PRIMARY_URL = testDatabaseUrl;
  process.env.BETTER_AUTH_SECRET ??= "inbound-http-integration-secret";
  process.env.BETTER_AUTH_URL = BASE;
  process.env.NEXT_PUBLIC_URL = BASE;
  process.env.RESEND_API_KEY ??= "re_inbound_http_test";
  process.env.POLAR_ACCESS_TOKEN ??= "polar_inbound_http_test";
  process.env.REDIS_URL ??= "redis://localhost:6379";
  process.env.MIDDAY_ENCRYPTION_KEY ??=
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  process.env.NODE_ENV ??= "test";
  process.env.STORAGE_BACKEND = "local";
  process.env.LOCAL_STORAGE_PATH = storageRoot;
  process.env.STORAGE_SIGNING_SECRET ??= "inbound-storage-test-secret";
  process.env.STORAGE_PUBLIC_URL = BASE;
  process.env.WORKFLOW_RETRY_BASE_MS = "10";
  process.env.WORKFLOW_RETRY_MAX_MS = "10";
  process.env.INBOUND_EMAIL_DOMAIN = DOMAIN;
  process.env.INBOUND_EMAIL_LIVE = "true";
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
      extraction: {
        supplierName: "Acme Supplies Ltd",
        invoiceNumber: "INV-2026-0042",
        invoiceDate: "2026-09-01",
        currency: "GBP",
        netAmount: 1000,
        taxAmount: 200,
        grossAmount: 1200,
        lineItems: [],
        bankDetails: null,
      },
      judgments: [],
    };
  }
}

/** A multipart message with the given attachments, base64 encoded. */
function buildMessage(input: {
  to: string;
  from?: string;
  messageId?: string | null;
  subject?: string;
  extraHeaders?: string[];
  attachments?: { name: string; type: string; bytes: Uint8Array }[];
}) {
  const boundary = `b-${crypto.randomUUID()}`;
  const headers = [
    ...(input.extraHeaders ?? []),
    `From: ${input.from ?? "Acme Supplies <billing@supplier.example>"}`,
    `To: ${input.to}`,
    `Subject: ${input.subject ?? "Invoice INV-2026-0042"}`,
    "Date: Tue, 22 Sep 2026 10:00:00 +0100",
    ...(input.messageId === null
      ? []
      : [
          `Message-ID: ${input.messageId ?? `<${crypto.randomUUID()}@supplier.example>`}`,
        ]),
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ];
  const parts = [
    `--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nPlease find the invoice attached.\r\n`,
    ...(input.attachments ?? []).map((attachment) => {
      const encoded = Buffer.from(attachment.bytes)
        .toString("base64")
        .replace(/.{76}/g, "$&\r\n");
      return `--${boundary}\r\nContent-Type: ${attachment.type}; name="${attachment.name}"\r\nContent-Disposition: attachment; filename="${attachment.name}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${encoded}\r\n`;
    }),
  ];
  return new TextEncoder().encode(
    `${headers.join("\r\n")}\r\n\r\n${parts.join("")}--${boundary}--\r\n`,
  );
}

const suite = testDatabaseUrl ? describe : describe.skip;

suite("dedicated receiving address over real HTTP", () => {
  let schema: typeof import("@invoicewise/db/schema");
  let orm: typeof import("drizzle-orm");
  let superjson: typeof import("superjson").default;
  let client: typeof import("@invoicewise/db/client");
  let inbound: typeof import("@invoicewise/jobs/inbound-email");
  let worker: typeof import("../../inbound-email/src/worker");
  let server: ReturnType<typeof Bun.serve>;
  let runBatch: () => Promise<void>;
  let reconcile: () => Promise<{ rescheduled: number; failed: number }>;
  let invoicePdf: Uint8Array;

  const created = { userIds: [] as string[], teamIds: [] as string[] };

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

  const trpc = async (
    cookie: string,
    path: string,
    input: unknown,
    kind: "query" | "mutation" = "query",
  ) => {
    const serialized = JSON.stringify(superjson.serialize(input ?? null));
    const response =
      kind === "query"
        ? await fetch(
            `${BASE}/trpc/${path}?input=${encodeURIComponent(serialized)}`,
            { headers: { origin: BASE, cookie } },
          )
        : await post(`/trpc/${path}`, JSON.parse(serialized), cookie);
    const parsed = (await response.json().catch(() => null)) as any;
    if (!parsed || parsed.error) {
      return {
        status: response.status,
        error: parsed?.error?.json?.message ?? "error",
        data: null,
      };
    }
    return {
      status: response.status,
      error: null,
      data: superjson.deserialize(parsed.result.data) as any,
    };
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
    if (!user?.teamId) throw new Error("User was not created");
    created.userIds.push(user.id);
    created.teamIds.push(user.teamId);
    return {
      email,
      userId: user.id,
      teamId: user.teamId,
      cookie: signIn.headers.getSetCookie()[0]!.split(";")[0]!,
    };
  };

  /** Delivers a message the way Cloudflare does: through the Email Worker. */
  const deliver = async (recipient: string, raw: Uint8Array) => {
    const rejections: string[] = [];
    let error: unknown = null;
    try {
      await worker.handleEmail(
        {
          from: "bounces@supplier.example",
          to: recipient,
          raw: new Response(raw).body!,
          rawSize: raw.byteLength,
          setReject: (reason) => rejections.push(reason),
        },
        {
          INBOUND_EMAIL_SECRET: SECRET,
          INBOUND_EMAIL_ENDPOINT: `${BASE}/inbound/email`,
        },
        {
          fetch: (url, init) => fetch(url, init),
          now: () => Date.now(),
          sleep: async () => undefined,
        },
      );
    } catch (caught) {
      error = caught;
    }
    return { rejections, error };
  };

  const inboundRowsFor = (teamId: string) =>
    client.primaryDb
      .select()
      .from(schema.inboundEmails)
      .where(orm.eq(schema.inboundEmails.teamId, teamId));

  const inboxRowsFor = (teamId: string) =>
    client.primaryDb
      .select()
      .from(schema.inbox)
      .where(orm.eq(schema.inbox.teamId, teamId));

  const jobsFor = (teamId: string) =>
    client.primaryDb
      .select()
      .from(schema.workflowJobs)
      .where(orm.eq(schema.workflowJobs.teamId, teamId));

  const runWorker = async (done: () => Promise<boolean>) => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (await done()) return true;
      await runBatch();
      await Bun.sleep(25);
    }
    return done();
  };

  const addressFor = async (cookie: string) => {
    const result = await trpc(cookie, "inboundEmail.get", null);
    expect(result.error).toBeNull();
    return result.data as {
      address: string;
      messages: { status: string; detail: string | null }[];
    };
  };

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

    schema = await import("@invoicewise/db/schema");
    orm = await import("drizzle-orm");
    superjson = (await import("superjson")).default;
    client = await import("@invoicewise/db/client");
    inbound = await import("@invoicewise/jobs/inbound-email");
    worker = await import("../../inbound-email/src/worker");

    const { OpenAPIHono } = await import("@hono/zod-openapi");
    const { trpcServer } = await import("@hono/trpc-server");
    const { auth } = await import("@api/auth");
    const { createTRPCContext } = await import("@api/trpc/init");
    const { appRouter } = await import("@api/trpc/routers/_app");
    const { handleInboundEmail } = await import("@api/inbound-email/http");
    const { DeliveryReconciler, WorkflowRuntimeLive, runWorkflowBatch } =
      await import("@invoicewise/jobs/runner");
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

    reconcile = () =>
      Effect.runPromise(
        Effect.flatMap(DeliveryReconciler, (reconciler) => reconciler.run).pipe(
          Effect.provide(WorkflowRuntimeLive),
          Effect.provide(Logger.minimumLogLevel(LogLevel.None)),
          Effect.scoped,
        ),
      );

    const app = new OpenAPIHono();
    app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
    app.use(
      "/trpc/*",
      trpcServer({ router: appRouter, createContext: createTRPCContext }),
    );
    app.post("/inbound/email", (c) =>
      handleInboundEmail(c.req.raw, {
        db: client.primaryDb,
        secret: SECRET,
        domain: DOMAIN,
      }),
    );
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

  afterEach(async () => {
    if (created.teamIds.length === 0) return;
    await client.primaryDb
      .delete(schema.workflowJobs)
      .where(orm.inArray(schema.workflowJobs.teamId, created.teamIds));
  });

  test("an external invoice email reaches the right workspace once, with its source on the invoice", async () => {
    const owner = await createUser("inbound-owner");
    const bystander = await createUser("inbound-bystander");

    const { address } = await addressFor(owner.cookie);
    expect(address).toMatch(/^[a-hj-km-np-z2-9]{16}@in\.invoicewise\.uk$/);
    // Stable across reads, and different per workspace.
    expect((await addressFor(owner.cookie)).address).toBe(address);
    const bystanderAddress = (await addressFor(bystander.cookie)).address;
    expect(bystanderAddress).not.toBe(address);

    const messageId = `<${crypto.randomUUID()}@supplier.example>`;
    const raw = buildMessage({
      // The To header names the other workspace: only the envelope routes.
      to: bystanderAddress,
      messageId,
      attachments: [
        { name: "invoice.pdf", type: "application/pdf", bytes: invoicePdf },
      ],
    });

    const first = await deliver(address, raw);
    expect(first).toEqual({ rejections: [], error: null });

    const [received] = await inboundRowsFor(owner.teamId);
    expect(received?.status).toBe("received");
    expect(received?.messageId).toBe(messageId);
    expect(received?.recipient).toBe(address);
    expect(received?.envelopeFrom).toBe("bounces@supplier.example");
    expect(received?.headerFrom).toBe(
      "Acme Supplies <billing@supplier.example>",
    );
    expect(await inboundRowsFor(bystander.teamId)).toHaveLength(0);

    // The provider redelivers the same message (a lost acknowledgement), and
    // again with a new trace header: one logical message, no second job.
    const second = await deliver(address, raw);
    const third = await deliver(
      address,
      buildMessage({
        to: address,
        messageId,
        extraHeaders: ["Received: from mx2.supplier.example"],
        attachments: [
          { name: "invoice.pdf", type: "application/pdf", bytes: invoicePdf },
        ],
      }),
    );
    expect(second.error).toBeNull();
    expect(third.error).toBeNull();
    const receivedRows = await inboundRowsFor(owner.teamId);
    expect(receivedRows).toHaveLength(1);
    expect(receivedRows[0]?.deliveryCount).toBe(3);
    expect(
      (await jobsFor(owner.teamId)).filter(
        ({ name }) => name === "process-inbound-email",
      ),
    ).toHaveLength(1);

    const processed = await runWorker(async () => {
      const [invoice] = await inboxRowsFor(owner.teamId);
      return Boolean(invoice?.extraction);
    });
    expect(processed).toBe(true);

    const [message] = await inboundRowsFor(owner.teamId);
    expect(message?.status).toBe("processed");
    expect(message?.raw).toBeNull();
    expect(message?.attachments).toHaveLength(1);
    expect(message?.attachments[0]).toMatchObject({
      fileName: "invoice.pdf",
      contentType: "application/pdf",
      outcome: "accepted",
    });

    const invoices = await inboxRowsFor(owner.teamId);
    expect(invoices).toHaveLength(1);
    expect(invoices[0]?.inboundEmailId).toBe(message!.id);
    expect(invoices[0]?.referenceId).toBe(`email:mid:${messageId}:0`);
    expect(invoices[0]?.status).toBe("pending");

    const detail = await trpc(owner.cookie, "inbox.getById", {
      id: invoices[0]!.id,
    });
    expect(detail.data?.inboundEmail).toMatchObject({
      id: message!.id,
      messageId,
      recipient: address,
      envelopeFrom: "bounces@supplier.example",
    });

    // The settings list shows the message; the bystander sees nothing.
    const listed = await addressFor(owner.cookie);
    expect(listed.messages).toHaveLength(1);
    expect(listed.messages[0]?.status).toBe("processed");
    expect((await addressFor(bystander.cookie)).messages).toHaveLength(0);

    // A redelivery after processing still creates nothing new.
    expect((await deliver(address, raw)).error).toBeNull();
    await runWorker(async () => true);
    expect(await inboxRowsFor(owner.teamId)).toHaveLength(1);
    expect(await inboundRowsFor(owner.teamId)).toHaveLength(1);
  }, 90_000);

  test("unknown, malformed, revoked and deleted-workspace recipients are refused permanently", async () => {
    const owner = await createUser("inbound-refusals");
    const { address } = await addressFor(owner.cookie);
    const raw = buildMessage({ to: address });

    for (const recipient of [
      `aaaaaaaaaaaaaaaa@${DOMAIN}`,
      `invoices@${DOMAIN}`,
      `${address.split("@")[0]}@invoicewise.uk`,
      `${owner.teamId}@${DOMAIN}`,
      // A subaddress of a real address is not the issued address.
      `${address.split("@")[0]}+acme@${DOMAIN}`,
    ]) {
      const result = await deliver(recipient, raw);
      expect(result).toEqual({
        rejections: [worker.REJECTIONS.unknownRecipient],
        error: null,
      });
    }

    // Rotation: the old address stops at once, the new one works.
    const rotated = await trpc(
      owner.cookie,
      "inboundEmail.rotate",
      null,
      "mutation",
    );
    expect(rotated.error).toBeNull();
    const next = rotated.data.address as string;
    expect(next).not.toBe(address);
    expect((await addressFor(owner.cookie)).address).toBe(next);
    expect((await deliver(address, raw)).rejections).toEqual([
      worker.REJECTIONS.unknownRecipient,
    ]);
    expect((await deliver(next, raw)).rejections).toEqual([]);

    // Deleting the workspace removes its address with it.
    await client.primaryDb
      .delete(schema.teams)
      .where(orm.eq(schema.teams.id, owner.teamId));
    expect(
      (await deliver(next, buildMessage({ to: next }))).rejections,
    ).toEqual([worker.REJECTIONS.unknownRecipient]);
    expect(await inboundRowsFor(owner.teamId)).toHaveLength(0);
  }, 60_000);

  test("an unsigned or spoofed request is refused whatever it claims", async () => {
    const owner = await createUser("inbound-spoof");
    const { address } = await addressFor(owner.cookie);
    const raw = buildMessage({ to: address });

    const unsigned = await fetch(`${BASE}/inbound/email`, {
      method: "POST",
      headers: {
        "content-type": "message/rfc822",
        "x-forwarded-for": "127.0.0.1",
        "x-real-ip": "127.0.0.1",
        "x-invoicewise-inbound-recipient": encodeURIComponent(address),
        "x-invoicewise-inbound-timestamp": String(
          Math.floor(Date.now() / 1000),
        ),
        "x-invoicewise-inbound-signature": `v1=${"a".repeat(64)}`,
      },
      body: raw,
    });
    expect(unsigned.status).toBe(401);

    // A worker holding the wrong secret fails temporarily, never permanently,
    // so a misconfiguration does not bounce customers' mail.
    const wrongSecret = await worker
      .handleEmail(
        {
          from: "x@supplier.example",
          to: address,
          raw: new Response(raw).body!,
          rawSize: raw.byteLength,
          setReject: () => {
            throw new Error("must not reject");
          },
        },
        {
          INBOUND_EMAIL_SECRET: "not-the-secret",
          INBOUND_EMAIL_ENDPOINT: `${BASE}/inbound/email`,
        },
        {
          fetch: (url, init) => fetch(url, init),
          now: () => Date.now(),
          sleep: async () => undefined,
        },
      )
      .then(
        () => null,
        (error: Error) => error.message,
      );
    expect(wrongSecret).toContain("HTTP 401");
    expect(await inboundRowsFor(owner.teamId)).toHaveLength(0);
  }, 60_000);

  test("mail with nothing to read or only rejected documents settles visibly without retries", async () => {
    const owner = await createUser("inbound-outcomes");
    const { address } = await addressFor(owner.cookie);

    const noAttachment = buildMessage({
      to: address,
      subject: "Just a note",
      attachments: [
        {
          name: "notes.txt",
          type: "text/plain",
          bytes: new TextEncoder().encode("hello"),
        },
      ],
    });
    const brokenPdf = buildMessage({
      to: address,
      subject: "Broken",
      attachments: [
        {
          name: "invoice.pdf",
          type: "application/pdf",
          bytes: new TextEncoder().encode("%PDF-1.4 not really a pdf"),
        },
        {
          name: "logo.png",
          type: "image/png",
          bytes: new Uint8Array(200),
        },
      ],
    });
    expect((await deliver(address, noAttachment)).error).toBeNull();
    expect((await deliver(address, brokenPdf)).error).toBeNull();

    const settled = await runWorker(async () =>
      (await inboundRowsFor(owner.teamId)).every(
        ({ status }) => status !== "received",
      ),
    );
    expect(settled).toBe(true);

    const rows = await inboundRowsFor(owner.teamId);
    const note = rows.find(({ subject }) => subject === "Just a note")!;
    expect(note.status).toBe("processed");
    expect(note.detail).toBe(
      "No PDF, JPEG or PNG attachment was found in this message.",
    );
    expect(note.attachments[0]).toMatchObject({
      outcome: "skipped",
      code: "unsupported_type",
    });

    const broken = rows.find(({ subject }) => subject === "Broken")!;
    expect(broken.status).toBe("processed");
    expect(broken.detail).toBe(
      "No attachment in this message could be read as an invoice.",
    );
    expect(broken.attachments.map(({ outcome }) => outcome)).toEqual([
      "rejected",
      "skipped",
    ]);
    expect(broken.attachments[1]?.code).toBe("small_image");

    // Each message ran exactly once: permanent problems are not retried.
    const jobs = (await jobsFor(owner.teamId)).filter(
      ({ name }) => name === "process-inbound-email",
    );
    expect(jobs.map(({ status, attempts }) => [status, attempts])).toEqual([
      ["succeeded", 1],
      ["succeeded", 1],
    ]);
    expect(await inboxRowsFor(owner.teamId)).toHaveLength(0);
  }, 60_000);

  test("a transient storage outage is retried and then recorded as failed, never dropped silently", async () => {
    const owner = await createUser("inbound-outage");
    const { address } = await addressFor(owner.cookie);
    expect(
      (
        await deliver(
          address,
          buildMessage({
            to: address,
            attachments: [
              {
                name: "invoice.pdf",
                type: "application/pdf",
                bytes: invoicePdf,
              },
            ],
          }),
        )
      ).error,
    ).toBeNull();
    const [row] = await inboundRowsFor(owner.teamId);
    const down = {
      uploadIfAbsent: async () => {
        throw new Error("storage unavailable");
      },
      remove: async () => undefined,
      download: async () => {
        throw new Error("storage unavailable");
      },
    };

    const retryable = await inbound
      .processInboundEmail(client.primaryDb, down as never, {
        teamId: owner.teamId,
        inboundEmailId: row!.id,
        finalAttempt: false,
      })
      .then(
        () => null,
        (error: InstanceType<typeof inbound.InboundEmailProcessingError>) =>
          error.retryable,
      );
    expect(retryable).toBe(true);
    expect((await inboundRowsFor(owner.teamId))[0]?.status).toBe("received");

    const final = await inbound.processInboundEmail(
      client.primaryDb,
      down as never,
      { teamId: owner.teamId, inboundEmailId: row!.id, finalAttempt: true },
    );
    expect(final.status).toBe("failed");
    const [failed] = await inboundRowsFor(owner.teamId);
    expect(failed?.status).toBe("failed");
    expect(failed?.detail).toContain("could not be stored");
    // The source is kept for an operator to re-drive.
    expect(failed?.raw).not.toBeNull();
  }, 60_000);

  test("a message whose job gave up without recording it is settled by the reconciler", async () => {
    const owner = await createUser("inbound-stalled");
    const { address } = await addressFor(owner.cookie);
    const stalled = buildMessage({ to: address, subject: "Stalled" });
    const waiting = buildMessage({ to: address, subject: "Waiting" });
    expect((await deliver(address, stalled)).error).toBeNull();
    expect((await deliver(address, waiting)).error).toBeNull();

    const rows = await inboundRowsFor(owner.teamId);
    const stalledRow = rows.find(({ subject }) => subject === "Stalled")!;
    // The worker died during the final attempt: the queue marks the job
    // failed when its lease expires and no inbound-email code runs.
    await client.primaryDb
      .update(schema.workflowJobs)
      .set({
        status: "failed",
        attempts: 3,
        lastError: "Workflow lease expired after its final attempt",
      })
      .where(orm.eq(schema.workflowJobs.idempotencyKey, stalledRow.id));

    const result = await reconcile();
    expect(result.failed).toBeGreaterThanOrEqual(1);

    const after = await inboundRowsFor(owner.teamId);
    const failed = after.find(({ subject }) => subject === "Stalled")!;
    expect(failed.status).toBe("failed");
    expect(failed.detail).toContain("temporary processing problem");
    expect(failed.raw).not.toBeNull();
    // A message whose job is still queued is left for the worker.
    expect(after.find(({ subject }) => subject === "Waiting")?.status).toBe(
      "received",
    );
    const listed = await addressFor(owner.cookie);
    expect(listed.messages.map(({ status }) => status).sort()).toEqual([
      "failed",
      "received",
    ]);
  }, 60_000);

  test("a Gmail forwarding confirmation is believed only with Cloudflare's DKIM pass for google.com", async () => {
    const owner = await createUser("inbound-gmail");
    const { address } = await addressFor(owner.cookie);
    const attachments = [
      { name: "invoice.pdf", type: "application/pdf", bytes: invoicePdf },
    ];
    const from = "Gmail Team <forwarding-noreply@google.com>";

    const genuine = buildMessage({
      to: address,
      from,
      subject: "Genuine",
      extraHeaders: [
        "Authentication-Results: mx.cloudflare.net; dkim=pass header.d=google.com header.s=20230601",
        "Received: from mail-sor-f41.google.com by mx.cloudflare.net",
      ],
    });
    // Spoofed From with no authentication, and with a forged google.com pass
    // below the receiving hop's Received header, where the sender put it.
    const unsigned = buildMessage({
      to: address,
      from,
      subject: "Unsigned",
      attachments,
    });
    const forged = buildMessage({
      to: address,
      from,
      subject: "Forged",
      extraHeaders: [
        "Authentication-Results: mx.cloudflare.net; dkim=pass header.d=evil.example",
        "Received: from mx.evil.example by mx.cloudflare.net",
        "Authentication-Results: mx.cloudflare.net; dkim=pass header.d=google.com",
        "ARC-Authentication-Results: i=1; mx.cloudflare.net; dkim=pass header.d=google.com",
      ],
      attachments: [
        {
          name: "invoice-2.pdf",
          type: "application/pdf",
          bytes: new Uint8Array([...invoicePdf, 10]),
        },
      ],
    });
    for (const raw of [genuine, unsigned, forged]) {
      expect((await deliver(address, raw)).error).toBeNull();
    }

    const settled = await runWorker(async () =>
      (await inboundRowsFor(owner.teamId)).every(
        ({ status }) => status !== "received",
      ),
    );
    expect(settled).toBe(true);

    const rows = await inboundRowsFor(owner.teamId);
    const bySubject = (subject: string) =>
      rows.find((row) => row.subject === subject)!;
    expect(bySubject("Genuine").detail).toStartWith(
      "Gmail forwarding confirmation:",
    );
    for (const subject of ["Unsigned", "Forged"]) {
      const row = bySubject(subject);
      expect(row.status).toBe("processed");
      expect(row.detail ?? "").not.toContain("Gmail forwarding confirmation");
      expect(row.attachments.map(({ outcome }) => outcome)).toEqual([
        "accepted",
      ]);
    }
    expect(await inboxRowsFor(owner.teamId)).toHaveLength(2);
  }, 90_000);

  test("no address is shown or rotated until the mailbox is live", async () => {
    const owner = await createUser("inbound-not-live");
    process.env.INBOUND_EMAIL_LIVE = "false";
    try {
      const hidden = await trpc(owner.cookie, "inboundEmail.get", null);
      expect(hidden.error).toBeNull();
      expect(hidden.data).toEqual({
        address: null,
        createdAt: null,
        messages: [],
      });
      const rotate = await trpc(
        owner.cookie,
        "inboundEmail.rotate",
        null,
        "mutation",
      );
      expect(rotate.status).toBe(412);
    } finally {
      process.env.INBOUND_EMAIL_LIVE = "true";
    }
    expect((await addressFor(owner.cookie)).address).toMatch(
      /@in\.invoicewise\.uk$/,
    );
  }, 60_000);

  test("members see the address but only admins rotate it", async () => {
    const owner = await createUser("inbound-rotate-owner");
    const member = await createUser("inbound-rotate-member");
    await trpc(
      owner.cookie,
      "team.invite",
      [{ email: member.email, role: "member" }],
      "mutation",
    );
    const pending = await trpc(member.cookie, "team.invitesByEmail", null);
    const accepted = await trpc(
      member.cookie,
      "team.acceptInvite",
      { id: (pending.data as { id: string }[])[0]!.id },
      "mutation",
    );
    expect(accepted.error).toBeNull();
    const switched = await trpc(
      member.cookie,
      "user.update",
      { teamId: owner.teamId },
      "mutation",
    );
    expect(switched.error).toBeNull();

    const ownerAddress = (await addressFor(owner.cookie)).address;
    expect((await addressFor(member.cookie)).address).toBe(ownerAddress);
    const denied = await trpc(
      member.cookie,
      "inboundEmail.rotate",
      null,
      "mutation",
    );
    expect(denied.status).toBe(403);
    expect((await addressFor(owner.cookie)).address).toBe(ownerAddress);
  }, 60_000);
});
