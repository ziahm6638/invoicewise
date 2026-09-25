/**
 * Exception workflow proof (docs/delivery.md#corrections-reprocessing-and-retries):
 * failed extraction, invalid totals, an ambiguous provider timeout and a
 * correction after delivery, run through the real queue, worker batches and
 * Postgres against loopback Nango/Xero, TypeSafe and webhook stubs.
 * `bun run verify` runs it; it creates its own workspace and removes it.
 */
import { resolve } from "node:path";
import { createDatabaseClient } from "@invoicewise/db/client";
import {
  createInbox,
  createWebhookEndpoint,
  getInbox,
  getInboxById,
  getInvoiceAccountingStatus,
  listInvoiceCorrections,
} from "@invoicewise/db/queries";
import {
  accountingConnections,
  inbox,
  invoiceCorrections,
  teams,
  users,
  workflowJobs,
} from "@invoicewise/db/schema";
import { createStorageClientFromEnv } from "@invoicewise/db/storage";
import type { InvoiceExtraction } from "@invoicewise/documents";
import { and, eq, sql } from "drizzle-orm";
import { Effect, Logger } from "effect";
import { completeAccountingConnection } from "./accounting";
import { InvoiceActionError } from "./action-error";
import { releaseHeldDelivery, retryInvoiceDelivery } from "./delivery";
import {
  TEMPORARY_PROCESSING_FAILURE,
  TEMPORARY_RERUN_FAILURE,
  correctInvoice,
  reconcileInvoiceOperations,
  requestQuestionRerun,
} from "./exceptions";
import { acceptIntakeUpload, retryIntakeProcessing } from "./intake";
import { saveProcessedDocument } from "./process-document";
import { WorkflowRuntimeLive, runWorkflowBatch } from "./runner";
import {
  deliverPossibleDuplicates,
  required,
  startTypeSafeStub,
} from "./verify-support";

const runBatch = () =>
  Effect.runPromise(
    runWorkflowBatch.pipe(
      Effect.provide(WorkflowRuntimeLive),
      Effect.provide(Logger.json),
      Effect.scoped,
    ),
  );

/**
 * Runs batches (waiting out retry backoff) until none of this workspace's jobs
 * is queued or running. Other verifiers share the database, and recurring
 * work such as the retention schedule always has a next run queued.
 */
const drain = async (
  db: ReturnType<typeof createDatabaseClient>["db"],
  teamId: string,
) => {
  for (let round = 0; round < 60; round++) {
    await runBatch();
    const [pending] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(workflowJobs)
      .where(
        and(
          eq(workflowJobs.teamId, teamId),
          sql`${workflowJobs.status} in ('queued', 'running')`,
        ),
      );
    if (!pending?.count) return;
    await Bun.sleep(20);
  }
  throw new Error("Workflow queue did not drain");
};

const check = (label: string, ok: boolean, detail?: unknown) => {
  if (!ok) {
    throw new Error(
      `${label} did not hold${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`,
    );
  }
};

const refusal = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return null;
  } catch (error) {
    if (error instanceof InvoiceActionError) return error.code;
    throw error;
  }
};

async function main() {
  process.env.WORKFLOW_RETRY_BASE_MS = "10";
  process.env.WORKFLOW_RETRY_MAX_MS = "10";
  // Loopback webhook endpoints are accepted outside production only.
  process.env.NODE_ENV = "test";
  process.env.NANGO_SECRET_KEY = "nango-exceptions-verification";
  process.env.NANGO_XERO_INTEGRATION_ID = "xero-invoicewise";
  process.env.TYPESAFE_API_KEY = "verification-key";

  const database = createDatabaseClient({
    primaryUrl: required("DATABASE_PRIMARY_URL"),
    isDevelopment: true,
  });
  const db = database.db;
  const storage = createStorageClientFromEnv();

  // TypeSafe: a correct model, or one that refuses every call.
  const typeSafe = startTypeSafeStub();
  const refusingTypeSafe = Bun.serve({
    port: 0,
    fetch: () => new Response("unauthorized", { status: 401 }),
  });
  const typeSafeUp = (up: boolean) => {
    process.env.TYPESAFE_BASE_URL = `http://127.0.0.1:${
      up ? typeSafe.port : refusingTypeSafe.port
    }`;
  };

  // Webhook consumer.
  const received: { event: string; body: Record<string, unknown> }[] = [];
  const receiver = Bun.serve({
    port: 0,
    async fetch(request) {
      received.push({
        event: request.headers.get("invoicewise-event") ?? "",
        body: (await request.json()) as Record<string, unknown>,
      });
      return new Response("ok");
    },
  });

  // The Xero organisation behind Nango: bills by idempotency key, each
  // bill's latest content, and switches that make the provider apply a
  // write and then time out (an ambiguous outcome).
  let workspaceId = "";
  const billsByKey = new Map<string, string>();
  const bills = new Map<string, Record<string, unknown>>();
  const providerCalls: { kind: "create" | "update"; number: string }[] = [];
  const timeOutAfterCreate = new Set<string>();
  let timeOutAfterUpdate = false;
  const nango = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (
        request.headers.get("authorization") !==
        `Bearer ${process.env.NANGO_SECRET_KEY}`
      ) {
        return Response.json(
          { error: { message: "Unauthorized" } },
          {
            status: 401,
          },
        );
      }
      if (request.method === "GET" && url.pathname === "/connections") {
        return Response.json({
          connections: [
            {
              connection_id: "xero-connection",
              provider_config_key: "xero-invoicewise",
              tags: { workspace_id: workspaceId },
            },
          ],
        });
      }
      if (url.pathname === "/connection/xero-connection") {
        return Response.json({
          connection_id: "xero-connection",
          provider_config_key: "xero-invoicewise",
          connection_config: { tenant_id: "xero-tenant" },
          credentials: {},
        });
      }
      if (
        request.method === "POST" &&
        url.pathname === "/proxy/api.xro/2.0/Invoices"
      ) {
        const [bill] = (
          (await request.json()) as {
            Invoices: Record<string, unknown>[];
          }
        ).Invoices;
        const key = request.headers.get("nango-proxy-idempotency-key") ?? "";
        const number = String(bill?.InvoiceNumber);
        providerCalls.push({ kind: "create", number });
        let id = billsByKey.get(key);
        if (!id) {
          id = `xero-bill-${bills.size + 1}`;
          billsByKey.set(key, id);
          bills.set(id, bill ?? {});
        }
        if (timeOutAfterCreate.has(number)) {
          return Response.json(
            { error: { message: "Gateway timeout" } },
            {
              status: 504,
            },
          );
        }
        return Response.json({ Invoices: [{ InvoiceID: id }] });
      }
      const update = url.pathname.match(
        /^\/proxy\/api\.xro\/2\.0\/Invoices\/([^/]+)$/,
      );
      if (request.method === "POST" && update) {
        const id = decodeURIComponent(update[1]!);
        const [bill] = (
          (await request.json()) as {
            Invoices: Record<string, unknown>[];
          }
        ).Invoices;
        providerCalls.push({
          kind: "update",
          number: String(bill?.InvoiceNumber),
        });
        if (!bills.has(id) || bill?.InvoiceID !== id) {
          return Response.json(
            { Message: "A validation exception occurred" },
            {
              status: 400,
            },
          );
        }
        bills.set(id, { ...bills.get(id), ...bill });
        if (timeOutAfterUpdate) {
          return Response.json(
            { error: { message: "Gateway timeout" } },
            {
              status: 504,
            },
          );
        }
        return Response.json({ Invoices: [{ InvoiceID: id }] });
      }
      if (url.pathname.includes("/Attachments/")) {
        return Response.json({ Attachments: [{}] });
      }
      return new Response("Not found", { status: 404 });
    },
  });
  process.env.NANGO_BASE_URL = `http://127.0.0.1:${nango.port}`;

  let teamId: string | undefined;
  const userIds: string[] = [];
  const paths: string[][] = [];
  try {
    const [team] = await db
      .insert(teams)
      .values({ name: "Exceptions verification" })
      .returning({ id: teams.id });
    if (!team) throw new Error("Unable to create verification team");
    const workspace = team.id;
    teamId = workspace;
    workspaceId = workspace;
    const person = async (fullName: string) => {
      const [user] = await db
        .insert(users)
        .values({
          fullName,
          email: `${crypto.randomUUID()}@example.test`,
          teamId,
        })
        .returning({ id: users.id });
      if (!user) throw new Error("Unable to create verification user");
      userIds.push(user.id);
      return user.id;
    };
    const admin = {
      actorId: await person("Ada Admin"),
      teamRole: "admin" as const,
    };
    // Its invoices share a date and total; the delivery rules have their own
    // proof (verify-delivery-rules).
    await deliverPossibleDuplicates(db, workspace);
    const member = {
      actorId: await person("Max Member"),
      teamRole: "member" as const,
    };
    await createWebhookEndpoint(db, {
      teamId,
      userId: admin.actorId,
      url: `http://127.0.0.1:${receiver.port}/invoices`,
      events: ["invoice.processed", "invoice.judgments.attached"],
    });
    await completeAccountingConnection(db, {
      teamId,
      provider: "xero",
      connectionId: "xero-connection",
    });

    const extractionOf = (
      invoiceNumber: string,
      grossAmount = 120,
    ): InvoiceExtraction => ({
      documentType: "invoice",
      supplierName: "Acme Supplies Ltd",
      supplierAddress: null,
      supplierVatNumber: "GB123456782",
      supplierCompanyNumber: null,
      invoiceNumber,
      originalInvoiceNumber: null,
      invoiceDate: "2026-09-01",
      dueDate: "2026-09-30",
      currency: "GBP",
      netAmount: 100,
      discountAmount: null,
      vatAmount: 20,
      taxRate: 20,
      grossAmount,
      amountsIncludeTax: false,
      lineItems: [
        { description: "Materials", quantity: 1, unitPrice: 100, total: 100 },
      ] as InvoiceExtraction["lineItems"],
      bankDetails: {
        accountName: null,
        accountNumber: null,
        sortCode: null,
        iban: null,
        bic: null,
      },
      description: null,
      purchaseOrderReference: null,
      paymentReference: null,
      textSource: "text-layer",
      pageSources: ["text-layer"],
      evidence: { fields: {}, lineItems: [] },
    });
    // A document read as the processing job would save it: validated, with
    // its deliveries (webhook and accounting post) scheduled in one commit.
    const processed = async (
      invoiceNumber: string,
      grossAmount?: number,
      file: Uint8Array = Buffer.from(
        "%PDF-1.4\n% InvoiceWise exceptions proof\n",
      ),
    ) => {
      const path = [teamId!, "inbox", `${crypto.randomUUID()}.pdf`];
      paths.push(path);
      await storage.upload({
        bucket: "vault",
        path,
        file: Buffer.from(file),
        contentType: "application/pdf",
      });
      const created = await createInbox(db, {
        teamId: teamId!,
        displayName: "Acme Supplies Ltd",
        filePath: path,
        fileName: `${invoiceNumber}.pdf`,
        contentType: "application/pdf",
        size: file.byteLength,
        status: "processing",
      });
      if (!created) throw new Error("Unable to create verification invoice");
      await saveProcessedDocument(db, {
        id: created.id,
        teamId: teamId!,
        displayName: "Acme Supplies Ltd",
        type: "invoice",
        extraction: extractionOf(invoiceNumber, grossAmount),
        judgments: [],
      });
      return created.id;
    };
    const read = async (id: string) => {
      const row = await getInboxById(db, { id, teamId: teamId! });
      if (!row) throw new Error(`Invoice ${id} is not readable`);
      return row;
    };
    const accounting = (id: string) =>
      getInvoiceAccountingStatus(db, { invoiceId: id, teamId: teamId! });
    const listed = async (state: Parameters<typeof getInbox>[1]["state"]) =>
      (await getInbox(db, { teamId: teamId!, state, pageSize: 100 })).data.map(
        (row) => row.id,
      );
    const jobsFor = async (name: string, invoiceId: string) =>
      (
        await db
          .select({ id: workflowJobs.id, status: workflowJobs.status })
          .from(workflowJobs)
          .where(
            and(
              eq(workflowJobs.name, name),
              sql`(${workflowJobs.payload} ->> 'inboxId' = ${invoiceId} or ${workflowJobs.payload} ->> 'invoiceId' = ${invoiceId})`,
            ),
          )
      ).map((job) => job.status);

    // --- 1. Failed extraction, then re-extraction ----------------------------------
    typeSafeUp(false);
    const bytes = new Uint8Array(
      await Bun.file(
        resolve(
          process.cwd(),
          "../documents/src/test/fixtures/synthetic-invoice.pdf",
        ),
      ).arrayBuffer(),
    );
    const upload = await acceptIntakeUpload(db, storage, {
      teamId,
      bytes,
      declaredMimeType: "application/pdf",
      fileName: "synthetic-invoice.pdf",
    });
    if (upload.status !== "accepted") throw new Error(upload.message);
    const scanned = upload.inboxId;
    await drain(db, workspace);
    const failedRead = await read(scanned);
    check(
      "a failed extraction is recorded with its reason and listed as failed",
      failedRead.processingError === TEMPORARY_PROCESSING_FAILURE &&
        failedRead.extraction === null &&
        (await listed("failed")).includes(scanned) &&
        (await listed("needs_attention")).includes(scanned),
      failedRead,
    );
    typeSafeUp(true);
    // Three clicks at once on the revision shown: one processing job.
    const clicks = await Promise.all(
      [0, 1, 2].map(() =>
        retryIntakeProcessing(database.primaryDb, {
          teamId: workspace,
          inboxId: scanned,
          expectedRevision: failedRead.processingRevision,
        }),
      ),
    );
    const retryJobs = (await jobsFor("process-attachment", scanned)).filter(
      (status) => status === "queued",
    );
    check(
      "concurrent re-extract clicks queue one job",
      new Set(clicks.map((click) => click?.jobId)).size === 1 &&
        retryJobs.length === 1,
      { clicks, retryJobs },
    );
    await drain(db, workspace);
    const reextracted = await read(scanned);
    check(
      "the re-extraction completes as a new revision",
      reextracted.processingError === null &&
        reextracted.extraction !== null &&
        reextracted.processingRevision === failedRead.processingRevision + 1,
      reextracted,
    );
    check(
      "a re-extraction of a revision that has moved on is refused",
      (await refusal(
        retryIntakeProcessing(database.primaryDb, {
          teamId: workspace,
          inboxId: scanned,
          expectedRevision: failedRead.processingRevision,
        }),
      )) === "conflict",
    );

    // Reading a processed invoice again and failing keeps the saved reading.
    typeSafeUp(false);
    await retryIntakeProcessing(database.primaryDb, {
      teamId,
      inboxId: scanned,
      expectedRevision: reextracted.processingRevision,
    });
    await drain(db, workspace);
    const failedReread = await read(scanned);
    typeSafeUp(true);
    check(
      "a failed re-extraction keeps the previous reading and records the reason",
      failedReread.processingError === TEMPORARY_PROCESSING_FAILURE &&
        failedReread.status === "pending" &&
        failedReread.processingRevision === reextracted.processingRevision &&
        JSON.stringify(failedReread.extraction) ===
          JSON.stringify(reextracted.extraction) &&
        JSON.stringify(failedReread.validation) ===
          JSON.stringify(reextracted.validation) &&
        JSON.stringify(failedReread.judgments) ===
          JSON.stringify(reextracted.judgments),
      failedReread,
    );

    // A worker that died after its final attempt without recording the
    // failure: the document would read as processing for ever.
    await db
      .update(inbox)
      .set({ status: "processing" })
      .where(eq(inbox.id, scanned));
    await db
      .update(workflowJobs)
      .set({
        status: "failed",
        lastError: "Workflow lease expired after its final attempt",
      })
      .where(
        and(
          eq(workflowJobs.name, "process-attachment"),
          sql`${workflowJobs.payload} ->> 'inboxId' = ${scanned}`,
        ),
      );
    const stalled = await read(scanned);
    const settled = await reconcileInvoiceOperations(db, { teamId });
    const afterStall = await read(scanned);
    check(
      "a stalled processing job becomes a visible, retryable failure",
      stalled.processingStalled === true &&
        settled.failed === 1 &&
        afterStall.status === "pending" &&
        afterStall.processingError === TEMPORARY_PROCESSING_FAILURE,
      { stalled: stalled.processingStalled, settled, afterStall },
    );
    await retryIntakeProcessing(database.primaryDb, {
      teamId,
      inboxId: scanned,
      expectedRevision: afterStall.processingRevision,
    });
    await drain(db, workspace);
    const recovered = await read(scanned);
    check(
      "the stalled document is read again",
      recovered.extraction !== null && recovered.processingError === null,
    );

    // --- 2. Question rerun: one transition, durable failure, retry ---------------
    const reruns = await Promise.all(
      [0, 1, 2].map(() =>
        requestQuestionRerun(db, {
          invoiceId: scanned,
          teamId: teamId!,
          expectedRevision: recovered.processingRevision,
        }),
      ),
    );
    check(
      "concurrent question reruns share one job",
      reruns.filter((rerun) => !rerun.deduplicated).length === 1 &&
        (await jobsFor("rerun-judgments", scanned)).length === 1,
      reruns,
    );
    typeSafeUp(false);
    await drain(db, workspace);
    const rerunFailed = await read(scanned);
    check(
      "a failed question rerun is recorded and does not change the revision",
      rerunFailed.judgmentsRerunStatus === "failed" &&
        rerunFailed.judgmentsRerunError === TEMPORARY_RERUN_FAILURE &&
        rerunFailed.processingRevision === recovered.processingRevision,
      rerunFailed,
    );
    // The same rerun requested again restarts its job; a worker then dies
    // on its final attempt and the reconciler makes that visible too.
    await requestQuestionRerun(db, {
      invoiceId: scanned,
      teamId: teamId!,
      expectedRevision: recovered.processingRevision,
    });
    await db
      .update(workflowJobs)
      .set({
        status: "running",
        attempts: sql`${workflowJobs.maxAttempts}`,
        leaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
      })
      .where(
        and(
          eq(workflowJobs.name, "rerun-judgments"),
          sql`${workflowJobs.payload} ->> 'invoiceId' = ${scanned}`,
        ),
      );
    await runBatch();
    await reconcileInvoiceOperations(db, { teamId });
    const leaseLost = await read(scanned);
    check(
      "a rerun whose worker died on its last attempt becomes retryable",
      leaseLost.judgmentsRerunStatus === "failed",
      leaseLost,
    );
    typeSafeUp(true);
    const webhooksBeforeRerun = received.length;
    await requestQuestionRerun(db, {
      invoiceId: scanned,
      teamId: teamId!,
      expectedRevision: recovered.processingRevision,
    });
    await drain(db, workspace);
    const rerun = await read(scanned);
    const rerunEvents = received
      .slice(webhooksBeforeRerun)
      .map((delivery) => [delivery.event, delivery.body.revision]);
    check(
      "a rerun commits new answers as the next revision and notifies webhooks",
      rerun.judgmentsRerunStatus === null &&
        rerun.processingRevision === recovered.processingRevision + 1 &&
        (rerun.judgments?.length ?? 0) > 0 &&
        rerunEvents.some(
          ([event, revision]) =>
            event === "invoice.judgments.attached" &&
            revision === rerun.processingRevision,
        ),
      { rerun, rerunEvents },
    );
    check(
      "a rerun of a revision that has moved on is refused",
      (await refusal(
        requestQuestionRerun(db, {
          invoiceId: scanned,
          teamId: teamId!,
          expectedRevision: recovered.processingRevision,
        }),
      )) === "conflict",
    );

    // --- 3. Invalid totals, corrected, then posted once ---------------------------
    const invalid = await processed("EXC-TOTAL", 150);
    await drain(db, workspace);
    const blocked = await accounting(invalid);
    const invalidRead = await read(invalid);
    const invalidDecision = invalidRead.deliveryDecision as {
      outcome?: string;
      accounting?: string;
      reasons?: { code?: string; locked?: boolean }[];
    } | null;
    check(
      "an invoice whose totals do not reconcile is held by the delivery rules, not sent",
      invalidRead.validation?.status === "invalid" &&
        invalidDecision?.outcome === "hold" &&
        invalidDecision.accounting === "held" &&
        invalidDecision.reasons?.some(
          (reason) => reason.code === "invalid_financials" && reason.locked,
        ) === true &&
        (blocked?.status ?? null) === null &&
        !providerCalls.some((call) => call.number === "EXC-TOTAL") &&
        !received.some((delivery) => delivery.body.invoiceId === invalid) &&
        (await listed("invalid")).includes(invalid) &&
        (await listed("held")).includes(invalid) &&
        (await listed("needs_attention")).includes(invalid) &&
        (await getInbox(db, { teamId, q: "EXC-TOTAL" })).data.some(
          (row) => row.id === invalid,
        ),
      { invalidRead: invalidRead.validation, blocked },
    );
    const base = {
      invoiceId: invalid,
      teamId,
      expectedRevision: invalidRead.processingRevision,
    };
    check(
      "a value that does not fit the canonical record is refused",
      (await refusal(
        correctInvoice(db, {
          ...base,
          ...admin,
          reason: "Wrong date",
          changes: { invoiceDate: "2026-02-30" },
        }),
      )) === "invalid",
    );
    // Two users correct the same revision at once: one correction wins.
    const outcomes = await Promise.allSettled([
      correctInvoice(db, {
        ...base,
        ...admin,
        reason: "Gross was read from the balance-due line",
        changes: { grossAmount: 120 },
      }),
      correctInvoice(db, {
        ...base,
        ...admin,
        reason: "Gross total fixed in another tab",
        changes: { grossAmount: 120 },
      }),
    ]);
    const won = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const lost = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult =>
        outcome.status === "rejected",
    );
    check(
      "concurrent corrections of one revision produce one correction",
      won.length === 1 &&
        lost.length === 1 &&
        lost[0]?.reason instanceof InvoiceActionError &&
        lost[0].reason.code === "conflict",
      outcomes.map((outcome) => outcome.status),
    );
    const corrected = (
      won[0] as PromiseFulfilledResult<
        Awaited<ReturnType<typeof correctInvoice>>
      >
    ).value;
    const [original] = await db
      .select({ original: inbox.extractionOriginal })
      .from(inbox)
      .where(eq(inbox.id, invalid));
    const history = await listInvoiceCorrections(db, {
      invoiceId: invalid,
      teamId,
    });
    check(
      "the correction validates, keeps the original reading and its audit trail, and re-queues the post",
      corrected.validationStatus === "valid" &&
        corrected.accounting === "post_queued" &&
        (original?.original as { grossAmount?: number })?.grossAmount === 150 &&
        history.length === 1 &&
        history[0]?.actor?.id === admin.actorId &&
        history[0].version === 1 &&
        history[0].reason.length > 0 &&
        Bun.deepEquals(history[0].changes, [
          { field: "grossAmount", from: 150, to: 120 },
        ]),
      { corrected, history },
    );
    await drain(db, workspace);
    const postedAfterCorrection = await accounting(invalid);
    check(
      "the corrected invoice is posted once",
      postedAfterCorrection?.status === "posted" &&
        providerCalls.filter((call) => call.number === "EXC-TOTAL").length ===
          1 &&
        received.some(
          (delivery) =>
            delivery.body.invoiceId === invalid &&
            (delivery.body.data as { correction?: { version?: number } })
              ?.correction?.version === 1,
        ),
      postedAfterCorrection,
    );

    // A member's correction of a held invoice waits for an admin's release:
    // neither the correction, a retry nor a question rerun sends it.
    // A readable document, so its questions can be answered again.
    const memberCase = await processed("EXC-MEMBER", 150, bytes);
    await drain(db, workspace);
    const memberCorrection = await correctInvoice(db, {
      invoiceId: memberCase,
      teamId,
      expectedRevision: (await read(memberCase)).processingRevision,
      ...member,
      reason: "Gross fixed",
      changes: { grossAmount: 120 },
    });
    const memberRetry = await retryInvoiceDelivery(db, {
      invoiceId: memberCase,
      teamId,
      teamRole: "member",
    });
    await requestQuestionRerun(db, {
      invoiceId: memberCase,
      teamId,
      expectedRevision: memberCorrection.revision,
    });
    await drain(db, workspace);
    const heldAfterCorrection = await read(memberCase);
    const release = {
      invoiceId: memberCase,
      teamId,
      expectedRevision: heldAfterCorrection.processingRevision,
      reason: "Checked the corrected gross against the PDF",
    };
    const memberRelease = await refusal(
      releaseHeldDelivery(db, { ...release, ...member }),
    );
    const adminRelease = await releaseHeldDelivery(db, {
      ...release,
      ...admin,
    });
    await drain(db, workspace);
    check(
      "a member's correction of a held invoice needs an admin's release, even after a question rerun, then posts once",
      memberCorrection.accounting === "held" &&
        memberRetry?.accounting === "held" &&
        memberRelease === "forbidden" &&
        heldAfterCorrection.processingRevision ===
          memberCorrection.revision + 1 &&
        heldAfterCorrection.delivery?.state === "held" &&
        (
          heldAfterCorrection.deliveryDecision as {
            reasons?: { code?: string }[];
          }
        )?.reasons?.some((reason) => reason.code === "awaiting_approval") ===
          true &&
        adminRelease.accounting === "queued" &&
        (await accounting(memberCase))?.status === "posted" &&
        providerCalls.filter((call) => call.number === "EXC-MEMBER").length ===
          1,
      {
        memberCorrection,
        memberRetry,
        memberRelease,
        adminRelease,
        heldAfterCorrection: heldAfterCorrection.deliveryDecision,
      },
    );

    // A correction is a new revision: it is matched to authorization sources
    // again, beside the processed revision's own match.
    const matchJobs = await jobsFor("match-invoice", memberCase);
    check(
      "a correction queues matching to authorization sources for its revision",
      matchJobs.length === 2 &&
        matchJobs.every((status) => status === "succeeded"),
      matchJobs,
    );

    // --- 4. Ambiguous provider timeout --------------------------------------------
    timeOutAfterCreate.add("EXC-TIMEOUT");
    const ambiguous = await processed("EXC-TIMEOUT");
    await drain(db, workspace);
    const timedOut = await accounting(ambiguous);
    const timedOutRead = await read(ambiguous);
    check(
      "a post that timed out after the provider created the bill is a retryable failure, not delivered",
      timedOut?.status === "failed" &&
        timedOut.retryable === true &&
        timedOutRead.delivery?.state === "failed" &&
        (await listed("delivery_failed")).includes(ambiguous),
      { timedOut, delivery: timedOutRead.delivery },
    );
    check(
      "an invoice whose bill may already exist cannot be corrected before the post settles",
      (await refusal(
        correctInvoice(db, {
          invoiceId: ambiguous,
          teamId,
          expectedRevision: timedOutRead.processingRevision,
          ...admin,
          reason: "Due date agreed",
          changes: { dueDate: "2026-10-15" },
        }),
      )) === "conflict",
    );
    timeOutAfterCreate.delete("EXC-TIMEOUT");
    await retryInvoiceDelivery(db, {
      invoiceId: ambiguous,
      teamId,
      teamRole: "admin",
    });
    await drain(db, workspace);
    const settledPost = await accounting(ambiguous);
    const timeoutBills = [...bills.entries()].filter(
      ([, bill]) => bill.InvoiceNumber === "EXC-TIMEOUT",
    );
    check(
      "the retry replays the same bill: one bill, the provider's original ID",
      settledPost?.status === "posted" &&
        timeoutBills.length === 1 &&
        settledPost.providerId === timeoutBills[0]?.[0] &&
        providerCalls.filter((call) => call.number === "EXC-TIMEOUT").length >
          1,
      { settledPost, timeoutBills: timeoutBills.length },
    );

    // --- 5. Corrected after delivery ---------------------------------------------
    const delivered = await read(invalid);
    const providerId = postedAfterCorrection?.providerId;
    const billsBefore = bills.size;
    const after = {
      invoiceId: invalid,
      teamId,
      expectedRevision: delivered.processingRevision,
    };
    const noOutcome = await refusal(
      correctInvoice(db, {
        ...after,
        ...admin,
        reason: "PO added",
        changes: { purchaseOrderReference: "PO-9" },
      }),
    );
    const memberUpdate = await refusal(
      correctInvoice(db, {
        ...after,
        ...member,
        reason: "PO added",
        changes: { purchaseOrderReference: "PO-9" },
        accountingOutcome: "update_bill",
      }),
    );
    const takenNumber = await refusal(
      correctInvoice(db, {
        ...after,
        ...admin,
        reason: "Number",
        changes: { invoiceNumber: "EXC-MEMBER" },
        accountingOutcome: "update_bill",
      }),
    );
    check(
      "a delivered invoice needs an explicit, permitted bill outcome and cannot take another bill's number",
      noOutcome === "invalid" &&
        memberUpdate === "forbidden" &&
        takenNumber === "conflict",
      { noOutcome, memberUpdate, takenNumber },
    );
    const callsBeforeKeep = providerCalls.length;
    const kept = await correctInvoice(db, {
      ...after,
      ...member,
      reason: "PO was on the covering email",
      changes: { purchaseOrderReference: "PO-9" },
      accountingOutcome: "keep_bill",
    });
    await drain(db, workspace);
    check(
      "keeping the bill changes only InvoiceWise's record",
      kept.accounting === "bill_kept" &&
        providerCalls.length === callsBeforeKeep &&
        (await accounting(invalid))?.providerId === providerId &&
        bills.size === billsBefore,
      kept,
    );
    // Update the same bill; the provider applies it and then times out, so
    // the update is failed, retryable, and never reads as delivered.
    timeOutAfterUpdate = true;
    const updateRequest = await correctInvoice(db, {
      invoiceId: invalid,
      teamId,
      expectedRevision: (await read(invalid)).processingRevision,
      ...admin,
      reason: "Due date agreed with the supplier",
      changes: { dueDate: "2026-10-15" },
      accountingOutcome: "update_bill",
    });
    const whileQueued = await read(invalid);
    check(
      "a queued bill update reads as delivering, never delivered",
      updateRequest.accounting === "bill_update_queued" &&
        whileQueued.delivery?.state === "pending" &&
        (await listed("delivering")).includes(invalid),
      whileQueued.delivery,
    );
    check(
      "a second correction waits for the bill update to settle",
      (await refusal(
        correctInvoice(db, {
          invoiceId: invalid,
          teamId,
          expectedRevision: whileQueued.processingRevision,
          ...admin,
          reason: "Another change",
          changes: { paymentReference: "REF-1" },
          accountingOutcome: "keep_bill",
        }),
      )) === "conflict",
    );
    await drain(db, workspace);
    const updateFailed = await read(invalid);
    const memberRedo = await retryInvoiceDelivery(db, {
      invoiceId: invalid,
      teamId,
      teamRole: "member",
    });
    check(
      "a bill update that timed out is a retryable delivery failure; re-sending it needs an admin",
      updateFailed.delivery?.state === "failed" &&
        memberRedo?.billUpdate === "admin_required",
      { delivery: updateFailed.delivery, memberRedo },
    );
    timeOutAfterUpdate = false;
    const adminRedo = await retryInvoiceDelivery(db, {
      invoiceId: invalid,
      teamId,
      teamRole: "admin",
    });
    await drain(db, workspace);
    const final = await read(invalid);
    const finalHistory = await listInvoiceCorrections(db, {
      invoiceId: invalid,
      teamId,
    });
    const bill = bills.get(providerId ?? "");
    check(
      "the retried update lands on the same bill: no second bill, provider ID kept, history complete",
      adminRedo?.billUpdate === "requeued" &&
        final.delivery?.state === "delivered" &&
        final.accountingProviderId === providerId &&
        bills.size === billsBefore &&
        bill?.DueDate === "2026-10-15" &&
        providerCalls.filter(
          (call) => call.kind === "create" && call.number === "EXC-TOTAL",
        ).length === 1 &&
        finalHistory.map((entry) => [
          entry.version,
          entry.accountingOutcome,
          entry.updateStatus,
          entry.providerId,
        ]).length === 3 &&
        Bun.deepEquals(
          finalHistory.map((entry) => [
            entry.version,
            entry.accountingOutcome,
            entry.updateStatus,
            entry.providerId,
          ]),
          [
            [3, "update_bill", "updated", providerId],
            [2, "keep_bill", null, providerId],
            [1, "not_posted", null, null],
          ],
        ),
      { final: final.delivery, finalHistory, bill },
    );

    // A later correction decides the bill: it supersedes an earlier update
    // that failed, and a question rerun queued for the previous revision.
    timeOutAfterUpdate = true;
    await correctInvoice(db, {
      invoiceId: invalid,
      teamId,
      expectedRevision: final.processingRevision,
      ...admin,
      reason: "Payment reference added",
      changes: { paymentReference: "REF-2" },
      accountingOutcome: "update_bill",
    });
    await drain(db, workspace);
    timeOutAfterUpdate = false;
    const failedUpdate = await read(invalid);
    await requestQuestionRerun(db, {
      invoiceId: invalid,
      teamId,
      expectedRevision: failedUpdate.processingRevision,
    });
    await correctInvoice(db, {
      invoiceId: invalid,
      teamId,
      expectedRevision: failedUpdate.processingRevision,
      ...member,
      reason: "Reference belongs on the remittance, not the bill",
      changes: { paymentReference: "REF-3" },
      accountingOutcome: "keep_bill",
    });
    const rerunSuperseded = await read(invalid);
    const callsBeforeStaleRetry = providerCalls.length;
    const staleRetry = await retryInvoiceDelivery(db, {
      invoiceId: invalid,
      teamId,
      teamRole: "admin",
    });
    await drain(db, workspace);
    const superseded = await read(invalid);
    check(
      "a later correction supersedes a failed bill update and a queued question rerun",
      failedUpdate.delivery?.state === "failed" &&
        rerunSuperseded.judgmentsRerunStatus === null &&
        staleRetry?.billUpdate === "not_needed" &&
        providerCalls.length === callsBeforeStaleRetry &&
        superseded.delivery?.state === "delivered" &&
        superseded.judgmentsRerunStatus === null &&
        (await listed("delivered")).includes(invalid) &&
        !(await listed("delivery_failed")).includes(invalid),
      {
        failedUpdate: failedUpdate.delivery,
        rerun: rerunSuperseded.judgmentsRerunStatus,
        staleRetry,
        superseded: superseded.delivery,
      },
    );

    // A bill update cancelled because the connection went away is unfinished
    // work, never delivered; with no connection an update cannot be asked for.
    const connected = (disconnectedAt: string | null) =>
      db
        .update(accountingConnections)
        .set({ disconnectedAt })
        .where(eq(accountingConnections.teamId, teamId!));
    await correctInvoice(db, {
      invoiceId: invalid,
      teamId,
      expectedRevision: superseded.processingRevision,
      ...admin,
      reason: "Due date moved again",
      changes: { dueDate: "2026-10-22" },
      accountingOutcome: "update_bill",
    });
    await connected(new Date().toISOString());
    await drain(db, workspace);
    const cancelledUpdate = await read(invalid);
    const [cancelledEntry] = await listInvoiceCorrections(db, {
      invoiceId: invalid,
      teamId,
    });
    const disconnectedUpdate = await refusal(
      correctInvoice(db, {
        invoiceId: invalid,
        teamId,
        expectedRevision: cancelledUpdate.processingRevision,
        ...admin,
        reason: "Due date moved again",
        changes: { dueDate: "2026-10-29" },
        accountingOutcome: "update_bill",
      }),
    );
    await connected(null);
    check(
      "a cancelled bill update reads as a delivery failure, and no update is queued without a connection",
      cancelledEntry?.updateStatus === "cancelled" &&
        cancelledUpdate.delivery?.state === "failed" &&
        (await listed("delivery_failed")).includes(invalid) &&
        !(await listed("delivered")).includes(invalid) &&
        disconnectedUpdate === "conflict",
      {
        update: cancelledEntry?.updateStatus,
        delivery: cancelledUpdate.delivery,
        disconnectedUpdate,
      },
    );

    // A re-extraction starts a new reading once it is saved: until then a
    // retry never re-sends the correction's bill update, and a re-read that
    // fails replaces nothing, so the update stays a retryable failure.
    await retryIntakeProcessing(database.primaryDb, {
      teamId,
      inboxId: invalid,
      expectedRevision: cancelledUpdate.processingRevision,
    });
    const [requestedEntry] = await listInvoiceCorrections(db, {
      invoiceId: invalid,
      teamId,
    });
    const retryWhileReading = await retryInvoiceDelivery(db, {
      invoiceId: invalid,
      teamId,
      teamRole: "admin",
    });
    const billJobsWhileReading = await jobsFor(
      "update-accounting-bill",
      invalid,
    );
    check(
      "a retry while the document is read again never re-sends the replaced correction's bill update",
      requestedEntry?.id === cancelledEntry?.id &&
        requestedEntry?.updateStatus === "cancelled" &&
        retryWhileReading?.billUpdate === "not_needed" &&
        !billJobsWhileReading.some(
          (status) => status === "queued" || status === "running",
        ),
      {
        update: requestedEntry?.updateStatus,
        retryWhileReading,
        billJobsWhileReading,
      },
    );
    await drain(db, workspace);
    const billRereadFailed = await read(invalid);
    const [keptEntry] = await listInvoiceCorrections(db, {
      invoiceId: invalid,
      teamId,
    });
    const retryAfterFailedReread = await retryInvoiceDelivery(db, {
      invoiceId: invalid,
      teamId,
      teamRole: "member",
    });
    check(
      "a re-read that fails leaves the correction's bill update a retryable delivery failure",
      billRereadFailed.processingError !== null &&
        billRereadFailed.processingRevision ===
          cancelledUpdate.processingRevision &&
        keptEntry?.id === cancelledEntry?.id &&
        keptEntry?.updateStatus === "cancelled" &&
        billRereadFailed.delivery?.state === "failed" &&
        (await listed("needs_attention")).includes(invalid) &&
        retryAfterFailedReread?.billUpdate === "admin_required",
      {
        processingError: billRereadFailed.processingError,
        update: keptEntry?.updateStatus,
        delivery: billRereadFailed.delivery,
        retryAfterFailedReread,
      },
    );

    // A re-read that is saved supersedes the unsent update: it stops deciding
    // the delivery state and is never sent, and the bill keeps its provider ID.
    await retryIntakeProcessing(database.primaryDb, {
      teamId,
      inboxId: invalid,
      expectedRevision: billRereadFailed.processingRevision,
    });
    await saveProcessedDocument(db, {
      id: invalid,
      teamId,
      displayName: "Acme Supplies Ltd",
      type: "invoice",
      extraction: extractionOf("EXC-TOTAL", 150),
      judgments: [],
    });
    await drain(db, workspace);
    const readAgain = await read(invalid);
    const callsBeforeReextractRetry = providerCalls.length;
    const reextractRetry = await retryInvoiceDelivery(db, {
      invoiceId: invalid,
      teamId,
      teamRole: "admin",
    });
    await drain(db, workspace);
    const [supersededEntry] = await listInvoiceCorrections(db, {
      invoiceId: invalid,
      teamId,
    });
    check(
      "a re-extraction supersedes the earlier reading's unsent bill update",
      readAgain.processingRevision > cancelledUpdate.processingRevision &&
        supersededEntry?.id === cancelledEntry?.id &&
        supersededEntry?.updateStatus === "superseded" &&
        readAgain.delivery?.state !== "failed" &&
        !(await listed("delivery_failed")).includes(invalid) &&
        reextractRetry?.billUpdate === "not_needed" &&
        providerCalls.length === callsBeforeReextractRetry &&
        readAgain.accountingProviderId === providerId &&
        bills.size === billsBefore,
      {
        revision: readAgain.processingRevision,
        update: supersededEntry?.updateStatus,
        delivery: readAgain.delivery,
        reextractRetry,
      },
    );

    // Pagination through an exception filter visits every match once.
    const pages: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await getInbox(db, {
        teamId,
        state: "corrected",
        pageSize: 1,
        cursor,
      });
      pages.push(...page.data.map((row) => row.id));
      cursor = page.meta.cursor;
    } while (cursor);
    check(
      "the corrected filter pages through each corrected invoice once",
      Bun.deepEquals([...pages].sort(), [invalid, memberCase].sort()),
      pages,
    );

    const [corrections] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(invoiceCorrections)
      .where(eq(invoiceCorrections.teamId, teamId));
    console.log(
      JSON.stringify(
        {
          event: "exceptions_verification_succeeded",
          failedExtraction: {
            reason: failedRead.processingError,
            concurrentClicks: clicks.length,
            jobs: 1,
            recoveredRevision: recovered.processingRevision,
            stalledRecordedAs: afterStall.processingError,
          },
          questionRerun: {
            concurrentRequests: reruns.length,
            failedWith: rerunFailed.judgmentsRerunError,
            revision: rerun.processingRevision,
            judgments: rerun.judgments?.length,
          },
          invalidTotals: {
            blocked: blocked?.lastError,
            concurrentCorrections: outcomes.map((outcome) => outcome.status),
            validation: corrected.validationStatus,
            posted: postedAfterCorrection?.providerId,
          },
          ambiguousTimeout: {
            afterTimeout: timedOut?.status,
            providerCalls: providerCalls.filter(
              (call) => call.number === "EXC-TIMEOUT",
            ).length,
            bills: timeoutBills.length,
            providerId: settledPost?.providerId,
          },
          correctedAfterDelivery: {
            providerId,
            billsInXero: bills.size,
            history: finalHistory.map((entry) => ({
              version: entry.version,
              outcome: entry.accountingOutcome,
              update: entry.updateStatus,
              actor: entry.actor?.fullName,
            })),
          },
          corrections: corrections?.count,
        },
        null,
        2,
      ),
    );
  } finally {
    for (const path of paths) {
      await storage.remove({ bucket: "vault", path }).catch(() => undefined);
    }
    if (teamId) await db.delete(teams).where(eq(teams.id, teamId));
    for (const id of userIds) await db.delete(users).where(eq(users.id, id));
    typeSafe.stop(true);
    refusingTypeSafe.stop(true);
    receiver.stop(true);
    nango.stop(true);
    await database.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
