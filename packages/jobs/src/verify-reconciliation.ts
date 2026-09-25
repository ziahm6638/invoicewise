/**
 * Reconciliation proof (docs/reconciliation.md), through the real queue,
 * worker batches and Postgres against loopback Nango/Xero and webhook stubs.
 *
 * A purchase order is billed in two parts, a third invoice exceeds its
 * remainder, a credit note is applied and the order is amended; after each
 * step the proof prints the source's balance, the invoice's reconciliation
 * and its delivery decision, under a policy that holds discrepancies and
 * unresolved reconciliations. It also covers a revised copy of an invoice
 * (never counted twice), a cancelled order, a source without a currency,
 * concurrent invoices against one order (exactly one goes over), a match an
 * admin overrides (the consumption moves with it), a scope judgment that
 * explains a line without changing an amount, a decision whose
 * reconciliation never came, the immutability trigger and a neighbouring
 * workspace that is never counted.
 *
 *   DATABASE_PRIMARY_URL=... LOCAL_STORAGE_PATH=... bun run verify:reconciliation
 */
import { createDatabaseClient } from "@invoicewise/db/client";
import {
  createInbox,
  createWebhookEndpoint,
  getInboxById,
  listDeliveryDecisions,
  listReconciliationHistory,
} from "@invoicewise/db/queries";
import {
  deliveryDecisions,
  invoiceReconciliations,
  teams,
  users,
  workflowJobs,
} from "@invoicewise/db/schema";
import { createStorageClientFromEnv } from "@invoicewise/db/storage";
import {
  DEFAULT_DELIVERY_POLICY,
  type InvoiceExtraction,
  type ReconciliationResult,
  type ScopeJudge,
} from "@invoicewise/documents";
import { and, eq, sql } from "drizzle-orm";
import { Effect, Logger } from "effect";
import { completeAccountingConnection } from "./accounting";
import {
  amendAuthorizationSource,
  setAuthorizationSourceStatus,
  submitAuthorizationSources,
} from "./authorization-sources";
import { releaseHeldDelivery } from "./delivery";
import { saveDeliveryPolicy } from "./delivery-rules";
import { saveProcessedDocument } from "./process-document";
import {
  getSourceBalance,
  reconcileInvoiceMatch,
  settleStalledDecisions,
} from "./reconciliation";
import { WorkflowRuntimeLive, runWorkflowBatch } from "./runner";
import { linkInvoiceSources, matchInvoice } from "./source-matching";
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

const NORTHWIND = {
  supplierName: "Northwind Joinery Ltd",
  supplierVatNumber: "GB293445512",
};

type Decision = {
  outcome?: string;
  accounting?: string;
  webhooks?: string;
  resolution?: string | null;
  reasons?: { code?: string; message?: string }[];
};

async function main() {
  process.env.WORKFLOW_RETRY_BASE_MS = "10";
  process.env.WORKFLOW_RETRY_MAX_MS = "10";
  // Loopback webhook endpoints are accepted outside production only.
  process.env.NODE_ENV = "test";
  process.env.NANGO_SECRET_KEY = "nango-reconciliation-verification";
  process.env.NANGO_XERO_INTEGRATION_ID = "xero-invoicewise";

  const database = createDatabaseClient({
    primaryUrl: required("DATABASE_PRIMARY_URL"),
    isDevelopment: true,
  });
  const db = database.db;
  const storage = createStorageClientFromEnv();

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

  const teamIds: string[] = [];
  const userIds: string[] = [];
  const paths: string[][] = [];
  try {
    for (const name of ["Reconciliation A", "Reconciliation B"]) {
      const [team] = await db
        .insert(teams)
        .values({ name })
        .returning({ id: teams.id });
      teamIds.push(team!.id);
    }
    const [workspace, neighbour] = teamIds as [string, string];
    workspaceId = workspace;
    const [user] = await db
      .insert(users)
      .values({
        fullName: "Ada Admin",
        email: `${crypto.randomUUID()}@example.test`,
        teamId: workspace,
      })
      .returning({ id: users.id });
    userIds.push(user!.id);
    const admin = { actorId: user!.id, teamRole: "admin" as const };

    await createWebhookEndpoint(db, {
      teamId: workspace,
      userId: admin.actorId,
      url: `http://127.0.0.1:${receiver.port}/invoices`,
      events: ["invoice.processed", "invoice.reconciled"],
    });
    await completeAccountingConnection(db, {
      teamId: workspace,
      provider: "xero",
      connectionId: "xero-connection",
    });
    await enableXeroPosting(db, workspace);
    // Discrepancies and unresolved reconciliations are held; an invoice
    // with no source at all is still delivered.
    const policy = await saveDeliveryPolicy(db, {
      teamId: workspace,
      ...admin,
      expectedVersion: 0,
      settings: {
        ...DEFAULT_DELIVERY_POLICY,
        rules: {
          ...DEFAULT_DELIVERY_POLICY.rules,
          authorization_discrepancy: "hold",
          authorization_unresolved: "hold",
          authorization_missing: "deliver",
        },
      },
    });
    check("the policy holds on reconciliation", policy.version === 1);

    const drain = async () => {
      for (let round = 0; round < 80; round++) {
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

    const order = {
      type: "purchase_order",
      reference: "PO-7001",
      title: "Oak boards for the Hatfield site",
      scope: "Supply of kiln-dried oak boards for the Hatfield site",
      supplier: {
        name: NORTHWIND.supplierName,
        vatNumber: NORTHWIND.supplierVatNumber,
      },
      currency: "GBP",
      taxBasis: "exclusive",
      issuedOn: "2026-09-01",
      lines: [
        {
          reference: "1",
          description: "Oak boards",
          quantity: "100",
          unitPrice: "20.00",
        },
      ],
    };
    const submitted = await submitAuthorizationSources(db, {
      teamId: workspace,
      actorId: admin.actorId,
      sources: [
        order,
        {
          ...order,
          reference: "PO-7002",
          title: "Oak boards, second site",
          lines: [
            {
              reference: "1",
              description: "Oak boards",
              quantity: "50",
              unitPrice: "20.00",
            },
          ],
        },
        {
          ...order,
          reference: "PO-7003",
          title: "Walnut boards",
          lines: [
            {
              reference: "1",
              description: "Walnut boards",
              quantity: "50",
              unitPrice: "20.00",
            },
          ],
        },
        {
          ...order,
          reference: "PO-7004",
          title: "Ash boards",
          lines: [
            {
              reference: "1",
              description: "Ash boards",
              quantity: "50",
              unitPrice: "20.00",
            },
          ],
        },
        {
          ...order,
          reference: "PO-7005",
          title: "Oak boards, workshop",
          lines: [
            {
              reference: "1",
              description: "Oak boards",
              quantity: "50",
              unitPrice: "20.00",
            },
          ],
        },
        {
          ...order,
          reference: "PO-7006",
          title: "Beech boards",
          currency: undefined,
          lines: [
            {
              reference: "1",
              description: "Beech boards",
              quantity: "50",
              unitPrice: "20.00",
            },
          ],
        },
      ],
    });
    check(
      "the purchase orders are recorded",
      submitted.status === "applied",
      submitted,
    );
    const sourceId = (reference: string) =>
      submitted.results.find((result) => result.reference === reference)!
        .sourceId!;
    // The neighbour records its own PO-7001; it is never counted here.
    await submitAuthorizationSources(db, {
      teamId: neighbour,
      actorId: null,
      sources: [order],
    });

    let day = 1;
    const extractionOf = (
      invoiceNumber: string,
      lines: { description: string; quantity: number; unitPrice: number }[],
      overrides: Partial<InvoiceExtraction> = {},
    ): InvoiceExtraction => {
      day += 1;
      const lineItems = lines.map((line) => ({
        description: line.description,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        discountAmount: null,
        discountRate: null,
        taxRate: null,
        taxAmount: null,
        total: Math.round(line.quantity * line.unitPrice * 100) / 100,
      }));
      const net = lineItems.reduce((sum, line) => sum + line.total, 0);
      const vat = Math.round(net * 20) / 100;
      return {
        documentType: "invoice",
        ...NORTHWIND,
        supplierAddress: null,
        supplierCompanyNumber: null,
        invoiceNumber,
        originalInvoiceNumber: null,
        invoiceDate: `2026-09-${String(day).padStart(2, "0")}`,
        dueDate: "2026-10-31",
        currency: "GBP",
        netAmount: net,
        discountAmount: null,
        vatAmount: vat,
        taxRate: 20,
        grossAmount: Math.round((net + vat) * 100) / 100,
        amountsIncludeTax: false,
        lineItems: lineItems as InvoiceExtraction["lineItems"],
        bankDetails: {
          accountName: null,
          accountNumber: null,
          sortCode: null,
          iban: null,
          bic: null,
        },
        description: null,
        purchaseOrderReference: "PO-7001",
        paymentReference: null,
        textSource: "text-layer",
        pageSources: ["text-layer"],
        evidence: { fields: {}, lineItems: [] },
        ...overrides,
      } as InvoiceExtraction;
    };
    const receive = async (
      extraction: InvoiceExtraction,
      teamId = workspace,
    ) => {
      const path = [teamId, "inbox", `${crypto.randomUUID()}.pdf`];
      paths.push(path);
      await storage.upload({
        bucket: "vault",
        path,
        file: Buffer.from("%PDF-1.4\n% InvoiceWise reconciliation proof\n"),
        contentType: "application/pdf",
      });
      const created = await createInbox(db, {
        teamId,
        displayName: extraction.supplierName ?? "Invoice",
        filePath: path,
        fileName: `${extraction.invoiceNumber}.pdf`,
        contentType: "application/pdf",
        size: 44,
        status: "processing",
      });
      if (!created) throw new Error("Unable to create verification invoice");
      await saveProcessedDocument(db, {
        id: created.id,
        teamId,
        displayName: extraction.supplierName ?? "Invoice",
        type: "invoice",
        extraction,
        judgments: [],
      });
      return created.id;
    };
    const processed = async (extraction: InvoiceExtraction) => {
      const id = await receive(extraction);
      await drain();
      return id;
    };
    const read = async (id: string) => {
      const row = await getInboxById(db, { id, teamId: workspace });
      if (!row) throw new Error(`Invoice ${id} is not readable`);
      return {
        reconciliation: row.reconciliation as
          | (ReconciliationResult & { id: string; sequence: number })
          | null,
        decision: row.deliveryDecision as Decision | null,
        delivery: row.delivery,
      };
    };
    const balance = async (reference: string) => {
      const found = await getSourceBalance(db, {
        teamId: workspace,
        sourceId: sourceId(reference),
      });
      if (!found) throw new Error(`No balance for ${reference}`);
      return found;
    };
    const bills = (number: string) =>
      providerCalls.filter((call) => call === number).length;
    const eventsFor = (id: string, event: string) =>
      received.filter(
        (delivery) =>
          delivery.event === event && delivery.body.invoiceId === id,
      );
    const reasonCodes = (decision: Decision | null) =>
      (decision?.reasons ?? []).map((reason) => reason.code);
    const findingCodes = (
      reconciliation: Awaited<ReturnType<typeof read>>["reconciliation"],
    ) => [
      ...(reconciliation?.discrepancies ?? []).map((item) => item.code),
      ...(reconciliation?.unresolved ?? []).map((item) => item.code),
    ];
    const proof: Record<string, unknown>[] = [];
    const step = async (label: string, invoiceId: string, number: string) => {
      const state = await read(invoiceId);
      const po = await balance("PO-7001");
      const line = po.lines[0]!;
      const row = {
        step: label,
        reconciliation: state.reconciliation?.status ?? null,
        findings: findingCodes(state.reconciliation),
        decision: `${state.decision?.outcome ?? null}${state.decision?.resolution ? ` (${state.decision.resolution})` : ""}`,
        reasons: reasonCodes(state.decision),
        accounting: state.decision?.accounting ?? null,
        bills: bills(number),
        balance: `PO-7001 v${po.version}: authorized ${po.authorized}, committed ${po.committed}, remaining ${po.remaining} (qty ${line.committedQuantity}/${line.authorizedQuantity}, ${po.invoices} invoices)`,
      };
      proof.push(row);
      console.log(JSON.stringify(row));
      return { state, po };
    };

    // 1. The first part of the order.
    const first = await processed(
      extractionOf("NJ-1001", [
        { description: "Oak boards", quantity: 40, unitPrice: 20 },
      ]),
    );
    let seen = await step("bill part 1 (40 x 20.00)", first, "NJ-1001");
    check(
      "a partial invoice is reconciled, delivered and posted",
      seen.state.reconciliation?.status === "reconciled" &&
        seen.state.decision?.outcome === "deliver" &&
        bills("NJ-1001") === 1 &&
        seen.po.committed === "800.00" &&
        seen.po.remaining === "1200.00",
      seen,
    );
    const firstSource = seen.state.reconciliation!.sources[0]!;
    check(
      "line variances use exact decimals against the authorized line",
      firstSource.lines[0]!.quantity.variance === "-60" &&
        firstSource.lines[0]!.rate.outcome === "within" &&
        firstSource.total.variance === "-1200.00" &&
        firstSource.balance?.committedBefore === "0.00",
      firstSource,
    );
    check(
      "the revision's events carry its reconciliation and decision",
      eventsFor(first, "invoice.reconciled").length === 1 &&
        (
          eventsFor(first, "invoice.processed")[0]?.body.data as Record<
            string,
            Record<string, unknown>
          >
        )?.reconciliation?.status === "reconciled",
      received.map((item) => item.event),
    );

    // 2. The second part.
    const second = await processed(
      extractionOf("NJ-1002", [
        { description: "Oak boards", quantity: 50, unitPrice: 20 },
      ]),
    );
    seen = await step("bill part 2 (50 x 20.00)", second, "NJ-1002");
    check(
      "the second part counts the first once",
      seen.state.reconciliation?.status === "reconciled" &&
        seen.state.reconciliation.sources[0]!.balance?.committedBefore ===
          "800.00" &&
        seen.po.committed === "1800.00" &&
        seen.po.remaining === "200.00" &&
        bills("NJ-1002") === 1,
      seen,
    );

    // 3. More than the remainder.
    const third = await processed(
      extractionOf("NJ-1003", [
        { description: "Oak boards", quantity: 15, unitPrice: 20 },
      ]),
    );
    seen = await step("exceed the remainder (15 x 20.00)", third, "NJ-1003");
    const over = seen.state.reconciliation!;
    check(
      "overbilling is a discrepancy with its evidence, and holds the invoice",
      over.status === "discrepancy" &&
        over.discrepancies.map((item) => item.code).join() ===
          "over_authorized_total,line_amount_over_authorized,quantity_over_authorized" &&
        over.discrepancies[0]!.message.includes("GBP 100.00 over") &&
        over.discrepancies[0]!.evidence.source?.remainingBefore === "200.00" &&
        seen.state.decision?.outcome === "hold" &&
        reasonCodes(seen.state.decision).join() ===
          "authorization_discrepancy" &&
        bills("NJ-1003") === 0 &&
        eventsFor(third, "invoice.processed").length === 0,
      { over, decision: seen.state.decision },
    );
    check(
      "a held invoice still commits the order until it is dismissed",
      seen.po.committed === "2100.00" &&
        seen.po.remaining === "-100.00" &&
        seen.po.over === "100.00",
      seen.po,
    );

    // A revised copy of the second invoice: same number, another total.
    const revised = await processed(
      extractionOf("NJ-1002", [
        { description: "Oak boards", quantity: 55, unitPrice: 20 },
      ]),
    );
    const revisedState = await read(revised);
    check(
      "a revised document is not counted a second time",
      findingCodes(revisedState.reconciliation).includes("duplicate_invoice") &&
        revisedState.reconciliation?.discrepancies.length === 0 &&
        (await balance("PO-7001")).committed === "2100.00" &&
        reasonCodes(revisedState.decision).includes("revised_invoice"),
      revisedState,
    );

    // 4. A credit note against the order.
    const credit = await processed(
      extractionOf(
        "NJ-CN-1",
        [{ description: "Oak boards", quantity: 10, unitPrice: 20 }],
        {
          documentType: "credit_note",
        },
      ),
    );
    seen = await step("credit 10 boards", credit, "NJ-CN-1");
    check(
      "a credit reduces what is committed, without a discrepancy",
      seen.state.reconciliation?.status === "reconciled" &&
        seen.state.reconciliation.sources[0]!.balance?.invoiced === "-200.00" &&
        seen.po.committed === "1900.00" &&
        seen.po.remaining === "100.00" &&
        seen.po.lines[0]!.committedQuantity === "95",
      seen,
    );

    // 5. The order is amended: 120 boards.
    const amended = await amendAuthorizationSource(db, {
      teamId: workspace,
      actorId: admin.actorId,
      sourceId: sourceId("PO-7001"),
      source: {
        ...order,
        changeReason: "Variation 1: 20 more boards",
        lines: [
          {
            reference: "1",
            description: "Oak boards",
            quantity: "120",
            unitPrice: "20.00",
          },
        ],
      },
    });
    check("the amendment is a new version", amended.version === 2, amended);
    seen = await step("amend PO to 120 boards", third, "NJ-1003");
    check(
      "the amendment moves the balance at once and rewrites no history",
      seen.po.version === 2 &&
        seen.po.authorized === "2400.00" &&
        seen.po.committed === "1900.00" &&
        seen.po.remaining === "500.00" &&
        seen.state.reconciliation?.status === "discrepancy" &&
        seen.state.decision?.outcome === "hold",
      seen,
    );
    const released = await releaseHeldDelivery(db, {
      invoiceId: third,
      teamId: workspace,
      ...admin,
      expectedRevision: 1,
      reason: "Variation 1 covers the extra boards",
    });
    await drain();
    seen = await step("release the held invoice", third, "NJ-1003");
    check(
      "a release after the amendment posts the held invoice once",
      released.accounting === "queued" &&
        seen.state.decision?.resolution === "released" &&
        bills("NJ-1003") === 1,
      { released, seen },
    );

    // 6. Billing under the amended terms.
    const fourth = await processed(
      extractionOf(
        "NJ-1004",
        [{ description: "Oak boards", quantity: 20, unitPrice: 20 }],
        {
          invoiceDate: new Date().toISOString().slice(0, 10),
        },
      ),
    );
    seen = await step("bill 20 more under v2", fourth, "NJ-1004");
    check(
      "an invoice after the amendment is compared with the amended terms",
      seen.state.reconciliation?.status === "reconciled" &&
        seen.state.reconciliation.sources[0]!.citedVersion === 2 &&
        seen.po.committed === "2300.00" &&
        seen.po.remaining === "100.00" &&
        bills("NJ-1004") === 1,
      seen,
    );

    // History: each invoice keeps its reconciliations and decisions.
    const history = await listReconciliationHistory(db, {
      teamId: workspace,
      inboxId: third,
    });
    const decisions = await listDeliveryDecisions(db, {
      invoiceId: third,
      teamId: workspace,
    });
    check(
      "the held invoice's history shows what was decided and why",
      history.length === 1 &&
        history[0]!.status === "discrepancy" &&
        decisions.length === 1 &&
        decisions[0]!.resolutionReason ===
          "Variation 1 covers the extra boards",
      { history, decisions },
    );

    // A higher unit rate than authorized.
    const dearer = await processed(
      extractionOf("NJ-1005", [
        { description: "Oak boards", quantity: 2, unitPrice: 21.5 },
      ]),
    );
    const dearerState = await read(dearer);
    check(
      "a rate above the authorized price is a discrepancy on its line",
      dearerState.reconciliation?.discrepancies[0]?.code ===
        "rate_above_authorized" &&
        dearerState.reconciliation.discrepancies[0]!.evidence.source
          ?.unitPrice === "20" &&
        dearerState.decision?.outcome === "hold",
      dearerState.reconciliation,
    );

    // A cancelled order: billed afterwards for work dated before.
    await setAuthorizationSourceStatus(db, {
      teamId: workspace,
      actorId: admin.actorId,
      sourceId: sourceId("PO-7004"),
      status: "cancelled",
      reason: "Project stopped",
    });
    const cancelled = await processed(
      extractionOf(
        "NJ-1101",
        [{ description: "Ash boards", quantity: 5, unitPrice: 20 }],
        {
          purchaseOrderReference: "PO-7004",
        },
      ),
    );
    const cancelledState = await read(cancelled);
    check(
      "billing a cancelled order is a discrepancy",
      cancelledState.reconciliation?.discrepancies.some(
        (item) => item.code === "source_cancelled",
      ) === true && cancelledState.decision?.outcome === "hold",
      cancelledState.reconciliation,
    );

    // A source that states no currency is never assumed to be in GBP.
    const noCurrency = await processed(
      extractionOf(
        "NJ-1201",
        [{ description: "Beech boards", quantity: 5, unitPrice: 20 }],
        {
          purchaseOrderReference: "PO-7006",
        },
      ),
    );
    const noCurrencyState = await read(noCurrency);
    check(
      "a missing currency leaves the invoice unresolved and held",
      noCurrencyState.reconciliation?.status === "unresolved" &&
        findingCodes(noCurrencyState.reconciliation).join() ===
          "currency_missing" &&
        reasonCodes(noCurrencyState.decision).join() ===
          "authorization_unresolved",
      noCurrencyState,
    );

    // A supplier with no source at all: delivered, because the policy does
    // not hold on it.
    const unmatched = await processed(
      extractionOf(
        "PS-1301",
        [{ description: "Printer paper", quantity: 1, unitPrice: 30 }],
        {
          supplierName: "Paperclip Stationers Ltd",
          supplierVatNumber: "GB999000333",
          purchaseOrderReference: null,
        },
      ),
    );
    const unmatchedState = await read(unmatched);
    check(
      "an invoice with no source is unmatched and delivered as the policy says",
      unmatchedState.reconciliation?.status === "unmatched" &&
        unmatchedState.decision?.outcome === "deliver",
      unmatchedState,
    );

    // Concurrent invoices against one order: 600 + 600 of 1000.
    const concurrent = [
      await receive(
        extractionOf(
          "NJ-1401",
          [{ description: "Walnut boards", quantity: 30, unitPrice: 20 }],
          {
            purchaseOrderReference: "PO-7003",
          },
        ),
      ),
      await receive(
        extractionOf(
          "NJ-1402",
          [{ description: "Walnut boards", quantity: 30, unitPrice: 20 }],
          {
            purchaseOrderReference: "PO-7003",
          },
        ),
      ),
    ];
    const matches = await Promise.all(
      concurrent.map((invoiceId) =>
        matchInvoice(db, { teamId: workspace, invoiceId }),
      ),
    );
    await Promise.all(
      concurrent.map((invoiceId, index) =>
        reconcileInvoiceMatch(db, {
          teamId: workspace,
          invoiceId,
          matchId: (matches[index] as { matchId: string }).matchId,
          revision: 1,
        }),
      ),
    );
    await drain();
    const concurrentStates = await Promise.all(concurrent.map(read));
    const walnut = await balance("PO-7003");
    check(
      "two invoices reconciled at once consume the order once each, and exactly one goes over",
      concurrentStates.filter(
        (state) => state.reconciliation?.status === "discrepancy",
      ).length === 1 &&
        concurrentStates.filter(
          (state) => state.reconciliation?.status === "reconciled",
        ).length === 1 &&
        walnut.committed === "1200.00" &&
        walnut.remaining === "-200.00" &&
        walnut.invoices === 2,
      {
        concurrentStates: concurrentStates.map((state) => state.reconciliation),
        walnut,
      },
    );

    // An admin overrides a match: the consumption moves with it.
    const overridden = await processed(
      extractionOf(
        "NJ-1501",
        [{ description: "Oak boards", quantity: 10, unitPrice: 20 }],
        {
          purchaseOrderReference: "PO-7002",
        },
      ),
    );
    check(
      "the printed order counts the invoice first",
      (await balance("PO-7002")).committed === "200.00",
      await balance("PO-7002"),
    );
    await linkInvoiceSources(db, {
      teamId: workspace,
      inboxId: overridden,
      actorId: admin.actorId,
      reason: "Delivered to the workshop, not the second site",
      sources: [{ sourceId: sourceId("PO-7005") }],
    });
    await drain();
    const overriddenHistory = await listReconciliationHistory(db, {
      teamId: workspace,
      inboxId: overridden,
    });
    check(
      "an overridden match moves the consumption and keeps both reconciliations",
      (await balance("PO-7002")).committed === "0.00" &&
        (await balance("PO-7005")).committed === "200.00" &&
        overriddenHistory.length === 2 &&
        (overriddenHistory[0]!.result as unknown as ReconciliationResult)
          .sources[0]!.reference === "PO-7005",
      overriddenHistory.map((row) => row.status),
    );

    // A line that pairs with no authorized line is read against the scope.
    const judge: ScopeJudge = async (questions) => ({
      status: "answered",
      judgments: Object.fromEntries(
        questions.map((question) => [
          question.key,
          {
            status: "answered" as const,
            model: "verification-stub",
            answer: /delivery/i.test(question.description ?? "")
              ? ("within_scope" as const)
              : ("outside_scope" as const),
            probability: 0.93,
          },
        ]),
      ),
    });
    const scoped = await receive(
      extractionOf("NJ-1601", [
        { description: "Oak boards", quantity: 1, unitPrice: 20 },
        { description: "Delivery to site", quantity: 1, unitPrice: 15 },
        { description: "Kitchen worktop fitting", quantity: 1, unitPrice: 5 },
      ]),
    );
    const scopedMatch = await matchInvoice(db, {
      teamId: workspace,
      invoiceId: scoped,
    });
    await reconcileInvoiceMatch(db, {
      teamId: workspace,
      invoiceId: scoped,
      matchId: (scopedMatch as { matchId: string }).matchId,
      revision: 1,
      judge,
    });
    await drain();
    const scopedState = await read(scoped);
    const scopedLines = scopedState.reconciliation!.sources[0]!.lines;
    check(
      "a scope judgment explains a line but never changes an amount",
      scopedLines[1]!.scope.status === "within_scope" &&
        scopedLines[2]!.scope.status === "outside_scope" &&
        scopedState
          .reconciliation!.discrepancies.map((item) => item.code)
          .join() === "outside_scope" &&
        scopedState.reconciliation!.sources[0]!.balance?.invoiced === "40.00",
      scopedState.reconciliation,
    );

    // A revision whose reconciliation never came is decided as unresolved.
    const stranded = await receive(
      extractionOf("NJ-1701", [
        { description: "Oak boards", quantity: 1, unitPrice: 20 },
      ]),
    );
    await db
      .delete(workflowJobs)
      .where(
        and(
          eq(workflowJobs.teamId, workspace),
          sql`${workflowJobs.payload} ->> 'invoiceId' = ${stranded}`,
        ),
      );
    await db
      .update(deliveryDecisions)
      .set({ createdAt: sql`now() - interval '5 minutes'` })
      .where(eq(deliveryDecisions.invoiceId, stranded));
    const pendingBefore = await read(stranded);
    const settled = await settleStalledDecisions(db, { teamId: workspace });
    await drain();
    const strandedState = await read(stranded);
    check(
      "a decision whose reconciliation was lost is settled, never read as reconciled",
      pendingBefore.decision?.outcome === "pending" &&
        pendingBefore.delivery?.state === "pending" &&
        settled.decided === 1 &&
        strandedState.decision?.outcome === "hold" &&
        reasonCodes(strandedState.decision).join() ===
          "authorization_unresolved",
      { pendingBefore, strandedState },
    );

    // Recorded reconciliations cannot be edited.
    let refused = false;
    try {
      await db
        .update(invoiceReconciliations)
        .set({ status: "reconciled" })
        .where(eq(invoiceReconciliations.inboxId, third));
    } catch {
      refused = true;
    }
    check("recorded reconciliations are immutable", refused);

    // The neighbour's own PO-7001 invoice never touches this workspace.
    const before = (await balance("PO-7001")).committed;
    await receive(
      extractionOf("NJ-1001", [
        { description: "Oak boards", quantity: 90, unitPrice: 20 },
      ]),
      neighbour,
    );
    await drain();
    check(
      "another workspace's invoices are never counted",
      (await balance("PO-7001")).committed === before,
      { before, after: await balance("PO-7001") },
    );

    console.log(
      "\nProof: a purchase order billed in parts, over, credited and amended",
    );
    console.table(
      proof.map((row) => ({
        step: row.step,
        reconciliation: row.reconciliation,
        decision: `${row.decision}${(row.reasons as string[]).length ? ` [${(row.reasons as string[]).join(", ")}]` : ""}`,
        bills: row.bills,
        balance: row.balance,
      })),
    );
  } finally {
    for (const path of paths) {
      await storage.remove({ bucket: "vault", path }).catch(() => undefined);
    }
    for (const id of teamIds) {
      await db.delete(workflowJobs).where(eq(workflowJobs.teamId, id));
      await db.delete(teams).where(eq(teams.id, id));
    }
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
