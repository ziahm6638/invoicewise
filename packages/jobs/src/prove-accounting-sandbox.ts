/**
 * Live proof against a provider sandbox company through self-hosted Nango
 * (docs/accounting-integrations.md, "Sandbox proof"), with synthetic records
 * only. It forces a token refresh, then:
 *
 * - Xero (a Demo Company only): posts a draft bill whose create response is
 *   lost in transit, retries it and gets the same bill, replays the raw
 *   create under the same Idempotency-Key, sends the invoice again (found by
 *   number, contact and InvoiceWise's key), uploads the PDF with a lost
 *   response and retries the upload on its own, posts a draft credit note
 *   twice, and counts what Xero holds: one record per reference, one
 *   attachment each. XERO_PROOF_TENANT_ID picks the organisation when the
 *   connection reaches several; XERO_PROOF_ACCOUNT_CODE and
 *   XERO_PROOF_TAX_TYPE override the account and tax rate.
 * - QuickBooks: posts an open bill whose create response is lost in transit
 *   (the request reaches QuickBooks, the answer never comes back), retries it
 *   and gets the same bill, replays the raw create under the same
 *   `requestid`, uploads the PDF with a lost response and retries the upload
 *   on its own, posts a vendor credit, and counts the records QuickBooks
 *   holds under each reference: exactly one of each, one attachment each.
 *
 *   bun run prove:accounting-sandbox <xero|quickbooks> <connection id>
 *
 * Reads NANGO_BASE_URL, NANGO_SECRET_KEY and the integration IDs from the
 * environment. Prints IDs and timestamps only, never credentials.
 */
import { join } from "node:path";
import type { AccountingProvider } from "@invoicewise/db/queries";
import { providerBillUrl } from "./accounting";
import {
  type BillAttachment,
  type DraftBill,
  attachProviderDocument,
  getQuickBooksSetupOptions,
  getXeroSetupOptions,
  listXeroOrganisations,
  postProviderBill,
  quickBooksRequestId,
} from "./accounting-providers";
import {
  type NangoConfig,
  asRecord,
  getNangoConfig,
  getNangoConnection,
  nangoProxy,
} from "./nango";

const [provider, connectionId] = process.argv.slice(2);
if ((provider !== "xero" && provider !== "quickbooks") || !connectionId) {
  console.error(
    "usage: prove-accounting-sandbox.ts <xero|quickbooks> <connection id>",
  );
  process.exit(2);
}

// Simulates a lost response: the matching request reaches the provider and
// is applied, but its answer is dropped as if the connection reset.
let loseNextResponse: RegExp | null = null;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const response = await realFetch(input, init);
  const url = input instanceof Request ? input.url : String(input);
  if (loseNextResponse?.test(url) && init?.method === "POST") {
    loseNextResponse = null;
    await response.arrayBuffer();
    throw new TypeError(
      "Simulated: the connection reset before the response arrived",
    );
  }
  return response;
}) as typeof fetch;

const syntheticBill = (
  stamp: number,
  overrides: Partial<DraftBill> = {},
): DraftBill => ({
  idempotencyKey: `invoicewise:sandbox-proof-${stamp}`,
  documentType: "invoice",
  supplierName: "InvoiceWise Sandbox Supplier Ltd",
  supplierTaxNumber: null,
  invoiceNumber: `IW-P-${stamp}`,
  invoiceDate: new Date().toISOString().slice(0, 10),
  dueDate: null,
  currency: null,
  netAmount: 100,
  vatAmount: 20,
  grossAmount: 120,
  description: "InvoiceWise sandbox proof",
  lineItems: [
    {
      description: "Sandbox proof line",
      quantity: 1,
      unitPrice: 100,
      total: 100,
    },
  ],
  ...overrides,
});

const loadAttachment = async (): Promise<BillAttachment> => ({
  fileName: "invoicewise-sandbox-proof.pdf",
  contentType: "application/pdf",
  data: await Bun.file(
    join(__dirname, "../../documents/src/test/fixtures/uk-invoice.pdf"),
  ).arrayBuffer(),
});

async function refreshToken(config: NangoConfig, connectionId: string) {
  const before = await getNangoConnection(config, connectionId);
  const after = await getNangoConnection(config, connectionId, {
    refresh: true,
  });
  return {
    before,
    tokenExpiresAt: {
      before: before.tokenExpiresAt,
      after: after.tokenExpiresAt,
    },
    tokenRefreshed: after.tokenExpiresAt !== before.tokenExpiresAt,
  };
}

async function proveXero(config: NangoConfig, connectionId: string) {
  const token = await refreshToken(config, connectionId);
  const organisations = await listXeroOrganisations(config, connectionId);
  const tenantId =
    process.env.XERO_PROOF_TENANT_ID ??
    (organisations.length === 1 ? organisations[0]!.id : undefined);
  if (!tenantId) {
    throw new Error(
      `The connection reaches ${organisations.length} organisations; set XERO_PROOF_TENANT_ID to the Demo Company's`,
    );
  }
  const setup = await getXeroSetupOptions(config, {
    connectionId,
    organisationId: tenantId,
  });
  // Synthetic records go only to Xero's resettable Demo Company.
  if (!setup.organisation.demo) {
    throw new Error(
      `${setup.organisation.name ?? tenantId} is not a Xero Demo Company; the proof refuses to write to it`,
    );
  }
  const account =
    setup.accounts.find(
      (candidate) => candidate.id === process.env.XERO_PROOF_ACCOUNT_CODE,
    ) ??
    setup.accounts.find((candidate) => candidate.id === "429") ??
    setup.accounts[0];
  if (!account) throw new Error("The organisation has no expense account");
  const taxCode =
    setup.taxCodes.find(
      (candidate) => candidate.id === process.env.XERO_PROOF_TAX_TYPE,
    ) ?? setup.taxCodes.find((candidate) => candidate.rate > 0);
  if (!taxCode) throw new Error("The organisation has no purchase tax rate");
  const connection = {
    connectionId,
    organisationId: tenantId,
    settings: { expenseAccountId: account.id, taxCodeIds: [taxCode.id] },
  };
  const tax = Math.round(taxCode.rate * 100) / 100;
  const stamp = Date.now();
  const bill = syntheticBill(stamp, {
    currency: setup.organisation.baseCurrency,
    vatAmount: tax,
    grossAmount: 100 + tax,
    sourceUrl: "https://app.invoicewise.uk/inbox?inboxId=sandbox-proof",
  });
  const api = (method: "GET" | "POST", path: string, json?: unknown) =>
    nangoProxy(config, connectionId, {
      method,
      path: `/api.xro/2.0${path}`,
      headers: {
        "Xero-Tenant-Id": tenantId,
        ...(json ? { "Idempotency-Key": bill.idempotencyKey } : {}),
      },
      json,
    }).then(asRecord);
  const rows = (body: Record<string, unknown>, key: string) =>
    Array.isArray(body[key]) ? body[key].map(asRecord) : [];

  // 1. The create reaches Xero but its answer is lost.
  loseNextResponse = /\/proxy\/api\.xro\/2\.0\/Invoices$/;
  const lost = await postProviderBill(
    "xero",
    config,
    connection,
    bill,
    null,
  ).then(
    () => "answered",
    (error: Error) => error.message,
  );
  // 2. The retry returns the bill Xero created instead of adding one.
  const recovered = await postProviderBill(
    "xero",
    config,
    connection,
    bill,
    null,
  );
  // 3. The raw create replayed under the same Idempotency-Key returns it.
  const [replayed] = rows(
    await api("POST", "/Invoices", {
      Invoices: [{ Type: "ACCPAY", Status: "DRAFT", Contact: { Name: "-" } }],
    }).catch((error: Error) => ({ Invoices: [{ error: error.message }] })),
    "Invoices",
  );
  // 4. A repeated delivery (the invoice sent again) finds the bill by its
  //    number, contact and InvoiceWise's key before creating anything.
  const repeated = await postProviderBill(
    "xero",
    config,
    connection,
    bill,
    null,
  );
  // 5. The upload reaches Xero but its answer is lost; retrying the
  //    attachment on its own twice leaves one attachment.
  const attachment = await loadAttachment();
  loseNextResponse = /\/Invoices\/[^/]+\/Attachments\/[^/]+$/;
  const lostUpload = await attachProviderDocument(
    "xero",
    config,
    connection,
    { providerId: recovered.providerId, entity: "bill" },
    attachment,
  ).then(
    () => "answered",
    (error: Error) => error.message,
  );
  for (let retry = 0; retry < 2; retry++) {
    await attachProviderDocument(
      "xero",
      config,
      connection,
      { providerId: recovered.providerId, entity: "bill" },
      attachment,
    );
  }
  // 6. A credit note becomes a draft credit note, once.
  const credit = syntheticBill(stamp, {
    idempotencyKey: `invoicewise:sandbox-proof-credit-${stamp}`,
    documentType: "credit_note",
    invoiceNumber: `IW-CN-${stamp}`,
    currency: setup.organisation.baseCurrency,
    netAmount: 40,
    vatAmount: Math.round(40 * taxCode.rate) / 100,
    grossAmount: 40 + Math.round(40 * taxCode.rate) / 100,
    lineItems: [
      {
        description: "Sandbox proof credit",
        quantity: 1,
        unitPrice: 40,
        total: 40,
      },
    ],
  });
  const credited = await postProviderBill(
    "xero",
    config,
    connection,
    credit,
    attachment,
  );
  const creditReplay = await postProviderBill(
    "xero",
    config,
    connection,
    credit,
    null,
  );

  const live = (row: Record<string, unknown>) =>
    row.Status !== "DELETED" && row.Status !== "VOIDED";
  const bills = rows(
    await api(
      "GET",
      `/Invoices?${new URLSearchParams({ where: `Type=="ACCPAY" AND InvoiceNumber=="${bill.invoiceNumber}"` })}`,
    ),
    "Invoices",
  ).filter(live);
  const credits = rows(
    await api(
      "GET",
      `/CreditNotes?${new URLSearchParams({ where: `Type=="ACCPAYCREDIT" AND CreditNoteNumber=="${credit.invoiceNumber}"` })}`,
    ),
    "CreditNotes",
  ).filter(live);
  const billAttachments = rows(
    await api("GET", `/Invoices/${recovered.providerId}/Attachments`),
    "Attachments",
  );
  const creditAttachments = rows(
    await api("GET", `/CreditNotes/${credited.providerId}/Attachments`),
    "Attachments",
  );
  const [created] = bills;
  const result = {
    provider: "xero",
    organisation: {
      name: setup.organisation.name,
      country: setup.organisation.countryCode,
      baseCurrency: setup.organisation.baseCurrency,
      demo: setup.organisation.demo,
      tenant: `…${tenantId.slice(-4)}`,
    },
    account: account.name,
    taxRate: `${taxCode.name} (${taxCode.id})`,
    tokenExpiresAt: token.tokenExpiresAt,
    tokenRefreshed: token.tokenRefreshed,
    bill: {
      number: bill.invoiceNumber,
      firstAttempt: lost,
      providerId: recovered.providerId,
      status: created?.Status ?? null,
      total: created?.Total ?? null,
      url: providerBillUrl("xero", recovered.providerId),
      idempotencyReplayId: replayed?.InvoiceID ?? replayed?.error ?? null,
      repeatedDeliveryId: repeated.providerId,
      uploadFirstAttempt: lostUpload,
      billsWithThisNumber: bills.map((row) => String(row.InvoiceID)),
      attachments: billAttachments.map((file) => String(file.FileName)),
    },
    creditNote: {
      number: credit.invoiceNumber,
      providerId: credited.providerId,
      status: credits[0]?.Status ?? null,
      replayReturnedSame: creditReplay.providerId === credited.providerId,
      url: providerBillUrl("xero", credited.providerId, {
        entity: "vendor_credit",
      }),
      creditsWithThisNumber: credits.length,
      attachments: creditAttachments.length,
    },
  };
  return {
    result,
    ok:
      token.tokenRefreshed &&
      lost !== "answered" &&
      bills.length === 1 &&
      created?.InvoiceID === recovered.providerId &&
      created.Status === "DRAFT" &&
      repeated.providerId === recovered.providerId &&
      lostUpload !== "answered" &&
      billAttachments.length === 1 &&
      credited.entity === "vendor_credit" &&
      result.creditNote.replayReturnedSame &&
      credits.length === 1 &&
      credits[0]?.Status === "DRAFT" &&
      creditAttachments.length === 1,
  };
}

async function proveQuickBooks(config: NangoConfig, connectionId: string) {
  const token = await refreshToken(config, connectionId);
  const setup = await getQuickBooksSetupOptions(config, connectionId);
  const account =
    setup.accounts.find(
      (candidate) => candidate.id === process.env.QUICKBOOKS_PROOF_ACCOUNT_ID,
    ) ?? setup.accounts[0];
  if (!account) throw new Error("The sandbox company has no expense account");
  const connection = {
    connectionId,
    settings: { expenseAccountId: account.id, taxCodeIds: [] },
  };
  const realm = setup.company.realmId;
  const call = (path: string, params: Record<string, string>, json?: unknown) =>
    nangoProxy(config, connectionId, {
      method: json === undefined ? "GET" : "POST",
      path: `/v3/company/${realm}${path}?${new URLSearchParams({ ...params, minorversion: "75" })}`,
      json,
    }).then(asRecord);
  const count = async (entity: string, where: string) => {
    const rows = asRecord(
      (
        await call("/query", {
          query: `select Id from ${entity} where ${where}`,
        })
      ).QueryResponse,
    )[entity];
    return Array.isArray(rows)
      ? rows.map((row) => String(asRecord(row).Id))
      : [];
  };

  const stamp = Date.now();
  const bill = syntheticBill(stamp, {
    currency: setup.company.homeCurrency,
  });

  // 1. The create reaches QuickBooks but its answer is lost.
  loseNextResponse = /\/proxy\/v3\/company\/[^/]+\/bill\?/;
  const lost = await postProviderBill(
    "quickbooks",
    config,
    connection,
    bill,
    null,
  ).then(
    () => "answered",
    (error: Error) => error.message,
  );
  // 2. The retry finds the bill QuickBooks created instead of adding one.
  const recovered = await postProviderBill(
    "quickbooks",
    config,
    connection,
    bill,
    null,
  );
  // 3. The raw create replayed under the same requestid returns that bill.
  const replay = asRecord(
    (
      await call(
        "/bill",
        { requestid: quickBooksRequestId(bill.idempotencyKey) },
        {
          VendorRef: { value: "0" },
          Line: [],
        },
      ).catch((error: Error) => ({ Bill: { error: error.message } }))
    ).Bill,
  );
  // 4. The upload reaches QuickBooks but its answer is lost; retrying the
  //    attachment on its own twice leaves one attachment.
  const attachment = await loadAttachment();
  loseNextResponse = /\/proxy\/v3\/company\/[^/]+\/upload\?/;
  const lostUpload = await attachProviderDocument(
    "quickbooks",
    config,
    connection,
    { providerId: recovered.providerId, entity: "bill" },
    attachment,
  ).then(
    () => "answered",
    (error: Error) => error.message,
  );
  for (let retry = 0; retry < 2; retry++) {
    await attachProviderDocument(
      "quickbooks",
      config,
      connection,
      { providerId: recovered.providerId, entity: "bill" },
      attachment,
    );
  }
  // 5. A credit note becomes a vendor credit, once.
  const credit = syntheticBill(stamp, {
    idempotencyKey: `invoicewise:sandbox-proof-credit-${stamp}`,
    documentType: "credit_note",
    invoiceNumber: `IW-CN-${stamp}`,
    currency: setup.company.homeCurrency,
    netAmount: 40,
    vatAmount: 8,
    grossAmount: 48,
    lineItems: [
      {
        description: "Sandbox proof credit",
        quantity: 1,
        unitPrice: 40,
        total: 40,
      },
    ],
  });
  const credited = await postProviderBill(
    "quickbooks",
    config,
    connection,
    credit,
    attachment,
  );
  const creditReplay = await postProviderBill(
    "quickbooks",
    config,
    connection,
    credit,
    null,
  );

  const bills = await count("Bill", `DocNumber = '${bill.invoiceNumber}'`);
  // QuickBooks keeps 21 characters of a reference; these fit whole.
  const credits = await count(
    "VendorCredit",
    `DocNumber = '${credit.invoiceNumber}'`,
  );
  const billAttachments = await count(
    "Attachable",
    `AttachableRef.EntityRef.Type = 'Bill' and AttachableRef.EntityRef.value = '${recovered.providerId}'`,
  );
  const creditAttachments = await count(
    "Attachable",
    `AttachableRef.EntityRef.Type = 'VendorCredit' and AttachableRef.EntityRef.value = '${credited.providerId}'`,
  );
  const result = {
    provider: "quickbooks",
    company: {
      name: setup.company.name,
      country: setup.company.country,
      homeCurrency: setup.company.homeCurrency,
      realm: `…${realm.slice(-4)}`,
    },
    expenseAccount: account.name,
    tokenExpiresAt: token.tokenExpiresAt,
    tokenRefreshed: token.tokenRefreshed,
    bill: {
      number: bill.invoiceNumber,
      firstAttempt: lost,
      providerId: recovered.providerId,
      url: providerBillUrl("quickbooks", recovered.providerId, {
        sandbox: true,
      }),
      requestIdReplayId: replay.Id ?? replay.error ?? null,
      uploadFirstAttempt: lostUpload,
      billsWithThisNumber: bills,
      attachments: billAttachments.length,
    },
    vendorCredit: {
      number: credit.invoiceNumber,
      providerId: credited.providerId,
      replayReturnedSame: creditReplay.providerId === credited.providerId,
      url: providerBillUrl("quickbooks", credited.providerId, {
        entity: "vendor_credit",
        sandbox: true,
      }),
      creditsWithThisNumber: credits,
      attachments: creditAttachments.length,
    },
  };
  return {
    result,
    ok:
      token.tokenRefreshed &&
      lost !== "answered" &&
      bills.length === 1 &&
      bills[0] === recovered.providerId &&
      replay.Id === recovered.providerId &&
      lostUpload !== "answered" &&
      billAttachments.length === 1 &&
      credited.entity === "vendor_credit" &&
      result.vendorCredit.replayReturnedSame &&
      credits.length === 1 &&
      creditAttachments.length === 1,
  };
}

async function main(provider: AccountingProvider, connectionId: string) {
  const config = getNangoConfig(provider);
  const { result, ok } =
    provider === "xero"
      ? await proveXero(config, connectionId)
      : await proveQuickBooks(config, connectionId);
  console.log(JSON.stringify({ connectionId, ...result }, null, 2));
  if (!ok) process.exit(1);
}

main(provider, connectionId).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
