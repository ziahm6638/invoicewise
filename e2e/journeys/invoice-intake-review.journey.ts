import {
  SYNTHETIC_INVOICE,
  signedInPage,
  waitForInvoice,
  waitForProcessed,
} from "../support/invoices";
import type { Journey } from "../support/journey";

/**
 * The core flow: a customer drops an invoice PDF into the dashboard, the
 * running API reads it (layout text, candidate mining, TypeSafe selection via
 * the loopback stub, validation, supplier identity), the customer reviews
 * the extracted fields next to the rendered original and corrects one with a
 * reason; the correction is kept with the original reading and audited.
 */
const journey: Journey = {
  id: "invoice-intake-review",
  name: "Upload, extract, review and correct an invoice",
  features: ["invoices"],
  async run(ctx) {
    const owner = await ctx.tenant("owner");
    const page = await signedInPage(ctx, owner);

    ctx.step("upload the PDF through the drop zone");
    await page.goto("/invoices");
    await page.waitForLoadState("networkidle");
    await page
      .getByText("Bring in your first invoice")
      .waitFor({ timeout: 30_000 });
    await page.locator("#upload-files").setInputFiles(SYNTHETIC_INVOICE.path);
    const deadline = Date.now() + 30_000;
    let id = "";
    while (!id && Date.now() < deadline) {
      const [row] = await ctx.query<{ id: string }>(
        "select id from inbox where team_id = $1 order by created_at desc limit 1",
        [owner.teamId],
      );
      id = row?.id ?? "";
      if (!id) await Bun.sleep(300);
    }
    if (!id) throw new Error("the dropped PDF did not create an invoice");
    await ctx.screenshot(page, "uploaded");

    ctx.step("the running app reads the invoice");
    const processed = await waitForProcessed(ctx, owner, id);
    const extraction = processed.extraction ?? {};
    const expected: [string, unknown][] = [
      ["supplierName", SYNTHETIC_INVOICE.supplierName],
      ["invoiceNumber", SYNTHETIC_INVOICE.invoiceNumber],
      ["currency", SYNTHETIC_INVOICE.currency],
      ["grossAmount", SYNTHETIC_INVOICE.grossAmount],
      ["netAmount", SYNTHETIC_INVOICE.netAmount],
      ["vatAmount", SYNTHETIC_INVOICE.vatAmount],
    ];
    for (const [field, value] of expected) {
      if (extraction[field] !== value) {
        throw new Error(
          `extracted ${field} is ${JSON.stringify(extraction[field])}, expected ${JSON.stringify(value)}`,
        );
      }
    }

    ctx.step("the original renders beside the result");
    const preview = await ctx.http(
      `${ctx.appOrigin}/api/preview?id=${encodeURIComponent(id)}`,
      { headers: { cookie: owner.cookie } },
    );
    if (
      preview.status !== 200 ||
      preview.headers.get("content-type") !== "image/png"
    ) {
      throw new Error(`original-document preview: ${preview.status}`);
    }

    ctx.step("review the invoice in the dashboard");
    await page.goto(`/invoices?inboxId=${id}`);
    await page
      .getByText(SYNTHETIC_INVOICE.invoiceNumber)
      .first()
      .waitFor({ timeout: 30_000 });
    await page.waitForLoadState("networkidle");
    await ctx.screenshot(page, "review");

    ctx.step("dismiss the finished upload panel");
    const uploads = page.getByRole("region", { name: "Uploads" });
    if (await uploads.isVisible()) {
      await uploads.getByRole("button", { name: "Clear" }).click();
      await uploads.waitFor({ state: "hidden", timeout: 10_000 });
    }

    ctx.step("correct the invoice number with a reason");
    const corrected = "INV-2026-0042-A";
    await page.getByRole("button", { name: "Correct fields" }).click();
    const input = page.locator("#correct-invoiceNumber");
    await input.fill(corrected);
    await page
      .locator("#correct-reason")
      .fill("The supplier re-issued the invoice with a suffix");
    await ctx.screenshot(page, "correction-form");
    await page.getByRole("button", { name: "Save 1 change" }).click();

    const after = await waitForInvoice(
      ctx,
      owner,
      id,
      (view) => view.correctionCount > 0,
      "the correction",
    );
    if (after.extraction?.invoiceNumber !== corrected) {
      throw new Error(
        `the corrected invoice number is ${after.extraction?.invoiceNumber}`,
      );
    }
    await page.getByText(corrected).first().waitFor({ timeout: 30_000 });
    await ctx.screenshot(page, "corrected");

    ctx.step("the original reading and the audit trail are kept");
    const [kept] = await ctx.query<{ original: string | null }>(
      "select extraction_original->>'invoiceNumber' as original from inbox where id = $1",
      [id],
    );
    if (kept?.original !== SYNTHETIC_INVOICE.invoiceNumber) {
      throw new Error(
        `the original reading was not kept: ${JSON.stringify(kept)}`,
      );
    }
    const history = await ctx.trpcQuery(owner, "inbox.history", { id });
    if (history.status !== 200 || !history.text.includes(corrected)) {
      throw new Error(
        `the correction is missing from the history: ${history.status}`,
      );
    }

    return `dropped the PDF, the app extracted ${SYNTHETIC_INVOICE.supplierName} ${SYNTHETIC_INVOICE.invoiceNumber} GBP ${SYNTHETIC_INVOICE.grossAmount} (net ${SYNTHETIC_INVOICE.netAmount} + VAT ${SYNTHETIC_INVOICE.vatAmount}), rendered the original, and a browser correction of the invoice number was saved, kept the original reading and appears in the history`;
  },
};

export default journey;
