import { createHash } from "node:crypto";
import type { Database } from "@invoicewise/db/client";
import {
  type AccountingProvider,
  claimAccountingPost,
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
  releaseAccountingPostClaim,
  releaseAccountingPostForReview,
  restartFailedWorkflowJob,
  updateInboxValidation,
  upsertAccountingConnection,
} from "@invoicewise/db/queries";
import {
  accountingReadiness,
  postingKeyOf,
  validateInvoice,
} from "@invoicewise/documents";
import { Effect, Schema } from "effect";
import { BillRejectedError, postProviderBill } from "./accounting-providers";
import { workflowKey } from "./client";
import {
  NangoRequestError,
  asRecord,
  getNangoConfig,
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

export class AccountingPostError extends Schema.TaggedError<AccountingPostError>()(
  "AccountingPostError",
  { reason: Schema.String, retryable: Schema.Boolean },
) {}

/**
 * Whether each provider can be connected: its Nango settings are present and
 * the integration (the provider's OAuth app) exists in Nango. A provider app
 * still awaiting registration therefore reads as unavailable, not broken.
 */
export async function getAccountingProviderAvailability(env = process.env) {
  return Promise.all(
    (["xero", "quickbooks"] as const).map(async (provider) => {
      try {
        const config = getNangoConfig(provider, env);
        await nangoRequest(
          config,
          `/integrations/${encodeURIComponent(config.integrationId)}`,
          { method: "GET" },
        );
        return { provider, available: true };
      } catch {
        return { provider, available: false };
      }
    }),
  );
}

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

export const postAccountingDraft = (
  db: Database,
  storage: AttachmentStorage,
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

    // Provider-required fields that are missing or invalid, an inconsistent
    // total, a duplicate or a credit note: the bill is not attempted, and the
    // reasons are recorded as a failure a retry cannot fix until the invoice
    // is corrected (see docs/document-intake.md#validation).
    const readiness = accountingReadiness(
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
            ...input,
            provider: connection.provider,
            idempotencyKey,
            error: error.reason,
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
            ...input,
            provider: connection.provider,
            idempotencyKey,
            error: notSent(
              blockers.map((blocker) => blocker.message).join(" "),
            ),
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
              ...input,
              provider: connection.provider,
              idempotencyKey,
              error: reason,
              status: "needs_review",
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
    const extraction = asRecord(invoice.extraction);
    const text = (value: unknown) =>
      typeof value === "string" && value.trim() ? value.trim() : null;
    const amount = (value: unknown) =>
      typeof value === "number" && Number.isFinite(value) ? value : null;
    const bill = {
      idempotencyKey,
      supplierName: text(extraction.supplierName),
      supplierTaxNumber: text(extraction.supplierVatNumber),
      invoiceNumber: text(extraction.invoiceNumber),
      invoiceDate: text(extraction.invoiceDate),
      dueDate: text(extraction.dueDate),
      currency: text(extraction.currency),
      netAmount: amount(extraction.netAmount),
      vatAmount: amount(extraction.vatAmount),
      grossAmount: amount(extraction.grossAmount),
      description: text(extraction.description),
      lineItems: (Array.isArray(extraction.lineItems)
        ? extraction.lineItems
        : []
      ).map((item) => {
        const line = asRecord(item);
        return {
          description: text(line.description),
          quantity: amount(line.quantity),
          unitPrice: amount(line.unitPrice),
          total: amount(line.total),
        };
      }),
    };
    const posted = yield* Effect.tryPromise({
      try: () =>
        postProviderBill(
          connection.provider,
          config,
          connection,
          bill,
          attachment,
        ),
      catch: (error) =>
        new AccountingPostError({
          reason: error instanceof Error ? error.message : "Nango post failed",
          retryable:
            error instanceof BillRejectedError
              ? false
              : error instanceof NangoRequestError
                ? error.retryable
                : true,
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
          duplicate: false,
        }),
      catch: () =>
        new AccountingPostError({
          reason: "Unable to record accounting post",
          retryable: true,
        }),
    });
    if (posted.right.attachmentError) {
      yield* Effect.logWarning(
        "Accounting bill posted without its attachment",
      ).pipe(
        Effect.annotateLogs({
          invoiceId: invoice.id,
          provider: connection.provider,
          reason: posted.right.attachmentError,
        }),
      );
    }
    return {
      invoiceId: invoice.id,
      status: "posted",
      providerId: posted.right.providerId,
      attached: posted.right.attached,
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
  // Retrying a post held for review is the user's decision that it is not a
  // duplicate: it is sent as its own bill.
  if (invoice.accountingPostStatus === "needs_review") {
    await releaseAccountingPostForReview(db, input);
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
