/**
 * A stateful stand-in for one Xero authorisation behind the Nango proxy, for
 * unit tests and the verification scripts only. It reaches one or more
 * organisations (tenants), each with its own accounts, tax rates, currencies,
 * contacts, draft bills and credit notes, attachments and history; replays a
 * repeated `Idempotency-Key` the way Xero does; and can inject the failures
 * the adapters must survive: an ambiguous timeout after the record was
 * created, a throttle, a token refresh failure, a refused upload. Never used
 * outside verification.
 */

type Row = Record<string, unknown>;

export type XeroFakeFailure = {
  /**
   * Which call fails: an API collection ("Invoices", "CreditNotes",
   * "Contacts", "Organisation", ...), "Attachments" or "History" for a
   * record's sub-resource, or "connections" for the tenant list.
   */
  on: string;
  /** Only this method fails (default: any). */
  method?: "GET" | "POST" | "PUT";
  status: number;
  body?: unknown;
  /** Apply the call first, then fail: the response is lost, not the write. */
  afterApply?: boolean;
};

export type XeroFakeOrganisation = {
  id: string;
  name: string;
  countryCode?: string;
  baseCurrency?: string;
  /** Currencies besides the base currency the organisation uses. */
  currencies?: string[];
};

const GB_TAX_RATES: Row[] = [
  { TaxType: "INPUT2", Name: "20% (VAT on Expenses)", EffectiveRate: 20 },
  { TaxType: "RRINPUT", Name: "5% (VAT on Expenses)", EffectiveRate: 5 },
  { TaxType: "ZERORATEDINPUT", Name: "Zero Rated Expenses", EffectiveRate: 0 },
  { TaxType: "EXEMPTEXPENSES", Name: "Exempt Expenses", EffectiveRate: 0 },
  { TaxType: "NONE", Name: "No VAT", EffectiveRate: 0 },
].map((rate) => ({ ...rate, Status: "ACTIVE", CanApplyToExpenses: true }));

const GB_SALES_RATES: Row[] = [
  {
    TaxType: "OUTPUT2",
    Name: "20% (VAT on Income)",
    EffectiveRate: 20,
    Status: "ACTIVE",
    CanApplyToExpenses: false,
  },
];

const ACCOUNTS: Row[] = [
  {
    Code: "429",
    Name: "General Expenses",
    Class: "EXPENSE",
    Type: "OVERHEADS",
    Status: "ACTIVE",
  },
  {
    Code: "310",
    Name: "Cost of Goods Sold",
    Class: "EXPENSE",
    Type: "DIRECTCOSTS",
    Status: "ACTIVE",
  },
  {
    Code: "499",
    Name: "Old Expenses",
    Class: "EXPENSE",
    Type: "EXPENSE",
    Status: "ARCHIVED",
  },
  {
    Code: "200",
    Name: "Sales",
    Class: "REVENUE",
    Type: "REVENUE",
    Status: "ACTIVE",
  },
];

const ENTITIES = {
  Invoices: { idField: "InvoiceID", numberField: "InvoiceNumber" },
  CreditNotes: { idField: "CreditNoteID", numberField: "CreditNoteNumber" },
} as const;
type Collection = keyof typeof ENTITIES;

const validation = (message: string) =>
  Response.json(
    {
      ErrorNumber: 10,
      Type: "ValidationException",
      Message: "A validation exception occurred",
      Elements: [{ ValidationErrors: [{ Message: message }] }],
    },
    { status: 400 },
  );

export function createXeroFake(organisations: XeroFakeOrganisation[]) {
  let nextId = 1;
  const id = (prefix: string) =>
    `${prefix}-0000-4000-8000-${String(nextId++).padStart(12, "0")}`;
  const tenants = new Map(
    organisations.map((organisation) => [
      organisation.id,
      {
        organisation: {
          countryCode: "GB",
          baseCurrency: "GBP",
          currencies: [] as string[],
          ...organisation,
        },
        contacts: [] as Row[],
        records: { Invoices: [] as Row[], CreditNotes: [] as Row[] },
        attachments: new Map<string, string[]>(),
        history: new Map<string, string[]>(),
        /** Idempotency-Key → the response Xero replays for it. */
        replays: new Map<string, Row>(),
      },
    ]),
  );
  const state = {
    /** Tenants the authorisation reaches, in Xero's order. */
    reachable: organisations.map((organisation) => organisation.id),
    failures: [] as XeroFakeFailure[],
    /** Every write Xero applied, by resource. */
    writes: {} as Record<string, number>,
  };
  const count = (resource: string) => {
    state.writes[resource] = (state.writes[resource] ?? 0) + 1;
  };

  type Tenant = NonNullable<ReturnType<typeof tenants.get>>;

  const filterWhere = (rows: Row[], where: string) =>
    rows.filter((row) =>
      where
        .split(/\s+AND\s+/)
        .filter(Boolean)
        .every((clause) => {
          const guid = clause.match(/^([\w.]+)=guid\("([^"]*)"\)$/);
          if (guid) {
            const [field, sub] = guid[1]!.split(".");
            return (
              (sub ? (row[field!] as Row | undefined)?.[sub] : row[field!]) ===
              guid[2]
            );
          }
          const text = clause.match(/^([\w.]+)=="([^"]*)"$/);
          if (text) return row[text[1]!] === text[2];
          throw new Error(`The Xero fake cannot filter ${clause}`);
        }),
    );

  const validateRecord = (tenant: Tenant, record: Row) => {
    const contact = tenant.contacts.find(
      (candidate) =>
        candidate.ContactID === (record.Contact as Row | undefined)?.ContactID,
    );
    if (!contact) return "The contact could not be found";
    if (contact.ContactStatus === "ARCHIVED") {
      return "The contact is archived";
    }
    const currency = record.CurrencyCode;
    if (
      currency !== undefined &&
      currency !== tenant.organisation.baseCurrency &&
      !tenant.organisation.currencies.includes(String(currency))
    ) {
      return `The currency ${String(currency)} is not set up`;
    }
    const lines = (record.LineItems as Row[] | undefined) ?? [];
    for (const line of lines) {
      const account = ACCOUNTS.find(
        (candidate) => candidate.Code === line.AccountCode,
      );
      if (line.AccountCode !== undefined && account?.Status !== "ACTIVE") {
        return `Account code '${String(line.AccountCode)}' is not a valid code for this document.`;
      }
      if (
        line.TaxType !== undefined &&
        !GB_TAX_RATES.some((rate) => rate.TaxType === line.TaxType)
      ) {
        return `The TaxType code '${String(line.TaxType)}' does not exist or cannot be used for this type of transaction.`;
      }
    }
    return null;
  };

  const writeRecord = (
    tenant: Tenant,
    collection: Collection,
    key: string | null,
    body: Row,
    recordId: string | null,
  ): Response => {
    const replayKey = key ? `${collection}:${key}` : null;
    const replayed = replayKey ? tenant.replays.get(replayKey) : undefined;
    if (replayed) return Response.json(replayed);
    const { idField } = ENTITIES[collection];
    const [sent] = (body[collection] as Row[] | undefined) ?? [];
    if (!sent) return validation("No records were sent");
    const rows = tenant.records[collection];
    let record: Row;
    if (recordId) {
      const index = rows.findIndex((row) => row[idField] === recordId);
      if (index < 0 || sent[idField] !== recordId) {
        return Response.json(
          { Title: "Not Found", Detail: "The resource was not found" },
          { status: 404 },
        );
      }
      record = { ...rows[index], ...sent };
      const problem = validateRecord(tenant, record);
      if (problem) return validation(problem);
      rows[index] = record;
    } else {
      record = {
        ...sent,
        [idField]: id(collection === "Invoices" ? "b111" : "c222"),
        Status: sent.Status ?? "DRAFT",
      };
      const problem = validateRecord(tenant, record);
      if (problem) return validation(problem);
      rows.push(record);
    }
    count(collection);
    const response = { [collection]: [record] };
    if (replayKey) tenant.replays.set(replayKey, response);
    return Response.json(response);
  };

  const apply = async (
    request: Request,
    tenant: Tenant,
    parts: string[],
    url: URL,
    json: Row | undefined,
    bytes: number | undefined,
  ): Promise<Response> => {
    const [resource, recordId, sub, fileName] = parts;
    const key = request.headers.get("nango-proxy-idempotency-key");
    switch (resource) {
      case "Organisation":
        return Response.json({
          Organisations: [
            {
              Name: tenant.organisation.name,
              CountryCode: tenant.organisation.countryCode,
              BaseCurrency: tenant.organisation.baseCurrency,
              IsDemoCompany: true,
            },
          ],
        });
      case "Currencies":
        return Response.json({
          Currencies: [
            tenant.organisation.baseCurrency,
            ...tenant.organisation.currencies,
          ].map((code) => ({ Code: code })),
        });
      case "TaxRates":
        return Response.json({
          TaxRates: [...GB_TAX_RATES, ...GB_SALES_RATES],
        });
      case "Accounts":
        return Response.json({ Accounts: ACCOUNTS });
      case "Contacts": {
        if (request.method === "GET") {
          const term = (url.searchParams.get("searchTerm") ?? "").toLowerCase();
          const archived = url.searchParams.get("includeArchived") === "true";
          return Response.json({
            Contacts: tenant.contacts.filter(
              (contact) =>
                String(contact.Name).toLowerCase().includes(term) &&
                (archived || contact.ContactStatus !== "ARCHIVED"),
            ),
          });
        }
        const replayed = key ? tenant.replays.get(`Contacts:${key}`) : null;
        if (replayed) return Response.json(replayed);
        const [sent] = (json?.Contacts as Row[] | undefined) ?? [];
        const name = String(sent?.Name ?? "");
        if (
          tenant.contacts.some(
            (contact) =>
              String(contact.Name).toLowerCase() === name.toLowerCase(),
          )
        ) {
          return validation(
            `The contact name ${name} is already assigned to another contact. The contact name must be unique across all active contacts.`,
          );
        }
        const contact = {
          ContactID: id("a000"),
          Name: name,
          ContactStatus: "ACTIVE",
        };
        tenant.contacts.push(contact);
        count("Contacts");
        const response = { Contacts: [contact] };
        if (key) tenant.replays.set(`Contacts:${key}`, response);
        return Response.json(response);
      }
      case "Invoices":
      case "CreditNotes": {
        const collection = resource as Collection;
        const { idField } = ENTITIES[collection];
        if (!recordId) {
          if (request.method === "GET") {
            return Response.json({
              [collection]: filterWhere(
                tenant.records[collection],
                url.searchParams.get("where") ?? "",
              ),
            });
          }
          return writeRecord(tenant, collection, key, json ?? {}, null);
        }
        const exists = tenant.records[collection].some(
          (row) => row[idField] === recordId,
        );
        if (!sub) {
          return writeRecord(tenant, collection, key, json ?? {}, recordId);
        }
        if (!exists) {
          return Response.json(
            { Title: "Not Found", Detail: "The resource was not found" },
            { status: 404 },
          );
        }
        if (sub === "Attachments") {
          const files = tenant.attachments.get(recordId) ?? [];
          if (request.method === "GET") {
            return Response.json({
              Attachments: files.map((name) => ({ FileName: name })),
            });
          }
          if (!bytes) return validation("The attachment is empty");
          const name = decodeURIComponent(fileName ?? "");
          tenant.attachments.set(recordId, [
            ...files.filter((file) => file !== name),
            name,
          ]);
          count("Attachments");
          return Response.json({ Attachments: [{ FileName: name }] });
        }
        if (sub === "History") {
          const notes = tenant.history.get(recordId) ?? [];
          if (request.method === "GET") {
            return Response.json({
              HistoryRecords: notes.map((details) => ({ Details: details })),
            });
          }
          const [record] = (json?.HistoryRecords as Row[] | undefined) ?? [];
          tenant.history.set(recordId, [...notes, String(record?.Details)]);
          count("History");
          return Response.json({ HistoryRecords: [record] });
        }
        break;
      }
    }
    return Response.json(
      { Title: "Not Found", Detail: `No route ${parts.join("/")}` },
      { status: 404 },
    );
  };

  const organisationOf = (tenantId: string) => tenants.get(tenantId)!;

  return {
    state,
    /** Records of one kind ("Invoices" or "CreditNotes") in an organisation. */
    records: (tenantId: string, collection: Collection) =>
      organisationOf(tenantId).records[collection],
    contacts: (tenantId: string) => organisationOf(tenantId).contacts,
    attachments: (tenantId: string, recordId: string) =>
      organisationOf(tenantId).attachments.get(recordId) ?? [],
    history: (tenantId: string, recordId: string) =>
      organisationOf(tenantId).history.get(recordId) ?? [],
    /** Forget replayable idempotency keys, as Xero does after a while. */
    expireIdempotencyKeys: () => {
      for (const tenant of tenants.values()) tenant.replays.clear();
    },
    fail: (failure: XeroFakeFailure) => state.failures.push(failure),
    /**
     * Answers one proxied request (`path` is the provider path, after
     * `/proxy`), or null when it is not a Xero path.
     */
    async handle(
      request: Request,
      path: string,
      url: URL,
      body: { json?: Row; bytes?: number },
    ): Promise<Response | null> {
      const connections = path === "/connections";
      if (!connections && !path.startsWith("/api.xro/2.0/")) return null;
      const parts = connections
        ? ["connections"]
        : path
            .slice("/api.xro/2.0/".length)
            .split("/")
            .map((part) => decodeURIComponent(part));
      const resource =
        parts[2] === "Attachments" || parts[2] === "History"
          ? parts[2]
          : parts[0]!;
      const index = state.failures.findIndex(
        (failure) =>
          failure.on === resource &&
          (!failure.method || failure.method === request.method),
      );
      const failure =
        index >= 0 ? state.failures.splice(index, 1)[0] : undefined;
      if (failure && !failure.afterApply) {
        return Response.json(
          failure.body ?? { error: { message: "Injected failure" } },
          { status: failure.status },
        );
      }
      let response: Response;
      if (connections) {
        response = Response.json(
          state.reachable.map((tenantId) => ({
            id: `connection-${tenantId}`,
            tenantId,
            tenantType: "ORGANISATION",
            tenantName: organisationOf(tenantId).organisation.name,
          })),
        );
      } else {
        const tenantId = request.headers.get("nango-proxy-xero-tenant-id");
        const tenant =
          tenantId && state.reachable.includes(tenantId)
            ? tenants.get(tenantId)
            : undefined;
        response = tenant
          ? await apply(request, tenant, parts, url, body.json, body.bytes)
          : Response.json(
              {
                Title: "Forbidden",
                Detail: "AuthenticationUnsuccessful",
                Status: 403,
              },
              { status: 403 },
            );
      }
      if (failure) {
        return Response.json(
          failure.body ?? { error: { message: "Injected failure" } },
          { status: failure.status },
        );
      }
      return response;
    },
  };
}
