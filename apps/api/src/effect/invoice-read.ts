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
import { Config, Context, Effect, Layer, Redacted, Schema } from "effect";
import { csvCell } from "./csv";

const Transaction = Schema.Struct({
  id: Schema.String,
  amount: Schema.Number,
  currency: Schema.String,
  name: Schema.String,
  date: Schema.String,
});

const InboundEmailSource = Schema.Struct({
  id: Schema.String,
  messageId: Schema.NullOr(Schema.String),
  from: Schema.NullOr(Schema.String),
  envelopeFrom: Schema.NullOr(Schema.String),
  recipient: Schema.String,
  subject: Schema.NullOr(Schema.String),
  receivedAt: Schema.String,
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
  /**
   * Deterministic checks of the extraction and whether it may be posted to
   * accounting (`status`, `checks`, `issues`, `identity`, `accounting`);
   * null until processed.
   */
  validation: Schema.optional(Schema.NullOr(Schema.Unknown)),
  /** The workspace supplier the invoice resolved to, before any merge; null when unresolved. */
  supplierId: Schema.optional(Schema.NullOr(Schema.String)),
  /**
   * Supplier-history checks (`known`, `duplicate`, `bankDetails`) with the
   * earlier documents each cites, the supplier resolution and the rules
   * `version`; bank details appear only masked. Null until processed.
   */
  supplierChecks: Schema.optional(Schema.NullOr(Schema.Unknown)),
  /**
   * The current decision about which authorization sources (jobs, purchase
   * orders, contracts) the invoice bills: `status` (`matched`, `unmatched`,
   * `ambiguous`, `insufficient_evidence`), `method`, `confidence`,
   * `needsConfirmation`, the linked sources and versions (`links`), the
   * `allocations`, every `candidates` source considered with its evidence,
   * and who decided (`origin`, `action`, `reason`). Null until matched.
   * A credential without `sources.read` gets only `status`,
   * `needsConfirmation` and the linked `sourceIds`.
   */
  sourceMatch: Schema.optional(Schema.NullOr(Schema.Unknown)),
  /**
   * The current reconciliation of that match with the sources' authorized
   * terms (docs/reconciliation.md): `status` (`reconciled`, `discrepancy`,
   * `unresolved`, `unmatched`), per source the line and total variances
   * (quantity, rate, tax, amount) and the `balance` (authorized, committed
   * before and after this invoice, remaining), the `discrepancies` and
   * `unresolved` findings with their evidence, and the tolerances applied.
   * Null until reconciled. A credential without `sources.read` gets only
   * `status` and the findings' codes.
   */
  reconciliation: Schema.optional(Schema.NullOr(Schema.Unknown)),
  /**
   * The delivery rules' decision for the current revision: the policy
   * version it was made under, `outcome` (`deliver` or `hold`), the
   * `reasons` it was held, what each destination was told and how a hold
   * was resolved. Null for invoices processed before delivery rules existed.
   */
  deliveryDecision: Schema.optional(Schema.NullOr(Schema.Unknown)),
  /** Why extraction failed, when it did; null while processing or once processed. */
  processingError: Schema.optional(Schema.NullOr(Schema.String)),
  /**
   * The message this document arrived in on the workspace's dedicated
   * address (Message-ID, sender, recipient, receipt time); null otherwise.
   */
  inboundEmail: Schema.optional(Schema.NullOr(InboundEmailSource)),
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
export const SourceDetails = Schema.Literal("full", "summary");
export type SourceDetails = typeof SourceDetails.Type;

export const InvoiceHeaders = Schema.Struct({
  "x-invoicewise-team-id": Schema.String,
  "x-invoicewise-source-details": Schema.optionalWith(SourceDetails, {
    default: () => "summary",
  }),
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
  eventId: Schema.NullOr(Schema.String),
  revision: Schema.NullOr(Schema.Number),
  status: Schema.String,
  attempts: Schema.Number,
  lastError: Schema.NullOr(Schema.String),
  retryable: Schema.NullOr(Schema.Boolean),
  deliveredAt: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
});
export const DeliveryStatus = Schema.Struct({
  data: Schema.Array(DeliveryStatusItem),
  accounting: Schema.NullOr(
    Schema.Struct({
      provider: Schema.NullOr(Schema.String),
      status: Schema.String,
      providerId: Schema.NullOr(Schema.String),
      lastError: Schema.NullOr(Schema.String),
      retryable: Schema.NullOr(Schema.Boolean),
      revision: Schema.NullOr(Schema.Number),
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
      sourceDetails: SourceDetails,
    ) => Effect.Effect<InvoicePage, InvoiceReadError>;
    readonly findById: (
      id: string,
      teamId: string,
      sourceDetails: SourceDetails,
    ) => Effect.Effect<InvoiceItem, InvoiceNotFound | InvoiceReadError>;
    readonly detail: (
      id: string,
      teamId: string,
      sourceDetails: SourceDetails,
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

const DatabaseLive = Layer.scoped(
  InvoiceDatabase,
  Effect.acquireRelease(
    Config.all({
      primaryUrl: Config.redacted("DATABASE_PRIMARY_URL"),
      environment: Config.string("NODE_ENV").pipe(
        Config.withDefault("production"),
      ),
    }).pipe(
      Effect.map((config) =>
        createDatabaseClient({
          primaryUrl: Redacted.value(config.primaryUrl),
          isDevelopment: config.environment === "development",
        }),
      ),
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

/**
 * The source match as a credential without `sources.read` sees it: whether
 * and to which sources the invoice is matched, never the sources' terms or
 * the evidence about them.
 */
export const summarizeSourceMatch = (value: unknown) => {
  if (value === null || value === undefined) return value;
  const match = record(value);
  return {
    status: match.status,
    needsConfirmation: match.needsConfirmation,
    sourceIds: Array.isArray(match.links)
      ? match.links.map((link) => record(link).sourceId)
      : [],
  };
};

/**
 * The reconciliation as a credential without `sources.read` sees it: its
 * status and which kinds of findings it has, never the sources' amounts,
 * terms or evidence.
 */
export const summarizeReconciliation = (value: unknown) => {
  if (value === null || value === undefined) return value;
  const reconciliation = record(value);
  const codes = (items: unknown) =>
    Array.isArray(items) ? items.map((item) => record(item).code) : [];
  return {
    status: reconciliation.status,
    discrepancies: codes(reconciliation.discrepancies),
    unresolved: codes(reconciliation.unresolved),
  };
};

const withSourceDetails = <
  T extends { sourceMatch?: unknown; reconciliation?: unknown },
>(
  item: T,
  sourceDetails: SourceDetails,
): T =>
  sourceDetails === "full"
    ? item
    : {
        ...item,
        sourceMatch: summarizeSourceMatch(item.sourceMatch),
        ...("reconciliation" in item
          ? { reconciliation: summarizeReconciliation(item.reconciliation) }
          : {}),
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
    "document_type",
    "validation_status",
    "accounting_ready",
    "validation_issues",
    "status",
    "created_at",
    ...judgmentIds.map((id) => `judgment:${id}`),
  ];
  const lines = rows.map((row) => {
    const extraction = record(row.extraction);
    const validation = record(row.validation);
    const accounting = record(validation.accounting);
    const issues = Array.isArray(validation.issues)
      ? validation.issues.map((issue) => record(issue).message).join(" | ")
      : null;
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
                    : judgment.status === "unknown"
                      ? "unknown"
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
      validation.documentType ?? extraction.documentType,
      validation.status,
      typeof accounting.ready === "boolean" ? accounting.ready : null,
      issues,
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
      sourceDetails: SourceDetails,
    ): Effect.Effect<InvoicePage, InvoiceReadError> =>
      Effect.gen(function* () {
        const result = yield* repository.list({ teamId, ...query });
        return yield* decode(InvoicePage, {
          ...result,
          data: result.data.map((item) =>
            withSourceDetails(item, sourceDetails),
          ),
        });
      });

    const findById = (
      id: string,
      teamId: string,
      sourceDetails: SourceDetails,
    ): Effect.Effect<InvoiceItem, InvoiceNotFound | InvoiceReadError> =>
      Effect.gen(function* () {
        const result = yield* repository.findById(id, teamId);
        if (!result) {
          return yield* Effect.fail(
            new InvoiceNotFound({ error: "Inbox item not found" }),
          );
        }
        return yield* decode(
          InvoiceItem,
          withSourceDetails(result, sourceDetails),
        );
      });

    const detail = (
      id: string,
      teamId: string,
      sourceDetails: SourceDetails,
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
          ...withSourceDetails(item, sourceDetails),
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
