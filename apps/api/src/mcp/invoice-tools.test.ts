import { describe, expect, test } from "bun:test";
import { Tool } from "@effect/ai";
import { Context, Effect, Layer } from "effect";
import {
  GetInvoice,
  GetInvoiceJudgments,
  InvoiceMcpClient,
  InvoiceMcpHandlers,
  InvoiceMcpToolkit,
  ListInvoices,
} from "./invoice-tools";

const invoice = {
  id: "invoice-1",
  fileName: "invoice.pdf",
  filePath: ["team-1", "invoice.pdf"],
  displayName: "Example Supplies",
  amount: 125.5,
  currency: "GBP",
  contentType: "application/pdf",
  date: "2026-09-22",
  status: "pending",
  createdAt: "2026-09-22T12:00:00.000Z",
  website: null,
  description: null,
  extraction: { invoiceNumber: "INV-100" },
  judgments: [{ questionId: "duplicate", answer: false }],
  transaction: null,
  lineItems: [{ description: "Materials", amount: 125.5 }],
  documentUrl: "https://api.example/storage/signed",
};

const runTool = (
  name: "list_invoices" | "get_invoice_judgments",
  input: unknown,
) =>
  Effect.gen(function* () {
    const toolkit = yield* InvoiceMcpToolkit;
    return yield* toolkit.handle(name, input as never);
  });

describe("InvoiceWise MCP tools", () => {
  test("all exposed tools are explicitly read-only", () => {
    for (const tool of [ListInvoices, GetInvoice, GetInvoiceJudgments]) {
      expect(Context.get(tool.annotations, Tool.Readonly)).toBe(true);
      expect(Context.get(tool.annotations, Tool.Destructive)).toBe(false);
    }
  });

  test("lists invoices without accepting a workspace identifier", async () => {
    const calls: unknown[] = [];
    const layer = InvoiceMcpHandlers.pipe(
      Layer.provide(
        Layer.succeed(InvoiceMcpClient, {
          list: (query) =>
            Effect.sync(() => {
              calls.push(query);
              return {
                meta: { hasPreviousPage: false, hasNextPage: false },
                data: [invoice],
              };
            }),
          detail: () => Effect.succeed(invoice),
        }),
      ),
    );

    const result = await Effect.runPromise(
      runTool("list_invoices", { pageSize: 10 }).pipe(Effect.provide(layer)),
    );

    expect(calls).toEqual([{ pageSize: 10 }]);
    expect(result.encodedResult).toMatchObject({ data: [{ id: invoice.id }] });
  });

  test("returns only judgments for the judgment tool", async () => {
    const layer = InvoiceMcpHandlers.pipe(
      Layer.provide(
        Layer.succeed(InvoiceMcpClient, {
          list: () =>
            Effect.succeed({
              meta: { hasPreviousPage: false, hasNextPage: false },
              data: [],
            }),
          detail: () => Effect.succeed(invoice),
        }),
      ),
    );

    const result = await Effect.runPromise(
      runTool("get_invoice_judgments", { id: invoice.id }).pipe(
        Effect.provide(layer),
      ),
    );

    expect(result.encodedResult).toEqual({
      id: invoice.id,
      judgments: invoice.judgments,
    });
  });
});
