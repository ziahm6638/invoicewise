import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { type Database, createDatabaseClient } from "@invoicewise/db/client";
import {
  type WorkflowJob,
  enqueueWorkflowJob,
  getExistingInboxAttachments,
  getInboxAccountInfo,
  getTeamById,
  getUserById,
  recordDeletionFailure,
  recordInboxProcessingFailure,
  updateInboxAccount,
} from "@invoicewise/db/queries";
import { createStorageClient } from "@invoicewise/db/storage";
import { INTAKE_LIMITS } from "@invoicewise/documents";
import { GetStartedEmail } from "@invoicewise/email/emails/get-started";
import { InviteEmail } from "@invoicewise/email/emails/invite";
import { TrialEndedEmail } from "@invoicewise/email/emails/trial-ended";
import { TrialExpiringEmail } from "@invoicewise/email/emails/trial-expiring";
import { WelcomeEmail } from "@invoicewise/email/emails/welcome";
import { getI18n } from "@invoicewise/email/locales";
import { render } from "@invoicewise/email/render";
import { InboxConnector } from "@invoicewise/inbox/connector";
import { isAuthenticationError } from "@invoicewise/inbox/utils";
import { ensureFileExtension } from "@invoicewise/utils";
import {
  type TransactionalMessage,
  assertTransactionalMailConfigured,
  isProductionEnv,
  resolveMailSender,
  resolveMailSinkPath,
  sendTransactionalSmtp,
  writeMailSinkRecord,
} from "@invoicewise/utils/transactional-mail";
import {
  Config,
  Context,
  Effect,
  Layer,
  Option,
  Redacted,
  Schema,
} from "effect";
import { nanoid } from "nanoid";
import { type CreateContactOptions, Resend } from "resend";
import { postAccountingDraft } from "./accounting";
import { workflowKey } from "./client";
import { reconcileDeliveries } from "./delivery";
import {
  DeletionCleanupError,
  revokeDeletionConnection,
  runDeletionCleanup,
} from "./deletion";
import {
  acceptIntakeUpload,
  resolveWorkerIntakeBinding,
  verifyStoredIntake,
} from "./intake";
import { isTransientIntakeFailure } from "./intake-failure";
import { processDocumentAttachment } from "./process-document";
import {
  type DeliverWebhookPayload,
  type InitialInboxSetupPayload,
  type InviteTeamMembersPayload,
  type OnboardTeamPayload,
  type PostAccountingDraftPayload,
  type ProcessAttachmentPayload,
  type PurgeDeletedDataPayload,
  type SyncInboxAccountPayload,
  WorkflowRequest,
} from "./schema";
import {
  WebhookDeliveryRepository,
  WebhookTransport,
  WebhookTransportLive,
  deliverWebhook,
  makeWebhookDeliveryRepository,
  publishDeliveryFailureById,
} from "./webhooks";

const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;

export class WorkflowExecutionError extends Schema.TaggedError<WorkflowExecutionError>()(
  "WorkflowExecutionError",
  {
    reason: Schema.String,
    retryable: Schema.Boolean,
    /** The reason safe to show the customer; absent for internal failures. */
    userMessage: Schema.optional(Schema.String),
  },
) {}

/** Recorded on an invoice whose failure is not the document's fault. */
export const TEMPORARY_PROCESSING_FAILURE =
  "A temporary processing problem stopped this invoice from being read. Retry it shortly.";

export class WorkflowDatabase extends Context.Tag(
  "invoicewise/WorkflowDatabase",
)<WorkflowDatabase, { readonly db: Database }>() {}

export class WorkflowStorage extends Context.Tag("invoicewise/WorkflowStorage")<
  WorkflowStorage,
  { readonly client: ReturnType<typeof createStorageClient> }
>() {}

/**
 * A workflow message. A template's own `from` is kept for the local sink only
 * when no AUTH_EMAIL_FROM is configured; SMTP always sends from AUTH_EMAIL_FROM.
 */
export type WorkflowMail = TransactionalMessage & { from?: string };

export class WorkflowMailer extends Context.Tag("invoicewise/WorkflowMailer")<
  WorkflowMailer,
  {
    readonly send: (
      message: WorkflowMail,
    ) => Effect.Effect<void, WorkflowExecutionError>;
    readonly createContact: (
      contact: Omit<CreateContactOptions, "audienceId">,
    ) => Effect.Effect<void, WorkflowExecutionError>;
  }
>() {}

export class WorkflowHandler extends Context.Tag("invoicewise/WorkflowHandler")<
  WorkflowHandler,
  {
    readonly handle: (
      job: WorkflowJob,
    ) => Effect.Effect<Record<string, unknown>, WorkflowExecutionError>;
  }
>() {}

const messageFor = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

const executionError = (error: unknown, fallback: string, retryable = true) =>
  new WorkflowExecutionError({
    reason: messageFor(error, fallback),
    retryable:
      typeof error === "object" &&
      error !== null &&
      "retryable" in error &&
      typeof error.retryable === "boolean"
        ? error.retryable
        : retryable,
    userMessage:
      typeof error === "object" &&
      error !== null &&
      "userMessage" in error &&
      typeof error.userMessage === "string"
        ? error.userMessage
        : undefined,
  });

const attempt = <A>(
  run: () => Promise<A>,
  fallback: string,
  retryable = true,
) =>
  Effect.tryPromise({
    try: run,
    catch: (error) => executionError(error, fallback, retryable),
  });

const decode = <A, I>(schema: Schema.Schema<A, I>, value: unknown) =>
  Schema.decodeUnknown(schema)(value).pipe(
    Effect.mapError(
      () =>
        new WorkflowExecutionError({
          reason: "Workflow payload is invalid",
          retryable: false,
        }),
    ),
  );

const ensureTeam = (job: WorkflowJob, teamId: string) =>
  job.teamId === teamId
    ? Effect.void
    : Effect.fail(
        new WorkflowExecutionError({
          reason: "Workflow team does not match its payload",
          retryable: false,
        }),
      );

const nextInboxSync = (accountId: string, now = new Date()) => {
  const minute =
    Array.from(accountId).reduce(
      (sum, character) => sum + character.charCodeAt(0),
      0,
    ) % 60;
  const next = new Date(now);
  next.setUTCSeconds(0, 0);
  next.setUTCMinutes(minute);
  next.setUTCHours(Math.floor(now.getUTCHours() / 6) * 6);
  if (next <= now) next.setUTCHours(next.getUTCHours() + 6);
  return next;
};

export const WorkflowDatabaseLive = Layer.scoped(
  WorkflowDatabase,
  Effect.acquireRelease(
    Config.all({
      primaryUrl: Config.redacted("DATABASE_PRIMARY_URL"),
      environment: Config.string("NODE_ENV").pipe(
        Config.withDefault("production"),
      ),
    }).pipe(
      Effect.map((config) =>
        createDatabaseClient({
          primaryUrl: Redacted.value(config.primaryUrl),
          isDevelopment: config.environment === "development",
        }),
      ),
    ),
    (client) => Effect.promise(() => client.close()),
  ).pipe(Effect.map((client) => ({ db: client.db }))),
);

export const WorkflowStorageLive = Layer.effect(
  WorkflowStorage,
  Effect.gen(function* () {
    const backend = yield* Config.string("STORAGE_BACKEND").pipe(
      Config.withDefault("local"),
    );
    const publicUrl = yield* Config.string("STORAGE_PUBLIC_URL").pipe(
      Config.withDefault("http://localhost:3003"),
    );
    const signingSecret = yield* Config.option(
      Config.redacted("STORAGE_SIGNING_SECRET"),
    );
    const legacySigningSecret = yield* Config.option(
      Config.redacted("LOCAL_STORAGE_SIGNING_SECRET"),
    );
    const common = {
      publicUrl,
      signingSecret: Option.isSome(signingSecret)
        ? Redacted.value(signingSecret.value)
        : Option.isSome(legacySigningSecret)
          ? Redacted.value(legacySigningSecret.value)
          : undefined,
    };

    if (backend === "local") {
      const rootPath = yield* Config.string("LOCAL_STORAGE_PATH").pipe(
        Config.withDefault(resolve(tmpdir(), "invoicewise-storage")),
      );
      return {
        client: createStorageClient({
          ...common,
          backend,
          rootPath,
        }),
      };
    }

    if (backend !== "s3") {
      return yield* Effect.dieMessage(
        `Unsupported STORAGE_BACKEND: ${backend}`,
      );
    }

    const config = yield* Config.all({
      endpoint: Config.string("STORAGE_S3_ENDPOINT"),
      bucket: Config.string("STORAGE_S3_BUCKET"),
      accessKeyId: Config.string("STORAGE_S3_ACCESS_KEY_ID"),
      secretAccessKey: Config.redacted("STORAGE_S3_SECRET_ACCESS_KEY"),
      region: Config.string("STORAGE_S3_REGION").pipe(
        Config.withDefault("auto"),
      ),
      forcePathStyle: Config.boolean("STORAGE_S3_FORCE_PATH_STYLE").pipe(
        Config.withDefault(false),
      ),
    });
    return {
      client: createStorageClient({
        ...common,
        backend,
        endpoint: config.endpoint,
        bucket: config.bucket,
        accessKeyId: config.accessKeyId,
        secretAccessKey: Redacted.value(config.secretAccessKey),
        region: config.region,
        forcePathStyle: config.forcePathStyle,
      }),
    };
  }),
);

export const WorkflowMailerLive = Layer.effect(
  WorkflowMailer,
  Config.all({
    smtpHost: Config.option(Config.string("SMTP_HOST")),
    smtpPort: Config.option(Config.string("SMTP_PORT")),
    smtpUser: Config.option(Config.string("SMTP_USER")),
    smtpPass: Config.option(Config.redacted("SMTP_PASS")),
    sender: Config.option(Config.string("AUTH_EMAIL_FROM")),
    sinkPath: Config.option(Config.string("AUTH_MAIL_SINK_PATH")),
    resendApiKey: Config.option(Config.redacted("RESEND_API_KEY")),
    audienceId: Config.option(Config.string("RESEND_AUDIENCE_ID")),
  }).pipe(
    Effect.map((config) => {
      // The same transactional-mail policy as the API: mail goes through
      // Purelymail over SMTP, the configured AUTH_EMAIL_FROM is the sender for
      // every workflow message, and a non-production AUTH_MAIL_SINK_PATH
      // captures the real message locally instead of contacting a server.
      const mailEnv = {
        ...process.env,
        SMTP_HOST: Option.getOrUndefined(config.smtpHost),
        SMTP_PORT: Option.getOrUndefined(config.smtpPort),
        SMTP_USER: Option.getOrUndefined(config.smtpUser),
        SMTP_PASS: Option.isSome(config.smtpPass)
          ? Redacted.value(config.smtpPass.value)
          : undefined,
        AUTH_EMAIL_FROM: Option.getOrUndefined(config.sender),
        AUTH_MAIL_SINK_PATH: Option.getOrUndefined(config.sinkPath),
      } as NodeJS.ProcessEnv;
      const sender = resolveMailSender(mailEnv);
      const sinkPath = resolveMailSinkPath(mailEnv);

      // The worker runs on its own, without the API's auth import, so it
      // enforces the same fail-closed production policy before it can send
      // anything: missing SMTP credentials or a missing sender refuse the
      // mailer instead of falling back to a template's sender.
      if (isProductionEnv(mailEnv)) {
        assertTransactionalMailConfigured(mailEnv);
      }

      // The marketing audience is optional and is not transactional mail: it
      // stays on Resend and is skipped unless both values are configured.
      const resendApiKey = Option.isSome(config.resendApiKey)
        ? Redacted.value(config.resendApiKey.value).trim()
        : "";
      const audienceId = Option.getOrElse(config.audienceId, () => "").trim();
      const audience =
        resendApiKey && audienceId
          ? { client: new Resend(resendApiKey), audienceId }
          : null;

      const applySender = (message: WorkflowMail): WorkflowMail =>
        sender ? { ...message, from: sender } : message;

      const deliver = async (message: WorkflowMail): Promise<void> => {
        const final = applySender(message);
        if (sinkPath) {
          await writeMailSinkRecord(sinkPath, {
            at: new Date().toISOString(),
            to: Array.isArray(final.to) ? final.to.join(",") : final.to,
            from: final.from ?? null,
            subject: final.subject,
            html: final.html ?? null,
            text: final.text ?? null,
          });
          return;
        }
        const { from: _templateSender, ...smtpMessage } = final;
        await sendTransactionalSmtp(smtpMessage, mailEnv);
      };

      return {
        send: (message: WorkflowMail) =>
          attempt(() => deliver(message), "Unable to send email"),
        createContact: (contact: Omit<CreateContactOptions, "audienceId">) =>
          attempt(async () => {
            // Local capture must not reach the provider's contact store.
            if (sinkPath || !audience) return;
            const response = await audience.client.contacts.create({
              ...contact,
              audienceId: audience.audienceId,
            });
            if (response.error) throw new Error(response.error.message);
          }, "Unable to create email contact"),
      };
    }),
  ),
);

const makeProcessAttachment = (
  db: Database,
  storage: ReturnType<typeof createStorageClient>,
) =>
  Effect.fn("processAttachmentWorkflow")(function* (
    job: WorkflowJob,
    payload: ProcessAttachmentPayload,
  ) {
    yield* ensureTeam(job, payload.teamId);
    // Path, type and size always come from the persisted workspace binding.
    // Nothing serialized in the payload is trusted as ownership proof.
    const binding = yield* attempt(
      () => resolveWorkerIntakeBinding(db, payload),
      "Unable to resolve invoice document binding",
    );

    if (!binding?.filePath?.length) {
      return yield* Effect.fail(
        new WorkflowExecutionError({
          reason: "Invoice document is not authorized for this workspace",
          retryable: false,
        }),
      );
    }

    // Extraction already completed (a replay, or a worker that died after
    // the completion commit). Its deliveries were scheduled in that same
    // transaction; resume any that lost their job instead of returning early.
    const resumeDeliveries = () =>
      attempt(
        () =>
          reconcileDeliveries(
            db,
            { teamId: payload.teamId, invoiceId: binding.id },
            (deliveryId, teamId) =>
              publishDeliveryFailureById(db, deliveryId, teamId),
          ),
        "Unable to resume invoice deliveries",
      );

    if (binding.status !== "processing") {
      const resumed = yield* resumeDeliveries();
      return { inboxId: binding.id, idempotent: true, ...resumed };
    }

    const inboxItem = binding;
    const filePath = [...binding.filePath];

    const processing = Effect.gen(function* () {
      const file = yield* attempt(
        () => storage.download({ bucket: "vault", path: filePath }),
        "Unable to load invoice attachment",
      );
      const bytes = Buffer.from(
        yield* Effect.promise(() => file.arrayBuffer()),
      );

      const stored = verifyStoredIntake(binding, bytes);
      if (!stored.ok) {
        return yield* Effect.fail(
          new WorkflowExecutionError({
            reason: stored.message,
            retryable: false,
          }),
        );
      }

      const mimetype = stored.mimeType;
      const team = yield* attempt(
        () => getTeamById(db, payload.teamId),
        "Unable to load invoice team",
      );
      const processed = yield* attempt(
        () =>
          processDocumentAttachment(db, {
            inboxId: inboxItem.id,
            teamId: payload.teamId,
            documentUrl: `data:${mimetype};base64,${bytes.toString("base64")}`,
            mimetype,
            companyName: team?.name,
          }),
        "Unable to process invoice",
      );
      const { completion } = processed;
      if (!completion) {
        // A concurrent worker completed the revision first; its transaction
        // scheduled the deliveries.
        const resumed = yield* resumeDeliveries();
        return { inboxId: inboxItem.id, idempotent: true, ...resumed };
      }
      return {
        inboxId: inboxItem.id,
        revision: completion.revision,
        type: processed.result.type ?? null,
        judgments: processed.result.judgments?.length ?? 0,
        webhooksScheduled: completion.scheduled.webhooks,
        accountingQueued: completion.scheduled.accounting,
      };
    });

    return yield* processing.pipe(
      // A final failure is recorded on the invoice in the same shape for
      // every input format: the customer sees the document's problem or a
      // generic retry message, and the internal detail stays in the logs. A
      // retryable failure waits for the next attempt.
      Effect.tapError((error) =>
        !error.retryable || job.attempts >= job.maxAttempts
          ? Effect.logWarning("invoice_processing_failed").pipe(
              Effect.annotateLogs({
                inboxId: inboxItem.id,
                reason: error.reason,
              }),
              Effect.zipRight(
                attempt(
                  () =>
                    recordInboxProcessingFailure(db, {
                      id: inboxItem.id,
                      teamId: payload.teamId,
                      error: error.userMessage ?? TEMPORARY_PROCESSING_FAILURE,
                    }).then(() => undefined),
                  "Unable to update failed invoice",
                ),
              ),
              Effect.ignore,
            )
          : Effect.void,
      ),
    );
  });

const makeSyncInboxAccount = (
  db: Database,
  storage: ReturnType<typeof createStorageClient>,
) =>
  Effect.fn("syncInboxAccountWorkflow")(function* (
    job: WorkflowJob,
    payload: SyncInboxAccountPayload,
  ) {
    const account = yield* attempt(
      () => getInboxAccountInfo(db, { id: payload.id }),
      "Unable to load inbox account",
    );
    if (!account) return { accountId: payload.id, skipped: true };
    yield* ensureTeam(job, account.teamId);
    if (account.provider !== "gmail") {
      return yield* Effect.fail(
        new WorkflowExecutionError({
          reason: `Unsupported inbox provider: ${account.provider}`,
          retryable: false,
        }),
      );
    }
    const provider = account.provider;

    const scheduleNextSync = async () => {
      if (!payload.scheduleNext) return;
      const runAt = nextInboxSync(payload.id);
      await enqueueWorkflowJob(db, {
        name: "sync-inbox-account",
        teamId: account.teamId,
        payload: { id: payload.id, scheduleNext: true },
        runAt,
        idempotencyKey: workflowKey.inboxSync(payload.id, runAt.toISOString()),
      });
    };

    const syncing = attempt(async () => {
      const connector = new InboxConnector(provider, db);
      const attachments = await connector.getAttachments({
        id: payload.id,
        teamId: account.teamId,
        maxResults: 50,
        lastAccessed: account.lastAccessed,
        fullSync: payload.manualSync ?? false,
      });
      const existing = await getExistingInboxAttachments(
        db,
        account.teamId,
        attachments.map(({ referenceId }) => referenceId),
      );
      const known = new Set(existing.map(({ referenceId }) => referenceId));
      let queued = 0;
      const transientFailures: string[] = [];
      const rejectedAttachments: string[] = [];

      for (const attachment of attachments) {
        if (
          known.has(attachment.referenceId) ||
          attachment.size > INTAKE_LIMITS.maxBytes
        ) {
          continue;
        }

        // Mailbox attachments use the same server-owned intake contract as
        // uploads: reserve, store immutably, validate, then queue.
        const accepted = await acceptIntakeUpload(db, storage, {
          teamId: account.teamId,
          bytes: attachment.data,
          declaredMimeType: attachment.mimeType,
          fileName: ensureFileExtension(
            attachment.filename,
            attachment.mimeType,
          ),
          website: attachment.website,
          referenceId: attachment.referenceId,
          inboxAccountId: payload.id,
        });
        if (accepted.status === "accepted") {
          queued += 1;
        } else if (isTransientIntakeFailure(accepted.code)) {
          // Transient: keep the attempt recoverable by failing the sync job
          // rather than marking the account synced.
          transientFailures.push(
            `${attachment.referenceId}: ${accepted.message}`,
          );
        } else {
          // Permanent rejection: visible in the job result, not retried.
          rejectedAttachments.push(
            `${attachment.referenceId} (${accepted.code}): ${accepted.message}`,
          );
        }
      }

      if (transientFailures.length > 0) {
        throw new Error(
          `Mailbox intake could not store ${transientFailures.length} attachment(s): ${transientFailures.join("; ")}`,
        );
      }

      await updateInboxAccount(db, {
        id: payload.id,
        lastAccessed: new Date().toISOString(),
        status: "connected",
        errorMessage: null,
      });

      await scheduleNextSync();

      return {
        accountId: payload.id,
        attachmentsProcessed: queued,
        attachmentsRejected: rejectedAttachments,
        syncedAt: new Date().toISOString(),
      };
    }, "Unable to sync inbox account");

    return yield* syncing.pipe(
      Effect.tapError((error) =>
        isAuthenticationError(error.reason)
          ? attempt(
              () =>
                updateInboxAccount(db, {
                  id: payload.id,
                  status: "disconnected",
                  errorMessage: `Authentication failed: ${error.reason}`,
                }).then(() => undefined),
              "Unable to mark inbox account disconnected",
            ).pipe(Effect.ignore)
          : Effect.void,
      ),
      // The schedule is a chain: each run enqueues the next. A run that has
      // exhausted its retries still enqueues the next slot (the key is the
      // slot time, so this never duplicates) without advancing lastAccessed,
      // so one failing message or outage cannot stop the mailbox for good.
      Effect.tapError((error) =>
        !error.retryable || job.attempts >= job.maxAttempts
          ? attempt(
              scheduleNextSync,
              "Unable to schedule the next inbox sync",
            ).pipe(
              Effect.catchAll((scheduleError) =>
                Effect.logError("inbox_sync_schedule_failed").pipe(
                  Effect.annotateLogs({
                    event: "inbox_sync_schedule_failed",
                    accountId: payload.id,
                    error: scheduleError.reason,
                  }),
                ),
              ),
            )
          : Effect.void,
      ),
    );
  });

const makeInitialInboxSetup = (db: Database) =>
  Effect.fn("initialInboxSetupWorkflow")(function* (
    payload: InitialInboxSetupPayload,
  ) {
    const account = yield* attempt(
      () => getInboxAccountInfo(db, { id: payload.id }),
      "Unable to load inbox account",
    );
    if (!account) return { accountId: payload.id, skipped: true };
    const queued = yield* attempt(
      () =>
        enqueueWorkflowJob(db, {
          name: "sync-inbox-account",
          teamId: account.teamId,
          payload: {
            id: payload.id,
            manualSync: true,
            scheduleNext: true,
          },
          idempotencyKey: workflowKey.inboxSync(payload.id, "initial"),
        }),
      "Unable to queue initial inbox sync",
    );
    return { accountId: payload.id, syncWorkflowId: queued.job.id };
  });

const makeInviteTeamMembers = (mailer: WorkflowMailer["Type"]) =>
  Effect.fn("inviteTeamMembersWorkflow")(function* (
    job: WorkflowJob,
    payload: InviteTeamMembersPayload,
  ) {
    yield* ensureTeam(job, payload.teamId);
    const { t } = getI18n({ locale: payload.locale });
    const { invite } = payload;
    const html = yield* Effect.sync(() =>
      render(
        InviteEmail({
          invitedByEmail: invite.invitedByEmail,
          invitedByName: invite.invitedByName,
          email: invite.email,
          teamName: invite.teamName,
          ip: payload.ip,
          locale: payload.locale,
        }),
      ),
    );
    yield* mailer.send({
      from: "InvoiceWise <hello@invoicewise.uk>",
      to: [invite.email],
      subject: t("invite.subject", {
        invitedByName: invite.invitedByName,
        teamName: invite.teamName,
      }),
      headers: { "X-Entity-Ref-ID": nanoid() },
      html,
    });
    return { invitationsSent: 1 };
  });

type OnboardingStage = NonNullable<OnboardTeamPayload["stage"]>;

const onboardingDelay: Partial<Record<OnboardingStage, number>> = {
  welcome: 3,
  "get-started": 11,
  "trial-expiring": 15,
};

const nextOnboardingStage: Partial<Record<OnboardingStage, OnboardingStage>> = {
  welcome: "get-started",
  "get-started": "trial-expiring",
  "trial-expiring": "trial-ended",
};

const makeOnboardTeam = (db: Database, mailer: WorkflowMailer["Type"]) =>
  Effect.fn("onboardTeamWorkflow")(function* (
    job: WorkflowJob,
    payload: OnboardTeamPayload,
  ) {
    const stage = payload.stage ?? "welcome";
    const user = yield* attempt(
      () => getUserById(db, payload.userId),
      "Unable to load onboarding user",
      false,
    );
    if (!user?.fullName || !user.email) {
      return yield* Effect.fail(
        new WorkflowExecutionError({
          reason: "Onboarding user data is missing",
          retryable: false,
        }),
      );
    }
    if (job.teamId && user.teamId !== job.teamId) {
      return yield* Effect.fail(
        new WorkflowExecutionError({
          reason: "Workflow team does not match its onboarding user",
          retryable: false,
        }),
      );
    }
    const [firstName, ...lastName] = user.fullName.split(" ");

    if (stage === "welcome") {
      yield* mailer.createContact({
        email: user.email,
        firstName,
        lastName: lastName.join(" "),
        unsubscribed: false,
      });
      yield* mailer.send({
        to: user.email,
        subject: "Welcome to InvoiceWise",
        from: "InvoiceWise <hello@invoicewise.uk>",
        html: yield* Effect.sync(() =>
          render(WelcomeEmail({ fullName: user.fullName! })),
        ),
      });
    } else if (user.team?.plan === "trial") {
      const email =
        stage === "get-started"
          ? {
              subject: "Get the most out of InvoiceWise",
              html: yield* Effect.sync(() =>
                render(GetStartedEmail({ fullName: user.fullName! })),
              ),
            }
          : stage === "trial-expiring"
            ? {
                subject: "Your trial is expiring soon",
                html: yield* Effect.sync(() =>
                  render(TrialExpiringEmail({ fullName: user.fullName! })),
                ),
              }
            : {
                subject: "Your trial has ended",
                html: yield* Effect.sync(() =>
                  render(TrialEndedEmail({ fullName: user.fullName! })),
                ),
              };
      yield* mailer.send({
        from: "InvoiceWise <hello@invoicewise.uk>",
        to: user.email,
        ...email,
      });
    }

    const nextStage = nextOnboardingStage[stage];
    const delayDays = onboardingDelay[stage];
    if (nextStage && delayDays && user.teamId) {
      const runAt = new Date(Date.now() + delayDays * 86_400_000);
      yield* attempt(
        () =>
          enqueueWorkflowJob(db, {
            name: "onboard-team",
            teamId: user.teamId!,
            payload: { userId: payload.userId, stage: nextStage },
            runAt,
            idempotencyKey: workflowKey.onboarding(payload.userId, nextStage),
          }),
        "Unable to queue onboarding follow-up",
      );
    }
    return { userId: payload.userId, stage };
  });

const makePurgeDeletedData = (
  db: Database,
  storage: ReturnType<typeof createStorageClient>,
) =>
  Effect.fn("purgeDeletedDataWorkflow")(function* (
    job: WorkflowJob,
    payload: PurgeDeletedDataPayload,
  ) {
    const outcome = yield* Effect.tryPromise({
      try: () =>
        runDeletionCleanup(
          {
            db,
            storage,
            revokeConnection: (connection) =>
              revokeDeletionConnection(connection),
          },
          payload.deletionId,
        ),
      catch: (error) =>
        new WorkflowExecutionError({
          reason:
            error instanceof Error ? error.message : "Deletion cleanup failed",
          retryable: !(
            error instanceof DeletionCleanupError && !error.retryable
          ),
        }),
    }).pipe(
      // The deletion request keeps its progress and the reason for every
      // failed run, and is marked failed once the job gives up, so an
      // exhausted cleanup is visible to operators and can be resumed.
      Effect.tapError((error) =>
        attempt(
          () =>
            recordDeletionFailure(db, {
              id: payload.deletionId,
              error: error.reason,
              final: !error.retryable || job.attempts >= job.maxAttempts,
            }),
          "Unable to record deletion failure",
        ).pipe(
          Effect.catchAll((recordError) =>
            Effect.logError("deletion_failure_record_failed").pipe(
              Effect.annotateLogs({
                event: "deletion_failure_record_failed",
                deletionId: payload.deletionId,
                error: recordError.reason,
              }),
            ),
          ),
        ),
      ),
      Effect.tapError((error) =>
        Effect.logError("deletion_cleanup_failed").pipe(
          Effect.annotateLogs({
            event: "deletion_cleanup_failed",
            deletionId: payload.deletionId,
            attempt: job.attempts,
            error: error.reason,
          }),
        ),
      ),
    );

    if (outcome.status === "waiting") {
      // Objects are purged after the quiesce time; schedule that run instead
      // of holding a worker or spending a retry.
      yield* attempt(
        () =>
          enqueueWorkflowJob(db, {
            name: "purge-deleted-data",
            payload: { deletionId: payload.deletionId },
            runAt: new Date(outcome.resumeAt),
            idempotencyKey: workflowKey.deletionResume(
              payload.deletionId,
              outcome.resumeAt,
            ),
            maxAttempts: job.maxAttempts,
          }),
        "Unable to schedule deletion cleanup",
      );
    }

    return outcome;
  });

export const WorkflowHandlerLive = Layer.effect(
  WorkflowHandler,
  Effect.gen(function* () {
    const { db } = yield* WorkflowDatabase;
    const { client: storage } = yield* WorkflowStorage;
    const mailer = yield* WorkflowMailer;
    const processAttachment = makeProcessAttachment(db, storage);
    const syncInboxAccount = makeSyncInboxAccount(db, storage);
    const initialInboxSetup = makeInitialInboxSetup(db);
    const inviteTeamMembers = makeInviteTeamMembers(mailer);
    const onboardTeam = makeOnboardTeam(db, mailer);
    const purgeDeletedData = makePurgeDeletedData(db, storage);
    const webhookRepository = makeWebhookDeliveryRepository(db);
    const postAccountingDraftJob = (
      job: WorkflowJob,
      payload: PostAccountingDraftPayload,
    ) =>
      postAccountingDraft(db, storage, {
        ...payload,
        attempt: job.attempts,
        maxAttempts: job.maxAttempts,
      }).pipe(
        Effect.mapError(
          (error) =>
            new WorkflowExecutionError({
              reason: error.reason,
              retryable: error.retryable,
            }),
        ),
      );
    const deliverWebhookJob = (
      job: WorkflowJob,
      payload: DeliverWebhookPayload,
    ) =>
      deliverWebhook({
        deliveryId: payload.deliveryId,
        teamId: payload.teamId,
        attempt: job.attempts,
        maxAttempts: job.maxAttempts,
      }).pipe(
        Effect.provideService(WebhookDeliveryRepository, webhookRepository),
        Effect.provideService(WebhookTransport, WebhookTransportLive),
        Effect.mapError(
          (error) =>
            new WorkflowExecutionError({
              reason: error.reason,
              retryable: error.retryable,
            }),
        ),
      );

    return {
      handle: (job: WorkflowJob) =>
        Effect.gen(function* () {
          const request = yield* decode(WorkflowRequest, {
            name: job.name,
            payload: job.payload,
          });
          switch (request.name) {
            case "process-attachment":
              return yield* processAttachment(job, request.payload);
            case "sync-inbox-account":
              return yield* syncInboxAccount(job, request.payload);
            case "initial-inbox-setup":
              return yield* initialInboxSetup(request.payload);
            case "invite-team-members":
              return yield* inviteTeamMembers(job, request.payload);
            case "onboard-team":
              return yield* onboardTeam(job, request.payload);
            case "deliver-webhook":
              return yield* deliverWebhookJob(job, request.payload);
            case "post-accounting-draft":
              return yield* postAccountingDraftJob(job, request.payload);
            case "purge-deleted-data":
              return yield* purgeDeletedData(job, request.payload);
          }
        }) as Effect.Effect<Record<string, unknown>, WorkflowExecutionError>,
    };
  }),
);

export const WorkflowInfrastructureLive = Layer.mergeAll(
  WorkflowDatabaseLive,
  WorkflowStorageLive,
  WorkflowMailerLive,
);
