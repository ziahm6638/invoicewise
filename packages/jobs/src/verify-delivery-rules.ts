/**
 * Delivery rules proof (docs/delivery.md#delivery-rules): an eligible
 * invoice delivered with no manual step, and risky invoices held with the
 * exact reason and resolved safely, run through the real queue, worker
 * batches and Postgres against loopback Nango/Xero and webhook stubs.
 * Covers a duplicate and a revised invoice, changed bank details, missing
 * evidence (a missing field, a low-confidence reading, an unknown required
 * answer), concurrent releases, retries that cannot bypass a hold, and a
 * policy update that re-decides nothing already decided.
 * `bun run verify` runs it; it creates its own workspace and removes it.
 */
import { createDatabaseClient } from "@invoicewise/db/client";
import {
  createInbox,
  createWebhookEndpoint,
  getInbox,
  getInboxById,
  getInvoiceAccountingStatus,
  listDeliveryDecisions,
} from "@invoicewise/db/queries";
import { inbox, teams, users, workflowJobs } from "@invoicewise/db/schema";
import { createStorageClientFromEnv } from "@invoicewise/db/storage";
import {
  DEFAULT_DELIVERY_POLICY,
  type InvoiceExtraction,
} from "@invoicewise/documents";
import { and, eq, sql } from "drizzle-orm";
import { Effect, Logger } from "effect";
import {
  completeAccountingConnection,
  retryAccountingPost,
} from "./accounting";
import { InvoiceActionError } from "./action-error";
import {
  dismissHeldDelivery,
  releaseHeldDelivery,
  retryInvoiceDelivery,
} from "./delivery";
import { saveDeliveryPolicy } from "./delivery-rules";
import { saveProcessedDocument } from "./process-document";
import { WorkflowRuntimeLive, runWorkflowBatch } from "./runner";
import { enableXeroPosting, required, xeroConnectStub } from "./verify-support";

const runBatch = () =>
  Effect.runPromise(
    runWorkflowBatch.pipe(
      Effect.provide(WorkflowRuntimeLive),
      Effect.provide(Logger.json),
      Effect.scoped,
    ),
  );

const check = (label: string, ok: boolean, detail?: unknown) => {
  if (!ok) {
    throw new Error(
      `${label} did not hold${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`,
    );
  }
  console.log(`ok - ${label}`);
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

type Decision = {
  outcome?: string;
  policyVersion?: number;
  accounting?: string;
  webhooks?: string;
  resolution?: string | null;
  reasons?: { code?: string; message?: string; locked?: boolean }[];
};

async function main() {
  process.env.WORKFLOW_RETRY_BASE_MS = "10";
  process.env.WORKFLOW_RETRY_MAX_MS = "10";
  // Loopback webhook endpoints are accepted outside production only.
  process.env.NODE_ENV = "test";
  process.env.NANGO_SECRET_KEY = "nango-delivery-rules-verification";
  process.env.NANGO_XERO_INTEGRATION_ID = "xero-invoicewise";

  const database = createDatabaseClient({
    primaryUrl: required("DATABASE_PRIMARY_URL"),
    isDevelopment: true,
  });
  const db = database.db;
  const storage = createStorageClientFromEnv();

  // The webhook consumer.
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

  // The Xero organisation behind Nango: one bill per idempotency key.
  let workspaceId = "";
  const billsByKey = new Map<string, string>();
  const providerCalls: string[] = [];
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
          { status: 401 },
        );
      }
      const connectCheck = xeroConnectStub(request, url);
      if (connectCheck) return connectCheck;
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
          (await request.json()) as { Invoices: Record<string, unknown>[] }
        ).Invoices;
        providerCalls.push(String(bill?.InvoiceNumber));
        const key = request.headers.get("nango-proxy-idempotency-key") ?? "";
        let id = billsByKey.get(key);
        if (!id) {
          id = `xero-bill-${billsByKey.size + 1}`;
          billsByKey.set(key, id);
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
      .values({ name: "Delivery rules verification" })
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
          teamId: workspace,
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
    const member = {
      actorId: await person("Max Member"),
      teamRole: "member" as const,
    };
    await createWebhookEndpoint(db, {
      teamId: workspace,
      userId: admin.actorId,
      url: `http://127.0.0.1:${receiver.port}/invoices`,
      events: ["invoice.processed", "invoice.judgments.attached"],
    });
    await completeAccountingConnection(db, {
      teamId: workspace,
      provider: "xero",
      connectionId: "xero-connection",
    });
    await enableXeroPosting(db, workspace);

    const drain = async () => {
      for (let round = 0; round < 60; round++) {
        await runBatch();
        const [pending] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(workflowJobs)
          .where(
            and(
              eq(workflowJobs.teamId, workspace),
              sql`${workflowJobs.status} in ('queued', 'running')`,
            ),
          );
        if (!pending?.count) return;
        await Bun.sleep(20);
      }
      throw new Error("Workflow queue did not drain");
    };

    // Each invoice has its own date, so none is a same-date-and-total copy
    // of another unless a case says so.
    let day = 0;
    const extractionOf = (
      invoiceNumber: string | null,
      overrides: Partial<InvoiceExtraction> = {},
    ): InvoiceExtraction => {
      day += 1;
      return {
        documentType: "invoice",
        supplierName: "Harbour Plumbing Ltd",
        supplierAddress: null,
        supplierVatNumber: "GB123456782",
        supplierCompanyNumber: null,
        invoiceNumber: invoiceNumber as string,
        originalInvoiceNumber: null,
        invoiceDate: `2026-08-${String(day).padStart(2, "0")}`,
        dueDate: "2026-09-30",
        currency: "GBP",
        netAmount: 100,
        discountAmount: null,
        vatAmount: 20,
        taxRate: 20,
        grossAmount: 120,
        amountsIncludeTax: false,
        lineItems: [
          { description: "Call-out", quantity: 1, unitPrice: 100, total: 100 },
        ] as InvoiceExtraction["lineItems"],
        bankDetails: {
          accountName: "Harbour Plumbing Ltd",
          accountNumber: "12345678",
          sortCode: "12-34-56",
          iban: null,
          bic: null,
        },
        description: null,
        purchaseOrderReference: null,
        paymentReference: null,
        textSource: "text-layer",
        pageSources: ["text-layer"],
        evidence: { fields: {}, lineItems: [] },
        ...overrides,
      };
    };
    // Read and saved as the processing job does: validated, supplier
    // checks recorded, decided and scheduled in one commit.
    const processed = async (
      extraction: InvoiceExtraction,
      judgments: Record<string, unknown>[] = [],
    ) => {
      const path = [workspace, "inbox", `${crypto.randomUUID()}.pdf`];
      paths.push(path);
      await storage.upload({
        bucket: "vault",
        path,
        file: Buffer.from("%PDF-1.4\n% InvoiceWise delivery rules proof\n"),
        contentType: "application/pdf",
      });
      const created = await createInbox(db, {
        teamId: workspace,
        displayName: extraction.supplierName ?? "Invoice",
        filePath: path,
        fileName: `${extraction.invoiceNumber ?? "unnumbered"}.pdf`,
        contentType: "application/pdf",
        size: 44,
        status: "processing",
      });
      if (!created) throw new Error("Unable to create verification invoice");
      await saveProcessedDocument(db, {
        id: created.id,
        teamId: workspace,
        displayName: extraction.supplierName ?? "Invoice",
        type: "invoice",
        extraction,
        judgments,
      });
      await drain();
      return created.id;
    };
    const read = async (id: string) => {
      const row = await getInboxById(db, { id, teamId: workspace });
      if (!row) throw new Error(`Invoice ${id} is not readable`);
      return {
        ...row,
        decision: row.deliveryDecision as Decision | null,
      };
    };
    const accounting = (id: string) =>
      getInvoiceAccountingStatus(db, { invoiceId: id, teamId: workspace });
    const eventsFor = (id: string) =>
      received.filter((delivery) => delivery.body.invoiceId === id);
    const billsFor = (number: string) =>
      providerCalls.filter((call) => call === number).length;
    const listed = async (state: "held" | "needs_attention" | "delivered") =>
      (
        await getInbox(db, { teamId: workspace, state, pageSize: 100 })
      ).data.map((row) => row.id);
    const codes = (decision: Decision | null) =>
      (decision?.reasons ?? []).map((reason) => reason.code);

    // --- 1. The normal valid invoice flows with no manual step --------------------
    const valid = await processed(extractionOf("HP-1001"));
    const validRead = await read(valid);
    const validEvent = eventsFor(valid).find(
      (delivery) => delivery.event === "invoice.processed",
    );
    const validSnapshot = (
      validEvent?.body.data as { deliveryDecision?: Decision } | undefined
    )?.deliveryDecision;
    check(
      "a valid invoice is posted and sent to webhooks automatically",
      validRead.decision?.outcome === "deliver" &&
        validRead.decision.policyVersion === 0 &&
        (await accounting(valid))?.status === "posted" &&
        billsFor("HP-1001") === 1 &&
        validRead.delivery?.state === "delivered" &&
        (await listed("delivered")).includes(valid),
      { decision: validRead.decision, delivery: validRead.delivery },
    );
    check(
      "the delivery carries the policy version and decision it was sent under",
      validSnapshot?.outcome === "deliver" &&
        validSnapshot.policyVersion === 0 &&
        Array.isArray(validSnapshot.reasons) &&
        validSnapshot.reasons.length === 0,
      validSnapshot,
    );

    // --- 2. A duplicate is held, cannot be released, and is dismissed ------------
    const copy = await processed(
      extractionOf("HP-1001", {
        invoiceDate: validRead.extraction?.invoiceDate as string,
      }),
    );
    const copyRead = await read(copy);
    check(
      "a second copy of a posted invoice is held as a duplicate with the reason",
      copyRead.decision?.outcome === "hold" &&
        codes(copyRead.decision).includes("duplicate") &&
        copyRead.decision.reasons?.every((reason) => reason.locked) === true &&
        billsFor("HP-1001") === 1 &&
        eventsFor(copy).length === 0 &&
        (await accounting(copy))?.status == null &&
        (await listed("held")).includes(copy) &&
        (await listed("needs_attention")).includes(copy),
      copyRead.decision,
    );
    const heldCopy = {
      invoiceId: copy,
      teamId: workspace,
      expectedRevision: copyRead.processingRevision,
    };
    check(
      "a duplicate cannot be released into a second bill",
      (await refusal(
        releaseHeldDelivery(db, {
          ...heldCopy,
          ...admin,
          reason: "Send it anyway",
        }),
      )) === "invalid",
    );
    const retriedCopy = await retryInvoiceDelivery(db, {
      ...heldCopy,
      teamRole: "admin",
    });
    const postedCopy = await retryAccountingPost(db, {
      invoiceId: copy,
      teamId: workspace,
    });
    await drain();
    check(
      "neither retry route bypasses a hold",
      retriedCopy?.accounting === "held" &&
        retriedCopy.webhooks.requeued === 0 &&
        postedCopy?.status === "held" &&
        billsFor("HP-1001") === 1,
      { retriedCopy, postedCopy },
    );
    check(
      "a member cannot dismiss a held invoice",
      (await refusal(
        dismissHeldDelivery(db, {
          ...heldCopy,
          ...member,
          reason: "Same bill received twice",
        }),
      )) === "forbidden",
    );
    await dismissHeldDelivery(db, {
      ...heldCopy,
      ...admin,
      reason: "Same bill received twice by email",
    });
    const dismissed = await read(copy);
    const [dismissal] = await listDeliveryDecisions(db, {
      invoiceId: copy,
      teamId: workspace,
    });
    check(
      "the dismissal is recorded with who decided and why, and nothing is sent",
      dismissed.delivery?.state === "dismissed" &&
        dismissal?.resolution === "dismissed" &&
        dismissal.resolver?.id === admin.actorId &&
        dismissal.resolutionReason === "Same bill received twice by email" &&
        eventsFor(copy).length === 0 &&
        !(await listed("needs_attention")).includes(copy),
      dismissal,
    );
    check(
      "a resolved hold cannot be resolved again",
      (await refusal(
        dismissHeldDelivery(db, {
          ...heldCopy,
          ...admin,
          reason: "Clicked twice",
        }),
      )) === "conflict",
    );

    // A revised invoice (same number, a different total) is not a copy.
    const revised = await processed(
      extractionOf("HP-1001", {
        netAmount: 150,
        vatAmount: 30,
        grossAmount: 180,
        lineItems: [
          { description: "Call-out", quantity: 1, unitPrice: 150, total: 150 },
        ] as InvoiceExtraction["lineItems"],
      }),
    );
    const revisedRead = await read(revised);
    check(
      "a revised invoice is held as a revision, not as a new invoice or a copy",
      codes(revisedRead.decision).includes("revised_invoice") &&
        !codes(revisedRead.decision).includes("duplicate") &&
        billsFor("HP-1001") === 1,
      revisedRead.decision,
    );

    // --- 3. Changed bank details: held, released by an admin, sent once ----------
    const changedBank = {
      bankDetails: {
        accountName: "Harbour Plumbing Ltd",
        accountNumber: "87654321",
        sortCode: "65-43-21",
        iban: null,
        bic: null,
      },
    };
    const bank = await processed(extractionOf("HP-1002", changedBank));
    const bankRead = await read(bank);
    const bankReason = bankRead.decision?.reasons?.find(
      (reason) => reason.code === "bank_details_changed",
    );
    check(
      "changed bank details are held with the masked accounts and what to do",
      bankRead.decision?.outcome === "hold" &&
        bankReason?.locked === false &&
        (bankReason.message ?? "").includes("4321") &&
        !(bankReason.message ?? "").includes("87654321") &&
        (bankReason.message ?? "").includes("Release it once") &&
        eventsFor(bank).length === 0 &&
        billsFor("HP-1002") === 0,
      bankRead.decision,
    );
    const releaseBank = {
      invoiceId: bank,
      teamId: workspace,
      expectedRevision: bankRead.processingRevision,
    };
    check(
      "a member cannot release a held invoice",
      (await refusal(
        releaseHeldDelivery(db, {
          ...releaseBank,
          ...member,
          reason: "Looks fine",
        }),
      )) === "forbidden",
    );
    check(
      "a release of a revision that has moved on is refused",
      (await refusal(
        releaseHeldDelivery(db, {
          ...releaseBank,
          expectedRevision: bankRead.processingRevision - 1,
          ...admin,
          reason: "Stale tab",
        }),
      )) === "conflict",
    );
    // Two admins release at once: one release, one bill, one event per type.
    const releases = await Promise.allSettled(
      [0, 1].map(() =>
        releaseHeldDelivery(db, {
          ...releaseBank,
          ...admin,
          reason:
            "Called Harbour Plumbing on the number we hold; new account confirmed",
        }),
      ),
    );
    await drain();
    const bankAfter = await read(bank);
    const bankEvents = eventsFor(bank);
    const releasedSnapshot = (
      bankEvents[0]?.body.data as { deliveryDecision?: Decision } | undefined
    )?.deliveryDecision;
    check(
      "concurrent releases send once: one bill, one event, the release on the delivery",
      releases.filter((result) => result.status === "fulfilled").length === 1 &&
        releases.some(
          (result) =>
            result.status === "rejected" &&
            result.reason instanceof InvoiceActionError &&
            result.reason.code === "conflict",
        ) &&
        billsFor("HP-1002") === 1 &&
        (await accounting(bank))?.status === "posted" &&
        bankEvents.filter((delivery) => delivery.event === "invoice.processed")
          .length === 1 &&
        releasedSnapshot?.resolution === "released" &&
        bankAfter.delivery?.state === "delivered",
      {
        releases: releases.map((result) => result.status),
        bills: billsFor("HP-1002"),
        events: bankEvents.map((delivery) => delivery.event),
      },
    );

    // --- 4. Missing evidence -------------------------------------------------------
    const unnumbered = await processed(extractionOf(null));
    const unnumberedRead = await read(unnumbered);
    check(
      "a missing invoice number holds the invoice until it is corrected",
      codes(unnumberedRead.decision).includes("missing_required_fields") &&
        unnumberedRead.decision?.reasons?.[0]?.locked === true,
      unnumberedRead.decision,
    );
    const uncertain = await processed(
      extractionOf("HP-1003", {
        evidence: {
          fields: {
            grossAmount: {
              page: 1,
              line: 14,
              text: "Total due 120.00",
              label: "Total due",
              confidence: 0.41,
            },
          },
          lineItems: [],
        } as InvoiceExtraction["evidence"],
      }),
    );
    const uncertainRead = await read(uncertain);
    check(
      "a gross total read with low confidence is held as an uncertain reading",
      codes(uncertainRead.decision).includes("uncertain_reading") &&
        billsFor("HP-1003") === 0,
      uncertainRead.decision,
    );
    // An earlier post of the invoice failed; the held revision is still not
    // re-posted by a retry.
    await db
      .update(inbox)
      .set({
        accountingPostStatus: "failed",
        accountingRevision: uncertainRead.processingRevision,
      })
      .where(eq(inbox.id, uncertain));
    const retriedFailed = await retryInvoiceDelivery(db, {
      invoiceId: uncertain,
      teamId: workspace,
      teamRole: "admin",
    });
    const postedFailed = await retryAccountingPost(db, {
      invoiceId: uncertain,
      teamId: workspace,
    });
    await drain();
    check(
      "a held invoice whose earlier post failed is not re-posted by a retry",
      retriedFailed?.accounting === "held" &&
        postedFailed?.status === "held" &&
        (await accounting(uncertain))?.status === "failed" &&
        billsFor("HP-1003") === 0,
      { retriedFailed, postedFailed },
    );
    await saveDeliveryPolicy(db, {
      teamId: workspace,
      ...admin,
      expectedVersion: 0,
      settings: {
        ...DEFAULT_DELIVERY_POLICY,
        requiredQuestions: ["known_supplier"],
      },
    });
    const unknownAnswer = await processed(extractionOf("HP-1004"), [
      {
        questionId: "known_supplier",
        label: "Known supplier",
        question: "Is the supplier known?",
        source: "default",
        type: "boolean",
        status: "unknown",
        reason: "The invoice does not say.",
      },
    ]);
    const unknownRead = await read(unknownAnswer);
    check(
      "an unknown answer to a required question holds the invoice, never reads as no",
      unknownRead.decision?.policyVersion === 1 &&
        codes(unknownRead.decision).includes("required_answer_uncertain") &&
        (unknownRead.decision?.reasons?.[0]?.message ?? "").includes(
          "has no answer on the invoice",
        ) &&
        billsFor("HP-1004") === 0,
      unknownRead.decision,
    );

    // --- 5. A policy update re-decides nothing already decided -----------------------
    check(
      "a stale policy save is refused and a member cannot change the rules",
      (await refusal(
        saveDeliveryPolicy(db, {
          teamId: workspace,
          ...admin,
          expectedVersion: 0,
          settings: DEFAULT_DELIVERY_POLICY,
        }),
      )) === "conflict" &&
        (await refusal(
          saveDeliveryPolicy(db, {
            teamId: workspace,
            ...member,
            expectedVersion: 1,
            settings: DEFAULT_DELIVERY_POLICY,
          }),
        )) === "forbidden",
    );
    const eventsBefore = received.length;
    const billsBefore = providerCalls.length;
    const saved = await saveDeliveryPolicy(db, {
      teamId: workspace,
      ...admin,
      expectedVersion: 1,
      settings: {
        ...DEFAULT_DELIVERY_POLICY,
        rules: {
          ...DEFAULT_DELIVERY_POLICY.rules,
          bank_details_changed: "deliver",
          uncertain_reading: "deliver",
        },
      },
    });
    await drain();
    const stillHeld = await read(uncertain);
    check(
      "held invoices keep their decision and nothing is re-sent after a policy change",
      saved.version === 2 &&
        stillHeld.decision?.outcome === "hold" &&
        stillHeld.decision.policyVersion === 0 &&
        stillHeld.delivery?.state === "held" &&
        received.length === eventsBefore &&
        providerCalls.length === billsBefore,
      { decision: stillHeld.decision, events: received.length - eventsBefore },
    );
    const newBank = await processed(
      extractionOf("HP-1005", {
        bankDetails: {
          accountName: "Harbour Plumbing Ltd",
          accountNumber: "11112222",
          sortCode: "11-22-33",
          iban: null,
          bic: null,
        },
      }),
      [
        {
          questionId: "known_supplier",
          label: "Known supplier",
          question: "Is the supplier known?",
          source: "default",
          type: "boolean",
          status: "answered",
          answer: true,
          probability: 0.97,
          certainty: "confident",
        },
      ],
    );
    const newBankRead = await read(newBank);
    check(
      "a new invoice is decided under the new version",
      newBankRead.decision?.outcome === "deliver" &&
        newBankRead.decision.policyVersion === 2 &&
        billsFor("HP-1005") === 1 &&
        eventsFor(newBank).some(
          (delivery) =>
            (delivery.body.data as { deliveryDecision?: Decision })
              ?.deliveryDecision?.policyVersion === 2,
        ),
      newBankRead.decision,
    );

    console.log(
      JSON.stringify(
        {
          event: "delivery_rules_verification_succeeded",
          eligible: {
            decision: validRead.decision?.outcome,
            policyVersion: validRead.decision?.policyVersion,
            accounting: (await accounting(valid))?.status,
            delivery: validRead.delivery?.state,
          },
          duplicate: {
            reasons: codes(copyRead.decision),
            release: "refused",
            resolution: dismissal?.resolution,
          },
          revised: codes(revisedRead.decision),
          changedBankDetails: {
            reason: bankReason?.message,
            releases: releases.map((result) => result.status),
            bills: billsFor("HP-1002"),
            processedEvents: bankEvents.length,
            delivery: bankAfter.delivery?.state,
          },
          missingEvidence: {
            missingNumber: codes(unnumberedRead.decision),
            lowConfidence: codes(uncertainRead.decision),
            unknownRequiredAnswer: codes(unknownRead.decision),
          },
          policyUpdate: {
            version: saved.version,
            heldStaysHeldUnder: stillHeld.decision?.policyVersion,
            resent: received.length - eventsBefore - eventsFor(newBank).length,
            newInvoiceUnder: newBankRead.decision?.policyVersion,
          },
          bills: billsByKey.size,
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
    for (const id of userIds) {
      await db.delete(users).where(eq(users.id, id));
    }
    receiver.stop(true);
    nango.stop(true);
    await database.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
