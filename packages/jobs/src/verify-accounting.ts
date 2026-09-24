import { createDatabaseClient } from "@invoicewise/db/client";
import {
  createInbox,
  getInvoiceAccountingStatus,
  getWorkflowJob,
  updateInboxWithProcessedData,
} from "@invoicewise/db/queries";
import { teams } from "@invoicewise/db/schema";
import { createStorageClientFromEnv } from "@invoicewise/db/storage";
import { eq } from "drizzle-orm";
import { Effect, Logger } from "effect";
import {
  completeAccountingConnection,
  createAccountingConnectSession,
  disconnectAccountingConnection,
  enqueueAccountingPost,
  postAccountingDraft,
} from "./accounting";
import { WorkflowRuntimeLive, runWorkflowBatch } from "./runner";

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
        billAttempts.set(key, (billAttempts.get(key) ?? 0) + 1);
        const contact = bill?.Contact as Record<string, unknown> | undefined;
        const lines = bill?.LineItems as Record<string, unknown>[] | undefined;
        if (
          !proxied ||
          !key.startsWith("invoicewise:") ||
          bill?.Type !== "ACCPAY" ||
          bill.Status !== "DRAFT" ||
          contact?.Name !== "Acme Supplies Ltd" ||
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

    const createInvoice = async (
      invoiceNumber: string,
      amounts: { netAmount: number; vatAmount: number; grossAmount: number } = {
        netAmount: 100,
        vatAmount: 20,
        grossAmount: 120,
      },
    ) => {
      const path = [teamId!, "inbox", `${invoiceNumber}.pdf`];
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
        fileName: `${invoiceNumber}.pdf`,
        contentType: "application/pdf",
        size: 42,
        status: "pending",
      });
      if (!created) throw new Error("Unable to create verification invoice");
      return updateInboxWithProcessedData(database.db, {
        id: created.id,
        displayName: "Acme Supplies Ltd",
        amount: 120,
        currency: "GBP",
        date: "2026-10-22",
        type: "invoice",
        status: "pending",
        extraction: {
          documentType: "invoice",
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
        },
        judgments: [],
      });
    };

    const postedInvoice = await createInvoice("POST-ONCE");
    if (!postedInvoice) throw new Error("Unable to persist posted invoice");
    const postedJob = await enqueueAccountingPost(database.db, {
      invoiceId: postedInvoice.id,
      teamId,
    });
    if (!postedJob) throw new Error("Accounting post was not queued");
    await runBatch();
    const postedStatus = await getInvoiceAccountingStatus(database.db, {
      invoiceId: postedInvoice.id,
      teamId,
    });
    const callsBeforeDuplicate = billAttempts.get(
      `invoicewise:${postedInvoice.id}`,
    );
    const duplicate = await Effect.runPromise(
      postAccountingDraft(
        database.db,
        storage,
        { invoiceId: postedInvoice.id, teamId },
        process.env,
      ),
    );
    const duplicateRefused =
      callsBeforeDuplicate ===
      billAttempts.get(`invoicewise:${postedInvoice.id}`);

    const retryInvoice = await createInvoice("FAIL-RETRY");
    if (!retryInvoice) throw new Error("Unable to persist retry invoice");
    const retryJob = await enqueueAccountingPost(database.db, {
      invoiceId: retryInvoice.id,
      teamId,
    });
    if (!retryJob) throw new Error("Retry accounting post was not queued");
    await runBatch();
    const failedStatus = await getInvoiceAccountingStatus(database.db, {
      invoiceId: retryInvoice.id,
      teamId,
    });
    const queued = await getWorkflowJob(database.db, {
      id: retryJob.job.id,
      teamId,
    });
    if (!queued) throw new Error("Unable to load retry workflow");
    await Bun.sleep(
      Math.max(0, new Date(queued.runAt).getTime() - Date.now() + 5),
    );
    await runBatch();
    const retriedJob = await getWorkflowJob(database.db, {
      id: retryJob.job.id,
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
    const blockedJob = await enqueueAccountingPost(database.db, {
      invoiceId: blockedInvoice.id,
      teamId,
    });
    if (!blockedJob) throw new Error("Blocked accounting post was not queued");
    await runBatch();
    const blockedStatus = await getInvoiceAccountingStatus(database.db, {
      invoiceId: blockedInvoice.id,
      teamId,
    });
    const blockedRun = await getWorkflowJob(database.db, {
      id: blockedJob.job.id,
      teamId,
    });
    const blockedCalls =
      billAttempts.get(`invoicewise:${blockedInvoice.id}`) ?? 0;

    const disconnected = await disconnectAccountingConnection(database.db, {
      teamId,
      provider: "xero",
    });

    if (
      connectSessions !== 1 ||
      postedStatus?.status !== "posted" ||
      duplicate.status !== "already_posted" ||
      !duplicateRefused ||
      failedStatus?.status !== "failed" ||
      retriedJob?.status !== "succeeded" ||
      retriedJob.attempts !== 2 ||
      retriedStatus?.status !== "posted" ||
      blockedStatus?.status !== "failed" ||
      !blockedStatus.lastError?.startsWith("Not sent to Xero:") ||
      blockedRun?.status !== "succeeded" ||
      blockedCalls !== 0 ||
      retriedStatus.providerId !==
        providerIds.get(`invoicewise:${retryInvoice.id}`) ||
      providerIds.size !== 2 ||
      [...attachments.values()].some((files) => files.size !== 1) ||
      connected ||
      !disconnected
    ) {
      throw new Error(
        "Accounting verification did not reach the expected state",
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
          retry: {
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
