/**
 * QuickBooks delivery, end to end against a loopback Nango and a fake
 * QuickBooks company (docs/accounting-integrations.md, "Local proof"):
 * workspace-bound connect with the company recorded, no posting before the
 * admin completes setup and confirms the company, then open bills through
 * the real processing, scheduling and workflow runner under an ambiguous
 * timeout, throttling, a failed token refresh and separately retried
 * attachments, a credit note as a vendor credit, the health check and
 * disconnect. Each business document ends as exactly one QuickBooks record.
 */
import { createDatabaseClient } from "@invoicewise/db/client";
import {
  createInbox,
  getInvoiceAccountingStatus,
} from "@invoicewise/db/queries";
import { inbox, teams, workflowJobs } from "@invoicewise/db/schema";
import { createStorageClientFromEnv } from "@invoicewise/db/storage";
import type { InvoiceExtraction } from "@invoicewise/documents";
import { and, eq, sql } from "drizzle-orm";
import { Effect, Logger } from "effect";
import {
  AccountingSettingsError,
  accountingRecordUrl,
  checkAccountingConnection,
  completeAccountingConnection,
  disconnectAccountingConnection,
  getAccountingSetup,
  retryAccountingPost,
  updateAccountingSettings,
} from "./accounting";
import { saveProcessedDocument } from "./process-document";
import { createQuickBooksFake } from "./quickbooks-fake";
import { WorkflowRuntimeLive, runWorkflowBatch } from "./runner";
import { deliverPossibleDuplicates, required } from "./verify-support";

const REALM = "9130";
const INTEGRATION = "quickbooks-invoicewise";
const CONNECTION = "quickbooks-connection";

const assert: (condition: unknown, message: string) => asserts condition = (
  condition,
  message,
) => {
  if (!condition) throw new Error(`QuickBooks verification failed: ${message}`);
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
  process.env.NANGO_QUICKBOOKS_INTEGRATION_ID = INTEGRATION;

  const database = createDatabaseClient({
    primaryUrl: required("DATABASE_PRIMARY_URL"),
    isDevelopment: true,
  });
  const db = database.db;
  const storage = createStorageClientFromEnv();
  const quickBooks = createQuickBooksFake(REALM, {
    name: "Synthetic Trading Ltd",
    country: "GB",
    homeCurrency: "GBP",
    multiCurrency: false,
  });
  let workspaceId = "";
  let connected = true;
  // The next connection lookups Nango answers with this status instead.
  const connectionFailures: number[] = [];

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
      if (url.pathname === `/integrations/${INTEGRATION}`) {
        return Response.json({
          data: { unique_key: INTEGRATION, provider: "quickbooks" },
        });
      }
      if (request.method === "GET" && url.pathname === "/connections") {
        // A connection is found only under the workspace tag it was made
        // with; "foreign-connection" belongs to another workspace.
        const id = url.searchParams.get("connectionId");
        const tag = url.searchParams.get("tags[workspace_id]");
        const owner =
          id === CONNECTION && connected
            ? workspaceId
            : id === "foreign-connection"
              ? "another-workspace"
              : null;
        return Response.json({
          connections:
            owner && owner === tag
              ? [
                  {
                    connection_id: id,
                    provider_config_key: INTEGRATION,
                    tags: { workspace_id: owner },
                  },
                ]
              : [],
        });
      }
      if (url.pathname === `/connection/${CONNECTION}`) {
        const status = connectionFailures.shift();
        if (status) {
          return Response.json(
            {
              error: {
                message:
                  status === 424
                    ? "Refreshing the token failed upstream"
                    : "Unknown connection",
              },
            },
            { status },
          );
        }
        return Response.json({
          connection_id: CONNECTION,
          connection_config: { realmId: REALM },
          credentials: { expires_at: "2026-09-25T13:00:00.000Z" },
        });
      }
      if (
        request.method === "DELETE" &&
        url.pathname === `/connections/${CONNECTION}`
      ) {
        connected = false;
        return Response.json({ success: true });
      }
      if (url.pathname.startsWith("/proxy/")) {
        if (
          request.headers.get("connection-id") !== CONNECTION ||
          request.headers.get("provider-config-key") !== INTEGRATION
        ) {
          return Response.json(
            { error: { message: "Unknown connection" } },
            { status: 404 },
          );
        }
        const type = request.headers.get("content-type") ?? "";
        const answer = await quickBooks.handle(
          request,
          url.pathname.slice("/proxy".length),
          url,
          type.startsWith("application/json")
            ? { json: (await request.json()) as Record<string, unknown> }
            : type.startsWith("multipart/form-data")
              ? { form: await request.formData() }
              : {},
        );
        if (answer) return answer;
      }
      return new Response("Not found", { status: 404 });
    },
  });
  process.env.NANGO_BASE_URL = `http://127.0.0.1:${stub.port}`;

  let teamId: string | undefined;
  const paths: string[][] = [];
  try {
    const [team] = await db
      .insert(teams)
      .values({ name: "QuickBooks verification" })
      .returning({ id: teams.id });
    assert(team, "the workspace is created");
    teamId = team.id;
    workspaceId = team.id;
    // The fixtures share a date and total; this proves the provider path,
    // and the delivery rules' duplicate hold has its own proof.
    await deliverPossibleDuplicates(db, teamId);

    // Drives the runner until no job of this workspace is waiting.
    const drain = async () => {
      for (let round = 0; round < 60; round++) {
        await runBatch();
        const [waiting] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(workflowJobs)
          .where(
            and(
              eq(workflowJobs.teamId, teamId!),
              sql`${workflowJobs.status} in ('queued', 'running')`,
            ),
          );
        if (!waiting?.count) return;
        await Bun.sleep(20);
      }
      throw new Error("QuickBooks verification jobs did not settle");
    };
    const statusOf = (invoiceId: string) =>
      getInvoiceAccountingStatus(db, { invoiceId, teamId: teamId! });
    const extractionOf = (
      invoiceNumber: string,
      overrides: Record<string, unknown> = {},
    ) =>
      ({
        documentType: "invoice",
        supplierName: "Northgate Timber Ltd",
        supplierVatNumber: "GB123456789",
        invoiceNumber,
        invoiceDate: "2026-09-22",
        dueDate: "2026-10-22",
        currency: "GBP",
        netAmount: 100,
        vatAmount: 20,
        grossAmount: 120,
        lineItems: [
          { description: "Timber", quantity: 4, unitPrice: 25, total: 100 },
        ],
        ...overrides,
      }) as unknown as InvoiceExtraction;
    // Receives and processes one document as intake does: its accounting
    // post, when due, is scheduled in the transaction that completes it.
    const processInvoice = async (
      invoiceNumber: string,
      overrides: Record<string, unknown> = {},
    ) => {
      const path = [teamId!, "inbox", `${invoiceNumber}.pdf`];
      paths.push(path);
      await storage.upload({
        bucket: "vault",
        path,
        file: Buffer.from(`%PDF-1.4\n% InvoiceWise ${invoiceNumber}\n`),
        contentType: "application/pdf",
      });
      const created = await createInbox(db, {
        teamId: teamId!,
        displayName: "Northgate Timber Ltd",
        filePath: path,
        fileName: `${invoiceNumber}.pdf`,
        contentType: "application/pdf",
        size: 42,
        status: "pending",
      });
      assert(created, `invoice ${invoiceNumber} is received`);
      await db
        .update(inbox)
        .set({ status: "processing" })
        .where(eq(inbox.id, created.id));
      const { completion } = await saveProcessedDocument(db, {
        id: created.id,
        teamId: teamId!,
        displayName: "Northgate Timber Ltd",
        type: "invoice",
        extraction: extractionOf(invoiceNumber, overrides),
        judgments: [],
      });
      return {
        id: created.id,
        scheduled: completion?.scheduled.accounting ?? false,
      };
    };
    const recordsNumbered = (number: string, kind = "Bill") =>
      quickBooks.records(kind).filter((record) => record.DocNumber === number);
    const attachedTo = (kind: string, id: string | null | undefined) =>
      quickBooks.state.attachables.get(`${kind}:${id}`) ?? 0;

    // --- Connect: only this workspace's connection binds, and the company
    // it reaches is recorded; nothing posts until setup and opt-in.
    const foreign = await completeAccountingConnection(db, {
      teamId,
      provider: "quickbooks",
      connectionId: "foreign-connection",
    }).catch((error: Error) => error.message);
    assert(
      foreign === "Nango connection does not belong to this workspace",
      "another workspace's connection is refused",
    );
    const connection = await completeAccountingConnection(db, {
      teamId,
      provider: "quickbooks",
      connectionId: CONNECTION,
    });
    assert(
      connection?.organisationId === REALM &&
        connection.organisationName === "Synthetic Trading Ltd" &&
        connection.autoPostEnabledAt === null &&
        connection.capabilities.includes("open_bills"),
      "the connection records its company and waits for the opt-in",
    );

    const beforeOptIn = await processInvoice("QB-BEFORE-OPT-IN");
    await drain();
    assert(
      !beforeOptIn.scheduled && (await statusOf(beforeOptIn.id)) === null,
      "nothing is posted before the workspace opts in",
    );

    const setup = await getAccountingSetup(db, { teamId });
    assert(
      setup?.missing.includes("expense_account") &&
        setup.accounts.some((account) => account.id === "7") &&
        setup.taxCodes.some((code) => code.id === "4" && code.rate === 20),
      "setup lists the company's expense accounts and purchase tax codes",
    );
    const refusals = await Promise.all(
      [
        { autoPost: true },
        { autoPost: true, expenseAccountId: "7" },
        { autoPost: true, expenseAccountId: "7", confirmOrganisationId: "1" },
        { autoPost: false, expenseAccountId: "no-such-account" },
      ].map((settings) =>
        updateAccountingSettings(db, {
          teamId: teamId!,
          userId: null,
          provider: "quickbooks",
          ...settings,
        }).then(
          () => "saved",
          (error) =>
            error instanceof AccountingSettingsError ? "refused" : error,
        ),
      ),
    );
    assert(
      refusals.every((outcome) => outcome === "refused"),
      `incomplete or unconfirmed opt-ins are refused (${refusals.join(", ")})`,
    );
    const optedIn = await updateAccountingSettings(db, {
      teamId,
      userId: null,
      provider: "quickbooks",
      expenseAccountId: "7",
      taxCodeIds: [],
      autoPost: true,
      confirmOrganisationId: REALM,
    });
    assert(optedIn?.autoPostEnabledAt, "the confirmed opt-in is recorded");

    // --- An ambiguous timeout: QuickBooks created the bill but the answer
    // was lost. The retry returns that bill; one bill exists.
    quickBooks.fail({ on: "bill", status: 504, afterApply: true });
    const ambiguous = await processInvoice("QB-AMBIGUOUS");
    assert(ambiguous.scheduled, "an opted-in invoice is scheduled");
    await drain();
    const ambiguousStatus = await statusOf(ambiguous.id);
    assert(
      ambiguousStatus?.status === "posted" &&
        recordsNumbered("QB-AMBIGUOUS").length === 1 &&
        ambiguousStatus.providerId === recordsNumbered("QB-AMBIGUOUS")[0]?.Id &&
        ambiguousStatus.entity === "bill" &&
        ambiguousStatus.attachmentStatus === "attached" &&
        attachedTo("Bill", ambiguousStatus.providerId) === 1,
      "an ambiguous timeout resolves to the one bill, attached once",
    );
    const billLine = (
      recordsNumbered("QB-AMBIGUOUS")[0]?.Line as Record<string, unknown>[]
    )[0] as { AccountBasedExpenseLineDetail: Record<string, unknown> };
    assert(
      JSON.stringify(billLine.AccountBasedExpenseLineDetail) ===
        JSON.stringify({
          AccountRef: { value: "7" },
          TaxCodeRef: { value: "4" },
        }),
      "the bill posts to the chosen account with the 20% purchase tax code",
    );

    // --- Throttled, then a failed token refresh, then success: one bill.
    quickBooks.fail({ on: "bill", status: 429 });
    connectionFailures.push(424);
    const throttled = await processInvoice("QB-THROTTLED");
    await drain();
    assert(
      (await statusOf(throttled.id))?.status === "posted" &&
        recordsNumbered("QB-THROTTLED").length === 1,
      "throttling and a refresh failure are retried into one bill",
    );

    // --- The upload fails after the bill exists: the bill stays posted and
    // only the attachment is retried, on its own job.
    const uploadsBefore = quickBooks.state.writes.upload ?? 0;
    quickBooks.fail({ on: "upload", status: 503 });
    quickBooks.fail({ on: "upload", status: 504, afterApply: true });
    const flakyUpload = await processInvoice("QB-FLAKY-UPLOAD");
    await drain();
    const flakyStatus = await statusOf(flakyUpload.id);
    assert(
      flakyStatus?.status === "posted" &&
        flakyStatus.attachmentStatus === "attached" &&
        recordsNumbered("QB-FLAKY-UPLOAD").length === 1 &&
        attachedTo("Bill", flakyStatus.providerId) === 1 &&
        (quickBooks.state.writes.upload ?? 0) - uploadsBefore === 1,
      "a failed and a lost upload are retried separately into one attachment",
    );

    // --- A refused upload fails the attachment only; an explicit retry
    // uploads it without posting the bill again.
    quickBooks.fail({
      on: "upload",
      status: 400,
      body: {
        Fault: { Error: [{ Detail: "File type not supported", code: "7000" }] },
      },
    });
    const refusedUpload = await processInvoice("QB-REFUSED-UPLOAD");
    await drain();
    const refusedStatus = await statusOf(refusedUpload.id);
    assert(
      refusedStatus?.status === "posted" &&
        refusedStatus.attachmentStatus === "failed" &&
        refusedStatus.attachmentError?.includes("File type not supported"),
      "a refused upload is recorded with its reason, the bill kept",
    );
    const retried = await retryAccountingPost(db, {
      invoiceId: refusedUpload.id,
      teamId,
    });
    await drain();
    const reattached = await statusOf(refusedUpload.id);
    assert(
      retried?.status === "attachment_queued" &&
        reattached?.attachmentStatus === "attached" &&
        attachedTo("Bill", reattached.providerId) === 1 &&
        recordsNumbered("QB-REFUSED-UPLOAD").length === 1,
      "an explicit retry attaches the document without a second bill",
    );

    // --- A credit note for an earlier invoice becomes a vendor credit.
    const credit = await processInvoice("QB-CREDIT", {
      documentType: "credit_note",
      originalInvoiceNumber: "QB-AMBIGUOUS",
      netAmount: -50,
      vatAmount: -10,
      grossAmount: -60,
      lineItems: [
        {
          description: "Returned timber",
          quantity: 2,
          unitPrice: -25,
          total: -50,
        },
      ],
    });
    await drain();
    const creditStatus = await statusOf(credit.id);
    const creditUrl = await accountingRecordUrl(db, teamId, {
      provider: "quickbooks",
      providerId: creditStatus?.providerId ?? null,
      entity: creditStatus?.entity,
    });
    assert(
      creditStatus?.status === "posted" &&
        creditStatus.entity === "vendor_credit" &&
        recordsNumbered("QB-CREDIT", "VendorCredit").length === 1 &&
        (
          recordsNumbered("QB-CREDIT", "VendorCredit")[0]?.Line as {
            Amount: number;
          }[]
        )[0]?.Amount === 50 &&
        creditUrl ===
          `https://app.qbo.intuit.com/app/vendorcredit?txnId=${creditStatus.providerId}`,
      `a credit note posts as one vendor credit with its link (${creditStatus?.status}: ${creditStatus?.lastError})`,
    );

    // --- Health: ok, unreachable while Nango's refresh fails, reconnect
    // when the connection is gone.
    const healthy = await checkAccountingConnection(db, { teamId });
    connectionFailures.push(424);
    const unreachable = await checkAccountingConnection(db, { teamId });
    connectionFailures.push(404);
    const gone = await checkAccountingConnection(db, { teamId });
    assert(
      healthy?.healthStatus === "ok" &&
        unreachable?.healthStatus === "unavailable" &&
        gone?.healthStatus === "reconnect" &&
        gone.healthError?.includes("reconnect QuickBooks"),
      "the health check tells ok, unreachable and reconnect apart",
    );

    const disconnected = await disconnectAccountingConnection(db, {
      teamId,
      provider: "quickbooks",
    });
    assert(
      disconnected?.disconnectedAt && !connected,
      "disconnect revokes the Nango connection",
    );

    const vendors = quickBooks.state.vendors.map(
      (vendor) => vendor.DisplayName,
    );
    assert(
      vendors.length === 1 && vendors[0] === "Northgate Timber Ltd",
      "one vendor was created for the supplier and reused",
    );
    console.log(
      JSON.stringify(
        {
          event: "quickbooks_verification_succeeded",
          company: {
            id: connection.organisationId,
            name: connection.organisationName,
          },
          bills: quickBooks.records("Bill").length,
          billWrites: quickBooks.state.writes.bill,
          vendorCredits: quickBooks.records("VendorCredit").length,
          uploads: quickBooks.state.writes.upload,
          vendors,
        },
        null,
        2,
      ),
    );
  } finally {
    for (const path of paths) {
      await storage.remove({ bucket: "vault", path });
    }
    if (teamId) await db.delete(teams).where(eq(teams.id, teamId));
    stub.stop(true);
    await database.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
