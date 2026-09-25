/**
 * Fault-injection proof for the processing-to-delivery handoff.
 *
 * Real worker processes (`src/worker.ts`) run against the verification
 * database. Each handoff boundary is reached deterministically with a test-only
 * trigger: an "error" fault fails a write inside the completion transaction,
 * and a "hold" fault parks the worker on an advisory lock right before it
 * records an outcome, where the verifier SIGKILLs it and restarts a fresh one.
 * At the end every accepted invoice revision is reconciled against the
 * webhook events a consumer received and the bills the provider created.
 */
import { resolve } from "node:path";
import { createDatabaseClient } from "@invoicewise/db/client";
import {
  createInbox,
  createWebhookEndpoint,
  disableWebhookEndpoint,
  disconnectAccountingConnectionRecord,
  getInboxById,
  upsertAccountingConnection,
} from "@invoicewise/db/queries";
import {
  inbox,
  teams,
  users,
  webhookDeliveries,
  workflowJobs,
} from "@invoicewise/db/schema";
import { createStorageClientFromEnv } from "@invoicewise/db/storage";
import { and, eq, inArray, sql } from "drizzle-orm";
import { workflowKey } from "./client";
import {
  completeInvoiceProcessing,
  logicalEventId,
  retryInvoiceDelivery,
} from "./delivery";
import { acceptIntakeUpload } from "./intake";
import {
  deliverPossibleDuplicates,
  required,
  startTypeSafeStub,
} from "./verify-support";

type Receipt = {
  endpoint: "a" | "b" | "c";
  deliveryId: string;
  eventId: string;
  event: string;
  invoiceId: string | null;
  revision: number | null;
  status: number;
};

type Worker = {
  label: string;
  output: () => string;
  kill: () => Promise<void>;
  stop: () => Promise<void>;
};

const FAULT_POINTS = {
  enqueueAccounting: "enqueue:post-accounting-draft",
  completeProcessing: "complete:process-attachment",
  recordWebhookAttempt: "record:webhook-attempt",
  recordAccountingPost: "record:accounting-post",
} as const;

// Test-only fault injection, created in the verification database and
// dropped afterwards. A fault row arms one point: "error" raises inside the
// writing transaction; "hold" blocks it on an advisory lock the verifier owns.
const FAULT_SETUP = `
create table if not exists handoff_fault (point text primary key, mode text not null);
create or replace function handoff_fault_hit() returns trigger language plpgsql as $$
declare fault_mode text;
begin
  select mode into fault_mode from handoff_fault where point = TG_ARGV[0];
  if fault_mode = 'error' then
    raise exception 'injected handoff fault at %', TG_ARGV[0];
  elsif fault_mode = 'hold' then
    perform pg_advisory_xact_lock(hashtext(TG_ARGV[0]));
  end if;
  return new;
end $$;
drop trigger if exists handoff_fault_enqueue_accounting on workflow_jobs;
create trigger handoff_fault_enqueue_accounting before insert on workflow_jobs
  for each row when (new.name = 'post-accounting-draft')
  execute function handoff_fault_hit('${FAULT_POINTS.enqueueAccounting}');
drop trigger if exists handoff_fault_complete_processing on workflow_jobs;
create trigger handoff_fault_complete_processing before update on workflow_jobs
  for each row when (new.name = 'process-attachment' and new.status = 'succeeded')
  execute function handoff_fault_hit('${FAULT_POINTS.completeProcessing}');
drop trigger if exists handoff_fault_webhook_attempt on webhook_delivery_attempts;
create trigger handoff_fault_webhook_attempt before insert on webhook_delivery_attempts
  for each row execute function handoff_fault_hit('${FAULT_POINTS.recordWebhookAttempt}');
drop trigger if exists handoff_fault_accounting_post on inbox;
create trigger handoff_fault_accounting_post before update on inbox
  for each row when (new.accounting_provider_id is not null and old.accounting_provider_id is null)
  execute function handoff_fault_hit('${FAULT_POINTS.recordAccountingPost}');
`;

const FAULT_TEARDOWN = `
drop trigger if exists handoff_fault_enqueue_accounting on workflow_jobs;
drop trigger if exists handoff_fault_complete_processing on workflow_jobs;
drop trigger if exists handoff_fault_webhook_attempt on webhook_delivery_attempts;
drop trigger if exists handoff_fault_accounting_post on inbox;
drop function if exists handoff_fault_hit();
drop table if exists handoff_fault;
`;

const check = (condition: unknown, message: string) => {
  if (!condition) throw new Error(`Handoff verification failed: ${message}`);
};

async function main() {
  const database = createDatabaseClient({
    primaryUrl: required("DATABASE_PRIMARY_URL"),
    isDevelopment: true,
  });
  const db = database.db;
  const storage = createStorageClientFromEnv();
  const bytes = Buffer.from(
    await Bun.file(
      resolve(
        process.cwd(),
        "../documents/src/test/fixtures/synthetic-invoice.pdf",
      ),
    ).arrayBuffer(),
  );

  // A consumer that records every delivery it is sent. `failing` makes one
  // endpoint answer 503 for one invoice, or for one event of that invoice.
  const receipts: Receipt[] = [];
  const failing = new Set<string>();
  const receiver = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const endpoint = path === "/a" ? "a" : path === "/c" ? "c" : "b";
      const body = (await request.json()) as {
        type: string;
        invoiceId?: string;
        revision?: number;
      };
      const invoiceId = body.invoiceId ?? null;
      const status =
        failing.has(`${endpoint}:${invoiceId}`) ||
        failing.has(`${endpoint}:${invoiceId}:${body.type}`)
          ? 503
          : 204;
      receipts.push({
        endpoint,
        deliveryId: request.headers.get("invoicewise-delivery") ?? "",
        eventId: request.headers.get("invoicewise-event-id") ?? "",
        event: body.type,
        invoiceId,
        revision: body.revision ?? null,
        status,
      });
      return new Response(status === 503 ? "unavailable" : null, { status });
    },
  });

  // Nango stand-in: the connection lookup plus the Xero proxy. One bill per
  // provider idempotency key, like Xero, which replays the original response
  // for a repeated Idempotency-Key. Requests and distinct bills are also
  // counted per invoice number, which the verifier sets to the invoice id.
  const bills = new Map<string, string>();
  const billRequests = new Map<string, number>();
  const billKeys = new Map<string, Set<string>>();
  const nango = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (
        request.method === "GET" &&
        url.pathname === "/connection/xero-connection"
      ) {
        return Response.json({
          connection_id: "xero-connection",
          provider_config_key: "xero-invoicewise",
          connection_config: { tenant_id: "xero-tenant" },
        });
      }
      if (
        request.method === "POST" &&
        url.pathname === "/proxy/api.xro/2.0/Invoices"
      ) {
        const key = request.headers.get("nango-proxy-idempotency-key") ?? "";
        const body = (await request.json()) as {
          Invoices?: { InvoiceNumber?: string }[];
        };
        const number = body.Invoices?.[0]?.InvoiceNumber ?? "";
        billRequests.set(number, (billRequests.get(number) ?? 0) + 1);
        billKeys.set(number, (billKeys.get(number) ?? new Set()).add(key));
        const providerId = bills.get(key) ?? `xero-bill-${bills.size + 1}`;
        bills.set(key, providerId);
        return Response.json({ Invoices: [{ InvoiceID: providerId }] });
      }
      if (
        request.method === "POST" &&
        url.pathname.startsWith("/proxy/api.xro/2.0/Invoices/")
      ) {
        return Response.json({ Attachments: [{ AttachmentID: "attachment" }] });
      }
      return new Response("Not found", { status: 404 });
    },
  });
  const typeSafe = startTypeSafeStub();

  const workerEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    NODE_ENV: "test",
    TYPESAFE_API_KEY: "verify-stub",
    TYPESAFE_BASE_URL: `http://127.0.0.1:${typeSafe.port}`,
    NANGO_SECRET_KEY: "verify-stub",
    NANGO_BASE_URL: `http://127.0.0.1:${nango.port}`,
    NANGO_XERO_INTEGRATION_ID: "xero-invoicewise",
    NANGO_XERO_DRAFT_BILL_ACTION: "create-draft-bill",
    WORKFLOW_POLL_MS: "50",
    WORKFLOW_LEASE_MS: "3000",
    WORKFLOW_RETRY_BASE_MS: "50",
    WORKFLOW_RETRY_MAX_MS: "100",
    WORKFLOW_RECONCILE_MS: "1000",
    WORKFLOW_CONCURRENCY: "4",
  };
  const workers = new Set<Worker>();
  const startWorker = (label: string, env: Record<string, string> = {}) => {
    const child = Bun.spawn(["bun", "--no-env-file", "run", "src/worker.ts"], {
      cwd: process.cwd(),
      env: { ...workerEnv, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    let output = "";
    const drain = async (stream: ReadableStream<Uint8Array>) => {
      const decoder = new TextDecoder();
      const reader = stream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        output = (output + decoder.decode(value)).slice(-20_000);
      }
    };
    void drain(child.stdout);
    void drain(child.stderr);
    const worker: Worker = {
      label,
      output: () => output,
      kill: async () => {
        child.kill("SIGKILL");
        await child.exited;
        workers.delete(worker);
      },
      stop: async () => {
        child.kill("SIGTERM");
        const exited = await Promise.race([
          child.exited.then(() => true),
          Bun.sleep(10_000).then(() => false),
        ]);
        if (!exited) {
          child.kill("SIGKILL");
          await child.exited;
        }
        workers.delete(worker);
      },
    };
    workers.add(worker);
    return worker;
  };

  const rows = async <T>(query: ReturnType<typeof sql>) =>
    (await db.execute(query)).rows as T[];

  const waitFor = async (
    label: string,
    condition: () => Promise<boolean>,
    timeoutMs = 60_000,
  ) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await condition()) return;
      await Bun.sleep(100);
    }
    const logs = [...workers]
      .map((worker) => `--- ${worker.label}\n${worker.output().slice(-3000)}`)
      .join("\n");
    throw new Error(`Timed out waiting for ${label}\n${logs}`);
  };

  const arm = (point: string, mode: "error" | "hold") =>
    db.execute(
      sql`insert into handoff_fault (point, mode) values (${point}, ${mode})
          on conflict (point) do update set mode = excluded.mode`,
    );
  const disarm = (point: string) =>
    db.execute(sql`delete from handoff_fault where point = ${point}`);

  /**
   * Parks the next worker that reaches `point` on an advisory lock. The
   * returned `crash` SIGKILLs that worker while it is parked, terminates its
   * blocked database session (so its open transaction rolls back, exactly as
   * a dead host's would), disarms the point and releases the lock.
   */
  const openHolds = new Set<() => void>();
  const holdAt = async (point: string) => {
    let release!: () => void;
    let acquired!: () => void;
    const released = new Promise<void>((done) => {
      release = done;
    });
    openHolds.add(release);
    const ready = new Promise<void>((done) => {
      acquired = done;
    });
    const holding = db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${point}))`);
      acquired();
      await released;
    });
    await ready;
    await arm(point, "hold");
    const blocked = () =>
      rows<{ pid: number }>(
        sql`select pid from pg_locks
            where locktype = 'advisory' and not granted
              and database = (select oid from pg_database where datname = current_database())`,
      );
    return {
      reached: () =>
        waitFor(`a worker to reach ${point}`, async () => {
          return (await blocked()).length > 0;
        }),
      crash: async (worker: Worker) => {
        await worker.kill();
        for (const { pid } of await blocked()) {
          await db.execute(sql`select pg_terminate_backend(${pid})`);
        }
        await disarm(point);
        openHolds.delete(release);
        release();
        await holding;
      },
    };
  };

  let teamId = "";
  let otherTeamId = "";
  const userIds: string[] = [];
  const filePaths: string[][] = [];
  try {
    await db.execute(sql.raw(FAULT_SETUP));

    const createTeam = async (name: string) => {
      const [team] = await db
        .insert(teams)
        .values({ name })
        .returning({ id: teams.id });
      if (!team) throw new Error("Unable to create verification team");
      const [user] = await db
        .insert(users)
        .values({
          fullName: "Handoff verifier",
          email: `handoff-${team.id}@invoicewise.local`,
          teamId: team.id,
        })
        .returning({ id: users.id });
      if (!user) throw new Error("Unable to create verification user");
      userIds.push(user.id);
      // Its invoices share a date and total; this proves the handoff, not
      // the delivery rules' possible-duplicate hold.
      await deliverPossibleDuplicates(db, team.id);
      return { teamId: team.id, userId: user.id };
    };
    const main = await createTeam("Handoff verification");
    teamId = main.teamId;
    const createdA = await createWebhookEndpoint(db, {
      teamId,
      userId: main.userId,
      url: `http://127.0.0.1:${receiver.port}/a`,
      events: [
        "invoice.processed",
        "invoice.judgments.attached",
        "delivery.failed",
      ],
    });
    const createdB = await createWebhookEndpoint(db, {
      teamId,
      userId: main.userId,
      url: `http://127.0.0.1:${receiver.port}/b`,
      events: ["invoice.processed"],
    });
    if (createdA.error || createdB.error) {
      throw new Error("Unable to create endpoints");
    }
    const endpointA = createdA.endpoint;
    const endpointB = createdB.endpoint;
    await upsertAccountingConnection(db, {
      teamId,
      provider: "xero",
      integrationId: "xero-invoicewise",
      connectionId: "xero-connection",
      organisationId: "xero-tenant",
      organisationName: null,
      sandbox: false,
      autoPostOnConnect: true,
    });

    const invoiceState = async (invoiceId: string) => {
      const [record] = await db
        .select({
          status: inbox.status,
          revision: inbox.processingRevision,
          accountingPostStatus: inbox.accountingPostStatus,
          accountingProviderId: inbox.accountingProviderId,
          accountingPostError: inbox.accountingPostError,
          accountingPostRetryable: inbox.accountingPostRetryable,
        })
        .from(inbox)
        .where(eq(inbox.id, invoiceId));
      const deliveries = await db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.invoiceId, invoiceId));
      return { ...record!, deliveries };
    };
    const deliveryFor = (
      state: Awaited<ReturnType<typeof invoiceState>>,
      endpointId: string,
      event = "invoice.processed",
    ) =>
      state.deliveries.find(
        (delivery) =>
          delivery.endpointId === endpointId && delivery.event === event,
      );
    const settled = async (invoiceIds: string[]) => {
      for (const invoiceId of invoiceIds) {
        const state = await invoiceState(invoiceId);
        if (state.accountingPostStatus === "queued") return false;
        if (
          state.deliveries.some(
            (delivery) =>
              delivery.status === "queued" || delivery.status === "delivering",
          )
        ) {
          return false;
        }
      }
      return true;
    };
    const waitSettled = (label: string, invoiceIds: string[]) =>
      waitFor(`${label} to settle`, () => settled(invoiceIds));
    const receiptsFor = (invoiceId: string, endpoint: "a" | "b") =>
      receipts.filter(
        (receipt) =>
          receipt.invoiceId === invoiceId && receipt.endpoint === endpoint,
      );

    // Complete enough to pass the accounting readiness checks.
    const extraction = (invoiceNumber: string) => ({
      documentType: "invoice",
      supplierName: "Acme Supplies Ltd",
      supplierVatNumber: "GB123456789",
      invoiceNumber,
      invoiceDate: "2026-09-22",
      dueDate: "2026-10-22",
      currency: "GBP",
      netAmount: 100,
      vatAmount: 20,
      grossAmount: 120,
      lineItems: [
        { description: "Materials", quantity: 1, unitPrice: 100, total: 100 },
      ],
    });
    const processingInvoice = async (name: string, owner = teamId) => {
      const filePath = [owner, "inbox", `${name}.pdf`];
      filePaths.push(filePath);
      // The bill post attaches the stored source document.
      await storage.upload({
        bucket: "vault",
        path: filePath,
        file: bytes,
        contentType: "application/pdf",
      });
      const created = await createInbox(db, {
        displayName: name,
        teamId: owner,
        filePath,
        fileName: `${name}.pdf`,
        contentType: "application/pdf",
        size: 42,
      });
      if (!created) throw new Error("Unable to create invoice");
      await db
        .update(inbox)
        .set({ status: "processing" })
        .where(eq(inbox.id, created.id));
      return created.id;
    };
    const complete = (invoiceId: string, owner = teamId) =>
      completeInvoiceProcessing(db, {
        id: invoiceId,
        teamId: owner,
        displayName: "Acme Supplies Ltd",
        amount: 120,
        currency: "GBP",
        type: "invoice",
        extraction: extraction(invoiceId),
        judgments: [],
      });

    const boundaries: Record<string, unknown> = {};

    // 1. Save-before-event. The last destination's enqueue fails inside the
    //    completion transaction: the extraction, the revision and the
    //    already-written webhook intents roll back together, so no
    //    destination is ever scheduled alone and the job retries.
    const accepted = await acceptIntakeUpload(db, storage, {
      teamId,
      bytes,
      declaredMimeType: "application/pdf",
      fileName: "handoff-invoice.pdf",
    });
    if (accepted.status !== "accepted") {
      throw new Error(`Intake validation failed: ${accepted.message}`);
    }
    filePaths.push(accepted.filePath);
    const processed = accepted.inboxId;
    const processKey = workflowKey.attachment(teamId, processed);
    const processJob = async () => {
      const [job] = await db
        .select()
        .from(workflowJobs)
        .where(
          and(
            eq(workflowJobs.name, "process-attachment"),
            eq(workflowJobs.idempotencyKey, processKey),
          ),
        );
      return job!;
    };
    await arm(FAULT_POINTS.enqueueAccounting, "error");
    // Long retry delay: the first failure is inspected before any retry.
    const saveFailure = startWorker("save-before-event", {
      WORKFLOW_RETRY_BASE_MS: "600000",
      WORKFLOW_RETRY_MAX_MS: "600000",
    });
    await waitFor("the completion transaction to fail", async () => {
      const job = await processJob();
      return job.attempts === 1 && job.status === "queued";
    });
    await saveFailure.stop();
    await disarm(FAULT_POINTS.enqueueAccounting);
    const afterRollback = await invoiceState(processed);
    const rolledBackJob = await processJob();
    check(
      afterRollback.status === "processing" &&
        afterRollback.revision === 0 &&
        afterRollback.deliveries.length === 0 &&
        afterRollback.accountingPostStatus === null &&
        rolledBackJob.lastError !== null,
      `a failed enqueue must roll back the whole completion: ${JSON.stringify({
        status: afterRollback.status,
        revision: afterRollback.revision,
        deliveries: afterRollback.deliveries.length,
        accounting: afterRollback.accountingPostStatus,
        error: rolledBackJob.lastError,
      })}`,
    );
    boundaries.saveBeforeEvent = {
      injected:
        "post-accounting-draft enqueue failed in the completion transaction",
      invoiceStatus: afterRollback.status,
      revision: afterRollback.revision,
      deliveriesScheduled: afterRollback.deliveries.length,
      jobRetryQueued: rolledBackJob.status,
    };

    // 2. Crash after the completion committed but before the job recorded
    //    success, with one destination's job then lost (as with the old
    //    non-atomic handoff). The restarted worker must not re-process or
    //    reschedule a second revision, and must resume the lost destination.
    await db
      .update(workflowJobs)
      .set({ runAt: new Date().toISOString() })
      .where(eq(workflowJobs.id, rolledBackJob.id));
    const afterCommit = await holdAt(FAULT_POINTS.completeProcessing);
    const committing = startWorker("crash-after-commit", {
      WORKFLOW_CONCURRENCY: "1",
    });
    await afterCommit.reached();
    const committed = await invoiceState(processed);
    check(
      committed.revision === 1 &&
        committed.status === "pending" &&
        committed.accountingPostStatus === "queued" &&
        committed.deliveries.length === 3,
      `completion must commit with all intents: ${JSON.stringify({
        revision: committed.revision,
        deliveries: committed.deliveries.length,
        accounting: committed.accountingPostStatus,
      })}`,
    );
    await afterCommit.crash(committing);
    const lostDelivery = deliveryFor(committed, endpointB.id)!;
    await db
      .delete(workflowJobs)
      .where(
        and(
          eq(workflowJobs.name, "deliver-webhook"),
          eq(
            workflowJobs.idempotencyKey,
            workflowKey.webhook(lostDelivery.eventId!, endpointB.id),
          ),
        ),
      );
    const resumed = startWorker("restart-after-commit");
    await waitFor("the processing job to be reclaimed", async () => {
      const job = await processJob();
      return job.status === "succeeded";
    });
    await waitSettled("the resumed invoice", [processed]);
    await resumed.stop();
    const afterResume = await invoiceState(processed);
    const resumedJob = await processJob();
    check(
      afterResume.revision === 1 &&
        afterResume.deliveries.length === 3 &&
        afterResume.deliveries.every(
          (delivery) => delivery.status === "succeeded",
        ) &&
        afterResume.accountingPostStatus === "posted" &&
        receiptsFor(processed, "b").some(
          (receipt) => receipt.eventId === lostDelivery.eventId,
        ),
      `restart after commit must resume every destination once: ${JSON.stringify(
        {
          revision: afterResume.revision,
          deliveries: afterResume.deliveries.map((d) => [d.event, d.status]),
          accounting: afterResume.accountingPostStatus,
        },
      )}`,
    );
    boundaries.crashAfterCommit = {
      killedWorker: "SIGKILL while recording process-attachment success",
      lostDestinationJob: "endpoint b",
      processingAttempts: resumedJob.attempts,
      revisionAfterRestart: afterResume.revision,
      deliveries: afterResume.deliveries.map((d) => `${d.event}:${d.status}`),
      accounting: afterResume.accountingPostStatus,
    };

    // 3. Webhook provider timeout after a remote success: the consumer got
    //    the event, the worker died before recording it. Redelivery reuses
    //    the delivery and logical event id, so the consumer deduplicates.
    const webhookInvoice = await processingInvoice("webhook-timeout");
    const webhookHold = await holdAt(FAULT_POINTS.recordWebhookAttempt);
    check(await complete(webhookInvoice), "webhook invoice must complete");
    const sending = startWorker("webhook-remote-success", {
      WORKFLOW_CONCURRENCY: "1",
    });
    await webhookHold.reached();
    const heldReceipt = receipts.find(
      (receipt) => receipt.invoiceId === webhookInvoice,
    );
    check(heldReceipt, "the consumer must have received the held delivery");
    await webhookHold.crash(sending);
    const webhookRestart = startWorker("restart-after-webhook");
    await waitSettled("the webhook invoice", [webhookInvoice]);
    await webhookRestart.stop();
    const afterWebhook = await invoiceState(webhookInvoice);
    const redelivered = receipts.filter(
      (receipt) => receipt.deliveryId === heldReceipt!.deliveryId,
    );
    check(
      redelivered.length >= 2 &&
        redelivered.every(
          (receipt) => receipt.eventId === heldReceipt!.eventId,
        ) &&
        afterWebhook.deliveries.every(
          (delivery) => delivery.status === "succeeded",
        ),
      "a redelivery after a remote success must keep its event id",
    );
    boundaries.webhookTimeoutAfterRemoteSuccess = {
      killedWorker: "SIGKILL after the consumer answered 2xx, before recording",
      receiptsOfHeldDelivery: redelivered.length,
      sameLogicalEventId: true,
      distinctEventsForConsumer: new Set(
        receipts
          .filter((receipt) => receipt.invoiceId === webhookInvoice)
          .map((receipt) => `${receipt.endpoint}:${receipt.eventId}`),
      ).size,
      ledger: afterWebhook.deliveries.map((d) => `${d.event}:${d.status}`),
    };

    // 4. Accounting provider timeout after a remote success: the bill was
    //    created, the worker died before recording it. The retry sends the
    //    same provider idempotency key and gets the same bill back.
    const billInvoice = await processingInvoice("bill-timeout");
    const billHold = await holdAt(FAULT_POINTS.recordAccountingPost);
    check(await complete(billInvoice), "bill invoice must complete");
    const posting = startWorker("bill-remote-success", {
      WORKFLOW_CONCURRENCY: "1",
    });
    await billHold.reached();
    check(
      billKeys.has(billInvoice),
      "the provider must have created the bill before the crash",
    );
    await billHold.crash(posting);
    const billRestart = startWorker("restart-after-bill");
    await waitSettled("the bill invoice", [billInvoice]);
    await billRestart.stop();
    const afterBill = await invoiceState(billInvoice);
    const billKey = [...(billKeys.get(billInvoice) ?? [])];
    check(
      billRequests.get(billInvoice) === 2 &&
        billKey.length === 1 &&
        afterBill.accountingProviderId === bills.get(billKey[0]!) &&
        afterBill.accountingPostStatus === "posted",
      `a provider timeout after success must yield one bill: ${JSON.stringify({
        requests: billRequests.get(billInvoice),
        status: afterBill.accountingPostStatus,
      })}`,
    );
    boundaries.accountingTimeoutAfterRemoteSuccess = {
      killedWorker:
        "SIGKILL after the provider created the bill, before recording",
      providerRequests: billRequests.get(billInvoice),
      billsCreated: 1,
      finalStatus: afterBill.accountingPostStatus,
    };

    // 5. Concurrent completion, lost and unrecorded jobs, and a failed second
    //    destination, all driven by two workers running at once.
    const raced = await processingInvoice("concurrent-completion");
    const [first, second] = await Promise.all([
      complete(raced),
      complete(raced),
    ]);
    check(
      (first === null) !== (second === null),
      "exactly one concurrent completion may win",
    );

    const stalled = await processingInvoice("stalled-jobs");
    const stalledCompletion = await complete(stalled);
    check(stalledCompletion, "stalled invoice must complete");
    const stalledState = await invoiceState(stalled);
    const orphaned = deliveryFor(stalledState, endpointA.id)!;
    const unrecorded = deliveryFor(stalledState, endpointB.id)!;
    // A's job vanished; B's job died after its final attempt without the
    // handler recording anything (the runner's lease-expiry outcome).
    await db
      .delete(workflowJobs)
      .where(
        eq(
          workflowJobs.idempotencyKey,
          workflowKey.webhook(orphaned.eventId!, endpointA.id),
        ),
      );
    await db
      .update(workflowJobs)
      .set({
        status: "failed",
        attempts: 4,
        lastError: "Workflow lease expired after its final attempt",
        finishedAt: new Date().toISOString(),
      })
      .where(
        eq(
          workflowJobs.idempotencyKey,
          workflowKey.webhook(unrecorded.eventId!, endpointB.id),
        ),
      );
    await db
      .update(webhookDeliveries)
      .set({ status: "delivering" })
      .where(eq(webhookDeliveries.id, unrecorded.id));

    const partial = await processingInvoice("partial-failure");
    check(await complete(partial), "partial invoice must complete");
    failing.add(`b:${partial}`);

    const concurrentWorkers = [
      startWorker("concurrent-1"),
      startWorker("concurrent-2"),
    ];
    await waitSettled("concurrent work", [raced, stalled, partial]);

    const racedState = await invoiceState(raced);
    check(
      racedState.revision === 1 &&
        racedState.deliveries.length === 2 &&
        racedState.accountingPostStatus === "posted",
      "a raced completion must schedule one revision once",
    );
    const stalledAfter = await invoiceState(stalled);
    const unrecordedAfter = stalledAfter.deliveries.find(
      (delivery) => delivery.id === unrecorded.id,
    )!;
    check(
      stalledAfter.deliveries.find((delivery) => delivery.id === orphaned.id)
        ?.status === "succeeded" &&
        unrecordedAfter.status === "failed" &&
        unrecordedAfter.retryable === true &&
        stalledAfter.deliveries.some(
          (delivery) => delivery.event === "delivery.failed",
        ),
      "the reconciler must re-drive a lost job and surface an unrecorded failure",
    );
    const partialState = await invoiceState(partial);
    const partialSummary = await getInboxById(db, { id: partial, teamId });
    check(
      deliveryFor(partialState, endpointA.id)?.status === "succeeded" &&
        deliveryFor(partialState, endpointB.id)?.status === "failed" &&
        deliveryFor(partialState, endpointB.id)?.attempts === 4 &&
        deliveryFor(partialState, endpointB.id)?.retryable === true &&
        partialState.accountingPostStatus === "posted" &&
        partialSummary?.delivery.state === "failed",
      `first destination succeeded, second failed: ${JSON.stringify({
        deliveries: partialState.deliveries.map((d) => [d.event, d.status]),
        summary: partialSummary?.delivery,
      })}`,
    );

    // The terminal failure committed its `delivery.failed` notification with
    // it: one event, to the other subscribed endpoint, identified by the
    // failed delivery and its attempt count.
    const failedB = deliveryFor(partialState, endpointB.id)!;
    const noticesOf = (
      state: Awaited<ReturnType<typeof invoiceState>>,
      deliveryId: string,
    ) =>
      state.deliveries.filter(
        (delivery) =>
          delivery.event === "delivery.failed" &&
          (delivery.payload as { data?: { deliveryId?: string } }).data
            ?.deliveryId === deliveryId,
      );
    const firstNotices = noticesOf(partialState, failedB.id);
    const firstNoticeId = logicalEventId(failedB.id, "delivery.failed", 4);
    check(
      firstNotices.length === 1 &&
        firstNotices[0]!.endpointId === endpointA.id &&
        firstNotices[0]!.eventId === firstNoticeId &&
        firstNotices[0]!.status === "succeeded" &&
        receiptsFor(partial, "a").some(
          (receipt) => receipt.eventId === firstNoticeId,
        ),
      `a terminal failure must notify the other endpoint once: ${JSON.stringify(
        firstNotices.map((d) => [d.endpointId, d.eventId, d.status]),
      )}`,
    );

    // A retry that fails for good again is a new failure event. Its
    // notification to endpoint A fails too, and a failed notification is
    // never itself announced (endpoint C would receive it).
    const createdC = await createWebhookEndpoint(db, {
      teamId,
      userId: main.userId,
      url: `http://127.0.0.1:${receiver.port}/c`,
      events: ["delivery.failed"],
    });
    if (createdC.error) {
      throw new Error("Unable to create endpoint c");
    }
    const endpointC = createdC.endpoint;
    failing.add(`a:${partial}:delivery.failed`);
    const failingRetry = await retryInvoiceDelivery(db, {
      invoiceId: partial,
      teamId,
      teamRole: "owner",
    });
    await waitSettled("the failing retry", [partial]);
    failing.delete(`a:${partial}:delivery.failed`);
    await disableWebhookEndpoint(db, { id: endpointC.id, teamId });
    const refailedState = await invoiceState(partial);
    const secondNoticeId = logicalEventId(failedB.id, "delivery.failed", 8);
    const secondNotices = noticesOf(refailedState, failedB.id).filter(
      (delivery) => delivery.eventId === secondNoticeId,
    );
    const failedNotice = secondNotices.find(
      (delivery) => delivery.endpointId === endpointA.id,
    );
    check(
      failingRetry?.webhooks.requeued === 1 &&
        deliveryFor(refailedState, endpointB.id)?.status === "failed" &&
        deliveryFor(refailedState, endpointB.id)?.attempts === 8 &&
        noticesOf(refailedState, failedB.id).length === 3 &&
        secondNotices.length === 2 &&
        failedNotice?.status === "failed" &&
        secondNotices.some(
          (delivery) =>
            delivery.endpointId === endpointC.id &&
            delivery.status === "succeeded",
        ) &&
        noticesOf(refailedState, failedNotice.id).length === 0,
      `a repeated failure must notify again without recursing: ${JSON.stringify(
        refailedState.deliveries.map((d) => [
          d.endpointId,
          d.event,
          d.eventId,
          d.status,
        ]),
      )}`,
    );

    // The supported recovery action re-drives only the failed destinations.
    failing.delete(`b:${partial}`);
    const partialRetry = await retryInvoiceDelivery(db, {
      invoiceId: partial,
      teamId,
      teamRole: "owner",
    });
    const stalledRetry = await retryInvoiceDelivery(db, {
      invoiceId: stalled,
      teamId,
      teamRole: "owner",
    });
    await waitSettled("the retried invoices", [partial, stalled]);
    for (const worker of concurrentWorkers) await worker.stop();
    const partialAfterRetry = await getInboxById(db, { id: partial, teamId });
    const stalledAfterRetry = await getInboxById(db, { id: stalled, teamId });
    const partialEvent = logicalEventId(partial, 1, "invoice.processed");
    check(
      partialRetry?.webhooks.requeued === 1 &&
        partialRetry.accounting === "already_posted" &&
        stalledRetry?.webhooks.requeued === 1 &&
        partialAfterRetry?.delivery.state === "delivered" &&
        stalledAfterRetry?.delivery.state === "delivered" &&
        receiptsFor(partial, "a").filter(
          (receipt) => receipt.eventId === partialEvent,
        ).length === 1,
      `retry must re-drive only the failed destination: ${JSON.stringify({
        partialRetry,
        stalledRetry,
        partial: partialAfterRetry?.delivery,
        stalled: stalledAfterRetry?.delivery,
      })}`,
    );
    boundaries.concurrentAndPartial = {
      concurrentCompletionWinners: 1,
      racedDeliveries: racedState.deliveries.length,
      lostJobRedriven: true,
      unrecordedFailureSurfaced: unrecordedAfter.lastError,
      secondDestinationFailed: {
        attempts: 4,
        retryable: true,
        dashboardState: partialSummary?.delivery.state,
      },
      failureNotifications: {
        first: firstNoticeId,
        afterFailingRetry: secondNoticeId,
        failedNotificationAnnounced: false,
      },
      retry: partialRetry,
      afterRetry: partialAfterRetry?.delivery.state,
    };

    // 6. Removed destinations and workspaces. Work queued before a webhook
    //    endpoint was disabled, the accounting connection disconnected or the
    //    invoice deleted is cancelled, not sent, and a retry never recreates
    //    or re-enables a removed destination.
    const disabledInvoice = await processingInvoice("disabled-destinations");
    const deletedInvoice = await processingInvoice("deleted-invoice");
    check(await complete(disabledInvoice), "disabled invoice must complete");
    check(await complete(deletedInvoice), "deleted invoice must complete");
    await disableWebhookEndpoint(db, { id: endpointB.id, teamId });
    await disconnectAccountingConnectionRecord(db, {
      teamId,
      provider: "xero",
    });
    await db
      .update(inbox)
      .set({ status: "deleted" })
      .where(eq(inbox.id, deletedInvoice));
    const afterRemoval = await processingInvoice("after-removal");
    const afterRemovalCompletion = await complete(afterRemoval);

    const other = await createTeam("Deleted workspace");
    otherTeamId = other.teamId;
    await createWebhookEndpoint(db, {
      teamId: otherTeamId,
      userId: other.userId,
      url: `http://127.0.0.1:${receiver.port}/a`,
      events: ["invoice.processed"],
    });
    const orphanInvoice = await processingInvoice(
      "deleted-workspace",
      otherTeamId,
    );
    check(
      await complete(orphanInvoice, otherTeamId),
      "the other workspace's invoice must complete",
    );
    await db.delete(teams).where(eq(teams.id, otherTeamId));
    const [orphanRows] = await rows<{ deliveries: number; jobs: number }>(
      sql`select
            (select count(*)::int from webhook_deliveries where team_id = ${otherTeamId}) as deliveries,
            (select count(*)::int from workflow_jobs where team_id = ${otherTeamId}) as jobs`,
    );

    const removalWorker = startWorker("removed-destinations");
    await waitSettled("removed destinations", [
      disabledInvoice,
      deletedInvoice,
      afterRemoval,
    ]);
    const disabledRetry = await retryInvoiceDelivery(db, {
      invoiceId: disabledInvoice,
      teamId,
      teamRole: "owner",
    });
    const deletedRetry = await retryInvoiceDelivery(db, {
      invoiceId: deletedInvoice,
      teamId,
      teamRole: "owner",
    });
    await waitFor("the team's queue to drain", async () => {
      const [pending] = await rows<{ count: number }>(
        sql`select count(*)::int as count from workflow_jobs
            where team_id = ${teamId} and status in ('queued', 'running')`,
      );
      return pending!.count === 0;
    });
    await removalWorker.stop();
    const disabledState = await invoiceState(disabledInvoice);
    const deletedState = await invoiceState(deletedInvoice);
    const afterRemovalState = await invoiceState(afterRemoval);
    const [endpointBNow] = await rows<{ active: boolean }>(
      sql`select active from webhook_endpoints where id = ${endpointB.id}`,
    );
    check(
      deliveryFor(disabledState, endpointA.id)?.status === "succeeded" &&
        deliveryFor(disabledState, endpointB.id)?.status === "cancelled" &&
        disabledState.accountingPostStatus === "cancelled" &&
        receiptsFor(disabledInvoice, "b").length === 0 &&
        !billRequests.has(disabledInvoice) &&
        deletedState.deliveries.every(
          (delivery) => delivery.status === "cancelled",
        ) &&
        deletedState.accountingPostStatus === "cancelled" &&
        receipts.every((receipt) => receipt.invoiceId !== deletedInvoice) &&
        disabledRetry?.webhooks.requeued === 0 &&
        disabledRetry.webhooks.skipped === 1 &&
        disabledRetry.accounting === "no_active_connection" &&
        deletedRetry === null &&
        endpointBNow?.active === false &&
        afterRemovalCompletion?.scheduled.webhooks === 1 &&
        afterRemovalCompletion.scheduled.accounting === false &&
        afterRemovalState.deliveries.length === 1 &&
        orphanRows?.deliveries === 0 &&
        orphanRows.jobs === 0 &&
        receipts.every((receipt) => receipt.invoiceId !== orphanInvoice),
      `removed destinations must be honoured: ${JSON.stringify({
        disabled: disabledState.deliveries.map((d) => [d.event, d.status]),
        disabledAccounting: disabledState.accountingPostStatus,
        deleted: deletedState.deliveries.map((d) => [d.event, d.status]),
        disabledRetry,
        deletedRetry,
        orphanRows,
      })}`,
    );
    boundaries.removedDestinations = {
      disabledEndpoint: deliveryFor(disabledState, endpointB.id)?.lastError,
      disconnectedAccounting: disabledState.accountingPostError,
      deletedInvoice: deletedState.deliveries[0]?.lastError,
      retryOfDisabled: disabledRetry,
      retryOfDeleted: deletedRetry,
      newRevisionAfterRemoval: afterRemovalCompletion?.scheduled,
      deletedWorkspaceRowsLeft: orphanRows,
    };

    // Reconciliation: every accepted invoice revision against what the
    // consumer received and the provider created.
    const accepted_ = await db
      .select({
        id: inbox.id,
        revision: inbox.processingRevision,
        status: inbox.status,
        extraction: inbox.extraction,
        accountingPostStatus: inbox.accountingPostStatus,
      })
      .from(inbox)
      .where(
        and(eq(inbox.teamId, teamId), sql`${inbox.processingRevision} > 0`),
      );
    const ledger = await db
      .select()
      .from(webhookDeliveries)
      .where(
        and(
          eq(webhookDeliveries.teamId, teamId),
          inArray(
            webhookDeliveries.invoiceId,
            accepted_.map((invoice) => invoice.id),
          ),
        ),
      );
    const report = accepted_.map((invoice) => {
      const deliveries = ledger.filter(
        (delivery) =>
          delivery.invoiceId === invoice.id &&
          delivery.event !== "delivery.failed",
      );
      const keys = deliveries.map((d) => `${d.endpointId}:${d.event}`);
      check(
        new Set(keys).size === keys.length,
        `invoice ${invoice.id} has a duplicate logical delivery`,
      );
      for (const delivery of deliveries) {
        check(
          delivery.revision === invoice.revision &&
            delivery.eventId ===
              logicalEventId(invoice.id, invoice.revision, delivery.event),
          `delivery ${delivery.id} does not carry its stable event id`,
        );
        check(
          delivery.status === "succeeded" || delivery.status === "cancelled",
          `delivery ${delivery.id} ended ${delivery.status}`,
        );
        const endpoint = delivery.endpointId === endpointA.id ? "a" : "b";
        const accepted = receipts.filter(
          (receipt) =>
            receipt.endpoint === endpoint &&
            receipt.eventId === delivery.eventId &&
            receipt.status < 300,
        );
        check(
          delivery.status === "succeeded"
            ? accepted.length >= 1
            : accepted.length === 0,
          `delivery ${delivery.id} (${delivery.status}) was received ${accepted.length} times`,
        );
      }
      const number = (invoice.extraction as { invoiceNumber?: string } | null)
        ?.invoiceNumber;
      const billCount = number ? (billKeys.get(number)?.size ?? 0) : 0;
      check(billCount <= 1, `invoice ${invoice.id} has ${billCount} bills`);
      check(
        invoice.accountingPostStatus !== "queued" &&
          invoice.accountingPostStatus !== "failed",
        `invoice ${invoice.id} accounting ended ${invoice.accountingPostStatus}`,
      );
      return {
        invoiceId: invoice.id,
        revision: invoice.revision,
        destinations: deliveries.map(
          (d) =>
            `${d.endpointId === endpointA.id ? "a" : "b"}:${d.event}:${d.status}`,
        ),
        accounting: invoice.accountingPostStatus,
        bills: billCount,
      };
    });
    const logicalReceipts = receipts.filter((receipt) => receipt.status < 300);
    const uniqueLogical = new Set(
      logicalReceipts.map(
        (receipt) => `${receipt.endpoint}:${receipt.eventId}`,
      ),
    );

    console.log(
      JSON.stringify({ boundaries, reconciliation: report }, null, 2),
    );
    console.log(
      JSON.stringify({
        event: "handoff_verification_succeeded",
        acceptedRevisions: report.length,
        webhookRequestsAccepted: logicalReceipts.length,
        distinctLogicalEvents: uniqueLogical.size,
        duplicateRedeliveriesDeduplicable:
          logicalReceipts.length - uniqueLogical.size,
        bills: bills.size,
        silentLosses: 0,
      }),
    );
  } finally {
    for (const worker of [...workers]) await worker.kill();
    // A failed check can leave a hold's transaction open; end it so the
    // pool can close and the failure is reported instead of hanging.
    for (const release of openHolds) release();
    await db.execute(sql.raw(FAULT_TEARDOWN)).catch(() => undefined);
    for (const path of filePaths) {
      await storage.remove({ bucket: "vault", path }).catch(() => undefined);
    }
    for (const id of [teamId, otherTeamId].filter(Boolean)) {
      await db.delete(teams).where(eq(teams.id, id));
    }
    for (const id of userIds) await db.delete(users).where(eq(users.id, id));
    receiver.stop(true);
    nango.stop(true);
    typeSafe.stop(true);
    await database.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
