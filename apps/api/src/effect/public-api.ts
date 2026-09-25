import { randomUUID } from "node:crypto";
import { HttpApiSchema } from "@effect/platform";
import type { Database } from "@invoicewise/db/client";
import { primaryDb } from "@invoicewise/db/client";
import {
  INVOICE_STATE_FILTERS,
  PUBLIC_INVOICE_STATUSES,
  type PublicInvoiceCursor,
  type PublicInvoiceRow,
  type TeamRole,
  findIntakeByReference,
  getInvoiceAccountingStatus,
  getInvoiceDeliveryStatus,
  getPublicInvoice,
  listPublicInvoices,
  listQuestionAnswerHistory,
  listWorkspaceQuestionKeys,
} from "@invoicewise/db/queries";
import { signedUrl as signStorageUrl } from "@invoicewise/db/storage";
import { retryInvoiceDelivery } from "@invoicewise/jobs/delivery";
import {
  InvoiceActionError,
  requestQuestionRerun,
} from "@invoicewise/jobs/exceptions";
import {
  type IntakeStorage,
  type IntakeUploadResult,
  acceptIntakeUpload,
  defaultIntakeStorage,
  intakeContentHash,
  resolveTeamDocumentBinding,
  retryIntakeProcessing,
} from "@invoicewise/jobs/intake";
import { logger } from "@invoicewise/logger";
import { Context, Effect, Layer, Schema } from "effect";
import { csvDocument } from "./csv";

/**
 * The versioned public API (`/v1`): one contract for submitting documents,
 * reading invoices, judgments and delivery, deliberate retries and paged CSV
 * exports. Authentication, scopes and rate limits happen in the Hono layer
 * (`apps/api/src/rest/v1.ts`) before a request reaches these handlers; the
 * caller's workspace always comes from the credential, never from input.
 * Customer documentation: docs/api.md.
 */

export const API_VERSION = "1";

// ---------------------------------------------------------------------------
// Errors. Every failure has the body `{ "error": { "code", "message" } }`.
// ---------------------------------------------------------------------------

export const ErrorDetail = Schema.Struct({
  code: Schema.String.annotations({
    description: "Stable, machine-readable reason. See docs/api.md#errors.",
  }),
  message: Schema.String.annotations({
    description: "Human-readable explanation. Do not parse it.",
  }),
});

const errorBody = { error: ErrorDetail };

export class ApiBadRequest extends Schema.Class<ApiBadRequest>("BadRequest")(
  errorBody,
  HttpApiSchema.annotations({ status: 400 }),
) {}
export class ApiUnauthorized extends Schema.Class<ApiUnauthorized>(
  "Unauthorized",
)(errorBody, HttpApiSchema.annotations({ status: 401 })) {}
export class ApiForbidden extends Schema.Class<ApiForbidden>("Forbidden")(
  errorBody,
  HttpApiSchema.annotations({ status: 403 }),
) {}
export class ApiNotFound extends Schema.Class<ApiNotFound>("NotFound")(
  errorBody,
  HttpApiSchema.annotations({ status: 404 }),
) {}
export class ApiConflict extends Schema.Class<ApiConflict>("Conflict")(
  errorBody,
  HttpApiSchema.annotations({ status: 409 }),
) {}
export class ApiPayloadTooLarge extends Schema.Class<ApiPayloadTooLarge>(
  "PayloadTooLarge",
)(errorBody, HttpApiSchema.annotations({ status: 413 })) {}
export class ApiTooManyRequests extends Schema.Class<ApiTooManyRequests>(
  "TooManyRequests",
)(errorBody, HttpApiSchema.annotations({ status: 429 })) {}
export class ApiInternal extends Schema.Class<ApiInternal>("InternalError")(
  errorBody,
  HttpApiSchema.annotations({ status: 500 }),
) {}
export class ApiUnavailable extends Schema.Class<ApiUnavailable>(
  "ServiceUnavailable",
)(errorBody, HttpApiSchema.annotations({ status: 503 })) {}

export type ApiError =
  | ApiBadRequest
  | ApiUnauthorized
  | ApiForbidden
  | ApiNotFound
  | ApiConflict
  | ApiPayloadTooLarge
  | ApiTooManyRequests
  | ApiInternal
  | ApiUnavailable;

/**
 * The status of a contract error. The error classes share one body shape,
 * so handlers render them by class rather than leaving the choice to a
 * structural schema match.
 */
export const errorStatus = (error: ApiError): number =>
  error instanceof ApiBadRequest
    ? 400
    : error instanceof ApiUnauthorized
      ? 401
      : error instanceof ApiForbidden
        ? 403
        : error instanceof ApiNotFound
          ? 404
          : error instanceof ApiConflict
            ? 409
            : error instanceof ApiPayloadTooLarge
              ? 413
              : error instanceof ApiTooManyRequests
                ? 429
                : error instanceof ApiUnavailable
                  ? 503
                  : 500;

const badRequest = (code: string, message: string) =>
  new ApiBadRequest({ error: { code, message } });
const notFound = () =>
  new ApiNotFound({
    error: { code: "not_found", message: "Invoice not found" },
  });
const internal = (message: string) =>
  new ApiInternal({ error: { code: "internal_error", message } });

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

const JsonObject = Schema.Record({ key: Schema.String, value: Schema.Unknown });

export const InvoiceStatus = Schema.Literal(
  ...PUBLIC_INVOICE_STATUSES,
).annotations({
  description:
    "`processing` while the document is being read; `processed` once it was read (see `validation` and `delivery` for what followed); `failed` when reading failed (see `processingError`, and re-extract).",
});

export const Judgment = Schema.Struct({
  questionKey: Schema.String.annotations({
    description: "The workspace question's stable key.",
  }),
  questionVersion: Schema.NullOr(Schema.Int).annotations({
    description: "The revision of the question that was asked.",
  }),
  questionVersionId: Schema.NullOr(Schema.String),
  label: Schema.String,
  question: Schema.NullOr(Schema.String),
  type: Schema.NullOr(Schema.Literal("boolean", "choice", "score", "number")),
  status: Schema.Literal(
    "answered",
    "unknown",
    "not_applicable",
    "failed",
  ).annotations({
    description:
      "`unknown`, `not_applicable` and `failed` are never a No or a zero.",
  }),
  answer: Schema.NullOr(
    Schema.Union(Schema.Boolean, Schema.Number, Schema.String),
  ),
  probability: Schema.NullOr(Schema.Number).annotations({
    description: "Boolean questions: the probability the answer is yes.",
  }),
  confidence: Schema.NullOr(Schema.Number),
  certainty: Schema.NullOr(Schema.String),
  currency: Schema.NullOr(Schema.String).annotations({
    description: "Currency questions: the invoice's currency.",
  }),
  reason: Schema.NullOr(Schema.String).annotations({
    description:
      "Why an answer is `unknown` or `not_applicable`, or why evaluation `failed`.",
  }),
  source: Schema.NullOr(Schema.Literal("default", "custom")),
  evaluator: Schema.NullOr(
    Schema.Struct({
      model: Schema.NullOr(Schema.String),
      version: Schema.String,
    }),
  ),
  answeredAt: Schema.NullOr(Schema.String),
  runId: Schema.NullOr(Schema.String).annotations({
    description:
      "The deliberate rerun that recorded the answer; null for processing's answer.",
  }),
});
export type Judgment = typeof Judgment.Type;

export const DeliverySummary = Schema.Struct({
  state: Schema.Literal("none", "pending", "delivered", "failed", "cancelled"),
  total: Schema.Int,
  succeeded: Schema.Int,
  pending: Schema.Int,
  failed: Schema.Int,
  cancelled: Schema.Int,
}).annotations({
  description:
    "Outcome of the current revision's destinations (webhooks and accounting).",
});

export const Invoice = Schema.Struct({
  id: Schema.String,
  revision: Schema.Int.annotations({
    description:
      "Processing revision. It grows on every re-extraction and correction; send it back with an action.",
  }),
  status: InvoiceStatus,
  createdAt: Schema.String,
  document: Schema.Struct({
    fileName: Schema.NullOr(Schema.String),
    displayName: Schema.NullOr(Schema.String),
    contentType: Schema.NullOr(Schema.String),
    size: Schema.NullOr(Schema.Number),
    sha256: Schema.NullOr(Schema.String),
    source: Schema.Literal("api", "upload", "email", "mailbox"),
    idempotencyKey: Schema.NullOr(Schema.String).annotations({
      description: "The `Idempotency-Key` it was submitted with, if any.",
    }),
  }),
  supplierId: Schema.NullOr(Schema.String),
  supplierName: Schema.NullOr(Schema.String),
  invoiceNumber: Schema.NullOr(Schema.String),
  invoiceDate: Schema.NullOr(Schema.String),
  dueDate: Schema.NullOr(Schema.String),
  currency: Schema.NullOr(Schema.String),
  amount: Schema.NullOr(Schema.Number).annotations({
    description: "The document's gross total as printed, in `currency`.",
  }),
  processingError: Schema.NullOr(Schema.String),
  corrected: Schema.Boolean,
  extraction: Schema.NullOr(JsonObject).annotations({
    description:
      "The canonical extraction record with per-value evidence; see docs/document-intake.md#persisted-result.",
  }),
  validation: Schema.NullOr(JsonObject).annotations({
    description:
      "Deterministic checks and accounting readiness; see docs/document-intake.md#validation.",
  }),
  supplierChecks: Schema.NullOr(JsonObject).annotations({
    description:
      "Supplier-history checks; see docs/document-intake.md#supplier-identity-and-history.",
  }),
  judgments: Schema.Array(Judgment),
  questionRerun: Schema.NullOr(
    Schema.Struct({
      status: Schema.Literal("queued", "failed"),
      error: Schema.NullOr(Schema.String),
    }),
  ),
  delivery: DeliverySummary,
  accounting: Schema.NullOr(
    Schema.Struct({
      provider: Schema.NullOr(Schema.String),
      status: Schema.String,
      providerId: Schema.NullOr(Schema.String),
    }),
  ),
});
export type Invoice = typeof Invoice.Type;

export const InvoiceList = Schema.Struct({
  data: Schema.Array(Invoice),
  hasMore: Schema.Boolean,
  nextCursor: Schema.NullOr(Schema.String).annotations({
    description:
      "Pass as `cursor` with the same filters for the next page; null on the last page.",
  }),
});
export type InvoiceList = typeof InvoiceList.Type;

export const Submission = Schema.Struct({
  id: Schema.String,
  status: InvoiceStatus,
  revision: Schema.Int,
  deduplicated: Schema.Boolean.annotations({
    description:
      "True when this content (or this idempotency key) was already accepted: the existing invoice is returned and nothing is processed or delivered again.",
  }),
  fileName: Schema.String,
  contentType: Schema.String,
  size: Schema.Int,
  sha256: Schema.String,
  links: Schema.Struct({ invoice: Schema.String }),
});
export type Submission = typeof Submission.Type;

export const AnswerHistoryEntry = Schema.Struct({
  id: Schema.String,
  runId: Schema.String,
  questionKey: Schema.String,
  questionVersion: Schema.NullOr(Schema.Int),
  questionVersionId: Schema.String,
  invoiceRevision: Schema.Int,
  recordedAt: Schema.String,
  answer: Judgment,
  previous: Schema.NullOr(Judgment),
});

export const InvoiceJudgments = Schema.Struct({
  invoiceId: Schema.String,
  revision: Schema.Int,
  judgments: Schema.Array(Judgment),
  history: Schema.Array(AnswerHistoryEntry).annotations({
    description: "Answers recorded by deliberate reruns, oldest first.",
  }),
});
export type InvoiceJudgments = typeof InvoiceJudgments.Type;

export const InvoiceDelivery = Schema.Struct({
  invoiceId: Schema.String,
  revision: Schema.Int,
  state: DeliverySummary.fields.state,
  webhooks: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      endpointId: Schema.String,
      endpointUrl: Schema.String,
      event: Schema.String,
      eventId: Schema.NullOr(Schema.String),
      revision: Schema.NullOr(Schema.Int),
      status: Schema.String,
      attempts: Schema.Int,
      lastError: Schema.NullOr(Schema.String),
      retryable: Schema.NullOr(Schema.Boolean),
      deliveredAt: Schema.NullOr(Schema.String),
      createdAt: Schema.String,
    }),
  ),
  accounting: Schema.NullOr(
    Schema.Struct({
      provider: Schema.NullOr(Schema.String),
      status: Schema.String,
      providerId: Schema.NullOr(Schema.String),
      lastError: Schema.NullOr(Schema.String),
      retryable: Schema.NullOr(Schema.Boolean),
      revision: Schema.NullOr(Schema.Int),
      postedAt: Schema.NullOr(Schema.String),
    }),
  ),
});
export type InvoiceDelivery = typeof InvoiceDelivery.Type;

export const DocumentLink = Schema.Struct({
  url: Schema.String,
  expiresAt: Schema.String,
  fileName: Schema.NullOr(Schema.String),
});
export type DocumentLink = typeof DocumentLink.Type;

export const RevisionBody = Schema.Struct({
  revision: Schema.Int.pipe(Schema.nonNegative()).annotations({
    description:
      "The invoice `revision` you read. A different current revision is refused with 409 `conflict`.",
  }),
});

export const ActionAccepted = Schema.Struct({
  id: Schema.String,
  action: Schema.Literal("reextract", "rerun_questions"),
  revision: Schema.Int,
  deduplicated: Schema.Boolean.annotations({
    description: "True when the same action was already queued.",
  }),
});
export type ActionAccepted = typeof ActionAccepted.Type;

export const DeliveryRetry = Schema.Struct({
  id: Schema.String,
  revision: Schema.Int,
  started: Schema.Boolean.annotations({
    description: "Whether anything was re-queued.",
  }),
  webhooks: Schema.Struct({ requeued: Schema.Int, skipped: Schema.Int }),
  accounting: Schema.Literal(
    "requeued",
    "already_posted",
    "in_progress",
    "no_active_connection",
    "not_scheduled",
    "admin_required",
  ),
  billUpdate: Schema.Literal(
    "requeued",
    "in_progress",
    "not_needed",
    "no_active_connection",
    "admin_required",
  ),
});
export type DeliveryRetry = typeof DeliveryRetry.Type;

// ---------------------------------------------------------------------------
// Query parameters
// ---------------------------------------------------------------------------

const IsoDate = Schema.String.pipe(
  Schema.pattern(/^\d{4}-\d{2}-\d{2}$/, {
    message: () => "Expected a date as YYYY-MM-DD",
  }),
);

const listFilterFields = {
  status: Schema.optional(Schema.Literal(...PUBLIC_INVOICE_STATUSES)),
  state: Schema.optional(Schema.Literal(...INVOICE_STATE_FILTERS)).annotations({
    description:
      "Exception state, as the dashboard shows it (needs_attention, failed, invalid, needs_review, delivering, delivery_failed, delivered, processing, corrected).",
  }),
  q: Schema.optional(Schema.String.pipe(Schema.maxLength(200))).annotations({
    description: "Matches supplier name, invoice number and file name.",
  }),
  supplierId: Schema.optional(Schema.UUID),
  createdFrom: Schema.optional(IsoDate),
  createdTo: Schema.optional(IsoDate),
  order: Schema.optionalWith(Schema.Literal("desc", "asc"), {
    default: () => "desc" as const,
  }).annotations({ description: "By creation time; newest first by default." }),
  cursor: Schema.optional(Schema.String.pipe(Schema.maxLength(512))),
};

export const ListQuery = Schema.Struct({
  ...listFilterFields,
  limit: Schema.optionalWith(
    Schema.NumberFromString.pipe(Schema.int(), Schema.between(1, 100)),
    { default: () => 25 },
  ),
});
export type ListQuery = typeof ListQuery.Type;

export const ExportQuery = Schema.Struct({
  ...listFilterFields,
  limit: Schema.optionalWith(
    Schema.NumberFromString.pipe(Schema.int(), Schema.between(1, 1000)),
    { default: () => 500 },
  ),
});
export type ExportQuery = typeof ExportQuery.Type;

/**
 * Postgres returns `2026-09-25 10:00:00.123456+00`; the contract speaks
 * ISO 8601. The raw value is kept for cursors, which need its precision.
 */
const parseTimestamp = (value: string) =>
  new Date(value.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"));
export const isoTimestamp = (value: string) => {
  const date = parseTimestamp(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
};
const isoOrNull = (value: string | null) =>
  value === null ? null : isoTimestamp(value);

// ---------------------------------------------------------------------------
// Cursor: opaque to clients; the order it was issued for is part of it.
// ---------------------------------------------------------------------------

export const encodeCursor = (
  order: "asc" | "desc",
  position: PublicInvoiceCursor,
) =>
  Buffer.from(
    JSON.stringify([1, order, position.createdAt, position.id]),
  ).toString("base64url");

export const decodeCursor = (
  cursor: string | undefined,
  order: "asc" | "desc",
): Effect.Effect<PublicInvoiceCursor | null, ApiBadRequest> => {
  if (!cursor) return Effect.succeed(null);
  const invalid = badRequest(
    "invalid_cursor",
    "The cursor is not one this API issued for this order. Start again without a cursor.",
  );
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString());
    if (
      Array.isArray(value) &&
      value.length === 4 &&
      value[0] === 1 &&
      value[1] === order &&
      typeof value[2] === "string" &&
      !Number.isNaN(parseTimestamp(value[2]).getTime()) &&
      typeof value[3] === "string" &&
      /^[0-9a-f-]{36}$/i.test(value[3])
    ) {
      return Effect.succeed({ createdAt: value[2], id: value[3] });
    }
  } catch {
    // Falls through to the refusal below.
  }
  return Effect.fail(invalid);
};

// ---------------------------------------------------------------------------
// Caller and infrastructure
// ---------------------------------------------------------------------------

/** The authenticated caller, established by the Hono layer. */
export class Caller extends Context.Tag("invoicewise/PublicApiCaller")<
  Caller,
  { readonly teamId: string; readonly userId: string; readonly role: TeamRole }
>() {}

export type SubmitInput = {
  teamId: string;
  bytes: Uint8Array;
  fileName: string;
  declaredMimeType: string;
  idempotencyKey: string | null;
};

type ListParams = Parameters<typeof listPublicInvoices>[1];
type DeliveryRows = Awaited<ReturnType<typeof getInvoiceDeliveryStatus>>;
type AccountingRow = Awaited<ReturnType<typeof getInvoiceAccountingStatus>>;
type HistoryRows = Awaited<ReturnType<typeof listQuestionAnswerHistory>>;
type RetryResult = NonNullable<
  Awaited<ReturnType<typeof retryInvoiceDelivery>>
>;

/**
 * The database, storage and queue operations the public API needs. The live
 * layer uses the same shared intake, retry and read functions as the
 * dashboard; tests provide a fake.
 */
export class PublicApiStore extends Context.Tag("invoicewise/PublicApiStore")<
  PublicApiStore,
  {
    readonly list: (params: ListParams) => Promise<{
      data: PublicInvoiceRow[];
      next: PublicInvoiceCursor | null;
    }>;
    readonly get: (
      teamId: string,
      id: string,
    ) => Promise<PublicInvoiceRow | undefined>;
    readonly history: (
      teamId: string,
      invoiceIds: string[],
    ) => Promise<HistoryRows>;
    readonly questionKeys: (teamId: string) => Promise<string[]>;
    readonly deliveryStatus: (
      teamId: string,
      id: string,
    ) => Promise<{ webhooks: DeliveryRows; accounting: AccountingRow }>;
    readonly documentUrl: (
      teamId: string,
      id: string,
    ) => Promise<{ url: string; fileName: string | null } | null>;
    readonly referenceOwner: (
      teamId: string,
      referenceId: string,
    ) => Promise<{ inboxId: string; contentHash: string | null } | null>;
    readonly submit: (input: SubmitInput) => Promise<IntakeUploadResult>;
    readonly reextract: (
      teamId: string,
      id: string,
      revision: number,
    ) => Promise<{ deduplicated: boolean } | null>;
    readonly rerunQuestions: (
      teamId: string,
      id: string,
      revision: number,
    ) => Promise<{ revision: number; deduplicated: boolean }>;
    readonly retryDelivery: (input: {
      teamId: string;
      id: string;
      role: TeamRole;
      revision: number;
    }) => Promise<RetryResult | null>;
  }
>() {}

export const DOCUMENT_URL_TTL_SECONDS = 60;

export const makePublicApiStore = (
  db: Database,
  storage: IntakeStorage,
): Context.Tag.Service<PublicApiStore> => ({
  list: (params) => listPublicInvoices(db, params),
  get: (teamId, id) => getPublicInvoice(db, { teamId, id }),
  history: (teamId, invoiceIds) =>
    listQuestionAnswerHistory(db, { teamId, invoiceIds }),
  questionKeys: (teamId) => listWorkspaceQuestionKeys(db, teamId),
  deliveryStatus: async (teamId, id) => ({
    webhooks: await getInvoiceDeliveryStatus(db, { invoiceId: id, teamId }),
    accounting: await getInvoiceAccountingStatus(db, { invoiceId: id, teamId }),
  }),
  documentUrl: async (teamId, id) => {
    // The path comes from the persisted binding, never from the caller.
    const binding = await resolveTeamDocumentBinding(db, { teamId, id });
    if (!binding?.filePath?.length) return null;
    const url = await signStorageUrl({
      bucket: "vault",
      path: binding.filePath.join("/"),
      expireIn: DOCUMENT_URL_TTL_SECONDS,
      inboxId: binding.id,
      options: { download: true },
    });
    return { url, fileName: binding.fileName ?? null };
  },
  referenceOwner: (teamId, referenceId) =>
    findIntakeByReference(db, { teamId, referenceId }),
  submit: (input) =>
    acceptIntakeUpload(db, storage, {
      teamId: input.teamId,
      bytes: input.bytes,
      declaredMimeType: input.declaredMimeType,
      fileName: input.fileName,
      referenceId: input.idempotencyKey
        ? idempotencyReference(input.idempotencyKey)
        : apiSubmissionReference(),
    }),
  reextract: (teamId, id, revision) =>
    retryIntakeProcessing(db, {
      teamId,
      inboxId: id,
      expectedRevision: revision,
    }),
  rerunQuestions: (teamId, id, revision) =>
    requestQuestionRerun(db, {
      invoiceId: id,
      teamId,
      expectedRevision: revision,
    }),
  retryDelivery: (input) =>
    retryInvoiceDelivery(db, {
      invoiceId: input.id,
      teamId: input.teamId,
      teamRole: input.role,
      expectedRevision: input.revision,
    }),
});

/** Reads go to the primary, so a poll right after a submission sees it. */
export const PublicApiStoreLive = Layer.sync(PublicApiStore, () =>
  makePublicApiStore(primaryDb as unknown as Database, defaultIntakeStorage),
);

/** Idempotency keys share the workspace's provider-reference namespace. */
export const idempotencyReference = (key: string) => `api:${key}`;

/**
 * A keyless submission still records its API origin, under a unique reference
 * outside the `api:` key namespace, so it is never reported as a key.
 */
export const apiSubmissionReference = () => `api-submission:${randomUUID()}`;

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown) => (typeof value === "string" ? value : null);
const num = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

export const statusOf = (row: {
  status: string | null;
  processingError: string | null;
  extraction: unknown;
  processingStalled: boolean | null;
}): Invoice["status"] => {
  if (row.processingStalled) return "failed";
  if (
    row.status === "new" ||
    row.status === "processing" ||
    row.status === "analyzing"
  ) {
    return "processing";
  }
  return row.processingError || !row.extraction ? "failed" : "processed";
};

const sourceOf = (row: PublicInvoiceRow): Invoice["document"]["source"] => {
  if (
    row.referenceId?.startsWith("api:") ||
    row.referenceId?.startsWith("api-submission:")
  ) {
    return "api";
  }
  if (row.inboundEmailId) return "email";
  if (row.inboxAccountId) return "mailbox";
  return "upload";
};

const JUDGMENT_TYPES = new Set(["boolean", "choice", "score", "number"]);
const JUDGMENT_STATUSES = new Set([
  "answered",
  "unknown",
  "not_applicable",
  "failed",
]);

/** A stored judgment in the contract's shape; older records are tolerated. */
export const toJudgment = (value: unknown): Judgment => {
  const raw = record(value);
  const answer =
    typeof raw.answer === "boolean" ||
    typeof raw.answer === "string" ||
    (typeof raw.answer === "number" && Number.isFinite(raw.answer))
      ? raw.answer
      : null;
  const type =
    typeof raw.type === "string" && JUDGMENT_TYPES.has(raw.type)
      ? (raw.type as Judgment["type"])
      : typeof answer === "boolean"
        ? "boolean"
        : null;
  const status =
    typeof raw.status === "string" && JUDGMENT_STATUSES.has(raw.status)
      ? (raw.status as Judgment["status"])
      : answer === null
        ? "unknown"
        : "answered";
  const evaluator = record(raw.evaluator);
  return {
    questionKey: text(raw.questionId) ?? text(raw.questionKey) ?? "",
    questionVersion: num(raw.questionVersion),
    questionVersionId: text(raw.questionVersionId),
    label: text(raw.label) ?? text(raw.questionId) ?? "",
    question: text(raw.question),
    type,
    status,
    answer: status === "answered" ? answer : null,
    probability: num(raw.probability),
    confidence: num(raw.confidence),
    certainty: text(raw.certainty),
    currency: text(raw.currency),
    reason: text(raw.reason) ?? text(raw.error),
    source:
      raw.source === "default" || raw.source === "custom" ? raw.source : null,
    evaluator:
      typeof evaluator.version === "string"
        ? { model: text(evaluator.model), version: evaluator.version }
        : null,
    answeredAt: text(raw.answeredAt),
    runId: text(raw.runId),
  };
};

export const toInvoice = (row: PublicInvoiceRow): Invoice => {
  const extraction = row.extraction ? record(row.extraction) : null;
  const source = sourceOf(row);
  return {
    id: row.id,
    revision: row.processingRevision,
    status: statusOf(row),
    createdAt: isoTimestamp(row.createdAt),
    document: {
      fileName: row.fileName,
      displayName: row.displayName,
      contentType: row.contentType,
      size: row.size,
      sha256: row.contentHash,
      source,
      idempotencyKey: row.referenceId?.startsWith("api:")
        ? row.referenceId.slice(4)
        : null,
    },
    supplierId: row.supplierId,
    supplierName: text(extraction?.supplierName),
    invoiceNumber: text(extraction?.invoiceNumber),
    invoiceDate: text(extraction?.invoiceDate),
    dueDate: text(extraction?.dueDate),
    currency: row.currency ?? text(extraction?.currency),
    amount: row.amount ?? num(extraction?.grossAmount),
    processingError: row.processingError,
    corrected: (row.correctionCount ?? 0) > 0,
    extraction,
    validation: row.validation ? record(row.validation) : null,
    supplierChecks: row.supplierChecks ? record(row.supplierChecks) : null,
    judgments: (row.judgments ?? []).map(toJudgment),
    questionRerun: row.judgmentsRerunStatus
      ? { status: row.judgmentsRerunStatus, error: row.judgmentsRerunError }
      : null,
    delivery: row.delivery,
    accounting: row.accountingPostStatus
      ? {
          provider: row.accountingProvider,
          status: row.accountingPostStatus,
          providerId: row.accountingProviderId,
        }
      : null,
  };
};

// ---------------------------------------------------------------------------
// CSV exports
// ---------------------------------------------------------------------------

const answerCell = (judgment: Judgment) =>
  judgment.status === "answered" ? judgment.answer : judgment.status;

export const invoicesCsv = (invoices: Invoice[], questionKeys: string[]) => {
  const headers = [
    "invoice_id",
    "revision",
    "status",
    "created_at",
    "source",
    "idempotency_key",
    "sha256",
    "file_name",
    "supplier_id",
    "supplier_name",
    "supplier_vat_number",
    "invoice_number",
    "invoice_date",
    "due_date",
    "document_type",
    "currency",
    "net_amount",
    "vat_amount",
    "gross_amount",
    "validation_status",
    "accounting_ready",
    "validation_issues",
    "delivery_state",
    "accounting_provider",
    "accounting_status",
    "accounting_provider_id",
    "corrected",
    "processing_error",
    ...questionKeys.map((key) => `question:${key}`),
  ];
  const rows = invoices.map((invoice) => {
    const extraction = invoice.extraction ?? {};
    const validation = invoice.validation ?? {};
    const accounting = record(validation.accounting);
    const issues = Array.isArray(validation.issues)
      ? validation.issues.map((issue) => record(issue).message).join(" | ")
      : null;
    const answers = new Map(
      invoice.judgments.map((judgment) => [judgment.questionKey, judgment]),
    );
    return [
      invoice.id,
      invoice.revision,
      invoice.status,
      invoice.createdAt,
      invoice.document.source,
      invoice.document.idempotencyKey,
      invoice.document.sha256,
      invoice.document.fileName,
      invoice.supplierId,
      invoice.supplierName,
      extraction.supplierVatNumber,
      invoice.invoiceNumber,
      invoice.invoiceDate,
      invoice.dueDate,
      validation.documentType ?? extraction.documentType,
      invoice.currency,
      extraction.netAmount,
      extraction.vatAmount,
      extraction.grossAmount ?? invoice.amount,
      validation.status,
      typeof accounting.ready === "boolean" ? accounting.ready : null,
      issues,
      invoice.delivery.state,
      invoice.accounting?.provider,
      invoice.accounting?.status,
      invoice.accounting?.providerId,
      invoice.corrected,
      invoice.processingError,
      ...questionKeys.map((key) => {
        const judgment = answers.get(key);
        return judgment ? answerCell(judgment) : null;
      }),
    ];
  });
  return csvDocument(headers, rows);
};

const JUDGMENT_HEADERS = [
  "invoice_id",
  "invoice_revision",
  "entry",
  "run_id",
  "recorded_at",
  "question_key",
  "question_version",
  "question_version_id",
  "label",
  "type",
  "status",
  "answer",
  "probability",
  "confidence",
  "certainty",
  "currency",
  "reason",
  "evaluator_model",
  "evaluator_version",
  "previous_status",
  "previous_answer",
] as const;

const judgmentCells = (judgment: Judgment) => [
  judgment.questionKey,
  judgment.questionVersion,
  judgment.questionVersionId,
  judgment.label,
  judgment.type,
  judgment.status,
  judgment.answer,
  judgment.probability,
  judgment.confidence,
  judgment.certainty,
  judgment.currency,
  judgment.reason,
  judgment.evaluator?.model,
  judgment.evaluator?.version,
];

/**
 * One row per current answer (`entry` = `current`) and per answer a
 * deliberate rerun recorded (`entry` = `rerun`, with the answer it replaced),
 * so the question revision and evaluator behind every answer are kept.
 */
export const judgmentsCsv = (invoices: Invoice[], history: HistoryRows) => {
  const byInvoice = new Map<string, HistoryRows>();
  for (const entry of history) {
    byInvoice.set(entry.invoiceId, [
      ...(byInvoice.get(entry.invoiceId) ?? []),
      entry,
    ]);
  }
  const rows = invoices.flatMap((invoice) => [
    ...invoice.judgments.map((judgment) => [
      invoice.id,
      invoice.revision,
      "current",
      judgment.runId,
      judgment.answeredAt,
      ...judgmentCells(judgment),
      null,
      null,
    ]),
    ...(byInvoice.get(invoice.id) ?? []).map((entry) => {
      const answer = toJudgment(entry.judgment);
      const previous = entry.previous ? toJudgment(entry.previous) : null;
      return [
        invoice.id,
        entry.invoiceRevision,
        "rerun",
        entry.runId,
        isoTimestamp(entry.createdAt),
        ...judgmentCells({
          ...answer,
          questionKey: entry.questionKey,
          questionVersion: entry.questionVersion ?? answer.questionVersion,
          questionVersionId: entry.questionVersionId,
        }),
        previous?.status,
        previous ? previous.answer : null,
      ];
    }),
  ]);
  return csvDocument(JUDGMENT_HEADERS, rows);
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export type CsvPage = { csv: string; nextCursor: string | null };

export type SubmitRequest = {
  bytes: Uint8Array;
  fileName: string;
  declaredMimeType: string;
  idempotencyKey: string | null;
};

type SubmitError =
  | ApiBadRequest
  | ApiConflict
  | ApiPayloadTooLarge
  | ApiTooManyRequests
  | ApiUnavailable
  | ApiInternal;

export class PublicInvoices extends Context.Tag("invoicewise/PublicInvoices")<
  PublicInvoices,
  {
    readonly list: (
      query: ListQuery,
    ) => Effect.Effect<InvoiceList, ApiBadRequest | ApiInternal, Caller>;
    readonly get: (
      id: string,
    ) => Effect.Effect<Invoice, ApiNotFound | ApiInternal, Caller>;
    readonly judgments: (
      id: string,
    ) => Effect.Effect<InvoiceJudgments, ApiNotFound | ApiInternal, Caller>;
    readonly delivery: (
      id: string,
    ) => Effect.Effect<InvoiceDelivery, ApiNotFound | ApiInternal, Caller>;
    readonly document: (
      id: string,
    ) => Effect.Effect<DocumentLink, ApiNotFound | ApiInternal, Caller>;
    readonly submit: (
      input: SubmitRequest,
    ) => Effect.Effect<Submission, SubmitError, Caller>;
    readonly reextract: (
      id: string,
      revision: number,
    ) => Effect.Effect<ActionAccepted, ActionError, Caller>;
    readonly rerunQuestions: (
      id: string,
      revision: number,
    ) => Effect.Effect<ActionAccepted, ActionError, Caller>;
    readonly retryDelivery: (
      id: string,
      revision: number,
    ) => Effect.Effect<DeliveryRetry, ActionError, Caller>;
    readonly exportInvoices: (
      query: ExportQuery,
    ) => Effect.Effect<CsvPage, ApiBadRequest | ApiInternal, Caller>;
    readonly exportJudgments: (
      query: ExportQuery,
    ) => Effect.Effect<CsvPage, ApiBadRequest | ApiInternal, Caller>;
  }
>() {}

/** An idempotency key: 1-255 visible ASCII characters. */
export const isValidIdempotencyKey = (key: string) =>
  /^[\x21-\x7E]{1,255}$/.test(key);

type ActionError = ApiNotFound | ApiConflict | ApiForbidden | ApiInternal;

/** A refused invoice action, as the contract reports it. */
const actionError =
  (label: string) =>
  (error: unknown): ActionError => {
    if (error instanceof InvoiceActionError) {
      switch (error.code) {
        case "not_found":
          return notFound();
        case "conflict":
          return new ApiConflict({
            error: { code: "conflict", message: error.message },
          });
        case "invalid":
          return new ApiConflict({
            error: { code: "not_extracted", message: error.message },
          });
        case "forbidden":
          return new ApiForbidden({
            error: { code: "admin_required", message: error.message },
          });
      }
    }
    logger.error(
      { err: error instanceof Error ? error.message : String(error) },
      `public API: unable to ${label}`,
    );
    return internal(`Unable to ${label}`);
  };

const INTAKE_STATUS_ERROR = (
  result: Extract<IntakeUploadResult, { status: "rejected" }>,
): SubmitError => {
  const error = { code: result.code, message: result.message };
  switch (result.code) {
    case "too_large":
    case "image_too_large":
      return new ApiPayloadTooLarge({ error });
    case "queue_full":
      return new ApiTooManyRequests({ error });
    case "storage_unavailable":
    case "temporarily_unavailable":
      return new ApiUnavailable({ error });
    case "reference_conflict":
      return new ApiConflict({
        error: {
          code: "idempotency_key_reused",
          message:
            "This Idempotency-Key was already used for a different document in this workspace.",
        },
      });
    case "superseded":
      return new ApiConflict({ error });
    case "malformed_binding":
      return internal(result.message);
    default:
      return new ApiBadRequest({ error });
  }
};

export const PublicInvoicesLayer = Layer.effect(
  PublicInvoices,
  Effect.gen(function* () {
    const store = yield* PublicApiStore;
    const run = <A>(label: string, action: () => Promise<A>) =>
      Effect.tryPromise({
        try: action,
        catch: (error) => {
          logger.error(
            { err: error instanceof Error ? error.message : String(error) },
            `public API: unable to ${label}`,
          );
          return internal(`Unable to ${label}`);
        },
      });

    const invoice = (id: string) =>
      Effect.gen(function* () {
        const caller = yield* Caller;
        const row = yield* run("read the invoice", () =>
          store.get(caller.teamId, id),
        );
        if (!row) return yield* Effect.fail(notFound());
        return toInvoice(row);
      });

    const page = (query: ListQuery | ExportQuery) =>
      Effect.gen(function* () {
        const caller = yield* Caller;
        const cursor = yield* decodeCursor(query.cursor, query.order);
        const result = yield* run("read invoices", () =>
          store.list({
            teamId: caller.teamId,
            cursor,
            order: query.order,
            limit: query.limit,
            status: query.status,
            state: query.state,
            q: query.q,
            supplierId: query.supplierId,
            createdFrom: query.createdFrom,
            createdTo: query.createdTo,
          }),
        );
        return {
          invoices: result.data.map(toInvoice),
          nextCursor: result.next
            ? encodeCursor(query.order, result.next)
            : null,
        };
      });

    const act = <A>(label: string, action: (teamId: string) => Promise<A>) =>
      Effect.flatMap(Caller, (caller) =>
        Effect.tryPromise({
          try: () => action(caller.teamId),
          catch: actionError(label),
        }),
      );

    return PublicInvoices.of({
      list: (query) =>
        page(query).pipe(
          Effect.map(({ invoices, nextCursor }) => ({
            data: invoices,
            hasMore: nextCursor !== null,
            nextCursor,
          })),
        ),

      get: invoice,

      judgments: (id) =>
        Effect.gen(function* () {
          const caller = yield* Caller;
          const current = yield* invoice(id);
          const history = yield* run("read question history", () =>
            store.history(caller.teamId, [current.id]),
          );
          return {
            invoiceId: current.id,
            revision: current.revision,
            judgments: current.judgments,
            history: history.map((entry) => {
              const answer = toJudgment(entry.judgment);
              return {
                id: entry.id,
                runId: entry.runId,
                questionKey: entry.questionKey,
                questionVersion: entry.questionVersion,
                questionVersionId: entry.questionVersionId,
                invoiceRevision: entry.invoiceRevision,
                recordedAt: isoTimestamp(entry.createdAt),
                answer: {
                  ...answer,
                  questionKey: entry.questionKey,
                  questionVersionId: entry.questionVersionId,
                  questionVersion:
                    entry.questionVersion ?? answer.questionVersion,
                },
                previous: entry.previous ? toJudgment(entry.previous) : null,
              };
            }),
          };
        }),

      delivery: (id) =>
        Effect.gen(function* () {
          const caller = yield* Caller;
          const current = yield* invoice(id);
          const status = yield* run("read delivery status", () =>
            store.deliveryStatus(caller.teamId, current.id),
          );
          return {
            invoiceId: current.id,
            revision: current.revision,
            state: current.delivery.state,
            webhooks: status.webhooks.map((delivery) => ({
              id: delivery.id,
              endpointId: delivery.endpointId,
              endpointUrl: delivery.endpointUrl,
              event: delivery.event,
              eventId: delivery.eventId,
              revision: delivery.revision,
              status: delivery.status,
              attempts: delivery.attempts,
              lastError: delivery.lastError,
              retryable: delivery.retryable,
              deliveredAt: isoOrNull(delivery.deliveredAt),
              createdAt: isoTimestamp(delivery.createdAt),
            })),
            accounting: status.accounting?.status
              ? {
                  provider: status.accounting.provider,
                  status: status.accounting.status,
                  providerId: status.accounting.providerId,
                  lastError: status.accounting.lastError,
                  retryable: status.accounting.retryable,
                  revision: status.accounting.revision,
                  postedAt: isoOrNull(status.accounting.postedAt),
                }
              : null,
          };
        }),

      document: (id) =>
        Effect.gen(function* () {
          const caller = yield* Caller;
          const signed = yield* run("sign the document link", () =>
            store.documentUrl(caller.teamId, id),
          );
          if (!signed) return yield* Effect.fail(notFound());
          const now = yield* Effect.clockWith(
            (clock) => clock.currentTimeMillis,
          );
          return {
            url: signed.url,
            fileName: signed.fileName,
            expiresAt: new Date(
              now + DOCUMENT_URL_TTL_SECONDS * 1000,
            ).toISOString(),
          };
        }),

      submit: (input) =>
        Effect.gen(function* () {
          const caller = yield* Caller;
          if (input.idempotencyKey !== null) {
            if (!isValidIdempotencyKey(input.idempotencyKey)) {
              return yield* Effect.fail(
                badRequest(
                  "invalid_idempotency_key",
                  "Idempotency-Key must be 1-255 visible ASCII characters.",
                ),
              );
            }
            // A key already used for other bytes is refused before any
            // work; the same bytes replay the invoice the key names.
            const key = input.idempotencyKey;
            const owner = yield* run("check the idempotency key", () =>
              store.referenceOwner(caller.teamId, idempotencyReference(key)),
            );
            if (owner && owner.contentHash !== intakeContentHash(input.bytes)) {
              return yield* Effect.fail(
                INTAKE_STATUS_ERROR({
                  status: "rejected",
                  code: "reference_conflict",
                  message: "",
                }),
              );
            }
          }
          const result = yield* run("accept the document", () =>
            store.submit({ ...input, teamId: caller.teamId }),
          );
          if (result.status === "rejected") {
            return yield* Effect.fail(INTAKE_STATUS_ERROR(result));
          }
          const current = yield* run("read the invoice", () =>
            store.get(caller.teamId, result.inboxId),
          );
          return {
            id: result.inboxId,
            status: current ? statusOf(current) : "processing",
            revision: current?.processingRevision ?? 0,
            deduplicated: result.deduplicated,
            fileName: result.fileName,
            contentType: result.mimeType,
            size: result.size,
            sha256: intakeContentHash(input.bytes),
            links: { invoice: `/v1/invoices/${result.inboxId}` },
          };
        }),

      reextract: (id, revision) =>
        Effect.gen(function* () {
          const result = yield* act("re-extract the invoice", (teamId) =>
            store.reextract(teamId, id, revision),
          );
          if (!result) return yield* Effect.fail(notFound());
          return {
            id,
            action: "reextract" as const,
            revision,
            deduplicated: result.deduplicated,
          };
        }),

      rerunQuestions: (id, revision) =>
        act("rerun the questions", (teamId) =>
          store.rerunQuestions(teamId, id, revision),
        ).pipe(
          Effect.map((result) => ({
            id,
            action: "rerun_questions" as const,
            revision: result.revision,
            deduplicated: result.deduplicated,
          })),
        ),

      retryDelivery: (id, revision) =>
        Effect.gen(function* () {
          const caller = yield* Caller;
          const result = yield* act("retry the delivery", (teamId) =>
            store.retryDelivery({ teamId, id, role: caller.role, revision }),
          );
          if (!result) return yield* Effect.fail(notFound());
          return {
            id: result.invoiceId,
            revision: result.revision,
            started:
              result.webhooks.requeued > 0 ||
              result.accounting === "requeued" ||
              result.billUpdate === "requeued",
            webhooks: result.webhooks,
            accounting: result.accounting,
            billUpdate: result.billUpdate,
          };
        }),

      exportInvoices: (query) =>
        Effect.gen(function* () {
          const caller = yield* Caller;
          const { invoices, nextCursor } = yield* page(query);
          const keys = yield* run("read the workspace questions", () =>
            store.questionKeys(caller.teamId),
          );
          return { csv: invoicesCsv(invoices, keys), nextCursor };
        }),

      exportJudgments: (query) =>
        Effect.gen(function* () {
          const caller = yield* Caller;
          const { invoices, nextCursor } = yield* page(query);
          const history = yield* run("read question history", () =>
            store.history(
              caller.teamId,
              invoices.map((invoice) => invoice.id),
            ),
          );
          return { csv: judgmentsCsv(invoices, history), nextCursor };
        }),
    });
  }),
);

export const PublicInvoicesLive = PublicInvoicesLayer.pipe(
  Layer.provide(PublicApiStoreLive),
);
