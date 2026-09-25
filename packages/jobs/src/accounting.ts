import { createHash } from "node:crypto";
import type { Database } from "@invoicewise/db/client";
import {
  type AccountingProvider,
  claimAccountingPost,
  disconnectAccountingConnectionRecord,
  getAccountingConnections,
  getAccountingPostInvoice,
  getActiveAccountingConnection,
  getActiveAccountingConnectionByProvider,
  getBillUpdate,
  isValidDocumentBinding,
  recordAccountingAlreadyPosted,
  recordAccountingAttachment,
  recordAccountingConnectionHealth,
  recordAccountingPostCancelled,
  recordAccountingPostFailure,
  recordAccountingPostSuccess,
  recordBillUpdateOutcome,
  releaseAccountingPostClaim,
  updateAccountingConnectionSettings,
  updateInboxValidation,
  upsertAccountingConnection,
} from "@invoicewise/db/queries";
import { redactOperationalText } from "@invoicewise/db/utils/redact";
import { postingKeyOf, validateInvoice } from "@invoicewise/documents";
import { Effect, Schema } from "effect";
import {
  type AccountingSettings,
  type DraftBill,
  type ProviderEntity,
  attachProviderDocument,
  getQuickBooksSetupOptions,
  isRetryable,
  postProviderBill,
  readProviderOrganisation,
  updateProviderBill,
} from "./accounting-providers";
import {
  otherAccountingCompanyReason,
  providerAccountingReadiness,
  requeueAccountingIntent,
  retryAccountingAttachment,
  scheduleAccountingAttachment,
} from "./delivery";
import {
  type NangoConfig,
  NangoRequestError,
  asRecord,
  getNangoConfig,
  getNangoConnection,
  nangoRequest,
} from "./nango";

export { getNangoConfig } from "./nango";

const PROVIDER_NAME: Record<AccountingProvider, string> = {
  xero: "Xero",
  quickbooks: "QuickBooks",
};

type AttachmentStorage = {
  download: (input: { bucket: string; path: string[] }) => Promise<Blob>;
};

/**
 * Where a user opens the record in the provider's own app. A QuickBooks
 * sandbox company lives on its own host; QUICKBOOKS_APP_URL overrides the
 * production host.
 */
export const providerBillUrl = (
  provider: AccountingProvider,
  providerId: string,
  options: { entity?: ProviderEntity | null; sandbox?: boolean } = {},
  env = process.env,
) => {
  const id = encodeURIComponent(providerId);
  if (provider === "xero") {
    return `https://go.xero.com/AccountsPayable/Edit.aspx?InvoiceID=${id}`;
  }
  const host = options.sandbox
    ? "https://app.sandbox.qbo.intuit.com"
    : (env.QUICKBOOKS_APP_URL || "https://app.qbo.intuit.com").replace(
        /\/$/,
        "",
      );
  const page = options.entity === "vendor_credit" ? "vendorcredit" : "bill";
  return `${host}/app/${page}?txnId=${id}`;
};

/**
 * The provider link for an invoice's accounting record, reading whether the
 * workspace's connection to that provider is a sandbox.
 */
export async function accountingRecordUrl(
  db: Database,
  teamId: string,
  record: {
    provider: AccountingProvider | null;
    providerId: string | null;
    entity?: ProviderEntity | null;
  },
) {
  if (!record.provider || !record.providerId) return null;
  const connection = (await getAccountingConnections(db, teamId)).find(
    (candidate) => candidate.provider === record.provider,
  );
  return providerBillUrl(record.provider, record.providerId, {
    entity: record.entity,
    sandbox: connection?.sandbox ?? false,
  });
}

/** What a provider bill carries, from an invoice's (corrected) extraction. */
export const draftBillFrom = (
  source: unknown,
  idempotencyKey: string,
): DraftBill => {
  const extraction = asRecord(source);
  const text = (value: unknown) =>
    typeof value === "string" && value.trim() ? value.trim() : null;
  const amount = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  const credit = extraction.documentType === "credit_note";
  // A credit note may print its amounts negative; the provider takes the
  // amounts credited.
  const signed = (value: unknown) => {
    const number = amount(value);
    return number !== null && credit ? Math.abs(number) : number;
  };
  return {
    idempotencyKey,
    documentType: credit ? "credit_note" : "invoice",
    supplierName: text(extraction.supplierName),
    supplierTaxNumber: text(extraction.supplierVatNumber),
    invoiceNumber: text(extraction.invoiceNumber),
    invoiceDate: text(extraction.invoiceDate),
    dueDate: text(extraction.dueDate),
    currency: text(extraction.currency),
    netAmount: signed(extraction.netAmount),
    vatAmount: signed(extraction.vatAmount),
    grossAmount: signed(extraction.grossAmount),
    description: text(extraction.description),
    lineItems: (Array.isArray(extraction.lineItems)
      ? extraction.lineItems
      : []
    ).map((item) => {
      const line = asRecord(item);
      return {
        description: text(line.description),
        quantity: signed(line.quantity),
        unitPrice: signed(line.unitPrice),
        total: signed(line.total),
      };
    }),
  };
};

export class AccountingPostError extends Schema.TaggedError<AccountingPostError>()(
  "AccountingPostError",
  { reason: Schema.String, retryable: Schema.Boolean },
) {}

/**
 * Whether each provider can be connected: its Nango settings are present and
 * the integration (the provider's OAuth app) exists in Nango. A provider app
 * still awaiting registration therefore reads as unavailable, not broken.
 * `sandbox` marks an integration that reaches only the provider's sandbox
 * companies (QuickBooks development keys).
 */
export async function getAccountingProviderAvailability(env = process.env) {
  return Promise.all(
    (["xero", "quickbooks"] as const).map(async (provider) => {
      try {
        return {
          provider,
          available: true,
          sandbox: await integrationIsSandbox(getNangoConfig(provider, env)),
        };
      } catch {
        return { provider, available: false, sandbox: false };
      }
    }),
  );
}

const integrationIsSandbox = async (config: NangoConfig) => {
  const body = asRecord(
    await nangoRequest(
      config,
      `/integrations/${encodeURIComponent(config.integrationId)}`,
      { method: "GET" },
    ),
  );
  const nangoProvider = asRecord(body.data).provider;
  return (
    typeof nangoProvider === "string" && nangoProvider.endsWith("-sandbox")
  );
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
  if (typeof data.connect_link !== "string" || !data.connect_link) {
    throw new Error("Nango returned a connect session without a connect link");
  }
  const connectLink = data.connect_link;
  return {
    token: data.token,
    connectLink,
    expiresAt: data.expires_at,
    integrationId: config.integrationId,
    // What the browser's Connect UI needs: the Nango API it talks to and
    // where the self-hosted Connect UI is served (the session link's base).
    apiUrl: config.publicUrl,
    connectUrl: connectLink.replace(/[?#].*$/, ""),
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

/**
 * Binds a Connect UI connection to the workspace: the connection must carry
 * this workspace's tag (set when the workspace started the connect session),
 * and the company it reaches is read live through the proxy and stored, so
 * the admin sees which organisation was bound before anything posts to it.
 */
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
  const [organisation, sandbox] = await Promise.all([
    readProviderOrganisation(input.provider, config, input.connectionId).catch(
      (error) => {
        throw new Error(
          `The connection was made, but ${PROVIDER_NAME[input.provider]} did not say which company it reaches: ${failureMessage(error)}`,
        );
      },
    ),
    integrationIsSandbox(config),
  ]);
  const connection = await upsertAccountingConnection(db, {
    ...input,
    integrationId: config.integrationId,
    organisationId: organisation.id,
    organisationName: organisation.name,
    sandbox,
    // A Xero draft awaits approval in Xero, so posting starts at connect; a
    // QuickBooks bill is open and unpaid, so an admin opts in first.
    autoPostOnConnect: input.provider === "xero",
  });
  // A reconnect replaces the Nango connection: the one it replaced no
  // longer serves the workspace, so its credentials are deleted.
  // Best effort: the new connection is stored, so a failure here must not
  // report the connect as failed.
  if (active && active.connectionId !== input.connectionId) {
    await revokeAccountingConnection(
      {
        provider: active.provider,
        connectionId: active.connectionId,
        integrationId: active.integrationId,
      },
      env,
    ).catch((error) =>
      Effect.runPromise(
        Effect.logWarning(
          "The replaced accounting connection could not be deleted in Nango",
        ).pipe(
          Effect.annotateLogs({
            teamId: input.teamId,
            provider: active.provider,
            reason: failureMessage(error),
          }),
        ),
      ),
    );
  }
  return connection;
}

const failureMessage = (error: unknown) =>
  redactOperationalText(
    error instanceof Error ? error.message : "The provider call failed",
  );

/**
 * A provider or Nango failure as a reason a user can act on, and whether
 * repeating the call unchanged may succeed. Never includes credentials:
 * Nango holds them, and the text is redacted besides.
 */
export function accountingFailure(
  provider: AccountingProvider,
  error: unknown,
): { reason: string; retryable: boolean } {
  const name = PROVIDER_NAME[provider];
  const message = failureMessage(error);
  if (error instanceof NangoRequestError) {
    if (error.status === 401 || error.status === 403) {
      return {
        reason: `${name} refused InvoiceWise's authorisation (${message}); reconnect ${name} in Settings → Accounting, then retry`,
        retryable: false,
      };
    }
    if (error.status === 404 && /connection/i.test(message)) {
      return {
        reason: `The ${name} connection no longer exists in Nango; reconnect ${name} in Settings → Accounting, then retry`,
        retryable: false,
      };
    }
    if (error.status === 424) {
      return {
        reason: `${name} could not be reached with the stored authorisation (${message}); if this keeps happening, reconnect ${name} in Settings → Accounting`,
        retryable: true,
      };
    }
    if (error.status === 429) {
      return {
        reason: `${name} is rate limiting requests; retrying`,
        retryable: true,
      };
    }
  }
  return { reason: message, retryable: isRetryable(error) };
}

/**
 * A live check of the workspace's connection through Nango: the connection
 * still exists and the provider answers for the bound company. Records and
 * returns ok, reconnect (the authorisation is gone or refused) or
 * unavailable (Nango or the provider is down or throttling).
 */
export async function checkAccountingConnection(
  db: Database,
  input: { teamId: string },
  env = process.env,
) {
  const connection = await getActiveAccountingConnection(db, input.teamId);
  if (!connection) return null;
  const record = (
    status: "ok" | "reconnect" | "unavailable",
    error: string | null,
    organisation?: { id: string; name: string | null },
  ) =>
    recordAccountingConnectionHealth(db, {
      teamId: input.teamId,
      provider: connection.provider,
      status,
      error,
      organisationId: organisation?.id,
      organisationName: organisation?.name,
    });
  try {
    const config = getNangoConfig(connection.provider, env);
    await getNangoConnection(config, connection.connectionId);
    const organisation = await readProviderOrganisation(
      connection.provider,
      config,
      connection.connectionId,
    );
    if (
      connection.organisationId &&
      organisation.id !== connection.organisationId
    ) {
      return record(
        "reconnect",
        `The connection now reaches ${organisation.name ?? organisation.id}, not the company it was bound to; reconnect ${PROVIDER_NAME[connection.provider]}`,
      );
    }
    return record("ok", null, organisation);
  } catch (error) {
    const failure = accountingFailure(connection.provider, error);
    return record(
      failure.retryable ? "unavailable" : "reconnect",
      failure.reason,
    );
  }
}

/** Settings an admin must choose before a provider can post. */
export const accountingSetupMissing = (
  provider: AccountingProvider,
  settings: unknown,
): "expense_account"[] =>
  provider === "quickbooks" && !settingsOf(settings).expenseAccountId
    ? ["expense_account"]
    : [];

const settingsOf = (value: unknown): AccountingSettings => {
  const record = asRecord(value);
  return {
    expenseAccountId:
      typeof record.expenseAccountId === "string"
        ? record.expenseAccountId
        : null,
    taxCodeIds: Array.isArray(record.taxCodeIds)
      ? record.taxCodeIds.filter((id): id is string => typeof id === "string")
      : [],
  };
};

/**
 * What an admin chooses from to set up posting to the connected company
 * (QuickBooks: its expense accounts and purchase tax codes), with the
 * current choices and what is still missing.
 */
export async function getAccountingSetup(
  db: Database,
  input: { teamId: string },
  env = process.env,
) {
  const connection = await getActiveAccountingConnection(db, input.teamId);
  if (!connection) return null;
  const settings = settingsOf(connection.settings);
  const base = {
    provider: connection.provider,
    organisationId: connection.organisationId,
    organisationName: connection.organisationName,
    sandbox: connection.sandbox,
    settings,
    autoPostEnabledAt: connection.autoPostEnabledAt,
    missing: accountingSetupMissing(connection.provider, settings),
  };
  if (connection.provider !== "quickbooks") {
    return { ...base, company: null, accounts: [], taxCodes: [] };
  }
  const options = await getQuickBooksSetupOptions(
    getNangoConfig("quickbooks", env),
    connection.connectionId,
  ).catch((error) => {
    throw new Error(accountingFailure("quickbooks", error).reason);
  });
  return { ...base, ...options };
}

export class AccountingSettingsError extends Error {}

/**
 * Saves an admin's posting choices. Choices are checked against the live
 * company, and automatic posting can be switched on only when the setup is
 * complete and the admin confirms the company it posts to (the organisation
 * ID shown to them), since a QuickBooks bill is created open and unpaid.
 */
export async function updateAccountingSettings(
  db: Database,
  input: {
    teamId: string;
    userId: string | null;
    provider: AccountingProvider;
    expenseAccountId?: string | null;
    taxCodeIds?: string[];
    autoPost: boolean;
    confirmOrganisationId?: string | null;
  },
  env = process.env,
) {
  const connection = await getActiveAccountingConnection(db, input.teamId);
  if (!connection || connection.provider !== input.provider) {
    throw new AccountingSettingsError(
      `${PROVIDER_NAME[input.provider]} is not connected`,
    );
  }
  let settings = settingsOf(connection.settings);
  if (input.provider === "quickbooks") {
    const setup = await getAccountingSetup(db, input, env);
    const expenseAccountId =
      input.expenseAccountId === undefined
        ? settings.expenseAccountId
        : input.expenseAccountId;
    if (
      expenseAccountId &&
      !setup?.accounts.some((account) => account.id === expenseAccountId)
    ) {
      throw new AccountingSettingsError(
        "Choose an active expense account from the connected QuickBooks company",
      );
    }
    const taxCodeIds = input.taxCodeIds ?? settings.taxCodeIds ?? [];
    const known = new Set(setup?.taxCodes.map((code) => code.id));
    if (taxCodeIds.some((id) => !known.has(id))) {
      throw new AccountingSettingsError(
        "Choose purchase tax codes from the connected QuickBooks company",
      );
    }
    settings = { expenseAccountId: expenseAccountId ?? null, taxCodeIds };
  }
  if (input.autoPost) {
    const missing = accountingSetupMissing(input.provider, settings);
    if (missing.length) {
      throw new AccountingSettingsError(
        "Choose the expense account before switching on automatic bills",
      );
    }
    if (
      !connection.autoPostEnabledAt &&
      (!input.confirmOrganisationId ||
        input.confirmOrganisationId !== connection.organisationId)
    ) {
      throw new AccountingSettingsError(
        `Confirm the ${PROVIDER_NAME[input.provider]} company automatic bills are created in`,
      );
    }
  }
  return updateAccountingConnectionSettings(db, {
    teamId: input.teamId,
    provider: input.provider,
    settings,
    autoPost: input.autoPost ? { enabledBy: input.userId } : null,
  });
}

/**
 * Deletes a connection in Nango, which removes the provider credentials it
 * holds. A connection Nango no longer has counts as already revoked.
 */
export async function revokeAccountingConnection(
  connection: {
    provider: AccountingProvider;
    connectionId: string;
    /** The integration the connection was made under, when it is known. */
    integrationId?: string;
  },
  env = process.env,
) {
  const config = getNangoConfig(connection.provider, env);
  const query = new URLSearchParams({
    provider_config_key: connection.integrationId ?? config.integrationId,
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
}

export async function disconnectAccountingConnection(
  db: Database,
  input: { teamId: string; provider: AccountingProvider },
  env = process.env,
) {
  const connection = await getActiveAccountingConnectionByProvider(db, input);
  if (!connection) return undefined;
  await revokeAccountingConnection(
    { provider: input.provider, connectionId: connection.connectionId },
    env,
  );
  return disconnectAccountingConnectionRecord(db, input);
}

/**
 * Posts one draft bill for an invoice. The provider idempotency key is per
 * invoice, so concurrent or repeated runs (an expired lease, a timeout after
 * the provider already created the bill) resolve to one logical bill. A
 * non-final failure keeps the intent queued; only the final attempt records a
 * visible failure. Queued work for a deleted invoice or a disconnected
 * connection is cancelled without posting.
 */
export const postAccountingDraft = (
  db: Database,
  storage: AttachmentStorage,
  input: {
    invoiceId: string;
    teamId: string;
    attempt?: number;
    maxAttempts?: number;
    /** A person asked for this post; see `requeueAccountingIntent`. */
    explicit?: boolean;
  },
  env = process.env,
) =>
  Effect.gen(function* () {
    const target = { invoiceId: input.invoiceId, teamId: input.teamId };
    const cancel = (reason: string, retryable?: boolean) =>
      Effect.tryPromise({
        try: () =>
          recordAccountingPostCancelled(db, { ...target, reason, retryable }),
        catch: () =>
          new AccountingPostError({
            reason: "Unable to record cancelled accounting post",
            retryable: true,
          }),
      });
    const invoice = yield* Effect.tryPromise({
      try: () => getAccountingPostInvoice(db, target),
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

    if (invoice.status === "deleted") {
      yield* cancel("Invoice was deleted");
      return { invoiceId: invoice.id, status: "cancelled" };
    }

    const connection = yield* Effect.tryPromise({
      try: () => getActiveAccountingConnection(db, input.teamId),
      catch: () =>
        new AccountingPostError({
          reason: "Unable to load accounting connection",
          retryable: true,
        }),
    });
    if (!connection) {
      yield* cancel("No accounting connection is active");
      return { invoiceId: invoice.id, status: "cancelled" };
    }

    if (invoice.accountingProviderId) {
      yield* Effect.tryPromise({
        try: () => recordAccountingAlreadyPosted(db, target),
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

    // Automatic posting switched off after this post was scheduled: nothing
    // is created unless a person asked for this invoice.
    if (!input.explicit && !connection.autoPostEnabledAt) {
      yield* cancel(
        `Automatic posting to ${PROVIDER_NAME[connection.provider]} was switched off before this invoice was sent; send it yourself from the invoice if you want it`,
        true,
      );
      return { invoiceId: invoice.id, status: "cancelled" };
    }

    // Provider-required fields that are missing or invalid, an inconsistent
    // total, a duplicate or a credit note Xero cannot take: the bill is not
    // attempted, and the reasons are recorded as a failure a retry cannot
    // fix until the invoice is corrected (see
    // docs/document-intake.md#validation).
    const readiness = providerAccountingReadiness(
      connection.provider,
      invoice.extraction,
      invoice.validation,
    );
    // Keyed by document type and number, not the document, so the provider
    // replays one bill for any copy that reaches it. A post a user released
    // from review is its own bill, under its own claim and key.
    const postingKey = postingKeyOf(invoice.extraction);
    const released = invoice.accountingPostReleased;
    const idempotencyKey =
      (!released && invoice.accountingIdempotencyKey) ||
      `invoicewise:${
        postingKey && !released
          ? createHash("sha256")
              .update(`${input.teamId}:${postingKey}`)
              .digest("hex")
              .slice(0, 36)
          : invoice.id
      }`;
    const claim = postingKey
      ? {
          teamId: input.teamId,
          identityKey: released ? `${postingKey}:${invoice.id}` : postingKey,
          invoiceId: invoice.id,
        }
      : null;
    const recordFailure = (error: AccountingPostError) =>
      Effect.tryPromise({
        try: async () => {
          if (claim && !error.retryable) {
            await releaseAccountingPostClaim(db, claim);
          }
          await recordAccountingPostFailure(db, {
            ...target,
            provider: connection.provider,
            idempotencyKey,
            error: error.reason,
            final:
              !error.retryable ||
              input.attempt === undefined ||
              input.attempt >= (input.maxAttempts ?? input.attempt),
            retryable: error.retryable,
          });
        },
        catch: () =>
          new AccountingPostError({
            reason: "Unable to record accounting post failure",
            retryable: true,
          }),
      }).pipe(Effect.zipRight(Effect.fail(error)));
    const notSent = (reasons: string) =>
      `Not sent to ${PROVIDER_NAME[connection.provider]}: ${reasons}`;
    const block = (blockers: readonly { code: string; message: string }[]) =>
      Effect.tryPromise({
        try: () =>
          recordAccountingPostFailure(db, {
            ...target,
            provider: connection.provider,
            idempotencyKey,
            error: notSent(
              blockers.map((blocker) => blocker.message).join(" "),
            ),
            retryable: false,
          }),
        catch: () =>
          new AccountingPostError({
            reason: "Unable to record blocked accounting post",
            retryable: true,
          }),
      }).pipe(
        Effect.as({
          invoiceId: invoice.id,
          status: "blocked",
          blockers: blockers.map((blocker) => blocker.code),
        }),
      );

    if (!readiness.ready) return yield* block(readiness.blockers);

    // Only the document holding the claim for its type and number posts.
    // Another copy from the same supplier that loses it becomes a duplicate
    // of the holder; a document from another supplier is held for review.
    if (claim) {
      const holder = yield* Effect.tryPromise({
        try: () => claimAccountingPost(db, claim),
        catch: () =>
          new AccountingPostError({
            reason: "Unable to claim the accounting post",
            retryable: true,
          }),
      });
      if (!holder) {
        return yield* Effect.fail(
          new AccountingPostError({
            reason: "The accounting post claim was released; retrying",
            retryable: true,
          }),
        );
      }
      if (holder !== invoice.id) {
        const validation = yield* Effect.tryPromise({
          try: async () => {
            const original = await getAccountingPostInvoice(db, {
              invoiceId: holder,
              teamId: input.teamId,
            });
            const validation = validateInvoice(
              invoice.extraction,
              original ? [{ id: holder, extraction: original.extraction }] : [],
            );
            await updateInboxValidation(db, {
              id: invoice.id,
              teamId: input.teamId,
              validation,
            });
            return validation;
          },
          catch: () =>
            new AccountingPostError({
              reason: "Unable to record the duplicate copy",
              retryable: true,
            }),
        });
        if (validation.identity.duplicateOf) {
          return yield* block(validation.accounting.blockers);
        }
        const reason = notSent(
          `invoice number ${String(asRecord(invoice.extraction).invoiceNumber)} was already sent for a different supplier (document ${holder}). Check it is not a duplicate, then retry to send it as a separate bill.`,
        );
        yield* Effect.tryPromise({
          try: () =>
            recordAccountingPostFailure(db, {
              ...target,
              provider: connection.provider,
              idempotencyKey,
              error: reason,
              status: "needs_review",
              retryable: true,
            }),
          catch: () =>
            new AccountingPostError({
              reason: "Unable to record the post held for review",
              retryable: true,
            }),
        });
        return yield* Effect.fail(
          new AccountingPostError({ reason, retryable: false }),
        );
      }
    }

    const config = yield* Effect.try({
      try: () => getNangoConfig(connection.provider, env),
      catch: (error) =>
        new AccountingPostError({
          reason:
            error instanceof Error ? error.message : "Nango is not configured",
          retryable: false,
        }),
    }).pipe(Effect.catchAll(recordFailure));

    let attachment = null;
    if (
      invoice.filePath?.length &&
      isValidDocumentBinding({
        teamId: invoice.teamId,
        filePath: invoice.filePath,
      })
    ) {
      const loaded = yield* Effect.tryPromise({
        try: async () => ({
          fileName: invoice.fileName ?? "invoice.pdf",
          contentType: invoice.contentType ?? "application/pdf",
          data: await (
            await storage.download({ bucket: "vault", path: invoice.filePath! })
          ).arrayBuffer(),
        }),
        catch: () =>
          new AccountingPostError({
            reason: "Unable to load invoice attachment",
            retryable: true,
          }),
      }).pipe(Effect.either);
      if (loaded._tag === "Left") {
        return yield* recordFailure(loaded.left);
      }
      attachment = loaded.right;
    }
    const bill = draftBillFrom(invoice.extraction, idempotencyKey);
    const posted = yield* Effect.tryPromise({
      try: () =>
        postProviderBill(
          connection.provider,
          config,
          { ...connection, settings: settingsOf(connection.settings) },
          bill,
          attachment,
        ),
      catch: (error) =>
        new AccountingPostError(accountingFailure(connection.provider, error)),
    }).pipe(Effect.either);

    if (posted._tag === "Left") {
      return yield* recordFailure(posted.left);
    }

    const result = posted.right;
    // A record whose document failed to upload stays posted; the upload is
    // retried on its own when it may succeed, never by posting again.
    const attachmentOutcome = result.attached
      ? { status: "attached" as const, error: null }
      : result.attachmentError
        ? {
            status: result.attachmentRetryable
              ? ("queued" as const)
              : ("failed" as const),
            error: redactOperationalText(result.attachmentError),
          }
        : { status: null, error: null };
    yield* Effect.tryPromise({
      try: () =>
        db.transaction(async (tx) => {
          const executor = tx as unknown as Database;
          await recordAccountingPostSuccess(executor, {
            ...target,
            provider: connection.provider,
            providerId: result.providerId,
            entity: result.entity,
            organisationId: connection.organisationId,
            idempotencyKey,
            duplicate: false,
            attachment: attachmentOutcome,
          });
          if (attachmentOutcome.status === "queued") {
            await scheduleAccountingAttachment(executor, {
              ...target,
              providerId: result.providerId,
            });
          }
        }),
      catch: () =>
        new AccountingPostError({
          reason: "Unable to record accounting post",
          retryable: true,
        }),
    });
    if (result.attachmentError) {
      yield* Effect.logWarning(
        "Accounting record posted without its attachment",
      ).pipe(
        Effect.annotateLogs({
          invoiceId: invoice.id,
          provider: connection.provider,
          reason: attachmentOutcome.error,
          retrying: attachmentOutcome.status === "queued",
        }),
      );
    }
    return {
      invoiceId: invoice.id,
      status: "posted",
      providerId: result.providerId,
      entity: result.entity,
      attached: result.attached,
    };
  });

/**
 * Uploads the source document to a record already posted, on its own: the
 * retry for a post whose record exists but whose attachment failed. It never
 * posts the record again, and repeating it never duplicates the document.
 * A non-final failure keeps the attachment queued; the final one records it
 * failed with the reason, for an explicit retry.
 */
export const attachAccountingDocument = (
  db: Database,
  storage: AttachmentStorage,
  input: {
    invoiceId: string;
    teamId: string;
    attempt?: number;
    maxAttempts?: number;
  },
  env = process.env,
) =>
  Effect.gen(function* () {
    const target = { invoiceId: input.invoiceId, teamId: input.teamId };
    const record = (
      status: "attached" | "queued" | "failed",
      error: string | null,
    ) =>
      Effect.tryPromise({
        try: () => recordAccountingAttachment(db, { ...target, status, error }),
        catch: () =>
          new AccountingPostError({
            reason: "Unable to record the attachment",
            retryable: true,
          }),
      });
    const loaded = yield* Effect.tryPromise({
      try: async () => ({
        invoice: await getAccountingPostInvoice(db, target),
        connection: await getActiveAccountingConnection(db, input.teamId),
      }),
      catch: () =>
        new AccountingPostError({
          reason: "Unable to load the invoice for its attachment",
          retryable: true,
        }),
    });
    const { invoice, connection } = loaded;
    if (!invoice?.accountingProviderId || !invoice.accountingProvider) {
      return { invoiceId: input.invoiceId, status: "not_posted" };
    }
    if (invoice.accountingAttachmentStatus === "attached") {
      return { invoiceId: invoice.id, status: "attached", idempotent: true };
    }
    const providerName = PROVIDER_NAME[invoice.accountingProvider];
    if (invoice.status === "deleted" || !invoice.filePath?.length) {
      yield* record("failed", "The invoice has no document to attach");
      return { invoiceId: invoice.id, status: "failed" };
    }
    if (connection?.provider !== invoice.accountingProvider) {
      yield* record(
        "failed",
        `${providerName} is no longer connected; attach the document in ${providerName} yourself`,
      );
      return { invoiceId: invoice.id, status: "failed" };
    }
    const otherCompany = otherAccountingCompanyReason(
      {
        provider: invoice.accountingProvider,
        organisationId: invoice.accountingOrganisationId,
      },
      connection,
    );
    if (otherCompany) {
      yield* record("failed", otherCompany);
      return { invoiceId: invoice.id, status: "failed" };
    }
    const final = (error: AccountingPostError) =>
      !error.retryable ||
      input.attempt === undefined ||
      input.attempt >= (input.maxAttempts ?? input.attempt);
    const attached = yield* Effect.tryPromise({
      try: async () => {
        if (
          !isValidDocumentBinding({
            teamId: invoice.teamId,
            filePath: invoice.filePath!,
          })
        ) {
          throw new Error(
            "The invoice document is not stored for this workspace",
          );
        }
        const data = await (
          await storage.download({ bucket: "vault", path: invoice.filePath! })
        ).arrayBuffer();
        await attachProviderDocument(
          invoice.accountingProvider!,
          getNangoConfig(invoice.accountingProvider!, env),
          { ...connection, settings: settingsOf(connection.settings) },
          {
            providerId: invoice.accountingProviderId!,
            entity: invoice.accountingProviderEntity ?? "bill",
          },
          {
            fileName: invoice.fileName ?? "invoice.pdf",
            contentType: invoice.contentType ?? "application/pdf",
            data,
          },
        );
      },
      catch: (error) =>
        new AccountingPostError(
          accountingFailure(invoice.accountingProvider!, error),
        ),
    }).pipe(Effect.either);
    if (attached._tag === "Left") {
      const error = attached.left;
      yield* record(final(error) ? "failed" : "queued", error.reason);
      return yield* Effect.fail(error);
    }
    yield* record("attached", null);
    return { invoiceId: invoice.id, status: "attached" };
  });

/**
 * Explicit accounting retry for one invoice. Re-drives a failed or cancelled
 * intent on the workspace's active connection; see `retryInvoiceDelivery` for
 * the full per-destination retry.
 */
export async function retryAccountingPost(
  db: Database,
  input: { invoiceId: string; teamId: string },
) {
  const invoice = await getAccountingPostInvoice(db, input);
  if (!invoice || invoice.status === "deleted") return null;
  if (invoice.accountingProviderId) {
    // A posted record whose document failed to attach: retry the upload.
    // A queued one whose job was lost is re-driven the same way.
    const queued = await retryAccountingAttachment(db, {
      ...input,
      providerId: invoice.accountingProviderId,
      provider: invoice.accountingProvider,
      organisationId: invoice.accountingOrganisationId,
      attachmentStatus: invoice.accountingAttachmentStatus,
    });
    return {
      status: queued
        ? ("attachment_queued" as const)
        : ("already_posted" as const),
    };
  }
  if (!(await getActiveAccountingConnection(db, input.teamId))) {
    throw new Error("No accounting connection is active");
  }
  const outcome = await db.transaction((tx) =>
    requeueAccountingIntent(tx as unknown as Database, {
      ...input,
      // A never-scheduled invoice is treated like a failed one: posting it is
      // what the caller explicitly asked for.
      status: invoice.accountingPostStatus ?? "failed",
      providerId: invoice.accountingProviderId,
      revision: invoice.accountingRevision ?? invoice.processingRevision,
      currentRevision: invoice.processingRevision,
      permitted: true,
    }),
  );
  return { status: outcome === "requeued" ? ("queued" as const) : outcome };
}

/**
 * Updates the bill an invoice was already posted as, after a user corrected
 * the invoice and chose to update it (docs/delivery.md#corrections). The
 * provider ID recorded when the bill was created is the only target: the
 * update can change that bill or fail, never create another. It sends the
 * extraction as it was when the user approved the correction, under a key
 * per correction, so a retry after an ambiguous timeout replays the same
 * update. A non-final failure keeps the update queued with its last error.
 */
export const updateAccountingBill = (
  db: Database,
  input: {
    correctionId: string;
    teamId: string;
    attempt?: number;
    maxAttempts?: number;
  },
  env = process.env,
) =>
  Effect.gen(function* () {
    const target = { correctionId: input.correctionId, teamId: input.teamId };
    const settle = (
      status: "updated" | "failed" | "cancelled" | "queued",
      error?: string,
      retryable?: boolean,
    ) =>
      Effect.tryPromise({
        try: () =>
          recordBillUpdateOutcome(db, { ...target, status, error, retryable }),
        catch: () =>
          new AccountingPostError({
            reason: "Unable to record the bill update",
            retryable: true,
          }),
      });
    const loaded = yield* Effect.tryPromise({
      try: () => getBillUpdate(db, target),
      catch: () =>
        new AccountingPostError({
          reason: "Unable to load the bill update",
          retryable: true,
        }),
    });
    if (!loaded) {
      return yield* Effect.fail(
        new AccountingPostError({
          reason: "Correction not found",
          retryable: false,
        }),
      );
    }
    const { correction, invoice } = loaded;
    // Settled already (a replayed job, or a retry that finished first).
    if (correction.updateStatus !== "queued") {
      return {
        correctionId: correction.id,
        status: correction.updateStatus ?? "none",
        idempotent: true,
      };
    }
    if (invoice.status === "deleted") {
      yield* settle("cancelled", "Invoice was deleted", false);
      return { correctionId: correction.id, status: "cancelled" };
    }
    const providerId = correction.providerId;
    const provider = correction.provider;
    if (!providerId || !provider) {
      yield* settle("failed", "The invoice has no bill to update", false);
      return { correctionId: correction.id, status: "failed" };
    }
    const providerName = PROVIDER_NAME[provider];
    const connection = yield* Effect.tryPromise({
      try: () => getActiveAccountingConnection(db, input.teamId),
      catch: () =>
        new AccountingPostError({
          reason: "Unable to load accounting connection",
          retryable: true,
        }),
    });
    if (!connection) {
      yield* settle("cancelled", "No accounting connection is active", true);
      return { correctionId: correction.id, status: "cancelled" };
    }
    if (connection.provider !== provider) {
      yield* settle(
        "failed",
        `The bill is in ${providerName}, but ${PROVIDER_NAME[connection.provider]} is connected now. Update the bill in ${providerName} yourself.`,
        false,
      );
      return { correctionId: correction.id, status: "failed" };
    }
    const otherCompany = otherAccountingCompanyReason(
      { provider, organisationId: invoice.accountingOrganisationId },
      connection,
    );
    if (otherCompany) {
      yield* settle("failed", otherCompany, false);
      return { correctionId: correction.id, status: "failed" };
    }

    // The corrected invoice must still be one the provider record can
    // represent.
    const readiness = providerAccountingReadiness(
      provider,
      correction.extraction,
      validateInvoice(correction.extraction),
    );
    if (!readiness.ready) {
      yield* settle(
        "failed",
        `Not updated in ${providerName}: ${readiness.blockers
          .map((blocker) => blocker.message)
          .join(" ")}`,
        false,
      );
      return { correctionId: correction.id, status: "blocked" };
    }

    const final = (error: AccountingPostError) =>
      !error.retryable ||
      input.attempt === undefined ||
      input.attempt >= (input.maxAttempts ?? input.attempt);
    const config = yield* Effect.try({
      try: () => getNangoConfig(provider, env),
      catch: (error) =>
        new AccountingPostError({
          reason:
            error instanceof Error ? error.message : "Nango is not configured",
          retryable: false,
        }),
    }).pipe(Effect.either);
    if (config._tag === "Left") {
      yield* settle("failed", config.left.reason, false);
      return yield* Effect.fail(config.left);
    }
    const updated = yield* Effect.tryPromise({
      try: () =>
        updateProviderBill(
          provider,
          config.right,
          { ...connection, settings: settingsOf(connection.settings) },
          providerId,
          draftBillFrom(
            correction.extraction,
            `invoicewise-update:${correction.id}:${correction.updateAttempt}`,
          ),
          invoice.accountingProviderEntity ?? "bill",
        ),
      catch: (error) =>
        new AccountingPostError(accountingFailure(provider, error)),
    }).pipe(Effect.either);
    if (updated._tag === "Left") {
      const error = updated.left;
      yield* settle(
        final(error) ? "failed" : "queued",
        error.reason,
        error.retryable,
      );
      return yield* Effect.fail(error);
    }
    yield* settle("updated");
    return {
      correctionId: correction.id,
      status: "updated",
      providerId: updated.right.providerId,
    };
  });
