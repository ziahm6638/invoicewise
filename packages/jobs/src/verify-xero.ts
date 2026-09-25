/**
 * Xero delivery, end to end against a loopback Nango and a fake Xero
 * authorisation reaching two organisations (docs/accounting-integrations.md,
 * "Local proof"): workspace-bound connect with the organisation recorded, the
 * admin choosing which organisation bills go to, no posting before the setup
 * is complete and the organisation confirmed, then draft bills through the
 * real processing, scheduling and workflow runner under an ambiguous timeout
 * (inside and after Xero's idempotency window), throttling, a failed token
 * refresh and separately retried attachments, a credit note as a draft credit
 * note (corrected in place), the opt-in switched off under a queued post, a
 * record from another organisation refused, the health check, a reconnect
 * that keeps the setup, and disconnect. Each business document ends as
 * exactly one Xero record in the chosen organisation.
 */
import { createDatabaseClient } from "@invoicewise/db/client";
import {
  createInbox,
  getInvoiceAccountingStatus,
  getLatestBillUpdate,
} from "@invoicewise/db/queries";
import { inbox, teams, users, workflowJobs } from "@invoicewise/db/schema";
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
  selectAccountingOrganisation,
  updateAccountingSettings,
} from "./accounting";
import { InvoiceActionError, correctInvoice } from "./exceptions";
import { saveProcessedDocument } from "./process-document";
import { WorkflowRuntimeLive, runWorkflowBatch } from "./runner";
import { deliverPossibleDuplicates, required } from "./verify-support";
import { createXeroFake } from "./xero-fake";

const INTEGRATION = "xero-invoicewise";
const CONNECTION = "xero-connection";
const RECONNECTION = "xero-connection-2";
// Nango records the first organisation at connect; the admin chooses the
// second, so every bill proves it followed the choice.
const RECORDED = "7d0c0a3e-0000-4000-8000-00000000000a";
const CHOSEN = "7d0c0a3e-0000-4000-8000-00000000000b";

const assert: (condition: unknown, message: string) => asserts condition = (
  condition,
  message,
) => {
  if (!condition) throw new Error(`Xero verification failed: ${message}`);
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
  process.env.NANGO_XERO_INTEGRATION_ID = INTEGRATION;
  process.env.BETTER_AUTH_URL = "https://app.invoicewise.test";

  const database = createDatabaseClient({
    primaryUrl: required("DATABASE_PRIMARY_URL"),
    isDevelopment: true,
  });
  const db = database.db;
  const storage = createStorageClientFromEnv();
  const xero = createXeroFake([
    { id: RECORDED, name: "Synthetic Demo Ltd" },
    { id: CHOSEN, name: "Synthetic Trading Ltd", currencies: ["EUR"] },
  ]);
  let workspaceId = "";
  const live = new Set([CONNECTION, RECONNECTION]);
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
          data: { unique_key: INTEGRATION, provider: "xero" },
        });
      }
      if (request.method === "GET" && url.pathname === "/connections") {
        // A connection is found only under the workspace tag it was made
        // with; "foreign-connection" belongs to another workspace.
        const id = url.searchParams.get("connectionId") ?? "";
        const tag = url.searchParams.get("tags[workspace_id]");
        const owner = live.has(id)
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
      const lookup = url.pathname.match(/^\/connection\/([^/]+)$/);
      if (lookup) {
        const status = connectionFailures.shift();
        const id = decodeURIComponent(lookup[1]!);
        if (status || !live.has(id)) {
          return Response.json(
            {
              error: {
                message:
                  status === 424
                    ? "Refreshing the token failed upstream"
                    : "Unknown connection",
              },
            },
            { status: status ?? 404 },
          );
        }
        return Response.json({
          connection_id: id,
          connection_config: { tenant_id: RECORDED },
          credentials: { expires_at: "2026-09-25T13:00:00.000Z" },
        });
      }
      const deleted = url.pathname.match(/^\/connections\/([^/]+)$/);
      if (request.method === "DELETE" && deleted) {
        live.delete(decodeURIComponent(deleted[1]!));
        return Response.json({ success: true });
      }
      if (url.pathname.startsWith("/proxy/")) {
        if (
          !live.has(request.headers.get("connection-id") ?? "") ||
          request.headers.get("provider-config-key") !== INTEGRATION
        ) {
          return Response.json(
            { error: { message: "Unknown connection" } },
            { status: 404 },
          );
        }
        const type = request.headers.get("content-type") ?? "";
        const answer = await xero.handle(
          request,
          url.pathname.slice("/proxy".length),
          url,
          type.startsWith("application/json")
            ? { json: (await request.json()) as Record<string, unknown> }
            : request.method === "GET"
              ? {}
              : { bytes: (await request.arrayBuffer()).byteLength },
        );
        if (answer) return answer;
      }
      return new Response("Not found", { status: 404 });
    },
  });
  process.env.NANGO_BASE_URL = `http://127.0.0.1:${stub.port}`;

  let teamId: string | undefined;
  let adminId: string | undefined;
  const paths: string[][] = [];
  try {
    const [team] = await db
      .insert(teams)
      .values({ name: "Xero verification" })
      .returning({ id: teams.id });
    assert(team, "the workspace is created");
    teamId = team.id;
    workspaceId = team.id;
    const [admin] = await db
      .insert(users)
      .values({
        fullName: "Ada Admin",
        email: `${crypto.randomUUID()}@example.test`,
        teamId,
      })
      .returning({ id: users.id });
    assert(admin, "the admin is created");
    adminId = admin.id;
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
      throw new Error("Xero verification jobs did not settle");
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
    const billsNumbered = (number: string, tenant = CHOSEN) =>
      xero
        .records(tenant, "Invoices")
        .filter((record) => record.InvoiceNumber === number);
    const creditsNumbered = (number: string) =>
      xero
        .records(CHOSEN, "CreditNotes")
        .filter((record) => record.CreditNoteNumber === number);
    const attachedTo = (id: string | null | undefined) =>
      id ? xero.attachments(CHOSEN, id).length : 0;
    const uploads = () => xero.state.writes.Attachments ?? 0;
    // An admin's correction of a posted invoice that updates its record.
    const correctRecord = async (
      invoiceId: string,
      changes: Record<string, unknown>,
    ) => {
      const [current] = await db
        .select({ revision: inbox.processingRevision })
        .from(inbox)
        .where(eq(inbox.id, invoiceId));
      return correctInvoice(db, {
        invoiceId,
        teamId: teamId!,
        actorId: adminId!,
        teamRole: "admin",
        expectedRevision: current!.revision,
        reason: "Date read from the delivery note",
        changes,
        accountingOutcome: "update_bill",
      });
    };
    const optIn = () =>
      updateAccountingSettings(db, {
        teamId: teamId!,
        userId: adminId!,
        provider: "xero",
        expenseAccountId: "429",
        taxCodeIds: [],
        autoPost: true,
        confirmOrganisationId: CHOSEN,
      });

    // --- Connect: only this workspace's connection binds, and the
    // organisation it reaches is recorded; nothing posts until setup and
    // opt-in.
    const foreign = await completeAccountingConnection(db, {
      teamId,
      provider: "xero",
      connectionId: "foreign-connection",
    }).catch((error: Error) => error.message);
    assert(
      foreign === "Nango connection does not belong to this workspace",
      "another workspace's connection is refused",
    );
    const connection = await completeAccountingConnection(db, {
      teamId,
      provider: "xero",
      connectionId: CONNECTION,
    });
    assert(
      connection?.organisationId === RECORDED &&
        connection.organisationName === "Synthetic Demo Ltd" &&
        connection.autoPostEnabledAt === null &&
        connection.capabilities.includes("draft_credit_notes"),
      "the connection records the organisation Nango bound and waits for setup",
    );
    const beforeOptIn = await processInvoice("XERO-BEFORE-OPT-IN");
    await drain();
    assert(
      !beforeOptIn.scheduled && (await statusOf(beforeOptIn.id)) === null,
      "nothing is posted before the workspace sets up and opts in",
    );

    // --- The authorisation reaches two organisations: the admin chooses
    // the one bills go to, and only one it reaches.
    const setup = await getAccountingSetup(db, { teamId });
    assert(
      setup?.missing.includes("expense_account") &&
        setup.organisations.length === 2 &&
        setup.accounts.some((account) => account.id === "429") &&
        !setup.accounts.some((account) => account.id === "200") &&
        setup.taxCodes.some((code) => code.id === "INPUT2" && code.rate === 20),
      "setup lists the organisations, expense accounts and purchase tax rates",
    );
    const elsewhere = await selectAccountingOrganisation(db, {
      teamId,
      provider: "xero",
      organisationId: "not-a-reachable-organisation",
    }).catch((error) => error);
    assert(
      elsewhere instanceof AccountingSettingsError,
      "an organisation the connection does not reach is refused",
    );
    const chosen = await selectAccountingOrganisation(db, {
      teamId,
      provider: "xero",
      organisationId: CHOSEN,
    });
    assert(
      chosen?.organisationId === CHOSEN &&
        chosen.organisationName === "Synthetic Trading Ltd",
      "the chosen organisation is recorded",
    );
    const refusals = await Promise.all(
      [
        { autoPost: true },
        { autoPost: true, expenseAccountId: "429" },
        {
          autoPost: true,
          expenseAccountId: "429",
          confirmOrganisationId: RECORDED,
        },
        { autoPost: false, expenseAccountId: "200" },
        { autoPost: false, taxCodeIds: ["OUTPUT2"] },
      ].map((settings) =>
        updateAccountingSettings(db, {
          teamId: teamId!,
          userId: null,
          provider: "xero",
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
      `incomplete, unconfirmed or foreign choices are refused (${refusals.join(", ")})`,
    );
    const optedIn = await optIn();
    assert(optedIn?.autoPostEnabledAt, "the confirmed opt-in is recorded");

    // --- An ambiguous timeout: Xero created the bill but the answer was
    // lost. The retry (Xero replays the key) returns that bill.
    xero.fail({
      on: "Invoices",
      method: "POST",
      status: 504,
      afterApply: true,
    });
    const ambiguous = await processInvoice("XERO-AMBIGUOUS");
    assert(ambiguous.scheduled, "an opted-in invoice is scheduled");
    await drain();
    const ambiguousStatus = await statusOf(ambiguous.id);
    const [ambiguousBill] = billsNumbered("XERO-AMBIGUOUS");
    assert(
      ambiguousStatus?.status === "posted" &&
        billsNumbered("XERO-AMBIGUOUS").length === 1 &&
        ambiguousStatus.providerId === ambiguousBill?.InvoiceID &&
        ambiguousStatus.entity === "bill" &&
        ambiguousStatus.attachmentStatus === "attached" &&
        attachedTo(ambiguousStatus.providerId) === 1 &&
        billsNumbered("XERO-AMBIGUOUS", RECORDED).length === 0,
      "an ambiguous timeout resolves to one bill in the chosen organisation, attached once",
    );
    const [line] = ambiguousBill!.LineItems as Record<string, unknown>[];
    assert(
      ambiguousBill?.Type === "ACCPAY" &&
        ambiguousBill.Status === "DRAFT" &&
        line?.AccountCode === "429" &&
        line.TaxType === "INPUT2" &&
        new URL(String(ambiguousBill.Url)).searchParams.get("inboxId") ===
          ambiguous.id,
      "the draft bill posts to the chosen account and 20% rate, linked back to the invoice",
    );
    const billUrl = await accountingRecordUrl(db, teamId, {
      provider: "xero",
      providerId: ambiguousStatus.providerId,
      entity: "bill",
    });
    assert(
      billUrl ===
        `https://go.xero.com/AccountsPayable/Edit.aspx?InvoiceID=${ambiguousStatus.providerId}`,
      "the bill links to Xero",
    );

    // --- The worker dies after Xero created the bill, and the retry comes
    // after Xero forgot the key: the lookup finds the bill by its number,
    // contact and InvoiceWise's key.
    xero.fail({
      on: "Invoices",
      method: "POST",
      status: 504,
      afterApply: true,
    });
    const restarted = await processInvoice("XERO-RESTARTED");
    await runBatch();
    xero.expireIdempotencyKeys();
    await Bun.sleep(30);
    await drain();
    assert(
      (await statusOf(restarted.id))?.status === "posted" &&
        billsNumbered("XERO-RESTARTED").length === 1,
      "a retry after Xero's replay window finds the bill instead of adding one",
    );

    // --- Throttled, then a failed token refresh, then success: one bill.
    xero.fail({ on: "Invoices", method: "POST", status: 429 });
    xero.fail({
      on: "Organisation",
      status: 424,
      body: { error: { message: "Refreshing the token failed upstream" } },
    });
    const throttled = await processInvoice("XERO-THROTTLED");
    await drain();
    assert(
      (await statusOf(throttled.id))?.status === "posted" &&
        billsNumbered("XERO-THROTTLED").length === 1,
      "throttling and a refresh failure are retried into one bill",
    );

    // --- The upload fails after the bill exists: the bill stays posted and
    // only the attachment is retried, on its own job.
    const uploadsBefore = uploads();
    xero.fail({ on: "Attachments", method: "POST", status: 503 });
    xero.fail({
      on: "Attachments",
      method: "POST",
      status: 504,
      afterApply: true,
    });
    const flakyUpload = await processInvoice("XERO-FLAKY-UPLOAD");
    await drain();
    const flakyStatus = await statusOf(flakyUpload.id);
    assert(
      flakyStatus?.status === "posted" &&
        flakyStatus.attachmentStatus === "attached" &&
        billsNumbered("XERO-FLAKY-UPLOAD").length === 1 &&
        attachedTo(flakyStatus.providerId) === 1 &&
        uploads() - uploadsBefore === 1,
      "a failed and a lost upload are retried separately into one attachment",
    );

    // --- A refused upload fails the attachment only; an explicit retry
    // uploads it without posting the bill again.
    xero.fail({
      on: "Attachments",
      method: "POST",
      status: 400,
      body: {
        Elements: [{ ValidationErrors: [{ Message: "File is too large" }] }],
      },
    });
    const refusedUpload = await processInvoice("XERO-REFUSED-UPLOAD");
    await drain();
    const refusedStatus = await statusOf(refusedUpload.id);
    assert(
      refusedStatus?.status === "posted" &&
        refusedStatus.attachmentStatus === "failed" &&
        refusedStatus.attachmentError?.includes("File is too large"),
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
        attachedTo(reattached.providerId) === 1 &&
        billsNumbered("XERO-REFUSED-UPLOAD").length === 1,
      "an explicit retry attaches the document without a second bill",
    );

    // --- Xero's validation error is kept on the invoice as a refusal.
    const foreignCurrency = await processInvoice("XERO-USD", {
      currency: "USD",
    });
    await drain();
    const foreignStatus = await statusOf(foreignCurrency.id);
    assert(
      foreignStatus?.status === "failed" &&
        foreignStatus.retryable === false &&
        foreignStatus.lastError?.includes(
          "add USD in Xero's currency settings",
        ) &&
        billsNumbered("XERO-USD").length === 0,
      "a currency the organisation does not use is refused with the fix",
    );

    // --- Automatic posting switched off while a post is queued: it creates
    // nothing and is cancelled with the reason; a person's retry sends it.
    const optedOut = await processInvoice("XERO-OPTED-OUT");
    assert(optedOut.scheduled, "the post is queued while opted in");
    await updateAccountingSettings(db, {
      teamId,
      userId: null,
      provider: "xero",
      autoPost: false,
    });
    await drain();
    const optedOutStatus = await statusOf(optedOut.id);
    assert(
      optedOutStatus?.status === "cancelled" &&
        optedOutStatus.retryable === true &&
        optedOutStatus.lastError?.includes("switched off") &&
        billsNumbered("XERO-OPTED-OUT").length === 0,
      "a queued post creates nothing once automatic posting is off",
    );
    const sentByHand = await retryAccountingPost(db, {
      invoiceId: optedOut.id,
      teamId,
    });
    await drain();
    assert(
      sentByHand?.status === "queued" &&
        (await statusOf(optedOut.id))?.status === "posted" &&
        billsNumbered("XERO-OPTED-OUT").length === 1,
      "a person's retry sends the invoice while automatic posting is off",
    );
    await optIn();

    // --- A credit note for an earlier invoice becomes a draft credit note.
    const credit = await processInvoice("XERO-CREDIT", {
      documentType: "credit_note",
      originalInvoiceNumber: "XERO-AMBIGUOUS",
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
      provider: "xero",
      providerId: creditStatus?.providerId ?? null,
      entity: creditStatus?.entity,
    });
    const [creditNote] = creditsNumbered("XERO-CREDIT");
    assert(
      creditStatus?.status === "posted" &&
        creditStatus.entity === "vendor_credit" &&
        creditsNumbered("XERO-CREDIT").length === 1 &&
        creditNote?.Type === "ACCPAYCREDIT" &&
        creditNote.Status === "DRAFT" &&
        (creditNote.LineItems as { UnitAmount: number }[])[0]?.UnitAmount ===
          25 &&
        attachedTo(creditStatus.providerId) === 1 &&
        creditUrl ===
          `https://go.xero.com/AccountsPayable/ViewCreditNote.aspx?creditNoteID=${creditStatus.providerId}`,
      `a credit note posts as one draft credit note with its link (${creditStatus?.status}: ${creditStatus?.lastError})`,
    );
    const creditCorrection = await correctRecord(credit.id, {
      invoiceDate: "2026-09-23",
    });
    await drain();
    const creditUpdate = await getLatestBillUpdate(db, {
      invoiceId: credit.id,
      teamId,
    });
    assert(
      creditCorrection.accounting === "bill_update_queued" &&
        creditUpdate?.updateStatus === "updated" &&
        creditsNumbered("XERO-CREDIT").length === 1 &&
        creditsNumbered("XERO-CREDIT")[0]?.Date === "2026-09-23",
      `a corrected credit note updates its credit note in place (${creditUpdate?.updateStatus}: ${creditUpdate?.updateError})`,
    );

    // --- A record posted to another organisation than the chosen one is
    // never updated or attached through this one.
    const uploadsBeforeElsewhere = uploads();
    await db
      .update(inbox)
      .set({
        accountingOrganisationId: RECORDED,
        accountingAttachmentStatus: "failed",
      })
      .where(eq(inbox.id, throttled.id));
    const elsewhereRetry = await retryAccountingPost(db, {
      invoiceId: throttled.id,
      teamId,
    });
    await drain();
    const elsewhereStatus = await statusOf(throttled.id);
    const elsewhereCorrection = await correctRecord(throttled.id, {
      invoiceDate: "2026-09-23",
    }).catch((error) => error);
    assert(
      elsewhereRetry?.status === "already_posted" &&
        elsewhereStatus?.attachmentStatus === "failed" &&
        elsewhereStatus.attachmentError?.includes(
          "different connected Xero company",
        ) &&
        elsewhereCorrection instanceof InvoiceActionError &&
        elsewhereCorrection.code === "conflict" &&
        uploads() === uploadsBeforeElsewhere,
      "an attachment retry or bill update for another organisation is refused",
    );

    // --- Health: ok, unreachable while Xero's token refresh fails,
    // reconnect when the chosen organisation is no longer authorised.
    const healthy = await checkAccountingConnection(db, { teamId });
    xero.fail({ on: "connections", status: 424 });
    const unreachable = await checkAccountingConnection(db, { teamId });
    xero.state.reachable = [RECORDED];
    const revoked = await checkAccountingConnection(db, { teamId });
    xero.state.reachable = [RECORDED, CHOSEN];
    assert(
      healthy?.healthStatus === "ok" &&
        healthy.organisationId === CHOSEN &&
        unreachable?.healthStatus === "unavailable" &&
        revoked?.healthStatus === "reconnect" &&
        revoked.healthError?.includes("reconnect Xero") &&
        revoked.organisationId === CHOSEN,
      "the health check tells ok, unreachable and a withdrawn organisation apart",
    );

    // --- Reconnect: the new authorisation still reaches the chosen
    // organisation, so its setup and opt-in are kept; the replaced Nango
    // connection is deleted.
    const reconnected = await completeAccountingConnection(db, {
      teamId,
      provider: "xero",
      connectionId: RECONNECTION,
    });
    assert(
      reconnected?.connectionId === RECONNECTION &&
        reconnected.organisationId === CHOSEN &&
        reconnected.autoPostEnabledAt !== null &&
        !live.has(CONNECTION),
      "a reconnect keeps the chosen organisation and its opt-in",
    );
    const afterReconnect = await processInvoice("XERO-RECONNECTED");
    await drain();
    assert(
      (await statusOf(afterReconnect.id))?.status === "posted" &&
        billsNumbered("XERO-RECONNECTED").length === 1,
      "posting continues through the new connection",
    );
    live.delete(RECONNECTION);
    const gone = await checkAccountingConnection(db, { teamId });
    live.add(RECONNECTION);
    assert(
      gone?.healthStatus === "reconnect" &&
        gone.healthError?.includes("reconnect Xero"),
      "a connection Nango no longer has asks for a reconnect",
    );

    const disconnected = await disconnectAccountingConnection(db, {
      teamId,
      provider: "xero",
    });
    assert(
      disconnected?.disconnectedAt && !live.has(RECONNECTION),
      "disconnect revokes the Nango connection",
    );

    const contacts = xero.contacts(CHOSEN).map((contact) => contact.Name);
    assert(
      contacts.length === 1 &&
        contacts[0] === "Northgate Timber Ltd" &&
        xero.records(RECORDED, "Invoices").length === 0,
      "one contact was created for the supplier and reused, in the chosen organisation only",
    );
    console.log(
      JSON.stringify(
        {
          event: "xero_verification_succeeded",
          organisation: {
            recordedAtConnect: connection.organisationName,
            chosen: chosen.organisationName,
          },
          bills: xero.records(CHOSEN, "Invoices").length,
          billWrites: xero.state.writes.Invoices,
          creditNotes: xero.records(CHOSEN, "CreditNotes").length,
          uploads: uploads(),
          contacts,
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
    if (adminId) await db.delete(users).where(eq(users.id, adminId));
    stub.stop(true);
    await database.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
