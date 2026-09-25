/**
 * Optional bank-payment reconciliation, end to end against Postgres with an
 * in-memory Salt Edge (`fake-salt-edge.ts`); nothing leaves the machine.
 *
 * Two workspaces turn bank payments on and connect a bank with explicit
 * consent. Their synced transactions then show: an invoice paid by a
 * transaction printing its number; part payments completed by a second one;
 * two plausible transactions left ambiguous until an admin chooses (with a
 * reason that survives automatic runs); an exact amount only proposed and
 * then confirmed; a credit note applied to the invoice it credits; a bank
 * charge recorded beside a payment; no match across currencies; a pending
 * payment replaced by its posted entry; a dropped pending entry; duplicates
 * never counted; a reversal undoing an automatic and a manual payment;
 * pagination with durable cursors and idempotent re-syncs; revoked consent
 * and reconnect; removal at the provider; disconnect keeping only counted
 * evidence; the neighbouring workspace never seeing or matching another's
 * transactions; immutability; and the authorization-source match untouched.
 *
 *   DATABASE_PRIMARY_URL=... bun run verify:bank-payments
 */
import { createDatabaseClient } from "@invoicewise/db/client";
import {
  getBankPaymentSettings,
  getPaymentMatch,
  listBankFeedTransactions,
} from "@invoicewise/db/queries";
import {
  bankFeedConnections,
  bankFeedTransactions,
  inbox,
  invoicePaymentMatches,
  invoiceSourceMatches,
  suppliers,
  teams,
  users,
  workflowJobs,
} from "@invoicewise/db/schema";
import type { InvoiceExtraction } from "@invoicewise/documents";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Schema } from "effect";
import {
  BankFeedError,
  completeBankConnection,
  disconnectBankConnection,
  getBankPaymentsOverview,
  handleSaltEdgeCallback,
  reconnectBankConnection,
  setBankPayments,
  startBankConnection,
  syncBankConnection,
} from "./bank-feeds";
import { createFakeSaltEdge } from "./fake-salt-edge";
import {
  PaymentMatchError,
  confirmPaymentMatch,
  matchWorkspacePayments,
  recordInvoicePayments,
} from "./payment-matching";
import type { PaymentMatchResult } from "./payment-rules";
import { saveProcessedDocument } from "./process-document";
import { createSaltEdgeClient } from "./salt-edge";
import { WorkflowRequest } from "./schema";
import { required } from "./verify-support";

const assert = (condition: unknown, message: string, detail?: unknown) => {
  if (!condition) {
    throw new Error(
      `${message}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`,
    );
  }
};

const rejects = async (
  work: () => Promise<unknown>,
  code: string,
): Promise<Error> => {
  try {
    await work();
  } catch (error) {
    if (
      (error instanceof BankFeedError || error instanceof PaymentMatchError) &&
      error.code === code
    ) {
      return error;
    }
    throw error;
  }
  throw new Error(`expected a ${code} refusal`);
};

const APP = { appId: "verify-app", secret: "verify-secret" };
const ENV = {
  ...process.env,
  BANK_PAYMENTS_ENABLED: "true",
  SALT_EDGE_APP_ID: APP.appId,
  SALT_EDGE_SECRET: APP.secret,
  INVOICEWISE_ENVIRONMENT: "staging",
  NEXT_PUBLIC_URL: "https://app.invoicewise.test",
};

const ACME = {
  supplierName: "Acme Supplies Ltd",
  supplierVatNumber: "GB123456789",
};

const extractionOf = (
  value: Partial<InvoiceExtraction> & { invoiceNumber: string },
): InvoiceExtraction =>
  ({
    documentType: "invoice",
    supplierAddress: null,
    supplierCompanyNumber: null,
    originalInvoiceNumber: null,
    invoiceDate: "2026-09-01",
    dueDate: null,
    currency: "GBP",
    netAmount: 1000,
    discountAmount: null,
    vatAmount: 200,
    taxRate: 20,
    grossAmount: 1200,
    amountsIncludeTax: false,
    lineItems: [],
    description: null,
    purchaseOrderReference: null,
    paymentReference: null,
    bankDetails: {
      accountName: null,
      accountNumber: null,
      sortCode: null,
      iban: null,
      bic: null,
    },
    textSource: "text-layer",
    pageSources: ["text-layer"],
    evidence: { fields: {}, lineItems: [] },
    ...ACME,
    ...value,
  }) as InvoiceExtraction;

/** Net and VAT for a gross amount at 20%, so validation passes. */
const amounts = (gross: number) => {
  const net = Math.round((gross / 1.2) * 100) / 100;
  return {
    netAmount: net,
    vatAmount: Math.round((gross - net) * 100) / 100,
    grossAmount: gross,
  };
};

async function main() {
  const database = createDatabaseClient({
    primaryUrl: required("DATABASE_PRIMARY_URL"),
    isDevelopment: true,
  });
  const db = database.db;
  const teamIds: string[] = [];
  const userIds: string[] = [];
  const fake = createFakeSaltEdge({ ...APP, pageSize: 3 });
  const client = createSaltEdgeClient(
    { ...APP, baseUrl: "https://www.saltedge.com/api/v6", privateKey: null },
    fake.fetcher,
  );
  let clock = Date.parse("2026-09-24T08:00:00Z");
  const deps = () => ({ env: ENV, client, now: () => new Date(clock) });
  const proof: Record<string, unknown> = {};

  const receive = async (teamId: string, extraction: InvoiceExtraction) => {
    clock += 60_000;
    const [row] = await db
      .insert(inbox)
      .values({
        teamId,
        createdAt: new Date(clock).toISOString(),
        displayName: extraction.supplierName ?? "invoice",
        fileName: `${extraction.invoiceNumber}.pdf`,
        contentType: "application/pdf",
        type: "invoice",
        status: "processing",
        intakeState: "accepted",
      })
      .returning({ id: inbox.id });
    await saveProcessedDocument(db, {
      id: row!.id,
      teamId,
      displayName: extraction.supplierName,
      type: "invoice",
      extraction,
      judgments: [],
    });
    return row!.id;
  };

  const currentOf = async (invoiceId: string) => {
    const [row] = await db
      .select({ match: invoicePaymentMatches })
      .from(inbox)
      .innerJoin(
        invoicePaymentMatches,
        eq(invoicePaymentMatches.id, inbox.paymentMatchId),
      )
      .where(eq(inbox.id, invoiceId));
    assert(row, "invoice has a current payment decision", invoiceId);
    return {
      ...row!.match,
      result: row!.match.result as unknown as PaymentMatchResult,
    };
  };
  const summary = async (invoiceId: string) => {
    const current = await currentOf(invoiceId);
    return {
      status: current.status,
      paymentStatus: current.paymentStatus,
      action: current.action,
      paid: current.paidAmount,
      remaining: current.result.remaining,
      allocations: current.result.allocations.map(
        (row) => `${row.kind} ${row.amount} ${row.currency}`,
      ),
      message: current.result.message,
    };
  };

  const connectAs = async (teamId: string, actorId: string) => {
    const started = await startBankConnection(
      db,
      { teamId, actorId, consentAccepted: true, consentPeriodDays: 90 },
      deps(),
    );
    const customerId = (await getBankPaymentSettings(db, teamId))
      ?.providerCustomerId;
    assert(customerId, "the workspace has its own Salt Edge customer");
    const bank = fake.completeConnect({ customerId: customerId! });
    return { started, customerId: customerId!, ...bank };
  };

  try {
    for (const name of ["Bank payments A", "Bank payments B"]) {
      const [team] = await db
        .insert(teams)
        .values({ name })
        .returning({ id: teams.id });
      teamIds.push(team!.id);
    }
    const [teamA, teamB] = teamIds as [string, string];
    for (const teamId of teamIds) {
      const [user] = await db
        .insert(users)
        .values({
          fullName: `Payments admin ${teamId.slice(0, 4)}`,
          email: `payments-${teamId}@invoicewise.local`,
          teamId,
        })
        .returning({ id: users.id });
      userIds.push(user!.id);
      await db.insert(suppliers).values({
        teamId,
        name: ACME.supplierName,
        nameKey: "acme supplies",
        vatKey: ACME.supplierVatNumber,
      });
    }
    const [adminA, adminB] = userIds as [string, string];

    // --- Off by default; explicit consent; one customer per workspace ------------
    const before = await getBankPaymentsOverview(db, { teamId: teamA, env: ENV });
    assert(before.enabled === false, "bank payments are off by default");
    await rejects(
      () =>
        startBankConnection(
          db,
          { teamId: teamA, actorId: adminA, consentAccepted: true },
          deps(),
        ),
      "disabled",
    );
    await rejects(
      () =>
        setBankPayments(db, {
          teamId: teamA,
          actorId: adminA,
          enabled: true,
          env: { ...ENV, BANK_PAYMENTS_ENABLED: "false" },
        }),
      "unavailable",
    );
    await rejects(
      () =>
        setBankPayments(db, {
          teamId: teamA,
          actorId: adminA,
          enabled: true,
          env: { ...ENV, INVOICEWISE_ENVIRONMENT: "production" },
        }),
      "unavailable",
    );
    for (const [teamId, actorId] of [
      [teamA, adminA],
      [teamB, adminB],
    ] as const) {
      await setBankPayments(db, { teamId, actorId, enabled: true, env: ENV });
    }
    await rejects(
      () =>
        startBankConnection(
          db,
          { teamId: teamA, actorId: adminA, consentAccepted: false },
          deps(),
        ),
      "invalid",
    );

    const a = await connectAs(teamA, adminA);
    const b = await connectAs(teamB, adminB);
    assert(a.customerId !== b.customerId, "each workspace has its own customer");
    const connectCall = fake.calls.find(
      (call) => call.path === "/connections/connect",
    )!.body as { data: { consent: { scopes: string[]; period_days: number } } };
    assert(
      JSON.stringify(connectCall.data.consent.scopes) ===
        JSON.stringify(["accounts", "transactions"]) &&
        connectCall.data.consent.period_days === 90,
      "consent asks for read-only scopes for the chosen period",
      connectCall.data.consent,
    );

    // Tenant isolation at connect: B cannot claim A's bank connection.
    await rejects(
      () =>
        completeBankConnection(
          db,
          {
            teamId: teamB,
            connectionId: b.started.connectionId,
            providerConnectionId: a.connectionId,
          },
          deps(),
        ),
      "forbidden",
    );
    const connectedA = await completeBankConnection(
      db,
      {
        teamId: teamA,
        connectionId: a.started.connectionId,
        providerConnectionId: a.connectionId,
      },
      deps(),
    );
    assert(connectedA.status === "active", "A's bank is connected");
    // B returns without a connection id: resolved from B's own customer only.
    const connectedB = await completeBankConnection(
      db,
      { teamId: teamB, connectionId: b.started.connectionId },
      deps(),
    );
    assert(connectedB.status === "active", "B's bank is connected");
    const queued = await db
      .select({ name: workflowJobs.name, payload: workflowJobs.payload })
      .from(workflowJobs)
      .where(inArray(workflowJobs.teamId, teamIds));
    assert(
      queued.filter((job) => job.name === "sync-bank-connection").length === 2,
      "connecting queues a sync per workspace",
      queued,
    );
    for (const job of queued) {
      Schema.decodeUnknownSync(WorkflowRequest)({
        name: job.name,
        payload: job.payload,
      });
    }
    // A callback naming A's customer cannot activate B's pending row.
    const [bPending] = await db
      .insert(bankFeedConnections)
      .values({
        teamId: teamB,
        status: "pending",
        consentStatus: "pending",
        consentPeriodDays: 90,
        consentGivenAt: new Date(clock).toISOString(),
      })
      .returning();
    const spoof = await handleSaltEdgeCallback(
      db,
      {
        type: "success",
        payload: {
          data: {
            connection_id: "999999",
            customer_id: a.customerId,
            custom_fields: { connection: bPending!.id },
            stage: "finish",
          },
        },
      },
      deps(),
    );
    const [stillPending] = await db
      .select()
      .from(bankFeedConnections)
      .where(eq(bankFeedConnections.id, bPending!.id));
    assert(
      spoof.outcome === "ignored" && stillPending?.status === "pending",
      "a callback for another workspace's customer cannot attach this workspace's attempt",
      spoof,
    );
    proof.tenantIsolation = { spoofedCallback: spoof.outcome };

    // --- Invoices -------------------------------------------------------------
    const inv = {
      paid: await receive(teamA, extractionOf({ invoiceNumber: "INV-1001", ...amounts(1200) })),
      partial: await receive(teamA, extractionOf({ invoiceNumber: "INV-1002", ...amounts(500) })),
      ambiguous: await receive(teamA, extractionOf({ invoiceNumber: "INV-1003", ...amounts(300) })),
      proposed: await receive(teamA, extractionOf({ invoiceNumber: "INV-1004", ...amounts(99.96) })),
      credited: await receive(teamA, extractionOf({ invoiceNumber: "INV-1005", ...amounts(420) })),
      fee: await receive(teamA, extractionOf({ invoiceNumber: "INV-1006", ...amounts(1080) })),
      euro: await receive(teamA, extractionOf({ invoiceNumber: "INV-1007", currency: "EUR", ...amounts(1200) })),
      pending: await receive(teamA, extractionOf({ invoiceNumber: "INV-1008", ...amounts(240) })),
    };
    const creditNote = await receive(
      teamA,
      extractionOf({
        documentType: "credit_note",
        invoiceNumber: "CN-0042",
        originalInvoiceNumber: "INV-1005",
        ...amounts(120),
      }),
    );
    // B has an invoice with the same number as A's.
    const invB = await receive(
      teamB,
      extractionOf({ invoiceNumber: "INV-1001", ...amounts(1200) }),
    );

    // --- Transactions at the bank ---------------------------------------------
    const tx = (description: string, amount: number, madeOn = "2026-09-10", extra: Record<string, unknown> = {}) =>
      fake.addTransaction(a.accountId, {
        status: "posted",
        made_on: madeOn,
        amount,
        currency_code: "GBP",
        description,
        ...extra,
      });
    tx("BACS ACME SUPPLIES INV-1001", -1200, "2026-09-05", {
      extra: { payee: "ACME SUPPLIES LTD" },
    });
    tx("INV-1002 PART PAYMENT", -200, "2026-09-06");
    tx("ACME SUPPLIES", -300, "2026-09-07");
    tx("ACME SUPPLIES LTD PAYMENT", -300, "2026-09-08");
    tx("CARD PAYMENT 5521", -99.96, "2026-09-09");
    tx("INV-1005 BALANCE", -300, "2026-09-11");
    tx("INV-1006 INCL CHARGES", -1085, "2026-09-12");
    tx("INV-1007 GBP", -1200, "2026-09-13");
    tx("INV-1001 DUPLICATE ENTRY", -1200, "2026-09-05", { duplicated: true });
    tx("COFFEE", -3.5, "2026-09-14");
    const pendingTx = fake.addTransaction(a.accountId, {
      status: "pending",
      made_on: "2026-09-20",
      amount: -240,
      currency_code: "GBP",
      description: "INV-1008 FASTER PAYMENT",
    });
    const droppedTx = fake.addTransaction(a.accountId, {
      status: "pending",
      made_on: "2026-09-20",
      amount: -55,
      currency_code: "GBP",
      description: "CARD HOLD",
    });
    // B's bank prints A's invoice number too; it must only ever pay B's.
    fake.addTransaction(b.accountId, {
      status: "posted",
      made_on: "2026-09-05",
      amount: -1200,
      currency_code: "GBP",
      description: "BACS INV-1001",
    });

    // --- Sync: pagination, cursors, idempotence ------------------------------------
    const first = await syncBankConnection(
      db,
      { teamId: teamA, connectionId: a.started.connectionId },
      deps(),
    );
    assert(first.outcome === "synced", "A syncs", first);
    const txCount = async (teamId: string) =>
      (
        await db
          .select({ count: sql<number>`count(*)::int` })
          .from(bankFeedTransactions)
          .where(eq(bankFeedTransactions.teamId, teamId))
      )[0]!.count;
    assert((await txCount(teamA)) === 12, "10 posted and 2 pending landed across pages", await txCount(teamA));
    const again = await syncBankConnection(
      db,
      { teamId: teamA, connectionId: a.started.connectionId },
      deps(),
    );
    assert(
      again.outcome === "synced" &&
        again.summary.postedNew === 0 &&
        (await txCount(teamA)) === 12,
      "a repeated sync resumes from the cursor and stores nothing twice",
      again,
    );
    await syncBankConnection(db, { teamId: teamB, connectionId: b.started.connectionId }, deps());
    assert((await txCount(teamB)) === 1, "B has only its own transaction");
    const aTransactions = await listBankFeedTransactions(db, { teamId: teamA });
    assert(
      aTransactions.every((row) => row.connectionId === a.started.connectionId),
      "A's transaction list holds only A's connection",
    );
    proof.sync = { first: first.outcome === "synced" ? first.summary : first, again: again.outcome === "synced" ? again.summary : again };

    // --- Matching ----------------------------------------------------------------
    const sweep = await matchWorkspacePayments(db, { teamId: teamA, now: new Date(clock) });
    await matchWorkspacePayments(db, { teamId: teamB, now: new Date(clock) });
    const paid = await summary(inv.paid);
    assert(
      paid.paymentStatus === "paid" && paid.status === "matched",
      "an invoice whose number the payment prints is paid",
      paid,
    );
    const paidAllocations = (await currentOf(inv.paid)).result.allocations;
    assert(
      paidAllocations.length === 1 &&
        aTransactions.find((row) => row.id === paidAllocations[0]!.transactionId)
          ?.duplicated === false,
      "the duplicate entry is never counted",
      paidAllocations,
    );
    const bPaid = await summary(invB);
    const bAllocation = (await currentOf(invB)).result.allocations[0];
    assert(
      bPaid.paymentStatus === "paid" &&
        !aTransactions.some((row) => row.id === bAllocation?.transactionId),
      "B's invoice is paid only by B's own transaction",
      bPaid,
    );
    assert(
      (await summary(inv.partial)).paymentStatus === "partially_paid",
      "a part payment is part paid",
    );
    const ambiguous = await summary(inv.ambiguous);
    assert(
      ambiguous.status === "ambiguous" && ambiguous.paymentStatus === "unpaid",
      "two plausible payments are ambiguous and assert nothing",
      ambiguous,
    );
    const proposed = await summary(inv.proposed);
    assert(
      proposed.status === "proposed" && proposed.paymentStatus === "unpaid",
      "an exact amount alone is only proposed",
      proposed,
    );
    const credited = await summary(inv.credited);
    const creditNoteDecision = await summary(creditNote);
    assert(
      creditNoteDecision.paymentStatus === "applied" &&
        credited.paymentStatus === "paid" &&
        credited.allocations.includes("credit 120.00 GBP") &&
        credited.allocations.includes("payment 300.00 GBP"),
      "a credit note is applied to the invoice it credits, and the rest is paid",
      { credited, creditNoteDecision },
    );
    const fee = await summary(inv.fee);
    const feeResult = (await currentOf(inv.fee)).result;
    assert(
      fee.paymentStatus === "paid" &&
        feeResult.unallocated[0]?.amount === "5.00",
      "a payment including a bank charge pays the invoice and leaves the charge",
      { fee, unallocated: feeResult.unallocated },
    );
    const euro = await summary(inv.euro);
    assert(
      euro.paymentStatus === "unpaid" && euro.status === "unmatched",
      "a transaction in another currency never pays an invoice",
      euro,
    );
    const pending = await summary(inv.pending);
    assert(
      pending.status === "pending" && pending.paymentStatus === "pending",
      "a pending payment is pending, not paid",
      pending,
    );
    proof.matched = { sweep, paid, partial: await summary(inv.partial), ambiguous, proposed, credited, fee, euro, pending };

    // --- An admin resolves: choose, confirm, record a fee -------------------------
    const ambiguousCurrent = await currentOf(inv.ambiguous);
    const ambiguousTxId = aTransactions.find(
      (row) => row.description === "ACME SUPPLIES" && row.madeOn === "2026-09-07",
    )!.id;
    const chosen = await recordInvoicePayments(db, {
      teamId: teamA,
      inboxId: inv.ambiguous,
      actorId: adminA,
      expectedMatchId: ambiguousCurrent.id,
      reason: "Remittance advice for INV-1003 names the 7 September payment.",
      payments: [{ transactionId: ambiguousTxId, amount: "300" }],
    });
    assert(chosen.paymentStatus === "paid", "an admin's choice pays it", chosen);
    await rejects(
      () =>
        recordInvoicePayments(db, {
          teamId: teamA,
          inboxId: inv.ambiguous,
          actorId: adminA,
          expectedMatchId: ambiguousCurrent.id,
          payments: [{ transactionId: ambiguousTxId, amount: "300" }],
        }),
      "conflict",
    );
    const euroTxId = aTransactions.find((row) => row.description === "INV-1007 GBP")!.id;
    const noFx = await rejects(
      () =>
        recordInvoicePayments(db, {
          teamId: teamA,
          inboxId: inv.euro,
          actorId: adminA,
          payments: [{ transactionId: euroTxId, amount: "1200" }],
        }),
      "invalid",
    );
    assert(/never converted/.test(noFx.message), "an admin cannot pay across currencies either", noFx.message);
    const confirmed = await confirmPaymentMatch(db, {
      teamId: teamA,
      inboxId: inv.proposed,
      actorId: adminA,
    });
    assert(confirmed.paymentStatus === "paid", "a confirmed proposal is paid", confirmed);
    const feeTxRow = aTransactions.find((row) => row.description === "INV-1006 INCL CHARGES")!;
    const withFee = await recordInvoicePayments(db, {
      teamId: teamA,
      inboxId: inv.fee,
      actorId: adminA,
      reason: "£5 is the bank's international payment charge.",
      payments: [{ transactionId: feeTxRow.id, amount: "1080", fee: "5" }],
    });
    assert(
      withFee.paymentStatus === "paid" &&
        ((withFee as { allocations?: unknown }).allocations as { kind: string; amount: string }[]).some(
          (row) => row.kind === "fee" && row.amount === "5.00",
        ),
      "a bank charge is recorded beside the payment and not counted as paid",
      withFee,
    );
    const rerun = await matchWorkspacePayments(db, { teamId: teamA, now: new Date(clock) });
    assert(
      (await currentOf(inv.ambiguous)).origin === "manual" && rerun.kept >= 3,
      "automatic runs keep a person's decisions",
      rerun,
    );

    // --- Second part payment; pending posted; pending dropped; reversals ------------
    tx("INV-1002 FINAL PAYMENT", -300, "2026-09-18");
    fake.removeTransaction(a.accountId, pendingTx);
    fake.removeTransaction(a.accountId, droppedTx);
    tx("INV-1008 FASTER PAYMENT", -240, "2026-09-21");
    tx("REVERSAL BACS ACME SUPPLIES INV-1001", 1200, "2026-09-22", {
      extra: { payee: "ACME SUPPLIES LTD" },
    });
    tx("RETURNED ACME SUPPLIES", 300, "2026-09-22");
    clock += 3_600_000;
    const third = await syncBankConnection(
      db,
      { teamId: teamA, connectionId: a.started.connectionId },
      deps(),
    );
    assert(
      third.outcome === "synced" &&
        third.summary.superseded === 1 &&
        third.summary.reversed >= 5,
      "the pending entry is replaced by its posted one; the dropped hold and both reversals are marked",
      third,
    );
    const statuses = await db
      .select({
        description: bankFeedTransactions.description,
        status: bankFeedTransactions.status,
      })
      .from(bankFeedTransactions)
      .where(eq(bankFeedTransactions.teamId, teamA));
    const statusOf = (description: string) =>
      statuses.filter((row) => row.description === description).map((row) => row.status);
    assert(
      statusOf("CARD HOLD").join() === "reversed" &&
        statusOf("INV-1008 FASTER PAYMENT").sort().join() === "posted,superseded" &&
        statusOf("BACS ACME SUPPLIES INV-1001").join() === "reversed",
      "transaction states follow the bank",
      statuses,
    );
    await matchWorkspacePayments(db, { teamId: teamA, now: new Date(clock) });
    const afterReversal = await summary(inv.paid);
    assert(
      afterReversal.paymentStatus === "unpaid" &&
        (afterReversal.status === "unmatched" ||
          afterReversal.status === "insufficient_evidence") &&
        (await currentOf(inv.paid)).result.proposed.length === 0,
      "a reversed payment no longer pays the invoice (and another invoice's payment is not proposed instead)",
      afterReversal,
    );
    const manualAfterReversal = await summary(inv.ambiguous);
    assert(
      manualAfterReversal.action === "reversal" &&
        manualAfterReversal.paymentStatus === "unpaid",
      "a person's decision loses only the reversed transaction",
      manualAfterReversal,
    );
    assert(
      (await summary(inv.partial)).paymentStatus === "paid",
      "the second part payment completes it",
    );
    assert(
      (await summary(inv.pending)).paymentStatus === "paid",
      "the posted payment replacing the pending one pays it",
    );
    proof.reversal = {
      invoice: afterReversal,
      manual: manualAfterReversal,
      states: statuses,
    };

    // --- Revoked consent, reconnect -------------------------------------------------
    fake.setConsent(a.connectionId, "revoked");
    const revoked = await syncBankConnection(
      db,
      { teamId: teamA, connectionId: a.started.connectionId },
      deps(),
    );
    const [revokedRow] = await db
      .select()
      .from(bankFeedConnections)
      .where(eq(bankFeedConnections.id, a.started.connectionId));
    assert(
      revoked.outcome === "reconnect_required" &&
        revokedRow?.status === "reconnect_required" &&
        revokedRow.consentStatus === "revoked",
      "revoked consent stops the sync and asks for a reconnect",
      { revoked, status: revokedRow?.status },
    );
    const skipped = await syncBankConnection(
      db,
      { teamId: teamA, connectionId: a.started.connectionId },
      deps(),
    );
    assert(skipped.outcome === "skipped", "nothing is pulled while consent is revoked", skipped);
    const renew = await reconnectBankConnection(
      db,
      {
        teamId: teamA,
        actorId: adminA,
        connectionId: a.started.connectionId,
        consentAccepted: true,
        consentPeriodDays: 180,
      },
      deps(),
    );
    assert(renew.connectUrl.includes("reconnect"), "reconnect opens the provider's page");
    fake.setConsent(a.connectionId, "active");
    const reconnected = await completeBankConnection(
      db,
      {
        teamId: teamA,
        connectionId: a.started.connectionId,
        providerConnectionId: a.connectionId,
      },
      deps(),
    );
    assert(reconnected.status === "active", "reconnected", reconnected);
    const countBefore = await txCount(teamA);
    const resumed = await syncBankConnection(
      db,
      { teamId: teamA, connectionId: a.started.connectionId },
      deps(),
    );
    assert(
      resumed.outcome === "synced" &&
        resumed.summary.postedNew === 0 &&
        (await txCount(teamA)) === countBefore,
      "after reconnect the sync resumes from its cursor",
      resumed,
    );
    proof.consent = { revoked, reconnected: reconnected.status, resumed };

    // --- Disconnect keeps only counted evidence -----------------------------------
    await rejects(
      () => setBankPayments(db, { teamId: teamA, actorId: adminA, enabled: false, env: ENV }),
      "conflict",
    );
    const beforeDisconnect = await txCount(teamA);
    const disconnected = await disconnectBankConnection(
      db,
      { teamId: teamA, actorId: adminA, connectionId: a.started.connectionId },
      deps(),
    );
    // Kept: transactions some payment decision counts, and the entries that
    // reversed or replaced them (their evidence).
    const uncountedLeft = await db.execute(sql`
      select t.id from bank_feed_transactions t
      where t.team_id = ${teamA}
        and not exists (select 1 from invoice_payment_allocations a where a.transaction_id = t.id)
        and not exists (
          select 1 from bank_feed_transactions k
          join invoice_payment_allocations a on a.transaction_id = k.id
          where k.superseded_by_id = t.id or k.reversed_by_id = t.id
        )`);
    const leftRows = Array.isArray(uncountedLeft)
      ? uncountedLeft
      : ((uncountedLeft as { rows?: unknown[] }).rows ?? []);
    assert(
      disconnected.connection.status === "disconnected" &&
        disconnected.connection.consent.status === "withdrawn" &&
        !fake.connections.has(a.connectionId) &&
        disconnected.removedTransactions > 0 &&
        (await txCount(teamA)) === beforeDisconnect - disconnected.removedTransactions &&
        leftRows.length === 0,
      "disconnect removes the provider connection and keeps only counted evidence",
      { disconnected, remaining: await txCount(teamA), leftRows },
    );
    assert(
      (await summary(inv.partial)).paymentStatus === "paid",
      "payment decisions keep their evidence after a disconnect",
    );
    await setBankPayments(db, { teamId: teamA, actorId: adminA, enabled: false, env: ENV });
    const off = await matchWorkspacePayments(db, { teamId: teamA });
    assert(off.outcome === "skipped", "nothing is matched once turned off");
    proof.disconnect = disconnected;

    // Removal at the provider (destroy callback) disconnects B.
    const destroyed = await handleSaltEdgeCallback(
      db,
      {
        type: "destroy",
        payload: {
          data: { connection_id: b.connectionId, customer_id: b.customerId },
        },
      },
      deps(),
    );
    const [bRow] = await db
      .select()
      .from(bankFeedConnections)
      .where(eq(bankFeedConnections.id, b.started.connectionId));
    assert(
      destroyed.outcome === "disconnected" && bRow?.status === "disconnected",
      "a destroy callback for B's own customer disconnects B",
      destroyed,
    );

    // --- Immutability and separation from authorization matching --------------------
    const anyMatch = await getPaymentMatch(db, {
      teamId: teamA,
      matchId: (await currentOf(inv.partial)).id,
    });
    let refused = false;
    try {
      await db
        .update(invoicePaymentMatches)
        .set({ paymentStatus: "unpaid" })
        .where(eq(invoicePaymentMatches.id, anyMatch!.id));
    } catch {
      refused = true;
    }
    assert(refused, "payment decisions are immutable");
    const sourceMatches = await db
      .select({ id: invoiceSourceMatches.id })
      .from(invoiceSourceMatches)
      .where(inArray(invoiceSourceMatches.teamId, teamIds));
    assert(
      sourceMatches.length === 0,
      "payment matching never records an authorization-source decision",
    );
    const matchJobs = await db
      .select({ name: workflowJobs.name })
      .from(workflowJobs)
      .where(
        and(
          inArray(workflowJobs.teamId, teamIds),
          eq(workflowJobs.name, "match-payments"),
        ),
      );
    assert(matchJobs.length > 0, "processing queued payment matching for the enabled workspaces");

    console.log(JSON.stringify(proof, null, 2));
    console.log("verify:bank-payments passed");
  } finally {
    if (teamIds.length) {
      await db.delete(teams).where(inArray(teams.id, teamIds));
    }
    if (userIds.length) {
      await db.delete(users).where(inArray(users.id, userIds));
    }
    await database.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
