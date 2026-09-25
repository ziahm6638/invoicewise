import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
  OpenApi,
} from "@effect/platform";
import { Effect, Layer, Schema } from "effect";
import { MAX_INTAKE_REQUEST_BYTES, readBoundedFormData } from "../intake/http";
import {
  API_VERSION,
  ActionAccepted,
  ApiBadRequest,
  ApiConflict,
  type ApiError,
  ApiForbidden,
  ApiInternal,
  ApiNotFound,
  ApiPayloadTooLarge,
  ApiTooManyRequests,
  ApiUnauthorized,
  ApiUnavailable,
  Caller,
  DeliveryRetry,
  DocumentLink,
  ExportQuery,
  Invoice,
  InvoiceDelivery,
  InvoiceJudgments,
  InvoiceList,
  ListQuery,
  PublicInvoices,
  PublicInvoicesLive,
  RevisionBody,
  Submission,
  errorStatus,
} from "./public-api";

/**
 * Headers the Hono layer sets after it authenticated the request. They are
 * overwritten on every forwarded request, so a client cannot supply them.
 */
export const TRUSTED_CALLER_HEADERS = {
  teamId: "x-invoicewise-team-id",
  userId: "x-invoicewise-user-id",
  role: "x-invoicewise-team-role",
} as const;

/** Resolves the authenticated caller for every v1 endpoint. */
export class Authenticated extends HttpApiMiddleware.Tag<Authenticated>()(
  "Authenticated",
  { provides: Caller, failure: ApiUnauthorized },
) {}

const AuthenticatedLive = Layer.succeed(
  Authenticated,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const teamId = request.headers[TRUSTED_CALLER_HEADERS.teamId];
    const userId = request.headers[TRUSTED_CALLER_HEADERS.userId];
    const role = request.headers[TRUSTED_CALLER_HEADERS.role];
    if (
      !teamId ||
      !userId ||
      (role !== "owner" && role !== "admin" && role !== "member")
    ) {
      return yield* Effect.fail(
        new ApiUnauthorized({
          error: { code: "unauthorized", message: "Authentication required" },
        }),
      );
    }
    return { teamId, userId, role };
  }),
);

const InvoicePath = Schema.Struct({ id: Schema.UUID });

const IdempotencyHeaders = Schema.Struct({
  "idempotency-key": Schema.optional(Schema.String).annotations({
    description:
      "Optional client key (1-255 visible ASCII characters). Repeating a request with the same key and bytes returns the same invoice; the same key with different bytes is refused with 409 `idempotency_key_reused`.",
  }),
});

const UploadForm = HttpApiSchema.Multipart(
  Schema.Struct({
    file: Schema.String.annotations({
      description:
        "The document: PDF (text or scanned), PNG or JPEG, at most 5 MB. See docs/document-intake.md#supported-inputs.",
      jsonSchema: { type: "string", format: "binary" },
    }),
  }),
);

const Csv = HttpApiSchema.Text({ contentType: "text/csv; charset=utf-8" });

const invoices = HttpApiGroup.make("invoices")
  .add(
    HttpApiEndpoint.post("submit", "/invoices")
      .setHeaders(IdempotencyHeaders)
      .setPayload(UploadForm)
      .addSuccess(Submission, { status: 202 })
      .addError(ApiBadRequest)
      .addError(ApiConflict)
      .addError(ApiPayloadTooLarge)
      .addError(ApiTooManyRequests)
      .addError(ApiUnavailable)
      .annotate(OpenApi.Summary, "Submit a document")
      .annotate(
        OpenApi.Description,
        "Accepts one document as multipart/form-data (`file`) and queues it for processing. Validation, storage and processing are the dashboard's own intake. Poll `GET /v1/invoices/{id}` until `status` is no longer `processing`.",
      ),
  )
  .add(
    HttpApiEndpoint.get("list", "/invoices")
      .setUrlParams(ListQuery)
      .addSuccess(InvoiceList)
      .addError(ApiBadRequest)
      .annotate(OpenApi.Summary, "List invoices"),
  )
  .add(
    HttpApiEndpoint.get("get", "/invoices/:id")
      .setPath(InvoicePath)
      .addSuccess(Invoice)
      .addError(ApiNotFound)
      .annotate(OpenApi.Summary, "Get an invoice and its processing status"),
  )
  .add(
    HttpApiEndpoint.get("judgments", "/invoices/:id/judgments")
      .setPath(InvoicePath)
      .addSuccess(InvoiceJudgments)
      .addError(ApiNotFound)
      .annotate(OpenApi.Summary, "Get judgments with their rerun history"),
  )
  .add(
    HttpApiEndpoint.get("delivery", "/invoices/:id/delivery")
      .setPath(InvoicePath)
      .addSuccess(InvoiceDelivery)
      .addError(ApiNotFound)
      .annotate(OpenApi.Summary, "Get webhook and accounting delivery"),
  )
  .add(
    HttpApiEndpoint.get("document", "/invoices/:id/document")
      .setPath(InvoicePath)
      .addSuccess(DocumentLink)
      .addError(ApiNotFound)
      .annotate(OpenApi.Summary, "Get a 60-second signed link to the document"),
  )
  .add(
    HttpApiEndpoint.post("reextract", "/invoices/:id/reextract")
      .setPath(InvoicePath)
      .setPayload(RevisionBody)
      .addSuccess(ActionAccepted, { status: 202 })
      .addError(ApiNotFound)
      .addError(ApiConflict)
      .annotate(OpenApi.Summary, "Read the stored document again")
      .annotate(
        OpenApi.Description,
        "Queues a new reading of the stored document for the revision you read. Concurrent requests share one job. Creates a new revision; a posted bill is never posted again.",
      ),
  )
  .add(
    HttpApiEndpoint.post("rerunQuestions", "/invoices/:id/questions/rerun")
      .setPath(InvoicePath)
      .setPayload(RevisionBody)
      .addSuccess(ActionAccepted, { status: 202 })
      .addError(ApiNotFound)
      .addError(ApiConflict)
      .annotate(OpenApi.Summary, "Answer the workspace's questions again")
      .annotate(
        OpenApi.Description,
        "Changes only judgments: no new revision and no accounting post. Each recorded answer is announced once as `invoice.judgments.attached`.",
      ),
  )
  .add(
    HttpApiEndpoint.post("retryDelivery", "/invoices/:id/delivery/retry")
      .setPath(InvoicePath)
      .setPayload(RevisionBody)
      .addSuccess(DeliveryRetry)
      .addError(ApiNotFound)
      .addError(ApiConflict)
      .annotate(OpenApi.Summary, "Retry failed delivery of the revision")
      .annotate(
        OpenApi.Description,
        "Re-drives the failed or cancelled destinations of the current revision with the same delivery rows and event ids, so nothing is delivered twice under a new id. Re-posting to accounting needs an owner or admin key and is otherwise reported as `admin_required`.",
      ),
  );

const exportsGroup = HttpApiGroup.make("exports")
  .add(
    HttpApiEndpoint.get("invoices", "/exports/invoices.csv")
      .setUrlParams(ExportQuery)
      .addSuccess(Csv)
      .addError(ApiBadRequest)
      .annotate(OpenApi.Summary, "Export invoices as CSV, one page per call")
      .annotate(
        OpenApi.Description,
        'One row per invoice with identifiers, revision, currency, amounts, validation, delivery and a `question:<key>` column per workspace question. When more rows follow, the response has an `X-Next-Cursor` header and a `Link: <...>; rel="next"` header. Text that a spreadsheet would run as a formula is prefixed with `\'`.',
      ),
  )
  .add(
    HttpApiEndpoint.get("judgments", "/exports/judgments.csv")
      .setUrlParams(ExportQuery)
      .addSuccess(Csv)
      .addError(ApiBadRequest)
      .annotate(OpenApi.Summary, "Export judgments and their history as CSV")
      .annotate(
        OpenApi.Description,
        "One row per current answer (`entry=current`) and per answer a rerun recorded (`entry=rerun`, with the answer it replaced), with the question revision and evaluator. Paged by invoice like the invoice export.",
      ),
  );

/**
 * Request-decoding failures reach clients as the contract's own 400 body
 * (`invalid_request`, rewritten in `rest/v1.ts`), so the published document
 * describes every 400 as `BadRequest` and drops Effect's internal shape.
 */
const uniformBadRequest = (spec: Record<string, any>): Record<string, any> => {
  const paths: Record<string, any> = {};
  for (const [path, operations] of Object.entries(spec.paths ?? {})) {
    paths[path] = {};
    for (const [method, operation] of Object.entries(
      operations as Record<string, any>,
    )) {
      const responses = { ...operation.responses };
      if (responses["400"]) {
        responses["400"] = {
          description:
            "The request is invalid: `invalid_request`, `invalid_cursor`, `invalid_idempotency_key`, `malformed` or an intake refusal code.",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/BadRequest" },
            },
          },
        };
      }
      paths[path][method] = { ...operation, responses };
    }
  }
  const {
    HttpApiDecodeError: _decode,
    Issue: _issue,
    PropertyKey: _key,
    ...schemas
  } = spec.components?.schemas ?? {};
  return { ...spec, paths, components: { ...spec.components, schemas } };
};

export class PublicApiV1 extends HttpApi.make("invoicewise-v1")
  .add(invoices)
  .add(exportsGroup)
  .middleware(Authenticated)
  .addError(ApiUnauthorized)
  .addError(ApiForbidden)
  .addError(ApiTooManyRequests)
  .addError(ApiInternal)
  .prefix("/v1")
  .annotateContext(
    OpenApi.annotations({
      title: "InvoiceWise API",
      version: `${API_VERSION}.0.0`,
      description:
        'Versioned InvoiceWise API. Authenticate with an API key as a bearer token. Errors are `{"error":{"code","message"}}`. Guide: https://github.com/ziahm6638/invoicewise/blob/main/docs/api.md',
      servers: [
        { url: "https://api.invoicewise.uk", description: "Production" },
      ],
      transform: (spec) => ({
        ...uniformBadRequest(spec),
        components: {
          ...uniformBadRequest(spec).components,
          securitySchemes: {
            ...spec.components?.securitySchemes,
            apiKey: {
              type: "http",
              scheme: "bearer",
              description:
                "An InvoiceWise API key (`mid_...`) from Settings → Developer, or an OAuth access token.",
            },
          },
        },
        security: [{ apiKey: [] }],
      }),
    }),
  ) {}

/** The published v1 contract (OpenAPI 3.1). */
export const publicApiContract = () => OpenApi.fromApi(PublicApiV1);

const csvResponse = (
  request: HttpServerRequest.HttpServerRequest,
  page: { csv: string; nextCursor: string | null },
  name: string,
) => {
  const headers: Record<string, string> = {
    "content-disposition": `attachment; filename="${name}"`,
  };
  if (page.nextCursor) {
    const next = new URL(request.url, "http://localhost");
    next.searchParams.set("cursor", page.nextCursor);
    headers["x-next-cursor"] = page.nextCursor;
    headers.link = `<${next.pathname}${next.search}>; rel="next"`;
  }
  return HttpServerResponse.text(page.csv, {
    contentType: "text/csv; charset=utf-8",
    headers,
  });
};

const errorResponse = (
  error: { error: { code: string; message: string } },
  status: number,
  headers: Record<string, string> = {},
) => HttpServerResponse.unsafeJson({ error: error.error }, { status, headers });

/**
 * The multipart body is read here, before any parsing, with the same byte
 * bound and parser as the dashboard's upload route.
 */
const submitHandler = (
  service: typeof PublicInvoices.Service,
  request: HttpServerRequest.HttpServerRequest,
) =>
  Effect.gen(function* () {
    const web = yield* HttpServerRequest.toWeb(request).pipe(
      Effect.orElseSucceed(() => null),
    );
    const invalid = (code: string, message: string, status = 400) =>
      errorResponse({ error: { code, message } }, status, {
        connection: "close",
      });
    if (!web) return invalid("malformed", "Invalid upload");
    const parsed = yield* Effect.promise(() =>
      readBoundedFormData(web, MAX_INTAKE_REQUEST_BYTES),
    );
    if (!parsed.ok) {
      return invalid(
        parsed.code,
        parsed.message,
        parsed.code === "too_large" ? 413 : 400,
      );
    }
    const file = parsed.formData.get("file");
    if (
      typeof file !== "object" ||
      file === null ||
      typeof (file as Blob).arrayBuffer !== "function"
    ) {
      return errorResponse(
        {
          error: {
            code: "malformed",
            message: "Send the document as the multipart field `file`.",
          },
        },
        400,
      );
    }
    const upload = file as File;
    const bytes = new Uint8Array(
      yield* Effect.promise(() => upload.arrayBuffer()),
    );
    return yield* service
      .submit({
        bytes,
        fileName: upload.name ?? "invoice",
        declaredMimeType: upload.type ?? "",
        idempotencyKey: request.headers["idempotency-key"] ?? null,
      })
      .pipe(
        Effect.map((submission) =>
          HttpServerResponse.unsafeJson(submission, {
            status: 202,
            headers: { location: submission.links.invoice },
          }),
        ),
        respond,
      );
  });

/** Renders a contract error with its own status and headers. */
const respond = <A, E extends ApiError, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.catchAll(effect, (error: ApiError) =>
    Effect.succeed(
      errorResponse(
        error,
        errorStatus(error),
        error instanceof ApiTooManyRequests ? { "retry-after": "120" } : {},
      ),
    ),
  );

const InvoicesHandlers = HttpApiBuilder.group(
  PublicApiV1,
  "invoices",
  (handlers) =>
    Effect.gen(function* () {
      const service = yield* PublicInvoices;
      return handlers
        .handleRaw("submit", ({ request }) => submitHandler(service, request))
        .handle("list", ({ urlParams }) => respond(service.list(urlParams)))
        .handle("get", ({ path }) => respond(service.get(path.id)))
        .handle("judgments", ({ path }) => respond(service.judgments(path.id)))
        .handle("delivery", ({ path }) => respond(service.delivery(path.id)))
        .handle("document", ({ path }) => respond(service.document(path.id)))
        .handle("reextract", ({ path, payload }) =>
          respond(service.reextract(path.id, payload.revision)),
        )
        .handle("rerunQuestions", ({ path, payload }) =>
          respond(service.rerunQuestions(path.id, payload.revision)),
        )
        .handle("retryDelivery", ({ path, payload }) =>
          respond(service.retryDelivery(path.id, payload.revision)),
        );
    }),
);

const ExportsHandlers = HttpApiBuilder.group(
  PublicApiV1,
  "exports",
  (handlers) =>
    Effect.gen(function* () {
      const service = yield* PublicInvoices;
      return handlers
        .handle("invoices", ({ request, urlParams }) =>
          respond(
            service
              .exportInvoices(urlParams)
              .pipe(
                Effect.map((page) =>
                  csvResponse(request, page, "invoicewise-invoices.csv"),
                ),
              ),
          ),
        )
        .handle("judgments", ({ request, urlParams }) =>
          respond(
            service
              .exportJudgments(urlParams)
              .pipe(
                Effect.map((page) =>
                  csvResponse(request, page, "invoicewise-judgments.csv"),
                ),
              ),
          ),
        );
    }),
);

export function makePublicApiHandler(
  serviceLayer: Layer.Layer<PublicInvoices, unknown, never>,
) {
  const handlers = Layer.mergeAll(InvoicesHandlers, ExportsHandlers).pipe(
    Layer.provide(serviceLayer),
  );
  const api = HttpApiBuilder.api(PublicApiV1).pipe(
    Layer.provide(handlers),
    Layer.provide(AuthenticatedLive),
  );
  return HttpApiBuilder.toWebHandler(
    Layer.mergeAll(api, HttpServer.layerContext),
  );
}

export const publicApiHttp = makePublicApiHandler(PublicInvoicesLive);
