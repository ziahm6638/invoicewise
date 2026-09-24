import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DocumentClient } from "./client";
import { InvoiceProcessingError } from "./processors/invoice/invoice-processor";

const invoiceText = `
Acme Supplies Ltd
Invoice number: INV-2026-0042
Invoice date: 2026-09-01
Gross total: £1,200.00
`;

const savedEnv = {
  apiKey: process.env.TYPESAFE_API_KEY,
  baseUrl: process.env.TYPESAFE_BASE_URL,
};

afterEach(() => {
  for (const [name, value] of [
    ["TYPESAFE_API_KEY", savedEnv.apiKey],
    ["TYPESAFE_BASE_URL", savedEnv.baseUrl],
  ] as const) {
    if (value === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = value;
  }
});

const failure = (request: Parameters<DocumentClient["getInvoice"]>[0]) =>
  new DocumentClient().getInvoice(request).then(
    () => {
      throw new Error("Expected the invoice run to fail");
    },
    (error: unknown) => {
      if (!(error instanceof InvoiceProcessingError)) throw error;
      return error;
    },
  );

describe("invoice failure reasons", () => {
  test("a document problem carries a reason safe to show the customer", async () => {
    const bytes = await readFile(
      resolve(__dirname, "test/fixtures/malformed-invoice.pdf"),
    );
    process.env.TYPESAFE_API_KEY = "unused-key";
    const error = await failure({
      documentUrl: `data:application/pdf;base64,${bytes.toString("base64")}`,
      mimetype: "application/pdf",
    });
    expect(error.message).toContain("PDF text extraction failed (malformed)");
    expect(error.userMessage).toBe(
      "The document is damaged or is not a valid PDF or image. Upload a fresh copy.",
    );
  });

  test("a provider failure keeps its detail out of the customer reason", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response("unauthorized", { status: 401 }),
    });
    try {
      process.env.TYPESAFE_API_KEY = "rejected-key";
      process.env.TYPESAFE_BASE_URL = `http://127.0.0.1:${server.port}`;
      const error = await failure({
        content: invoiceText,
        mimetype: "text/plain",
      });
      expect(error.message).toBe("TypeSafe authentication failed");
      expect(error.retryable).toBe(false);
      expect(error.userMessage).toBeUndefined();
    } finally {
      server.stop(true);
    }
  });

  test("missing TypeSafe configuration is not shown to the customer", async () => {
    Reflect.deleteProperty(process.env, "TYPESAFE_API_KEY");
    const error = await failure({
      content: invoiceText,
      mimetype: "text/plain",
    });
    expect(error.message).toContain("TypeSafe is not configured");
    expect(error.userMessage).toBeUndefined();
  });
});
