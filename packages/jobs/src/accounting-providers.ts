import { createHash } from "node:crypto";
import type { AccountingProvider } from "@invoicewise/db/queries";
import {
  type NangoConfig,
  NangoRequestError,
  asRecord,
  getNangoConnection,
  nangoProxy,
} from "./nango";

/**
 * Provider adapters that turn an extracted invoice into the provider's
 * non-payment document, through Nango's proxy: a Xero draft bill or draft
 * credit note, or a QuickBooks Online open bill or vendor credit, each mapped
 * onto the organisation's own contacts or vendors, expense account, tax codes
 * and currency. See
 * docs/accounting-integrations.md for what each provider receives.
 */
export type DraftBill = {
  idempotencyKey: string;
  /** A credit note's amounts arrive here as positive amounts credited. */
  documentType: "invoice" | "credit_note";
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
  /** The invoice's page in InvoiceWise, linked from the Xero bill. */
  sourceUrl?: string | null;
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

/** What the provider record is: a bill, or a credit note (vendor credit). */
export type ProviderEntity = "bill" | "vendor_credit";

export type PostedBill = {
  providerId: string;
  entity: ProviderEntity;
  /** Whether the source document is now attached to the provider record. */
  attached: boolean;
  attachmentError: string | null;
  /** Whether a failed attachment is worth uploading again on its own. */
  attachmentRetryable: boolean;
};

/**
 * A workspace's choices for posting to its connected company, made in
 * Settings → Accounting: the expense account every line posts to (Xero: its
 * account code), and the purchase tax codes (Xero: tax types) InvoiceWise may
 * choose between.
 */
export type AccountingSettings = {
  expenseAccountId?: string | null;
  taxCodeIds?: string[] | null;
};

/** A reason the provider will never accept, however often it is retried. */
export class BillRejectedError extends Error {}

type Connection = {
  connectionId: string;
  /** The organisation the workspace chose (Xero tenant, QuickBooks realm). */
  organisationId?: string | null;
  settings?: AccountingSettings;
};

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

/**
 * Uploads the source document once the provider record exists. A failed
 * upload never undoes the record: it is reported so the attachment can be
 * retried on its own (`attachProviderDocument`).
 */
async function withAttachment(
  record: { providerId: string; entity: ProviderEntity },
  attachment: BillAttachment | null,
  upload: () => Promise<unknown>,
): Promise<PostedBill> {
  if (!attachment) {
    return {
      ...record,
      attached: false,
      attachmentError: null,
      attachmentRetryable: false,
    };
  }
  try {
    await upload();
    return {
      ...record,
      attached: true,
      attachmentError: null,
      attachmentRetryable: false,
    };
  } catch (error) {
    return {
      ...record,
      attached: false,
      attachmentError:
        error instanceof Error ? error.message : "Attachment upload failed",
      attachmentRetryable: isRetryable(error),
    };
  }
}

/** Whether a failed provider call may succeed when repeated unchanged. */
export const isRetryable = (error: unknown) =>
  error instanceof BillRejectedError
    ? false
    : error instanceof NangoRequestError
      ? error.retryable
      : true;

// ---------------------------------------------------------------------------
// Xero. A bill is an ACCPAY invoice and a credit note an ACCPAYCREDIT credit
// note, both created in DRAFT: they await approval in Xero and are never
// approved or paid by InvoiceWise. Every call names the organisation the
// workspace chose (`Xero-Tenant-Id`), since one Xero authorisation can reach
// several. Business idempotency is two-layered like QuickBooks': Xero replays
// a repeated `Idempotency-Key`, and a create is preceded by a lookup of the
// same number from the same contact that carries InvoiceWise's key (a bill's
// `Url`, a credit note's history note), so a retry after Xero's replay window
// still finds the record instead of adding another.

const XERO_API = "/api.xro/2.0";

const XERO_ENTITY = {
  bill: {
    collection: "Invoices",
    idField: "InvoiceID",
    numberField: "InvoiceNumber",
    type: "ACCPAY",
    label: "bill",
  },
  vendor_credit: {
    collection: "CreditNotes",
    idField: "CreditNoteID",
    numberField: "CreditNoteNumber",
    type: "ACCPAYCREDIT",
    label: "credit note",
  },
} as const;

/** Statuses of a record that still stands (not deleted or voided). */
const XERO_LIVE_STATUSES = ["DRAFT", "SUBMITTED", "AUTHORISED", "PAID"];

/** Where a bill's "Go to InvoiceWise" link points when no page is given. */
const INVOICEWISE_APP_URL = "https://app.invoicewise.uk/inbox";

const xeroEntityOf = (bill: DraftBill): ProviderEntity =>
  bill.documentType === "credit_note" ? "vendor_credit" : "bill";

/** Xero's `where` filter takes a double-quoted string literal. */
const xeroLiteral = (value: string) =>
  /["\\]/.test(value) ? null : `"${value}"`;

/**
 * The bill's `Url`: the invoice's page in InvoiceWise ("Go to InvoiceWise"
 * in Xero), carrying the posting key that marks the bill as InvoiceWise's.
 */
const xeroSourceUrl = (bill: DraftBill) => {
  const url = new URL(bill.sourceUrl ?? INVOICEWISE_APP_URL);
  url.searchParams.set("posting", bill.idempotencyKey);
  return url.toString();
};

const carriesKey = (url: unknown, key: string) => {
  if (typeof url !== "string") return false;
  try {
    return new URL(url).searchParams.get("posting") === key;
  } catch {
    return false;
  }
};

export type XeroOrganisationChoice = { id: string; name: string | null };

/**
 * The organisations one Xero authorisation reaches (Xero's own
 * `/connections`, outside the accounting API), in the order Xero lists them.
 */
async function xeroTenants(
  config: NangoConfig,
  connectionId: string,
): Promise<XeroOrganisationChoice[]> {
  const body = await nangoProxy(config, connectionId, {
    method: "GET",
    path: "/connections",
  });
  return (Array.isArray(body) ? body : [])
    .map(asRecord)
    .filter(
      (tenant) =>
        typeof tenant.tenantId === "string" &&
        tenant.tenantId !== "" &&
        (tenant.tenantType === undefined ||
          tenant.tenantType === "ORGANISATION"),
    )
    .map((tenant) => ({
      id: String(tenant.tenantId),
      name: typeof tenant.tenantName === "string" ? tenant.tenantName : null,
    }));
}

/**
 * The organisation a Xero connection posts to: the one the workspace chose
 * (recorded on the connection), else the one Nango recorded at connect.
 */
async function xeroTenantId(config: NangoConfig, connection: Connection) {
  if (connection.organisationId) return connection.organisationId;
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
  return tenantId;
}

type XeroApi = ReturnType<typeof xeroApi>;

function xeroApi(config: NangoConfig, connectionId: string, tenantId: string) {
  const call = (
    method: "GET" | "POST" | "PUT",
    path: string,
    options: {
      params?: Record<string, string>;
      idempotencyKey?: string;
    } & Pick<Parameters<typeof nangoProxy>[2], "json" | "bytes"> = {},
  ) => {
    const query = options.params
      ? `?${new URLSearchParams(options.params)}`
      : "";
    return nangoProxy(config, connectionId, {
      method,
      path: `${XERO_API}${path}${query}`,
      headers: {
        "Xero-Tenant-Id": tenantId,
        ...(options.idempotencyKey
          ? { "Idempotency-Key": options.idempotencyKey }
          : {}),
      },
      json: options.json,
      bytes: options.bytes,
    }).then(asRecord);
  };
  const list = async (
    path: string,
    key: string,
    params?: Record<string, string>,
  ) => {
    const rows = (await call("GET", path, { params }))[key];
    return Array.isArray(rows) ? rows.map(asRecord) : [];
  };
  return { tenantId, call, list };
}

export type XeroOrganisation = {
  id: string;
  name: string | null;
  countryCode: string | null;
  baseCurrency: string | null;
  demo: boolean;
};

async function readXeroOrganisation(api: XeroApi): Promise<XeroOrganisation> {
  const [organisation] = await api.list("/Organisation", "Organisations");
  const text = (value: unknown) =>
    typeof value === "string" && value ? value : null;
  return {
    id: api.tenantId,
    name: text(organisation?.Name),
    countryCode: text(organisation?.CountryCode),
    baseCurrency: text(organisation?.BaseCurrency),
    demo: organisation?.IsDemoCompany === true,
  };
}

/** Active tax rates that apply to purchases, with their effective rate (%). */
async function xeroPurchaseTaxRates(api: XeroApi): Promise<TaxCode[]> {
  return (await api.list("/TaxRates", "TaxRates"))
    .filter(
      (rate) =>
        rate.Status === "ACTIVE" &&
        rate.CanApplyToExpenses === true &&
        typeof rate.TaxType === "string",
    )
    .map((rate) => ({
      id: String(rate.TaxType),
      name: String(rate.Name ?? rate.TaxType),
      rate: Number(rate.EffectiveRate ?? rate.DisplayTaxRate ?? 0),
    }));
}

/**
 * What an admin chooses from before Xero posting can start: the
 * organisations the authorisation reaches, the chosen organisation's active
 * expense accounts (by code, which bill lines carry) and purchase tax rates,
 * and the currencies it takes.
 */
export async function getXeroSetupOptions(
  config: NangoConfig,
  connection: Connection,
) {
  const tenantId = await xeroTenantId(config, connection);
  const api = xeroApi(config, connection.connectionId, tenantId);
  const [organisations, organisation, accounts, taxCodes, currencies] =
    await Promise.all([
      xeroTenants(config, connection.connectionId),
      readXeroOrganisation(api),
      api.list("/Accounts", "Accounts"),
      xeroPurchaseTaxRates(api),
      api.list("/Currencies", "Currencies"),
    ]);
  return {
    organisation,
    organisations,
    currencies: currencies
      .map((currency) => currency.Code)
      .filter((code): code is string => typeof code === "string"),
    accounts: accounts
      .filter(
        (account) =>
          account.Status === "ACTIVE" &&
          account.Class === "EXPENSE" &&
          typeof account.Code === "string" &&
          account.Code !== "",
      )
      .map((account) => ({
        id: String(account.Code),
        name: `${String(account.Code)} · ${String(account.Name ?? "")}`,
        type: String(account.Type ?? ""),
      })),
    taxCodes,
  };
}

/**
 * The supplier's Xero contact, found by name (Xero names are unique, ignoring
 * case) or created. A contact created by a concurrent post is found again; an
 * archived one is refused with the fix.
 */
async function resolveXeroContact(api: XeroApi, name: string) {
  const find = async () =>
    (
      await api.list("/Contacts", "Contacts", {
        searchTerm: name,
        includeArchived: "true",
      })
    ).find(
      (contact) =>
        typeof contact.Name === "string" &&
        contact.Name.trim().toLowerCase() === name.toLowerCase(),
    );
  let contact = await find();
  if (!contact) {
    try {
      const created = await api.call("POST", "/Contacts", {
        idempotencyKey: `invoicewise-contact:${createHash("sha256")
          .update(`${api.tenantId}:${name.toLowerCase()}`)
          .digest("hex")
          .slice(0, 40)}`,
        json: { Contacts: [{ Name: name }] },
      });
      contact = asRecord(
        Array.isArray(created.Contacts) ? created.Contacts[0] : undefined,
      );
    } catch (error) {
      if (!(error instanceof NangoRequestError && error.status === 400)) {
        throw error;
      }
      // Xero refuses a second contact with the same name: another post
      // created it meanwhile.
      contact = await find();
      if (!contact) {
        throw new BillRejectedError(
          `Xero refused the contact "${name}": ${error.message}`,
        );
      }
    }
  }
  if (typeof contact.ContactID !== "string") {
    throw new Error("Xero did not return the contact ID");
  }
  if (contact.ContactStatus === "ARCHIVED") {
    throw new BillRejectedError(
      `The Xero contact "${name}" is archived; restore it in Xero and retry`,
    );
  }
  return contact.ContactID;
}

/**
 * Everything a Xero bill or credit note is written against: the chosen
 * organisation, the contact, the configured account and each line's tax
 * rate. Every refusal names what to change.
 */
async function xeroContext(
  config: NangoConfig,
  connection: Connection,
  bill: DraftBill,
) {
  const accountCode = connection.settings?.expenseAccountId;
  if (!accountCode) {
    throw new BillRejectedError(
      "Choose the Xero account for bill lines in Settings → Accounting",
    );
  }
  const supplierName = bill.supplierName?.trim().slice(0, 255);
  if (!supplierName) {
    throw new BillRejectedError("Xero needs the supplier name");
  }
  const tenantId = await xeroTenantId(config, connection);
  const api = xeroApi(config, connection.connectionId, tenantId);
  const [organisation, currencies, taxRates] = await Promise.all([
    readXeroOrganisation(api),
    api.list("/Currencies", "Currencies"),
    xeroPurchaseTaxRates(api),
  ]);
  if (
    bill.currency &&
    bill.currency !== organisation.baseCurrency &&
    !currencies.some((currency) => currency.Code === bill.currency)
  ) {
    throw new BillRejectedError(
      `The invoice is in ${bill.currency}, which the Xero organisation does not use (base currency ${organisation.baseCurrency ?? "unknown"}); add ${bill.currency} in Xero's currency settings, or record it by hand`,
    );
  }
  const lines = billLines(bill);
  const net = round2(lines.reduce((sum, line) => sum + line.total, 0));
  const tax = round2(bill.vatAmount ?? 0);
  if (tax !== 0 && bill.netAmount === null) {
    throw new BillRejectedError(
      "Xero needs the invoice's net amount to apply its tax",
    );
  }
  const taxType = chooseTaxCode(
    "Xero",
    taxRates,
    connection.settings?.taxCodeIds ?? [],
    net,
    tax,
    lines.length,
  ).id;
  const contactId = await resolveXeroContact(api, supplierName);
  const entity = xeroEntityOf(bill);
  const fields = {
    Contact: { ContactID: contactId },
    [XERO_ENTITY[entity].numberField]: bill.invoiceNumber ?? undefined,
    Date: bill.invoiceDate ?? undefined,
    ...(entity === "bill" ? { DueDate: bill.dueDate ?? undefined } : {}),
    CurrencyCode: bill.currency ?? undefined,
    LineAmountTypes: "Exclusive",
    LineItems: lines.map((line) => ({
      Description: line.description,
      Quantity: line.quantity,
      UnitAmount: line.unitPrice,
      AccountCode: accountCode,
      TaxType: taxType,
    })),
  };
  return { api, organisation, contactId, fields };
}

/** Provider refusals as reasons a user can act on; see `isRetryable`. */
function xeroFailure(error: unknown, entity: ProviderEntity): unknown {
  if (!(error instanceof NangoRequestError) || error.status !== 400) {
    return error;
  }
  return new BillRejectedError(
    `Xero refused the ${XERO_ENTITY[entity].label}: ${error.message}`,
  );
}

/** Writes InvoiceWise's key on a credit note, which has no `Url`. */
const markXeroCreditNote = (api: XeroApi, id: string, key: string) =>
  api.call(
    "PUT",
    `/${XERO_ENTITY.vendor_credit.collection}/${encodeURIComponent(id)}/History`,
    { json: { HistoryRecords: [{ Details: `InvoiceWise ${key}` }] } },
  );

/** Whether a Xero record has the currency and lines InvoiceWise sends. */
const matchesXeroFields = (
  row: Record<string, unknown>,
  fields: Awaited<ReturnType<typeof xeroContext>>["fields"],
) => {
  const lines = Array.isArray(row.LineItems) ? row.LineItems.map(asRecord) : [];
  return (
    (fields.CurrencyCode === undefined ||
      row.CurrencyCode === fields.CurrencyCode) &&
    lines.length === fields.LineItems.length &&
    fields.LineItems.every((line, index) => {
      const sent = lines[index]!;
      return (
        sent.AccountCode === line.AccountCode &&
        sent.TaxType === line.TaxType &&
        round2(Number(sent.Quantity) * Number(sent.UnitAmount)) ===
          round2(line.Quantity * line.UnitAmount)
      );
    })
  );
};

/**
 * The record this post already created, found by number and contact with
 * InvoiceWise's key on it. A credit note gets its key only after the create,
 * so an unmarked draft credit note carrying exactly this invoice's lines is
 * the one a lost create answer or failed history note left behind: it is
 * marked and adopted. Any other same-numbered record from the same contact
 * is someone else's entry of this invoice: refused rather than duplicated.
 */
async function findXeroRecord(
  context: Awaited<ReturnType<typeof xeroContext>>,
  entity: ProviderEntity,
  bill: DraftBill,
) {
  const number = bill.invoiceNumber;
  if (!number) return null;
  const { collection, idField, numberField, type, label } = XERO_ENTITY[entity];
  const literal = xeroLiteral(number);
  const where = [
    `Type=="${type}"`,
    `Contact.ContactID=guid("${context.contactId}")`,
    ...(literal ? [`${numberField}==${literal}`] : []),
  ].join(" AND ");
  const sameNumber = (
    await context.api.list(`/${collection}`, collection, { where, page: "1" })
  ).filter(
    (row) =>
      row[numberField] === number &&
      typeof row.Status === "string" &&
      XERO_LIVE_STATUSES.includes(row.Status),
  );
  for (const row of sameNumber) {
    const id = String(row[idField]);
    const ours =
      entity === "bill"
        ? carriesKey(row.Url, bill.idempotencyKey)
        : (
            await context.api.list(
              `/${collection}/${encodeURIComponent(id)}/History`,
              "HistoryRecords",
            )
          ).some(
            (record) =>
              typeof record.Details === "string" &&
              record.Details.includes(bill.idempotencyKey),
          );
    if (ours) return id;
  }
  const unmarked =
    entity === "vendor_credit"
      ? sameNumber.filter(
          (row) =>
            row.Status === "DRAFT" && matchesXeroFields(row, context.fields),
        )
      : [];
  if (unmarked.length === 1) {
    const id = String(unmarked[0]![idField]);
    await markXeroCreditNote(context.api, id, bill.idempotencyKey);
    return id;
  }
  if (sameNumber.length) {
    throw new BillRejectedError(
      `Xero already has ${label} ${number} from ${bill.supplierName} (ID ${String(sameNumber[0]![idField])}) that InvoiceWise did not create; check whether it is this invoice, then delete or renumber one of them in Xero and retry`,
    );
  }
  return null;
}

async function postXeroDocument(
  config: NangoConfig,
  connection: Connection,
  bill: DraftBill,
  attachment: BillAttachment | null,
): Promise<PostedBill> {
  const entity = xeroEntityOf(bill);
  const { collection, idField } = XERO_ENTITY[entity];
  const context = await xeroContext(config, connection, bill);
  let providerId = await findXeroRecord(context, entity, bill);
  if (!providerId) {
    const created = await context.api
      .call("POST", `/${collection}`, {
        idempotencyKey: bill.idempotencyKey,
        json: {
          [collection]: [
            {
              Type: XERO_ENTITY[entity].type,
              Status: "DRAFT",
              ...context.fields,
              ...(entity === "bill" ? { Url: xeroSourceUrl(bill) } : {}),
            },
          ],
        },
      })
      .catch((error) => {
        throw xeroFailure(error, entity);
      });
    const record = asRecord(
      Array.isArray(created[collection]) ? created[collection][0] : undefined,
    );
    if (typeof record[idField] !== "string") {
      throw new Error(
        `Xero did not return the ${XERO_ENTITY[entity].label} ID`,
      );
    }
    providerId = record[idField];
    if (entity === "vendor_credit") {
      // A credit note has no Url, so its key goes in its history, where a
      // later lookup recognises it.
      await markXeroCreditNote(context.api, providerId, bill.idempotencyKey);
    }
  }
  const id = providerId;
  return withAttachment({ providerId: id, entity }, attachment, () =>
    attachXeroDocument(context.api, entity, id, attachment!),
  );
}

/**
 * Attaches the source document unless a file of that name is already on the
 * record, so a retried upload (including one whose response was lost) never
 * adds a copy.
 */
async function attachXeroDocument(
  api: XeroApi,
  entity: ProviderEntity,
  providerId: string,
  attachment: BillAttachment,
) {
  const base = `/${XERO_ENTITY[entity].collection}/${encodeURIComponent(providerId)}/Attachments`;
  const existing = await api.list(base, "Attachments");
  if (existing.some((file) => file.FileName === attachment.fileName)) return;
  await api
    .call("POST", `${base}/${encodeURIComponent(attachment.fileName)}`, {
      bytes: { data: attachment.data, contentType: attachment.contentType },
    })
    .catch((error) => {
      throw error instanceof NangoRequestError && error.status === 400
        ? new BillRejectedError(`Xero refused the attachment: ${error.message}`)
        : error;
    });
}

/**
 * The organisation a Xero connection reaches: `preferred` (the one the
 * workspace chose) while the authorisation still reaches it, else the one
 * Nango recorded at connect, else the first Xero lists. Its details are read
 * with its own tenant header, so the organisation is proven to answer.
 */
async function readXeroConnectionOrganisation(
  config: NangoConfig,
  connectionId: string,
  preferred: string | null,
) {
  const organisations = await xeroTenants(config, connectionId);
  const recorded = asRecord(
    (await getNangoConnection(config, connectionId)).connectionConfig,
  ).tenant_id;
  const chosen =
    organisations.find((organisation) => organisation.id === preferred) ??
    organisations.find((organisation) => organisation.id === recorded) ??
    organisations[0];
  if (!chosen) {
    throw new BillRejectedError(
      "The Xero authorisation reaches no organisation; reconnect Xero and choose one",
    );
  }
  const details = await readXeroOrganisation(
    xeroApi(config, connectionId, chosen.id),
  );
  return {
    id: chosen.id,
    name: details.name ?? chosen.name,
    organisations,
  };
}

/** The organisations a Xero connection may post to, for the admin's choice. */
export const listXeroOrganisations = xeroTenants;

// ---------------------------------------------------------------------------
// QuickBooks Online. There is no draft bill: a Bill is created open and
// unpaid (a credit note becomes a VendorCredit), so a workspace opts in before
// anything is created automatically. Business idempotency is two-layered:
// `requestid` replays a repeated create, and a create is preceded by a lookup
// of the same reference number from the same vendor, so a retry long after
// an ambiguous timeout still finds the record instead of adding another.

const QUICKBOOKS_MINOR_VERSION = "75";
/** QuickBooks caps a bill's reference number (DocNumber) at 21 characters. */
const DOC_NUMBER_MAX = 21;

const QUICKBOOKS_ENTITY = {
  bill: { name: "Bill", path: "/bill", label: "bill" },
  vendor_credit: {
    name: "VendorCredit",
    path: "/vendorcredit",
    label: "vendor credit",
  },
} as const;

/** QuickBooks takes a `requestid` of at most 50 characters. */
export const quickBooksRequestId = (key: string) =>
  key.length <= 50
    ? key
    : `iw-${createHash("sha256").update(key).digest("hex").slice(0, 40)}`;

const quote = (value: string) =>
  `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

const quickBooksEntityOf = (bill: DraftBill): ProviderEntity =>
  bill.documentType === "credit_note" ? "vendor_credit" : "bill";

async function quickBooksRealm(config: NangoConfig, connectionId: string) {
  const { connectionConfig } = await getNangoConnection(config, connectionId);
  const realmId = connectionConfig.realmId;
  if (typeof realmId !== "string" || !realmId) {
    throw new BillRejectedError(
      "The QuickBooks connection has no company; reconnect QuickBooks",
    );
  }
  return realmId;
}

type QuickBooksApi = ReturnType<typeof quickBooksApi>;

function quickBooksApi(
  config: NangoConfig,
  connectionId: string,
  realmId: string,
) {
  const company = `/v3/company/${encodeURIComponent(realmId)}`;
  const call = (
    method: "GET" | "POST",
    path: string,
    params: Record<string, string>,
    extra: Pick<Parameters<typeof nangoProxy>[2], "json" | "form"> = {},
  ) =>
    nangoProxy(config, connectionId, {
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
  return { realmId, call, query };
}

export type QuickBooksCompany = {
  realmId: string;
  name: string | null;
  country: string | null;
  homeCurrency: string | null;
  multiCurrency: boolean;
  /**
   * Whether bill lines carry a purchase tax code. QuickBooks' global
   * editions (UK, CA, AU, ...) tax purchases per line; US companies use
   * sales tax and put no tax code on a bill.
   */
  purchaseTax: boolean;
};

async function readQuickBooksCompany(
  api: QuickBooksApi,
): Promise<QuickBooksCompany> {
  const [info, preferences] = await Promise.all([
    api.call("GET", `/companyinfo/${encodeURIComponent(api.realmId)}`, {}),
    api.call("GET", "/preferences", {}),
  ]);
  const company = asRecord(info.CompanyInfo);
  const currency = asRecord(asRecord(preferences.Preferences).CurrencyPrefs);
  const text = (value: unknown) =>
    typeof value === "string" && value ? value : null;
  const country = text(company.Country);
  return {
    realmId: api.realmId,
    name: text(company.CompanyName),
    country,
    homeCurrency: text(asRecord(currency.HomeCurrency).value),
    multiCurrency: currency.MultiCurrencyEnabled === true,
    purchaseTax: country !== null && country !== "US",
  };
}

/** The connected company: ID, name and the settings that shape a bill. */
export async function getQuickBooksCompany(
  config: NangoConfig,
  connectionId: string,
) {
  const realmId = await quickBooksRealm(config, connectionId);
  return readQuickBooksCompany(quickBooksApi(config, connectionId, realmId));
}

export type TaxCode = { id: string; name: string; rate: number };

/** Active tax codes that apply to purchases, with their combined rate (%). */
async function purchaseTaxCodes(api: QuickBooksApi): Promise<TaxCode[]> {
  const [codes, rates] = await Promise.all([
    api.query("TaxCode", "select * from TaxCode maxresults 1000"),
    api.query("TaxRate", "select * from TaxRate maxresults 1000"),
  ]);
  const rateById = new Map(
    rates.map((rate) => [String(rate.Id), Number(rate.RateValue ?? 0)]),
  );
  return codes.flatMap((code) => {
    const details = asRecord(code.PurchaseTaxRateList).TaxRateDetail;
    if (code.Active === false || !Array.isArray(details) || !details.length) {
      return [];
    }
    const rate = details.reduce<number>(
      (sum, detail) =>
        sum +
        (rateById.get(String(asRecord(asRecord(detail).TaxRateRef).value)) ??
          0),
      0,
    );
    return [{ id: String(code.Id), name: String(code.Name ?? code.Id), rate }];
  });
}

/**
 * What an admin chooses from before QuickBooks posting can start: the
 * company's active expense accounts and, for a company that taxes purchases,
 * its purchase tax codes.
 */
export async function getQuickBooksSetupOptions(
  config: NangoConfig,
  connectionId: string,
) {
  const realmId = await quickBooksRealm(config, connectionId);
  const api = quickBooksApi(config, connectionId, realmId);
  const company = await readQuickBooksCompany(api);
  const [accounts, taxCodes] = await Promise.all([
    api.query(
      "Account",
      "select Id, Name, FullyQualifiedName, AccountType from Account where Active = true and AccountType in ('Expense', 'Other Expense', 'Cost of Goods Sold') maxresults 1000",
    ),
    company.purchaseTax ? purchaseTaxCodes(api) : Promise.resolve([]),
  ]);
  return {
    company,
    accounts: accounts.map((account) => ({
      id: String(account.Id),
      name: String(account.FullyQualifiedName ?? account.Name ?? account.Id),
      type: String(account.AccountType ?? ""),
    })),
    taxCodes,
  };
}

/**
 * The purchase tax code for a single-rate invoice: the code whose rate
 * reproduces the invoice's tax on its net lines (to a penny a line),
 * preferring the codes the workspace chose. Anything ambiguous or unmatched
 * is refused with the reason rather than guessed.
 */
function chooseTaxCode(
  provider: "Xero" | "QuickBooks",
  codes: TaxCode[],
  preferred: readonly string[],
  net: number,
  tax: number,
  lineCount: number,
) {
  const tolerance = 0.01 * Math.max(1, lineCount);
  const matching = codes.filter(
    (code) => Math.abs(round2((net * code.rate) / 100) - tax) <= tolerance,
  );
  const chosen = matching.filter((code) => preferred.includes(code.id));
  const pick =
    chosen.length === 1
      ? chosen[0]
      : chosen.length === 0 && matching.length === 1
        ? matching[0]
        : undefined;
  if (pick) return pick;
  const rate = net ? round2((tax / net) * 100) : 0;
  throw new BillRejectedError(
    matching.length
      ? `Several ${provider} purchase tax codes match the ${rate}% tax on this invoice (${matching.map((code) => code.name).join(", ")}); choose the one InvoiceWise should use in Settings → Accounting`
      : `No active ${provider} purchase tax code matches the ${rate}% tax on this invoice (${tax.toFixed(2)} on ${net.toFixed(2)}); an invoice with mixed tax rates is not mapped, so record it in ${provider} by hand`,
  );
}

/**
 * The supplier's QuickBooks vendor, found by display name or created. A
 * vendor created by a concurrent post is found again; a name QuickBooks
 * reserves for a customer or employee is refused with the fix.
 */
async function resolveVendor(
  api: QuickBooksApi,
  company: QuickBooksCompany,
  bill: DraftBill,
  name: string,
): Promise<string> {
  const find = () =>
    api
      .query(
        "Vendor",
        `select Id, Active, CurrencyRef from Vendor where DisplayName = ${quote(name)} and Active in (true, false)`,
      )
      .then(([vendor]) => vendor);
  let vendor = await find();
  if (!vendor) {
    try {
      vendor = asRecord(
        (
          await api.call(
            "POST",
            "/vendor",
            {
              requestid: quickBooksRequestId(
                `invoicewise-vendor:${createHash("sha256").update(name).digest("hex").slice(0, 32)}`,
              ),
            },
            {
              json: {
                DisplayName: name,
                CompanyName: name,
                ...(company.multiCurrency && bill.currency
                  ? { CurrencyRef: { value: bill.currency } }
                  : {}),
              },
            },
          )
        ).Vendor,
      );
    } catch (error) {
      if (!(error instanceof NangoRequestError && error.code === "6240")) {
        throw error;
      }
      vendor = await find();
      if (!vendor) {
        throw new BillRejectedError(
          `QuickBooks already uses the name "${name}" for a customer or employee, so no vendor can have it; create the vendor in QuickBooks under another name and retry`,
        );
      }
    }
  }
  if (typeof vendor.Id !== "string") {
    throw new Error("QuickBooks did not return the vendor ID");
  }
  if (vendor.Active === false) {
    throw new BillRejectedError(
      `The QuickBooks vendor "${name}" is inactive; make it active in QuickBooks and retry`,
    );
  }
  const vendorCurrency = asRecord(vendor.CurrencyRef).value;
  if (
    company.multiCurrency &&
    bill.currency &&
    typeof vendorCurrency === "string" &&
    vendorCurrency !== bill.currency
  ) {
    throw new BillRejectedError(
      `The QuickBooks vendor "${name}" is set up in ${vendorCurrency} but the invoice is in ${bill.currency}; QuickBooks allows one currency per vendor, so record it by hand`,
    );
  }
  return vendor.Id;
}

/**
 * Everything a QuickBooks bill or vendor credit is written against: the
 * company, the vendor, the configured expense account and the lines with
 * their tax treatment. Every refusal names what to change.
 */
async function quickBooksContext(
  config: NangoConfig,
  connection: Connection,
  bill: DraftBill,
) {
  const expenseAccountId = connection.settings?.expenseAccountId;
  if (!expenseAccountId) {
    throw new BillRejectedError(
      "Choose the QuickBooks expense account for bills in Settings → Accounting",
    );
  }
  const supplierName = bill.supplierName?.trim().slice(0, 500);
  if (!supplierName) {
    throw new BillRejectedError("QuickBooks needs the supplier name");
  }
  const realmId = await quickBooksRealm(config, connection.connectionId);
  const api = quickBooksApi(config, connection.connectionId, realmId);
  const company = await readQuickBooksCompany(api);
  if (
    bill.currency &&
    company.homeCurrency &&
    bill.currency !== company.homeCurrency &&
    !company.multiCurrency
  ) {
    throw new BillRejectedError(
      `The invoice is in ${bill.currency} but the QuickBooks company works only in ${company.homeCurrency}; turn on multicurrency in QuickBooks, or record it by hand`,
    );
  }

  const lines = billLines(bill);
  const net = round2(lines.reduce((sum, line) => sum + line.total, 0));
  const tax = round2(bill.vatAmount ?? 0);
  let taxCodeId: string | null = null;
  if (company.purchaseTax) {
    if (tax !== 0 && bill.netAmount === null) {
      throw new BillRejectedError(
        "QuickBooks needs the invoice's net amount to apply its tax",
      );
    }
    taxCodeId = chooseTaxCode(
      "QuickBooks",
      await purchaseTaxCodes(api),
      connection.settings?.taxCodeIds ?? [],
      net,
      tax,
      lines.length,
    ).id;
  }
  const vendorId = await resolveVendor(api, company, bill, supplierName);
  const line = (description: string, amount: number) => ({
    DetailType: "AccountBasedExpenseLineDetail",
    Amount: amount,
    Description: description,
    AccountBasedExpenseLineDetail: {
      AccountRef: { value: expenseAccountId },
      ...(taxCodeId ? { TaxCodeRef: { value: taxCodeId } } : {}),
    },
  });
  const Line = lines.map((entry) => line(entry.description, entry.total));
  // A US company's bill has no tax code, so the invoice's tax is its own
  // line when the posted lines are net of it: the bill's total is the
  // invoice's total either way, or the bill is refused.
  if (!company.purchaseTax && tax > 0) {
    const gross = bill.grossAmount;
    const linesAreGross = gross !== null && Math.abs(net - gross) <= 0.01;
    const linesAreNet =
      gross === null
        ? bill.netAmount !== null
        : Math.abs(net + tax - gross) <= 0.01;
    if (!linesAreGross && !linesAreNet) {
      throw new BillRejectedError(
        "QuickBooks needs the invoice's net amount to add its tax: its lines do not add up to the invoice total with or without the tax",
      );
    }
    if (!linesAreGross) {
      Line.push(
        line(
          bill.invoiceNumber ? `Tax on invoice ${bill.invoiceNumber}` : "Tax",
          tax,
        ),
      );
    }
  }
  const docNumber = bill.invoiceNumber
    ? bill.invoiceNumber.slice(0, DOC_NUMBER_MAX)
    : undefined;
  const fields = {
    VendorRef: { value: vendorId },
    DocNumber: docNumber,
    TxnDate: bill.invoiceDate ?? undefined,
    ...(company.multiCurrency && bill.currency
      ? { CurrencyRef: { value: bill.currency } }
      : {}),
    ...(company.purchaseTax ? { GlobalTaxCalculation: "TaxExcluded" } : {}),
    Line,
  };
  return { api, company, vendorId, docNumber, fields };
}

/** Provider refusals as reasons a user can act on; see `isRetryable`. */
function quickBooksFailure(error: unknown, entity: ProviderEntity): unknown {
  if (!(error instanceof NangoRequestError)) return error;
  const label = QUICKBOOKS_ENTITY[entity].label;
  if (error.code === "5010") {
    // Someone changed the record meanwhile: read it again and retry.
    return new Error(`QuickBooks changed the ${label} meanwhile; retrying`);
  }
  if (error.status === 400) {
    return new BillRejectedError(
      `QuickBooks refused the ${label}: ${error.message}`,
    );
  }
  return error;
}

/**
 * The record this post already created, found by reference number and
 * vendor with InvoiceWise's key in its note. A same-numbered record from the
 * same vendor that InvoiceWise did not create is someone else's entry of
 * this invoice: refused rather than duplicated.
 */
async function findQuickBooksRecord(
  context: Awaited<ReturnType<typeof quickBooksContext>>,
  entity: ProviderEntity,
  bill: DraftBill,
) {
  if (!context.docNumber) return null;
  const { name, label } = QUICKBOOKS_ENTITY[entity];
  const sameVendor = (
    await context.api.query(
      name,
      `select Id, VendorRef, PrivateNote from ${name} where DocNumber = ${quote(context.docNumber)}`,
    )
  ).filter((row) => asRecord(row.VendorRef).value === context.vendorId);
  const ours = sameVendor.find(
    (row) =>
      typeof row.PrivateNote === "string" &&
      row.PrivateNote.includes(bill.idempotencyKey),
  );
  if (ours) return String(ours.Id);
  if (sameVendor.length) {
    throw new BillRejectedError(
      `QuickBooks already has ${label} ${context.docNumber} from ${bill.supplierName} (ID ${String(sameVendor[0]!.Id)}) that InvoiceWise did not create; check whether it is this invoice, then delete or renumber one of them in QuickBooks and retry`,
    );
  }
  return null;
}

async function postQuickBooksDocument(
  config: NangoConfig,
  connection: Connection,
  bill: DraftBill,
  attachment: BillAttachment | null,
): Promise<PostedBill> {
  const entity = quickBooksEntityOf(bill);
  const { path, name } = QUICKBOOKS_ENTITY[entity];
  const context = await quickBooksContext(config, connection, bill);
  let providerId = await findQuickBooksRecord(context, entity, bill);
  if (!providerId) {
    const note =
      bill.invoiceNumber && bill.invoiceNumber !== context.docNumber
        ? `InvoiceWise ${bill.idempotencyKey} · reference ${bill.invoiceNumber}`
        : `InvoiceWise ${bill.idempotencyKey}`;
    const created = await context.api
      .call(
        "POST",
        path,
        { requestid: quickBooksRequestId(bill.idempotencyKey) },
        {
          json: {
            ...context.fields,
            ...(entity === "bill" && bill.dueDate
              ? { DueDate: bill.dueDate }
              : {}),
            PrivateNote: note,
          },
        },
      )
      .catch((error) => {
        throw quickBooksFailure(error, entity);
      });
    const record = asRecord(created[name]);
    if (typeof record.Id !== "string") {
      throw new Error(`QuickBooks did not return the ${name} ID`);
    }
    providerId = record.Id;
  }
  const id = providerId;
  return withAttachment({ providerId: id, entity }, attachment, () =>
    attachQuickBooksDocument(context.api, entity, id, attachment!),
  );
}

/**
 * Attaches the source document unless a document is already attached, so a
 * retried upload (including one whose response was lost) never adds a copy.
 */
async function attachQuickBooksDocument(
  api: QuickBooksApi,
  entity: ProviderEntity,
  providerId: string,
  attachment: BillAttachment,
) {
  const { name } = QUICKBOOKS_ENTITY[entity];
  const existing = await api.query(
    "Attachable",
    `select Id from Attachable where AttachableRef.EntityRef.Type = '${name}' and AttachableRef.EntityRef.value = ${quote(providerId)}`,
  );
  if (existing.length) return;
  const form = new FormData();
  form.append(
    "file_metadata_01",
    new Blob(
      [
        JSON.stringify({
          AttachableRef: [{ EntityRef: { type: name, value: providerId } }],
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
  const uploaded = await api.call("POST", "/upload", {}, { form });
  // An upload reports its own failure inside a 200 response.
  const [result] = Array.isArray(uploaded.AttachableResponse)
    ? uploaded.AttachableResponse.map(asRecord)
    : [];
  const fault = asRecord(result?.Fault);
  if (!result?.Attachable) {
    const [detail] = Array.isArray(fault.Error)
      ? fault.Error.map(asRecord)
      : [];
    throw new BillRejectedError(
      `QuickBooks refused the attachment: ${String(detail?.Detail ?? detail?.Message ?? "no attachment was created")}`,
    );
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
    ? postXeroDocument(config, connection, bill, attachment)
    : postQuickBooksDocument(config, connection, bill, attachment);

/**
 * Uploads the source document to a record InvoiceWise already created, on
 * its own: the retry for a post whose record exists but whose attachment
 * failed. Repeating it never duplicates the document.
 */
export async function attachProviderDocument(
  provider: AccountingProvider,
  config: NangoConfig,
  connection: Connection,
  record: { providerId: string; entity: ProviderEntity },
  attachment: BillAttachment,
) {
  if (provider === "xero") {
    await attachXeroDocument(
      xeroApi(
        config,
        connection.connectionId,
        await xeroTenantId(config, connection),
      ),
      record.entity,
      record.providerId,
      attachment,
    );
    return;
  }
  const realmId = await quickBooksRealm(config, connection.connectionId);
  await attachQuickBooksDocument(
    quickBooksApi(config, connection.connectionId, realmId),
    record.entity,
    record.providerId,
    attachment,
  );
}

/**
 * The organisation a connection reaches, read live through the proxy: the
 * health check and the connect-time record of which company was bound. A
 * Xero authorisation can reach several organisations: `preferred` (the one
 * the workspace chose) is kept while it is still reachable.
 */
export async function readProviderOrganisation(
  provider: AccountingProvider,
  config: NangoConfig,
  connectionId: string,
  preferred: string | null = null,
): Promise<{ id: string; name: string | null }> {
  if (provider === "quickbooks") {
    const company = await getQuickBooksCompany(config, connectionId);
    return { id: company.realmId, name: company.name };
  }
  const { id, name } = await readXeroConnectionOrganisation(
    config,
    connectionId,
    preferred,
  );
  return { id, name };
}

/**
 * Updates a record InvoiceWise already created, in place: the same provider
 * ID, never a second record. `bill.idempotencyKey` is per correction, so a
 * retry after an ambiguous timeout replays the same update.
 */
export async function updateProviderBill(
  provider: AccountingProvider,
  config: NangoConfig,
  connection: Connection,
  providerId: string,
  bill: DraftBill,
  entity: ProviderEntity = "bill",
): Promise<{ providerId: string }> {
  if (provider === "xero") {
    if (xeroEntityOf(bill) !== entity) {
      throw new BillRejectedError(
        `The correction changes the document type, but Xero cannot turn a ${XERO_ENTITY[entity].label} into a ${XERO_ENTITY[xeroEntityOf(bill)].label}; change it in Xero yourself`,
      );
    }
    const { collection, idField, label } = XERO_ENTITY[entity];
    const context = await xeroContext(config, connection, bill);
    // The status is left as it is: an approved bill stays approved, and one
    // Xero no longer lets anyone edit (paid, voided) is refused.
    const body = await context.api
      .call("POST", `/${collection}/${encodeURIComponent(providerId)}`, {
        idempotencyKey: bill.idempotencyKey,
        json: { [collection]: [{ [idField]: providerId, ...context.fields }] },
      })
      .catch((error) => {
        throw xeroFailure(error, entity);
      });
    const record = asRecord(
      Array.isArray(body[collection]) ? body[collection][0] : undefined,
    );
    if (record[idField] !== providerId) {
      throw new Error(`Xero did not confirm the ${label} update`);
    }
    return { providerId };
  }

  if (quickBooksEntityOf(bill) !== entity) {
    throw new BillRejectedError(
      `The correction changes the document type, but QuickBooks cannot turn a ${QUICKBOOKS_ENTITY[entity].label} into a ${QUICKBOOKS_ENTITY[quickBooksEntityOf(bill)].label}; change it in QuickBooks yourself`,
    );
  }
  const { path, name, label } = QUICKBOOKS_ENTITY[entity];
  const context = await quickBooksContext(config, connection, bill);
  // QuickBooks updates need the record's current SyncToken; a record someone
  // changed in QuickBooks meanwhile is read again on the next attempt.
  const current = asRecord(
    (
      await context.api
        .call("GET", `${path}/${encodeURIComponent(providerId)}`, {})
        .catch((error) => {
          throw error instanceof NangoRequestError && error.status === 400
            ? new BillRejectedError(`QuickBooks no longer has this ${label}`)
            : error;
        })
    )[name],
  );
  if (typeof current.SyncToken !== "string") {
    throw new BillRejectedError(`QuickBooks no longer has this ${label}`);
  }
  const updated = asRecord(
    (
      await context.api
        .call(
          "POST",
          path,
          { requestid: quickBooksRequestId(bill.idempotencyKey) },
          {
            json: {
              Id: providerId,
              SyncToken: current.SyncToken,
              sparse: true,
              ...context.fields,
              ...(entity === "bill" && bill.dueDate
                ? { DueDate: bill.dueDate }
                : {}),
            },
          },
        )
        .catch((error) => {
          throw quickBooksFailure(error, entity);
        })
    )[name],
  );
  if (updated.Id !== providerId) {
    throw new Error(`QuickBooks did not confirm the ${label} update`);
  }
  return { providerId };
}
