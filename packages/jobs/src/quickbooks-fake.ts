/**
 * A stateful stand-in for one QuickBooks Online company behind the Nango
 * proxy, for unit tests and `verify-quickbooks.ts` only. It keeps vendors,
 * bills, vendor credits and attachables, replays a repeated `requestid` the
 * way QuickBooks does, and can inject the failures the adapters must survive:
 * an ambiguous timeout after the record was created, a throttle, a token
 * refresh failure, a refused upload. Never used outside verification.
 */

type Row = Record<string, unknown>;

export type QuickBooksFakeFailure = {
  /** Which call fails: the first path segment after the company. */
  on: "bill" | "vendorcredit" | "vendor" | "upload" | "query" | "companyinfo";
  status: number;
  body?: unknown;
  /** Apply the call first, then fail: the response is lost, not the write. */
  afterApply?: boolean;
};

export type QuickBooksFakeCompany = {
  name: string;
  country: string;
  homeCurrency: string;
  multiCurrency: boolean;
};

const GB_TAX = {
  codes: [
    { Id: "4", Name: "20.0% S", rate: "1" },
    { Id: "6", Name: "0.0% Z", rate: "2" },
    { Id: "7", Name: "Exempt", rate: "2" },
    { Id: "8", Name: "5.0% R", rate: "3" },
  ],
  rates: [
    { Id: "1", Name: "20.0% S (Purchases)", RateValue: 20 },
    { Id: "2", Name: "0.0% (Purchases)", RateValue: 0 },
    { Id: "3", Name: "5.0% R (Purchases)", RateValue: 5 },
  ],
};

const unquote = (value: string) => value.replace(/\\(.)/g, "$1");
const fault = (status: number, code: string, message: string) =>
  Response.json(
    { Fault: { Error: [{ Message: message, Detail: message, code }] } },
    { status },
  );

export function createQuickBooksFake(
  realmId: string,
  company: QuickBooksFakeCompany,
) {
  const state = {
    company,
    accounts: [
      { Id: "7", Name: "Purchases", AccountType: "Expense" },
      { Id: "9", Name: "Subcontractors", AccountType: "Cost of Goods Sold" },
    ] as Row[],
    vendors: [] as Row[],
    /** Names QuickBooks reserves for customers or employees. */
    reservedNames: new Set<string>(),
    records: new Map<string, Row & { entity: string }>(),
    requestIds: new Map<string, string>(),
    attachables: new Map<string, number>(),
    failures: [] as QuickBooksFakeFailure[],
    /** Every write QuickBooks applied, by path segment. */
    writes: { bill: 0, vendorcredit: 0, vendor: 0, upload: 0 } as Record<
      string,
      number
    >,
  };
  const prefix = `/v3/company/${realmId}`;
  let nextId = 100;

  const records = (entity: string) =>
    [...state.records.values()].filter((record) => record.entity === entity);

  const query = (statement: string) => {
    const from = statement.match(/ from (\w+)/i)?.[1];
    const equals = (field: string) => {
      const match = statement.match(
        new RegExp(`${field.replace(/\./g, "\\.")} = '((?:[^'\\\\]|\\\\.)*)'`),
      );
      return match ? unquote(match[1]!) : undefined;
    };
    switch (from) {
      case "Vendor": {
        const name = equals("DisplayName");
        const includeInactive = /Active in \(true, false\)/.test(statement);
        return {
          Vendor: state.vendors.filter(
            (vendor) =>
              vendor.DisplayName === name &&
              (includeInactive || vendor.Active !== false),
          ),
        };
      }
      case "Account":
        return { Account: state.accounts };
      case "TaxCode":
        return state.company.country === "US"
          ? {
              TaxCode: [
                { Id: "TAX", Name: "TAX" },
                { Id: "NON", Name: "NON" },
              ],
            }
          : {
              TaxCode: GB_TAX.codes.map((code) => ({
                Id: code.Id,
                Name: code.Name,
                Active: true,
                PurchaseTaxRateList: {
                  TaxRateDetail: [{ TaxRateRef: { value: code.rate } }],
                },
              })),
            };
      case "TaxRate":
        return state.company.country === "US" ? {} : { TaxRate: GB_TAX.rates };
      case "Bill":
      case "VendorCredit": {
        const docNumber = equals("DocNumber");
        return {
          [from]: records(from).filter(
            (record) => record.DocNumber === docNumber,
          ),
        };
      }
      case "Attachable": {
        const type = equals("AttachableRef.EntityRef.Type");
        const id = equals("AttachableRef.EntityRef.value");
        const count = state.attachables.get(`${type}:${id}`) ?? 0;
        return count
          ? {
              Attachable: Array.from({ length: count }, (_, index) => ({
                Id: `att-${index}`,
              })),
            }
          : {};
      }
      default:
        return {};
    }
  };

  const write = async (
    segment: string,
    url: URL,
    body: Row,
  ): Promise<Response> => {
    const entity = segment === "bill" ? "Bill" : "VendorCredit";
    if (body.Id !== undefined) {
      const current = state.records.get(String(body.Id));
      if (!current || current.entity !== entity) {
        return fault(400, "610", "Object Not Found");
      }
      if (current.SyncToken !== body.SyncToken) {
        return fault(400, "5010", "Stale Object Error");
      }
      const updated = {
        ...current,
        ...body,
        entity,
        SyncToken: String(Number(current.SyncToken) + 1),
      };
      state.records.set(String(body.Id), updated);
      state.writes[segment] = (state.writes[segment] ?? 0) + 1;
      return Response.json({ [entity]: updated });
    }
    const requestId = url.searchParams.get("requestid");
    const replayed = requestId
      ? state.requestIds.get(`${segment}:${requestId}`)
      : undefined;
    if (replayed) {
      return Response.json({ [entity]: state.records.get(replayed) });
    }
    const vendor = state.vendors.find(
      (candidate) => candidate.Id === (body.VendorRef as Row)?.value,
    );
    if (!vendor) return fault(400, "2500", "Invalid Reference Id: vendor");
    const id = String(nextId++);
    const record = { ...body, Id: id, SyncToken: "0", entity };
    state.records.set(id, record);
    if (requestId) state.requestIds.set(`${segment}:${requestId}`, id);
    state.writes[segment] = (state.writes[segment] ?? 0) + 1;
    return Response.json({ [entity]: record });
  };

  const apply = async (
    request: Request,
    path: string,
    url: URL,
    body: { json?: Row; form?: FormData },
  ): Promise<Response> => {
    const segment = path.slice(prefix.length + 1).split("/")[0]!;
    if (segment === "companyinfo") {
      return Response.json({
        CompanyInfo: {
          Id: "1",
          CompanyName: state.company.name,
          Country: state.company.country,
        },
      });
    }
    if (segment === "preferences") {
      return Response.json({
        Preferences: {
          CurrencyPrefs: {
            MultiCurrencyEnabled: state.company.multiCurrency,
            HomeCurrency: { value: state.company.homeCurrency },
          },
        },
      });
    }
    if (segment === "query") {
      return Response.json({
        QueryResponse: query(url.searchParams.get("query") ?? ""),
      });
    }
    if (segment === "vendor" && request.method === "POST") {
      const name = String(body.json?.DisplayName);
      if (
        state.reservedNames.has(name) ||
        state.vendors.some((vendor) => vendor.DisplayName === name)
      ) {
        return fault(400, "6240", "Duplicate Name Exists Error");
      }
      const vendor = {
        Id: `v${state.vendors.length + 1}`,
        DisplayName: name,
        Active: true,
        CurrencyRef: body.json?.CurrencyRef ?? {
          value: state.company.homeCurrency,
        },
      };
      state.vendors.push(vendor);
      state.writes.vendor = (state.writes.vendor ?? 0) + 1;
      return Response.json({ Vendor: vendor });
    }
    if (segment === "bill" || segment === "vendorcredit") {
      const id = path.split("/")[5];
      if (request.method === "GET" && id) {
        const record = state.records.get(decodeURIComponent(id));
        const entity = segment === "bill" ? "Bill" : "VendorCredit";
        return record?.entity === entity
          ? Response.json({ [entity]: record })
          : fault(400, "610", "Object Not Found");
      }
      return write(segment, url, body.json ?? {});
    }
    if (segment === "upload") {
      const metadata = JSON.parse(
        await (body.form?.get("file_metadata_01") as File).text(),
      ) as { AttachableRef: { EntityRef: { type: string; value: string } }[] };
      const ref = metadata.AttachableRef[0]!.EntityRef;
      const key = `${ref.type}:${ref.value}`;
      state.attachables.set(key, (state.attachables.get(key) ?? 0) + 1);
      state.writes.upload = (state.writes.upload ?? 0) + 1;
      return Response.json({
        AttachableResponse: [{ Attachable: { Id: `att-${key}` } }],
      });
    }
    return fault(400, "4000", `No route ${path}`);
  };

  return {
    state,
    prefix,
    /** Records created of one kind ("Bill" or "VendorCredit"). */
    records,
    /** Forget replayable request IDs, as QuickBooks does after a while. */
    expireRequestIds: () => state.requestIds.clear(),
    fail: (failure: QuickBooksFakeFailure) => state.failures.push(failure),
    /** Answers one proxied request for this company, or null for another. */
    async handle(
      request: Request,
      path: string,
      url: URL,
      body: { json?: Row; form?: FormData },
    ): Promise<Response | null> {
      if (!path.startsWith(`${prefix}/`)) return null;
      const segment = path.slice(prefix.length + 1).split("/")[0]!;
      const index = state.failures.findIndex(
        (failure) => failure.on === segment,
      );
      if (index >= 0) {
        const [failure] = state.failures.splice(index, 1);
        if (failure!.afterApply) await apply(request, path, url, body);
        return Response.json(
          failure!.body ?? { error: { message: "Injected failure" } },
          { status: failure!.status },
        );
      }
      return apply(request, path, url, body);
    },
  };
}
