import {
  SYNTHETIC_INVOICE,
  signedInPage,
  syntheticInvoiceBytes,
  uploadInvoice,
  waitForInvoice,
  waitForProcessed,
} from "../support/invoices";
import type { Journey } from "../support/journey";

/**
 * Optional bank payments (docs/bank-payments.md), end to end against the
 * loopback Salt Edge: an owner turns bank payments on, gives read-only
 * consent and signs in at the (fake) bank; the sync pages through the
 * account and the invoice whose number the payment prints becomes Paid with
 * that transaction as its evidence. Another workspace cannot sync,
 * disconnect or read any of it. The bank then reverses the payment: the next
 * sync records the reversal and the invoice is no longer paid. Finally the
 * owner disconnects, which withdraws the connection at Salt Edge.
 */
const PAYMENT = `FASTER PAYMENT ${SYNTHETIC_INVOICE.supplierName} ${SYNTHETIC_INVOICE.invoiceNumber}`;

const journey: Journey = {
  id: "bank-payments",
  name: "Connect a bank, match a payment, see its reversal, disconnect",
  features: ["settings-bank-payments", "invoices"],
  async run(ctx) {
    const owner = await ctx.tenant("owner");
    const other = await ctx.tenant("other");

    ctx.step("receive an invoice");
    const uploaded = await uploadInvoice(
      ctx,
      owner,
      await syntheticInvoiceBytes(),
      "acme-september.pdf",
    );
    await waitForProcessed(ctx, owner, uploaded.id);

    // What the owner's bank account holds: the invoice's payment, an
    // unrelated card payment and a pending entry. Pages of two, so the sync
    // follows the provider's cursor.
    ctx.stubs.seedBank(owner.teamId, [
      {
        made_on: "2026-09-10",
        amount: -SYNTHETIC_INVOICE.grossAmount,
        currency_code: SYNTHETIC_INVOICE.currency,
        description: PAYMENT,
      },
      {
        made_on: "2026-09-12",
        amount: -45.1,
        currency_code: "GBP",
        description: "TESCO STORES 2231",
      },
      {
        made_on: "2026-09-20",
        amount: -19.99,
        currency_code: "GBP",
        description: "CARD PAYMENT STATIONERY WORLD",
        status: "pending",
      },
    ]);

    ctx.step("turn bank payments on and connect with consent");
    const page = await signedInPage(ctx, owner);
    await page.goto("/settings/bank-payments");
    await page.getByRole("switch", { name: "Use bank payments" }).click();
    const connectButton = page.getByRole("button", { name: "Connect a bank" });
    await connectButton.waitFor({ timeout: 30_000 });
    if (await connectButton.isEnabled()) {
      throw new Error("Connect a bank is enabled before consent is given");
    }
    await page.getByLabel(/I allow InvoiceWise to read this bank/).click();
    await ctx.screenshot(page, "consent");
    await connectButton.click();

    ctx.step("back from the bank, the connection is active");
    await page.waitForURL(
      (url) =>
        url.pathname.endsWith("/settings/bank-payments") &&
        !url.searchParams.has("connection"),
      { timeout: 30_000 },
    );
    await page.getByText("Connected", { exact: true }).waitFor({
      timeout: 30_000,
    });
    const [bank] = ctx.stubs.bankConnectionsOf(owner.teamId);
    if (!bank) throw new Error("the fake bank saw no sign-in");
    const [connection] = await ctx.query<{
      id: string;
      status: string;
      consent_status: string;
      provider_connection_id: string;
    }>(
      "select id, status, consent_status, provider_connection_id from bank_feed_connections where team_id = $1",
      [owner.teamId],
    );
    if (
      connection?.status !== "active" ||
      connection.consent_status !== "active" ||
      connection.provider_connection_id !== bank.connectionId
    ) {
      throw new Error(
        `connection after sign-in: ${JSON.stringify(connection)}`,
      );
    }

    ctx.step("the sync imports every page once");
    const deadline = Date.now() + 60_000;
    let rows: { status: string; amount_minor: string }[] = [];
    while (Date.now() < deadline) {
      rows = await ctx.query(
        "select status, amount_minor::text from bank_feed_transactions where team_id = $1 order by made_on",
        [owner.teamId],
      );
      if (rows.length >= 3) break;
      await Bun.sleep(500);
    }
    const summary = rows.map((row) => `${row.status} ${row.amount_minor}`);
    if (
      summary.join(",") !==
      `posted -${SYNTHETIC_INVOICE.grossAmount * 100},posted -4510,pending -1999`
    ) {
      throw new Error(`imported transactions: ${summary.join(", ")}`);
    }

    ctx.step("the invoice is paid by the transaction printing its number");
    const paid = await waitForInvoice(
      ctx,
      owner,
      uploaded.id,
      (view) => view.paymentMatch?.paymentStatus === "paid",
      "the payment match",
    );
    if (
      paid.paymentMatch.status !== "matched" ||
      paid.paymentMatch.paidAmount !== `${SYNTHETIC_INVOICE.grossAmount}.00` ||
      paid.paymentMatch.allocations?.length !== 1
    ) {
      throw new Error(
        `payment decision: ${JSON.stringify(paid.paymentMatch).slice(0, 600)}`,
      );
    }
    await page.goto(`/invoices?inboxId=${uploaded.id}`);
    await page.getByText("Paid", { exact: true }).first().waitFor({
      timeout: 30_000,
    });
    await page.getByText(PAYMENT).first().waitFor({ timeout: 30_000 });
    await page.waitForLoadState("networkidle");
    await page
      .getByRole("heading", { name: "Payment", exact: true })
      .scrollIntoViewIfNeeded();
    await ctx.screenshot(page, "invoice-paid");

    ctx.step("another workspace can neither act on nor read the bank");
    // With bank payments on in its own workspace, so every refusal below is
    // about whose bank and invoice it is, not about the feature being off.
    const otherOn = await ctx.trpcMutation(other, "bankPayments.setEnabled", {
      enabled: true,
    });
    if (otherOn.status !== 200) {
      throw new Error(`enable for the other workspace: ${otherOn.text}`);
    }
    for (const [path, input] of [
      ["bankPayments.sync", { connectionId: connection.id }],
      ["bankPayments.disconnect", { connectionId: connection.id }],
      [
        "bankPayments.unlink",
        { inboxId: uploaded.id, reason: "not ours", expectedMatchId: null },
      ],
    ] as const) {
      const attempt = await ctx.trpcMutation(other, path, input);
      if (attempt.status === 200) {
        throw new Error(`${path} as another workspace: ${attempt.text}`);
      }
    }
    const foreign = await ctx.trpcQuery(other, "bankPayments.forInvoice", {
      inboxId: uploaded.id,
    });
    if (foreign.status === 200 && foreign.json?.current) {
      throw new Error("another workspace read the invoice's payment");
    }
    const otherTransactions = await ctx.trpcQuery(
      other,
      "bankPayments.transactions",
      { page: 0 },
    );
    if (
      otherTransactions.status === 200 &&
      otherTransactions.json?.data?.length
    ) {
      throw new Error("another workspace listed the owner's transactions");
    }
    const [still] = await ctx.query<{ status: string }>(
      "select status from bank_feed_connections where id = $1",
      [connection.id],
    );
    if (still?.status !== "active") {
      throw new Error(`the connection changed: ${still?.status}`);
    }

    ctx.step("the bank reverses the payment");
    ctx.stubs.addBankTransaction(owner.teamId, {
      made_on: "2026-09-11",
      amount: SYNTHETIC_INVOICE.grossAmount,
      currency_code: SYNTHETIC_INVOICE.currency,
      description: `REVERSAL ${PAYMENT}`,
    });
    const synced = await ctx.trpcMutation(owner, "bankPayments.sync", {
      connectionId: connection.id,
    });
    if (synced.status !== 200) {
      throw new Error(`sync: ${synced.status} ${synced.text.slice(0, 300)}`);
    }
    const reversed = await waitForInvoice(
      ctx,
      owner,
      uploaded.id,
      (view) =>
        Boolean(view.paymentMatch) &&
        view.paymentMatch.paymentStatus !== "paid",
      "the reversal undoing the payment",
      // A manual sync waits 30s for the bank to answer the refresh.
      150_000,
    );
    if (
      reversed.paymentMatch.paymentStatus !== "unpaid" ||
      reversed.paymentMatch.allocations?.length !== 0
    ) {
      throw new Error(
        `after the reversal: ${JSON.stringify(reversed.paymentMatch).slice(0, 600)}`,
      );
    }
    const pair = await ctx.query<{ status: string; amount_minor: string }>(
      "select status, amount_minor::text from bank_feed_transactions where team_id = $1 and description like $2 order by made_on",
      [owner.teamId, `%${SYNTHETIC_INVOICE.invoiceNumber}`],
    );
    if (pair.map((row) => row.status).join() !== "reversed,reversed") {
      throw new Error(`the payment and its reversal: ${JSON.stringify(pair)}`);
    }
    await page.goto(`/invoices?inboxId=${uploaded.id}`);
    await page.getByText("Unpaid", { exact: true }).first().waitFor({
      timeout: 30_000,
    });
    await page.waitForLoadState("networkidle");
    await page
      .getByRole("heading", { name: "Payment", exact: true })
      .scrollIntoViewIfNeeded();
    await ctx.screenshot(page, "invoice-reversed");

    ctx.step("disconnect");
    await page.goto("/settings/bank-payments");
    await page.getByRole("button", { name: "Disconnect" }).first().click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Disconnect" })
      .click();
    await page.getByText("Disconnected", { exact: true }).first().waitFor({
      timeout: 30_000,
    });
    await page.waitForLoadState("networkidle");
    await ctx.screenshot(page, "disconnected");
    const [after] = await ctx.query<{ status: string; consent_status: string }>(
      "select status, consent_status from bank_feed_connections where id = $1",
      [connection.id],
    );
    if (after?.status !== "disconnected") {
      throw new Error(`after disconnect: ${JSON.stringify(after)}`);
    }
    if (ctx.stubs.saltEdge.connections.has(bank.connectionId)) {
      throw new Error("the connection was not removed at Salt Edge");
    }

    return `consented and connected through the loopback Salt Edge; ${rows.length} transactions synced over paged cursors; ${SYNTHETIC_INVOICE.invoiceNumber} became Paid from the transaction printing its number; another workspace was refused sync, disconnect, unlink and reads; the bank's reversal marked both entries reversed and made it unpaid again; disconnect removed the connection at Salt Edge`;
  },
};

export default journey;
