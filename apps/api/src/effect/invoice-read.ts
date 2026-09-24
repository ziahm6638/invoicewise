import { type Database, createDatabaseClient } from "@invoicewise/db/client";
import {
  type GetInboxParams,
  getInbox,
  getInboxById,
  getInvoiceAccountingStatus,
  getInvoiceDeliveryStatus,
  getInvoiceExportRows,
  isValidDocumentBinding,
} from "@invoicewise/db/queries";
import { createStorageClientFromEnv } from "@invoicewise/db/storage";
import {
  Config,
  Context,
  Effect,
  Layer,
  Option,
  Redacted,
  Schema,
} from "effect";

const Transaction = Schema.Struct({
  id: Schema.String,
  amount: Schema.Number,
  currency: Schema.String,
  name: Schema.String,
  date: Schema.String,
});

export const InvoiceItem = Schema.Struct({
  id: Schema.String,
  fileName: Schema.String,
  filePath: Schema.Array(Schema.String),
  displayName: Schema.String,
  amount: Schema.NullOr(Schema.Number),
  currency: Schema.NullOr(Schema.String),
  contentType: Schema.NullOr(Schema.String),
  date: Schema.NullOr(Schema.String),
  status: Schema.String,
  createdAt: Schema.String,
  website: Schema.NullOr(Schema.String),
  description: Schema.NullOr(Schema.String),
  extraction: Schema.optional(Schema.NullOr(Schema.Unknown)),
  judgments: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
  transaction: Schema.NullOr(Transaction),
});

export type InvoiceItem = typeof InvoiceItem.Type;

export const InvoiceDetail = Schema.Struct({
  ...InvoiceItem.fields,
  lineItems: Schema.Array(Schema.Unknown),
  documentUrl: Schema.String,
});

export type InvoiceDetail = typeof InvoiceDetail.Type;

export const InvoicePage = Schema.Struct({
  meta: Schema.Struct({
    cursor: Schema.optional(Schema.String),
    hasPreviousPage: Schema.Boolean,
    hasNextPage: Schema.Boolean,
  }),
  data: Schema.Array(InvoiceItem),
});

export type InvoicePage = typeof InvoicePage.Type;

export const InvoiceListQuery = Schema.Struct({
  cursor: Schema.optional(Schema.String),
  order: Schema.optional(Schema.String),
  sort: Schema.optional(Schema.String),
  pageSize: Schema.optionalWith(
    Schema.NumberFromString.pipe(Schema.int(), Schema.between(1, 100)),
    { default: () => 20 },
  ),
  q: Schema.optional(Schema.String),
  dateFrom: Schema.optional(Schema.String),
  dateTo: Schema.optional(Schema.String),
  status: Schema.optional(Schema.Literal("done", "pending")),
});

export type InvoiceListQuery = typeof InvoiceListQuery.Type;

export const InvoicePath = Schema.Struct({ id: Schema.String });
export const InvoiceHeaders = Schema.Struct({
  "x-invoicewise-team-id": Schema.String,
});
export const AttachmentQuery = Schema.Struct({
  download: Schema.optionalWith(Schema.BooleanFromString, {
    default: () => true,
  }),
});
export const AttachmentUrl = Schema.Struct({
  url: Schema.String,
  expiresAt: Schema.String,
  fileName: Schema.NullOr(Schema.String),
});

export type AttachmentUrl = typeof AttachmentUrl.Type;

export const DeliveryStatusItem = Schema.Struct({
  id: Schema.String,
  endpointId: Schema.String,
  endpointUrl: Schema.String,
  event: Schema.String,
  status: Schema.String,
  attempts: Schema.Number,
  lastError: Schema.NullOr(Schema.String),
  deliveredAt: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
});
export const DeliveryStatus = Schema.Struct({
  data: Schema.Array(DeliveryStatusItem),
  accounting: Schema.NullOr(
    Schema.Struct({
      provider: Schema.String,
      status: Schema.String,
      providerId: Schema.NullOr(Schema.String),
      lastError: Schema.NullOr(Schema.String),
      postedAt: Schema.NullOr(Schema.String),
      idempotencyKey: Schema.NullOr(Schema.String),
    }),
  ),
});
export type DeliveryStatus = typeof DeliveryStatus.Type;

export class InvoiceNotFound extends Schema.TaggedError<InvoiceNotFound>()(
  "InvoiceNotFound",
  { error: Schema.String },
) {}

export class AttachmentUnavailable extends Schema.TaggedError<AttachmentUnavailable>()(
  "AttachmentUnavailable",
  { error: Schema.String },
) {}

export class InvoiceReadError extends Schema.TaggedError<InvoiceReadError>()(
  "InvoiceReadError",
  { error: Schema.String },
) {}

type InboxPageResult = Awaited<ReturnType<typeof getInbox>>;
type InboxItemResult = Awaited<ReturnType<typeof getInboxById>>;
type DeliveryStatusResult = Awaited<
  ReturnType<typeof getInvoiceDeliveryStatus>
>;
type AccountingStatusResult = Awaited<
  ReturnType<typeof getInvoiceAccountingStatus>
>;
type ExportRowsResult = Awaited<ReturnType<typeof getInvoiceExportRows>>;

export class InvoiceRepository extends Context.Tag(
  "invoicewise/InvoiceRepository",
)<
  InvoiceRepository,
  {
    readonly list: (
      params: GetInboxParams,
    ) => Effect.Effect<InboxPageResult, InvoiceReadError>;
    readonly findById: (
      id: string,
      teamId: string,
    ) => Effect.Effect<InboxItemResult, InvoiceReadError>;
    readonly deliveryStatus: (
      id: string,
      teamId: string,
    ) => Effect.Effect<DeliveryStatusResult, InvoiceReadError>;
    readonly accountingStatus: (
      id: string,
      teamId: string,
    ) => Effect.Effect<AccountingStatusResult, InvoiceReadError>;
    readonly exportRows: (
      teamId: string,
    ) => Effect.Effect<ExportRowsResult, InvoiceReadError>;
  }
>() {}

export class InvoiceStorage extends Context.Tag("invoicewise/InvoiceStorage")<
  InvoiceStorage,
  {
    readonly signedUrl: (input: {
      bucket: string;
      path: string;
      expireIn: number;
      download: boolean;
      inboxId: string;
    }) => Effect.Effect<string, InvoiceReadError>;
  }
>() {}

export class InvoiceRead extends Context.Tag("invoicewise/InvoiceRead")<
  InvoiceRead,
  {
    readonly list: (
      teamId: string,
      query: InvoiceListQuery,
    ) => Effect.Effect<InvoicePage, InvoiceReadError>;
    readonly findById: (
      id: string,
      teamId: string,
    ) => Effect.Effect<InvoiceItem, InvoiceNotFound | InvoiceReadError>;
    readonly detail: (
      id: string,
      teamId: string,
    ) => Effect.Effect<InvoiceDetail, InvoiceNotFound | InvoiceReadError>;
    readonly deliveryStatus: (
      id: string,
      teamId: string,
    ) => Effect.Effect<DeliveryStatus, InvoiceNotFound | InvoiceReadError>;
    readonly exportCsv: (
      teamId: string,
    ) => Effect.Effect<string, InvoiceReadError>;
    readonly attachmentUrl: (
      id: string,
      teamId: string,
      download: boolean,
    ) => Effect.Effect<
      AttachmentUrl,
      AttachmentUnavailable | InvoiceNotFound | InvoiceReadError
    >;
  }
>() {}

class InvoiceDatabase extends Context.Tag("invoicewise/InvoiceDatabase")<
  InvoiceDatabase,
  { readonly db: Database }
>() {}

class StorageClient extends Context.Tag("invoicewise/StorageClient")<
  StorageClient,
  { readonly client: ReturnType<typeof createStorageClientFromEnv> }
>() {}

const optionalRedacted = (name: string) => Config.option(Config.redacted(name));

const DatabaseLive = Layer.scoped(
  InvoiceDatabase,
  Effect.acquireRelease(
    Config.all({
      primaryUrl: Config.redacted("DATABASE_PRIMARY_URL"),
      fraUrl: optionalRedacted("DATABASE_FRA_URL"),
      sjcUrl: optionalRedacted("DATABASE_SJC_URL"),
      iadUrl: optionalRedacted("DATABASE_IAD_URL"),
      region: Config.option(Config.string("FLY_REGION")),
      instance: Config.option(Config.string("FLY_ALLOC_ID")),
      environment: Config.string("NODE_ENV").pipe(
        Config.withDefault("production"),
      ),
    }).pipe(
      Effect.map((config) => {
        const replicaUrls =
          Option.isSome(config.fraUrl) &&
          Option.isSome(config.sjcUrl) &&
          Option.isSome(config.iadUrl)
            ? {
                fra: Redacted.value(config.fraUrl.value),
                sjc: Redacted.value(config.sjcUrl.value),
                iad: Redacted.value(config.iadUrl.value),
              }
            : undefined;
        return createDatabaseClient({
          primaryUrl: Redacted.value(config.primaryUrl),
          replicaUrls,
          region: Option.getOrUndefined(config.region),
          instance: Option.getOrUndefined(config.instance),
          isDevelopment: config.environment === "development",
        });
      }),
    ),
    (client) => Effect.promise(() => client.close()),
  ).pipe(Effect.map((client) => ({ db: client.db }))),
);

const StorageClientLive = Layer.sync(StorageClient, () => ({
  client: createStorageClientFromEnv(),
}));

export const InvoiceRepositoryLive = Layer.effect(
  InvoiceRepository,
  Effect.gen(function* () {
    const { db } = yield* InvoiceDatabase;
    return {
      list: (params: GetInboxParams) =>
        Effect.tryPromise({
          try: () => getInbox(db, params),
          catch: () =>
            new InvoiceReadError({ error: "Unable to read invoices" }),
        }),
      findById: (id: string, teamId: string) =>
        Effect.tryPromise({
          try: () => getInboxById(db, { id, teamId }),
          catch: () =>
            new InvoiceReadError({ error: "Unable to read invoice" }),
        }),
      deliveryStatus: (id: string, teamId: string) =>
        Effect.tryPromise({
          try: () => getInvoiceDeliveryStatus(db, { invoiceId: id, teamId }),
          catch: () =>
            new InvoiceReadError({ error: "Unable to read delivery status" }),
        }),
      accountingStatus: (id: string, teamId: string) =>
        Effect.tryPromise({
          try: () => getInvoiceAccountingStatus(db, { invoiceId: id, teamId }),
          catch: () =>
            new InvoiceReadError({ error: "Unable to read accounting status" }),
        }),
      exportRows: (teamId: string) =>
        Effect.tryPromise({
          try: () => getInvoiceExportRows(db, teamId),
          catch: () =>
            new InvoiceReadError({ error: "Unable to export invoices" }),
        }),
    };
  }),
).pipe(Layer.provide(DatabaseLive));

export const InvoiceStorageLive = Layer.effect(
  InvoiceStorage,
  Effect.gen(function* () {
    const { client } = yield* StorageClient;
    return {
      signedUrl: (input) =>
        Effect.tryPromise({
          try: () =>
            client.signedUrl({
              bucket: input.bucket,
              path: input.path,
              expireIn: input.expireIn,
              inboxId: input.inboxId,
              options: { download: input.download },
            }),
          catch: () =>
            new InvoiceReadError({
              error: "Unable to generate attachment URL",
            }),
        }),
    };
  }),
).pipe(Layer.provide(StorageClientLive));

const decode = <A, I>(schema: Schema.Schema<A, I, never>, value: unknown) =>
  Schema.decodeUnknown(schema)(value).pipe(
    Effect.mapError(
      () => new InvoiceReadError({ error: "Invoice data is invalid" }),
    ),
  );

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};

const csvCell = (value: unknown) => {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

export const invoicesToCsv = (rows: ExportRowsResult) => {
  const judgmentIds = Array.from(
    new Set(
      rows.flatMap((row) =>
        (row.judgments ?? [])
          .map((judgment) => record(judgment).questionId)
          .filter((id): id is string => typeof id === "string"),
      ),
    ),
  ).sort();
  const headers = [
    "id",
    "display_name",
    "file_name",
    "supplier_name",
    "supplier_address",
    "invoice_number",
    "invoice_date",
    "due_date",
    "amount",
    "currency",
    "status",
    "created_at",
    ...judgmentIds.map((id) => `judgment:${id}`),
  ];
  const lines = rows.map((row) => {
    const extraction = record(row.extraction);
    const judgments = new Map(
      (row.judgments ?? []).flatMap((value) => {
        const judgment = record(value);
        return typeof judgment.questionId === "string"
          ? [
              [
                judgment.questionId,
                judgment.answer ??
                  (judgment.status === "not_applicable"
                    ? "not applicable"
                    : judgment.error) ??
                  "",
              ] as const,
            ]
          : [];
      }),
    );
    return [
      row.id,
      row.displayName,
      row.fileName,
      extraction.supplierName,
      extraction.supplierAddress,
      extraction.invoiceNumber,
      extraction.invoiceDate,
      extraction.dueDate,
      row.amount,
      row.currency,
      row.status,
      row.createdAt,
      ...judgmentIds.map((id) => judgments.get(id)),
    ]
      .map(csvCell)
      .join(",");
  });
  return [headers.map(csvCell).join(","), ...lines].join("\r\n");
};

export const InvoiceReadLayer = Layer.effect(
  InvoiceRead,
  Effect.gen(function* () {
    const repository = yield* InvoiceRepository;
    const storage = yield* InvoiceStorage;

    const list = (
      teamId: string,
      query: InvoiceListQuery,
    ): Effect.Effect<InvoicePage, InvoiceReadError> =>
      Effect.gen(function* () {
        const result = yield* repository.list({ teamId, ...query });
        return yield* decode(InvoicePage, result);
      });

    const findById = (
      id: string,
      teamId: string,
    ): Effect.Effect<InvoiceItem, InvoiceNotFound | InvoiceReadError> =>
      Effect.gen(function* () {
        const result = yield* repository.findById(id, teamId);
        if (!result) {
          return yield* Effect.fail(
            new InvoiceNotFound({ error: "Inbox item not found" }),
          );
        }
        return yield* decode(InvoiceItem, result);
      });

    const detail = (
      id: string,
      teamId: string,
    ): Effect.Effect<InvoiceDetail, InvoiceNotFound | InvoiceReadError> =>
      Effect.gen(function* () {
        const item = yield* repository.findById(id, teamId);
        if (!item) {
          return yield* Effect.fail(
            new InvoiceNotFound({ error: "Invoice not found" }),
          );
        }
        if (
          !item.filePath?.length ||
          !isValidDocumentBinding({ teamId, filePath: item.filePath })
        ) {
          return yield* Effect.fail(
            new InvoiceReadError({ error: "Invoice document is unavailable" }),
          );
        }
        const documentUrl = yield* storage.signedUrl({
          bucket: "vault",
          path: item.filePath.join("/"),
          expireIn: 300,
          download: false,
          inboxId: id,
        });
        const extraction = record(item.extraction);
        return yield* decode(InvoiceDetail, {
          ...item,
          lineItems: Array.isArray(extraction.lineItems)
            ? extraction.lineItems
            : [],
          documentUrl,
        });
      });

    const deliveryStatus = (
      id: string,
      teamId: string,
    ): Effect.Effect<DeliveryStatus, InvoiceNotFound | InvoiceReadError> =>
      Effect.gen(function* () {
        const invoice = yield* repository.findById(id, teamId);
        if (!invoice) {
          return yield* Effect.fail(
            new InvoiceNotFound({ error: "Invoice not found" }),
          );
        }
        return yield* decode(DeliveryStatus, {
          data: yield* repository.deliveryStatus(id, teamId),
          accounting: yield* repository.accountingStatus(id, teamId),
        });
      });

    const exportCsv = (teamId: string) =>
      repository.exportRows(teamId).pipe(Effect.map(invoicesToCsv));

    const attachmentUrl = (
      id: string,
      teamId: string,
      download: boolean,
    ): Effect.Effect<
      AttachmentUrl,
      AttachmentUnavailable | InvoiceNotFound | InvoiceReadError
    > =>
      Effect.gen(function* () {
        const item = yield* repository.findById(id, teamId);
        if (!item) {
          return yield* Effect.fail(
            new InvoiceNotFound({ error: "Inbox item not found" }),
          );
        }
        if (
          !item.filePath?.length ||
          !isValidDocumentBinding({ teamId, filePath: item.filePath })
        ) {
          return yield* Effect.fail(
            new AttachmentUnavailable({
              error: "Attachment file path not available",
            }),
          );
        }

        const expireIn = 60;
        const url = yield* storage.signedUrl({
          bucket: "vault",
          path: item.filePath.join("/"),
          expireIn,
          download,
          inboxId: id,
        });
        const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
        return {
          url,
          expiresAt: new Date(now + expireIn * 1000).toISOString(),
          fileName: item.fileName ?? item.filePath.at(-1) ?? null,
        };
      });

    return {
      attachmentUrl,
      deliveryStatus,
      detail,
      exportCsv,
      findById,
      list,
    };
  }),
);

export const InvoiceReadLive = InvoiceReadLayer.pipe(
  Layer.provide(Layer.mergeAll(InvoiceRepositoryLive, InvoiceStorageLive)),
);
