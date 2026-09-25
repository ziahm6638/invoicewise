import { describe, expect, test } from "bun:test";
import type { Invoice } from "@api/effect/public-api";
import { Tool } from "@effect/ai";
import { Context, Effect, Layer } from "effect";
import { handleMcpHttp, mcpToolList } from "./http";
import {
  type ApiFetcher,
  InvoiceMcpClient,
  InvoiceMcpHandlers,
  InvoiceMcpToolkit,
  makeInvoiceMcpClient,
} from "./invoice-tools";

const invoiceId = "4a80fbd7-898f-4896-af62-f4b21621988f";

const invoice: Invoice = {
  id: invoiceId,
  revision: 1,
  status: "processed",
  createdAt: "2026-09-22T12:00:00.000Z",
  document: {
    fileName: "invoice.pdf",
    displayName: "Example Supplies",
    contentType: "application/pdf",
    size: 1024,
    sha256: "ab".repeat(32),
    source: "api",
    idempotencyKey: "order-1",
  },
  supplierId: null,
  supplierName: "Example Supplies Ltd",
  invoiceNumber: "INV-100",
  invoiceDate: "2026-09-01",
  dueDate: null,
  currency: "GBP",
  amount: 125.5,
  processingError: null,
  corrected: false,
  extraction: { invoiceNumber: "INV-100" },
  validation: { status: "valid" },
  supplierChecks: null,
  judgments: [],
  questionRerun: null,
  delivery: {
    state: "none",
    total: 0,
    succeeded: 0,
    pending: 0,
    failed: 0,
    cancelled: 0,
  },
  accounting: null,
};

const judgments = {
  invoiceId,
  revision: 1,
  judgments: [],
  history: [],
};

/** A stand-in for the v1 API that records every path it was asked for. */
const fakeApi = (routes: Record<string, [number, unknown]>) => {
  const calls: string[] = [];
  const fetcher: ApiFetcher = async (path) => {
    calls.push(path);
    const [status, body] = routes[path.split("?")[0]!] ?? [
      404,
      { error: { code: "not_found", message: "Invoice not found" } },
    ];
    return Response.json(body, { status });
  };
  return { calls, fetcher };
};

const runTool = (fetcher: ApiFetcher, name: string, input: unknown) =>
  Effect.runPromise(
    Effect.flatMap(InvoiceMcpToolkit, (toolkit) =>
      toolkit.handle(name as never, input as never),
    ).pipe(
      Effect.provide(
        InvoiceMcpHandlers.pipe(
          Layer.provide(
            Layer.succeed(InvoiceMcpClient, makeInvoiceMcpClient(fetcher)),
          ),
        ),
      ),
    ),
  );

const rpc = (fetcher: ApiFetcher, body: unknown, method = "POST") =>
  handleMcpHttp(
    new Request("http://api.test/v1/mcp", {
      method,
      headers: { "content-type": "application/json" },
      body: method === "POST" ? JSON.stringify(body) : undefined,
    }),
    fetcher,
  );

describe("InvoiceWise MCP tools", () => {
  test("every tool is read-only and takes no workspace argument", () => {
    for (const tool of Object.values(InvoiceMcpToolkit.tools)) {
      expect(Context.get(tool.annotations, Tool.Readonly)).toBe(true);
      expect(Context.get(tool.annotations, Tool.Destructive)).toBe(false);
    }
    for (const tool of mcpToolList()) {
      const properties = Object.keys(
        (tool.inputSchema as { properties?: object }).properties ?? {},
      );
      expect(properties.some((name) => /team|workspace/i.test(name))).toBe(
        false,
      );
      expect(tool.annotations.readOnlyHint).toBe(true);
    }
    expect(mcpToolList().map((tool) => tool.name)).toEqual([
      "list_invoices",
      "get_invoice",
      "get_invoice_judgments",
      "get_invoice_delivery",
    ]);
  });

  test("lists through the versioned API with the given filters", async () => {
    const api = fakeApi({
      "/v1/invoices": [
        200,
        { data: [invoice], hasMore: false, nextCursor: null },
      ],
    });
    const result = await runTool(api.fetcher, "list_invoices", {
      limit: 10,
      status: "processed",
    });
    expect(api.calls).toEqual(["/v1/invoices?status=processed&limit=10"]);
    expect(result.encodedResult).toMatchObject({ data: [{ id: invoiceId }] });
  });

  test("reads judgments from their own endpoint", async () => {
    const api = fakeApi({
      [`/v1/invoices/${invoiceId}/judgments`]: [200, judgments],
    });
    const result = await runTool(api.fetcher, "get_invoice_judgments", {
      id: invoiceId,
    });
    expect(result.encodedResult).toEqual(judgments);
  });

  test("reports the API's error code and message", async () => {
    const api = fakeApi({});
    const exit = await Effect.runPromiseExit(
      makeInvoiceMcpClient(api.fetcher).detail(invoiceId),
    );
    expect(exit._tag).toBe("Failure");
    expect(JSON.stringify(exit)).toContain("not_found");
  });
});

describe("InvoiceWise MCP over HTTP", () => {
  test("initializes with the requested protocol version and tools capability", async () => {
    const response = await rpc(fakeApi({}).fetcher, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result: { protocolVersion: string; capabilities: object };
    };
    expect(body.result.protocolVersion).toBe("2025-03-26");
    expect(body.result.capabilities).toEqual({
      tools: { listChanged: false },
    });
  });

  test("acknowledges notifications without a body", async () => {
    const response = await rpc(fakeApi({}).fetcher, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
  });

  test("lists tools with input and output schemas", async () => {
    const response = await rpc(fakeApi({}).fetcher, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    const body = (await response.json()) as {
      result: { tools: { name: string; inputSchema: { type: string } }[] };
    };
    expect(body.result.tools).toHaveLength(4);
    expect(body.result.tools[0]?.inputSchema.type).toBe("object");
  });

  test("calls a tool and returns structured content", async () => {
    const api = fakeApi({ [`/v1/invoices/${invoiceId}`]: [200, invoice] });
    const response = await rpc(api.fetcher, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "get_invoice", arguments: { id: invoiceId } },
    });
    const body = (await response.json()) as {
      result: { isError: boolean; structuredContent: { id: string } };
    };
    expect(body.result.isError).toBe(false);
    expect(body.result.structuredContent.id).toBe(invoiceId);
  });

  test("a refused call is a tool error carrying the API's code", async () => {
    const response = await rpc(fakeApi({}).fetcher, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "get_invoice", arguments: { id: invoiceId } },
    });
    const body = (await response.json()) as {
      result: {
        isError: boolean;
        structuredContent: { error: { status: number; code: string } };
      };
    };
    expect(body.result.isError).toBe(true);
    expect(body.result.structuredContent.error).toMatchObject({
      status: 404,
      code: "not_found",
    });
  });

  test("invalid arguments are reported without calling the API", async () => {
    const api = fakeApi({});
    const response = await rpc(api.fetcher, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "get_invoice", arguments: { id: "not-a-uuid" } },
    });
    const body = (await response.json()) as {
      result: { isError: boolean; structuredContent: { error: object } };
    };
    expect(body.result.isError).toBe(true);
    expect(body.result.structuredContent.error).toMatchObject({
      code: "invalid_arguments",
    });
    expect(api.calls).toEqual([]);
  });

  test("an unknown tool or method is a JSON-RPC error", async () => {
    const unknownTool = (await (
      await rpc(fakeApi({}).fetcher, {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "delete_invoice", arguments: {} },
      })
    ).json()) as { error: { code: number } };
    expect(unknownTool.error.code).toBe(-32602);
    const unknownMethod = (await (
      await rpc(fakeApi({}).fetcher, {
        jsonrpc: "2.0",
        id: 7,
        method: "resources/list",
      })
    ).json()) as { error: { code: number } };
    expect(unknownMethod.error.code).toBe(-32601);
  });

  test("refuses a server stream and malformed JSON", async () => {
    const get = await rpc(fakeApi({}).fetcher, null, "GET");
    expect(get.status).toBe(405);
    const malformed = await handleMcpHttp(
      new Request("http://api.test/v1/mcp", { method: "POST", body: "{" }),
      fakeApi({}).fetcher,
    );
    expect(malformed.status).toBe(400);
  });
});
