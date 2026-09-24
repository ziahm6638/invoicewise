import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  BillRejectedError,
  type DraftBill,
  postProviderBill,
} from "./accounting-providers";
import { NangoRequestError, getNangoConfig } from "./nango";

// A stand-in for self-hosted Nango: the connection lookup plus the proxy,
// answering as Xero and QuickBooks would. It records every proxied call.
type Call = {
  method: string;
  path: string;
  search: URLSearchParams;
  headers: Headers;
  json?: unknown;
  bytes?: number;
  form?: FormData;
};

let calls: Call[] = [];
let connectionConfig: Record<string, unknown> = {};
let vendors: string[] = [];
let bills = new Map<string, string>();
let attachables = new Set<string>();
let failNextBill = false;
let uploadStatus = 200;

const stub = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.headers.get("authorization") !== "Bearer nango-test") {
      return Response.json(
        { error: { message: "Unauthorized" } },
        { status: 401 },
      );
    }
    if (url.pathname.startsWith("/connection/")) {
      return Response.json({
        connection_id: decodeURIComponent(url.pathname.split("/")[2]!),
        connection_config: connectionConfig,
        credentials: { expires_at: "2026-09-24T21:00:00.000Z" },
      });
    }
    if (!url.pathname.startsWith("/proxy/")) {
      return new Response("Not found", { status: 404 });
    }
    const path = url.pathname.slice("/proxy".length);
    const call: Call = {
      method: request.method,
      path,
      search: url.searchParams,
      headers: request.headers,
    };
    const type = request.headers.get("content-type") ?? "";
    if (type.startsWith("application/json")) call.json = await request.json();
    else if (type.startsWith("multipart/form-data"))
      call.form = await request.formData();
    else if (request.method !== "GET")
      call.bytes = (await request.arrayBuffer()).byteLength;
    calls.push(call);

    // Xero
    if (path === "/api.xro/2.0/Invoices") {
      const key = request.headers.get("nango-proxy-idempotency-key")!;
      const id = bills.get(key) ?? `xero-${bills.size + 1}`;
      bills.set(key, id);
      if (failNextBill) {
        failNextBill = false;
        return Response.json(
          { error: { message: "Gateway timeout" } },
          { status: 504 },
        );
      }
      return Response.json({ Invoices: [{ InvoiceID: id }] });
    }
    if (path.startsWith("/api.xro/2.0/Invoices/")) {
      return uploadStatus === 200
        ? Response.json({ Attachments: [{}] })
        : Response.json(
            { Message: "Attachment too large" },
            { status: uploadStatus },
          );
    }

    // QuickBooks
    if (path === "/v3/company/9130/query") {
      const query = url.searchParams.get("query")!;
      if (query.includes("from Vendor")) {
        const name = query
          .match(/DisplayName = '(.*)'$/)?.[1]
          ?.replace(/\\(.)/g, "$1");
        const index = vendors.findIndex((vendor) => vendor === name);
        return Response.json({
          QueryResponse: index < 0 ? {} : { Vendor: [{ Id: `v${index + 1}` }] },
        });
      }
      if (query.includes("from Account")) {
        return Response.json({ QueryResponse: { Account: [{ Id: "7" }] } });
      }
      if (query.includes("from Attachable")) {
        const id = query.match(/value = '(.*)'$/)?.[1]!;
        return Response.json({
          QueryResponse: attachables.has(id)
            ? { Attachable: [{ Id: "a1" }] }
            : {},
        });
      }
    }
    if (path === "/v3/company/9130/vendor") {
      vendors.push((call.json as { DisplayName: string }).DisplayName);
      return Response.json({ Vendor: { Id: `v${vendors.length}` } });
    }
    if (path === "/v3/company/9130/bill") {
      const key = url.searchParams.get("requestid")!;
      const id = bills.get(key) ?? String(100 + bills.size);
      bills.set(key, id);
      return Response.json({ Bill: { Id: id } });
    }
    if (path === "/v3/company/9130/upload") {
      const metadata = JSON.parse(
        await (call.form!.get("file_metadata_01") as File).text(),
      );
      attachables.add(metadata.AttachableRef[0].EntityRef.value);
      return Response.json({ AttachableResponse: [{}] });
    }
    return Response.json(
      {
        Fault: {
          Error: [{ Message: "Unsupported", Detail: `No route ${path}` }],
        },
      },
      { status: 400 },
    );
  },
});

afterAll(() => stub.stop(true));

beforeEach(() => {
  calls = [];
  vendors = [];
  bills = new Map();
  attachables = new Set();
  failNextBill = false;
  uploadStatus = 200;
});

const env = {
  NANGO_BASE_URL: `http://127.0.0.1:${stub.port}`,
  NANGO_SECRET_KEY: "nango-test",
  NANGO_XERO_INTEGRATION_ID: "xero",
  NANGO_QUICKBOOKS_INTEGRATION_ID: "quickbooks",
};

const bill: DraftBill = {
  idempotencyKey: "invoicewise:3f1c2a4e-0000-4000-8000-000000000001",
  supplierName: "O'Brien Supplies Ltd",
  supplierTaxNumber: "GB123456789",
  invoiceNumber: "INV-42",
  invoiceDate: "2026-09-22",
  dueDate: "2026-10-22",
  currency: "GBP",
  netAmount: 150,
  vatAmount: 30,
  grossAmount: 180,
  description: null,
  lineItems: [
    { description: "Materials", quantity: 2, unitPrice: 50, total: 100 },
    { description: "Labour", quantity: null, unitPrice: null, total: 50 },
  ],
};

const attachment = {
  fileName: "INV 42.pdf",
  contentType: "application/pdf",
  data: new TextEncoder().encode("%PDF-1.4 synthetic").buffer as ArrayBuffer,
};

const connection = { connectionId: "conn-1" };

describe("Xero", () => {
  const config = getNangoConfig("xero", env);

  test("creates a DRAFT ACCPAY bill for the organisation and attaches the PDF", async () => {
    connectionConfig = { tenant_id: "tenant-1" };
    const posted = await postProviderBill(
      "xero",
      config,
      connection,
      bill,
      attachment,
    );
    expect(posted).toEqual({
      providerId: "xero-1",
      attached: true,
      attachmentError: null,
    });

    const [create, upload] = calls;
    expect(create!.headers.get("connection-id")).toBe("conn-1");
    expect(create!.headers.get("provider-config-key")).toBe("xero");
    expect(create!.headers.get("nango-proxy-xero-tenant-id")).toBe("tenant-1");
    expect(create!.headers.get("nango-proxy-idempotency-key")).toBe(
      bill.idempotencyKey,
    );
    expect(create!.json).toEqual({
      Invoices: [
        {
          Type: "ACCPAY",
          Status: "DRAFT",
          Contact: { Name: "O'Brien Supplies Ltd" },
          InvoiceNumber: "INV-42",
          Date: "2026-09-22",
          DueDate: "2026-10-22",
          CurrencyCode: "GBP",
          LineAmountTypes: "Exclusive",
          LineItems: [
            { Description: "Materials", Quantity: 2, UnitAmount: 50 },
            { Description: "Labour", Quantity: 1, UnitAmount: 50 },
          ],
        },
      ],
    });
    expect(upload!.method).toBe("POST");
    expect(upload!.path).toBe(
      "/api.xro/2.0/Invoices/xero-1/Attachments/INV%2042.pdf",
    );
    expect(upload!.headers.get("nango-proxy-content-type")).toBe(
      "application/pdf",
    );
    expect(upload!.bytes).toBe(attachment.data.byteLength);
  });

  test("a retry after an ambiguous timeout reuses the key and gets the same bill", async () => {
    connectionConfig = { tenant_id: "tenant-1" };
    failNextBill = true;
    const error = await postProviderBill(
      "xero",
      config,
      connection,
      bill,
      null,
    ).catch((caught) => caught);
    expect(error).toBeInstanceOf(NangoRequestError);
    expect((error as NangoRequestError).retryable).toBe(true);

    const posted = await postProviderBill(
      "xero",
      config,
      connection,
      bill,
      null,
    );
    expect(posted.providerId).toBe("xero-1");
    expect(bills.size).toBe(1);
  });

  test("keeps the bill when only the attachment fails", async () => {
    connectionConfig = { tenant_id: "tenant-1" };
    uploadStatus = 413;
    const posted = await postProviderBill(
      "xero",
      config,
      connection,
      bill,
      attachment,
    );
    expect(posted).toEqual({
      providerId: "xero-1",
      attached: false,
      attachmentError: "Attachment too large",
    });
  });

  const postedXeroLines = async (
    lineItems: DraftBill["lineItems"],
    netAmount: number,
  ) => {
    connectionConfig = { tenant_id: "tenant-1" };
    await postProviderBill(
      "xero",
      config,
      connection,
      { ...bill, lineItems, netAmount },
      null,
    );
    const create = calls.find((call) => call.path === "/api.xro/2.0/Invoices")!;
    return (create.json as { Invoices: [{ LineItems: unknown[] }] }).Invoices[0]
      .LineItems;
  };

  test("sends a line whose unit price disagrees with its total as one unit of the total", async () => {
    expect(
      await postedXeroLines(
        [{ description: "Labour", quantity: null, unitPrice: 50, total: 250 }],
        250,
      ),
    ).toEqual([{ Description: "Labour", Quantity: 1, UnitAmount: 250 }]);
  });

  test("sends a line whose rounded unit price misses its total as one unit of the total", async () => {
    expect(
      await postedXeroLines(
        [{ description: "Labour", quantity: 3, unitPrice: null, total: 100 }],
        100,
      ),
    ).toEqual([{ Description: "Labour", Quantity: 1, UnitAmount: 100 }]);
  });

  test("refuses a connection without an organisation", async () => {
    connectionConfig = {};
    expect(
      postProviderBill("xero", config, connection, bill, null),
    ).rejects.toBeInstanceOf(BillRejectedError);
  });
});

describe("QuickBooks", () => {
  const config = getNangoConfig("quickbooks", env);

  test("finds or creates the vendor, creates an idempotent bill and uploads once", async () => {
    connectionConfig = { realmId: "9130" };
    const first = await postProviderBill(
      "quickbooks",
      config,
      connection,
      bill,
      attachment,
    );
    expect(first).toEqual({
      providerId: "100",
      attached: true,
      attachmentError: null,
    });
    expect(vendors).toEqual(["O'Brien Supplies Ltd"]);

    const vendorQuery = calls[0]!.search.get("query");
    expect(vendorQuery).toBe(
      "select Id from Vendor where DisplayName = 'O\\'Brien Supplies Ltd'",
    );
    const create = calls.find((call) => call.path === "/v3/company/9130/bill")!;
    expect(create.search.get("requestid")).toBe(bill.idempotencyKey);
    expect(create.search.get("minorversion")).toBe("75");
    expect(create.json).toEqual({
      VendorRef: { value: "v1" },
      DocNumber: "INV-42",
      TxnDate: "2026-09-22",
      DueDate: "2026-10-22",
      PrivateNote: `InvoiceWise ${bill.idempotencyKey}`,
      Line: [
        {
          DetailType: "AccountBasedExpenseLineDetail",
          Amount: 100,
          Description: "Materials",
          AccountBasedExpenseLineDetail: { AccountRef: { value: "7" } },
        },
        {
          DetailType: "AccountBasedExpenseLineDetail",
          Amount: 50,
          Description: "Labour",
          AccountBasedExpenseLineDetail: { AccountRef: { value: "7" } },
        },
      ],
    });
    const upload = calls.find(
      (call) => call.path === "/v3/company/9130/upload",
    )!;
    expect(upload.headers.get("nango-proxy-content-type")).toBe(
      "multipart/form-data",
    );
    const file = upload.form!.get("file_content_01") as File;
    expect(file.name).toBe("INV 42.pdf");
    expect(file.size).toBe(attachment.data.byteLength);

    // Replayed: same vendor and bill, and the existing attachment is kept.
    calls = [];
    const again = await postProviderBill(
      "quickbooks",
      config,
      connection,
      bill,
      attachment,
    );
    expect(again.providerId).toBe("100");
    expect(vendors).toHaveLength(1);
    expect(bills.size).toBe(1);
    expect(calls.some((call) => call.path.endsWith("/upload"))).toBe(false);
  });

  test("posts the net total as one line when no line items were extracted", async () => {
    connectionConfig = { realmId: "9130" };
    await postProviderBill(
      "quickbooks",
      config,
      connection,
      { ...bill, lineItems: [], description: "Monthly service" },
      null,
    );
    const create = calls.find((call) => call.path === "/v3/company/9130/bill")!;
    expect((create.json as { Line: unknown[] }).Line).toEqual([
      {
        DetailType: "AccountBasedExpenseLineDetail",
        Amount: 150,
        Description: "Monthly service",
        AccountBasedExpenseLineDetail: { AccountRef: { value: "7" } },
      },
    ]);
  });

  const netTotalLine = [
    {
      DetailType: "AccountBasedExpenseLineDetail",
      Amount: 150,
      Description: "Invoice INV-42",
      AccountBasedExpenseLineDetail: { AccountRef: { value: "7" } },
    },
  ];

  test("posts the net total as one line when an extracted line has no amount", async () => {
    connectionConfig = { realmId: "9130" };
    await postProviderBill(
      "quickbooks",
      config,
      connection,
      {
        ...bill,
        lineItems: [
          {
            description: "Labour",
            quantity: null,
            unitPrice: null,
            total: 100,
          },
          {
            description: "Materials",
            quantity: null,
            unitPrice: null,
            total: null,
          },
        ],
      },
      null,
    );
    const create = calls.find((call) => call.path === "/v3/company/9130/bill")!;
    expect((create.json as { Line: unknown[] }).Line).toEqual(netTotalLine);
  });

  test("posts the net total as one line when the lines do not add up to it", async () => {
    connectionConfig = { realmId: "9130" };
    await postProviderBill(
      "quickbooks",
      config,
      connection,
      {
        ...bill,
        lineItems: [
          {
            description: "Labour",
            quantity: null,
            unitPrice: null,
            total: 100,
          },
          { description: "Materials", quantity: 1, unitPrice: 20, total: 20 },
        ],
      },
      null,
    );
    const create = calls.find((call) => call.path === "/v3/company/9130/bill")!;
    expect((create.json as { Line: unknown[] }).Line).toEqual(netTotalLine);
  });

  test("refuses a bill without a supplier or a company", async () => {
    connectionConfig = { realmId: "9130" };
    expect(
      postProviderBill(
        "quickbooks",
        config,
        connection,
        { ...bill, supplierName: null },
        null,
      ),
    ).rejects.toBeInstanceOf(BillRejectedError);
    connectionConfig = {};
    expect(
      postProviderBill("quickbooks", config, connection, bill, null),
    ).rejects.toBeInstanceOf(BillRejectedError);
  });
});

test("the Nango base URL must be configured explicitly", () => {
  const { NANGO_BASE_URL: _unset, ...rest } = env;
  expect(() => getNangoConfig("xero", rest)).toThrow(
    "NANGO_BASE_URL must be configured",
  );
});
