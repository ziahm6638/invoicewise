import {
  SYNTHETIC_INVOICE,
  signedInPage,
  syntheticInvoiceBytes,
  uploadInvoice,
  waitForProcessed,
} from "../support/invoices";
import type { Journey } from "../support/journey";

/**
 * Getting the money data out: an admin creates a scoped API key in Settings →
 * Developer, reads the processed invoice over the public /v1 API and pulls
 * the paged CSV export with its amounts; a read-only key cannot submit, a
 * deleted key stops working at once; the owner then requests the full
 * workspace data export and downloads the finished archive.
 */
const journey: Journey = {
  id: "invoice-export",
  name: "Export invoices over the API and as a workspace archive",
  features: ["settings-developer", "settings-data", "invoices"],
  async run(ctx) {
    const owner = await ctx.tenant("owner");
    const uploaded = await uploadInvoice(
      ctx,
      owner,
      await syntheticInvoiceBytes(),
      "acme.pdf",
    );
    await waitForProcessed(ctx, owner, uploaded.id);

    ctx.step("create API keys in Settings → Developer");
    const createKey = async (name: string, scopes: string[]) => {
      const created = await ctx.trpcMutation(owner, "apiKeys.upsert", {
        name,
        scopes,
      });
      if (created.status !== 200 || !created.json?.key) {
        throw new Error(
          `API key ${name}: ${created.status} ${created.text.slice(0, 300)}`,
        );
      }
      return { key: created.json.key as string, id: created.json.data.id };
    };
    const full = await createKey("E2E export", ["inbox.read", "inbox.write"]);
    const readOnly = await createKey("E2E read-only", ["inbox.read"]);
    const v1 = (path: string, key: string, init: RequestInit = {}) =>
      ctx.http(`${ctx.apiOrigin}${path}`, {
        ...init,
        headers: { ...(init.headers ?? {}), authorization: `Bearer ${key}` },
      });

    ctx.step("read the invoice over /v1");
    const read = await v1(`/v1/invoices/${uploaded.id}`, full.key);
    const body = (await read.json()) as Record<string, any>;
    if (
      read.status !== 200 ||
      !JSON.stringify(body).includes(SYNTHETIC_INVOICE.invoiceNumber)
    ) {
      throw new Error(
        `/v1 read: ${read.status} ${JSON.stringify(body).slice(0, 300)}`,
      );
    }

    ctx.step("export the invoices as CSV");
    const csv = await v1("/v1/exports/invoices.csv?limit=10", readOnly.key);
    const text = await csv.text();
    if (
      csv.status !== 200 ||
      !(csv.headers.get("content-type") ?? "").includes("csv")
    ) {
      throw new Error(
        `CSV export: ${csv.status} ${csv.headers.get("content-type")}`,
      );
    }
    const [header = "", ...rows] = text.trim().split("\n");
    const row = rows.find((line) => line.includes(uploaded.id)) ?? "";
    if (
      !row.includes(SYNTHETIC_INVOICE.invoiceNumber) ||
      !row.includes(SYNTHETIC_INVOICE.supplierName)
    ) {
      throw new Error(
        `the export row is missing the invoice: ${header} / ${row}`,
      );
    }
    if (!/1200(\.00?)?\b/.test(row)) {
      throw new Error(`the export row does not carry the gross amount: ${row}`);
    }

    ctx.step("a read-only key cannot submit");
    const form = new FormData();
    form.set(
      "file",
      new File([new Uint8Array(await syntheticInvoiceBytes())], "ro.pdf", {
        type: "application/pdf",
      }),
    );
    const refused = await v1("/v1/invoices", readOnly.key, {
      method: "POST",
      body: form,
    });
    if (refused.status !== 403) {
      throw new Error(
        `a read-only key submitted a document: ${refused.status}`,
      );
    }

    ctx.step("a deleted key stops working at once");
    const deleted = await ctx.trpcMutation(owner, "apiKeys.delete", {
      id: readOnly.id,
    });
    if (deleted.status !== 200)
      throw new Error(`delete key: ${deleted.status}`);
    const revoked = await v1("/v1/invoices?limit=1", readOnly.key);
    if (revoked.status !== 401) {
      throw new Error(`a deleted key still works: ${revoked.status}`);
    }

    ctx.step("the developer settings list the remaining key");
    const page = await signedInPage(ctx, owner);
    await page.goto("/settings/developer");
    await page.getByText("E2E export").first().waitFor({ timeout: 30_000 });
    await page.waitForLoadState("networkidle");
    await ctx.screenshot(page, "developer-api-keys");

    ctx.step("request the owner's workspace export");
    const requested = await ctx.trpcMutation(owner, "data.requestExport");
    if (requested.status !== 200) {
      throw new Error(
        `request export: ${requested.status} ${requested.text.slice(0, 300)}`,
      );
    }
    const deadline = Date.now() + 90_000;
    let ready: Record<string, any> | undefined;
    while (!ready && Date.now() < deadline) {
      const list = await ctx.trpcQuery(owner, "data.exports");
      ready = (list.json as Record<string, any>[] | null)?.find(
        (item) => item.status === "ready",
      );
      if (!ready) await Bun.sleep(500);
    }
    if (!ready) throw new Error("the workspace export did not become ready");
    const link = await ctx.trpcMutation(owner, "data.exportDownloadUrl", {
      id: ready.id,
    });
    const url = link.json?.url as string | undefined;
    if (link.status !== 200 || !url) {
      throw new Error(
        `export download link: ${link.status} ${link.text.slice(0, 300)}`,
      );
    }
    const archive = await ctx.http(
      url.startsWith("http") ? url : `${ctx.apiOrigin}${url}`,
      {
        headers: { cookie: owner.cookie, origin: ctx.appOrigin },
      },
    );
    const bytes = new Uint8Array(await archive.arrayBuffer());
    if (
      archive.status !== 200 ||
      bytes.length < 100 ||
      bytes[0] !== 0x50 ||
      bytes[1] !== 0x4b
    ) {
      throw new Error(
        `the export archive is not a zip: ${archive.status}, ${bytes.length} bytes`,
      );
    }
    await page.goto("/settings/data");
    await page.waitForLoadState("networkidle");
    await ctx.screenshot(page, "data-export-ready");

    return `scoped API keys created; /v1 read and the CSV export carry ${SYNTHETIC_INVOICE.invoiceNumber} at GBP ${SYNTHETIC_INVOICE.grossAmount}; a read-only key was refused a submission and a deleted key was refused at once; the owner's workspace export finished and downloaded as a ${bytes.length}-byte zip`;
  },
};

export default journey;
