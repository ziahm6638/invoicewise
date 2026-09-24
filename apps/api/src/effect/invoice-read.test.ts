import { afterAll, describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { makeInvoiceHttpHandler } from "./invoice-http";
import {
  InvoiceReadLayer,
  InvoiceRepository,
  InvoiceStorage,
} from "./invoice-read";

const invoice = {
  id: "4a80fbd7-898f-4896-af62-f4b21621988f",
  fileName: "invoice.pdf",
  // The persisted path must belong to the row's own workspace and sit in the
  // document namespace; the shared binding guard rejects anything else.
  filePath: ["team-123", "inbox", "invoice.pdf"],
  displayName: "Acme September invoice",
  transactionId: null,
  amount: 125.5,
  currency: "GBP",
  contentType: "application/pdf",
  date: "2026-09-20",
  status: "done" as const,
  createdAt: "2026-09-20T12:00:00.000Z",
  website: "https://acme.example",
  description: "September services",
  extraction: {
    supplierName: "Acme Ltd",
    invoiceNumber: "INV-42",
    lineItems: [
      {
        description: "September services",
        quantity: 1,
        unitPrice: 125.5,
        total: 125.5,
      },
    ],
  },
  judgments: [
    { questionId: "known_supplier", label: "Known supplier", answer: true },
  ],
  processingError: null,
  inboxAccountId: null,
  inboxAccount: null,
  transaction: null,
  suggestion: null,
};

let requestedTeamId: string | undefined;
let requestedDownload: boolean | undefined;

const RepositoryTest = Layer.succeed(InvoiceRepository, {
  list: (params) => {
    requestedTeamId = params.teamId;
    return Effect.succeed({
      meta: {
        cursor: undefined,
        hasPreviousPage: false,
        hasNextPage: false,
      },
      data: [invoice],
    });
  },
  findById: (id, teamId) => {
    requestedTeamId = teamId;
    return Effect.succeed(
      id === invoice.id && teamId === "team-123" ? invoice : undefined,
    );
  },
  deliveryStatus: (invoiceId, teamId) =>
    Effect.succeed(
      invoiceId === invoice.id && teamId === "team-123"
        ? [
            {
              id: "delivery-1",
              endpointId: "endpoint-1",
              endpointUrl: "https://customer.example/webhooks",
              event: "invoice.processed",
              status: "succeeded" as const,
              attempts: 1,
              lastError: null,
              deliveredAt: "2026-09-20T12:01:00.000Z",
              createdAt: "2026-09-20T12:00:30.000Z",
            },
          ]
        : [],
    ),
  accountingStatus: (invoiceId, teamId) =>
    Effect.succeed(
      invoiceId === invoice.id && teamId === "team-123"
        ? {
            provider: "xero" as const,
            status: "posted" as const,
            providerId: "xero-bill-1",
            lastError: null,
            postedAt: "2026-09-20T12:02:00.000Z",
            idempotencyKey: `invoicewise:${invoice.id}`,
          }
        : null,
    ),
  exportRows: (teamId) =>
    Effect.succeed(teamId === "team-123" ? [invoice] : []),
});

const StorageTest = Layer.succeed(InvoiceStorage, {
  signedUrl: ({ download }) => {
    requestedDownload = download;
    return Effect.succeed("http://localhost:3003/storage/vault/invoice.pdf");
  },
});

const InvoiceReadTest = InvoiceReadLayer.pipe(
  Layer.provide(Layer.mergeAll(RepositoryTest, StorageTest)),
);
const { dispose, handler } = makeInvoiceHttpHandler(InvoiceReadTest);

afterAll(dispose);

const request = (path: string, init?: RequestInit) =>
  handler(
    new Request(`http://localhost${path}`, {
      ...init,
      headers: {
        "x-invoicewise-team-id": "team-123",
        ...init?.headers,
      },
    }),
  );

describe("Effect invoice read HTTP slice", () => {
  test("lists invoices through the injected repository", async () => {
    const response = await request("/inbox?pageSize=10");

    expect(response.status).toBe(200);
    expect(requestedTeamId).toBe("team-123");
    expect(await response.json()).toEqual({
      meta: { hasPreviousPage: false, hasNextPage: false },
      data: [
        {
          id: invoice.id,
          fileName: invoice.fileName,
          filePath: invoice.filePath,
          displayName: invoice.displayName,
          amount: invoice.amount,
          currency: invoice.currency,
          contentType: invoice.contentType,
          date: invoice.date,
          status: invoice.status,
          createdAt: invoice.createdAt,
          website: invoice.website,
          description: invoice.description,
          extraction: invoice.extraction,
          judgments: invoice.judgments,
          processingError: null,
          transaction: null,
        },
      ],
    });
  });

  test("returns the typed not-found error", async () => {
    const response = await request("/inbox/missing");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      _tag: "InvoiceNotFound",
      error: "Inbox item not found",
    });
  });

  test("generates an attachment URL through the storage layer", async () => {
    const response = await request(
      `/inbox/${invoice.id}/presigned-url?download=false`,
      { method: "POST" },
    );
    const body = (await response.json()) as {
      expiresAt: string;
      fileName: string;
      url: string;
    };

    expect(response.status).toBe(200);
    expect(requestedDownload).toBe(false);
    expect(body.url).toBe("http://localhost:3003/storage/vault/invoice.pdf");
    expect(body.fileName).toBe("invoice.pdf");
    expect(Number.isNaN(Date.parse(body.expiresAt))).toBe(false);
  });

  test("returns a complete invoice with line items and a signed document URL", async () => {
    const response = await request(`/invoices/${invoice.id}`);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.extraction).toEqual(invoice.extraction);
    expect(body.judgments).toEqual(invoice.judgments);
    expect(body.lineItems).toEqual(invoice.extraction.lineItems);
    expect(body.documentUrl).toBe(
      "http://localhost:3003/storage/vault/invoice.pdf",
    );
  });

  test("refuses an invoice owned by another workspace", async () => {
    const response = await request(`/invoices/${invoice.id}`, {
      headers: { "x-invoicewise-team-id": "team-other" },
    });

    expect(response.status).toBe(404);
  });

  test("returns delivery status for the workspace invoice", async () => {
    const response = await request(`/invoices/${invoice.id}/delivery-status`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: [
        expect.objectContaining({
          id: "delivery-1",
          status: "succeeded",
          attempts: 1,
        }),
      ],
      accounting: expect.objectContaining({
        provider: "xero",
        status: "posted",
        providerId: "xero-bill-1",
      }),
    });
  });

  test("exports invoice data and dynamic judgment columns as CSV", async () => {
    const response = await request("/invoices/export.csv");
    const csv = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(csv).toContain("known_supplier");
    expect(csv).toContain("INV-42");
    expect(csv).toContain("true");
  });
});
