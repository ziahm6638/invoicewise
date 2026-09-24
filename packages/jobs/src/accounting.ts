import type { Database } from "@invoicewise/db/client";
import {
  type AccountingProvider,
  disconnectAccountingConnectionRecord,
  enqueueWorkflowJob,
  getAccountingPostInvoice,
  getActiveAccountingConnection,
  getActiveAccountingConnectionByProvider,
  getWorkflowJobByKey,
  isValidDocumentBinding,
  recordAccountingAlreadyPosted,
  recordAccountingPostFailure,
  recordAccountingPostSuccess,
  restartFailedWorkflowJob,
  upsertAccountingConnection,
} from "@invoicewise/db/queries";
import { Effect, Schema } from "effect";
import { workflowKey } from "./client";

type NangoConfig = {
  baseUrl: string;
  secretKey: string;
  integrationId: string;
  draftBillAction: string;
};

type StorageSigner = {
  signedUrl: (input: {
    bucket: string;
    path: string | string[];
    expireIn: number;
    inboxId: string;
    options?: { download?: boolean };
  }) => Promise<string>;
};

export class AccountingPostError extends Schema.TaggedError<AccountingPostError>()(
  "AccountingPostError",
  { reason: Schema.String, retryable: Schema.Boolean },
) {}

class NangoRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }

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
  const prefix = providerPrefix(provider);
  return {
    baseUrl: (env.NANGO_BASE_URL ?? "https://api.nango.dev").replace(/\/$/, ""),
    secretKey: required(env, "NANGO_SECRET_KEY"),
    integrationId: required(env, `${prefix}_INTEGRATION_ID`),
    draftBillAction: env[`${prefix}_DRAFT_BILL_ACTION`] ?? "create-draft-bill",
  };
};

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};

const errorMessage = (body: unknown, status: number) => {
  const record = asRecord(body);
  const error = asRecord(record.error);
  const upstream = asRecord(error.upstream);
  const upstreamBody = asRecord(upstream.body);
  const message =
    error.message ??
    upstreamBody.message ??
    record.message ??
    `Nango returned HTTP ${status}`;
  return typeof message === "string"
    ? message
    : `Nango returned HTTP ${status}`;
};

const nangoRequest = async (
  config: NangoConfig,
  path: string,
  init: RequestInit,
) => {
  const response = await fetch(`${config.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.secretKey}`,
      ...init.headers,
    },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new NangoRequestError(
      errorMessage(body, response.status),
      response.status,
    );
  }
  return body;
};

export async function createAccountingConnectSession(
  input: { teamId: string; provider: AccountingProvider },
  env = process.env,
) {
  const config = getNangoConfig(input.provider, env);
  const body = asRecord(
    await nangoRequest(config, "/connect/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tags: { workspace_id: input.teamId },
        allowed_integrations: [config.integrationId],
      }),
    }),
  );
  const data = asRecord(body.data);
  if (typeof data.token !== "string" || typeof data.expires_at !== "string") {
    throw new Error("Nango returned an invalid connect session");
  }
  return {
    token: data.token,
    connectLink:
      typeof data.connect_link === "string" ? data.connect_link : null,
    expiresAt: data.expires_at,
    integrationId: config.integrationId,
  };
}

async function verifyAccountingConnection(
  input: {
    teamId: string;
    provider: AccountingProvider;
    connectionId: string;
  },
  env = process.env,
) {
  const config = getNangoConfig(input.provider, env);
  const query = new URLSearchParams({
    connectionId: input.connectionId,
    "tags[workspace_id]": input.teamId,
  });
  const body = asRecord(
    await nangoRequest(config, `/connections?${query}`, { method: "GET" }),
  );
  const connection = Array.isArray(body.connections)
    ? body.connections
        .map(asRecord)
        .find(
          (candidate) =>
            candidate.connection_id === input.connectionId &&
            candidate.provider_config_key === config.integrationId,
        )
    : undefined;
  if (!connection || asRecord(connection.tags).workspace_id !== input.teamId) {
    throw new Error("Nango connection does not belong to this workspace");
  }
  return config;
}

export async function completeAccountingConnection(
  db: Database,
  input: {
    teamId: string;
    provider: AccountingProvider;
    connectionId: string;
  },
  env = process.env,
) {
  const active = await getActiveAccountingConnection(db, input.teamId);
  if (active && active.provider !== input.provider) {
    throw new Error("Disconnect the current accounting connection first");
  }
  const config = await verifyAccountingConnection(input, env);
  return upsertAccountingConnection(db, {
    ...input,
    integrationId: config.integrationId,
  });
}

export async function disconnectAccountingConnection(
  db: Database,
  input: { teamId: string; provider: AccountingProvider },
  env = process.env,
) {
  const connection = await getActiveAccountingConnectionByProvider(db, input);
  if (!connection) return undefined;
  const config = getNangoConfig(input.provider, env);
  const query = new URLSearchParams({
    provider_config_key: config.integrationId,
  });
  try {
    await nangoRequest(
      config,
      `/connections/${encodeURIComponent(connection.connectionId)}?${query}`,
      { method: "DELETE" },
    );
  } catch (error) {
    if (!(error instanceof NangoRequestError && error.status === 404))
      throw error;
  }
  return disconnectAccountingConnectionRecord(db, input);
}

const triggerDraftBill = async (
  connection: {
    provider: AccountingProvider;
    connectionId: string;
  },
  draft: Record<string, unknown>,
  env = process.env,
) => {
  const config = getNangoConfig(connection.provider, env);
  const body = asRecord(
    await nangoRequest(config, "/action/trigger", {
      method: "POST",
      headers: {
        "Connection-Id": connection.connectionId,
        "Content-Type": "application/json",
        "Provider-Config-Key": config.integrationId,
      },
      body: JSON.stringify({
        action_name: config.draftBillAction,
        input: draft,
      }),
    }),
  );
  if (typeof body.providerId !== "string") {
    throw new Error("Nango draft-bill action did not return providerId");
  }
  return { providerId: body.providerId, duplicate: body.duplicate === true };
};

export const postAccountingDraft = (
  db: Database,
  storage: StorageSigner,
  input: { invoiceId: string; teamId: string },
  env = process.env,
) =>
  Effect.gen(function* () {
    const invoice = yield* Effect.tryPromise({
      try: () => getAccountingPostInvoice(db, input),
      catch: () =>
        new AccountingPostError({
          reason: "Unable to load invoice for accounting",
          retryable: true,
        }),
    });
    if (!invoice) {
      return yield* Effect.fail(
        new AccountingPostError({
          reason: "Invoice not found",
          retryable: false,
        }),
      );
    }

    const connection = yield* Effect.tryPromise({
      try: () => getActiveAccountingConnection(db, input.teamId),
      catch: () =>
        new AccountingPostError({
          reason: "Unable to load accounting connection",
          retryable: true,
        }),
    });
    if (!connection) return { invoiceId: invoice.id, status: "skipped" };

    if (invoice.accountingProviderId) {
      yield* Effect.tryPromise({
        try: () => recordAccountingAlreadyPosted(db, input),
        catch: () =>
          new AccountingPostError({
            reason: "Unable to record duplicate accounting post",
            retryable: true,
          }),
      });
      return {
        invoiceId: invoice.id,
        status: "already_posted",
        providerId: invoice.accountingProviderId,
      };
    }

    const idempotencyKey =
      invoice.accountingIdempotencyKey ?? `invoicewise:${invoice.id}`;
    const recordFailure = (error: AccountingPostError) =>
      Effect.tryPromise({
        try: () =>
          recordAccountingPostFailure(db, {
            ...input,
            provider: connection.provider,
            idempotencyKey,
            error: error.reason,
          }),
        catch: () =>
          new AccountingPostError({
            reason: "Unable to record accounting post failure",
            retryable: true,
          }),
      }).pipe(Effect.zipRight(Effect.fail(error)));

    let attachment = null;
    if (
      invoice.filePath?.length &&
      isValidDocumentBinding({
        teamId: invoice.teamId,
        filePath: invoice.filePath,
      })
    ) {
      const signed = yield* Effect.tryPromise({
        try: async () => ({
          url: await storage.signedUrl({
            bucket: "vault",
            path: invoice.filePath!,
            expireIn: 900,
            inboxId: invoice.id,
          }),
          fileName: invoice.fileName,
          contentType: invoice.contentType,
        }),
        catch: () =>
          new AccountingPostError({
            reason: "Unable to sign invoice attachment",
            retryable: true,
          }),
      }).pipe(Effect.either);
      if (signed._tag === "Left") {
        return yield* recordFailure(signed.left);
      }
      attachment = signed.right;
    }
    const extraction = asRecord(invoice.extraction);
    const draft = {
      idempotencyKey,
      status: "draft",
      supplier: {
        name: extraction.supplierName ?? null,
        taxNumber: extraction.supplierVatNumber ?? null,
      },
      invoiceNumber: extraction.invoiceNumber ?? null,
      invoiceDate: extraction.invoiceDate ?? null,
      dueDate: extraction.dueDate ?? null,
      currency: extraction.currency ?? null,
      netAmount: extraction.netAmount ?? null,
      vatAmount: extraction.vatAmount ?? null,
      grossAmount: extraction.grossAmount ?? null,
      lineItems: Array.isArray(extraction.lineItems)
        ? extraction.lineItems
        : [],
      attachment,
    };
    const posted = yield* Effect.tryPromise({
      try: () => triggerDraftBill(connection, draft, env),
      catch: (error) =>
        new AccountingPostError({
          reason: error instanceof Error ? error.message : "Nango post failed",
          retryable:
            error instanceof NangoRequestError ? error.retryable : true,
        }),
    }).pipe(Effect.either);

    if (posted._tag === "Left") {
      return yield* recordFailure(posted.left);
    }

    yield* Effect.tryPromise({
      try: () =>
        recordAccountingPostSuccess(db, {
          ...input,
          provider: connection.provider,
          providerId: posted.right.providerId,
          idempotencyKey,
          duplicate: posted.right.duplicate,
        }),
      catch: () =>
        new AccountingPostError({
          reason: "Unable to record accounting post",
          retryable: true,
        }),
    });
    return {
      invoiceId: invoice.id,
      status: posted.right.duplicate ? "already_posted" : "posted",
      providerId: posted.right.providerId,
    };
  });

export async function enqueueAccountingPost(
  db: Database,
  input: { invoiceId: string; teamId: string },
) {
  if (!(await getActiveAccountingConnection(db, input.teamId))) return null;
  return enqueueWorkflowJob(db, {
    name: "post-accounting-draft",
    teamId: input.teamId,
    payload: input,
    idempotencyKey: workflowKey.accounting(input.teamId, input.invoiceId),
  });
}

export async function retryAccountingPost(
  db: Database,
  input: { invoiceId: string; teamId: string },
) {
  const invoice = await getAccountingPostInvoice(db, input);
  if (!invoice) return null;
  if (invoice.accountingProviderId) {
    return { status: "already_posted" as const, job: null };
  }
  if (!(await getActiveAccountingConnection(db, input.teamId))) {
    throw new Error("No accounting connection is active");
  }
  const idempotencyKey = workflowKey.accounting(input.teamId, input.invoiceId);
  const existing = await getWorkflowJobByKey(db, {
    name: "post-accounting-draft",
    idempotencyKey,
    teamId: input.teamId,
  });
  if (existing?.status === "failed") {
    return {
      status: "queued" as const,
      job: await restartFailedWorkflowJob(db, {
        id: existing.id,
        teamId: input.teamId,
      }),
    };
  }
  if (existing) return { status: existing.status, job: existing };
  const created = await enqueueAccountingPost(db, input);
  return { status: "queued" as const, job: created?.job ?? null };
}
