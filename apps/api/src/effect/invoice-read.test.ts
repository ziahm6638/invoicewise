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
  validation: {
    version: 1,
    status: "invalid",
    documentType: "invoice",
    issues: [
      {
        code: "gross",
        severity: "error",
        message:
          "Net 100.00 + VAT 20.00 = 120.00, but the gross total is 125.50.",
      },
    ],
    accounting: {
      ready: false,
      blockers: [
        {
          code: "gross",
          message:
            "Net 100.00 + VAT 20.00 = 120.00, but the gross total is 125.50.",
        },
      ],
    },
  },
  supplierId: "5a0c3e59-2d3f-4d7c-9b44-9e1f7f0d6a11",
  supplierChecks: {
    version: 1,
    duplicate: { outcome: "none", evidence: [] },
    bankDetails: {
      outcome: "changed",
      current: { kind: "iban", ending: "6819" },
      evidence: [],
    },
  },
  sourceMatch: {
    id: "3f1c9a52-4b1e-4c55-9f0b-6b1d2f8e7a10",
    sequence: 1,
    status: "matched",
    origin: "automatic",
    action: "automatic",
    method: "reference",
    confidence: 1,
    needsConfirmation: false,
    links: [
      {
        sourceId: "b8e2a6f1-0c3d-4e5f-8a9b-1c2d3e4f5a6b",
        versionId: "c9f3b7a2-1d4e-4f6a-9b0c-2d3e4f5a6b7c",
        version: 1,
        type: "purchase_order",
        reference: "PO-55120",
        title: "Timber",
      },
    ],
    allocations: [],
    candidates: [],
    reason: null,
    decidedAt: "2026-09-21T10:00:00.000Z",
  },
  processingError: null,
  processingRevision: 1,
  delivery: {
    state: "delivered" as const,
    total: 2,
    succeeded: 2,
    pending: 0,
    failed: 0,
    cancelled: 0,
  },
  inboxAccountId: null,
  inboxAccount: null,
  inboundEmail: {
    id: "8e5c7a42-0d7f-4b4e-9b0e-2f1c4f7d9a10",
    messageId: "<inv-2026-0042@supplier.example>",
    from: "Acme Supplies <billing@supplier.example>",
    envelopeFrom: "bounces@supplier.example",
    recipient: "abcdefghjkmnpqrs@in.invoicewise.uk",
    subject: "Invoice INV-2026-0042",
    receivedAt: "2026-09-01T09:00:00.000Z",
  },
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
              eventId: "8f14e45f-ceea-867f-a5b0-38a1b4c1f0a2",
              revision: 1,
              status: "succeeded" as const,
              attempts: 1,
              lastError: null,
              retryable: null,
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
            retryable: null,
            revision: 1,
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
          validation: invoice.validation,
          supplierId: invoice.supplierId,
          supplierChecks: invoice.supplierChecks,
          sourceMatch: invoice.sourceMatch,
          processingError: null,
          inboundEmail: invoice.inboundEmail,
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
          eventId: "8f14e45f-ceea-867f-a5b0-38a1b4c1f0a2",
          revision: 1,
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

  test("returns the persisted validation and exports why an invoice cannot be delivered", async () => {
    const detail = (await (
      await request(`/invoices/${invoice.id}`)
    ).json()) as Record<string, unknown>;
    expect(detail.validation).toEqual(invoice.validation);
    expect(detail.supplierChecks).toEqual(invoice.supplierChecks);
    expect(detail.sourceMatch).toEqual(invoice.sourceMatch);

    const [header, row] = (
      await (await request("/invoices/export.csv")).text()
    ).split("\r\n");
    const columns = header!.split(",");
    const cells = Object.fromEntries(
      columns.map((column, index) => [column, row!.split(",")[index]]),
    );
    expect(cells).toMatchObject({
      document_type: "invoice",
      validation_status: "invalid",
      accounting_ready: "false",
    });
    expect(row).toContain("but the gross total is 125.50.");
  });
});
