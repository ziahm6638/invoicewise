import type { AccountingProvider } from "@invoicewise/db/queries";

/**
 * Client for the self-hosted Nango instance (docs/accounting-integrations.md).
 * The free self-hosted edition provides OAuth (Connect UI, token storage and
 * refresh) and the authenticated proxy; it does not run Nango actions, so the
 * provider-specific bill calls live in ./accounting-providers.ts and reach the
 * provider only through the proxy. Provider credentials never leave Nango.
 */
export type NangoConfig = {
  baseUrl: string;
  publicUrl: string;
  secretKey: string;
  integrationId: string;
};

export class NangoRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The provider's own error code, such as a QuickBooks fault code. */
    readonly code: string | null = null,
  ) {
    super(message);
  }

  /** Nango answers 424 when the provider or a token refresh failed upstream. */
  get retryable() {
    return this.status === 424 || this.status === 429 || this.status >= 500;
  }
}

const required = (env: NodeJS.ProcessEnv, name: string) => {
  const value = env[name];
  if (!value) throw new Error(`${name} must be configured`);
  return value;
};

const providerPrefix = (provider: AccountingProvider) =>
  provider === "xero" ? "NANGO_XERO" : "NANGO_QUICKBOOKS";

export const getNangoConfig = (
  provider: AccountingProvider,
  env = process.env,
): NangoConfig => {
  const baseUrl = required(env, "NANGO_BASE_URL").replace(/\/$/, "");
  return {
    baseUrl,
    // Browsers load Connect UI against the public host; the API may reach
    // Nango on a private network address instead.
    publicUrl: (env.NANGO_PUBLIC_URL || baseUrl).replace(/\/$/, ""),
    secretKey: required(env, "NANGO_SECRET_KEY"),
    integrationId: required(env, `${providerPrefix(provider)}_INTEGRATION_ID`),
  };
};

export const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};

const firstString = (...values: unknown[]) =>
  values.find(
    (value): value is string => typeof value === "string" && value !== "",
  );

/**
 * The most useful reason in a Nango or provider error body: Nango's own
 * error, Xero validation errors, a QuickBooks fault, or a plain message.
 */
export const errorMessage = (body: unknown, status: number) => {
  const record = asRecord(body);
  const error = asRecord(record.error);
  const upstreamBody = asRecord(asRecord(error.upstream).body);
  const xeroValidation = (Array.isArray(record.Elements) ? record.Elements : [])
    .flatMap((element) => {
      const errors = asRecord(element).ValidationErrors;
      return Array.isArray(errors) ? errors : [];
    })
    .map((validation) => asRecord(validation).Message)
    .filter((message): message is string => typeof message === "string");
  const fault = asRecord(record.Fault ?? record.fault);
  const faultError = asRecord(
    Array.isArray(fault.Error) ? fault.Error[0] : undefined,
  );
  const faultMessage = firstString(faultError.Detail, faultError.Message);
  return (
    firstString(
      error.message,
      upstreamBody.message,
      xeroValidation.join("; "),
      faultMessage,
      record.Detail,
      record.Message,
      record.message,
      typeof record.error === "string" ? record.error : undefined,
    ) ?? `Nango returned HTTP ${status}`
  );
};

/** The provider's error code in a proxied error body (a QuickBooks fault). */
export const providerErrorCode = (body: unknown) => {
  const record = asRecord(body);
  const fault = asRecord(record.Fault ?? record.fault);
  const error = asRecord(
    Array.isArray(fault.Error) ? fault.Error[0] : undefined,
  );
  return typeof error.code === "string" && error.code ? error.code : null;
};

const parseBody = async (response: Response) => {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text.slice(0, 500) };
  }
};

/**
 * One finished Nango call: which integration, whether it went through the
 * provider proxy, timing and outcome. Never the request or response body.
 */
export type NangoCallEvent = {
  operation: string;
  durationMs: number;
  outcome: "ok" | "failed" | "throttled";
};

let nangoCallObserver: ((event: NangoCallEvent) => void) | undefined;

/** Registers the process-wide observer for Nango calls (provider metering). */
export const observeNangoCalls = (
  observer: ((event: NangoCallEvent) => void) | undefined,
) => {
  nangoCallObserver = observer;
};

export const nangoRequest = async (
  config: NangoConfig,
  path: string,
  init: RequestInit,
) => {
  const startedAt = performance.now();
  const report = (outcome: NangoCallEvent["outcome"]) => {
    try {
      nangoCallObserver?.({
        operation: `${path.startsWith("/proxy") ? "proxy" : "api"}:${config.integrationId}`,
        durationMs: performance.now() - startedAt,
        outcome,
      });
    } catch {
      // Metering never changes the call's outcome.
    }
  };
  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${config.secretKey}`,
        ...init.headers,
      },
    });
  } catch (error) {
    report("failed");
    throw error;
  }
  const body = await parseBody(response);
  if (!response.ok) {
    report(response.status === 429 ? "throttled" : "failed");
    throw new NangoRequestError(
      errorMessage(body, response.status),
      response.status,
      providerErrorCode(body),
    );
  }
  report("ok");
  return body;
};

/**
 * The stored connection, including the provider details Nango captured at
 * connect time (Xero `tenant_id`, QuickBooks `realmId`). `refresh` forces
 * Nango to refresh the access token now instead of on expiry.
 */
export async function getNangoConnection(
  config: NangoConfig,
  connectionId: string,
  options: { refresh?: boolean } = {},
) {
  const query = new URLSearchParams({
    provider_config_key: config.integrationId,
  });
  if (options.refresh) query.set("force_refresh", "true");
  const body = asRecord(
    await nangoRequest(
      config,
      `/connection/${encodeURIComponent(connectionId)}?${query}`,
      { method: "GET" },
    ),
  );
  const credentials = asRecord(body.credentials);
  return {
    connectionId: String(body.connection_id ?? connectionId),
    connectionConfig: asRecord(body.connection_config),
    tokenExpiresAt:
      typeof credentials.expires_at === "string"
        ? credentials.expires_at
        : null,
  };
}

export type ProxyRequest = {
  method: "GET" | "POST" | "PUT";
  /** Provider API path, including any query string. */
  path: string;
  /** Headers for the provider; sent as Nango-Proxy-* so Nango forwards them. */
  headers?: Record<string, string>;
  json?: unknown;
  /** Raw bytes sent with `contentType`. */
  bytes?: { data: ArrayBuffer; contentType: string };
  /** Multipart parts; Nango rebuilds the form for the provider. */
  form?: FormData;
};

/** Call the provider API through Nango's authenticated proxy. */
export const nangoProxy = (
  config: NangoConfig,
  connectionId: string,
  request: ProxyRequest,
) => {
  const headers: Record<string, string> = {
    "Connection-Id": connectionId,
    "Provider-Config-Key": config.integrationId,
    // Let the caller own retries: a replayed write must carry its
    // idempotency key, which only the adapter knows how to reuse.
    Retries: "0",
  };
  const forward: Record<string, string> = {
    Accept: "application/json",
    ...request.headers,
  };
  let body: RequestInit["body"];
  if (request.json !== undefined) {
    headers["Content-Type"] = "application/json";
    forward["Content-Type"] = "application/json";
    body = JSON.stringify(request.json);
  } else if (request.bytes) {
    headers["Content-Type"] = request.bytes.contentType;
    forward["Content-Type"] = request.bytes.contentType;
    body = request.bytes.data;
  } else if (request.form) {
    // fetch sets the multipart boundary; Nango re-encodes the parts when the
    // forwarded content type is exactly multipart/form-data.
    forward["Content-Type"] = "multipart/form-data";
    body = request.form;
  }
  for (const [name, value] of Object.entries(forward)) {
    headers[`Nango-Proxy-${name}`] = value;
  }
  return nangoRequest(config, `/proxy${request.path}`, {
    method: request.method,
    headers,
    body,
  });
};
