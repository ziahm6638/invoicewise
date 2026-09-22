import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { type Database, createDatabaseClient } from "@midday/db/client";
import {
  type GetInboxParams,
  getInbox,
  getInboxById,
} from "@midday/db/queries";
import { createStorageClient } from "@midday/db/storage";
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
  transaction: Schema.NullOr(Transaction),
});

export type InvoiceItem = typeof InvoiceItem.Type;

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
  { readonly client: ReturnType<typeof createStorageClient> }
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

const StorageClientLive = Layer.effect(
  StorageClient,
  Config.all({
    rootPath: Config.string("LOCAL_STORAGE_PATH").pipe(
      Config.withDefault(resolve(tmpdir(), "invoicewise-storage")),
    ),
    publicUrl: Config.string("STORAGE_PUBLIC_URL").pipe(
      Config.orElse(() => Config.string("NEXT_PUBLIC_API_URL")),
      Config.withDefault("http://localhost:3003"),
    ),
    signingSecret: Config.redacted("LOCAL_STORAGE_SIGNING_SECRET"),
  }).pipe(
    Effect.map((config) => ({
      client: createStorageClient({
        rootPath: config.rootPath,
        publicUrl: config.publicUrl,
        signingSecret: Redacted.value(config.signingSecret),
      }),
    })),
  ),
);

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
        if (!item.filePath?.length) {
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
        });
        const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
        return {
          url,
          expiresAt: new Date(now + expireIn * 1000).toISOString(),
          fileName: item.fileName ?? item.filePath.at(-1) ?? null,
        };
      });

    return { attachmentUrl, findById, list };
  }),
);

export const InvoiceReadLive = InvoiceReadLayer.pipe(
  Layer.provide(Layer.mergeAll(InvoiceRepositoryLive, InvoiceStorageLive)),
);
