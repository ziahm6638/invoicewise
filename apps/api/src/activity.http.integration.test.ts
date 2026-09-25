/**
 * Runnable check for roadmap issue #51: a stuck synthetic invoice is
 * diagnosed and recovered only through the supported status and recovery
 * surfaces, then who did what is inspected.
 *
 * Boots the real API app (Better Auth, tRPC, REST, operator routes) on a
 * disposable local port over a disposable Postgres database and runs the
 * real Postgres queue in-process: a worker is "killed" mid-job, a fresh
 * runner reclaims the job, a TypeSafe outage exhausts its attempts, an
 * operator retries it, and the invoice is delivered to a loopback webhook.
 * It covers read-only customer access (a member and an `inbox.read` API
 * key), denied customer and operator actions, restart recovery, operator
 * cancel, redaction, and the full incident timeline and audit trail.
 *
 * Providers are stubbed. Nothing leaves the machine.
 *
 *   docker exec invoicewise-postgres-1 psql -U invoicewise -d postgres \
 *     -c "DROP DATABASE IF EXISTS invoicewise_activity_test" \
 *     -c "CREATE DATABASE invoicewise_activity_test"
 *   cd packages/db && DATABASE_PRIMARY_URL=postgresql://invoicewise:invoicewise@localhost:5432/invoicewise_activity_test bunx drizzle-kit migrate
 *   cd apps/api && ACTIVITY_TEST_DATABASE_URL=postgresql://invoicewise:invoicewise@localhost:5432/invoicewise_activity_test \
 *     bun test src/activity.http.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testDatabaseUrl = process.env.ACTIVITY_TEST_DATABASE_URL;
const PORT = Number(process.env.ACTIVITY_TEST_PORT ?? 31791);
const BASE = `http://localhost:${PORT}`;
const OPS_TOKEN = `ops-${crypto.randomUUID()}`;
const OPS_TOKEN_FINGERPRINT = createHash("sha256")
  .update(OPS_TOKEN)
  .digest("hex")
  .slice(0, 8);
const storageRoot = join(
  tmpdir(),
  `invoicewise-activity-test-${crypto.randomUUID()}`,
);

if (testDatabaseUrl) {
  process.env.DATABASE_PRIMARY_URL = testDatabaseUrl;
  process.env.BETTER_AUTH_SECRET ??= "activity-http-integration-secret";
  process.env.BETTER_AUTH_URL = BASE;
  process.env.NEXT_PUBLIC_URL = BASE;
  process.env.RESEND_API_KEY ??= "re_activity_http_test";
  process.env.POLAR_ACCESS_TOKEN ??= "polar_activity_http_test";
  process.env.REDIS_URL ??= "redis://localhost:6379";
  process.env.MIDDAY_ENCRYPTION_KEY ??=
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  process.env.NODE_ENV ??= "test";
  process.env.STORAGE_BACKEND = "local";
  process.env.LOCAL_STORAGE_PATH = storageRoot;
  process.env.STORAGE_SIGNING_SECRET ??= "activity-storage-test-secret";
  process.env.STORAGE_PUBLIC_URL = BASE;
  process.env.WORKFLOW_RETRY_BASE_MS = "10";
  process.env.WORKFLOW_RETRY_MAX_MS = "10";
}

mock.module("@api/services/resend", () => ({
  resend: {
    emails: { send: async () => ({ data: { id: "stub" }, error: null }) },
    contacts: { remove: async () => ({ data: null, error: null }) },
  },
}));

/**
 * The provider error quotes a credential and a bank account, as a careless
 * upstream error might; neither may reach any operator or customer surface.
 */
const LEAKY_TOKEN = "sk_live_leakytoken123456";
const LEAKY_IBAN = "GB29NWBK60161331926819";
const PROVIDER_OUTAGE = `TypeSafe unavailable: 503 (Authorization: Bearer ${LEAKY_TOKEN}; payee IBAN ${LEAKY_IBAN})`;

const provider = { down: false, calls: 0 };

class FakeDocumentClient {
  async getInvoice() {
    provider.calls += 1;
    if (provider.down) throw new Error(PROVIDER_OUTAGE);
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
        invoiceNumber: `INV-${crypto.randomUUID().slice(0, 8)}`,
        invoiceDate: "2026-09-01",
        dueDate: "2026-09-30",
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

type Json = Record<string, any>;

const suite = testDatabaseUrl ? describe : describe.skip;

suite("invoice activity and operator recovery over real HTTP", () => {
  let schema: typeof import("@invoicewise/db/schema");
  let orm: typeof import("drizzle-orm");
  let superjson: typeof import("superjson").default;
  let client: typeof import("@invoicewise/db/client");
  let queries: typeof import("@invoicewise/db/queries");
  let delivery: typeof import("@invoicewise/jobs/delivery");
  let exceptions: typeof import("@invoicewise/jobs/exceptions");
  let server: ReturnType<typeof Bun.serve>;
  let receiver: ReturnType<typeof Bun.serve>;
  let runBatch: () => Promise<void>;

  const received: { eventId: string | null; type: string | null }[] = [];
  const created = { userIds: [] as string[], teamIds: [] as string[] };

  const request = (
    path: string,
    init: { method?: string; headers?: Record<string, string>; body?: unknown },
  ) =>
    fetch(`${BASE}${path}`, {
      method: init.method ?? "GET",
      redirect: "manual",
      headers: {
        origin: BASE,
        ...(init.body !== undefined
          ? { "content-type": "application/json" }
          : {}),
        ...init.headers,
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });

  const trpc = async (
    cookie: string,
    path: string,
    input: unknown,
    kind: "query" | "mutation" = "query",
  ) => {
    const serialized = superjson.serialize(input ?? null);
    const response =
      kind === "query"
        ? await request(
            `/trpc/${path}?input=${encodeURIComponent(JSON.stringify(serialized))}`,
            { headers: { cookie } },
          )
        : await request(`/trpc/${path}`, {
            method: "POST",
            headers: { cookie },
            body: serialized,
          });
    const parsed = (await response.json().catch(() => null)) as Json | null;
    if (!parsed || parsed.error) {
      return {
        status: response.status,
        code: parsed?.error?.json?.data?.code as string | undefined,
        error: (parsed?.error?.json?.message as string) ?? "error",
        data: null as any,
      };
    }
    return {
      status: response.status,
      code: undefined,
      error: null,
      data: superjson.deserialize(parsed.result.data) as any,
    };
  };

  const operator = (
    path: string,
    init: {
      method?: string;
      body?: unknown;
      token?: string | null;
      name?: string | null;
    } = {},
  ) =>
    request(path, {
      method: init.method,
      body: init.body,
      headers: {
        ...(init.token !== null
          ? { authorization: `Bearer ${init.token ?? OPS_TOKEN}` }
          : {}),
        ...(init.name !== null ? { "x-operator": init.name ?? "on-call" } : {}),
      },
    });

  const sessionCookie = (response: Response) => {
    const cookie = response.headers.getSetCookie()[0];
    if (!cookie) throw new Error("No session cookie was issued");
    return cookie.split(";")[0]!;
  };

  const createUser = async (label: string) => {
    const email = `${label}-${crypto.randomUUID()}@example.test`;
    const password = "Password123!";
    const signUp = await request("/api/auth/sign-up/email", {
      method: "POST",
      body: { email, password, name: label },
    });
    expect(signUp.status).toBe(200);
    await client.primaryDb
      .update(schema.users)
      .set({ emailVerified: true })
      .where(orm.eq(schema.users.email, email));
    const signIn = await request("/api/auth/sign-in/email", {
      method: "POST",
      body: { email, password },
    });
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
      name: label,
      userId: user.id,
      teamId: user.teamId,
      cookie: sessionCookie(signIn),
    };
  };

  type User = Awaited<ReturnType<typeof createUser>>;

  /** Invites `user` into the owner's workspace, accepts and switches to it. */
  const joinTeam = async (owner: User, user: User, role: "member") => {
    const invited = await trpc(
      owner.cookie,
      "team.invite",
      [{ email: user.email, role }],
      "mutation",
    );
    expect(invited.error).toBeNull();
    const pending = await trpc(user.cookie, "team.invitesByEmail", null);
    const accepted = await trpc(
      user.cookie,
      "team.acceptInvite",
      { id: (pending.data as { id: string }[])[0]!.id },
      "mutation",
    );
    expect(accepted.error).toBeNull();
    const switched = await trpc(
      user.cookie,
      "user.update",
      { teamId: owner.teamId },
      "mutation",
    );
    expect(switched.error).toBeNull();
  };

  const upload = async (cookie: string) => {
    const bytes = await Bun.file(
      join(
        import.meta.dir,
        "../../../packages/documents/src/test/fixtures/synthetic-invoice.pdf",
      ),
    ).arrayBuffer();
    const form = new FormData();
    form.set(
      "file",
      new File([Buffer.from(bytes)], "synthetic-invoice.pdf", {
        type: "application/pdf",
      }),
    );
    const response = await fetch(`${BASE}/api/storage/upload`, {
      method: "POST",
      headers: { origin: BASE, cookie },
      body: form,
    });
    expect(response.status).toBe(200);
    return ((await response.json()) as { id: string }).id;
  };

  const jobsFor = (teamId: string, name: string) =>
    client.primaryDb
      .select()
      .from(schema.workflowJobs)
      .where(
        orm.and(
          orm.eq(schema.workflowJobs.teamId, teamId),
          orm.eq(schema.workflowJobs.name, name),
        ),
      )
      .orderBy(orm.asc(schema.workflowJobs.createdAt));

  const WORKER_WAIT_MS = 30_000;
  const runWorker = async (done: () => Promise<boolean>) => {
    const deadline = Date.now() + WORKER_WAIT_MS;
    while (Date.now() < deadline) {
      if (await done()) return true;
      await runBatch();
      await Bun.sleep(25);
    }
    return done();
  };

  beforeAll(async () => {
    const realDocuments = await import("@invoicewise/documents");
    mock.module("@invoicewise/documents", () => ({
      ...realDocuments,
      DocumentClient: FakeDocumentClient,
    }));

    schema = await import("@invoicewise/db/schema");
    orm = await import("drizzle-orm");
    superjson = (await import("superjson")).default;
    client = await import("@invoicewise/db/client");
    queries = await import("@invoicewise/db/queries");
    delivery = await import("@invoicewise/jobs/delivery");
    exceptions = await import("@invoicewise/jobs/exceptions");
    const storage = (
      await import("@invoicewise/db/storage")
    ).createStorageClient({
      backend: "local",
      rootPath: storageRoot,
      signingSecret: process.env.STORAGE_SIGNING_SECRET!,
      publicUrl: BASE,
    });

    const { OpenAPIHono } = await import("@hono/zod-openapi");
    const { trpcServer } = await import("@hono/trpc-server");
    const { auth, getAuthSession } = await import("@api/auth");
    const { createTRPCContext } = await import("@api/trpc/init");
    const { appRouter } = await import("@api/trpc/routers/_app");
    const { routers } = await import("@api/rest/routers");
    const { v1Router } = await import("@api/rest/v1");
    const { registerOperatorRoutes } = await import("@api/ops/recovery");
    const intakeHttp = await import("@api/intake/http");
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

    receiver = Bun.serve({
      port: 0,
      fetch: (req) => {
        received.push({
          eventId: req.headers.get("invoicewise-event-id"),
          type: req.headers.get("invoicewise-event"),
        });
        return new Response("ok");
      },
    });

    const app = new OpenAPIHono();
    app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
    app.use(
      "/trpc/*",
      trpcServer({ router: appRouter, createContext: createTRPCContext }),
    );
    registerOperatorRoutes(app, { db: client.db, env: { OPS_TOKEN } });
    app.post("/api/storage/upload", async (c) => {
      const session = await getAuthSession(c.req.raw.headers);
      if (!session?.teamId) return c.json({ error: "Unauthorized" }, 401);
      return intakeHttp.handleInvoiceIntake(c.req.raw, {
        teamId: session.teamId,
        db: client.primaryDb,
        storage: {
          uploadIfAbsent: storage.uploadIfAbsent.bind(storage),
          remove: storage.remove.bind(storage),
          download: storage.download.bind(storage),
        },
      });
    });
    app.route("/v1", v1Router);
    app.route("/", routers);
    server = Bun.serve({ port: PORT, fetch: app.fetch });
  });

  afterAll(async () => {
    server?.stop(true);
    receiver?.stop(true);
    await rm(storageRoot, { recursive: true, force: true });
    if (created.teamIds.length > 0) {
      await client.primaryDb
        .delete(schema.workflowJobs)
        .where(orm.inArray(schema.workflowJobs.teamId, created.teamIds));
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

  test("a stuck invoice is diagnosed and recovered through supported surfaces, then who did what is inspected", async () => {
    const owner = await createUser("activity-owner");
    const member = await createUser("activity-member");
    const teamId = owner.teamId;
    await joinTeam(owner, member, "member");

    // --- Workspace setup, all audited --------------------------------------
    const endpoint = await trpc(
      owner.cookie,
      "webhooks.create",
      {
        url: `http://127.0.0.1:${receiver.port}/hook?token=receiver-secret`,
        events: ["invoice.processed"],
      },
      "mutation",
    );
    expect(endpoint.error).toBeNull();
    // Delivery rules are a workspace policy: sending every processed invoice
    // to webhooks (each carrying its decision) is an audited change.
    const rules = await trpc(owner.cookie, "deliveryRules.get", null);
    expect(rules.error).toBeNull();
    const policy = rules.data.current.policy as Json;
    const saved = await trpc(
      owner.cookie,
      "deliveryRules.update",
      {
        expectedVersion: rules.data.current.version,
        policy: {
          ...policy,
          destinations: { ...policy.destinations, webhooks: "all" },
        },
      },
      "mutation",
    );
    expect(saved.error).toBeNull();
    const readOnly = await trpc(
      owner.cookie,
      "apiKeys.upsert",
      { name: "Support dashboard", scopes: ["inbox.read"] },
      "mutation",
    );
    expect(readOnly.error).toBeNull();
    const readKey = (readOnly.data as { key: string }).key;
    const bearer = { authorization: `Bearer ${readKey}` };

    // A member cannot manage integrations; the refusal is recorded.
    const memberWebhook = await trpc(
      member.cookie,
      "webhooks.create",
      { url: `http://127.0.0.1:${receiver.port}/member`, events: [] },
      "mutation",
    );
    expect(memberWebhook.code).toBe("FORBIDDEN");

    // --- The incident: a worker dies mid-job while the provider is down ----
    provider.down = true;
    const invoiceId = await upload(owner.cookie);
    const [queued] = await jobsFor(teamId, "process-attachment");
    expect(queued?.status).toBe("queued");
    const killed = await queries.claimWorkflowJobs(client.primaryDb as never, {
      workerId: "worker-killed",
      limit: 1,
      leaseMs: 1,
      excludeNames: [
        "invite-team-members",
        "deliver-webhook",
        "post-accounting-draft",
        "process-inbound-email",
        "sync-inbox-account",
        "onboard-team",
        "apply-retention",
        "rerun-judgments",
        "rerun-question",
        "update-accounting-bill",
        "build-data-export",
        "purge-deleted-data",
        "initial-inbox-setup",
      ],
    });
    expect(killed.map((job) => job.id)).toContain(queued!.id);
    await Bun.sleep(20);

    // --- Customers read where it stands, read-only ------------------------
    const memberView = await trpc(member.cookie, "inbox.activity", {
      id: invoiceId,
    });
    expect(memberView.error).toBeNull();
    const stalled = (memberView.data.entries as Json[]).find(
      (entry) => entry.stage === "extraction",
    );
    expect(stalled).toMatchObject({
      title: "Reading the document: stalled",
      refs: { jobId: queued!.id },
    });
    const keyView = await request(`/invoices/${invoiceId}/activity`, {
      headers: bearer,
    });
    expect(keyView.status).toBe(200);
    expect(((await keyView.json()) as Json).invoiceId).toBe(invoiceId);
    // A read-only key cannot act, and members cannot read the audit log.
    const keyRetry = await request(`/invoices/${invoiceId}/delivery/retry`, {
      method: "POST",
      headers: bearer,
    });
    expect(keyRetry.status).toBe(403);
    // The same refusal through the versioned public API is recorded too.
    const v1Retry = await request(`/v1/invoices/${invoiceId}/delivery/retry`, {
      method: "POST",
      headers: bearer,
    });
    expect(v1Retry.status).toBe(403);
    expect((await trpc(member.cookie, "audit.list", {})).code).toBe(
      "FORBIDDEN",
    );
    // Another workspace cannot see it.
    const outsider = await createUser("activity-outsider");
    expect(
      (await trpc(outsider.cookie, "inbox.activity", { id: invoiceId })).data,
    ).toBeNull();

    // --- Operator diagnosis: authority separate from customer roles --------
    for (const denied of [
      await request(`/ops/jobs?filter=stuck&teamId=${teamId}`, {
        headers: { cookie: owner.cookie },
      }),
      await request(`/ops/jobs?filter=stuck&teamId=${teamId}`, {
        headers: bearer,
      }),
      await operator("/ops/jobs?filter=stuck", { token: "not-the-token" }),
    ]) {
      expect(denied.status).toBe(401);
    }
    expect(
      (await operator("/ops/jobs?filter=stuck", { name: null })).status,
    ).toBe(400);
    const stuck = await operator(`/ops/jobs?filter=stuck&teamId=${teamId}`);
    expect(stuck.status).toBe(200);
    const stuckJob = ((await stuck.json()) as Json).data.find(
      (job: Json) => job.id === queued!.id,
    );
    expect(stuckJob).toMatchObject({
      workflow: "process-attachment",
      status: "running",
      stuck: true,
      lockedBy: "worker-killed",
      subject: { inboxId: invoiceId },
    });
    expect(stuckJob).not.toHaveProperty("payload");

    // Denied operator actions: no purpose, then a retry of a job that has
    // not failed. Neither changes the job.
    expect(
      (
        await operator(`/ops/jobs/${queued!.id}/cancel`, {
          method: "POST",
          body: { reason: "no purpose given" },
        })
      ).status,
    ).toBe(400);
    const premature = await operator(`/ops/jobs/${queued!.id}/retry`, {
      method: "POST",
      body: { purpose: "incident", reason: "Invoice stuck for customer" },
    });
    expect(premature.status).toBe(409);
    expect((await premature.json()) as Json).toMatchObject({
      status: "not_failed",
      jobStatus: "running",
    });
    // Customer-data access needs a purpose and is recorded for the workspace.
    expect((await operator(`/ops/invoices/${invoiceId}/activity`)).status).toBe(
      400,
    );
    const operatorView = await operator(
      `/ops/invoices/${invoiceId}/activity?purpose=support&reason=${encodeURIComponent("Customer ticket 4411: invoice stuck")}`,
    );
    expect(operatorView.status).toBe(200);
    const operatorTrace = (await operatorView.json()) as Json;
    expect(operatorTrace.teamId).toBe(teamId);
    expect(JSON.stringify(operatorTrace)).not.toContain(owner.email);

    // --- Restart recovery: a fresh runner reclaims the expired lease -------
    const exhausted = await runWorker(async () => {
      const [job] = await jobsFor(teamId, "process-attachment");
      return job?.status === "failed";
    });
    expect(exhausted).toBe(true);
    const [failedJob] = await jobsFor(teamId, "process-attachment");
    expect(failedJob?.attempts).toBe(3);
    expect(failedJob?.lockedBy).toBeNull();
    // The runner's reconciler pass settles anything its handler could not.
    await exceptions.reconcileInvoiceOperations(client.db, { teamId });

    const failedView = await trpc(owner.cookie, "inbox.activity", {
      id: invoiceId,
    });
    expect(failedView.data.current.extraction).toBe("failed");
    const failedEntry = (failedView.data.entries as Json[]).find(
      (entry) => entry.refs.jobId === failedJob!.id,
    );
    expect(failedEntry).toMatchObject({
      title: "Reading the document: failed",
      status: "failed",
    });
    expect(failedEntry?.reason).toContain("TypeSafe unavailable: 503");

    const failedList = await operator(
      `/ops/jobs?filter=failed&teamId=${teamId}&workflow=process-attachment`,
    );
    const listedFailure = ((await failedList.json()) as Json).data[0];
    expect(listedFailure.id).toBe(failedJob!.id);
    expect(listedFailure.lastError).toContain("TypeSafe unavailable: 503");

    // --- Recovery: the provider is back and an operator retries ------------
    provider.down = false;
    const retried = await operator(`/ops/jobs/${failedJob!.id}/retry`, {
      method: "POST",
      body: { purpose: "incident", reason: "TypeSafe outage resolved" },
    });
    expect(retried.status).toBe(202);
    expect((await retried.json()) as Json).toMatchObject({
      status: "requeued",
      action: "reextract",
    });
    // Bounded: the same job cannot be retried twice.
    const again = await operator(`/ops/jobs/${failedJob!.id}/retry`, {
      method: "POST",
      body: { purpose: "incident", reason: "TypeSafe outage resolved" },
    });
    expect(again.status).toBe(409);
    expect(((await again.json()) as Json).status).toBe("superseded");

    const recovered = await runWorker(async () => {
      const row = await client.primaryDb.query.inbox.findFirst({
        where: orm.eq(schema.inbox.id, invoiceId),
        columns: { processingRevision: true },
      });
      return (
        (row?.processingRevision ?? 0) >= 1 &&
        received.some((event) => event.type === "invoice.processed")
      );
    });
    expect(recovered).toBe(true);
    await runWorker(async () => {
      const deliveries = await client.primaryDb
        .select({ status: schema.webhookDeliveries.status })
        .from(schema.webhookDeliveries)
        .where(orm.eq(schema.webhookDeliveries.invoiceId, invoiceId));
      return deliveries.every((row) => row.status === "succeeded");
    });

    // --- The full incident timeline, as the owner reads it -----------------
    const timeline = await trpc(owner.cookie, "inbox.activity", {
      id: invoiceId,
    });
    const entries = timeline.data.entries as Json[];
    expect(timeline.data.current.extraction).toBe("processed");
    const index = (predicate: (entry: Json) => boolean) =>
      entries.findIndex(predicate);
    const receipt = index((entry) => entry.stage === "receipt");
    const firstFailure = index(
      (entry) =>
        entry.refs.jobId === failedJob!.id && entry.status === "failed",
    );
    const refusedRetry = index(
      (entry) =>
        entry.title === "Operator retried a job" && entry.status === "refused",
    );
    const viewed = index(
      (entry) => entry.title === "Operator viewed the invoice's activity",
    );
    const operatorRetry = index(
      (entry) =>
        entry.title === "Operator retried a job" && entry.status === "ok",
    );
    const reread = index(
      (entry) =>
        entry.stage === "extraction" &&
        entry.status === "ok" &&
        entry.refs.jobId !== failedJob!.id,
    );
    const delivered = index(
      (entry) => entry.stage === "delivery" && entry.status === "ok",
    );
    const keyDenied = index(
      (entry) =>
        entry.title === "Retried delivery" && entry.actor?.type === "api_key",
    );
    for (const position of [
      receipt,
      firstFailure,
      refusedRetry,
      viewed,
      operatorRetry,
      reread,
      delivered,
      keyDenied,
    ]) {
      expect(position).toBeGreaterThanOrEqual(0);
    }
    expect(receipt).toBeLessThan(refusedRetry);
    expect(refusedRetry).toBeLessThan(viewed);
    expect(viewed).toBeLessThan(firstFailure);
    expect(firstFailure).toBeLessThan(operatorRetry);
    expect(operatorRetry).toBeLessThan(reread);
    expect(reread).toBeLessThan(delivered);
    expect(entries[operatorRetry]).toMatchObject({
      actor: { type: "operator", name: "on-call" },
      reason: expect.stringContaining("Purpose: incident"),
    });
    expect(entries[keyDenied]?.reason).toContain("Not permitted");
    // Correlation: the delivered entry names the event the endpoint received.
    const deliveredEventId = entries[delivered]?.refs.eventId;
    expect(received.map((event) => event.eventId)).toContain(deliveredEventId);
    expect(entries[delivered]?.title).toBe(
      `Webhook invoice.processed to http://127.0.0.1:${receiver.port} delivered`,
    );

    // --- Who did what: the workspace audit log (owner) ---------------------
    const log = await trpc(owner.cookie, "audit.list", { limit: 100 });
    expect(log.error).toBeNull();
    const events = log.data.data as Json[];
    const find = (action: string, outcome: string, actorType?: string) =>
      events.find(
        (event) =>
          event.action === action &&
          event.outcome === outcome &&
          (!actorType || event.actor.type === actorType),
      );
    expect(find("webhook.create", "succeeded", "user")).toMatchObject({
      actor: { id: owner.userId },
      detail: { origin: `http://127.0.0.1:${receiver.port}` },
    });
    expect(find("webhook.create", "denied", "user")).toMatchObject({
      actor: { id: member.userId },
    });
    expect(find("delivery_rules.update", "succeeded", "user")).toMatchObject({
      actor: { id: owner.userId },
      detail: { expectedVersion: rules.data.current.version },
    });
    expect(find("api_key.save", "succeeded")).toMatchObject({
      detail: { scopes: ["inbox.read"] },
    });
    expect(find("member.invite", "succeeded")).toBeDefined();
    expect(find("member.join", "succeeded")).toMatchObject({
      actor: { id: member.userId },
    });
    expect(
      events.filter(
        (event) =>
          event.action === "delivery.retry" &&
          event.outcome === "denied" &&
          event.actor.type === "api_key",
      ),
    ).toHaveLength(2);
    expect(find("delivery.retry", "denied", "api_key")).toMatchObject({
      target: { type: "invoice", id: invoiceId },
      surface: "api",
    });
    const refusals = events.filter(
      (event) =>
        event.action === "operator.job_retry" && event.outcome === "refused",
    );
    expect(refusals.map((event) => event.detail.result).sort()).toEqual([
      "not_failed",
      "superseded",
    ]);
    expect(refusals.every((event) => event.purpose === "incident")).toBe(true);
    expect(find("operator.job_retry", "succeeded", "operator")).toMatchObject({
      actor: { name: "on-call", credentialId: OPS_TOKEN_FINGERPRINT },
      purpose: "incident",
      target: { type: "invoice", id: invoiceId },
      detail: {
        workflow: "process-attachment",
        result: "requeued",
        tokenFingerprint: OPS_TOKEN_FINGERPRINT,
      },
    });
    expect(
      find("operator.invoice_activity_view", "succeeded", "operator"),
    ).toMatchObject({ purpose: "support" });
    // Settled: nothing audited is left without an outcome.
    expect(events.filter((event) => event.outcome === "started")).toEqual([]);

    // The operator's own record of what operators did.
    const operatorLog = await operator(`/ops/audit?teamId=${teamId}`);
    const operatorEvents = ((await operatorLog.json()) as Json).data as Json[];
    expect(operatorEvents.map((event) => event.action).sort()).toEqual([
      "operator.invoice_activity_view",
      "operator.job_retry",
      "operator.job_retry",
      "operator.job_retry",
    ]);
    expect(
      operatorEvents.every(
        (event) => event.detail.tokenFingerprint === OPS_TOKEN_FINGERPRINT,
      ),
    ).toBe(true);

    // --- Redaction everywhere an operator or customer looks ----------------
    const surfaces = JSON.stringify([
      timeline.data,
      events,
      operatorTrace,
      listedFailure,
      operatorEvents,
      await client.primaryDb
        .select({ lastError: schema.workflowJobs.lastError })
        .from(schema.workflowJobs)
        .where(orm.eq(schema.workflowJobs.teamId, teamId)),
    ]);
    expect(surfaces).not.toContain(LEAKY_TOKEN);
    expect(surfaces).not.toContain(LEAKY_IBAN);
    expect(surfaces).not.toContain("receiver-secret");
    expect(surfaces).not.toContain(readKey);
  }, 120_000);

  test("an invoice's job links are read through the workflow_jobs payload indexes", async () => {
    const owner = await createUser("activity-explain");
    const teamId = owner.teamId;
    // A workspace with a long job history, most of it about other invoices.
    await client.primaryDb.execute(orm.sql`
      insert into workflow_jobs (name, team_id, payload, status, idempotency_key)
      select 'process-attachment', ${teamId}::uuid,
        jsonb_build_object('inboxId', gen_random_uuid()::text),
        'succeeded', 'explain-' || ${teamId} || '-' || g
      from generate_series(1, 20000) g`);
    await client.primaryDb.execute(orm.sql`analyze workflow_jobs`);

    const query = queries.invoiceJobsQuery(client.db, {
      teamId,
      invoiceId: crypto.randomUUID(),
      deliveryIds: [crypto.randomUUID()],
      correctionIds: [crypto.randomUUID()],
    });
    const explained = await client.primaryDb.execute<{
      "QUERY PLAN": unknown;
    }>(orm.sql`explain (format json) ${query}`);
    const plan = JSON.stringify(explained.rows[0]!["QUERY PLAN"]);
    for (const index of [
      "workflow_jobs_team_inbox_id_idx",
      "workflow_jobs_team_invoice_id_idx",
      "workflow_jobs_team_delivery_id_idx",
      "workflow_jobs_team_correction_id_idx",
    ]) {
      expect(plan).toContain(`"Index Name":"${index}"`);
    }
    expect(plan).not.toContain('"Node Type":"Seq Scan"');
    expect(plan).not.toContain('"Index Name":"workflow_jobs_team_id_idx"');
  }, 60_000);

  test("an operator re-runs a failed invoice match and the customer sees it", async () => {
    provider.down = false;
    const owner = await createUser("activity-match");
    const teamId = owner.teamId;
    const invoiceId = await upload(owner.cookie);
    const matched = await runWorker(async () => {
      const [job] = await jobsFor(teamId, "match-invoice");
      return job?.status === "succeeded";
    });
    expect(matched).toBe(true);
    const [matchJob] = await jobsFor(teamId, "match-invoice");
    await client.primaryDb
      .update(schema.workflowJobs)
      .set({ status: "failed", lastError: "TypeSafe unavailable: 503" })
      .where(orm.eq(schema.workflowJobs.id, matchJob!.id));

    const view = await trpc(owner.cookie, "inbox.activity", { id: invoiceId });
    expect(
      (view.data.entries as Json[]).find((entry) => entry.stage === "matching"),
    ).toMatchObject({
      title: "Matching to authorization sources: failed",
      status: "failed",
      reason: expect.stringContaining("TypeSafe unavailable: 503"),
      refs: { jobId: matchJob!.id },
    });

    const body = { purpose: "incident", reason: "TypeSafe outage resolved" };
    const retried = await operator(`/ops/jobs/${matchJob!.id}/retry`, {
      method: "POST",
      body,
    });
    expect(retried.status).toBe(202);
    expect((await retried.json()) as Json).toMatchObject({
      status: "requeued",
      action: "rematch",
    });
    const rematched = await runWorker(async () => {
      const [job] = await jobsFor(teamId, "match-invoice");
      return job?.status === "succeeded";
    });
    expect(rematched).toBe(true);
    const jobs = await jobsFor(teamId, "match-invoice");
    expect(jobs.map((job) => job.id)).toEqual([matchJob!.id]);
    const again = await operator(`/ops/jobs/${matchJob!.id}/retry`, {
      method: "POST",
      body,
    });
    expect(again.status).toBe(409);
  }, 60_000);

  test("an operator accounting retry that re-drives only webhooks reports what it requeued", async () => {
    provider.down = false;
    const owner = await createUser("activity-partial");
    const teamId = owner.teamId;
    const endpoint = await trpc(
      owner.cookie,
      "webhooks.create",
      {
        url: `http://127.0.0.1:${receiver.port}/partial`,
        events: ["invoice.processed"],
      },
      "mutation",
    );
    expect(endpoint.error).toBeNull();
    const rules = await trpc(owner.cookie, "deliveryRules.get", null);
    const policy = rules.data.current.policy as Json;
    expect(
      (
        await trpc(
          owner.cookie,
          "deliveryRules.update",
          {
            expectedVersion: rules.data.current.version,
            policy: {
              ...policy,
              destinations: { ...policy.destinations, webhooks: "all" },
            },
          },
          "mutation",
        )
      ).error,
    ).toBeNull();
    const invoiceId = await upload(owner.cookie);
    const deliveryRow = () =>
      client.primaryDb
        .select()
        .from(schema.webhookDeliveries)
        .where(orm.eq(schema.webhookDeliveries.invoiceId, invoiceId))
        .then(([row]) => row);
    expect(
      await runWorker(
        async () => (await deliveryRow())?.status === "succeeded",
      ),
    ).toBe(true);

    // The webhook delivery failed, and so did an accounting post the
    // delivery rules hold for the current revision.
    const delivered = await deliveryRow();
    await client.primaryDb
      .update(schema.webhookDeliveries)
      .set({ status: "failed", lastError: "HTTP 500" })
      .where(orm.eq(schema.webhookDeliveries.id, delivered!.id));
    await client.primaryDb
      .update(schema.inbox)
      .set({ accountingPostStatus: "failed" })
      .where(orm.eq(schema.inbox.id, invoiceId));
    const [post] = await client.primaryDb
      .insert(schema.workflowJobs)
      .values({
        name: "post-accounting-draft",
        teamId,
        payload: { invoiceId, teamId },
        status: "failed",
        attempts: 3,
        lastError: "Xero unavailable",
        idempotencyKey: `activity-partial-${invoiceId}`,
        finishedAt: new Date().toISOString(),
      })
      .returning();

    // The open hold on the current revision waits for a person, so the
    // customer's trace marks it as needing review, not as work in progress.
    const heldView = await trpc(owner.cookie, "inbox.activity", {
      id: invoiceId,
    });
    const holds = (heldView.data.entries as Json[]).filter((entry) =>
      String(entry.id).startsWith("decision:"),
    );
    expect(holds).toHaveLength(1);
    expect(holds[0]).toMatchObject({
      stage: "delivery",
      status: "review",
      title: expect.stringContaining("Held by the delivery rules"),
      reason: expect.stringContaining(
        "correct or re-extract the invoice, or dismiss it",
      ),
    });
    expect(
      (heldView.data.entries as Json[]).some(
        (entry) => entry.status === "pending",
      ),
    ).toBe(false);

    const body = { purpose: "incident", reason: "Webhook endpoint recovered" };
    const retried = await operator(`/ops/jobs/${post!.id}/retry`, {
      method: "POST",
      body,
    });
    expect(retried.status).toBe(202);
    const result = (await retried.json()) as Json;
    expect(result).toMatchObject({
      status: "requeued",
      action: "retry_delivery",
      detail: {
        accounting: "held",
        webhooksRequeued: 1,
        notRequeued:
          "Held by the delivery rules: it cannot be released: correct or re-extract the invoice, or dismiss it",
      },
    });
    expect((await deliveryRow())?.status).toBe("queued");

    const again = await operator(`/ops/jobs/${post!.id}/retry`, {
      method: "POST",
      body,
    });
    expect(again.status).toBe(409);
    expect((await again.json()) as Json).toMatchObject({
      status: "refused",
      reason:
        "Held by the delivery rules: it cannot be released: correct or re-extract the invoice, or dismiss it",
    });

    const [settled] = await client.primaryDb
      .select()
      .from(schema.auditEvents)
      .where(orm.eq(schema.auditEvents.id, result.auditEventId))
      .limit(1);
    expect(settled).toMatchObject({
      outcome: "succeeded",
      detail: expect.objectContaining({
        webhooksRequeued: 1,
        accounting: "held",
      }),
    });
  }, 60_000);

  test("an operator cancels a queued job and the customer recovers it", async () => {
    const owner = await createUser("activity-cancel");
    const teamId = owner.teamId;
    const endpoint = await trpc(
      owner.cookie,
      "webhooks.create",
      {
        url: `http://127.0.0.1:${receiver.port}/cancel`,
        events: ["invoice.processed"],
      },
      "mutation",
    );
    expect(endpoint.error).toBeNull();
    const endpointId = (endpoint.data as { id: string }).id;
    const test = await trpc(
      owner.cookie,
      "webhooks.sendTest",
      { id: endpointId },
      "mutation",
    );
    const deliveryId = (test.data as { deliveryId: string }).deliveryId;

    const queued = await operator(
      `/ops/jobs?filter=queued&teamId=${teamId}&workflow=deliver-webhook`,
    );
    const [job] = ((await queued.json()) as Json).data as Json[];
    expect(job).toMatchObject({ subject: { deliveryId } });

    const body = {
      purpose: "incident",
      reason: "Endpoint owner asked to hold",
    };
    expect(
      (
        await request(`/ops/jobs/${job!.id}/cancel`, {
          method: "POST",
          headers: { cookie: owner.cookie },
          body,
        })
      ).status,
    ).toBe(401);
    const cancelled = await operator(`/ops/jobs/${job!.id}/cancel`, {
      method: "POST",
      body,
    });
    expect(cancelled.status).toBe(202);
    const twice = await operator(`/ops/jobs/${job!.id}/cancel`, {
      method: "POST",
      body,
    });
    expect(twice.status).toBe(409);

    // The reconciler turns the cancelled job into a visible, retryable
    // failure on the delivery, which the customer redelivers.
    await delivery.reconcileDeliveries(client.db, { teamId });
    const deliveries = await trpc(owner.cookie, "webhooks.deliveries", {
      id: endpointId,
    });
    const settled = (deliveries.data as Json[]).find(
      (row) => row.id === deliveryId,
    );
    expect(settled).toMatchObject({ status: "failed" });
    expect(settled?.lastError).toContain("Cancelled by an operator");
    const redelivered = await trpc(
      owner.cookie,
      "webhooks.redeliver",
      { id: endpointId, deliveryId },
      "mutation",
    );
    expect(redelivered.error).toBeNull();
    const delivered = await runWorker(async () => {
      const [row] = await client.primaryDb
        .select({ status: schema.webhookDeliveries.status })
        .from(schema.webhookDeliveries)
        .where(orm.eq(schema.webhookDeliveries.id, deliveryId));
      return row?.status === "succeeded";
    });
    expect(delivered).toBe(true);

    const log = await trpc(owner.cookie, "audit.list", {
      categories: ["operator", "delivery"],
    });
    const actions = (log.data.data as Json[]).map(
      (event) => `${event.action}:${event.outcome}`,
    );
    expect(actions).toEqual(
      expect.arrayContaining([
        "operator.job_cancel:succeeded",
        "operator.job_cancel:refused",
        "webhook.test:succeeded",
        "webhook.redeliver:succeeded",
      ]),
    );
  }, 60_000);
});
