/**
 * Live proof against a provider sandbox company through self-hosted Nango
 * (docs/accounting-integrations.md, "Sandbox proof"), with synthetic records
 * only. It forces a token refresh, then:
 *
 * - Xero: posts a draft bill with the synthetic invoice PDF attached and
 *   replays the same idempotency key to show Xero returns the original bill.
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
  const bill = syntheticBill(Date.now(), { currency: "GBP" });
  const connection = { connectionId };
  const posted = await postProviderBill(
    "xero",
    config,
    connection,
    bill,
    await loadAttachment(),
  );
  const replayed = await postProviderBill(
    "xero",
    config,
    connection,
    bill,
    null,
  );
  const result = {
    provider: "xero",
    organisation: token.before.connectionConfig.tenant_id,
    tokenExpiresAt: token.tokenExpiresAt,
    tokenRefreshed: token.tokenRefreshed,
    bill: {
      providerId: posted.providerId,
      attached: posted.attached,
      attachmentError: posted.attachmentError,
      replayReturnedSameBill: replayed.providerId === posted.providerId,
    },
  };
  return {
    result,
    ok:
      token.tokenRefreshed &&
      posted.attached &&
      result.bill.replayReturnedSameBill,
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
