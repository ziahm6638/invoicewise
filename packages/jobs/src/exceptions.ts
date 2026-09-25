import type { Database } from "@invoicewise/db/client";
import {
  type InvoiceCorrectionOutcome,
  type TeamRole,
  canPostToAccounting,
  canResolveHeldDeliveries,
  claimAdditionalPostingKey,
  clearJudgmentsRerun,
  enqueueWorkflowJob,
  getActiveAccountingConnection,
  getDeliveryDecision,
  getPendingBillUpdate,
  getTeamById,
  insertInvoiceCorrection,
  listStalledJudgmentReruns,
  listStalledProcessing,
  lockDocumentIdentities,
  lockInvoiceForAction,
  markJudgmentsRerunQueued,
  nextCorrectionVersion,
  recordInboxProcessingFailure,
  recordJudgmentsRerunFailure,
  requeueFinishedWorkflowJob,
  reviseInvoice,
} from "@invoicewise/db/queries";
import {
  DocumentClient,
  type InvoiceExtraction,
  type InvoiceValidation,
  MAX_CORRECTION_REASON_LENGTH,
  accountingReadiness,
  applyInvoiceCorrection,
  changesPostingIdentity,
  invoiceColumnsFromExtraction,
  postingKeyOf,
} from "@invoicewise/documents";
import { InvoiceActionError } from "./action-error";
import { workflowKey } from "./client";
import { enqueueBillUpdate, scheduleInvoiceDeliveries } from "./delivery";
import { decisionHeld } from "./delivery-rules";
import { resolveWorkerIntakeBinding, verifyStoredIntake } from "./intake";
import {
  loadJudgmentQuestions,
  reevaluateLaterDocuments,
} from "./process-document";
import { scheduleInvoiceMatch } from "./source-matching";
import {
  loadJudgmentHistory,
  recordSupplierChecks,
  resolveDocumentSupplier,
  validateAgainstEarlierDocuments,
} from "./suppliers";

/**
 * The exception workflow on a processed invoice: correct its fields, answer
 * its questions again, and (in `./delivery`) retry what failed to deliver.
 * Re-extraction is `retryIntakeProcessing` in `./intake`.
 *
 * Every action names the processing revision the user saw and runs under the
 * invoice's row lock, so two clicks, two tabs or a click racing a finishing
 * worker produce one transition; the other is refused as a conflict.
 * docs/delivery.md#corrections-reprocessing-and-retries publishes it.
 */

export { InvoiceActionError } from "./action-error";

/** Recorded on an invoice whose failure is not the document's fault. */
export const TEMPORARY_PROCESSING_FAILURE =
  "A temporary processing problem stopped this invoice from being read. Retry it shortly.";

/** Recorded on a question rerun that could not be completed. */
export const TEMPORARY_RERUN_FAILURE =
  "The questions could not be answered again right now. Try again shortly.";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
const asDatabase = (tx: Transaction) => tx as unknown as Database;

const PROVIDER_NAME = { xero: "Xero", quickbooks: "QuickBooks" } as const;

const providerName = (provider: string | null) =>
  provider === "xero" || provider === "quickbooks"
    ? PROVIDER_NAME[provider]
    : "your accounting software";

const refuse = (
  code: InvoiceActionError["code"],
  message: string,
  fields: InvoiceActionError["fields"] = [],
) => new InvoiceActionError(code, message, fields);

/** The invoice is one a user may act on at the revision they saw. */
function assertActionable(
  invoice: Awaited<ReturnType<typeof lockInvoiceForAction>>,
  expectedRevision: number,
): asserts invoice is NonNullable<typeof invoice> {
  if (
    !invoice ||
    invoice.status === "deleted" ||
    (invoice.intakeState !== null && invoice.intakeState !== "accepted")
  ) {
    throw refuse("not_found", "Invoice not found");
  }
  if (invoice.status === "processing") {
    throw refuse(
      "conflict",
      "This invoice is being read again. Wait for that to finish, then try again.",
    );
  }
  if (invoice.processingRevision !== expectedRevision) {
    throw refuse(
      "conflict",
      "This invoice changed since you opened it. Reload it to see the current values, then try again.",
    );
  }
  if (!invoice.extraction || invoice.processingError) {
    throw refuse(
      "invalid",
      "This invoice has no extracted record yet. Re-extract the document first.",
    );
  }
}

// --- Corrections -------------------------------------------------------------------

/** What a correction did about the bill in the accounting provider. */
export type CorrectionAccounting =
  /** The invoice was not posted: a post of the corrected invoice is queued. */
  | "post_queued"
  /** Not posted, and nothing is scheduled (no connection, or never set up). */
  | "not_scheduled"
  /** Not posted; re-posting after a failure needs an admin. */
  | "admin_required"
  /** Not posted: the delivery rules hold the corrected invoice. */
  | "held"
  /** Posted: the bill was left as it is. */
  | "bill_kept"
  /** Posted: an in-place update of the same bill is queued. */
  | "bill_update_queued";

export type CorrectInvoiceInput = {
  invoiceId: string;
  teamId: string;
  actorId: string;
  teamRole: TeamRole | null;
  /** The processing revision the user corrected. */
  expectedRevision: number;
  reason: string;
  changes: Record<string, unknown>;
  /** Required once the invoice is a bill in the accounting provider. */
  accountingOutcome?: "keep_bill" | "update_bill";
};

/**
 * Corrects extracted fields of a processed invoice.
 *
 * In one transaction, under the invoice's row lock and the workspace's
 * document-identity lock: the values are checked against the canonical
 * record, the original reading is kept (`extraction_original`, and each
 * field's before and after in the correction), validation runs again (and
 * again for later copies that depend on this one), the correction is
 * recorded with its actor, time, reason and version, and the corrected
 * record becomes the next revision with its webhook deliveries scheduled.
 *
 * The bill: an invoice not yet posted has its post scheduled again from the
 * corrected values (re-posting after a failure needs an admin, as a retry
 * does). An invoice already posted keeps its provider ID and never gets a
 * second bill: the caller must choose to keep the bill as it is or to update
 * that same bill in place (admin only, and only when the corrected invoice
 * could be posted).
 */
export async function correctInvoice(db: Database, input: CorrectInvoiceInput) {
  const reason = input.reason.trim();
  if (reason.length < 3 || reason.length > MAX_CORRECTION_REASON_LENGTH) {
    throw refuse(
      "invalid",
      `Give a reason for the correction (3 to ${MAX_CORRECTION_REASON_LENGTH} characters).`,
      [{ field: "reason", message: "Give a reason for the correction" }],
    );
  }
  return db.transaction(async (tx) => {
    const executor = asDatabase(tx);
    // The same order as processing: identity lock, then the row.
    await lockDocumentIdentities(executor, input.teamId);
    const invoice = await lockInvoiceForAction(executor, {
      id: input.invoiceId,
      teamId: input.teamId,
    });
    assertActionable(invoice, input.expectedRevision);
    const provider = providerName(invoice.accountingProvider);

    if (invoice.accountingPostStatus === "queued") {
      throw refuse(
        "conflict",
        `This invoice is being sent to ${provider}. Correct it once that has finished.`,
      );
    }
    if (await getPendingBillUpdate(executor, input)) {
      throw refuse(
        "conflict",
        `An update of this bill is still being sent to ${provider}. Correct it again once that has finished.`,
      );
    }

    const version = await nextCorrectionVersion(executor, input);
    const applied = applyInvoiceCorrection(
      invoice.extraction,
      input.changes,
      `Corrected by a user (correction ${version})`,
    );
    if (!applied.ok) {
      throw refuse(
        "invalid",
        applied.errors.map((error) => error.message).join(" "),
        applied.errors,
      );
    }

    const posted = Boolean(invoice.accountingProviderId);
    const admin = canPostToAccounting(input.teamRole);
    let outcome: InvoiceCorrectionOutcome = "not_posted";
    if (posted) {
      if (!input.accountingOutcome) {
        throw refuse(
          "invalid",
          `This invoice is already a bill in ${provider}. Choose whether to keep that bill as it is or update it.`,
          [
            {
              field: "accountingOutcome",
              message: "Choose what happens to the bill",
            },
          ],
        );
      }
      if (input.accountingOutcome === "update_bill" && !admin) {
        throw refuse(
          "forbidden",
          `Only an admin can change the bill in ${provider}. Keep the bill as it is, or ask an admin.`,
        );
      }
      if (input.accountingOutcome === "update_bill") {
        const connection = await getActiveAccountingConnection(
          executor,
          input.teamId,
        );
        if (connection?.provider !== invoice.accountingProvider) {
          throw refuse(
            "conflict",
            `${provider} is not connected, so the bill cannot be updated. Reconnect ${provider} first, or keep the bill as it is.`,
          );
        }
      }
      outcome = input.accountingOutcome;
    }

    // A member's correction cannot clear a hold by itself: the corrected
    // revision waits for an owner's or admin's release.
    const previous = await getDeliveryDecision(executor, {
      invoiceId: invoice.id,
      teamId: input.teamId,
      revision: invoice.processingRevision,
    });
    const approval =
      !posted &&
      !canResolveHeldDeliveries(input.teamRole) &&
      previous?.outcome === "hold" &&
      decisionHeld(previous) &&
      previous.resolution === null
        ? "A member corrected this invoice while its delivery was held; an owner or admin must release it."
        : null;

    const identityChanged = changesPostingIdentity(applied.changes);
    // A post that may have reached the provider under its current key (it
    // failed in a way a retry could fix, or was cancelled mid-way) could
    // already have created a bill from the values as they were. Posting the
    // corrected invoice would replay that bill and record it as sent with
    // values it does not carry, so the attempt must settle first: a retry
    // either creates the bill or returns the existing one, which a later
    // correction can then keep or update.
    const postMayExist =
      !posted &&
      Boolean(invoice.accountingIdempotencyKey) &&
      ((invoice.accountingPostStatus === "failed" &&
        invoice.accountingPostRetryable !== false) ||
        invoice.accountingPostStatus === "cancelled");
    if (postMayExist) {
      throw refuse(
        "conflict",
        `The last attempt to send this invoice to ${provider} may already have created the bill. Retry delivery first; once it settles, correct the invoice and choose whether to update that bill.`,
      );
    }

    // A corrected supplier name or VAT number may name another supplier; a
    // supplier a user assigned by hand is kept.
    const supplier = await resolveDocumentSupplier(executor, {
      teamId: input.teamId,
      documentId: invoice.id,
      extraction: applied.extraction,
    });
    const validation = await validateAgainstEarlierDocuments(executor, {
      teamId: input.teamId,
      documentId: invoice.id,
      extraction: applied.extraction,
      supplierId: supplier.supplierId,
    });

    if (outcome === "update_bill") {
      const readiness = accountingReadiness(applied.extraction, validation);
      if (!readiness.ready) {
        throw refuse(
          "invalid",
          `The corrected invoice cannot be sent to ${provider}: ${readiness.blockers
            .map((blocker) => blocker.message)
            .join(" ")} Fix these, or keep the bill as it is.`,
        );
      }
      const postingKey = identityChanged
        ? postingKeyOf(applied.extraction)
        : null;
      if (postingKey) {
        const holder = await claimAdditionalPostingKey(executor, {
          teamId: input.teamId,
          identityKey: postingKey,
          invoiceId: invoice.id,
        });
        if (holder !== invoice.id) {
          throw refuse(
            "conflict",
            `Invoice number ${String(applied.extraction.invoiceNumber)} was already sent to ${provider} for another document (${holder}). Updating this bill to it would give ${provider} two bills with one number.`,
          );
        }
      }
    }

    const revised = await reviseInvoice(executor, {
      id: invoice.id,
      teamId: input.teamId,
      expectedRevision: input.expectedRevision,
      set: {
        extraction: applied.extraction as unknown as Record<string, unknown>,
        validation: validation as unknown as Record<string, unknown>,
        extractionOriginal: invoice.extractionOriginal ?? invoice.extraction,
        ...invoiceColumnsFromExtraction(applied.extraction),
        // A question rerun asked for the previous revision is superseded.
        judgmentsRerunStatus: null,
        judgmentsRerunError: null,
        judgmentsRerunRevision: null,
        // Nothing reached the provider under the old number, so the next
        // post takes its key (and claim) from the corrected one.
        ...(identityChanged && !posted
          ? { accountingIdempotencyKey: null, accountingPostReleased: false }
          : {}),
      },
    });
    if (!revised) {
      throw refuse(
        "conflict",
        "This invoice changed since you opened it. Reload it and try again.",
      );
    }

    await recordSupplierChecks(executor, {
      teamId: input.teamId,
      documentId: invoice.id,
      extraction: applied.extraction,
      validation,
      supplier,
    });

    const correction = await insertInvoiceCorrection(executor, {
      teamId: input.teamId,
      invoiceId: invoice.id,
      version,
      baseRevision: input.expectedRevision,
      revision: revised.processingRevision,
      actorId: input.actorId,
      reason,
      changes: applied.changes,
      extraction: applied.extraction as unknown as Record<string, unknown>,
      accountingOutcome: outcome,
      provider: posted ? invoice.accountingProvider : null,
      providerId: invoice.accountingProviderId,
      updateStatus: outcome === "update_bill" ? "queued" : null,
    });

    // A failed, cancelled or held post: sending it again is a re-post,
    // which needs an admin (docs/permissions.md).
    const repost = invoice.accountingPostStatus !== null && !admin;
    const scheduled = await scheduleInvoiceDeliveries(executor, revised, {
      accounting: outcome === "not_posted" && !repost,
      data: {
        correction: { version, reason, changes: applied.changes },
      },
      approval,
    });
    // The corrected values (a fixed PO number, say) are matched to
    // authorization sources again; a person's match decision is kept.
    await scheduleInvoiceMatch(executor, {
      teamId: input.teamId,
      invoiceId: invoice.id,
      revision: revised.processingRevision,
    });
    const allowed = scheduled.decision?.accounting;

    let accounting: CorrectionAccounting;
    if (outcome === "update_bill") {
      await enqueueBillUpdate(executor, {
        correctionId: correction.id,
        invoiceId: invoice.id,
        teamId: input.teamId,
      });
      accounting = "bill_update_queued";
    } else if (outcome === "keep_bill") {
      accounting = "bill_kept";
    } else if (allowed === "held") {
      accounting = "held";
    } else if (scheduled.accounting) {
      accounting = "post_queued";
    } else if (repost && allowed === "not_scheduled") {
      accounting = "admin_required";
    } else {
      accounting = "not_scheduled";
    }

    const before = invoice.extraction as Partial<InvoiceExtraction>;
    await reevaluateLaterDocuments(
      executor,
      input.teamId,
      invoice.id,
      [before.invoiceNumber, applied.extraction.invoiceNumber].filter(
        (number): number is string => typeof number === "string",
      ),
    );

    return {
      invoiceId: invoice.id,
      correctionId: correction.id,
      version,
      revision: revised.processingRevision,
      changes: applied.changes,
      validationStatus: validation.status,
      webhooks: scheduled.webhooks,
      accounting,
    };
  });
}

// --- Question reruns --------------------------------------------------------------

/**
 * Queues the workspace's questions to be answered again for the invoice as
 * it is now (with any corrections). The job is keyed by the revision, so
 * repeated clicks share it; a rerun that failed for this revision is
 * restarted rather than queued twice.
 */
export async function requestQuestionRerun(
  db: Database,
  input: { invoiceId: string; teamId: string; expectedRevision: number },
) {
  return db.transaction(async (tx) => {
    const executor = asDatabase(tx);
    const invoice = await lockInvoiceForAction(executor, {
      id: input.invoiceId,
      teamId: input.teamId,
    });
    assertActionable(invoice, input.expectedRevision);
    const revision = invoice.processingRevision;
    if (
      invoice.judgmentsRerunStatus === "queued" &&
      invoice.judgmentsRerunRevision === revision
    ) {
      return { invoiceId: invoice.id, revision, deduplicated: true };
    }
    await markJudgmentsRerunQueued(executor, {
      id: invoice.id,
      teamId: input.teamId,
      revision,
    });
    const key = workflowKey.judgments(input.teamId, invoice.id, revision);
    const restarted = await requeueFinishedWorkflowJob(executor, {
      name: "rerun-judgments",
      idempotencyKey: key,
      teamId: input.teamId,
    });
    if (!restarted) {
      await enqueueWorkflowJob(executor, {
        name: "rerun-judgments",
        teamId: input.teamId,
        payload: { invoiceId: invoice.id, teamId: input.teamId, revision },
        idempotencyKey: key,
      });
    }
    return { invoiceId: invoice.id, revision, deduplicated: false };
  });
}

type RerunStorage = {
  download: (input: { bucket: string; path: string[] }) => Promise<Blob>;
};

/**
 * The question rerun job. It answers the questions for the stored
 * extraction and commits them as the next revision (with its webhook
 * deliveries) only if the invoice is still at the revision the rerun was
 * requested for; a rerun overtaken by a re-extraction or a correction is
 * dropped. Its answers never change the bill, so no accounting is scheduled,
 * except the post the delivery rules held for the previous revision when the
 * new answers let the invoice through.
 */
export async function rerunInvoiceJudgments(
  db: Database,
  storage: RerunStorage,
  input: { invoiceId: string; teamId: string; revision: number },
) {
  const superseded = async (executor: Database = db) => {
    await clearJudgmentsRerun(executor, {
      id: input.invoiceId,
      teamId: input.teamId,
      revision: input.revision,
    });
    return { invoiceId: input.invoiceId, superseded: true as const };
  };
  const [current] = await db.transaction(async (tx) => [
    await lockInvoiceForAction(asDatabase(tx), {
      id: input.invoiceId,
      teamId: input.teamId,
    }),
  ]);
  if (
    !current ||
    current.status === "deleted" ||
    current.status === "processing" ||
    current.processingRevision !== input.revision ||
    current.judgmentsRerunStatus !== "queued" ||
    current.judgmentsRerunRevision !== input.revision ||
    !current.extraction
  ) {
    return superseded();
  }
  const binding = await resolveWorkerIntakeBinding(db, {
    teamId: input.teamId,
    inboxId: input.invoiceId,
  });
  if (!binding?.filePath?.length) return superseded();
  const file = await storage.download({
    bucket: "vault",
    path: [...binding.filePath],
  });
  const bytes = Buffer.from(await file.arrayBuffer());
  const stored = verifyStoredIntake(binding, bytes);
  if (!stored.ok) {
    throw Object.assign(new Error(stored.message), {
      retryable: false,
      userMessage:
        "The stored document no longer matches this invoice, so its questions cannot be answered again.",
    });
  }

  const [team, questions] = await Promise.all([
    getTeamById(db, input.teamId),
    loadJudgmentQuestions(db, input.teamId),
  ]);
  const judgments = await new DocumentClient().getJudgments({
    documentUrl: `data:${stored.mimeType};base64,${bytes.toString("base64")}`,
    mimetype: stored.mimeType,
    companyName: team?.name,
    // The same supplier-scoped history a processing run compares with.
    loadHistory: (extraction) =>
      loadJudgmentHistory(db, {
        teamId: input.teamId,
        documentId: input.invoiceId,
        extraction,
      }),
    defaultJudgmentQuestions: questions.defaultQuestions,
    judgmentQuestions: questions.customQuestions,
    extraction: current.extraction as unknown as InvoiceExtraction,
    validation: current.validation as unknown as InvoiceValidation | null,
  });

  return db.transaction(async (tx) => {
    const executor = asDatabase(tx);
    const invoice = await lockInvoiceForAction(executor, {
      id: input.invoiceId,
      teamId: input.teamId,
    });
    if (
      !invoice ||
      invoice.processingRevision !== input.revision ||
      invoice.judgmentsRerunStatus !== "queued" ||
      invoice.judgmentsRerunRevision !== input.revision
    ) {
      return superseded(executor);
    }
    // New answers may clear a hold (a required question now answered): the
    // bill that was held is then posted. Otherwise a rerun never posts. A
    // hold awaiting an admin's approval is carried over: only a release
    // clears it.
    const previous = await getDeliveryDecision(executor, {
      invoiceId: input.invoiceId,
      teamId: input.teamId,
      revision: input.revision,
    });
    const unresolved = previous?.resolution === null;
    const accountingWasHeld = unresolved && previous?.accounting === "held";
    const awaitingApproval = unresolved
      ? (previous?.reasons as { code?: unknown; message?: unknown }[]).find(
          (held) => held.code === "awaiting_approval",
        )
      : undefined;
    const revised = await reviseInvoice(executor, {
      id: input.invoiceId,
      teamId: input.teamId,
      expectedRevision: input.revision,
      set: {
        judgments: judgments as unknown as Record<string, unknown>[],
        judgmentsRerunStatus: null,
        judgmentsRerunError: null,
        judgmentsRerunRevision: null,
      },
    });
    if (!revised) return superseded(executor);
    const scheduled = await scheduleInvoiceDeliveries(executor, revised, {
      accounting: accountingWasHeld,
      data: { judgmentsRerun: true },
      approval: awaitingApproval ? String(awaitingApproval.message) : null,
    });
    return {
      invoiceId: input.invoiceId,
      revision: revised.processingRevision,
      judgments: judgments.length,
      webhooksScheduled: scheduled.webhooks,
    };
  });
}

// --- Reconciliation ----------------------------------------------------------------

/**
 * Settles invoice work whose job disappeared or failed without its handler
 * recording the outcome, so nothing reads as in progress for ever: a lost
 * question rerun is queued again under its key, a failed one is marked
 * failed and can be retried, and a document left `processing` after its
 * processing job failed is recorded as failed and can be re-extracted. Run
 * by the workflow runner's reconciler alongside `reconcileDeliveries`.
 */
export async function reconcileInvoiceOperations(
  db: Database,
  input: { teamId?: string; invoiceId?: string; limit?: number } = {},
) {
  const limit = input.limit ?? 100;
  const [reruns, stalled] = await Promise.all([
    listStalledJudgmentReruns(db, { ...input, limit }),
    listStalledProcessing(db, { ...input, limit }),
  ]);
  let rescheduled = 0;
  let failed = 0;
  for (const rerun of reruns) {
    if (rerun.jobStatus === "failed") {
      const settled = await recordJudgmentsRerunFailure(db, {
        id: rerun.invoiceId,
        teamId: rerun.teamId,
        revision: rerun.revision,
        error: TEMPORARY_RERUN_FAILURE,
      });
      if (settled) failed += 1;
      continue;
    }
    await enqueueWorkflowJob(db, {
      name: "rerun-judgments",
      teamId: rerun.teamId,
      payload: {
        invoiceId: rerun.invoiceId,
        teamId: rerun.teamId,
        revision: rerun.revision,
      },
      idempotencyKey: workflowKey.judgments(
        rerun.teamId,
        rerun.invoiceId,
        rerun.revision,
      ),
    });
    rescheduled += 1;
  }
  for (const document of stalled) {
    const settled = await db.transaction(async (tx) => {
      const executor = asDatabase(tx);
      await lockInvoiceForAction(executor, {
        id: document.id,
        teamId: document.teamId,
      });
      const [still] = await listStalledProcessing(executor, {
        teamId: document.teamId,
        invoiceId: document.id,
        limit: 1,
      });
      if (!still) return undefined;
      return recordInboxProcessingFailure(executor, {
        id: document.id,
        teamId: document.teamId,
        error: TEMPORARY_PROCESSING_FAILURE,
      });
    });
    if (settled) failed += 1;
  }
  return { rescheduled, failed };
}
