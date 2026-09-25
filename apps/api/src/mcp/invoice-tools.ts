import {
  Invoice,
  InvoiceDelivery,
  InvoiceJudgments,
  InvoiceList,
} from "@api/effect/public-api";
import { Tool, Toolkit } from "@effect/ai";
import { INVOICE_STATE_FILTERS } from "@invoicewise/db/queries";
import { Config, Context, Effect, Layer, Redacted, Schema } from "effect";

/**
 * The read-only MCP tools. Each one is a call to the versioned REST API
 * (`/v1`) with the caller's own credential, so authentication, scopes,
 * rate limits and workspace isolation are exactly REST's. No tool takes a
 * workspace argument and none changes anything. Served over stdio
 * (`server.ts`).
 */

export class InvoiceMcpError extends Schema.TaggedError<InvoiceMcpError>()(
  "InvoiceMcpError",
  {
    status: Schema.Number,
    code: Schema.String,
    message: Schema.String,
  },
) {}

const Uuid = Schema.UUID.annotations({
  description: "An invoice id, as returned by list_invoices.",
});

export const ListInvoices = Tool.make("list_invoices", {
  description:
    "List invoices in the workspace the API key belongs to, newest first. Each invoice has its processing status (processing, processed, failed), revision, supplier, invoice number, dates, currency, amount, validation, judgments and delivery state. Pass nextCursor back as cursor for the next page.",
  parameters: {
    status: Schema.optional(
      Schema.Literal("processing", "processed", "failed"),
    ),
    state: Schema.optional(
      Schema.Literal(...INVOICE_STATE_FILTERS),
    ).annotations({
      description: "Exception state, as the dashboard shows it.",
    }),
    q: Schema.optional(Schema.String).annotations({
      description: "Search supplier name, invoice number and file name.",
    }),
    supplierId: Schema.optional(Schema.UUID),
    createdFrom: Schema.optional(Schema.String).annotations({
      description: "YYYY-MM-DD",
    }),
    createdTo: Schema.optional(Schema.String).annotations({
      description: "YYYY-MM-DD",
    }),
    order: Schema.optional(Schema.Literal("desc", "asc")),
    limit: Schema.optional(
      Schema.Number.pipe(Schema.int(), Schema.between(1, 100)),
    ),
    cursor: Schema.optional(Schema.String),
  },
  success: InvoiceList,
  failure: InvoiceMcpError,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const GetInvoice = Tool.make("get_invoice", {
  description:
    "Get one invoice: processing status and revision, the canonical extraction with per-value evidence, validation (deterministic checks and accounting readiness), supplier-history checks, judgments and delivery summary.",
  parameters: { id: Uuid },
  success: Invoice,
  failure: InvoiceMcpError,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const GetInvoiceJudgments = Tool.make("get_invoice_judgments", {
  description:
    "Get an invoice's current answers to the workspace questions (status, typed answer, confidence, question revision, evaluator) and the answers deliberate reruns recorded.",
  parameters: { id: Uuid },
  success: InvoiceJudgments,
  failure: InvoiceMcpError,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const GetInvoiceDelivery = Tool.make("get_invoice_delivery", {
  description:
    "Get where an invoice was delivered: each webhook delivery (event, status, attempts, last error) and the accounting post status.",
  parameters: { id: Uuid },
  success: InvoiceDelivery,
  failure: InvoiceMcpError,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const InvoiceMcpToolkit = Toolkit.make(
  ListInvoices,
  GetInvoice,
  GetInvoiceJudgments,
  GetInvoiceDelivery,
);

/** Sends one GET to the v1 API as the caller and returns the raw response. */
export type ApiFetcher = (path: string) => Promise<Response>;

export class InvoiceMcpClient extends Context.Tag(
  "invoicewise/InvoiceMcpClient",
)<
  InvoiceMcpClient,
  {
    readonly list: (
      query: typeof ListInvoices.parametersSchema.Type,
    ) => Effect.Effect<typeof InvoiceList.Type, InvoiceMcpError>;
    readonly detail: (
      id: string,
    ) => Effect.Effect<typeof Invoice.Type, InvoiceMcpError>;
    readonly judgments: (
      id: string,
    ) => Effect.Effect<typeof InvoiceJudgments.Type, InvoiceMcpError>;
    readonly delivery: (
      id: string,
    ) => Effect.Effect<typeof InvoiceDelivery.Type, InvoiceMcpError>;
  }
>() {}

const requestJson = <A, I>(
  fetcher: ApiFetcher,
  path: string,
  schema: Schema.Schema<A, I, never>,
) =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetcher(path);
      if (!response.ok) {
        const body = await response.text();
        let code = "request_failed";
        let message = body || response.statusText;
        try {
          const parsed = JSON.parse(body) as {
            error?: { code?: unknown; message?: unknown } | string;
          };
          if (typeof parsed.error === "object" && parsed.error) {
            if (typeof parsed.error.code === "string") code = parsed.error.code;
            if (typeof parsed.error.message === "string") {
              message = parsed.error.message;
            }
          } else if (typeof parsed.error === "string") {
            message = parsed.error;
          }
        } catch {
          // The response body is useful as-is when it is not JSON.
        }
        throw new InvoiceMcpError({ status: response.status, code, message });
      }
      return response.json();
    },
    catch: (cause) =>
      cause instanceof InvoiceMcpError
        ? cause
        : new InvoiceMcpError({
            status: 503,
            code: "api_unreachable",
            message:
              cause instanceof Error ? cause.message : "API request failed",
          }),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknown(schema)),
    Effect.mapError((cause) =>
      cause instanceof InvoiceMcpError
        ? cause
        : new InvoiceMcpError({
            status: 502,
            code: "invalid_response",
            message: "InvoiceWise returned an invalid response",
          }),
    ),
  );

export const makeInvoiceMcpClient = (
  fetcher: ApiFetcher,
): Context.Tag.Service<InvoiceMcpClient> => ({
  list: (query) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) search.set(key, String(value));
    }
    const suffix = search.size > 0 ? `?${search}` : "";
    return requestJson(fetcher, `/v1/invoices${suffix}`, InvoiceList);
  },
  detail: (id) =>
    requestJson(fetcher, `/v1/invoices/${encodeURIComponent(id)}`, Invoice),
  judgments: (id) =>
    requestJson(
      fetcher,
      `/v1/invoices/${encodeURIComponent(id)}/judgments`,
      InvoiceJudgments,
    ),
  delivery: (id) =>
    requestJson(
      fetcher,
      `/v1/invoices/${encodeURIComponent(id)}/delivery`,
      InvoiceDelivery,
    ),
});

/** The stdio server's client: the configured API URL and key. */
export const InvoiceMcpClientLive = Layer.effect(
  InvoiceMcpClient,
  Config.all({
    apiUrl: Config.string("INVOICEWISE_API_URL").pipe(
      Config.withDefault("https://api.invoicewise.uk"),
    ),
    apiKey: Config.redacted("INVOICEWISE_API_KEY"),
  }).pipe(
    Effect.map(({ apiKey, apiUrl }) =>
      makeInvoiceMcpClient((path) =>
        fetch(new URL(path, apiUrl), {
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${Redacted.value(apiKey)}`,
          },
        }),
      ),
    ),
  ),
);

export const InvoiceMcpHandlers = InvoiceMcpToolkit.toLayer(
  Effect.gen(function* () {
    const client = yield* InvoiceMcpClient;
    return InvoiceMcpToolkit.of({
      list_invoices: (query) => client.list(query),
      get_invoice: ({ id }) => client.detail(id),
      get_invoice_judgments: ({ id }) => client.judgments(id),
      get_invoice_delivery: ({ id }) => client.delivery(id),
    });
  }),
);

export const InvoiceMcpHandlersLive = InvoiceMcpHandlers.pipe(
  Layer.provide(InvoiceMcpClientLive),
);
