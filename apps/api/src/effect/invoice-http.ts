import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
  HttpServer,
} from "@effect/platform";
import { Effect, Layer } from "effect";
import {
  AttachmentQuery,
  AttachmentUnavailable,
  AttachmentUrl,
  DeliveryStatus,
  InvoiceDetail,
  InvoiceHeaders,
  InvoiceItem,
  InvoiceListQuery,
  InvoiceNotFound,
  InvoicePage,
  InvoicePath,
  InvoiceRead,
  InvoiceReadError,
  InvoiceReadLive,
} from "./invoice-read";

const invoiceReadGroup = HttpApiGroup.make("invoiceRead")
  .add(
    HttpApiEndpoint.get("list", "/inbox")
      .setHeaders(InvoiceHeaders)
      .setUrlParams(InvoiceListQuery)
      .addSuccess(InvoicePage)
      .addError(InvoiceReadError, { status: 500 }),
  )
  .add(
    HttpApiEndpoint.get("findById", "/inbox/:id")
      .setHeaders(InvoiceHeaders)
      .setPath(InvoicePath)
      .addSuccess(InvoiceItem)
      .addError(InvoiceNotFound, { status: 404 })
      .addError(InvoiceReadError, { status: 500 }),
  )
  .add(
    HttpApiEndpoint.post("attachmentUrl", "/inbox/:id/presigned-url")
      .setHeaders(InvoiceHeaders)
      .setPath(InvoicePath)
      .setUrlParams(AttachmentQuery)
      .addSuccess(AttachmentUrl)
      .addError(AttachmentUnavailable, { status: 400 })
      .addError(InvoiceNotFound, { status: 404 })
      .addError(InvoiceReadError, { status: 500 }),
  )
  .add(
    HttpApiEndpoint.get("listInvoices", "/invoices")
      .setHeaders(InvoiceHeaders)
      .setUrlParams(InvoiceListQuery)
      .addSuccess(InvoicePage)
      .addError(InvoiceReadError, { status: 500 }),
  )
  .add(
    HttpApiEndpoint.get("exportInvoices", "/invoices/export.csv")
      .setHeaders(InvoiceHeaders)
      .addSuccess(
        HttpApiSchema.Text({ contentType: "text/csv; charset=utf-8" }),
      )
      .addError(InvoiceReadError, { status: 500 }),
  )
  .add(
    HttpApiEndpoint.get("invoiceDetail", "/invoices/:id")
      .setHeaders(InvoiceHeaders)
      .setPath(InvoicePath)
      .addSuccess(InvoiceDetail)
      .addError(InvoiceNotFound, { status: 404 })
      .addError(InvoiceReadError, { status: 500 }),
  )
  .add(
    HttpApiEndpoint.get(
      "invoiceDeliveryStatus",
      "/invoices/:id/delivery-status",
    )
      .setHeaders(InvoiceHeaders)
      .setPath(InvoicePath)
      .addSuccess(DeliveryStatus)
      .addError(InvoiceNotFound, { status: 404 })
      .addError(InvoiceReadError, { status: 500 }),
  );

export class InvoiceApi extends HttpApi.make("invoiceApi").add(
  invoiceReadGroup,
) {}

const InvoiceReadHandlers = HttpApiBuilder.group(
  InvoiceApi,
  "invoiceRead",
  (handlers) =>
    Effect.gen(function* () {
      const invoices = yield* InvoiceRead;
      return handlers
        .handle("list", ({ headers, urlParams }) =>
          invoices.list(
            headers["x-invoicewise-team-id"],
            urlParams,
            headers["x-invoicewise-source-details"],
          ),
        )
        .handle("findById", ({ headers, path }) =>
          invoices.findById(
            path.id,
            headers["x-invoicewise-team-id"],
            headers["x-invoicewise-source-details"],
          ),
        )
        .handle("attachmentUrl", ({ headers, path, urlParams }) =>
          invoices.attachmentUrl(
            path.id,
            headers["x-invoicewise-team-id"],
            urlParams.download,
          ),
        )
        .handle("listInvoices", ({ headers, urlParams }) =>
          invoices.list(
            headers["x-invoicewise-team-id"],
            urlParams,
            headers["x-invoicewise-source-details"],
          ),
        )
        .handle("exportInvoices", ({ headers }) =>
          invoices.exportCsv(headers["x-invoicewise-team-id"]),
        )
        .handle("invoiceDetail", ({ headers, path }) =>
          invoices.detail(
            path.id,
            headers["x-invoicewise-team-id"],
            headers["x-invoicewise-source-details"],
          ),
        )
        .handle("invoiceDeliveryStatus", ({ headers, path }) =>
          invoices.deliveryStatus(path.id, headers["x-invoicewise-team-id"]),
        );
    }),
);

export function makeInvoiceHttpHandler(
  invoiceReadLayer: Layer.Layer<InvoiceRead, unknown, never>,
) {
  const handlers = InvoiceReadHandlers.pipe(Layer.provide(invoiceReadLayer));
  const api = HttpApiBuilder.api(InvoiceApi).pipe(Layer.provide(handlers));

  return HttpApiBuilder.toWebHandler(
    Layer.mergeAll(api, HttpServer.layerContext),
  );
}

export const invoiceHttp = makeInvoiceHttpHandler(InvoiceReadLive);

/**
 * The request the invoice read slice answers for an authenticated caller: its
 * workspace, and full source-match details only when its credential holds
 * `sources.read` (client-sent values of either header are replaced).
 */
export const invoiceReadRequest = (
  request: Request,
  caller: { teamId: string; scopes: readonly string[] | undefined },
) => {
  const headers = new Headers(request.headers);
  headers.set("x-invoicewise-team-id", caller.teamId);
  headers.set(
    "x-invoicewise-source-details",
    caller.scopes?.includes("sources.read") ? "full" : "summary",
  );
  return new Request(request, { headers });
};
