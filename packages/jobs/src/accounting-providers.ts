import type { AccountingProvider } from "@invoicewise/db/queries";
import {
  type NangoConfig,
  asRecord,
  getNangoConnection,
  nangoProxy,
} from "./nango";

/**
 * Provider adapters that turn an extracted invoice into the provider's
 * non-payment bill, through Nango's proxy. Mappings (accounts, tax codes,
 * currencies) are deliberately minimal here; see
 * docs/accounting-integrations.md for what each provider receives.
 */
export type DraftBill = {
  idempotencyKey: string;
  supplierName: string | null;
  supplierTaxNumber: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  dueDate: string | null;
  currency: string | null;
  netAmount: number | null;
  vatAmount: number | null;
  grossAmount: number | null;
  description: string | null;
  lineItems: {
    description: string | null;
    quantity: number | null;
    unitPrice: number | null;
    total: number | null;
  }[];
};

export type BillAttachment = {
  fileName: string;
  contentType: string;
  data: ArrayBuffer;
};

export type PostedBill = {
  providerId: string;
  /** Whether the source document is now attached to the provider bill. */
  attached: boolean;
  attachmentError: string | null;
};

/** A reason the provider will never accept, however often it is retried. */
export class BillRejectedError extends Error {}

type Connection = { connectionId: string };

const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * The extracted lines when every one has an amount and they add up to the
 * net total, else one line carrying the invoice's net total. A line whose
 * quantity times unit price is not its total is sent as one unit of the total.
 */
const billLines = (bill: DraftBill) => {
  const lines = bill.lineItems
    .map((item) => {
      const quantity = item.quantity && item.quantity > 0 ? item.quantity : 1;
      const unitPrice =
        item.unitPrice ?? (item.total !== null ? item.total / quantity : null);
      if (unitPrice === null) return null;
      const description = item.description ?? "Invoice line";
      const total = round2(item.total ?? unitPrice * quantity);
      if (round2(quantity * round2(unitPrice)) !== total) {
        return { description, quantity: 1, unitPrice: total, total };
      }
      return { description, quantity, unitPrice: round2(unitPrice), total };
    })
    .filter((line) => line !== null);
  const linesTotal = lines.reduce((sum, line) => sum + line.total, 0);
  if (
    lines.length &&
    lines.length === bill.lineItems.length &&
    (bill.netAmount === null || Math.abs(linesTotal - bill.netAmount) <= 0.01)
  ) {
    return lines;
  }
  const amount = bill.netAmount ?? bill.grossAmount;
  if (amount === null) {
    throw new BillRejectedError("The invoice has no amount to post");
  }
  return [
    {
      description:
        bill.description ??
        (bill.invoiceNumber ? `Invoice ${bill.invoiceNumber}` : "Invoice"),
      quantity: 1,
      unitPrice: round2(amount),
      total: round2(amount),
    },
  ];
};

const attachmentFailure = (error: unknown) =>
  error instanceof Error ? error.message : "Attachment upload failed";

// Xero: an ACCPAY invoice in DRAFT is a bill awaiting review; it is neither
// approved nor paid. Xero replays the original response for a repeated
// Idempotency-Key, so an ambiguous timeout retried with the same key returns
// the bill it already created.
async function postXeroBill(
  config: NangoConfig,
  connection: Connection,
  bill: DraftBill,
  attachment: BillAttachment | null,
): Promise<PostedBill> {
  const { connectionConfig } = await getNangoConnection(
    config,
    connection.connectionId,
  );
  const tenantId = connectionConfig.tenant_id;
  if (typeof tenantId !== "string" || !tenantId) {
    throw new BillRejectedError(
      "The Xero connection has no organisation; reconnect Xero",
    );
  }
  const tenant = { "Xero-Tenant-Id": tenantId };
  const body = asRecord(
    await nangoProxy(config, connection.connectionId, {
      method: "POST",
      path: "/api.xro/2.0/Invoices",
      headers: { ...tenant, "Idempotency-Key": bill.idempotencyKey },
      json: {
        Invoices: [
          {
            Type: "ACCPAY",
            Status: "DRAFT",
            Contact: { Name: bill.supplierName ?? "Unknown supplier" },
            InvoiceNumber: bill.invoiceNumber ?? undefined,
            Date: bill.invoiceDate ?? undefined,
            DueDate: bill.dueDate ?? undefined,
            CurrencyCode: bill.currency ?? undefined,
            LineAmountTypes: "Exclusive",
            LineItems: billLines(bill).map((line) => ({
              Description: line.description,
              Quantity: line.quantity,
              UnitAmount: line.unitPrice,
            })),
          },
        ],
      },
    }),
  );
  const invoice = asRecord(
    Array.isArray(body.Invoices) ? body.Invoices[0] : undefined,
  );
  if (typeof invoice.InvoiceID !== "string") {
    throw new Error("Xero did not return the bill ID");
  }
  const providerId = invoice.InvoiceID;
  if (!attachment)
    return { providerId, attached: false, attachmentError: null };
  try {
    // POST replaces an attachment of the same name, so a retried upload
    // never duplicates the document on the bill.
    await nangoProxy(config, connection.connectionId, {
      method: "POST",
      path: `/api.xro/2.0/Invoices/${encodeURIComponent(providerId)}/Attachments/${encodeURIComponent(attachment.fileName)}`,
      headers: tenant,
      bytes: { data: attachment.data, contentType: attachment.contentType },
    });
    return { providerId, attached: true, attachmentError: null };
  } catch (error) {
    return {
      providerId,
      attached: false,
      attachmentError: attachmentFailure(error),
    };
  }
}

// QuickBooks Online has no draft bill: a Bill is created unpaid and open.
// `requestid` makes the create idempotent, so a retry after an ambiguous
// timeout returns the bill QuickBooks already created.
const QUICKBOOKS_MINOR_VERSION = "75";

const quote = (value: string) =>
  `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

async function postQuickBooksBill(
  config: NangoConfig,
  connection: Connection,
  bill: DraftBill,
  attachment: BillAttachment | null,
): Promise<PostedBill> {
  const { connectionConfig } = await getNangoConnection(
    config,
    connection.connectionId,
  );
  const realmId = connectionConfig.realmId;
  if (typeof realmId !== "string" || !realmId) {
    throw new BillRejectedError(
      "The QuickBooks connection has no company; reconnect QuickBooks",
    );
  }
  if (!bill.supplierName) {
    throw new BillRejectedError("QuickBooks needs the supplier name");
  }
  const company = `/v3/company/${encodeURIComponent(realmId)}`;
  const call = (
    method: "GET" | "POST",
    path: string,
    params: Record<string, string>,
    extra: Pick<Parameters<typeof nangoProxy>[2], "json" | "form"> = {},
  ) =>
    nangoProxy(config, connection.connectionId, {
      method,
      path: `${company}${path}?${new URLSearchParams({ ...params, minorversion: QUICKBOOKS_MINOR_VERSION })}`,
      ...extra,
    }).then(asRecord);
  const query = async (entity: string, statement: string) => {
    const result = asRecord(
      (await call("GET", "/query", { query: statement })).QueryResponse,
    );
    const rows = result[entity];
    return Array.isArray(rows) ? rows.map(asRecord) : [];
  };

  const [vendor] = await query(
    "Vendor",
    `select Id from Vendor where DisplayName = ${quote(bill.supplierName)}`,
  );
  const vendorId =
    vendor?.Id ??
    asRecord(
      (
        await call(
          "POST",
          "/vendor",
          {},
          { json: { DisplayName: bill.supplierName } },
        )
      ).Vendor,
    ).Id;
  const [account] = await query(
    "Account",
    "select Id from Account where AccountType = 'Expense' maxresults 1",
  );
  if (typeof vendorId !== "string" || typeof account?.Id !== "string") {
    throw new BillRejectedError(
      "QuickBooks has no supplier record or expense account to post against",
    );
  }

  const created = asRecord(
    (
      await call(
        "POST",
        "/bill",
        { requestid: bill.idempotencyKey },
        {
          json: {
            VendorRef: { value: vendorId },
            DocNumber: bill.invoiceNumber ?? undefined,
            TxnDate: bill.invoiceDate ?? undefined,
            DueDate: bill.dueDate ?? undefined,
            PrivateNote: `InvoiceWise ${bill.idempotencyKey}`,
            Line: billLines(bill).map((line) => ({
              DetailType: "AccountBasedExpenseLineDetail",
              Amount: line.total,
              Description: line.description,
              AccountBasedExpenseLineDetail: {
                AccountRef: { value: account.Id },
              },
            })),
          },
        },
      )
    ).Bill,
  );
  if (typeof created.Id !== "string") {
    throw new Error("QuickBooks did not return the bill ID");
  }
  const providerId = created.Id;
  if (!attachment)
    return { providerId, attached: false, attachmentError: null };
  try {
    const existing = await query(
      "Attachable",
      `select Id from Attachable where AttachableRef.EntityRef.Type = 'Bill' and AttachableRef.EntityRef.value = ${quote(providerId)}`,
    );
    if (existing.length) {
      return { providerId, attached: true, attachmentError: null };
    }
    const form = new FormData();
    form.append(
      "file_metadata_01",
      new Blob(
        [
          JSON.stringify({
            AttachableRef: [{ EntityRef: { type: "Bill", value: providerId } }],
            FileName: attachment.fileName,
            ContentType: attachment.contentType,
          }),
        ],
        { type: "application/json" },
      ),
      "metadata.json",
    );
    form.append(
      "file_content_01",
      new Blob([attachment.data], { type: attachment.contentType }),
      attachment.fileName,
    );
    await call("POST", "/upload", {}, { form });
    return { providerId, attached: true, attachmentError: null };
  } catch (error) {
    return {
      providerId,
      attached: false,
      attachmentError: attachmentFailure(error),
    };
  }
}

export const postProviderBill = (
  provider: AccountingProvider,
  config: NangoConfig,
  connection: Connection,
  bill: DraftBill,
  attachment: BillAttachment | null,
) =>
  provider === "xero"
    ? postXeroBill(config, connection, bill, attachment)
    : postQuickBooksBill(config, connection, bill, attachment);
