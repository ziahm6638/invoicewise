import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { type Database, createDatabaseClient } from "@midday/db/client";
import {
  type WorkflowJob,
  createInbox,
  enqueueWorkflowJob,
  getExistingInboxAttachments,
  getInboxAccountInfo,
  getInboxByFilePath,
  getTeamById,
  getUserById,
  updateInbox,
  updateInboxAccount,
} from "@midday/db/queries";
import { createStorageClient } from "@midday/db/storage";
import { GetStartedEmail } from "@midday/email/emails/get-started";
import { InviteEmail } from "@midday/email/emails/invite";
import { TrialEndedEmail } from "@midday/email/emails/trial-ended";
import { TrialExpiringEmail } from "@midday/email/emails/trial-expiring";
import { WelcomeEmail } from "@midday/email/emails/welcome";
import { getI18n } from "@midday/email/locales";
import { render } from "@midday/email/render";
import { InboxConnector } from "@midday/inbox/connector";
import { isAuthenticationError } from "@midday/inbox/utils";
import { ensureFileExtension } from "@midday/utils";
import {
  Config,
  Context,
  Effect,
  Layer,
  Option,
  Redacted,
  Schema,
} from "effect";
import convert from "heic-convert";
import { nanoid } from "nanoid";
import {
  type CreateBatchOptions,
  type CreateContactOptions,
  type CreateEmailOptions,
  Resend,
} from "resend";
import sharp from "sharp";
import { workflowKey } from "./client";
import { processDocumentAttachment } from "./process-document";
import {
  type DeliverWebhookPayload,
  type InitialInboxSetupPayload,
  type InviteTeamMembersPayload,
  type OnboardTeamPayload,
  type ProcessAttachmentPayload,
  type SyncInboxAccountPayload,
  WorkflowRequest,
} from "./schema";
import {
  WebhookDeliveryRepository,
  WebhookTransport,
  WebhookTransportLive,
  deliverWebhook,
  makeWebhookDeliveryRepository,
} from "./webhooks";

const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;
const HEIC_MAX_WIDTH = 1500;

export class WorkflowExecutionError extends Schema.TaggedError<WorkflowExecutionError>()(
  "WorkflowExecutionError",
  {
    reason: Schema.String,
    retryable: Schema.Boolean,
  },
) {}

export class WorkflowDatabase extends Context.Tag(
  "invoicewise/WorkflowDatabase",
)<WorkflowDatabase, { readonly db: Database }>() {}

export class WorkflowStorage extends Context.Tag("invoicewise/WorkflowStorage")<
  WorkflowStorage,
  { readonly client: ReturnType<typeof createStorageClient> }
>() {}

export class WorkflowMailer extends Context.Tag("invoicewise/WorkflowMailer")<
  WorkflowMailer,
  {
    readonly send: (
      message: CreateEmailOptions,
    ) => Effect.Effect<void, WorkflowExecutionError>;
    readonly batch: (
      messages: CreateBatchOptions,
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
    apiKey: Config.option(Config.redacted("RESEND_API_KEY")),
    audienceId: Config.option(Config.string("RESEND_AUDIENCE_ID")),
  }).pipe(
    Effect.map((config) => {
      const resend = Option.isSome(config.apiKey)
        ? new Resend(Redacted.value(config.apiKey.value))
        : null;
      const requireClient = () => {
        if (!resend) throw new Error("RESEND_API_KEY is not configured");
        return resend;
      };
      return {
        send: (message: CreateEmailOptions) =>
          attempt(async () => {
            const response = await requireClient().emails.send(message);
            if (response.error) throw new Error(response.error.message);
          }, "Unable to send email"),
        batch: (messages: CreateBatchOptions) =>
          attempt(async () => {
            const response = await requireClient().batch.send(messages);
            if (response.error) throw new Error(response.error.message);
          }, "Unable to send email batch"),
        createContact: (contact: Omit<CreateContactOptions, "audienceId">) =>
          attempt(async () => {
            if (Option.isNone(config.audienceId)) {
              throw new Error("RESEND_AUDIENCE_ID is not configured");
            }
            const response = await requireClient().contacts.create({
              ...contact,
              audienceId: config.audienceId.value,
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
    const existing = yield* attempt(
      () =>
        getInboxByFilePath(db, {
          filePath: [...payload.filePath],
          teamId: payload.teamId,
        }),
      "Unable to find invoice record",
    );
    if (existing && existing.status !== "processing") {
      return { inboxId: existing.id, idempotent: true };
    }

    const inboxItem =
      existing ??
      (yield* attempt(
        () =>
          createInbox(db, {
            displayName: payload.filePath.at(-1) ?? "Unknown",
            teamId: payload.teamId,
            filePath: [...payload.filePath],
            fileName: payload.filePath.at(-1) ?? "Unknown",
            contentType: payload.mimetype,
            size: payload.size,
            referenceId: payload.referenceId,
            website: payload.website,
            inboxAccountId: payload.inboxAccountId,
            status: "processing",
          }),
        "Unable to create invoice record",
      ));
    if (!inboxItem) {
      return yield* Effect.fail(
        new WorkflowExecutionError({
          reason: "Unable to create invoice record",
          retryable: true,
        }),
      );
    }

    const processing = Effect.gen(function* () {
      let mimetype = payload.mimetype;
      const file = yield* attempt(
        () =>
          storage.download({ bucket: "vault", path: [...payload.filePath] }),
        "Unable to load invoice attachment",
      );
      let bytes: Buffer<ArrayBufferLike> = Buffer.from(
        yield* Effect.promise(() => file.arrayBuffer()),
      );

      if (mimetype === "image/heic") {
        const decoded = yield* attempt(
          () =>
            convert({
              buffer: bytes.buffer.slice(
                bytes.byteOffset,
                bytes.byteOffset + bytes.byteLength,
              ) as ArrayBuffer,
              format: "JPEG",
              quality: 1,
            }),
          "Unable to decode HEIC attachment",
          false,
        );
        const image = yield* attempt(
          () =>
            sharp(decoded)
              .rotate()
              .resize({ width: HEIC_MAX_WIDTH })
              .jpeg()
              .toBuffer(),
          "Unable to convert HEIC attachment",
          false,
        );
        yield* attempt(
          () =>
            storage.upload({
              bucket: "vault",
              path: [...payload.filePath],
              file: image,
            }),
          "Unable to store converted attachment",
        );
        mimetype = "image/jpeg";
        bytes = image;
      }

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
      return {
        inboxId: inboxItem.id,
        type: processed.result.type ?? null,
        judgments: processed.result.judgments?.length ?? 0,
      };
    });

    return yield* processing.pipe(
      Effect.tapError((error) =>
        !error.retryable || job.attempts >= job.maxAttempts
          ? attempt(
              () =>
                updateInbox(db, {
                  id: inboxItem.id,
                  teamId: payload.teamId,
                  status: "pending",
                }).then(() => undefined),
              "Unable to update failed invoice",
            ).pipe(Effect.ignore)
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
        attachments.map(({ referenceId }) => referenceId),
      );
      const known = new Set(existing.map(({ referenceId }) => referenceId));
      let queued = 0;

      for (const attachment of attachments) {
        if (
          known.has(attachment.referenceId) ||
          attachment.size > MAX_ATTACHMENT_SIZE
        ) {
          continue;
        }
        const filename = ensureFileExtension(
          attachment.filename,
          attachment.mimeType,
        );
        const uploaded = await storage.upload({
          bucket: "vault",
          path: `${account.teamId}/inbox/${filename}`,
          file: attachment.data,
        });
        const filePath = uploaded.path.split("/");
        await enqueueWorkflowJob(db, {
          name: "process-attachment",
          teamId: account.teamId,
          payload: {
            filePath,
            size: attachment.size,
            mimetype: attachment.mimeType,
            website: attachment.website,
            referenceId: attachment.referenceId,
            teamId: account.teamId,
            inboxAccountId: payload.id,
          },
          idempotencyKey: workflowKey.attachment(
            account.teamId,
            filePath,
            attachment.referenceId,
          ),
        });
        queued += 1;
      }

      await updateInboxAccount(db, {
        id: payload.id,
        lastAccessed: new Date().toISOString(),
        status: "connected",
        errorMessage: null,
      });

      if (payload.scheduleNext) {
        const runAt = nextInboxSync(payload.id);
        await enqueueWorkflowJob(db, {
          name: "sync-inbox-account",
          teamId: account.teamId,
          payload: { id: payload.id, scheduleNext: true },
          runAt,
          idempotencyKey: workflowKey.inboxSync(
            payload.id,
            runAt.toISOString(),
          ),
        });
      }

      return {
        accountId: payload.id,
        attachmentsProcessed: queued,
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
    const messages = yield* Effect.forEach(payload.invites, (invite) =>
      Effect.promise(async () => ({
        from: "InvoiceWise <hello@invoicewise.uk>",
        to: [invite.email],
        subject: t("invite.subject", {
          invitedByName: invite.invitedByName,
          teamName: invite.teamName,
        }),
        headers: { "X-Entity-Ref-ID": nanoid() },
        html: await render(
          InviteEmail({
            invitedByEmail: invite.invitedByEmail,
            invitedByName: invite.invitedByName,
            email: invite.email,
            teamName: invite.teamName,
            ip: payload.ip,
            locale: payload.locale,
          }),
        ),
      })),
    );
    yield* mailer.batch(messages);
    return { invitationsSent: messages.length };
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
    const webhookRepository = makeWebhookDeliveryRepository(db);
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
