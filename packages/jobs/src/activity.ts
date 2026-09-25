import {
  type AuditCategory,
  INVOICE_ACTIVITY_SOURCE_LIMIT,
  type InvoiceActivitySources,
} from "@invoicewise/db/queries";
import { redactOptionalText } from "@invoicewise/db/utils/redact";
import {
  DELIVERY_RULE_DESCRIPTIONS,
  type DeliveryRuleId,
} from "@invoicewise/documents/delivery-policy";

/**
 * The audit trail's vocabulary: every recorded action, with its category and
 * the phrase customers and operators read. The API's audit registries only
 * use actions listed here (checked by `activity.test.ts`).
 */
export const AUDIT_ACTIONS = {
  // Invoices
  "invoice.correct": { category: "invoice", label: "Corrected fields" },
  "invoice.reextract": { category: "invoice", label: "Asked to read again" },
  "invoice.rerun_questions": {
    category: "invoice",
    label: "Asked to answer questions again",
  },
  "invoice.bulk_action": { category: "invoice", label: "Bulk action" },
  "invoice.submit": {
    category: "invoice",
    label: "Submitted a document over the API",
  },
  "invoice.update": { category: "invoice", label: "Updated invoice" },
  "invoice.delete": { category: "invoice", label: "Deleted invoice" },
  "invoice.document_link": {
    category: "invoice",
    label: "Issued a document link",
  },
  // Delivery
  "delivery.retry": { category: "delivery", label: "Retried delivery" },
  "accounting.retry": {
    category: "delivery",
    label: "Retried the accounting post",
  },
  "delivery.release": {
    category: "delivery",
    label: "Released a held delivery",
  },
  "delivery.dismiss": {
    category: "delivery",
    label: "Dismissed a held delivery",
  },
  "delivery_rules.update": {
    category: "delivery",
    label: "Changed the delivery rules",
  },
  "webhook.redeliver": {
    category: "delivery",
    label: "Redelivered a webhook event",
  },
  "webhook.test": { category: "delivery", label: "Sent a test webhook event" },
  // Questions
  "question.create": { category: "question", label: "Added a question" },
  "question.update": { category: "question", label: "Changed a question" },
  "question.delete": { category: "question", label: "Deleted a question" },
  "question.preview": { category: "question", label: "Previewed a question" },
  "question.rerun": {
    category: "question",
    label: "Reran a question on invoices",
  },
  // Suppliers
  "supplier.assign_invoice": {
    category: "supplier",
    label: "Assigned an invoice to a supplier",
  },
  "supplier.merge": { category: "supplier", label: "Merged suppliers" },
  "supplier.revert": {
    category: "supplier",
    label: "Undid a supplier correction",
  },
  // Authorization sources
  "authorization_source.create": {
    category: "authorization_source",
    label: "Added an authorization source",
  },
  "authorization_source.amend": {
    category: "authorization_source",
    label: "Amended an authorization source",
  },
  "authorization_source.set_status": {
    category: "authorization_source",
    label: "Changed an authorization source's status",
  },
  "authorization_source.link_supplier": {
    category: "authorization_source",
    label: "Linked a supplier to an authorization source",
  },
  "authorization_source.import": {
    category: "authorization_source",
    label: "Imported authorization sources",
  },
  "authorization_source.attach_document": {
    category: "authorization_source",
    label: "Attached a document to an authorization source",
  },
  "source_match.confirm": {
    category: "authorization_source",
    label: "Confirmed an invoice's authorization match",
  },
  "source_match.link": {
    category: "authorization_source",
    label: "Linked an invoice to authorization sources",
  },
  "source_match.unlink": {
    category: "authorization_source",
    label: "Unlinked an invoice from its authorization sources",
  },
  // Integrations
  "webhook.create": { category: "integration", label: "Added a webhook" },
  "webhook.disable": { category: "integration", label: "Disabled a webhook" },
  "webhook.rotate_secret": {
    category: "integration",
    label: "Rotated a webhook secret",
  },
  "accounting.connect_start": {
    category: "integration",
    label: "Started connecting accounting",
  },
  "accounting.connect": {
    category: "integration",
    label: "Connected accounting",
  },
  "accounting.disconnect": {
    category: "integration",
    label: "Disconnected accounting",
  },
  "accounting.health_check": {
    category: "integration",
    label: "Checked the accounting connection",
  },
  "accounting.settings_update": {
    category: "integration",
    label: "Changed accounting settings",
  },
  "accounting.organisation_select": {
    category: "integration",
    label: "Chose the accounting organisation",
  },
  "mailbox.connect": { category: "integration", label: "Connected a mailbox" },
  "mailbox.disconnect": {
    category: "integration",
    label: "Disconnected a mailbox",
  },
  "mailbox.sync": { category: "integration", label: "Synced a mailbox" },
  "inbound_address.replace": {
    category: "integration",
    label: "Replaced the receiving address",
  },
  "oauth_app.create": {
    category: "integration",
    label: "Created an OAuth application",
  },
  "oauth_app.update": {
    category: "integration",
    label: "Changed an OAuth application",
  },
  "oauth_app.delete": {
    category: "integration",
    label: "Deleted an OAuth application",
  },
  "oauth_app.regenerate_secret": {
    category: "integration",
    label: "Regenerated an OAuth application secret",
  },
  "oauth_app.set_approval": {
    category: "integration",
    label: "Changed an OAuth application's approval",
  },
  // Access: keys, grants and members
  "api_key.save": {
    category: "access",
    label: "Created or changed an API key",
  },
  "api_key.delete": { category: "access", label: "Deleted an API key" },
  "oauth.grant": { category: "access", label: "Granted an application access" },
  "oauth.revoke": {
    category: "access",
    label: "Revoked an application's access",
  },
  "member.invite": { category: "access", label: "Invited members" },
  "member.invite_revoke": {
    category: "access",
    label: "Revoked an invitation",
  },
  "member.remove": { category: "access", label: "Removed a member" },
  "member.role_change": {
    category: "access",
    label: "Changed a member's role",
  },
  "member.join": { category: "access", label: "Joined the workspace" },
  "member.leave": { category: "access", label: "Left the workspace" },
  // Workspace
  "workspace.create": { category: "workspace", label: "Created the workspace" },
  "workspace.update": {
    category: "workspace",
    label: "Changed workspace settings",
  },
  "workspace.delete": { category: "workspace", label: "Deleted the workspace" },
  "data.export_request": {
    category: "workspace",
    label: "Requested a data export",
  },
  "data.export_download": {
    category: "workspace",
    label: "Downloaded a data export",
  },
  "api.request": { category: "workspace", label: "Changed data over the API" },
  // Operators
  "operator.job_retry": {
    category: "operator",
    label: "Operator retried a job",
  },
  "operator.job_cancel": {
    category: "operator",
    label: "Operator cancelled a job",
  },
  "operator.invoice_activity_view": {
    category: "operator",
    label: "Operator viewed the invoice's activity",
  },
} as const satisfies Record<string, { category: AuditCategory; label: string }>;

export type AuditAction = keyof typeof AUDIT_ACTIONS;

export const auditActionLabel = (action: string) =>
  (AUDIT_ACTIONS as Record<string, { label: string }>)[action]?.label ?? action;

export type ActivityAudience = "customer" | "operator";

export type ActivityActor = {
  type: "user" | "api_key" | "oauth" | "operator" | "system";
  /** A display name for customers; operators see ids only. */
  name: string | null;
  id: string | null;
};

export type InvoiceActivityEntry = {
  id: string;
  at: string;
  stage:
    | "receipt"
    | "extraction"
    | "judgments"
    | "matching"
    | "correction"
    | "delivery"
    | "accounting"
    | "action";
  title: string;
  status: "ok" | "pending" | "review" | "failed" | "refused" | "info";
  /** Why it failed or what it is waiting for, in plain words (redacted). */
  reason: string | null;
  actor: ActivityActor | null;
  /** Correlation identifiers: jobs, deliveries, events, messages, revisions. */
  refs: Record<string, string | number>;
};

export type InvoiceActivity = {
  invoiceId: string;
  revision: number;
  current: {
    extraction: "processing" | "processed" | "failed" | "not_accepted";
    extractionError: string | null;
    validation: string | null;
    accounting: string | null;
    questionRerun: string | null;
    /** The current revision's delivery-rules decision: deliver, held, released or dismissed. */
    delivery: "deliver" | "held" | "released" | "dismissed" | null;
  };
  entries: InvoiceActivityEntry[];
  /** True when a source held more rows than the trace shows. */
  truncated: boolean;
};

const PROVIDER_NAME: Record<string, string> = {
  xero: "Xero",
  quickbooks: "QuickBooks",
};

const WORKFLOW_TITLE: Record<string, string> = {
  "process-attachment": "Reading the document",
  "rerun-judgments": "Answering questions again",
  "post-accounting-draft": "Posting the draft bill",
  "update-accounting-bill": "Updating the posted bill",
  "attach-accounting-document": "Attaching the document to the posted bill",
  "match-invoice": "Matching to authorization sources",
  "reconcile-invoice": "Reconciling with authorization sources",
};

/** A URL shown as its origin only: paths and queries can carry tokens. */
const origin = (url: string) => {
  try {
    return new URL(url).origin;
  } catch {
    return "an endpoint";
  }
};

const plural = (count: number, noun: string) =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

const actorFor = (
  audience: ActivityAudience,
  actor: {
    type: ActivityActor["type"];
    userId: string | null;
    name: string | null;
    ref?: string | null;
  },
): ActivityActor => {
  if (actor.type === "operator") {
    return { type: "operator", name: actor.ref ?? "Operator", id: null };
  }
  if (audience === "operator") {
    return { type: actor.type, name: null, id: actor.userId };
  }
  return {
    type: actor.type,
    name:
      actor.name ??
      (actor.userId ? null : actor.type === "user" ? "A former member" : null),
    id: actor.userId,
  };
};

type Job = InvoiceActivitySources["jobs"][number];

/** A queue job as the stage it moved the invoice through. */
const jobEntry = (job: Job, now: number): InvoiceActivityEntry | null => {
  const title = WORKFLOW_TITLE[job.name];
  if (!title) return null;
  const stage: InvoiceActivityEntry["stage"] =
    job.name === "process-attachment"
      ? "extraction"
      : job.name === "rerun-judgments"
        ? "judgments"
        : job.name === "match-invoice" || job.name === "reconcile-invoice"
          ? "matching"
          : "accounting";
  const error = redactOptionalText(job.lastError);
  const refs: InvoiceActivityEntry["refs"] = {
    jobId: job.id,
    attempts: job.attempts,
  };
  if (job.revision != null) refs.revision = job.revision;
  if (job.correctionId) refs.correctionId = job.correctionId;
  const stalled =
    job.status === "running" &&
    !!job.leaseExpiresAt &&
    new Date(job.leaseExpiresAt).getTime() < now;
  switch (job.status) {
    case "succeeded":
      return {
        id: `job:${job.id}`,
        at: job.finishedAt ?? job.updatedAt,
        stage,
        title: `${title}: done`,
        status: "ok",
        reason:
          job.attempts > 1
            ? `Succeeded on attempt ${job.attempts} of ${job.maxAttempts}`
            : null,
        actor: null,
        refs,
      };
    case "failed":
      return {
        id: `job:${job.id}`,
        at: job.finishedAt ?? job.updatedAt,
        stage,
        title: `${title}: failed`,
        status: "failed",
        reason: error
          ? `${error} (after ${plural(job.attempts, "attempt")})`
          : `Stopped after ${plural(job.attempts, "attempt")}`,
        actor: null,
        refs,
      };
    case "running":
      return {
        id: `job:${job.id}`,
        at: job.updatedAt,
        stage,
        title: stalled ? `${title}: stalled` : `${title}: in progress`,
        status: "pending",
        reason: stalled
          ? `The worker stopped responding during attempt ${job.attempts}; the job is picked up again automatically`
          : `Attempt ${job.attempts} of ${job.maxAttempts}`,
        actor: null,
        refs,
      };
    default:
      return {
        id: `job:${job.id}`,
        at: job.updatedAt,
        stage,
        title: `${title}: queued`,
        status: "pending",
        reason:
          job.attempts > 0
            ? `Waiting to retry after attempt ${job.attempts}${error ? `: ${error}` : ""}`
            : null,
        actor: null,
        refs,
      };
  }
};

const deliveryStatus = (status: string): InvoiceActivityEntry["status"] =>
  status === "succeeded"
    ? "ok"
    : status === "failed"
      ? "failed"
      : status === "cancelled"
        ? "refused"
        : "pending";

const accountingStatus = (
  status: string | null,
): InvoiceActivityEntry["status"] =>
  status === "posted" || status === "already_posted"
    ? "ok"
    : status === "failed" || status === "needs_review"
      ? "failed"
      : status === "cancelled"
        ? "refused"
        : "pending";

const DECISION_DESTINATION: Record<string, string> = {
  deliver: "sent",
  held: "held",
  off: "off",
  not_connected: "not connected",
  not_applicable: "not applicable",
  already_posted: "already posted",
  not_scheduled: "not scheduled",
};

export const HELD_RELEASABLE_TEXT =
  "An owner or admin releases or dismisses it";
export const HELD_LOCKED_TEXT =
  "It cannot be released: correct or re-extract the invoice, or dismiss it";

const ruleLabel = (rule: string) =>
  DELIVERY_RULE_DESCRIPTIONS[rule as DeliveryRuleId]?.label ?? rule;

const OUTCOME_STATUS = {
  started: "pending",
  succeeded: "ok",
  refused: "refused",
  denied: "refused",
  failed: "failed",
} as const;

const ENTRY_LIMIT = 300;

/**
 * An invoice's activity trace, oldest first: how it was received, each run
 * that read it or answered its questions, every correction and action, and
 * each destination with its outcome, with the identifiers that tie each step
 * to the queue, the delivery ledger and the audit trail. Built only from the
 * existing records (`getInvoiceActivitySources`); no invoice content is
 * included. The operator audience gets actor ids instead of names and no
 * sender address.
 */
export function buildInvoiceActivity(
  sources: InvoiceActivitySources,
  options: { audience: ActivityAudience; now?: Date },
): InvoiceActivity {
  const { invoice } = sources;
  const now = (options.now ?? new Date()).getTime();
  const audience = options.audience;
  const entries: InvoiceActivityEntry[] = [];

  // Receipt.
  if (sources.email) {
    const sender =
      audience === "customer" && sources.email.sender
        ? ` from ${sources.email.sender}`
        : "";
    entries.push({
      id: `receipt:${invoice.id}`,
      at: sources.email.createdAt,
      stage: "receipt",
      title: `Received by email${sender}`,
      status: sources.email.status === "failed" ? "failed" : "ok",
      reason: redactOptionalText(sources.email.detail),
      actor: null,
      refs: {
        inboundEmailId: sources.email.id,
        ...(sources.email.messageId
          ? { messageId: sources.email.messageId }
          : {}),
      },
    });
  } else {
    entries.push({
      id: `receipt:${invoice.id}`,
      at: invoice.createdAt,
      stage: "receipt",
      title: invoice.inboxAccountId
        ? "Received from a connected mailbox"
        : "Uploaded",
      status: invoice.intakeState === "cancelled" ? "refused" : "ok",
      reason: redactOptionalText(invoice.intakeError),
      actor: null,
      refs: {
        invoiceId: invoice.id,
        ...(invoice.inboxAccountId
          ? { mailboxId: invoice.inboxAccountId }
          : {}),
      },
    });
  }
  for (const redelivery of sources.redeliveries) {
    entries.push({
      id: `redelivery:${redelivery.id}`,
      at: redelivery.receivedAt,
      stage: "receipt",
      title: "Received again: the same document is not read twice",
      status: "info",
      reason: null,
      actor: null,
      refs: { redeliveryId: redelivery.id },
    });
  }

  // Queue runs: reading, question reruns and accounting posts.
  const latestPost = sources.jobs.find(
    (job) => job.name === "post-accounting-draft",
  );
  for (const job of sources.jobs) {
    const entry = jobEntry(job, now);
    if (!entry) continue;
    // The newest post carries the post's recorded outcome, which is more
    // precise than the job's own status (held for review, provider id).
    if (job === latestPost && invoice.accountingPostStatus) {
      const provider =
        PROVIDER_NAME[invoice.accountingProvider ?? ""] ?? "accounting";
      const status = accountingStatus(invoice.accountingPostStatus);
      entry.status = status;
      entry.title =
        status === "ok"
          ? `Draft bill posted to ${provider}`
          : invoice.accountingPostStatus === "needs_review"
            ? `Draft bill held for review: ${provider} may already have it`
            : invoice.accountingPostStatus === "cancelled"
              ? `Draft bill to ${provider} cancelled`
              : status === "failed"
                ? `Draft bill to ${provider} failed`
                : `Posting the draft bill to ${provider}`;
      if (status === "ok" && invoice.accountingPostedAt) {
        entry.at = invoice.accountingPostedAt;
      }
      if (status !== "ok") {
        const error = redactOptionalText(invoice.accountingPostError);
        entry.reason =
          error &&
          `${error}${
            status === "failed" && invoice.accountingPostRetryable !== null
              ? invoice.accountingPostRetryable
                ? " · Retry may succeed"
                : " · Needs a change before retrying"
              : ""
          }`;
      } else {
        entry.reason = null;
      }
      if (invoice.accountingProviderId) {
        entry.refs.providerId = invoice.accountingProviderId;
      }
      if (invoice.accountingRevision != null) {
        entry.refs.revision = invoice.accountingRevision;
      }
    }
    entries.push(entry);
  }

  // Webhook destinations.
  for (const delivery of sources.deliveries) {
    const status = deliveryStatus(delivery.status);
    const where = `${delivery.event} to ${origin(delivery.endpointUrl)}`;
    const job = sources.jobs.find((item) => item.deliveryId === delivery.id);
    entries.push({
      id: `delivery:${delivery.id}`,
      at: delivery.deliveredAt ?? delivery.updatedAt,
      stage: "delivery",
      title:
        status === "ok"
          ? `Webhook ${where} delivered`
          : status === "failed"
            ? `Webhook ${where} failed`
            : status === "refused"
              ? `Webhook ${where} cancelled`
              : `Webhook ${where} sending`,
      status,
      reason:
        status === "ok"
          ? delivery.attempts > 1
            ? `Delivered on attempt ${delivery.attempts}`
            : null
          : [
              redactOptionalText(delivery.lastError),
              status === "failed" && delivery.retryable !== null
                ? delivery.retryable
                  ? "Retry may succeed"
                  : "Needs a change before retrying"
                : null,
              delivery.attempts > 0
                ? plural(delivery.attempts, "attempt")
                : null,
            ]
              .filter(Boolean)
              .join(" · ") || null,
      actor: null,
      refs: {
        deliveryId: delivery.id,
        endpointId: delivery.endpointId,
        ...(delivery.eventId ? { eventId: delivery.eventId } : {}),
        ...(delivery.revision != null ? { revision: delivery.revision } : {}),
        ...(job ? { jobId: job.id } : {}),
      },
    });
  }

  // Delivery-rule decisions: one per revision, with how a hold was resolved.
  for (const decision of sources.decisions) {
    const refs = {
      decisionId: decision.id,
      revision: decision.revision,
      policyVersion: decision.policyVersion,
    };
    const destinations = `Accounting: ${DECISION_DESTINATION[decision.accounting] ?? decision.accounting} · Webhooks: ${DECISION_DESTINATION[decision.webhooks] ?? decision.webhooks}`;
    const held = decision.outcome === "hold";
    const open = held && !decision.resolution;
    const superseded = open && decision.revision < invoice.processingRevision;
    entries.push({
      id: `decision:${decision.id}`,
      at: decision.createdAt,
      stage: "delivery",
      title: held
        ? `Held by the delivery rules: ${[...new Set(decision.rules.map(ruleLabel))].join(", ") || "held"}`
        : "Passed the delivery rules",
      status: superseded ? "info" : open ? "review" : "ok",
      reason: superseded
        ? `${destinations} · Superseded by revision ${invoice.processingRevision}`
        : open
          ? `${destinations} · ${decision.locked ? HELD_LOCKED_TEXT : HELD_RELEASABLE_TEXT}`
          : destinations,
      actor: null,
      refs,
    });
    if (decision.resolution && decision.resolvedAt) {
      entries.push({
        id: `decision-resolution:${decision.id}`,
        at: decision.resolvedAt,
        stage: "delivery",
        title:
          decision.resolution === "released"
            ? "Held delivery released"
            : "Held delivery dismissed: nothing is sent for this revision",
        status: decision.resolution === "released" ? "ok" : "refused",
        reason: redactOptionalText(decision.resolutionReason),
        actor: decision.resolvedBy
          ? actorFor(audience, {
              type: "user",
              userId: decision.resolvedBy,
              name: decision.resolvedByName,
            })
          : null,
        refs,
      });
    }
  }

  // Corrections: field names only; the values stay in the invoice's history.
  for (const correction of sources.corrections) {
    const provider = PROVIDER_NAME[correction.provider ?? ""] ?? "accounting";
    const bill =
      correction.accountingOutcome === "keep_bill"
        ? `bill in ${provider} kept`
        : correction.accountingOutcome === "update_bill"
          ? `bill in ${provider} ${correction.updateStatus === "updated" ? "updated" : correction.updateStatus === "queued" ? "being updated" : (correction.updateStatus ?? "update pending")}`
          : null;
    entries.push({
      id: `correction:${correction.id}`,
      at: correction.createdAt,
      stage: "correction",
      title: `Corrected ${correction.fields.join(", ") || "fields"}`,
      status:
        correction.updateStatus === "failed" ||
        correction.updateStatus === "cancelled"
          ? "failed"
          : "ok",
      reason:
        [
          bill,
          correction.updateStatus === "failed" ||
          correction.updateStatus === "cancelled"
            ? redactOptionalText(correction.updateError)
            : null,
        ]
          .filter(Boolean)
          .join(" · ") || null,
      actor: actorFor(audience, {
        type: "user",
        userId: correction.actorId,
        name: correction.actorName,
      }),
      refs: {
        correctionId: correction.id,
        version: correction.version,
        revision: correction.revision,
        ...(correction.providerId ? { providerId: correction.providerId } : {}),
      },
    });
  }

  // Question reruns: which question, for which revision, never the answer.
  for (const answer of sources.answers) {
    entries.push({
      id: `answer:${answer.id}`,
      at: answer.createdAt,
      stage: "judgments",
      title: `Question "${answer.questionKey}" answered again`,
      status: "ok",
      reason: null,
      actor: answer.requestedBy
        ? actorFor(audience, {
            type: "user",
            userId: answer.requestedBy,
            name: answer.requestedByName,
          })
        : null,
      refs: { runId: answer.runId, revision: answer.invoiceRevision },
    });
  }
  for (const run of sources.failedRuns) {
    entries.push({
      id: `question-run:${run.id}`,
      at: run.completedAt ?? run.createdAt,
      stage: "judgments",
      title: `Question "${run.questionKey}" rerun failed`,
      status: "failed",
      reason: redactOptionalText(run.error),
      actor: null,
      refs: { runId: run.id },
    });
  }

  // Actions people and operators took on the invoice. A successful
  // correction is already listed from the correction itself.
  for (const event of sources.audit) {
    if (event.action === "invoice.correct" && event.outcome === "succeeded") {
      continue;
    }
    const detailError =
      event.detail && typeof event.detail.error === "string"
        ? event.detail.error
        : null;
    entries.push({
      id: `audit:${event.id}`,
      at: event.createdAt,
      stage: "action",
      title: auditActionLabel(event.action),
      status: OUTCOME_STATUS[event.outcome],
      reason:
        [
          event.outcome === "started" ? "Outcome not recorded" : null,
          event.outcome === "denied" ? "Not permitted" : null,
          detailError,
          event.purpose ? `Purpose: ${event.purpose}` : null,
        ]
          .filter(Boolean)
          .join(" · ") || null,
      actor: actorFor(audience, {
        type: event.actorType,
        userId: event.actor?.id ?? null,
        name: event.actor?.fullName ?? event.actor?.email ?? null,
        ref: event.actorRef,
      }),
      refs: {
        auditEventId: event.id,
        ...(event.revision != null ? { revision: event.revision } : {}),
      },
    });
  }

  entries.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));

  const extraction =
    invoice.intakeState === "reserved" || invoice.intakeState === "cancelled"
      ? "not_accepted"
      : invoice.status === "processing"
        ? "processing"
        : invoice.processingError
          ? "failed"
          : "processed";

  const currentDecision = sources.decisions.find(
    (decision) => decision.revision === invoice.processingRevision,
  );

  return {
    invoiceId: invoice.id,
    revision: invoice.processingRevision,
    current: {
      extraction,
      extractionError: redactOptionalText(invoice.processingError),
      validation: invoice.validationStatus,
      accounting: invoice.accountingPostStatus,
      questionRerun:
        invoice.judgmentsRerunStatus === "failed"
          ? (redactOptionalText(invoice.judgmentsRerunError) ??
            "The question rerun failed")
          : invoice.judgmentsRerunStatus,
      delivery: currentDecision
        ? (currentDecision.resolution ??
          (currentDecision.outcome === "hold" ? "held" : "deliver"))
        : null,
    },
    entries: entries.slice(-ENTRY_LIMIT),
    truncated:
      entries.length > ENTRY_LIMIT ||
      [
        sources.jobs,
        sources.deliveries,
        sources.decisions,
        sources.corrections,
        sources.answers,
        sources.audit,
      ].some((rows) => rows.length >= INVOICE_ACTIVITY_SOURCE_LIMIT),
  };
}
