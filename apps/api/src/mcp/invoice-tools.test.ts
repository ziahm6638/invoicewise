import { describe, expect, test } from "bun:test";
import type { Invoice } from "@api/effect/public-api";
import { Tool } from "@effect/ai";
import { Context, Effect, Layer } from "effect";
import {
  type ApiFetcher,
  InvoiceMcpClient,
  InvoiceMcpHandlers,
  InvoiceMcpToolkit,
  makeInvoiceMcpClient,
} from "./invoice-tools";
import { connectMcpStdio } from "./stdio-client";

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

describe("InvoiceWise MCP tools", () => {
  test("every tool is read-only", () => {
    for (const tool of Object.values(InvoiceMcpToolkit.tools)) {
      expect(Context.get(tool.annotations, Tool.Readonly)).toBe(true);
      expect(Context.get(tool.annotations, Tool.Destructive)).toBe(false);
    }
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

describe("InvoiceWise stdio MCP server", () => {
  const withServer = async (
    run: (
      client: Awaited<ReturnType<typeof connectMcpStdio>>["client"],
      seen: { path: string; authorization: string | null }[],
    ) => Promise<void>,
  ) => {
    const seen: { path: string; authorization: string | null }[] = [];
    const api = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) => {
        const url = new URL(request.url);
        seen.push({
          path: url.pathname + url.search,
          authorization: request.headers.get("authorization"),
        });
        if (url.pathname === `/v1/invoices/${invoiceId}`) {
          return Response.json(invoice);
        }
        return Response.json(
          { error: { code: "not_found", message: "Invoice not found" } },
          { status: 404 },
        );
      },
    });
    const { client } = await connectMcpStdio({
      apiUrl: `http://127.0.0.1:${api.port}`,
      apiKey: "mid_test",
    });
    try {
      await run(client, seen);
    } finally {
      await client.close();
      api.stop(true);
    }
  };

  test(
    "lists read-only tools with schemas that take no workspace",
    () =>
      withServer(async (client) => {
        const response = await client.request("tools/list");
        const tools = response.result.tools as {
          name: string;
          inputSchema: { type: string; properties?: object };
          annotations: { readOnlyHint: boolean; destructiveHint: boolean };
        }[];
        expect(tools.map((tool) => tool.name)).toEqual([
          "list_invoices",
          "get_invoice",
          "get_invoice_judgments",
          "get_invoice_delivery",
        ]);
        for (const tool of tools) {
          expect(tool.inputSchema.type).toBe("object");
          expect(tool.annotations.readOnlyHint).toBe(true);
          expect(tool.annotations.destructiveHint).toBe(false);
          expect(
            Object.keys(tool.inputSchema.properties ?? {}).some((name) =>
              /team|workspace/i.test(name),
            ),
          ).toBe(false);
        }
      }),
    30_000,
  );

  test(
    "reads through /v1 with the configured key and reports refusals",
    () =>
      withServer(async (client, seen) => {
        const found = await client.request("tools/call", {
          name: "get_invoice",
          arguments: { id: invoiceId },
        });
        expect(found.result.isError).toBe(false);
        expect(found.result.structuredContent.id).toBe(invoiceId);
        expect(seen).toEqual([
          {
            path: `/v1/invoices/${invoiceId}`,
            authorization: "Bearer mid_test",
          },
        ]);

        const missing = await client.request("tools/call", {
          name: "get_invoice_delivery",
          arguments: { id: invoiceId },
        });
        expect(missing.result.isError).toBe(true);
        expect(missing.result.structuredContent).toMatchObject({
          status: 404,
          code: "not_found",
        });

        const invalid = await client.request("tools/call", {
          name: "get_invoice",
          arguments: { id: "not-a-uuid" },
        });
        expect(invalid.result.isError).toBe(true);
        expect(seen).toHaveLength(2);
      }),
    30_000,
  );
});
