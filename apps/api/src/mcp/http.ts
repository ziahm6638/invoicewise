import {
  Cause,
  Effect,
  Exit,
  JSONSchema,
  Layer,
  Option,
  type Schema,
} from "effect";
import {
  type ApiFetcher,
  InvoiceMcpClient,
  InvoiceMcpError,
  InvoiceMcpHandlers,
  InvoiceMcpToolkit,
  makeInvoiceMcpClient,
} from "./invoice-tools";

/**
 * The remote MCP server at `/v1/mcp`: the Model Context Protocol's
 * streamable HTTP transport, answered statelessly with JSON (no session, no
 * server-to-client stream). The Hono layer has already authenticated the
 * bearer credential and checked `inbox.read`; every tool call goes back
 * through the v1 REST API with that same credential, so tenant isolation,
 * scopes and rate limits are REST's. The tools are read-only.
 */

export const MCP_SERVER_INFO = { name: "invoicewise", version: "1.0.0" };

/** Newest first; an unknown requested version gets the newest. */
export const MCP_PROTOCOL_VERSIONS = [
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
] as const;

const MAX_MCP_BODY_BYTES = 256 * 1024;

type JsonRpcId = string | number;
type JsonRpcMessage = {
  jsonrpc?: unknown;
  id?: JsonRpcId | null;
  method?: unknown;
  params?: unknown;
};

const rpcError = (id: JsonRpcId | null, code: number, message: string) => ({
  jsonrpc: "2.0" as const,
  id,
  error: { code, message },
});

const rpcResult = (id: JsonRpcId, result: unknown) => ({
  jsonrpc: "2.0" as const,
  id,
  result,
});

const jsonSchema = (schema: Schema.Schema.Any) => {
  const { $schema: _ignored, ...rest } = JSONSchema.make(
    schema as Schema.Schema<unknown>,
  ) as unknown as Record<string, unknown>;
  return rest;
};

/** The tool list, with input and output JSON Schemas and read-only hints. */
export const mcpToolList = () =>
  Object.values(InvoiceMcpToolkit.tools).map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: jsonSchema(tool.parametersSchema),
    outputSchema: jsonSchema(tool.successSchema),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }));

const toolText = (value: unknown) => [
  { type: "text" as const, text: JSON.stringify(value) },
];

const callTool = async (
  fetcher: ApiFetcher,
  name: string,
  args: unknown,
): Promise<unknown> => {
  const handlers = InvoiceMcpHandlers.pipe(
    Layer.provide(
      Layer.succeed(InvoiceMcpClient, makeInvoiceMcpClient(fetcher)),
    ),
  );
  const exit = await Effect.runPromiseExit(
    Effect.flatMap(InvoiceMcpToolkit, (toolkit) =>
      toolkit.handle(name as never, (args ?? {}) as never),
    ).pipe(Effect.provide(handlers)),
  );
  if (Exit.isSuccess(exit)) {
    const encoded = exit.value.encodedResult;
    return {
      content: toolText(encoded),
      structuredContent: encoded,
      isError: false,
    };
  }
  const failure: unknown = Option.getOrNull(Cause.failureOption(exit.cause));
  const error =
    failure instanceof InvoiceMcpError
      ? { status: failure.status, code: failure.code, message: failure.message }
      : {
          status: 400,
          code: "invalid_arguments",
          message:
            failure && typeof failure === "object" && "description" in failure
              ? String((failure as { description: unknown }).description)
              : "The tool call failed",
        };
  return {
    content: toolText({ error }),
    structuredContent: { error },
    isError: true,
  };
};

const TOOL_NAMES = new Set(Object.keys(InvoiceMcpToolkit.tools));

const handleMessage = async (
  message: JsonRpcMessage,
  fetcher: ApiFetcher,
): Promise<object | null> => {
  // Notifications and responses from the client need no answer.
  if (message.id === undefined || message.id === null) return null;
  const id = message.id;
  if (message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return rpcError(id, -32600, "Invalid request");
  }
  const params =
    typeof message.params === "object" && message.params !== null
      ? (message.params as Record<string, unknown>)
      : {};
  switch (message.method) {
    case "initialize": {
      const requested = params.protocolVersion;
      const protocolVersion = MCP_PROTOCOL_VERSIONS.includes(
        requested as (typeof MCP_PROTOCOL_VERSIONS)[number],
      )
        ? requested
        : MCP_PROTOCOL_VERSIONS[0];
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: MCP_SERVER_INFO,
        instructions:
          "Read-only access to the InvoiceWise workspace of the API key: invoices, their extraction, validation, judgments and delivery.",
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: mcpToolList() });
    case "tools/call": {
      if (typeof params.name !== "string" || !TOOL_NAMES.has(params.name)) {
        return rpcError(
          id,
          -32602,
          `Unknown tool. Available tools: ${[...TOOL_NAMES].join(", ")}`,
        );
      }
      return rpcResult(
        id,
        await callTool(fetcher, params.name, params.arguments),
      );
    }
    default:
      return rpcError(id, -32601, `Method not found: ${message.method}`);
  }
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

export async function handleMcpHttp(
  request: Request,
  fetcher: ApiFetcher,
): Promise<Response> {
  if (request.method !== "POST") {
    // No server-initiated stream and no sessions to end.
    return new Response(null, { status: 405, headers: { allow: "POST" } });
  }
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_MCP_BODY_BYTES) {
    return json(rpcError(null, -32600, "Request too large"), 413);
  }
  const body = await request.text();
  if (body.length > MAX_MCP_BODY_BYTES) {
    return json(rpcError(null, -32600, "Request too large"), 413);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return json(rpcError(null, -32700, "Parse error"), 400);
  }
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  if (
    messages.length === 0 ||
    messages.some((message) => typeof message !== "object" || message === null)
  ) {
    return json(rpcError(null, -32600, "Invalid request"), 400);
  }
  const responses = (
    await Promise.all(
      messages.map((message) =>
        handleMessage(message as JsonRpcMessage, fetcher),
      ),
    )
  ).filter((response) => response !== null);
  if (responses.length === 0) return new Response(null, { status: 202 });
  return json(Array.isArray(parsed) ? responses : responses[0]);
}
