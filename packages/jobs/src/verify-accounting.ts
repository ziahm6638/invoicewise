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
  process.env.NANGO_XERO_DRAFT_BILL_ACTION = "create-draft-bill";

  const database = createDatabaseClient({
    primaryUrl: required("DATABASE_PRIMARY_URL"),
    isDevelopment: true,
  });
  const storage = createStorageClientFromEnv();
  const providerIds = new Map<string, string>();
  const actionAttempts = new Map<string, number>();
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
      if (request.method === "POST" && url.pathname === "/action/trigger") {
        const body = (await request.json()) as {
          action_name: string;
          input: Record<string, unknown>;
        };
        const supplier = body.input.supplier as Record<string, unknown>;
        const attachment = body.input.attachment as Record<string, unknown>;
        const key = String(body.input.idempotencyKey);
        const attempts = (actionAttempts.get(key) ?? 0) + 1;
        actionAttempts.set(key, attempts);
        if (
          body.action_name !== "create-draft-bill" ||
          body.input.status !== "draft" ||
          supplier.name !== "Acme Supplies Ltd" ||
          body.input.currency !== "GBP" ||
          body.input.netAmount !== 100 ||
          body.input.vatAmount !== 20 ||
          body.input.grossAmount !== 120 ||
          !Array.isArray(body.input.lineItems) ||
          typeof attachment.url !== "string" ||
          request.headers.get("connection-id") !== "xero-connection" ||
          request.headers.get("provider-config-key") !== "xero-invoicewise"
        ) {
          return Response.json(
            { error: { message: "Invalid draft action" } },
            { status: 400 },
          );
        }
        const existing = providerIds.get(key);
        if (existing)
          return Response.json({ providerId: existing, duplicate: true });
        const providerId = `xero-draft-${providerIds.size + 1}`;
        providerIds.set(key, providerId);
        if (body.input.invoiceNumber === "FAIL-RETRY") {
          return Response.json(
            { error: { message: "Forced provider timeout" } },
            { status: 503 },
          );
        }
        return Response.json({ providerId, duplicate: false });
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

    const createInvoice = async (invoiceNumber: string) => {
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
    const callsBeforeDuplicate = actionAttempts.get(
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
      actionAttempts.get(`invoicewise:${postedInvoice.id}`);

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
      retriedStatus?.status !== "already_posted" ||
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
            duplicateRefused,
          },
          retry: {
            failedWith: failedStatus.lastError,
            attempts: retriedJob.attempts,
            finalStatus: retriedStatus.status,
            providerId: retriedStatus.providerId,
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
