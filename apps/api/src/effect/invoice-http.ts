import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpServer,
} from "@effect/platform";
import { Effect, Layer } from "effect";
import {
  AttachmentQuery,
  AttachmentUnavailable,
  AttachmentUrl,
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
          invoices.list(headers["x-invoicewise-team-id"], urlParams),
        )
        .handle("findById", ({ headers, path }) =>
          invoices.findById(path.id, headers["x-invoicewise-team-id"]),
        )
        .handle("attachmentUrl", ({ headers, path, urlParams }) =>
          invoices.attachmentUrl(
            path.id,
            headers["x-invoicewise-team-id"],
            urlParams.download,
          ),
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
