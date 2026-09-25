/**
 * Walkthrough against the real Salt Edge sandbox (docs/bank-payments.md,
 * "Proof"): connect -> sync -> match -> reverse -> disconnect, through the
 * same services the product uses, on a disposable database.
 *
 *   bun run prove:bank-sandbox start       # prints the Salt Edge connect URL
 *   (complete the Fake Bank Simple sign-in: login "username…", password "secret")
 *   bun run prove:bank-sandbox complete    # attach the connection, sync
 *   bun run prove:bank-sandbox match       # invoices paid by real sandbox transactions
 *   bun run prove:bank-sandbox reverse     # a reversal of a counted payment
 *   bun run prove:bank-sandbox revoke      # revoke the consent at Salt Edge, sync
 *   bun run prove:bank-sandbox reconnect   # prints the reconnect URL; then "complete"
 *   bun run prove:bank-sandbox disconnect  # remove at Salt Edge, prune evidence
 *
 * The match step expects Fake Bank Simple's sample data (a Boots and a John
 * Lewis card payment). Needs SALT_EDGE_APP_ID / SALT_EDGE_SECRET of a sandbox (test-status) app
 * and DATABASE_PRIMARY_URL naming a disposable database (`*_test`). State is
 * kept in BANK_SANDBOX_STATE (default ./.bank-sandbox-proof.json). Prints ids,
 * statuses and amounts only, never credentials.
 */
import { createDatabaseClient } from "@invoicewise/db/client";
import {
  getBankPaymentSettings,
  listBankFeedTransactions,
} from "@invoicewise/db/queries";
import {
  bankFeedAccounts,
  bankFeedConnections,
  bankFeedTransactions,
  inbox,
  invoicePaymentMatches,
  teams,
  users,
} from "@invoicewise/db/schema";
import type { InvoiceExtraction } from "@invoicewise/documents";
import { and, desc, eq } from "drizzle-orm";
import {
  BankSyncNotReady,
  completeBankConnection,
  disconnectBankConnection,
  reconnectBankConnection,
  setBankPayments,
  startBankConnection,
  syncBankConnection,
} from "./bank-feeds";
import {
  confirmPaymentMatch,
  matchWorkspacePayments,
} from "./payment-matching";
import type { PaymentMatchResult } from "./payment-rules";
import { saveProcessedDocument } from "./process-document";
import { bankPaymentsAvailability, createSaltEdgeClient } from "./salt-edge";
import { required } from "./verify-support";

const STATE = process.env.BANK_SANDBOX_STATE ?? ".bank-sandbox-proof.json";
const env = {
  ...process.env,
  BANK_PAYMENTS_ENABLED: "true",
  INVOICEWISE_ENVIRONMENT: process.env.INVOICEWISE_ENVIRONMENT || "development",
};

type State = {
  teamId: string;
  actorId: string;
  connectionId: string;
  invoices?: Record<string, string>;
};

const readState = async (): Promise<State> => {
  const file = Bun.file(STATE);
  if (!(await file.exists())) throw new Error(`run "start" first (${STATE})`);
  return (await file.json()) as State;
};

const print = (label: string, value: unknown) =>
  console.log(`${label}: ${JSON.stringify(value, null, 2)}`);

async function main(step: string | undefined) {
  const url = required("DATABASE_PRIMARY_URL");
  if (!/_test(\?|$)/.test(new URL(url).pathname + new URL(url).search)) {
    throw new Error(
      "DATABASE_PRIMARY_URL must name a disposable *_test database",
    );
  }
  const availability = bankPaymentsAvailability(env);
  if (!availability.available) throw new Error(availability.message);
  const client = createSaltEdgeClient(availability.config);
  const database = createDatabaseClient({
    primaryUrl: url,
    isDevelopment: true,
  });
  const db = database.db;
  const deps = { env, client };
  try {
    if (step === "start") {
      const [team] = await db
        .insert(teams)
        .values({ name: `Salt Edge sandbox proof ${new Date().toISOString()}` })
        .returning({ id: teams.id });
      const [user] = await db
        .insert(users)
        .values({
          fullName: "Sandbox proof admin",
          email: `bank-sandbox-${team!.id}@invoicewise.local`,
          teamId: team!.id,
        })
        .returning({ id: users.id });
      await setBankPayments(db, {
        teamId: team!.id,
        actorId: user!.id,
        enabled: true,
        env,
      });
      const started = await startBankConnection(
        db,
        {
          teamId: team!.id,
          actorId: user!.id,
          consentAccepted: true,
          consentPeriodDays: 90,
        },
        deps,
      );
      await Bun.write(
        STATE,
        JSON.stringify({
          teamId: team!.id,
          actorId: user!.id,
          connectionId: started.connectionId,
        }),
      );
      print("workspace", {
        teamId: team!.id,
        connectionId: started.connectionId,
      });
      console.log(`connect URL: ${started.connectUrl}`);
      return;
    }

    const state = await readState();
    const connection = async () =>
      (
        await db
          .select()
          .from(bankFeedConnections)
          .where(eq(bankFeedConnections.id, state.connectionId))
      )[0]!;
    const sync = async () => {
      for (let attempt = 1; attempt <= 20; attempt += 1) {
        try {
          return await syncBankConnection(
            db,
            {
              teamId: state.teamId,
              connectionId: state.connectionId,
              finalAttempt: attempt === 20,
            },
            deps,
          );
        } catch (error) {
          if (!(error instanceof BankSyncNotReady)) throw error;
          console.log("Salt Edge is still fetching; waiting 5s");
          await Bun.sleep(5_000);
        }
      }
    };
    const transactions = () =>
      listBankFeedTransactions(db, { teamId: state.teamId, limit: 500 });

    if (step === "complete") {
      const completed = await completeBankConnection(
        db,
        { teamId: state.teamId, connectionId: state.connectionId },
        deps,
      );
      print("connection", {
        status: completed.status,
        bank: completed.bankName,
        consent: completed.consent,
      });
      const synced = await sync();
      print("sync", synced);
      const again = await sync();
      print("sync again (idempotent)", again);
      const rows = await transactions();
      print(
        "transactions",
        rows.map((row) => ({
          madeOn: row.madeOn,
          amount: row.amount,
          currency: row.currency,
          status: row.status,
          duplicated: row.duplicated,
          description: row.description,
        })),
      );
      return;
    }

    if (step === "match") {
      // Invoices for real Fake Bank Simple transactions: Boots prints its
      // branch reference (asserted paid automatically), John Lewis only its
      // name and the exact amount (proposed, then confirmed by an admin).
      const rows = (await transactions()).filter(
        (row) => row.status === "posted" && !row.duplicated,
      );
      const find = (needle: string) => {
        const row = rows.find((item) => item.description.includes(needle));
        if (!row) throw new Error(`no sandbox transaction "${needle}"`);
        return row;
      };
      const plan = [
        {
          label: "referenced",
          row: find("BOOTS 773"),
          supplierName: "Boots UK Limited",
          invoiceNumber: "BOOTS-773",
        },
        {
          label: "proposed",
          row: find("JOHN LEWIS"),
          supplierName: "John Lewis plc",
          invoiceNumber: `JL-${Date.now()}`,
        },
      ];
      const invoices: Record<string, string> = {};
      for (const { label, row, supplierName, invoiceNumber } of plan) {
        // Invoices carry two decimal places; the bank may report more.
        const gross = Math.round(Math.abs(Number(row.amount)) * 100) / 100;
        const net = Math.round((gross / 1.2) * 100) / 100;
        const extraction = {
          documentType: "invoice",
          supplierName,
          supplierAddress: null,
          supplierVatNumber: null,
          supplierCompanyNumber: null,
          originalInvoiceNumber: null,
          invoiceNumber,
          invoiceDate: row.madeOn,
          dueDate: null,
          currency: row.currency,
          netAmount: net,
          discountAmount: null,
          vatAmount: Math.round((gross - net) * 100) / 100,
          taxRate: 20,
          grossAmount: gross,
          amountsIncludeTax: false,
          lineItems: [],
          description: "Salt Edge sandbox proof",
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
        } as unknown as InvoiceExtraction;
        const [created] = await db
          .insert(inbox)
          .values({
            teamId: state.teamId,
            displayName: supplierName,
            fileName: `${invoiceNumber}.pdf`,
            contentType: "application/pdf",
            type: "invoice",
            status: "processing",
            intakeState: "accepted",
          })
          .returning({ id: inbox.id });
        await saveProcessedDocument(db, {
          id: created!.id,
          teamId: state.teamId,
          displayName: supplierName,
          type: "invoice",
          extraction,
          judgments: [],
        });
        invoices[label] = created!.id;
        print(`invoice ${label}`, {
          supplierName,
          invoiceNumber,
          gross: `${gross} ${row.currency}`,
          sandboxTransaction: `${row.madeOn} ${row.amount} ${row.currency} ${row.description}`,
        });
      }
      await Bun.write(STATE, JSON.stringify({ ...state, invoices }));
      print(
        "sweep",
        await matchWorkspacePayments(db, { teamId: state.teamId }),
      );
      await showDecisions(db, invoices);
      const confirmed = await confirmPaymentMatch(db, {
        teamId: state.teamId,
        inboxId: invoices.proposed!,
        actorId: state.actorId,
      });
      print("admin confirmed the proposal", {
        paymentStatus: confirmed.paymentStatus,
        action: confirmed.action,
      });
      const rerun = await matchWorkspacePayments(db, { teamId: state.teamId });
      print("sweep again (idempotent, keeps the admin decision)", rerun);
      await showDecisions(db, invoices);
      return;
    }

    if (step === "reverse") {
      // Salt Edge's sandbox cannot post a reversal of its own fake data, so
      // the reversing entry the bank would send is recorded on the synced
      // sandbox account exactly as a sync stores one; the sync's own
      // reconciliation then detects it from the evidence rules.
      const invoices = state.invoices ?? {};
      const current = await db
        .select({ result: invoicePaymentMatches.result })
        .from(inbox)
        .innerJoin(
          invoicePaymentMatches,
          eq(invoicePaymentMatches.id, inbox.paymentMatchId),
        )
        .where(eq(inbox.id, invoices.referenced!));
      const counted = (
        current[0]?.result as unknown as PaymentMatchResult
      )?.allocations.find((row) => row.kind === "payment");
      if (!counted?.transactionId) throw new Error("run match first");
      const [original] = await db
        .select()
        .from(bankFeedTransactions)
        .where(eq(bankFeedTransactions.id, counted.transactionId));
      const madeOn = new Date(
        Date.parse(`${original!.madeOn}T00:00:00Z`) + 86_400_000,
      )
        .toISOString()
        .slice(0, 10);
      await db.insert(bankFeedTransactions).values({
        teamId: state.teamId,
        connectionId: original!.connectionId,
        accountId: original!.accountId,
        providerTransactionId: `proof-reversal-${original!.providerTransactionId}`,
        status: "posted",
        mode: "normal",
        madeOn,
        amount: String(-Number(original!.amount)),
        currency: original!.currency,
        description: `REVERSAL ${original!.description}`,
        counterparty: original!.counterparty,
        reference: original!.reference,
        fingerprint: `proof-reversal-${original!.id}`,
      });
      print("reversing entry", {
        madeOn,
        amount: -Number(original!.amount),
        description: `REVERSAL ${original!.description}`,
      });
      print("sync", await sync());
      const [reversed] = await db
        .select({
          status: bankFeedTransactions.status,
          reversal: bankFeedTransactions.reversal,
        })
        .from(bankFeedTransactions)
        .where(eq(bankFeedTransactions.id, original!.id));
      print("original transaction", reversed);
      print(
        "sweep",
        await matchWorkspacePayments(db, { teamId: state.teamId }),
      );
      await showDecisions(db, invoices);
      return;
    }

    if (step === "revoke") {
      // Revoked at the provider, as a customer revoking at their bank would.
      const row = await connection();
      const consents = await client.listConsents(row.providerConnectionId!);
      const active = consents.find((item) => item.status === "active");
      if (!active) throw new Error("no active consent to revoke");
      await client.revokeConsent(active.id, row.providerConnectionId!);
      print("consent revoked at Salt Edge", { consentId: active.id });
      print("sync", await sync());
      const after = await connection();
      print("connection", {
        status: after.status,
        consent: after.consentStatus,
        error: after.lastSyncError,
      });
      return;
    }

    if (step === "reconnect") {
      const renewed = await reconnectBankConnection(
        db,
        {
          teamId: state.teamId,
          actorId: state.actorId,
          connectionId: state.connectionId,
          consentAccepted: true,
          consentPeriodDays: 30,
        },
        deps,
      );
      console.log(`reconnect URL: ${renewed.connectUrl}`);
      return;
    }

    if (step === "disconnect") {
      const before = (await transactions()).length;
      const result = await disconnectBankConnection(
        db,
        {
          teamId: state.teamId,
          actorId: state.actorId,
          connectionId: state.connectionId,
        },
        deps,
      );
      const row = await connection();
      const atProvider = await client
        .getConnection(row.providerConnectionId!)
        .then(() => "still present")
        .catch((error: Error) => `gone (${error.message})`);
      print("disconnect", {
        status: result.connection.status,
        consent: result.connection.consent.status,
        transactionsBefore: before,
        removed: result.removedTransactions,
        kept: (await transactions()).length,
        atSaltEdge: atProvider,
      });
      await showDecisions(db, state.invoices ?? {});
      const settings = await getBankPaymentSettings(db, state.teamId);
      // The sandbox customer is removed too, as workspace deletion would.
      if (settings?.providerCustomerId) {
        await client.removeCustomer(settings.providerCustomerId);
        print("sandbox customer removed", true);
      }
      return;
    }

    if (step === "status") {
      const row = await connection();
      print("connection", {
        status: row.status,
        consent: row.consentStatus,
        expires: row.consentExpiresAt,
        sync: row.lastSyncSummary,
      });
      const accounts = await db
        .select({
          name: bankFeedAccounts.name,
          cursor: bankFeedAccounts.postedCursor,
        })
        .from(bankFeedAccounts)
        .where(eq(bankFeedAccounts.teamId, state.teamId));
      print("accounts", accounts);
      await showDecisions(db, state.invoices ?? {});
      return;
    }
    throw new Error(
      "step: start | complete | match | reverse | revoke | reconnect | disconnect | status",
    );
  } finally {
    await database.close();
  }
}

async function showDecisions(
  db: ReturnType<typeof createDatabaseClient>["db"],
  invoices: Record<string, string>,
) {
  for (const [label, id] of Object.entries(invoices)) {
    const decisions = await db
      .select({
        sequence: invoicePaymentMatches.sequence,
        status: invoicePaymentMatches.status,
        paymentStatus: invoicePaymentMatches.paymentStatus,
        action: invoicePaymentMatches.action,
        paid: invoicePaymentMatches.paidAmount,
        result: invoicePaymentMatches.result,
      })
      .from(invoicePaymentMatches)
      .where(and(eq(invoicePaymentMatches.inboxId, id)))
      .orderBy(desc(invoicePaymentMatches.sequence));
    print(
      `decisions ${label}`,
      decisions.map((row) => ({
        sequence: row.sequence,
        status: row.status,
        paymentStatus: row.paymentStatus,
        action: row.action,
        paid: row.paid,
        message: (row.result as { message?: string }).message,
      })),
    );
  }
}

main(process.argv[2]).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
