/**
 * Clean-room integration smoke check for the public API (docs/api.md).
 *
 * It uses nothing but the documented HTTP API: no repository imports, no
 * database access and no manual edits. Give it an API key of a throwaway
 * workspace (Settings → Developer, scopes `inbox.read` and `inbox.write`):
 *
 *   INVOICEWISE_API_URL=https://iw-staging-api.zzapp.uk \
 *   INVOICEWISE_API_KEY=mid_... \
 *   bun apps/api/src/public-api-smoke.ts
 *
 * It submits a freshly generated invoice PDF (with an idempotency key, then
 * replays it), polls until it is processed, reads it, its judgments,
 * delivery and document, pages through the list and both CSV exports,
 * exercises the retry contract and queries it through the remote MCP
 * endpoint. Set SMOKE_WEBHOOK_URL to an HTTPS receiver you control (the key
 * then needs an owner or admin) to also register a webhook and wait for its
 * `invoice.processed` delivery; the endpoint is disabled again at the end.
 * Prints one JSON summary and exits non-zero on the first failed check.
 */

const apiUrl = (process.env.INVOICEWISE_API_URL ?? "").replace(/\/+$/, "");
const apiKey = process.env.INVOICEWISE_API_KEY ?? "";
const webhookUrl = process.env.SMOKE_WEBHOOK_URL?.trim() || null;
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS ?? 240_000);
const pollMs = Number(process.env.SMOKE_POLL_MS ?? 3_000);

if (!apiUrl || !apiKey) {
  console.error("Set INVOICEWISE_API_URL and INVOICEWISE_API_KEY.");
  process.exit(2);
}

class SmokeFailure extends Error {}

const check: (condition: unknown, message: string) => asserts condition = (
  condition,
  message,
) => {
  if (!condition) throw new SmokeFailure(message);
};

type Json = Record<string, any>;

const call = async (
  path: string,
  init: RequestInit & { key?: string | null } = {},
) => {
  const headers = new Headers(init.headers);
  const key = init.key === undefined ? apiKey : init.key;
  if (key) headers.set("authorization", `Bearer ${key}`);
  const response = await fetch(`${apiUrl}${path}`, { ...init, headers });
  const text = await response.text();
  let body: any = text;
  if (response.headers.get("content-type")?.includes("json")) {
    try {
      body = JSON.parse(text);
    } catch {
      // Keep the raw text for the failure message.
    }
  }
  return { status: response.status, headers: response.headers, body, text };
};

const expectStatus = (
  result: { status: number; text: string },
  status: number,
  label: string,
) =>
  check(
    result.status === status,
    `${label}: expected ${status}, got ${result.status} ${result.text.slice(0, 300)}`,
  );

const sha256 = async (bytes: Uint8Array) =>
  Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex");

/** A one-page text PDF of a plausible invoice, unique to this run. */
const invoicePdf = (reference: string) => {
  const lines = [
    "ACME SUPPLIES LTD",
    "10 Market Street, London, EC1A 1AA",
    "VAT number: GB123456789",
    "",
    "INVOICE",
    "Invoice number: INV-2026-0042",
    "Invoice date: 2026-09-01",
    "Due date: 2026-09-30",
    "Currency: GBP",
    "Bill to: InvoiceWise Ltd",
    "Purchase order reference: PO-7788",
    "Description: September consulting services",
    "",
    "Consulting services | 2 | GBP 500.00 | GBP 1,000.00",
    "",
    "Net total: GBP 1,000.00",
    "VAT: GBP 200.00",
    "Gross total: GBP 1,200.00",
    "",
    "Payment details",
    "Account name: ACME SUPPLIES LTD",
    "Account number: 12345678",
    "Sort code: 12-34-56",
    "IBAN: GB12 ACME 1234 5678 9012 34",
    "BIC: ACMEGB2L",
    "",
    `Smoke reference: ${reference}`,
  ];
  const pdfText = (value: string) => value.replace(/[\\()]/g, "\\$&");
  const content = lines
    .map(
      (line, index) =>
        `BT /F1 10 Tf 50 ${790 - index * 16} Td (${pdfText(line)}) Tj ET`,
    )
    .join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let output = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(output.length);
    output += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = output.length;
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    output += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(output);
};

const submit = (bytes: Uint8Array, key: string, name = "smoke-invoice.pdf") => {
  const form = new FormData();
  form.set("file", new File([bytes], name, { type: "application/pdf" }));
  return call("/v1/invoices", {
    method: "POST",
    body: form,
    headers: { "idempotency-key": key },
  });
};

const waitFor = async <T>(
  label: string,
  read: () => Promise<T>,
  done: (value: T) => boolean,
) => {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await read();
    if (done(last)) return last;
    await Bun.sleep(pollMs);
  }
  throw new SmokeFailure(
    `${label} did not happen within ${timeoutMs} ms: ${JSON.stringify(last).slice(0, 500)}`,
  );
};

const parseCsv = (text: string) =>
  text
    .split("\r\n")
    .filter(Boolean)
    .map((line) => {
      const cells: string[] = [];
      let cell = "";
      let quoted = false;
      for (let index = 0; index < line.length; index++) {
        const char = line[index]!;
        if (quoted) {
          if (char === '"' && line[index + 1] === '"') {
            cell += '"';
            index++;
          } else if (char === '"') quoted = false;
          else cell += char;
        } else if (char === '"') quoted = true;
        else if (char === ",") {
          cells.push(cell);
          cell = "";
        } else cell += char;
      }
      cells.push(cell);
      return cells;
    });

const mcp = (message: Json, key: string | null = apiKey) =>
  call("/v1/mcp", {
    method: "POST",
    key,
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify(message),
  });

async function main() {
  const summary: Json = { apiUrl };
  const run = crypto.randomUUID();

  // The contract is published; credentials are required and never optional.
  const contract = await call("/v1/openapi.json", { key: null });
  expectStatus(contract, 200, "contract");
  check(contract.body.paths?.["/v1/invoices"], "contract lists /v1/invoices");
  const anonymous = await call("/v1/invoices", { key: null });
  expectStatus(anonymous, 401, "request without a key");
  check(anonymous.body?.error?.code === "unauthorized", "anonymous error code");
  const forged = await call("/v1/invoices", {
    key: `mid_${"0".repeat(64)}`,
  });
  expectStatus(forged, 401, "request with an unknown key");
  summary.auth = { contract: 200, anonymous: 401, unknownKey: 401 };

  let endpoint: { id: string } | null = null;
  if (webhookUrl) {
    const registered = await call("/webhooks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: webhookUrl, events: ["invoice.processed"] }),
    });
    expectStatus(registered, 201, "webhook registration");
    endpoint = { id: registered.body.id };
    summary.webhook = { endpointId: endpoint.id };
  }

  try {
    // Submission: accepted asynchronously, replayable, never re-keyed.
    const bytes = invoicePdf(run);
    const idempotencyKey = `smoke-${run}`;
    const submitted = await submit(bytes, idempotencyKey);
    expectStatus(submitted, 202, "submission");
    const id: string = submitted.body.id;
    check(
      submitted.headers.get("location") === `/v1/invoices/${id}`,
      "submission Location header",
    );
    check(submitted.body.sha256 === (await sha256(bytes)), "submitted hash");
    const replay = await submit(bytes, idempotencyKey);
    expectStatus(replay, 202, "idempotent replay");
    check(
      replay.body.id === id && replay.body.deduplicated === true,
      "replay returns the same invoice",
    );
    const reused = await submit(invoicePdf(`${run}-other`), idempotencyKey);
    expectStatus(reused, 409, "idempotency key reused for other bytes");
    check(
      reused.body.error?.code === "idempotency_key_reused",
      "reused key error code",
    );
    summary.submission = {
      id,
      status: submitted.body.status,
      replay: "same invoice",
      reusedKey: 409,
    };

    // Asynchronous status: poll until the document is read.
    const invoice = await waitFor(
      "processing",
      async () => (await call(`/v1/invoices/${id}`)).body as Json,
      (body) => body?.status && body.status !== "processing",
    );
    check(
      invoice.status === "processed",
      `invoice ended ${invoice.status}: ${invoice.processingError}`,
    );
    check(invoice.document?.idempotencyKey === idempotencyKey, "stored key");
    summary.invoice = {
      status: invoice.status,
      revision: invoice.revision,
      supplierName: invoice.supplierName,
      invoiceNumber: invoice.invoiceNumber,
      currency: invoice.currency,
      amount: invoice.amount,
      validation: invoice.validation?.status ?? null,
      judgments: invoice.judgments?.length ?? 0,
    };

    const judgments = await call(`/v1/invoices/${id}/judgments`);
    expectStatus(judgments, 200, "judgments");
    check(Array.isArray(judgments.body.history), "judgment history");
    const delivery = await call(`/v1/invoices/${id}/delivery`);
    expectStatus(delivery, 200, "delivery status");
    const document = await call(`/v1/invoices/${id}/document`);
    expectStatus(document, 200, "document link");
    const stored = new Uint8Array(
      await (await fetch(document.body.url)).arrayBuffer(),
    );
    check(
      (await sha256(stored)) === submitted.body.sha256,
      "signed link serves the submitted bytes",
    );
    summary.reads = { judgments: 200, delivery: 200, document: "bytes match" };

    // Listing and paging: the new invoice is first, pages never repeat.
    const first = await call("/v1/invoices?limit=1");
    expectStatus(first, 200, "list");
    check(first.body.data[0]?.id === id, "newest invoice listed first");
    if (first.body.nextCursor) {
      const second = await call(
        `/v1/invoices?limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`,
      );
      expectStatus(second, 200, "second page");
      check(second.body.data[0]?.id !== id, "pages do not repeat");
    }
    const invalidCursor = await call("/v1/invoices?cursor=not-a-cursor");
    expectStatus(invalidCursor, 400, "invalid cursor");

    // Export: identifiers, revision and currency, paged, formula-safe.
    const exported = await call("/v1/exports/invoices.csv?limit=1");
    expectStatus(exported, 200, "invoice export");
    const [header, row] = parseCsv(exported.text);
    check(header && row, "export has a header and a row");
    const column = (name: string) => row![header!.indexOf(name)];
    check(column("invoice_id") === id, "export row is the invoice");
    check(column("revision") === String(invoice.revision), "export revision");
    check(column("currency") === (invoice.currency ?? ""), "export currency");
    check(column("idempotency_key") === idempotencyKey, "export key");
    const judgmentsCsv = await call("/v1/exports/judgments.csv?limit=1");
    expectStatus(judgmentsCsv, 200, "judgment export");
    check(
      judgmentsCsv.text.startsWith("invoice_id,invoice_revision,entry"),
      "judgment export header",
    );
    summary.export = {
      invoices: 200,
      judgments: 200,
      nextCursor: Boolean(exported.headers.get("x-next-cursor")),
    };

    if (endpoint) {
      const endpointId = endpoint.id;
      const delivered = await waitFor(
        "webhook delivery",
        async () => (await call(`/v1/invoices/${id}/delivery`)).body as Json,
        (body) =>
          body?.webhooks?.some(
            (item: Json) =>
              item.endpointId === endpointId &&
              item.event === "invoice.processed" &&
              item.status === "succeeded",
          ),
      );
      summary.webhook.delivered = delivered.webhooks.find(
        (item: Json) => item.endpointId === endpointId,
      )?.status;
    }

    // Retry contract: the revision read is required; a stale one conflicts.
    const retry = await call(`/v1/invoices/${id}/delivery/retry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: invoice.revision }),
    });
    expectStatus(retry, 200, "delivery retry");
    const stale = await call(`/v1/invoices/${id}/delivery/retry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: invoice.revision + 1 }),
    });
    expectStatus(stale, 409, "retry of a revision not read");
    summary.retry = {
      started: retry.body.started,
      webhooks: retry.body.webhooks,
      staleRevision: 409,
    };

    // Remote MCP with the same key.
    const init = await mcp({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "invoicewise-smoke", version: "1" },
      },
    });
    expectStatus(init, 200, "MCP initialize");
    const initialized = await mcp({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expectStatus(initialized, 202, "MCP initialized notification");
    const tools = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const toolNames = (tools.body.result?.tools ?? []).map(
      (tool: Json) => tool.name,
    );
    check(
      toolNames.includes("get_invoice") &&
        tools.body.result.tools.every(
          (tool: Json) => tool.annotations?.readOnlyHint === true,
        ),
      "MCP tools are read-only",
    );
    const read = await mcp({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "get_invoice", arguments: { id } },
    });
    check(
      read.body.result?.isError === false &&
        read.body.result.structuredContent?.id === id,
      `MCP get_invoice: ${read.text.slice(0, 300)}`,
    );
    const mcpAnonymous = await mcp(
      { jsonrpc: "2.0", id: 4, method: "tools/list" },
      null,
    );
    expectStatus(mcpAnonymous, 401, "MCP without a key");
    summary.mcp = {
      protocolVersion: init.body.result?.protocolVersion,
      tools: toolNames,
      getInvoice: "ok",
      anonymous: 401,
    };
  } finally {
    if (endpoint) {
      await call(`/webhooks/${endpoint.id}`, { method: "DELETE" });
    }
  }

  console.log(JSON.stringify({ ok: true, ...summary }, null, 2));
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exit(1);
});
