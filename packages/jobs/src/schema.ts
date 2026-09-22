import { Schema } from "effect";

export const ProcessAttachmentPayload = Schema.Struct({
  teamId: Schema.String,
  mimetype: Schema.String,
  size: Schema.Number,
  filePath: Schema.Array(Schema.String),
  referenceId: Schema.optional(Schema.String),
  website: Schema.optional(Schema.String),
  inboxAccountId: Schema.optional(Schema.String),
});
export type ProcessAttachmentPayload = typeof ProcessAttachmentPayload.Type;

export const SyncInboxAccountPayload = Schema.Struct({
  id: Schema.String,
  manualSync: Schema.optional(Schema.Boolean),
  scheduleNext: Schema.optional(Schema.Boolean),
});
export type SyncInboxAccountPayload = typeof SyncInboxAccountPayload.Type;

export const InitialInboxSetupPayload = Schema.Struct({ id: Schema.String });
export type InitialInboxSetupPayload = typeof InitialInboxSetupPayload.Type;

export const InviteTeamMembersPayload = Schema.Struct({
  teamId: Schema.String,
  ip: Schema.String,
  locale: Schema.String,
  invites: Schema.Array(
    Schema.Struct({
      email: Schema.String,
      invitedByName: Schema.String,
      invitedByEmail: Schema.String,
      teamName: Schema.String,
      inviteCode: Schema.optional(Schema.String),
    }),
  ),
});
export type InviteTeamMembersPayload = typeof InviteTeamMembersPayload.Type;

export const OnboardTeamPayload = Schema.Struct({
  userId: Schema.String,
  stage: Schema.optional(
    Schema.Literal("welcome", "get-started", "trial-expiring", "trial-ended"),
  ),
});
export type OnboardTeamPayload = typeof OnboardTeamPayload.Type;

export const DeliverWebhookPayload = Schema.Struct({
  deliveryId: Schema.String,
  teamId: Schema.String,
});
export type DeliverWebhookPayload = typeof DeliverWebhookPayload.Type;

export const PostAccountingDraftPayload = Schema.Struct({
  invoiceId: Schema.String,
  teamId: Schema.String,
});
export type PostAccountingDraftPayload = typeof PostAccountingDraftPayload.Type;

export const WorkflowRequest = Schema.Union(
  Schema.Struct({
    name: Schema.Literal("process-attachment"),
    payload: ProcessAttachmentPayload,
  }),
  Schema.Struct({
    name: Schema.Literal("sync-inbox-account"),
    payload: SyncInboxAccountPayload,
  }),
  Schema.Struct({
    name: Schema.Literal("initial-inbox-setup"),
    payload: InitialInboxSetupPayload,
  }),
  Schema.Struct({
    name: Schema.Literal("invite-team-members"),
    payload: InviteTeamMembersPayload,
  }),
  Schema.Struct({
    name: Schema.Literal("onboard-team"),
    payload: OnboardTeamPayload,
  }),
  Schema.Struct({
    name: Schema.Literal("deliver-webhook"),
    payload: DeliverWebhookPayload,
  }),
  Schema.Struct({
    name: Schema.Literal("post-accounting-draft"),
    payload: PostAccountingDraftPayload,
  }),
);
export type WorkflowRequest = typeof WorkflowRequest.Type;
export type WorkflowName = WorkflowRequest["name"];
