/** The v1 error body, shared by the Hono layer and its tests. */

type ErrorCode =
  | "unauthorized"
  | "forbidden"
  | "no_workspace"
  | "insufficient_scope"
  | "rate_limited"
  | "not_found"
  | "invalid_request"
  | "internal_error";

export const v1Error = (
  code: ErrorCode,
  message: string,
  status: number,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

export const unauthorized = (message: string) =>
  v1Error("unauthorized", message, 401, {
    "www-authenticate": 'Bearer realm="invoicewise"',
  });

/**
 * Effect's own request-decoding failures and unmatched routes are rewritten
 * into the contract's error body.
 */
export const normalizeResponse = async (response: Response) => {
  if (response.status === 404 && !response.headers.get("content-type")) {
    return v1Error("not_found", "No such endpoint", 404);
  }
  if (response.status !== 400) return response;
  const body = (await response
    .clone()
    .json()
    .catch(() => null)) as { _tag?: string; message?: string } | null;
  if (body?._tag !== "HttpApiDecodeError") return response;
  return v1Error(
    "invalid_request",
    body.message || "The request does not match the API contract",
    400,
  );
};
