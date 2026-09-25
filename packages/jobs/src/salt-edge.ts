/**
 * Salt Edge Account Information API v6 client for optional bank-payment
 * reconciliation (docs/bank-payments.md).
 *
 * InvoiceWise never sees bank credentials: the customer signs in to their
 * bank on Salt Edge's own connect page. What InvoiceWise holds is the app's
 * `App-id`/`Secret` (deployment secrets) and the provider's customer and
 * connection ids. Only read scopes (accounts, transactions) are requested.
 */
import { createSign, createVerify } from "node:crypto";

export const SALT_EDGE_DEFAULT_BASE_URL = "https://www.saltedge.com/api/v6";

/** Consent scopes requested for every connect and reconnect: read only. */
export const SALT_EDGE_SCOPES = ["accounts", "transactions"] as const;

/** How long a signed request stays valid (Salt Edge's `Expires-at`). */
const SIGNATURE_TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * The public key Salt Edge signs v6 callbacks with (published in the v6
 * documentation under "Signature"). A public value, so it is the default;
 * `SALT_EDGE_CALLBACK_PUBLIC_KEY` overrides it when Salt Edge rotates it.
 */
export const SALT_EDGE_CALLBACK_PUBLIC_KEY_V6 = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA8qxSS5BmftHK/eyW+o98
NR89TyDmz1V8e6yyFdoMPddEYN4Bcidkk2whoJEc/T/AKghHQ9Nq+DuebnRYYcSJ
YT99VbR1PpIw2R9i8z+DZ79hoizy6z+rwxGANnJOr5BDF5HUKJ8uKS9yGRieojFv
Y9j+rxH6Fj6P90bO4d2igYYspKVoI3Zb3hWS0LrWN+JXAaW9qcOmQPTgO0WG0MUK
gB3NNMfN7gMIkl3chbaULiEgVciP2qZTIGb1b7IDr5+fA9oVVGaXiybdieGHIa4J
S7JNTf0JjWrIKd2DaczKULnghqNQsnoCu+S8BurEOJR5EN1BBfQBPlbSh+ru1zgZ
AQIDAQAB
-----END PUBLIC KEY-----`;

export type SaltEdgeConfig = {
  appId: string;
  secret: string;
  baseUrl: string;
  /** Signs requests; a live-status Salt Edge app must sign every request. */
  privateKey: string | null;
};

export type BankPaymentsAvailability =
  | { available: true; config: SaltEdgeConfig }
  | {
      available: false;
      reason: "disabled" | "not_configured" | "live_app_required";
      message: string;
    };

/**
 * Whether this deployment offers bank payments at all. Off unless
 * `BANK_PAYMENTS_ENABLED` is `true` and the app credentials are set; in
 * production it also needs `SALT_EDGE_PRIVATE_KEY`, because only a
 * live-status app (which must sign requests) may connect real banks, so a
 * sandbox app can never be switched on there by accident.
 */
export const bankPaymentsAvailability = (
  env: NodeJS.ProcessEnv = process.env,
): BankPaymentsAvailability => {
  if (env.BANK_PAYMENTS_ENABLED?.trim() !== "true") {
    return {
      available: false,
      reason: "disabled",
      message: "Bank payments are not available on this deployment.",
    };
  }
  const appId = env.SALT_EDGE_APP_ID?.trim();
  const secret = env.SALT_EDGE_SECRET?.trim();
  if (!appId || !secret) {
    return {
      available: false,
      reason: "not_configured",
      message: "The bank data provider is not configured on this deployment.",
    };
  }
  const privateKey = env.SALT_EDGE_PRIVATE_KEY?.trim() || null;
  if ((env.INVOICEWISE_ENVIRONMENT ?? "") === "production" && !privateKey) {
    return {
      available: false,
      reason: "live_app_required",
      message:
        "Bank payments need a live bank-data provider app before they can be offered in production.",
    };
  }
  return {
    available: true,
    config: {
      appId,
      secret,
      privateKey,
      baseUrl: (env.SALT_EDGE_BASE_URL?.trim() || SALT_EDGE_DEFAULT_BASE_URL)
        .replace(/\/+$/, ""),
    },
  };
};

/**
 * The Salt Edge customer identifier for a workspace. The environment keeps
 * staging and development customers apart when they share one Salt Edge app.
 */
export const saltEdgeCustomerIdentifier = (
  teamId: string,
  env: NodeJS.ProcessEnv = process.env,
) =>
  `invoicewise-${(env.INVOICEWISE_ENVIRONMENT || "development").toLowerCase()}-${teamId}`;

// --- Signing ------------------------------------------------------------------

/** `expiresAt|METHOD|url|body`, the value a signed request carries. */
export const outboundSignatureString = (input: {
  expiresAt: number;
  method: string;
  url: string;
  body: string;
}) =>
  `${input.expiresAt}|${input.method.toUpperCase()}|${input.url}|${input.body}`;

export const signSaltEdgeRequest = (privateKeyPem: string, value: string) => {
  const signer = createSign("SHA256");
  signer.update(value, "utf8");
  signer.end();
  return signer.sign(privateKeyPem, "base64");
};

/**
 * Verifies a Salt Edge callback: RSA-SHA256 over `${callbackUrl}|${rawBody}`
 * with Salt Edge's public key, where `callbackUrl` is exactly the URL the
 * callback was registered at.
 */
export const verifySaltEdgeCallback = (input: {
  publicKeyPem: string;
  callbackUrl: string;
  body: string;
  signature: string;
}) => {
  if (!input.signature) return false;
  const verifier = createVerify("SHA256");
  verifier.update(`${input.callbackUrl}|${input.body}`, "utf8");
  verifier.end();
  try {
    return verifier.verify(input.publicKeyPem, input.signature, "base64");
  } catch {
    return false;
  }
};

// --- Errors -------------------------------------------------------------------

export class SaltEdgeError extends Error {
  override readonly name = "SaltEdgeError";
  constructor(
    message: string,
    /** HTTP status; 0 for a network failure or timeout. */
    readonly status: number,
    /** Salt Edge's `error.class`, when it sent one. */
    readonly errorClass: string | null,
  ) {
    super(message);
  }

  get retryable() {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }

  /** The consent behind the connection has expired or been revoked. */
  get consentGone() {
    return (
      this.errorClass !== null &&
      /Consent(Expired|Revoked)|AispConsent(Expired|Revoked)/.test(
        this.errorClass,
      )
    );
  }

  get notFound() {
    return (
      this.status === 404 ||
      this.errorClass === "ConnectionNotFound" ||
      this.errorClass === "CustomerNotFound"
    );
  }
}

// --- Shapes -------------------------------------------------------------------

export type SaltEdgeConnection = {
  id: string;
  customerId: string;
  /** `active`, `inactive` or `disabled`. */
  status: string;
  providerName: string | null;
  /** Whether the latest attempt (connect, reconnect or refresh) has finished. */
  lastAttemptFinished: boolean | null;
  lastAttemptErrorClass: string | null;
};

export type SaltEdgeConsent = {
  id: string;
  /** `active`, `expired` or `revoked`. */
  status: string;
  expiresAt: string | null;
  revokedAt: string | null;
};

export type SaltEdgeAccount = {
  id: string;
  name: string;
  nature: string | null;
  currency: string;
};

export type SaltEdgeTransaction = {
  id: string;
  accountId: string;
  status: "posted" | "pending";
  duplicated: boolean;
  mode: "normal" | "fee" | "transfer";
  madeOn: string;
  /** Signed decimal string as the bank reports it: money out is negative. */
  amount: string;
  currency: string;
  description: string;
  counterparty: string | null;
  reference: string | null;
};

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};

const text = (value: unknown) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

const idOf = (value: unknown) =>
  typeof value === "number" ? String(value) : (text(value) ?? "");

const connectionOf = (value: unknown): SaltEdgeConnection => {
  const row = record(value);
  const attempt = record(row.last_attempt);
  return {
    id: idOf(row.id),
    customerId: idOf(row.customer_id),
    status: text(row.status) ?? "inactive",
    providerName: text(row.provider_name),
    lastAttemptFinished:
      typeof attempt.finished === "boolean" ? attempt.finished : null,
    lastAttemptErrorClass: text(attempt.fail_error_class),
  };
};

const consentOf = (value: unknown): SaltEdgeConsent => {
  const row = record(value);
  return {
    id: idOf(row.id),
    status: text(row.status) ?? "active",
    expiresAt: text(row.expires_at),
    revokedAt: text(row.revoked_at),
  };
};

const accountOf = (value: unknown): SaltEdgeAccount => {
  const row = record(value);
  return {
    id: idOf(row.id),
    name: text(row.name) ?? "Account",
    nature: text(row.nature),
    currency: (text(row.currency_code) ?? "").toUpperCase(),
  };
};

/** A decimal amount as a string with at most four places, never a float. */
export const decimalOf = (value: unknown): string | null => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value.toFixed(4).replace(/\.?0+$/, "") || "0";
  }
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim())) {
    return value.trim();
  }
  return null;
};

const transactionOf = (value: unknown): SaltEdgeTransaction | null => {
  const row = record(value);
  const extra = record(row.extra);
  const amount = decimalOf(row.amount);
  const madeOn = text(row.made_on);
  const id = idOf(row.id);
  if (!id || amount === null || !madeOn) return null;
  const references = [
    extra.end_to_end_id,
    extra.information,
    extra.additional,
    extra.payee_information,
    extra.payer_information,
  ]
    .map(text)
    .filter((item): item is string => item !== null);
  const mode = text(row.mode);
  return {
    id,
    accountId: idOf(row.account_id),
    status: row.status === "pending" ? "pending" : "posted",
    duplicated: row.duplicated === true,
    mode: mode === "fee" || mode === "transfer" ? mode : "normal",
    madeOn,
    amount,
    currency: (text(row.currency_code) ?? "").toUpperCase(),
    description: text(row.description) ?? "",
    counterparty:
      text(extra.payee) ??
      text(extra.payer) ??
      text(extra.transfer_account_name),
    reference: references.length ? [...new Set(references)].join(" | ") : null,
  };
};

// --- Client -------------------------------------------------------------------

export type SaltEdgeClient = ReturnType<typeof createSaltEdgeClient>;

/** Largest page Salt Edge serves; a sync reads at most `maxPages` of them. */
const PER_PAGE = 1000;

export function createSaltEdgeClient(
  config: SaltEdgeConfig,
  fetcher: typeof fetch = fetch,
) {
  const call = async (
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    options: {
      query?: Record<string, string | number | boolean | undefined | null>;
      body?: unknown;
    } = {},
  ) => {
    const url = new URL(`${config.baseUrl}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }
    const body =
      options.body === undefined ? "" : JSON.stringify({ data: options.body });
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
      "App-id": config.appId,
      Secret: config.secret,
    };
    if (config.privateKey) {
      const expiresAt = Math.floor((Date.now() + SIGNATURE_TTL_MS) / 1000);
      headers["Expires-at"] = String(expiresAt);
      headers.Signature = signSaltEdgeRequest(
        config.privateKey,
        outboundSignatureString({
          expiresAt,
          method,
          url: url.toString(),
          body,
        }),
      );
    }
    let response: Response;
    try {
      response = await fetcher(url, {
        method,
        headers,
        body: body || undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new SaltEdgeError(
        `Salt Edge could not be reached: ${error instanceof Error ? error.message : String(error)}`,
        0,
        null,
      );
    }
    const raw = await response.text();
    let parsed: unknown = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      const error = record(record(parsed).error);
      throw new SaltEdgeError(
        text(error.message) ?? `Salt Edge returned HTTP ${response.status}`,
        response.status,
        text(error.class),
      );
    }
    const envelope = record(parsed);
    return { data: envelope.data, meta: record(envelope.meta) };
  };

  /** Every page of a list endpoint, following `meta.next_id`, bounded. */
  const all = async <T>(
    path: string,
    query: Record<string, string | undefined>,
    map: (value: unknown) => T,
    maxPages = 20,
  ) => {
    const rows: T[] = [];
    let fromId: string | undefined;
    for (let page = 0; page < maxPages; page += 1) {
      const { data, meta } = await call("GET", path, {
        query: { ...query, from_id: fromId },
      });
      rows.push(...(Array.isArray(data) ? data : []).map(map));
      fromId = text(meta.next_id) ?? undefined;
      if (!fromId) break;
    }
    return rows;
  };

  const attemptOf = (input: {
    returnTo: string;
    customFields?: Record<string, string>;
  }) => ({
    return_to: input.returnTo,
    return_connection_id: true,
    return_error_class: true,
    fetch_scopes: [...SALT_EDGE_SCOPES],
    custom_fields: input.customFields ?? {},
  });

  const consentOf_ = (periodDays: number) => ({
    scopes: [...SALT_EDGE_SCOPES],
    period_days: periodDays,
  });

  return {
    async createCustomer(identifier: string) {
      try {
        const { data } = await call("POST", "/customers", {
          body: { identifier },
        });
        return { id: idOf(record(data).customer_id ?? record(data).id) };
      } catch (error) {
        // A retried connect after a partial failure: reuse the customer.
        if (
          error instanceof SaltEdgeError &&
          error.errorClass === "DuplicatedCustomer"
        ) {
          const existing = await all("/customers", {}, (value) => {
            const row = record(value);
            return {
              id: idOf(row.customer_id ?? row.id),
              identifier: text(row.identifier),
            };
          });
          const found = existing.find((row) => row.identifier === identifier);
          if (found) return { id: found.id };
        }
        throw error;
      }
    },

    async removeCustomer(customerId: string) {
      try {
        await call("DELETE", `/customers/${encodeURIComponent(customerId)}`);
      } catch (error) {
        if (error instanceof SaltEdgeError && error.notFound) return;
        throw error;
      }
    },

    async connect(input: {
      customerId: string;
      periodDays: number;
      fromDate: string;
      returnTo: string;
      customFields?: Record<string, string>;
    }) {
      const { data } = await call("POST", "/connections/connect", {
        body: {
          customer_id: input.customerId,
          consent: { ...consentOf_(input.periodDays), from_date: input.fromDate },
          attempt: { ...attemptOf(input), fetch_from_date: input.fromDate },
        },
      });
      const row = record(data);
      return {
        connectUrl: text(row.connect_url) ?? "",
        expiresAt: text(row.expires_at),
      };
    },

    async reconnect(
      connectionId: string,
      input: {
        periodDays: number;
        fromDate: string;
        returnTo: string;
        customFields?: Record<string, string>;
      },
    ) {
      const { data } = await call(
        "POST",
        `/connections/${encodeURIComponent(connectionId)}/reconnect`,
        {
          body: {
            consent: {
              ...consentOf_(input.periodDays),
              from_date: input.fromDate,
            },
            attempt: { ...attemptOf(input), fetch_from_date: input.fromDate },
          },
        },
      );
      const row = record(data);
      return {
        connectUrl: text(row.connect_url) ?? "",
        expiresAt: text(row.expires_at),
      };
    },

    /** Asks the bank for new data; false when the provider refuses for now. */
    async refresh(connectionId: string, returnTo: string) {
      try {
        await call(
          "POST",
          `/connections/${encodeURIComponent(connectionId)}/refresh`,
          { body: { attempt: attemptOf({ returnTo }) } },
        );
        return true;
      } catch (error) {
        if (
          error instanceof SaltEdgeError &&
          !error.retryable &&
          !error.consentGone
        ) {
          return false;
        }
        throw error;
      }
    },

    async getConnection(connectionId: string) {
      const { data } = await call(
        "GET",
        `/connections/${encodeURIComponent(connectionId)}`,
      );
      return connectionOf(data);
    },

    listConnections(customerId: string) {
      return all("/connections", { customer_id: customerId }, connectionOf);
    },

    /** Removes the connection at Salt Edge, which also revokes its consent. */
    async removeConnection(connectionId: string) {
      try {
        await call(
          "DELETE",
          `/connections/${encodeURIComponent(connectionId)}`,
        );
      } catch (error) {
        if (error instanceof SaltEdgeError && error.notFound) return;
        throw error;
      }
    },

    listConsents(connectionId: string) {
      return all("/consents", { connection_id: connectionId }, consentOf);
    },

    listAccounts(connectionId: string) {
      return all("/accounts", { connection_id: connectionId }, accountOf);
    },

    /**
     * One page of an account's transactions from `fromId` (inclusive), with
     * the id to continue from. Posted and pending are listed separately.
     */
    async listTransactions(input: {
      connectionId: string;
      accountId: string;
      pending: boolean;
      fromId?: string | null;
    }) {
      const { data, meta } = await call("GET", "/transactions", {
        query: {
          connection_id: input.connectionId,
          account_id: input.accountId,
          pending: input.pending ? true : undefined,
          from_id: input.fromId ?? undefined,
          per_page: PER_PAGE,
        },
      });
      return {
        transactions: (Array.isArray(data) ? data : [])
          .map(transactionOf)
          .filter((row): row is SaltEdgeTransaction => row !== null),
        nextId: text(meta.next_id),
      };
    },
  };
}

/**
 * Removes a deleted workspace's Salt Edge customer. Uses the app credentials
 * even when bank payments were since switched off on this deployment; with no
 * credentials at all the removal cannot happen and the cleanup retries.
 */
export async function revokeBankFeedCustomer(
  customerId: string,
  env: NodeJS.ProcessEnv = process.env,
  fetcher: typeof fetch = fetch,
) {
  const appId = env.SALT_EDGE_APP_ID?.trim();
  const secret = env.SALT_EDGE_SECRET?.trim();
  if (!appId || !secret) {
    throw new SaltEdgeError(
      "SALT_EDGE_APP_ID and SALT_EDGE_SECRET are needed to remove the bank data customer",
      0,
      null,
    );
  }
  await createSaltEdgeClient(
    {
      appId,
      secret,
      privateKey: env.SALT_EDGE_PRIVATE_KEY?.trim() || null,
      baseUrl: (env.SALT_EDGE_BASE_URL?.trim() || SALT_EDGE_DEFAULT_BASE_URL).replace(
        /\/+$/,
        "",
      ),
    },
    fetcher,
  ).removeCustomer(customerId);
}
