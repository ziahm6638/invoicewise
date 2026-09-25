import {
  SYNTHETIC_INVOICE,
  signedInPage,
  syntheticInvoiceBytes,
  uploadInvoice,
  waitForInvoice,
  waitForProcessed,
} from "../support/invoices";
import type { Journey } from "../support/journey";
import { XERO_ORGANISATION } from "../support/stubs";

/**
 * The money flow: an admin connects Xero (through the loopback Nango and the
 * stateful Xero fake; nothing reaches Xero), sets the expense account and
 * switches on automatic posting for the organisation they confirm; a
 * received invoice is then read and posted exactly once as a DRAFT bill in
 * that organisation with the invoice's own amounts, supplier and number.
 */
const journey: Journey = {
  id: "accounting-delivery",
  name: "Connect Xero and post a received invoice as a draft bill",
  features: ["settings-accounting", "invoices"],
  async run(ctx) {
    const admin = await ctx.tenant("admin");

    ctx.step("start the Xero connection");
    const session = await ctx.trpcMutation(
      admin,
      "accounting.createConnectSession",
      { provider: "xero" },
    );
    if (session.status !== 200 || !session.json?.token) {
      throw new Error(
        `connect session: ${session.status} ${session.text.slice(0, 300)}`,
      );
    }
    const connectionId = ctx.stubs.nangoConnectionFor(admin.teamId);
    if (!connectionId)
      throw new Error("Nango saw no session for the workspace");

    ctx.step("bind the finished connection to the workspace");
    const completed = await ctx.trpcMutation(
      admin,
      "accounting.completeConnection",
      { provider: "xero", connectionId },
    );
    if (completed.status !== 200) {
      throw new Error(
        `complete connection: ${completed.status} ${completed.text.slice(0, 300)}`,
      );
    }

    ctx.step("nothing posts before setup");
    const early = await ctx.trpcQuery(admin, "accounting.get");
    const connection = early.json?.connections?.[0];
    if (
      connection?.organisationName !== XERO_ORGANISATION.name ||
      connection.autoPostEnabledAt
    ) {
      throw new Error(`connection after connect: ${early.text.slice(0, 400)}`);
    }

    ctx.step("set up posting for the confirmed organisation");
    const setup = await ctx.trpcQuery(admin, "accounting.setup");
    if (setup.status !== 200) {
      throw new Error(
        `setup read: ${setup.status} ${setup.text.slice(0, 300)}`,
      );
    }
    const settings = await ctx.trpcMutation(
      admin,
      "accounting.updateSettings",
      {
        provider: "xero",
        expenseAccountId: "429",
        autoPost: true,
        confirmOrganisationId: XERO_ORGANISATION.id,
      },
    );
    if (settings.status !== 200 || !settings.json?.autoPostEnabledAt) {
      throw new Error(
        `enable posting: ${settings.status} ${settings.text.slice(0, 300)}`,
      );
    }

    ctx.step("the settings page shows the connected organisation");
    const page = await signedInPage(ctx, admin);
    await page.goto("/settings/accounting");
    await page
      .getByText(XERO_ORGANISATION.name)
      .first()
      .waitFor({ timeout: 30_000 });
    await page.waitForLoadState("networkidle");
    await ctx.screenshot(page, "accounting-connected");

    ctx.step("receive an invoice");
    const uploaded = await uploadInvoice(
      ctx,
      admin,
      await syntheticInvoiceBytes(),
      "acme-september.pdf",
    );
    await waitForProcessed(ctx, admin, uploaded.id);

    ctx.step("the invoice is posted to Xero as a draft bill");
    const posted = await waitForInvoice(
      ctx,
      admin,
      uploaded.id,
      (view) => Boolean(view.accountingProviderId),
      "posting to Xero",
      90_000,
    );
    const bills = ctx.stubs.xero
      .records(XERO_ORGANISATION.id, "Invoices")
      .filter((bill) => bill.InvoiceID === posted.accountingProviderId);
    if (bills.length !== 1) {
      throw new Error(`expected exactly one Xero bill, found ${bills.length}`);
    }
    const bill = bills[0] as Record<string, any>;
    const problems: string[] = [];
    if (bill.Type !== "ACCPAY") problems.push(`Type ${bill.Type}`);
    if (bill.Status !== "DRAFT") problems.push(`Status ${bill.Status}`);
    if (bill.CurrencyCode !== SYNTHETIC_INVOICE.currency) {
      problems.push(`CurrencyCode ${bill.CurrencyCode}`);
    }
    if (bill.InvoiceNumber !== SYNTHETIC_INVOICE.invoiceNumber) {
      problems.push(`InvoiceNumber ${bill.InvoiceNumber}`);
    }
    // Xero computes totals itself: the bill carries tax-exclusive lines with
    // a tax type, so the net must be the invoice's net at 20% input VAT.
    const lines = (bill.LineItems ?? []) as Record<string, any>[];
    const netPence = lines.reduce(
      (sum, line) =>
        sum + Math.round(Number(line.Quantity) * Number(line.UnitAmount) * 100),
      0,
    );
    if (bill.LineAmountTypes !== "Exclusive") {
      problems.push(`LineAmountTypes ${bill.LineAmountTypes}`);
    }
    if (netPence !== SYNTHETIC_INVOICE.netAmount * 100) {
      problems.push(`net ${netPence / 100}`);
    }
    if (lines.some((line) => line.TaxType !== "INPUT2")) {
      problems.push("a line is not on 20% input VAT (INPUT2)");
    }
    const total = (netPence * 1.2) / 100;
    if (problems.length > 0) {
      throw new Error(
        `the Xero bill does not match the invoice: ${problems.join(", ")} (${JSON.stringify(bill).slice(0, 600)})`,
      );
    }

    ctx.step("the invoice shows it was posted");
    await page.goto(`/invoices?inboxId=${uploaded.id}`);
    await page.getByText("Xero").first().waitFor({ timeout: 30_000 });
    await page.waitForLoadState("networkidle");
    await ctx.screenshot(page, "invoice-posted");

    return `Xero connected to "${XERO_ORGANISATION.name}" via Nango, posting enabled after setup, and the received invoice became exactly one DRAFT bill (${bill.InvoiceNumber}, ${bill.CurrencyCode} ${total}) in that organisation`;
  },
};

export default journey;
