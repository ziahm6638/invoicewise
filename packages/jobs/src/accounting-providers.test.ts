import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  BillRejectedError,
  type DraftBill,
  attachProviderDocument,
  getXeroSetupOptions,
  isRetryable,
  postProviderBill,
  quickBooksRequestId,
  readProviderOrganisation,
  updateProviderBill,
} from "./accounting-providers";
import {
  type NangoCallEvent,
  NangoRequestError,
  getNangoConfig,
  nangoProxy,
  nangoRequest,
  observeNangoCalls,
} from "./nango";
import { createQuickBooksFake } from "./quickbooks-fake";
import { createXeroFake } from "./xero-fake";

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
const xeroOrganisations = [
  { id: "tenant-1", name: "Synthetic Demo Ltd", currencies: ["EUR"] },
  { id: "tenant-2", name: "Second Synthetic Ltd" },
];
let xero = createXeroFake(xeroOrganisations);
let quickBooks = createQuickBooksFake("9130", {
  name: "Synthetic Trading Ltd",
  country: "GB",
  homeCurrency: "GBP",
  multiCurrency: false,
});

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
    const xeroAnswer = await xero.handle(request, path, url, {
      json: call.json as Record<string, unknown> | undefined,
      bytes: call.bytes,
    });
    if (xeroAnswer) return xeroAnswer;

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
  xero = createXeroFake(xeroOrganisations);
  quickBooks = createQuickBooksFake("9130", {
    name: "Synthetic Trading Ltd",
    country: "GB",
    homeCurrency: "GBP",
    multiCurrency: false,
  });
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

describe("Xero", () => {
  const config = getNangoConfig("xero", env);
  const configured = {
    connectionId: "conn-1",
    organisationId: "tenant-1" as string | null,
    settings: {
      expenseAccountId: "429" as string | null,
      taxCodeIds: [] as string[],
    },
  };
  const post = (
    draft: DraftBill = bill,
    file: typeof attachment | null = attachment,
    target: typeof configured = configured,
  ) => postProviderBill("xero", config, target, draft, file);
  const bills = (tenantId = "tenant-1") => xero.records(tenantId, "Invoices");

  beforeEach(() => {
    connectionConfig = { tenant_id: "tenant-1" };
  });

  test("creates a DRAFT ACCPAY bill on the chosen account and tax rate for a new contact, and attaches once", async () => {
    const posted = await post({
      ...bill,
      sourceUrl: "https://app.test/inbox?inboxId=i-1",
    });
    expect(posted).toMatchObject({
      entity: "bill",
      attached: true,
      attachmentError: null,
    });
    const [created] = bills();
    expect(created).toMatchObject({
      InvoiceID: posted.providerId,
      Type: "ACCPAY",
      Status: "DRAFT",
      InvoiceNumber: "INV-42",
      Date: "2026-09-22",
      DueDate: "2026-10-22",
      CurrencyCode: "GBP",
      LineAmountTypes: "Exclusive",
      LineItems: [
        {
          Description: "Materials",
          Quantity: 2,
          UnitAmount: 50,
          AccountCode: "429",
          TaxType: "INPUT2",
        },
        {
          Description: "Labour",
          Quantity: 1,
          UnitAmount: 50,
          AccountCode: "429",
          TaxType: "INPUT2",
        },
      ],
    });
    // The contact was created once and the bill names it by ID.
    const [contact] = xero.contacts("tenant-1");
    expect(contact?.Name).toBe("O'Brien Supplies Ltd");
    expect(created?.Contact).toEqual({ ContactID: contact?.ContactID });
    // "Go to InvoiceWise" opens the invoice and marks the bill as ours.
    const link = new URL(String(created?.Url));
    expect(link.searchParams.get("inboxId")).toBe("i-1");
    expect(link.searchParams.get("posting")).toBe(bill.idempotencyKey);
    expect(xero.attachments("tenant-1", posted.providerId)).toEqual([
      "INV 42.pdf",
    ]);
    const create = calls.find(
      (call) => call.method === "POST" && call.path === "/api.xro/2.0/Invoices",
    )!;
    expect(create.headers.get("connection-id")).toBe("conn-1");
    expect(create.headers.get("provider-config-key")).toBe("xero");
    expect(create.headers.get("nango-proxy-xero-tenant-id")).toBe("tenant-1");
    expect(create.headers.get("nango-proxy-idempotency-key")).toBe(
      bill.idempotencyKey,
    );
    // The second organisation was never touched.
    expect(bills("tenant-2")).toHaveLength(0);
  });

  test("posts to the organisation the workspace chose, not the one Nango recorded", async () => {
    await post(bill, null, { ...configured, organisationId: "tenant-2" });
    expect(bills("tenant-1")).toHaveLength(0);
    expect(bills("tenant-2")).toHaveLength(1);
  });

  test("reuses an existing contact by name, ignoring case, and refuses an archived one", async () => {
    await post({ ...bill, supplierName: "o'brien supplies ltd" }, null);
    await post(
      {
        ...bill,
        idempotencyKey: "invoicewise:second",
        invoiceNumber: "INV-43",
      },
      null,
    );
    expect(xero.contacts("tenant-1")).toHaveLength(1);
    xero.contacts("tenant-1")[0]!.ContactStatus = "ARCHIVED";
    const refused = await post(
      { ...bill, idempotencyKey: "invoicewise:third", invoiceNumber: "INV-44" },
      null,
    ).catch((error) => error);
    expect(refused).toBeInstanceOf(BillRejectedError);
    expect(refused.message).toContain("is archived; restore it in Xero");
  });

  test("a retry after an ambiguous timeout returns the bill Xero already created", async () => {
    xero.fail({
      on: "Invoices",
      method: "POST",
      status: 504,
      afterApply: true,
    });
    const error = await post(bill, null).catch((caught) => caught);
    expect(error).toBeInstanceOf(NangoRequestError);
    expect(isRetryable(error)).toBe(true);
    const posted = await post(bill, null);
    expect(bills()).toHaveLength(1);
    expect(posted.providerId).toBe(String(bills()[0]!.InvoiceID));
  });

  test("finds its bill by number and contact after Xero forgot the idempotency key", async () => {
    xero.fail({
      on: "Invoices",
      method: "POST",
      status: 504,
      afterApply: true,
    });
    await post(bill, null).catch(() => undefined);
    xero.expireIdempotencyKeys();
    const posted = await post(bill, null);
    expect(bills()).toHaveLength(1);
    expect(posted.providerId).toBe(String(bills()[0]!.InvoiceID));
  });

  test("refuses a same-numbered bill from the same contact that InvoiceWise did not create", async () => {
    await post({ ...bill, idempotencyKey: "invoicewise:someone-else" }, null);
    const refused = await post(bill, null).catch((error) => error);
    expect(refused).toBeInstanceOf(BillRejectedError);
    expect(refused.message).toContain("that InvoiceWise did not create");
    expect(bills()).toHaveLength(1);
  });

  test("a deleted or voided bill of the same number does not block a new one", async () => {
    await post({ ...bill, idempotencyKey: "invoicewise:someone-else" }, null);
    bills()[0]!.Status = "DELETED";
    await post(bill, null);
    expect(bills()).toHaveLength(2);
  });

  test("throttling and a failed token refresh are retryable and create nothing", async () => {
    xero.fail({ on: "Organisation", status: 429 });
    const throttled = await post(bill, null).catch((error) => error);
    expect(isRetryable(throttled)).toBe(true);
    xero.fail({
      on: "Organisation",
      status: 424,
      body: { error: { message: "Token refresh failed" } },
    });
    const refresh = await post(bill, null).catch((error) => error);
    expect(isRetryable(refresh)).toBe(true);
    expect(bills()).toHaveLength(0);
  });

  test("a failed upload keeps the bill and is retried on its own, attaching exactly once", async () => {
    xero.fail({
      on: "Attachments",
      method: "POST",
      status: 503,
      afterApply: true,
    });
    const posted = await post();
    expect(posted).toMatchObject({
      attached: false,
      attachmentRetryable: true,
    });
    for (let retry = 0; retry < 2; retry++) {
      await attachProviderDocument(
        "xero",
        config,
        configured,
        { providerId: posted.providerId, entity: "bill" },
        attachment,
      );
    }
    expect(bills()).toHaveLength(1);
    expect(xero.attachments("tenant-1", posted.providerId)).toEqual([
      "INV 42.pdf",
    ]);
    expect(xero.state.writes.Attachments).toBe(1);
  });

  test("a refused upload keeps the bill and is not retried", async () => {
    xero.fail({
      on: "Attachments",
      method: "POST",
      status: 400,
      body: {
        Elements: [{ ValidationErrors: [{ Message: "File is too large" }] }],
      },
    });
    const posted = await post();
    expect(posted).toMatchObject({
      attached: false,
      attachmentError: "Xero refused the attachment: File is too large",
      attachmentRetryable: false,
    });
    expect(bills()).toHaveLength(1);
  });

  test("a credit note becomes a draft ACCPAYCREDIT credit note, found again by its history note", async () => {
    const credit: DraftBill = {
      ...bill,
      idempotencyKey: "invoicewise:credit-1",
      documentType: "credit_note",
      invoiceNumber: "CN-7",
    };
    const posted = await post(credit);
    expect(posted).toMatchObject({ entity: "vendor_credit", attached: true });
    const [note] = xero.records("tenant-1", "CreditNotes");
    expect(note).toMatchObject({
      CreditNoteID: posted.providerId,
      Type: "ACCPAYCREDIT",
      Status: "DRAFT",
      CreditNoteNumber: "CN-7",
    });
    expect(note).not.toHaveProperty("DueDate");
    expect(note).not.toHaveProperty("Url");
    expect(xero.history("tenant-1", posted.providerId)).toEqual([
      "InvoiceWise invoicewise:credit-1",
    ]);
    xero.expireIdempotencyKeys();
    const again = await post(credit, null);
    expect(again.providerId).toBe(posted.providerId);
    expect(xero.records("tenant-1", "CreditNotes")).toHaveLength(1);
    expect(bills()).toHaveLength(0);
  });

  describe("a credit note left without its history note", () => {
    const credit: DraftBill = {
      ...bill,
      idempotencyKey: "invoicewise:credit-2",
      documentType: "credit_note",
      invoiceNumber: "CN-8",
    };
    const notes = () => xero.records("tenant-1", "CreditNotes");

    test("recovers on retry after its create answer was lost and Xero forgot the key", async () => {
      xero.fail({
        on: "CreditNotes",
        method: "POST",
        status: 504,
        afterApply: true,
      });
      const lost = await post(credit, null).catch((error) => error);
      expect(isRetryable(lost)).toBe(true);
      xero.expireIdempotencyKeys();
      const posted = await post(credit, null);
      expect(notes()).toHaveLength(1);
      expect(posted.providerId).toBe(String(notes()[0]!.CreditNoteID));
      expect(xero.history("tenant-1", posted.providerId)).toEqual([
        "InvoiceWise invoicewise:credit-2",
      ]);
      expect((await post(credit, null)).providerId).toBe(posted.providerId);
      expect(xero.history("tenant-1", posted.providerId)).toHaveLength(1);
    });

    test("recovers on retry after its history note failed", async () => {
      xero.fail({ on: "History", method: "PUT", status: 500 });
      const failed = await post(credit, null).catch((error) => error);
      expect(isRetryable(failed)).toBe(true);
      const [created] = notes();
      expect(xero.history("tenant-1", String(created!.CreditNoteID))).toEqual(
        [],
      );
      xero.expireIdempotencyKeys();
      const posted = await post(credit, null);
      expect(notes()).toHaveLength(1);
      expect(posted.providerId).toBe(String(created!.CreditNoteID));
      expect(xero.history("tenant-1", posted.providerId)).toEqual([
        "InvoiceWise invoicewise:credit-2",
      ]);
    });

    test("still refuses a same-numbered credit note with other lines", async () => {
      xero.fail({ on: "History", method: "PUT", status: 500 });
      await post(credit, null).catch(() => undefined);
      xero.expireIdempotencyKeys();
      const refused = await post(
        {
          ...credit,
          netAmount: 50,
          vatAmount: 10,
          grossAmount: 60,
          lineItems: [],
        },
        null,
      ).catch((error) => error);
      expect(refused).toBeInstanceOf(BillRejectedError);
      expect(refused.message).toContain("that InvoiceWise did not create");
      expect(notes()).toHaveLength(1);
    });
  });

  test("prefers the chosen tax rate where several share one, and refuses an ambiguous or unmatched rate", async () => {
    const zeroRated: DraftBill = {
      ...bill,
      vatAmount: 0,
      grossAmount: 150,
    };
    const ambiguous = await post(zeroRated, null).catch((error) => error);
    expect(ambiguous).toBeInstanceOf(BillRejectedError);
    expect(ambiguous.message).toContain("Several Xero purchase tax codes");
    await post(zeroRated, null, {
      ...configured,
      settings: { expenseAccountId: "429", taxCodeIds: ["ZERORATEDINPUT"] },
    });
    expect(
      (bills()[0]!.LineItems as { TaxType: string }[]).map(
        (line) => line.TaxType,
      ),
    ).toEqual(["ZERORATEDINPUT", "ZERORATEDINPUT"]);
    const unmatched = await post(
      {
        ...bill,
        idempotencyKey: "invoicewise:twelve",
        invoiceNumber: "INV-12",
        vatAmount: 18,
        grossAmount: 168,
      },
      null,
    ).catch((error) => error);
    expect(unmatched.message).toContain(
      "No active Xero purchase tax code matches the 12% tax",
    );
  });

  test("refuses a currency the organisation does not use and posts one it does", async () => {
    const usd = await post({ ...bill, currency: "USD" }, null).catch(
      (error) => error,
    );
    expect(usd).toBeInstanceOf(BillRejectedError);
    expect(usd.message).toContain("add USD in Xero's currency settings");
    await post({ ...bill, currency: "EUR" }, null);
    expect(bills()[0]?.CurrencyCode).toBe("EUR");
  });

  test("names what to fix when setup, the supplier or the organisation is missing", async () => {
    const noAccount = await post(bill, null, {
      ...configured,
      settings: { expenseAccountId: null, taxCodeIds: [] },
    }).catch((error) => error);
    expect(noAccount.message).toBe(
      "Choose the Xero account for bill lines in Settings → Accounting",
    );
    const noSupplier = await post({ ...bill, supplierName: null }, null).catch(
      (error) => error,
    );
    expect(noSupplier.message).toBe("Xero needs the supplier name");
    connectionConfig = {};
    const noOrganisation = await post(bill, null, {
      ...configured,
      organisationId: null,
    }).catch((error) => error);
    expect(noOrganisation).toBeInstanceOf(BillRejectedError);
    // An organisation the authorisation no longer reaches is refused by Xero
    // with 403, which asks for a reconnect rather than being retried.
    xero.state.reachable = ["tenant-2"];
    const unreachable = await post(bill, null).catch((error) => error);
    expect(unreachable).toBeInstanceOf(NangoRequestError);
    expect(isRetryable(unreachable)).toBe(false);
    expect(bills()).toHaveLength(0);
  });

  test("surfaces Xero's validation errors as a permanent refusal", async () => {
    const refused = await post(bill, null, {
      ...configured,
      settings: { expenseAccountId: "499", taxCodeIds: [] },
    }).catch((error) => error);
    expect(refused).toBeInstanceOf(BillRejectedError);
    expect(refused.message).toBe(
      "Xero refused the bill: Account code '499' is not a valid code for this document.",
    );
  });

  const postedXeroLines = async (
    lineItems: DraftBill["lineItems"],
    netAmount: number,
  ) => {
    await post(
      { ...bill, lineItems, netAmount, vatAmount: netAmount * 0.2 },
      null,
    );
    return (bills()[0]!.LineItems as Record<string, unknown>[]).map(
      ({ Description, Quantity, UnitAmount }) => ({
        Description,
        Quantity,
        UnitAmount,
      }),
    );
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

  test("reads the organisations a connection reaches and keeps the chosen one", async () => {
    connectionConfig = { tenant_id: "tenant-1" };
    expect(
      await readProviderOrganisation("xero", config, "conn-1", "tenant-2"),
    ).toEqual({ id: "tenant-2", name: "Second Synthetic Ltd" });
    // No choice yet: the one Nango recorded at connect.
    expect(await readProviderOrganisation("xero", config, "conn-1")).toEqual({
      id: "tenant-1",
      name: "Synthetic Demo Ltd",
    });
    // A choice the authorisation no longer reaches falls back, so the health
    // check sees a different organisation.
    xero.state.reachable = ["tenant-1"];
    expect(
      (await readProviderOrganisation("xero", config, "conn-1", "tenant-2")).id,
    ).toBe("tenant-1");
    const setup = await getXeroSetupOptions(config, configured);
    expect(setup.organisations.map((organisation) => organisation.id)).toEqual([
      "tenant-1",
    ]);
    expect(setup.accounts.map((account) => account.id)).toEqual(["429", "310"]);
    expect(setup.taxCodes.map((code) => code.id)).toEqual([
      "INPUT2",
      "RRINPUT",
      "ZERORATEDINPUT",
      "EXEMPTEXPENSES",
      "NONE",
    ]);
    expect(setup.currencies).toEqual(["GBP", "EUR"]);
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

  const xeroTarget = {
    connectionId: "conn-1",
    organisationId: "tenant-1",
    settings: { expenseAccountId: "429", taxCodeIds: [] },
  };

  test("Xero updates the same bill in place, leaving its status alone", async () => {
    const config = getNangoConfig("xero", env);
    const posted = await postProviderBill(
      "xero",
      config,
      xeroTarget,
      bill,
      null,
    );
    calls = [];
    const updated = await updateProviderBill(
      "xero",
      config,
      xeroTarget,
      posted.providerId,
      { ...corrected, netAmount: 150, vatAmount: 30, grossAmount: 180 },
    );
    expect(updated).toEqual({ providerId: posted.providerId });
    const call = calls.find((entry) => entry.method === "POST")!;
    expect(call.path).toBe(`/api.xro/2.0/Invoices/${posted.providerId}`);
    expect(call.headers.get("nango-proxy-idempotency-key")).toBe(
      corrected.idempotencyKey,
    );
    const [sent] = (call.json as { Invoices: Record<string, unknown>[] })
      .Invoices;
    expect(sent?.InvoiceID).toBe(posted.providerId);
    expect(sent).not.toHaveProperty("Status");
    expect(sent).not.toHaveProperty("Type");
    // No second bill exists.
    expect(xero.records("tenant-1", "Invoices")).toHaveLength(1);
  });

  test("Xero refuses a correction that changes the document type", async () => {
    const config = getNangoConfig("xero", env);
    const refused = await updateProviderBill(
      "xero",
      config,
      xeroTarget,
      "some-bill",
      { ...corrected, documentType: "credit_note" },
    ).catch((error) => error);
    expect(refused).toBeInstanceOf(BillRejectedError);
  });

  test("Xero without the bill fails permanently rather than creating one", async () => {
    const config = getNangoConfig("xero", env);
    const failure = await updateProviderBill(
      "xero",
      config,
      xeroTarget,
      "unknown-bill",
      { ...corrected, netAmount: 150, vatAmount: 30, grossAmount: 180 },
    ).catch((error) => error);
    expect(isRetryable(failure)).toBe(false);
    expect(xero.records("tenant-1", "Invoices")).toHaveLength(0);
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

describe("Nango metering", () => {
  test("Nango answering that an integration does not exist is not a provider failure", async () => {
    const events: NangoCallEvent[] = [];
    observeNangoCalls((event) => events.push(event));
    try {
      const config = getNangoConfig("xero", env);
      await nangoRequest(config, "/integrations/xero", { method: "GET" }).catch(
        () => undefined,
      );
      await nangoProxy(config, "conn-1", {
        method: "GET",
        path: "/api.xro/2.0/NoSuchResource",
        headers: { "Xero-Tenant-Id": "tenant-1" },
      }).catch(() => undefined);
    } finally {
      observeNangoCalls(undefined);
    }
    expect(
      events.map(({ operation, outcome }) => [operation, outcome]),
    ).toEqual([
      ["api:xero", "ok"],
      ["proxy:xero", "failed"],
    ]);
  });
});
