import { Schema } from "effect";

export const ProcessAttachmentPayload = Schema.Struct({
  teamId: Schema.String,
  /**
   * Workspace-owned inbox record. The worker resolves path, type and size from
   * this row; nothing in the payload is trusted as ownership proof.
   */
  inboxId: Schema.optional(Schema.String),
  /**
   * Legacy payload fields, kept so jobs enqueued before this contract still
   * run. A serialized path only counts when it is the job workspace's own
   * document path; the record is created from it when none exists yet.
   */
  mimetype: Schema.optional(Schema.String),
  size: Schema.optional(Schema.Number),
  filePath: Schema.optional(Schema.Array(Schema.String)),
  referenceId: Schema.optional(Schema.String),
  website: Schema.optional(Schema.String),
  inboxAccountId: Schema.optional(Schema.String),
});
export type ProcessAttachmentPayload = typeof ProcessAttachmentPayload.Type;

export const ProcessInboundEmailPayload = Schema.Struct({
  teamId: Schema.String,
  /** Workspace-owned received message; read back scoped to `teamId`. */
  inboundEmailId: Schema.String,
});
export type ProcessInboundEmailPayload = typeof ProcessInboundEmailPayload.Type;

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
  invite: Schema.Struct({
    email: Schema.String,
    invitedByName: Schema.String,
    invitedByEmail: Schema.String,
    teamName: Schema.String,
    inviteCode: Schema.optional(Schema.String),
  }),
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

export const RerunQuestionPayload = Schema.Struct({
  runId: Schema.String,
  teamId: Schema.String,
});
export type RerunQuestionPayload = typeof RerunQuestionPayload.Type;

export const PurgeDeletedDataPayload = Schema.Struct({
  deletionId: Schema.String,
});
export type PurgeDeletedDataPayload = typeof PurgeDeletedDataPayload.Type;

export const BuildDataExportPayload = Schema.Struct({
  exportId: Schema.String,
  teamId: Schema.String,
});
export type BuildDataExportPayload = typeof BuildDataExportPayload.Type;

export const MatchInvoicePayload = Schema.Struct({
  teamId: Schema.String,
  invoiceId: Schema.String,
});
export type MatchInvoicePayload = typeof MatchInvoicePayload.Type;

export const ApplyRetentionPayload = Schema.Struct({
  /** The hourly slot this run belongs to; the next slot is queued after it. */
  slot: Schema.String,
});
export type ApplyRetentionPayload = typeof ApplyRetentionPayload.Type;

export const WorkflowRequest = Schema.Union(
  Schema.Struct({
    name: Schema.Literal("process-attachment"),
    payload: ProcessAttachmentPayload,
  }),
  Schema.Struct({
    name: Schema.Literal("process-inbound-email"),
    payload: ProcessInboundEmailPayload,
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
  Schema.Struct({
    name: Schema.Literal("rerun-question"),
    payload: RerunQuestionPayload,
  }),
  Schema.Struct({
    name: Schema.Literal("purge-deleted-data"),
    payload: PurgeDeletedDataPayload,
  }),
  Schema.Struct({
    name: Schema.Literal("build-data-export"),
    payload: BuildDataExportPayload,
  }),
  Schema.Struct({
    name: Schema.Literal("apply-retention"),
    payload: ApplyRetentionPayload,
  }),
  Schema.Struct({
    name: Schema.Literal("match-invoice"),
    payload: MatchInvoicePayload,
  }),
);
export type WorkflowRequest = typeof WorkflowRequest.Type;
export type WorkflowName = WorkflowRequest["name"];
