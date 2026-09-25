import { createDatabaseClient } from "@invoicewise/db/client";
import {
  createInbox,
  getInvoiceAccountingStatus,
  getWorkflowJob,
  updateInboxWithProcessedData,
} from "@invoicewise/db/queries";
import { inbox, teams } from "@invoicewise/db/schema";
import { createStorageClientFromEnv } from "@invoicewise/db/storage";
import type { InvoiceExtraction } from "@invoicewise/documents";
import { eq } from "drizzle-orm";
import { Effect, Logger } from "effect";
import {
  completeAccountingConnection,
  createAccountingConnectSession,
  disconnectAccountingConnection,
  postAccountingDraft,
  retryAccountingPost,
} from "./accounting";
import { scheduleAccountingPost } from "./delivery";
import { saveProcessedDocument } from "./process-document";
import { WorkflowRuntimeLive, runWorkflowBatch } from "./runner";
import { deliverPossibleDuplicates } from "./verify-support";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const runBatch = () =>
  Effect.runPromise(
    runWorkflowBatch.pipe(
      Effect.provide(WorkflowRuntimeLive),
      Effect.provide(Logger.json),
      Effect.scoped,
    ),
  );

async function main() {
  process.env.WORKFLOW_RETRY_BASE_MS = "10";
  process.env.WORKFLOW_RETRY_MAX_MS = "10";
  process.env.NANGO_SECRET_KEY = "nango-local-verification";
  process.env.NANGO_XERO_INTEGRATION_ID = "xero-invoicewise";

  const database = createDatabaseClient({
    primaryUrl: required("DATABASE_PRIMARY_URL"),
    isDevelopment: true,
  });
  const storage = createStorageClientFromEnv();
  // The Xero organisation the stub serves: bills by idempotency key, and the
  // attachments stored on each bill by file name.
  const providerIds = new Map<string, string>();
  const attachments = new Map<string, Map<string, number>>();
  // Provider calls per invoice number, whatever idempotency key they used.
  const billAttempts = new Map<string, number>();
  let workspaceId = "";
  let connected = true;
  let connectSessions = 0;
  const stub = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (
        request.headers.get("authorization") !==
        `Bearer ${process.env.NANGO_SECRET_KEY}`
      ) {
        return Response.json(
          { error: { message: "Unauthorized" } },
          { status: 401 },
        );
      }
      if (request.method === "POST" && url.pathname === "/connect/sessions") {
        const body = (await request.json()) as {
          tags?: { workspace_id?: string };
          allowed_integrations?: string[];
        };
        if (
          body.tags?.workspace_id !== workspaceId ||
          body.allowed_integrations?.[0] !== "xero-invoicewise"
        ) {
          return Response.json(
            { error: { message: "Invalid connect session" } },
            { status: 400 },
          );
        }
        connectSessions += 1;
        return Response.json(
          {
            data: {
              token: "connect-session-token",
              connect_link: "https://connect.nango.test/session",
              expires_at: "2026-09-22T13:00:00.000Z",
            },
          },
          { status: 201 },
        );
      }
      if (request.method === "GET" && url.pathname === "/connections") {
        if (
          url.searchParams.get("connectionId") !== "xero-connection" ||
          url.searchParams.get("tags[workspace_id]") !== workspaceId
        ) {
          return Response.json({ connections: [] });
        }
        return connected
          ? Response.json({
              connections: [
                {
                  connection_id: "xero-connection",
                  provider_config_key: "xero-invoicewise",
                  tags: { workspace_id: workspaceId },
                },
              ],
            })
          : Response.json({ connections: [] });
      }
      if (
        request.method === "GET" &&
        url.pathname === "/connection/xero-connection"
      ) {
        if (
          url.searchParams.get("provider_config_key") !== "xero-invoicewise"
        ) {
          return Response.json(
            { error: { message: "Unknown connection" } },
            { status: 404 },
          );
        }
        return Response.json({
          connection_id: "xero-connection",
          provider_config_key: "xero-invoicewise",
          connection_config: { tenant_id: "xero-tenant" },
          credentials: { expires_at: "2026-09-22T13:30:00.000Z" },
        });
      }
      const proxied =
        request.headers.get("connection-id") === "xero-connection" &&
        request.headers.get("provider-config-key") === "xero-invoicewise" &&
        request.headers.get("nango-proxy-xero-tenant-id") === "xero-tenant";
      if (
        request.method === "POST" &&
        url.pathname === "/proxy/api.xro/2.0/Invoices"
      ) {
        const body = (await request.json()) as {
          Invoices: Record<string, unknown>[];
        };
        const [bill] = body.Invoices;
        const key = request.headers.get("nango-proxy-idempotency-key") ?? "";
        const number = String(bill?.InvoiceNumber);
        billAttempts.set(number, (billAttempts.get(number) ?? 0) + 1);
        // Hold concurrent posts open together, as a slow provider would.
        if (number === "CONCURRENT") await Bun.sleep(100);
        const contact = bill?.Contact as Record<string, unknown> | undefined;
        const lines = bill?.LineItems as Record<string, unknown>[] | undefined;
        if (
          !proxied ||
          !key.startsWith("invoicewise:") ||
          bill?.Type !== "ACCPAY" ||
          bill.Status !== "DRAFT" ||
          !["Acme Supplies Ltd", "Northgate Timber Ltd"].includes(
            String(contact?.Name),
          ) ||
          bill.CurrencyCode !== "GBP" ||
          bill.LineAmountTypes !== "Exclusive" ||
          lines?.[0]?.UnitAmount !== 100
        ) {
          return Response.json(
            { Message: "A validation exception occurred" },
            { status: 400 },
          );
        }
        // Xero replays the original response for a repeated Idempotency-Key.
        const existing = providerIds.get(key);
        if (existing)
          return Response.json({ Invoices: [{ InvoiceID: existing }] });
        const providerId = `xero-bill-${providerIds.size + 1}`;
        providerIds.set(key, providerId);
        attachments.set(providerId, new Map());
        if (bill.InvoiceNumber === "FAIL-RETRY") {
          return Response.json(
            { error: { message: "Forced provider timeout" } },
            { status: 503 },
          );
        }
        return Response.json({ Invoices: [{ InvoiceID: providerId }] });
      }
      const attachment = url.pathname.match(
        /^\/proxy\/api\.xro\/2\.0\/Invoices\/([^/]+)\/Attachments\/([^/]+)$/,
      );
      if (request.method === "POST" && attachment) {
        const stored = attachments.get(decodeURIComponent(attachment[1]!));
        const bytes = (await request.arrayBuffer()).byteLength;
        if (
          !proxied ||
          !stored ||
          request.headers.get("nango-proxy-content-type") !==
            "application/pdf" ||
          bytes === 0
        ) {
          return Response.json(
            { Message: "Invalid attachment" },
            { status: 400 },
          );
        }
        stored.set(decodeURIComponent(attachment[2]!), bytes);
        return Response.json({ Attachments: [{ AttachmentID: "attachment" }] });
      }
      if (
        request.method === "DELETE" &&
        url.pathname === "/connections/xero-connection"
      ) {
        connected = false;
        return Response.json({ success: true });
      }
      return new Response("Not found", { status: 404 });
    },
  });
  process.env.NANGO_BASE_URL = `http://127.0.0.1:${stub.port}`;

  let teamId: string | undefined;
  const paths: string[][] = [];
  try {
    const [team] = await database.db
      .insert(teams)
      .values({ name: "Accounting verification" })
      .returning({ id: teams.id });
    if (!team) throw new Error("Unable to create verification team");
    teamId = team.id;
    workspaceId = team.id;
    // This proves the accounting job's own guards against copies that
    // reached it; the delivery rules have their own proof.
    await deliverPossibleDuplicates(database.db, teamId);

    const session = await createAccountingConnectSession({
      teamId,
      provider: "xero",
    });
    const connection = await completeAccountingConnection(database.db, {
      teamId,
      provider: "xero",
      connectionId: "xero-connection",
    });
    if (!connection) throw new Error("Unable to store accounting connection");

    const createDocument = async (fileName: string) => {
      const path = [teamId!, "inbox", `${fileName}.pdf`];
      paths.push(path);
      await storage.upload({
        bucket: "vault",
        path,
        file: Buffer.from("%PDF-1.4\n% InvoiceWise accounting proof\n"),
        contentType: "application/pdf",
      });
      const created = await createInbox(database.db, {
        teamId: teamId!,
        displayName: "Acme Supplies Ltd",
        filePath: path,
        fileName: `${fileName}.pdf`,
        contentType: "application/pdf",
        size: 42,
        status: "pending",
      });
      if (!created) throw new Error("Unable to create verification invoice");
      return created;
    };
    const extractionOf = (
      invoiceNumber: string,
      amounts: { netAmount: number; vatAmount: number; grossAmount: number } = {
        netAmount: 100,
        vatAmount: 20,
        grossAmount: 120,
      },
    ) => ({
      documentType: "invoice" as const,
      supplierName: "Acme Supplies Ltd",
      supplierVatNumber: "GB123456789",
      invoiceNumber,
      invoiceDate: "2026-09-22",
      dueDate: "2026-10-22",
      currency: "GBP",
      ...amounts,
      lineItems: [
        {
          description: "Materials",
          quantity: 1,
          unitPrice: 100,
          total: 100,
        },
      ],
    });
    const createInvoice = async (
      invoiceNumber: string,
      amounts?: { netAmount: number; vatAmount: number; grossAmount: number },
      fileName = invoiceNumber,
    ) => {
      const created = await createDocument(fileName);
      return updateInboxWithProcessedData(database.db, {
        id: created.id,
        displayName: "Acme Supplies Ltd",
        amount: 120,
        currency: "GBP",
        date: "2026-10-22",
        type: "invoice",
        status: "pending",
        extraction: extractionOf(invoiceNumber, amounts),
        judgments: [],
      });
    };
    // Completes a copy as the processing job does: validated against every
    // other copy, with its accounting post scheduled in the same transaction.
    const processCopy = async (
      id: string,
      invoiceNumber: string,
      supplier: Partial<ReturnType<typeof extractionOf>> = {},
    ) => {
      await database.db
        .update(inbox)
        .set({ status: "processing" })
        .where(eq(inbox.id, id));
      const { completion } = await saveProcessedDocument(database.db, {
        id,
        teamId: teamId!,
        displayName: "Acme Supplies Ltd",
        type: "invoice",
        extraction: {
          ...extractionOf(invoiceNumber),
          ...supplier,
        } as unknown as InvoiceExtraction,
        judgments: [],
      });
      if (!completion?.scheduled.accounting) {
        throw new Error(
          `Accounting post for ${invoiceNumber} was not queued: ${JSON.stringify(completion?.scheduled.decision?.reasons)}`,
        );
      }
    };
    const callsFor = (invoiceNumber: string) =>
      billAttempts.get(invoiceNumber) ?? 0;
    const statusOf = async (id: string) =>
      (
        await getInvoiceAccountingStatus(database.db, {
          invoiceId: id,
          teamId: teamId!,
        })
      )?.status;
    const duplicateOfFor = async (id: string) => {
      const [row] = await database.db
        .select({ validation: inbox.validation })
        .from(inbox)
        .where(eq(inbox.id, id));
      return (
        (row?.validation as { identity?: { duplicateOf?: string | null } })
          ?.identity?.duplicateOf ?? null
      );
    };

    const postedInvoice = await createInvoice("POST-ONCE");
    if (!postedInvoice) throw new Error("Unable to persist posted invoice");
    const schedule = (invoiceId: string) =>
      scheduleAccountingPost(database.db, {
        invoiceId,
        teamId: teamId!,
        revision: 0,
        status: null,
        providerId: null,
      });
    const postedJob = await schedule(postedInvoice.id);
    if (!postedJob) throw new Error("Accounting post was not queued");
    await runBatch();
    const postedStatus = await getInvoiceAccountingStatus(database.db, {
      invoiceId: postedInvoice.id,
      teamId,
    });
    const callsBeforeDuplicate = callsFor("POST-ONCE");
    const duplicate = await Effect.runPromise(
      postAccountingDraft(
        database.db,
        storage,
        { invoiceId: postedInvoice.id, teamId },
        process.env,
      ),
    );
    const duplicateRefused = callsBeforeDuplicate === callsFor("POST-ONCE");

    const retryInvoice = await createInvoice("FAIL-RETRY");
    if (!retryInvoice) throw new Error("Unable to persist retry invoice");
    const retryJob = await schedule(retryInvoice.id);
    if (!retryJob) throw new Error("Retry accounting post was not queued");
    await runBatch();
    const failedStatus = await getInvoiceAccountingStatus(database.db, {
      invoiceId: retryInvoice.id,
      teamId,
    });
    const queued = await getWorkflowJob(database.db, {
      id: retryJob.id,
      teamId,
    });
    if (!queued) throw new Error("Unable to load retry workflow");
    await Bun.sleep(
      Math.max(0, new Date(queued.runAt).getTime() - Date.now() + 5),
    );
    await runBatch();
    const retriedJob = await getWorkflowJob(database.db, {
      id: retryJob.id,
      teamId,
    });
    const retriedStatus = await getInvoiceAccountingStatus(database.db, {
      invoiceId: retryInvoice.id,
      teamId,
    });
    // An invoice whose total does not reconcile is refused before the
    // provider is called, with the reason recorded on the invoice.
    const blockedInvoice = await createInvoice("BLOCKED-TOTAL", {
      netAmount: 100,
      vatAmount: 20,
      grossAmount: 150,
    });
    if (!blockedInvoice) throw new Error("Unable to persist blocked invoice");
    const blockedJob = await schedule(blockedInvoice.id);
    if (!blockedJob) throw new Error("Blocked accounting post was not queued");
    await runBatch();
    const blockedStatus = await getInvoiceAccountingStatus(database.db, {
      invoiceId: blockedInvoice.id,
      teamId,
    });
    const blockedRun = await getWorkflowJob(database.db, {
      id: blockedJob.id,
      teamId,
    });
    const blockedCalls = callsFor("BLOCKED-TOTAL");

    // Two copies of one invoice processed out of arrival order: the later
    // copy is extracted first, then the original. The original is the one
    // delivered; the later copy becomes its duplicate before either post runs.
    const original = await createDocument("OUT-OF-ORDER-original");
    const laterCopy = await createDocument("OUT-OF-ORDER-copy");
    await processCopy(laterCopy.id, "OUT-OF-ORDER");
    await processCopy(original.id, "OUT-OF-ORDER");
    await runBatch();
    const outOfOrder = {
      calls: callsFor("OUT-OF-ORDER"),
      status: [await statusOf(original.id), await statusOf(laterCopy.id)],
      duplicateOf: [
        await duplicateOfFor(original.id),
        await duplicateOfFor(laterCopy.id),
      ],
    };
    // A later copy already sent before the original was read: the original
    // is never sent as a second bill.
    const lateOriginal = await createDocument("SENT-FIRST-original");
    const sentCopy = await createDocument("SENT-FIRST-copy");
    await processCopy(sentCopy.id, "SENT-FIRST");
    await runBatch();
    await processCopy(lateOriginal.id, "SENT-FIRST");
    await runBatch();
    const sentFirst = {
      calls: callsFor("SENT-FIRST"),
      status: [await statusOf(lateOriginal.id), await statusOf(sentCopy.id)],
    };
    // Two copies, each valid on its own record, posting at the same time:
    // exactly one wins the invoice's claim and reaches the provider; the
    // other becomes its duplicate without a provider call.
    const concurrentCopies = [
      await createInvoice("CONCURRENT", undefined, "CONCURRENT-a"),
      await createInvoice("CONCURRENT", undefined, "CONCURRENT-b"),
    ].map((copy) => {
      if (!copy) throw new Error("Unable to persist concurrent copy");
      return copy.id;
    });
    await Promise.all(
      concurrentCopies.map((invoiceId) =>
        Effect.runPromise(
          Effect.either(
            postAccountingDraft(
              database.db,
              storage,
              { invoiceId, teamId: teamId! },
              process.env,
            ),
          ),
        ),
      ),
    );
    const concurrentStatus = await Promise.all(concurrentCopies.map(statusOf));
    const winner = concurrentCopies[concurrentStatus.indexOf("posted")];
    const loser = concurrentCopies.find((id) => id !== winner);
    const concurrent = {
      calls: callsFor("CONCURRENT"),
      status: [...concurrentStatus].sort(),
      loserDuplicateOfWinner:
        winner !== undefined &&
        loser !== undefined &&
        (await duplicateOfFor(loser)) === winner,
    };

    // One copy read with the supplier's VAT number is sent; a copy of the
    // same invoice read with only the supplier's name, processed later, is
    // its duplicate and is never sent.
    const nameOnlyOriginal = await createDocument("VAT-NAME-original");
    const vatCopy = await createDocument("VAT-NAME-copy");
    await processCopy(vatCopy.id, "VAT-NAME");
    await runBatch();
    await processCopy(nameOnlyOriginal.id, "VAT-NAME", {
      supplierVatNumber: null as unknown as string,
    });
    await runBatch();
    const vatAndName = {
      calls: callsFor("VAT-NAME"),
      status: [await statusOf(nameOnlyOriginal.id), await statusOf(vatCopy.id)],
      duplicateOf: await duplicateOfFor(nameOnlyOriginal.id),
    };
    // Another supplier's invoice with a number already sent is never posted
    // automatically: it is held for review until a user retries it.
    const acmeNumber = await createDocument("SAME-NUMBER-acme");
    const otherNumber = await createDocument("SAME-NUMBER-other");
    await processCopy(acmeNumber.id, "SAME-NUMBER");
    await runBatch();
    await processCopy(otherNumber.id, "SAME-NUMBER", {
      supplierName: "Northgate Timber Ltd",
      supplierVatNumber: "GB987654321",
    });
    await runBatch();
    const held = {
      calls: callsFor("SAME-NUMBER"),
      status: await statusOf(otherNumber.id),
      duplicateOf: await duplicateOfFor(otherNumber.id),
    };
    await retryAccountingPost(database.db, {
      invoiceId: otherNumber.id,
      teamId,
    });
    await runBatch();
    const differentSupplier = {
      held,
      released: {
        calls: callsFor("SAME-NUMBER"),
        status: [await statusOf(acmeNumber.id), await statusOf(otherNumber.id)],
      },
    };

    const disconnected = await disconnectAccountingConnection(database.db, {
      teamId,
      provider: "xero",
    });

    if (
      connectSessions !== 1 ||
      postedStatus?.status !== "posted" ||
      duplicate.status !== "already_posted" ||
      !duplicateRefused ||
      // A failed attempt with retries left keeps the intent queued; only the
      // final attempt is a terminal failure.
      failedStatus?.status !== "queued" ||
      failedStatus.lastError !== "Forced provider timeout" ||
      retriedJob?.status !== "succeeded" ||
      retriedJob.attempts !== 2 ||
      retriedStatus?.status !== "posted" ||
      blockedStatus?.status !== "failed" ||
      !blockedStatus.lastError?.startsWith("Not sent to Xero:") ||
      blockedRun?.status !== "succeeded" ||
      blockedCalls !== 0 ||
      retriedStatus.providerId !==
        providerIds.get(retriedStatus.idempotencyKey ?? "") ||
      !Bun.deepEquals(outOfOrder, {
        calls: 1,
        status: ["posted", "failed"],
        duplicateOf: [null, original.id],
      }) ||
      !Bun.deepEquals(sentFirst, { calls: 1, status: ["failed", "posted"] }) ||
      !Bun.deepEquals(concurrent, {
        calls: 1,
        status: ["failed", "posted"],
        loserDuplicateOfWinner: true,
      }) ||
      !Bun.deepEquals(vatAndName, {
        calls: 1,
        status: ["failed", "posted"],
        duplicateOf: vatCopy.id,
      }) ||
      !Bun.deepEquals(differentSupplier, {
        held: { calls: 1, status: "needs_review", duplicateOf: null },
        released: { calls: 2, status: ["posted", "posted"] },
      }) ||
      providerIds.size !== 8 ||
      [...attachments.values()].some((files) => files.size !== 1) ||
      connected ||
      !disconnected
    ) {
      throw new Error(
        `Accounting verification did not reach the expected state: ${JSON.stringify(
          {
            outOfOrder,
            sentFirst,
            concurrent,
            vatAndName,
            differentSupplier,
            bills: providerIds.size,
          },
        )}`,
      );
    }

    console.log(
      JSON.stringify(
        {
          event: "accounting_verification_succeeded",
          connection: {
            connectSession: Boolean(session.token),
            stored: true,
            disconnected: !connected,
          },
          posting: {
            status: postedStatus.status,
            providerId: postedStatus.providerId,
            attached:
              attachments.get(postedStatus.providerId ?? "")?.size === 1,
            duplicateRefused,
          },
          blocked: {
            providerCalls: blockedCalls,
            status: blockedStatus.status,
            reason: blockedStatus.lastError,
          },
          copies: {
            outOfOrder,
            sentFirst,
            concurrent,
            vatAndName,
            differentSupplier,
          },
          retry: {
            afterFirstAttempt: failedStatus.status,
            failedWith: failedStatus.lastError,
            attempts: retriedJob.attempts,
            finalStatus: retriedStatus.status,
            providerId: retriedStatus.providerId,
            billsInXero: providerIds.size,
          },
        },
        null,
        2,
      ),
    );
  } finally {
    for (const path of paths) {
      await storage.remove({ bucket: "vault", path });
    }
    if (teamId) await database.db.delete(teams).where(eq(teams.id, teamId));
    stub.stop(true);
    await database.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
