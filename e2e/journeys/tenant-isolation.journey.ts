import { createHash } from "node:crypto";
import {
  postUpload,
  syntheticInvoiceBytes,
  uploadInvoice,
} from "../support/invoices";
import type { Journey } from "../support/journey";

/**
 * Two customers in two workspaces: the second can never read, preview or
 * query the first one's invoice through any surface (dashboard proxy and
 * preview, the API's tRPC), an anonymous request reads nothing, and a forged
 * storage path in the upload is ignored in favour of the server-owned one.
 */
const journey: Journey = {
  id: "tenant-isolation",
  name: "Workspace isolation across every read surface",
  features: ["invoices"],
  async run(ctx) {
    const owner = await ctx.tenant("owner");
    const other = await ctx.tenant("other");
    if (owner.teamId === other.teamId) {
      throw new Error("the two tenants share one workspace");
    }

    ctx.step("upload with a forged storage path");
    const bytes = await syntheticInvoiceBytes();
    const forged = await postUpload(ctx, owner, () => {
      const form = new FormData();
      form.set(
        "file",
        new File([new Uint8Array(bytes)], "invoice.pdf", {
          type: "application/pdf",
        }),
      );
      form.set("path", JSON.stringify([other.teamId, "inbox", "forged.pdf"]));
      form.set("bucket", "vault");
      return form;
    });
    const forgedBody = forged.body ?? {};
    if (forged.status !== 200 || !forgedBody.id) {
      throw new Error(`upload failed: ${forged.status}`);
    }
    if (forgedBody.path?.[0] !== owner.teamId) {
      throw new Error(
        `the stored path is not bound to the uploader's workspace: ${JSON.stringify(forgedBody.path)}`,
      );
    }
    const id = forgedBody.id;

    ctx.step("owner reads the original bytes");
    const proxy = await ctx.http(
      `${ctx.appOrigin}/api/proxy?id=${encodeURIComponent(id)}`,
      { headers: { cookie: owner.cookie } },
    );
    if (proxy.status !== 200) throw new Error(`owner proxy: ${proxy.status}`);
    const hash = (data: Uint8Array) =>
      createHash("sha256").update(data).digest("hex");
    if (hash(new Uint8Array(await proxy.arrayBuffer())) !== hash(bytes)) {
      throw new Error("the proxied document is not the uploaded bytes");
    }
    if (!(proxy.headers.get("cache-control") ?? "").includes("no-store")) {
      throw new Error("the document proxy response is cacheable");
    }
    if (proxy.headers.get("x-content-type-options") !== "nosniff") {
      throw new Error("the document proxy response is missing nosniff");
    }

    ctx.step("the other workspace is refused everywhere");
    for (const path of ["/api/proxy", "/api/preview"]) {
      const foreign = await ctx.http(
        `${ctx.appOrigin}${path}?id=${encodeURIComponent(id)}`,
        { headers: { cookie: other.cookie } },
      );
      if (foreign.status !== 404) {
        throw new Error(`other workspace got ${foreign.status} from ${path}`);
      }
    }
    const foreignTrpc = await ctx.trpcQuery(other, "inbox.getById", { id });
    if (foreignTrpc.text.includes(id) && foreignTrpc.status === 200) {
      throw new Error("the other workspace read the invoice over tRPC");
    }
    const foreignList = await ctx.trpcQuery(other, "inbox.get", {});
    if (foreignList.text.includes(id)) {
      throw new Error("the invoice appears in the other workspace's list");
    }
    const anonymous = await ctx.http(
      `${ctx.appOrigin}/api/proxy?id=${encodeURIComponent(id)}`,
    );
    if (anonymous.status === 200) {
      throw new Error("an anonymous request read an invoice document");
    }

    ctx.step("durable work belongs to the owner only");
    const [owned] = await ctx.query<{ count: string }>(
      "select count(*)::text as count from workflow_jobs where team_id = $1 and payload::text like $2",
      [owner.teamId, `%${id}%`],
    );
    if (Number(owned?.count ?? 0) < 1) {
      throw new Error("the upload queued no processing work");
    }
    const [leaked] = await ctx.query<{ count: string }>(
      "select count(*)::text as count from workflow_jobs where team_id = $1",
      [other.teamId],
    );
    if (Number(leaked?.count ?? 0) !== 0) {
      throw new Error("the other workspace received the owner's work");
    }

    ctx.step("the seeded bystander workspace stays invisible");
    const bystander = await ctx.trpcQuery(owner, "inbox.get", {});
    if (bystander.status !== 200) {
      throw new Error(`owner inbox list: ${bystander.status}`);
    }

    // A second upload of the same bytes by the other workspace is its own.
    const theirs = await uploadInvoice(ctx, other, bytes, "invoice.pdf");
    if (theirs.id === id || theirs.path[0] !== other.teamId) {
      throw new Error("the same file in another workspace was not kept apart");
    }

    return "forged upload path ignored; owner proxied the exact bytes (no-store, nosniff); the other workspace and anonymous callers were refused on proxy, preview, tRPC and the list; queued work stayed per workspace";
  },
};

export default journey;
