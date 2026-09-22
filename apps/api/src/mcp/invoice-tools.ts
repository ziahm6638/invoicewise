import { InvoiceDetail, InvoicePage } from "@api/effect/invoice-read";
import { Tool, Toolkit } from "@effect/ai";
import { Config, Context, Effect, Layer, Redacted, Schema } from "effect";

export class InvoiceMcpError extends Schema.TaggedError<InvoiceMcpError>()(
  "InvoiceMcpError",
  {
    status: Schema.Number,
    error: Schema.String,
  },
) {}

export const InvoiceJudgments = Schema.Struct({
  id: Schema.String,
  judgments: Schema.NullOr(Schema.Array(Schema.Unknown)),
});

export const ListInvoices = Tool.make("list_invoices", {
  description:
    "List processed invoices in the workspace authenticated by the configured InvoiceWise API key.",
  parameters: {
    cursor: Schema.optional(Schema.String),
    order: Schema.optional(Schema.String),
    sort: Schema.optional(Schema.String),
    pageSize: Schema.optional(
      Schema.Number.pipe(Schema.int(), Schema.between(1, 100)),
    ),
    q: Schema.optional(Schema.String),
    status: Schema.optional(Schema.Literal("done", "pending")),
  },
  success: InvoicePage,
  failure: InvoiceMcpError,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const GetInvoice = Tool.make("get_invoice", {
  description:
    "Get one invoice with its extraction, line items, judgments, and signed document link.",
  parameters: { id: Schema.String },
  success: InvoiceDetail,
  failure: InvoiceMcpError,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const GetInvoiceJudgments = Tool.make("get_invoice_judgments", {
  description:
    "Read only the judgments attached to an invoice in the authenticated workspace.",
  parameters: { id: Schema.String },
  success: InvoiceJudgments,
  failure: InvoiceMcpError,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const InvoiceMcpToolkit = Toolkit.make(
  ListInvoices,
  GetInvoice,
  GetInvoiceJudgments,
);

export class InvoiceMcpClient extends Context.Tag(
  "invoicewise/InvoiceMcpClient",
)<
  InvoiceMcpClient,
  {
    readonly list: (
      query: typeof ListInvoices.parametersSchema.Type,
    ) => Effect.Effect<typeof InvoicePage.Type, InvoiceMcpError>;
    readonly detail: (
      id: string,
    ) => Effect.Effect<typeof InvoiceDetail.Type, InvoiceMcpError>;
  }
>() {}

const requestJson = <A, I>(
  apiUrl: string,
  apiKey: Redacted.Redacted<string>,
  path: string,
  schema: Schema.Schema<A, I, never>,
) =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(new URL(path, apiUrl), {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${Redacted.value(apiKey)}`,
        },
      });
      if (!response.ok) {
        const body = await response.text();
        let message = body || response.statusText;
        try {
          const parsed = JSON.parse(body) as { error?: unknown };
          if (typeof parsed.error === "string") message = parsed.error;
        } catch {
          // The response body is useful as-is when it is not JSON.
        }
        throw new InvoiceMcpError({ status: response.status, error: message });
      }
      return response.json();
    },
    catch: (cause) =>
      cause instanceof InvoiceMcpError
        ? cause
        : new InvoiceMcpError({
            status: 503,
            error:
              cause instanceof Error ? cause.message : "API request failed",
          }),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknown(schema)),
    Effect.mapError((cause) =>
      cause instanceof InvoiceMcpError
        ? cause
        : new InvoiceMcpError({
            status: 502,
            error: "InvoiceWise returned an invalid response",
          }),
    ),
  );

export const InvoiceMcpClientLive = Layer.effect(
  InvoiceMcpClient,
  Config.all({
    apiUrl: Config.string("INVOICEWISE_API_URL").pipe(
      Config.withDefault("http://localhost:3003"),
    ),
    apiKey: Config.redacted("INVOICEWISE_API_KEY"),
  }).pipe(
    Effect.map(({ apiKey, apiUrl }) => ({
      list: (query: typeof ListInvoices.parametersSchema.Type) => {
        const search = new URLSearchParams();
        for (const [key, value] of Object.entries(query)) {
          if (value !== undefined) search.set(key, String(value));
        }
        const suffix = search.size > 0 ? `?${search}` : "";
        return requestJson(apiUrl, apiKey, `/invoices${suffix}`, InvoicePage);
      },
      detail: (id: string) =>
        requestJson(
          apiUrl,
          apiKey,
          `/invoices/${encodeURIComponent(id)}`,
          InvoiceDetail,
        ),
    })),
  ),
);

export const InvoiceMcpHandlers = InvoiceMcpToolkit.toLayer(
  Effect.gen(function* () {
    const client = yield* InvoiceMcpClient;
    return InvoiceMcpToolkit.of({
      list_invoices: (query) => client.list(query),
      get_invoice: ({ id }) => client.detail(id),
      get_invoice_judgments: ({ id }) =>
        client.detail(id).pipe(
          Effect.map((invoice) => ({
            id: invoice.id,
            judgments: invoice.judgments ?? null,
          })),
        ),
    });
  }),
);

export const InvoiceMcpHandlersLive = InvoiceMcpHandlers.pipe(
  Layer.provide(InvoiceMcpClientLive),
);
