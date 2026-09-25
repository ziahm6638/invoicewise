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
 *   attachment each. It then disconnects (deletes the Nango connection, as
 *   Settings → Accounting does) and shows the connection gone and a post
 *   through it refused as needing a reconnect. After an admin reconnects
 *   Xero in Settings, `xero-reconnect` with the new connection ID and the
 *   first run's stamp shows the new connection reaching the same Demo Company
 *   and a repeated delivery finding the same bill and credit note, not
 *   adding any. XERO_PROOF_TENANT_ID picks the organisation when the
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
 *   bun run prove:accounting-sandbox xero-reconnect <connection id> <stamp>
 *
 * Reads NANGO_BASE_URL, NANGO_SECRET_KEY and the integration IDs from the
 * environment. Prints IDs and timestamps only, never credentials.
 */
import { join } from "node:path";
import type { AccountingProvider } from "@invoicewise/db/queries";
import {
  accountingFailure,
  providerBillUrl,
  revokeAccountingConnection,
} from "./accounting";
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

const [mode, connectionId, reconnectStamp] = process.argv.slice(2);
if (
  !connectionId ||
  (mode !== "xero" &&
    mode !== "quickbooks" &&
    !(mode === "xero-reconnect" && Number(reconnectStamp) > 0))
) {
  console.error(
    "usage: prove-accounting-sandbox.ts <xero|quickbooks> <connection id>\n" +
      "       prove-accounting-sandbox.ts xero-reconnect <connection id> <stamp>",
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

/**
 * The Demo Company a Xero connection reaches, with the account and tax rate
 * the proof posts to. Refuses any organisation that is not a Demo Company.
 */
async function xeroProofSetup(config: NangoConfig, connectionId: string) {
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
  const xeroDocuments = (stamp: number) => ({
    bill: syntheticBill(stamp, {
      currency: setup.organisation.baseCurrency,
      vatAmount: tax,
      grossAmount: 100 + tax,
      sourceUrl: "https://app.invoicewise.uk/inbox?inboxId=sandbox-proof",
    }),
    credit: syntheticBill(stamp, {
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
    }),
  });
  const organisation = {
    name: setup.organisation.name,
    country: setup.organisation.countryCode,
    baseCurrency: setup.organisation.baseCurrency,
    demo: setup.organisation.demo,
    tenant: `…${tenantId.slice(-4)}`,
  };
  return {
    tenantId,
    account,
    taxCode,
    connection,
    organisation,
    documents: xeroDocuments,
  };
}

/** Xero's own records, read through the proxy with the proof's tenant. */
function xeroProofApi(
  config: NangoConfig,
  connectionId: string,
  tenantId: string,
  idempotencyKey?: string,
) {
  const api = (method: "GET" | "POST", path: string, json?: unknown) =>
    nangoProxy(config, connectionId, {
      method,
      path: `/api.xro/2.0${path}`,
      headers: {
        "Xero-Tenant-Id": tenantId,
        ...(json && idempotencyKey
          ? { "Idempotency-Key": idempotencyKey }
          : {}),
      },
      json,
    }).then(asRecord);
  const rows = (body: Record<string, unknown>, key: string) =>
    Array.isArray(body[key]) ? body[key].map(asRecord) : [];
  const live = (row: Record<string, unknown>) =>
    row.Status !== "DELETED" && row.Status !== "VOIDED";
  const withNumber = async (entity: "bill" | "credit", number: string) =>
    entity === "bill"
      ? rows(
          await api(
            "GET",
            `/Invoices?${new URLSearchParams({ where: `Type=="ACCPAY" AND InvoiceNumber=="${number}"` })}`,
          ),
          "Invoices",
        ).filter(live)
      : rows(
          await api(
            "GET",
            `/CreditNotes?${new URLSearchParams({ where: `Type=="ACCPAYCREDIT" AND CreditNoteNumber=="${number}"` })}`,
          ),
          "CreditNotes",
        ).filter(live);
  const attachments = async (
    collection: "Invoices" | "CreditNotes",
    id: string,
  ) =>
    rows(await api("GET", `/${collection}/${id}/Attachments`), "Attachments");
  return { api, rows, withNumber, attachments };
}

async function proveXero(config: NangoConfig, connectionId: string) {
  const token = await refreshToken(config, connectionId);
  const { tenantId, account, taxCode, connection, organisation, documents } =
    await xeroProofSetup(config, connectionId);
  const stamp = Date.now();
  const { bill, credit } = documents(stamp);
  const { api, rows, withNumber, attachments } = xeroProofApi(
    config,
    connectionId,
    tenantId,
    bill.idempotencyKey,
  );

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

  const bills = await withNumber("bill", bill.invoiceNumber!);
  const credits = await withNumber("credit", credit.invoiceNumber!);
  const billAttachments = await attachments("Invoices", recovered.providerId);
  const creditAttachments = await attachments(
    "CreditNotes",
    credited.providerId,
  );

  // 7. Disconnect deletes the Nango connection, as Settings → Accounting
  //    does; the connection is gone and a post through it needs a reconnect.
  await revokeAccountingConnection({
    provider: "xero",
    connectionId,
    integrationId: config.integrationId,
  });
  const afterDisconnect = await getNangoConnection(config, connectionId).then(
    () => ({ reason: "the connection still exists", retryable: true }),
    (error: unknown) => accountingFailure("xero", error),
  );
  const postAfterDisconnect = await postProviderBill(
    "xero",
    config,
    connection,
    bill,
    null,
  ).then(
    () => ({ reason: "posted", retryable: true }),
    (error: unknown) => accountingFailure("xero", error),
  );
  const [created] = bills;
  const result = {
    provider: "xero",
    stamp,
    organisation,
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
    disconnect: {
      at: new Date().toISOString(),
      connection: afterDisconnect.reason,
      postAfterDisconnect: postAfterDisconnect.reason,
    },
    next: `An admin reconnects Xero to the same Demo Company in Settings → Accounting, then: bun run prove:accounting-sandbox xero-reconnect <new connection id> ${stamp}`,
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
      creditAttachments.length === 1 &&
      !afterDisconnect.retryable &&
      postAfterDisconnect.reason !== "posted",
  };
}

/**
 * After a disconnect and a reconnect through Settings → Accounting: the new
 * connection reaches the same Demo Company, and delivering the first run's
 * bill and credit note again finds the records it created (each still with
 * its one attachment) instead of adding any.
 */
async function proveXeroReconnect(
  config: NangoConfig,
  connectionId: string,
  stamp: number,
) {
  const token = await refreshToken(config, connectionId);
  const { tenantId, connection, organisation, documents } =
    await xeroProofSetup(config, connectionId);
  const { bill, credit } = documents(stamp);
  const { withNumber, attachments } = xeroProofApi(
    config,
    connectionId,
    tenantId,
  );
  const before = {
    bills: await withNumber("bill", bill.invoiceNumber!),
    credits: await withNumber("credit", credit.invoiceNumber!),
  };
  const repeated = await postProviderBill(
    "xero",
    config,
    connection,
    bill,
    null,
  );
  const creditRepeated = await postProviderBill(
    "xero",
    config,
    connection,
    credit,
    null,
  );
  const bills = await withNumber("bill", bill.invoiceNumber!);
  const credits = await withNumber("credit", credit.invoiceNumber!);
  const billAttachments = await attachments("Invoices", repeated.providerId);
  const creditAttachments = await attachments(
    "CreditNotes",
    creditRepeated.providerId,
  );
  const result = {
    provider: "xero",
    stage: "reconnect",
    stamp,
    organisation,
    tokenExpiresAt: token.tokenExpiresAt,
    reconnectedAt: new Date().toISOString(),
    bill: {
      number: bill.invoiceNumber,
      providerIdBefore: before.bills.map((row) => String(row.InvoiceID)),
      repeatedDeliveryId: repeated.providerId,
      url: providerBillUrl("xero", repeated.providerId),
      billsWithThisNumber: bills.map((row) => String(row.InvoiceID)),
      attachments: billAttachments.map((file) => String(file.FileName)),
    },
    creditNote: {
      number: credit.invoiceNumber,
      providerIdBefore: before.credits.map((row) => String(row.CreditNoteID)),
      repeatedDeliveryId: creditRepeated.providerId,
      url: providerBillUrl("xero", creditRepeated.providerId, {
        entity: "vendor_credit",
      }),
      creditsWithThisNumber: credits.length,
      attachments: creditAttachments.length,
    },
  };
  return {
    result,
    ok:
      before.bills.length === 1 &&
      bills.length === 1 &&
      before.bills[0]?.InvoiceID === repeated.providerId &&
      billAttachments.length === 1 &&
      before.credits.length === 1 &&
      credits.length === 1 &&
      before.credits[0]?.CreditNoteID === creditRepeated.providerId &&
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

async function main(mode: string, connectionId: string) {
  const provider: AccountingProvider =
    mode === "quickbooks" ? "quickbooks" : "xero";
  const config = getNangoConfig(provider);
  const { result, ok } =
    mode === "xero-reconnect"
      ? await proveXeroReconnect(config, connectionId, Number(reconnectStamp))
      : provider === "xero"
        ? await proveXero(config, connectionId)
        : await proveQuickBooks(config, connectionId);
  console.log(JSON.stringify({ connectionId, ...result }, null, 2));
  if (!ok) process.exit(1);
}

main(mode, connectionId).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
