import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  BillRejectedError,
  type DraftBill,
  attachProviderDocument,
  isRetryable,
  postProviderBill,
  quickBooksRequestId,
  updateProviderBill,
} from "./accounting-providers";
import { NangoRequestError, getNangoConfig } from "./nango";
import { createQuickBooksFake } from "./quickbooks-fake";

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
let bills = new Map<string, string>();
let failNextBill = false;
let quickBooks = createQuickBooksFake("9130", {
  name: "Synthetic Trading Ltd",
  country: "GB",
  homeCurrency: "GBP",
  multiCurrency: false,
});
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
    // An update names the bill in the path and the body; it never creates.
    const xeroUpdate = path.match(/^\/api\.xro\/2\.0\/Invoices\/([^/]+)$/);
    if (xeroUpdate) {
      const id = decodeURIComponent(xeroUpdate[1]!);
      const [sent] = (call.json as { Invoices: { InvoiceID: string }[] })
        .Invoices;
      if (![...bills.values()].includes(id) || sent?.InvoiceID !== id) {
        return Response.json(
          { Message: "A validation exception occurred" },
          { status: 400 },
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
    const quickBooksAnswer = await quickBooks.handle(request, path, url, {
      json: call.json as Record<string, unknown> | undefined,
      form: call.form,
    });
    if (quickBooksAnswer) return quickBooksAnswer;
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
  bills = new Map();
  failNextBill = false;
  quickBooks = createQuickBooksFake("9130", {
    name: "Synthetic Trading Ltd",
    country: "GB",
    homeCurrency: "GBP",
    multiCurrency: false,
  });
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
  documentType: "invoice",
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
      entity: "bill",
      attached: true,
      attachmentError: null,
      attachmentRetryable: false,
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
      entity: "bill",
      attached: false,
      attachmentError: "Attachment too large",
      // A 413 will not pass on a retry unchanged.
      attachmentRetryable: false,
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
  const configured = {
    connectionId: "conn-1",
    settings: {
      expenseAccountId: "7" as string | null,
      taxCodeIds: [] as string[],
    },
  };
  type Sent = {
    VendorRef: { value: string };
    DocNumber?: string;
    DueDate?: string;
    CurrencyRef?: { value: string };
    GlobalTaxCalculation?: string;
    PrivateNote?: string;
    Line: {
      DetailType: string;
      Amount: number;
      Description: string;
      AccountBasedExpenseLineDetail: {
        AccountRef: { value: string };
        TaxCodeRef?: { value: string };
      };
    }[];
  };
  const created = (entity: "Bill" | "VendorCredit" = "Bill") =>
    quickBooks.records(entity) as unknown as (Sent & { Id: string })[];
  const post = (
    draft: DraftBill = bill,
    file: typeof attachment | null = attachment,
    target: typeof configured = configured,
  ) => postProviderBill("quickbooks", config, target, draft, file);

  beforeEach(() => {
    connectionConfig = { realmId: "9130" };
  });

  test("creates an open bill for a new vendor with the matching purchase tax code and attaches once", async () => {
    const posted = await post();
    expect(posted).toEqual({
      providerId: "100",
      entity: "bill",
      attached: true,
      attachmentError: null,
      attachmentRetryable: false,
    });
    expect(quickBooks.state.vendors).toMatchObject([
      { Id: "v1", DisplayName: "O'Brien Supplies Ltd" },
    ]);
    const [record] = created();
    expect(record).toMatchObject({
      VendorRef: { value: "v1" },
      DocNumber: "INV-42",
      TxnDate: "2026-09-22",
      DueDate: "2026-10-22",
      GlobalTaxCalculation: "TaxExcluded",
      PrivateNote: `InvoiceWise ${bill.idempotencyKey}`,
    });
    expect(record!.Line).toEqual([
      {
        DetailType: "AccountBasedExpenseLineDetail",
        Amount: 100,
        Description: "Materials",
        AccountBasedExpenseLineDetail: {
          AccountRef: { value: "7" },
          TaxCodeRef: { value: "4" },
        },
      },
      {
        DetailType: "AccountBasedExpenseLineDetail",
        Amount: 50,
        Description: "Labour",
        AccountBasedExpenseLineDetail: {
          AccountRef: { value: "7" },
          TaxCodeRef: { value: "4" },
        },
      },
    ]);
    const create = calls.find((call) => call.path === "/v3/company/9130/bill")!;
    expect(create.search.get("requestid")).toBe(bill.idempotencyKey);
    expect(quickBooks.state.attachables.get("Bill:100")).toBe(1);
  });

  test("a retry after an ambiguous timeout returns the bill QuickBooks already created", async () => {
    quickBooks.fail({ on: "bill", status: 504, afterApply: true });
    const error = await post(bill, null).catch((caught) => caught);
    expect(error).toBeInstanceOf(NangoRequestError);
    expect(isRetryable(error)).toBe(true);
    const posted = await post(bill, null);
    expect(posted.providerId).toBe("100");
    expect(created()).toHaveLength(1);
    expect(quickBooks.state.writes.bill).toBe(1);
  });

  test("finds its bill by reference and vendor after QuickBooks forgot the request ID", async () => {
    quickBooks.fail({ on: "bill", status: 504, afterApply: true });
    await post(bill, null).catch(() => undefined);
    quickBooks.expireRequestIds();
    const posted = await post(bill, null);
    expect(posted.providerId).toBe("100");
    expect(created()).toHaveLength(1);
  });

  test("refuses a same-numbered bill from the same vendor that InvoiceWise did not create", async () => {
    await post(bill, null);
    const error = await post(
      { ...bill, idempotencyKey: "invoicewise:someone-else" },
      null,
    ).catch((caught) => caught);
    expect(error).toBeInstanceOf(BillRejectedError);
    expect((error as Error).message).toContain(
      "QuickBooks already has bill INV-42 from O'Brien Supplies Ltd (ID 100) that InvoiceWise did not create",
    );
    expect(created()).toHaveLength(1);
  });

  test("throttling and a failed token refresh are retryable and create nothing", async () => {
    quickBooks.fail({ on: "bill", status: 429 });
    const throttled = await post(bill, null).catch((caught) => caught);
    expect((throttled as NangoRequestError).status).toBe(429);
    expect(isRetryable(throttled)).toBe(true);
    quickBooks.fail({
      on: "companyinfo",
      status: 424,
      body: { error: { message: "The refresh token has expired" } },
    });
    const refresh = await post(bill, null).catch((caught) => caught);
    expect((refresh as NangoRequestError).status).toBe(424);
    expect(isRetryable(refresh)).toBe(true);
    expect(created()).toHaveLength(0);
    // Once QuickBooks answers again, one bill is created.
    await post(bill, null);
    expect(created()).toHaveLength(1);
  });

  test("a failed upload keeps the bill and is retried on its own, attaching exactly once", async () => {
    quickBooks.fail({ on: "upload", status: 503 });
    const posted = await post();
    expect(posted).toMatchObject({
      providerId: "100",
      attached: false,
      attachmentRetryable: true,
    });
    // The upload's response is lost, then it is retried twice more.
    quickBooks.fail({ on: "upload", status: 504, afterApply: true });
    const lost = await attachProviderDocument(
      "quickbooks",
      config,
      configured,
      { providerId: "100", entity: "bill" },
      attachment,
    ).catch((caught) => caught);
    expect(isRetryable(lost)).toBe(true);
    for (let retry = 0; retry < 2; retry++) {
      await attachProviderDocument(
        "quickbooks",
        config,
        configured,
        { providerId: "100", entity: "bill" },
        attachment,
      );
    }
    expect(quickBooks.state.attachables.get("Bill:100")).toBe(1);
    expect(created()).toHaveLength(1);
    expect(quickBooks.state.writes.bill).toBe(1);
  });

  test("a credit note becomes a vendor credit", async () => {
    const posted = await post({
      ...bill,
      documentType: "credit_note",
      invoiceNumber: "CN-7",
    });
    expect(posted).toMatchObject({ entity: "vendor_credit", attached: true });
    expect(created()).toHaveLength(0);
    const [credit] = created("VendorCredit");
    expect(credit).toMatchObject({ DocNumber: "CN-7" });
    expect(credit).not.toHaveProperty("DueDate");
    expect(quickBooks.state.attachables.get(`VendorCredit:${credit!.Id}`)).toBe(
      1,
    );
  });

  test("prefers the chosen tax code where several share a rate, and refuses an ambiguous or unmatched rate", async () => {
    const zeroRated = { ...bill, vatAmount: 0, grossAmount: 150 };
    const ambiguous = await post(zeroRated, null).catch((caught) => caught);
    expect(ambiguous).toBeInstanceOf(BillRejectedError);
    expect((ambiguous as Error).message).toContain(
      "Several QuickBooks purchase tax codes match the 0% tax on this invoice (0.0% Z, Exempt)",
    );
    await post(zeroRated, null, {
      ...configured,
      settings: { ...configured.settings, taxCodeIds: ["6"] },
    });
    expect(
      created()[0]!.Line[0]!.AccountBasedExpenseLineDetail.TaxCodeRef,
    ).toEqual({ value: "6" });

    const unmatched = await post(
      { ...bill, invoiceNumber: "INV-43", vatAmount: 17, grossAmount: 167 },
      null,
    ).catch((caught) => caught);
    expect((unmatched as Error).message).toContain(
      "No active QuickBooks purchase tax code matches the 11.33% tax",
    );
  });

  test("a US company's bill has no tax code and carries the tax as its own line", async () => {
    quickBooks.state.company = {
      name: "Sandbox Company US",
      country: "US",
      homeCurrency: "USD",
      multiCurrency: false,
    };
    await post({ ...bill, currency: "USD" }, null);
    const [record] = created();
    expect(record).not.toHaveProperty("GlobalTaxCalculation");
    expect(
      record!.Line.map((line) => [
        line.Description,
        line.Amount,
        line.AccountBasedExpenseLineDetail.TaxCodeRef,
      ]),
    ).toEqual([
      ["Materials", 100, undefined],
      ["Labour", 50, undefined],
      ["Tax on invoice INV-42", 30, undefined],
    ]);
  });

  test("a US company's bill adds the tax to net lines without a net amount, and refuses lines it cannot reconcile", async () => {
    quickBooks.state.company = {
      name: "Sandbox Company US",
      country: "US",
      homeCurrency: "USD",
      multiCurrency: false,
    };
    await post({ ...bill, currency: "USD", netAmount: null }, null);
    expect(created()[0]!.Line.reduce((sum, line) => sum + line.Amount, 0)).toBe(
      180,
    );

    const grossLines = {
      ...bill,
      invoiceNumber: "INV-43",
      idempotencyKey: "invoicewise:gross-lines",
      currency: "USD",
      netAmount: null,
      lineItems: [
        { description: "Materials", quantity: 1, unitPrice: 120, total: 120 },
        { description: "Labour", quantity: 1, unitPrice: 60, total: 60 },
      ],
    };
    await post(grossLines, null);
    expect(
      created()
        .find((record) => record.DocNumber === "INV-43")!
        .Line.map((line) => line.Amount),
    ).toEqual([120, 60]);

    const unreconciled = await post(
      {
        ...grossLines,
        invoiceNumber: "INV-44",
        idempotencyKey: "invoicewise:unreconciled",
        grossAmount: null,
      },
      null,
    ).catch((caught) => caught);
    expect(unreconciled).toBeInstanceOf(BillRejectedError);
    expect(created().some((record) => record.DocNumber === "INV-44")).toBe(
      false,
    );
  });

  test("refuses a foreign currency without multicurrency and posts it in its own currency with it", async () => {
    const euro = { ...bill, currency: "EUR" };
    const refused = await post(euro, null).catch((caught) => caught);
    expect((refused as Error).message).toBe(
      "The invoice is in EUR but the QuickBooks company works only in GBP; turn on multicurrency in QuickBooks, or record it by hand",
    );
    quickBooks.state.company = {
      ...quickBooks.state.company,
      multiCurrency: true,
    };
    await post(euro, null);
    expect(created()[0]!.CurrencyRef).toEqual({ value: "EUR" });
    expect(quickBooks.state.vendors[0]!.CurrencyRef).toEqual({ value: "EUR" });
    // The vendor is EUR now; a GBP invoice from it cannot share it.
    const mismatch = await post(
      { ...bill, invoiceNumber: "INV-44" },
      null,
    ).catch((caught) => caught);
    expect((mismatch as Error).message).toContain("is set up in EUR");
  });

  test("names what to fix when setup, the vendor or the company is missing", async () => {
    const unset = await post(bill, null, {
      connectionId: "conn-1",
      settings: { expenseAccountId: null, taxCodeIds: [] },
    }).catch((caught) => caught);
    expect((unset as Error).message).toBe(
      "Choose the QuickBooks expense account for bills in Settings → Accounting",
    );

    quickBooks.state.reservedNames.add("O'Brien Supplies Ltd");
    const reserved = await post(bill, null).catch((caught) => caught);
    expect(reserved).toBeInstanceOf(BillRejectedError);
    expect((reserved as Error).message).toContain(
      'already uses the name "O\'Brien Supplies Ltd" for a customer or employee',
    );

    quickBooks.state.reservedNames.clear();
    quickBooks.state.vendors.push({
      Id: "v9",
      DisplayName: "O'Brien Supplies Ltd",
      Active: false,
    });
    const inactive = await post(bill, null).catch((caught) => caught);
    expect((inactive as Error).message).toContain("is inactive");

    expect(post({ ...bill, supplierName: null }, null)).rejects.toThrow(
      "QuickBooks needs the supplier name",
    );
    connectionConfig = {};
    expect(post(bill, null)).rejects.toThrow("has no company");
    expect(created()).toHaveLength(0);
  });

  test("cuts a long reference to QuickBooks' 21 characters and keeps it whole in the note", async () => {
    const long = { ...bill, invoiceNumber: "SUPPLIER-2026-000000012345" };
    await post(long, null);
    const [record] = created();
    expect(record!.DocNumber).toBe("SUPPLIER-2026-0000000");
    expect(record!.PrivateNote).toContain(
      "reference SUPPLIER-2026-000000012345",
    );
    // A replay still finds it under the cut reference.
    quickBooks.expireRequestIds();
    await post(long, null);
    expect(created()).toHaveLength(1);
  });

  test("request IDs fit QuickBooks' 50 characters", () => {
    const key = "invoicewise-update:3f1c2a4e-0000-4000-8000-00000000c001:12";
    expect(quickBooksRequestId(key).length).toBeLessThanOrEqual(50);
    expect(quickBooksRequestId(key)).toBe(quickBooksRequestId(key));
    expect(quickBooksRequestId(bill.idempotencyKey)).toBe(bill.idempotencyKey);
  });
});

test("the Nango base URL must be configured explicitly", () => {
  const { NANGO_BASE_URL: _unset, ...rest } = env;
  expect(() => getNangoConfig("xero", rest)).toThrow(
    "NANGO_BASE_URL must be configured",
  );
});

describe("bill update", () => {
  const corrected: DraftBill = {
    ...bill,
    idempotencyKey: "invoicewise-update:3f1c2a4e-0000-4000-8000-00000000c001",
    grossAmount: 170,
    vatAmount: 20,
  };

  test("Xero updates the same bill in place, leaving its status alone", async () => {
    connectionConfig = { tenant_id: "tenant-1" };
    const config = getNangoConfig("xero", env);
    const posted = await postProviderBill(
      "xero",
      config,
      connection,
      bill,
      null,
    );
    calls = [];
    const updated = await updateProviderBill(
      "xero",
      config,
      connection,
      posted.providerId,
      corrected,
    );
    expect(updated).toEqual({ providerId: posted.providerId });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.path).toBe(`/api.xro/2.0/Invoices/${posted.providerId}`);
    expect(call?.headers.get("nango-proxy-idempotency-key")).toBe(
      corrected.idempotencyKey,
    );
    const [sent] = (call?.json as { Invoices: Record<string, unknown>[] })
      .Invoices;
    expect(sent?.InvoiceID).toBe(posted.providerId);
    expect(sent).not.toHaveProperty("Status");
    expect(sent).not.toHaveProperty("Type");
    // No second bill exists.
    expect(bills.size).toBe(1);
  });

  test("Xero refusing the update is a permanent failure", async () => {
    connectionConfig = { tenant_id: "tenant-1" };
    const config = getNangoConfig("xero", env);
    const failure = await updateProviderBill(
      "xero",
      config,
      connection,
      "unknown-bill",
      corrected,
    ).catch((error) => error);
    expect(failure).toBeInstanceOf(NangoRequestError);
    expect((failure as NangoRequestError).retryable).toBe(false);
  });

  test("QuickBooks updates the bill with its current SyncToken", async () => {
    connectionConfig = { realmId: "9130" };
    const config = getNangoConfig("quickbooks", env);
    const target = {
      connectionId: "conn-1",
      settings: { expenseAccountId: "7", taxCodeIds: [] },
    };
    const posted = await postProviderBill(
      "quickbooks",
      config,
      target,
      bill,
      null,
    );
    calls = [];
    const updated = await updateProviderBill(
      "quickbooks",
      config,
      target,
      posted.providerId,
      { ...corrected, vatAmount: 30, grossAmount: 180, dueDate: "2026-11-01" },
    );
    expect(updated).toEqual({ providerId: posted.providerId });
    const update = calls.find(
      (call) => call.method === "POST" && call.path === "/v3/company/9130/bill",
    )!;
    expect(update.json).toMatchObject({
      Id: posted.providerId,
      SyncToken: "0",
      sparse: true,
      DueDate: "2026-11-01",
    });
    expect(update.search.get("requestid")!.length).toBeLessThanOrEqual(50);
    expect(quickBooks.records("Bill")).toHaveLength(1);
  });

  test("QuickBooks without the bill refuses rather than creating one", async () => {
    connectionConfig = { realmId: "9130" };
    const failure = await updateProviderBill(
      "quickbooks",
      getNangoConfig("quickbooks", env),
      { connectionId: "conn-1", settings: { expenseAccountId: "7" } },
      "999",
      corrected,
    ).catch((error) => error);
    expect(failure).toBeInstanceOf(BillRejectedError);
    expect(quickBooks.records("Bill")).toHaveLength(0);
  });
});
