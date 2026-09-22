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
  filePath: ["team", "inbox", "invoice.pdf"],
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
  extraction: null,
  judgments: null,
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
      data: [{ ...invoice, extraction: undefined, judgments: undefined }],
    });
  },
  findById: (id, teamId) => {
    requestedTeamId = teamId;
    return Effect.succeed(id === invoice.id ? invoice : undefined);
  },
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
});
