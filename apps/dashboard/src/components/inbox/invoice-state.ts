export type InvoiceState =
  | "processing"
  | "extracted"
  | "judged"
  | "delivering"
  | "delivered"
  | "delivery_failed"
  | "failed";

type InvoiceRecord = {
  status?: string | null;
  extraction?: Record<string, unknown> | null;
  judgments?: Record<string, unknown>[] | null;
  processingError?: string | null;
  /**
   * Server-derived outcome of the current revision's configured
   * destinations (webhooks and accounting). Absent or "none" when no
   * destination is configured.
   */
  delivery?: { state: string } | null;
  /**
   * The record is still `processing` but its processing job failed and none
   * is pending: it will not finish on its own, so it reads as failed and can
   * be re-extracted.
   */
  processingStalled?: boolean | null;
};

export function getInvoiceState(invoice: InvoiceRecord): InvoiceState {
  if (invoice.processingStalled) return "failed";
  if (["new", "processing", "analyzing"].includes(invoice.status ?? "")) {
    return "processing";
  }

  if (invoice.processingError || !invoice.extraction) return "failed";
  // Delivery reflects actual destination outcomes; the legacy `done` status
  // does not mean anything was delivered.
  if (invoice.delivery?.state === "failed") return "delivery_failed";
  if (invoice.delivery?.state === "pending") return "delivering";
  if (invoice.delivery?.state === "delivered") return "delivered";
  if (invoice.judgments?.length) return "judged";
  return "extracted";
}

export const invoiceStateLabel: Record<InvoiceState, string> = {
  processing: "Processing",
  extracted: "Extracted",
  judged: "Judged",
  delivering: "Delivering",
  delivered: "Delivered",
  delivery_failed: "Delivery failed",
  failed: "Failed",
};

export function getExtractionText(
  extraction: Record<string, unknown> | null | undefined,
  key: string,
) {
  const value = extraction?.[key];
  return typeof value === "string" && value.trim() ? value : null;
}

export const STALLED_PROCESSING_REASON =
  "Reading this invoice stopped before it finished. Re-extract it to try again.";

/** The exception states the invoice list can be filtered by. */
export const invoiceStateFilters = [
  { value: "needs_attention", label: "Needs attention" },
  { value: "failed", label: "Extraction failed" },
  { value: "invalid", label: "Invalid" },
  { value: "needs_review", label: "Needs review" },
  { value: "delivery_failed", label: "Delivery failed" },
  { value: "delivering", label: "Delivering" },
  { value: "delivered", label: "Delivered" },
  { value: "processing", label: "Processing" },
  { value: "corrected", label: "Corrected" },
] as const;

export type InvoiceStateFilter = (typeof invoiceStateFilters)[number]["value"];

export type WorkflowStageStatus =
  | "done"
  | "in_progress"
  | "attention"
  | "failed"
  | "not_started";

export type WorkflowStage = {
  key: "extraction" | "validation" | "questions" | "delivery";
  label: string;
  status: WorkflowStageStatus;
  /** What happened, including the reason for a failure. */
  summary: string;
  /** The next permitted action, in words; null when nothing is needed. */
  next: string | null;
};

type WorkflowRecord = InvoiceRecord & {
  validation?: Record<string, unknown> | null;
  judgmentsRerunStatus?: string | null;
  judgmentsRerunError?: string | null;
  correctionCount?: number | null;
  accountingPostStatus?: string | null;
  accountingProviderId?: string | null;
  delivery?: {
    state: string;
    total?: number;
    succeeded?: number;
    pending?: number;
    failed?: number;
    cancelled?: number;
  } | null;
};

const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? "" : "s"}`;

const issuesOf = (validation: Record<string, unknown> | null | undefined) =>
  (Array.isArray(validation?.issues) ? validation.issues : []).filter(
    (issue): issue is { severity: string; message: string } =>
      typeof issue === "object" &&
      issue !== null &&
      typeof (issue as { message?: unknown }).message === "string",
  );

/**
 * Where the invoice stands in each stage, with the reason and the next
 * permitted action. Queued work is always "in progress", never done: an
 * invoice is only delivered when its destinations report success.
 */
export function describeInvoiceWorkflow(
  invoice: WorkflowRecord,
  viewer: { postToAccounting: boolean },
): WorkflowStage[] {
  const state = getInvoiceState(invoice);
  const corrections = invoice.correctionCount ?? 0;
  // A failed re-read keeps the previous reading, so the later stages still
  // describe that reading and whatever was delivered from it.
  const keptReading = state === "failed" && Boolean(invoice.extraction);
  const extracted =
    state !== "processing" && (state !== "failed" || keptReading);

  const extraction: WorkflowStage =
    state === "processing"
      ? {
          key: "extraction",
          label: "Extraction",
          status: "in_progress",
          summary: "Reading the document. This usually takes under a minute.",
          next: null,
        }
      : state === "failed"
        ? {
            key: "extraction",
            label: "Extraction",
            status: "failed",
            summary: `${keptReading ? "The last re-read failed: " : ""}${
              invoice.processingStalled
                ? STALLED_PROCESSING_REASON
                : (invoice.processingError ??
                  "No invoice details could be read from this document.")
            }${keptReading ? " The previous reading is kept." : ""}`,
            next: "Re-extract the document, or upload a clearer copy.",
          }
        : {
            key: "extraction",
            label: "Extraction",
            status: "done",
            summary: corrections
              ? `Read from the document and corrected ${plural(corrections, "time")}. The original reading is kept in the history.`
              : "Read from the document.",
            next: null,
          };

  const validationStatus = invoice.validation?.status;
  const issues = issuesOf(invoice.validation);
  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity !== "error");
  const validation: WorkflowStage = !extracted
    ? {
        key: "validation",
        label: "Validation",
        status: "not_started",
        summary: "Runs once the document has been read.",
        next: null,
      }
    : validationStatus === "invalid"
      ? {
          key: "validation",
          label: "Validation",
          status: "failed",
          summary: `${plural(errors.length, "error")}: ${errors[0]?.message ?? "the checks failed."}`,
          next: "Correct the values that are wrong. Validation runs again on save, and an invalid invoice is not sent to accounting.",
        }
      : validationStatus === "needs_review"
        ? {
            key: "validation",
            label: "Validation",
            status: "attention",
            summary: `${plural(warnings.length, "warning")}: ${warnings[0]?.message ?? "some values need a check."}`,
            next: "Check the flagged values against the document and correct any that are wrong.",
          }
        : validationStatus === "valid"
          ? {
              key: "validation",
              label: "Validation",
              status: "done",
              summary: "Every check passed.",
              next: null,
            }
          : {
              key: "validation",
              label: "Validation",
              status: "not_started",
              summary: "This invoice was read before validation existed.",
              next: "Correct or re-extract it to validate it.",
            };

  const judgments = invoice.judgments ?? [];
  const unanswered = judgments.filter(
    (judgment) => judgment.status === "failed",
  ).length;
  const questions: WorkflowStage = !extracted
    ? {
        key: "questions",
        label: "Questions",
        status: "not_started",
        summary: "Answered once the document has been read.",
        next: null,
      }
    : invoice.judgmentsRerunStatus === "queued"
      ? {
          key: "questions",
          label: "Questions",
          status: "in_progress",
          summary: "Answering the questions again.",
          next: null,
        }
      : invoice.judgmentsRerunStatus === "failed"
        ? {
            key: "questions",
            label: "Questions",
            status: "failed",
            summary:
              invoice.judgmentsRerunError ??
              "The questions could not be answered again.",
            next: "Rerun the questions.",
          }
        : unanswered > 0
          ? {
              key: "questions",
              label: "Questions",
              status: "attention",
              summary: `${plural(unanswered, "question")} could not be answered.`,
              next: "Rerun the questions.",
            }
          : judgments.length === 0
            ? {
                key: "questions",
                label: "Questions",
                status: "not_started",
                summary: "No questions were asked of this invoice.",
                next: null,
              }
            : {
                key: "questions",
                label: "Questions",
                status: "done",
                summary: `${plural(judgments.length, "question")} answered.`,
                next: null,
              };

  const summary = invoice.delivery;
  const total = summary?.total ?? 0;
  const posted = Boolean(invoice.accountingProviderId);
  const delivery: WorkflowStage = !extracted
    ? {
        key: "delivery",
        label: "Delivery",
        status: "not_started",
        summary: "Nothing is delivered until the document has been read.",
        next: null,
      }
    : summary?.state === "failed"
      ? {
          key: "delivery",
          label: "Delivery",
          status: "failed",
          summary: `${summary.failed ?? 0} of ${plural(total, "destination")} failed or ${summary.failed === 1 ? "is" : "are"} held for review.`,
          next:
            invoice.accountingPostStatus === "failed" &&
            validationStatus === "invalid"
              ? viewer.postToAccounting
                ? "Correct the invoice; once it validates it is sent again."
                : "Correct the invoice; once it validates an admin must send it again."
              : "Retry delivery for the failed destinations below.",
        }
      : summary?.state === "pending"
        ? {
            key: "delivery",
            label: "Delivery",
            status: "in_progress",
            summary: `Queued for ${plural(summary.pending ?? total, "destination")}; not delivered yet.`,
            next: null,
          }
        : summary?.state === "delivered"
          ? {
              key: "delivery",
              label: "Delivery",
              status: "done",
              summary: `Delivered to ${plural(summary.succeeded ?? total, "destination")}${posted ? ", including the accounting bill" : ""}.`,
              next: null,
            }
          : summary?.state === "cancelled"
            ? {
                key: "delivery",
                label: "Delivery",
                status: "attention",
                summary:
                  "Every destination was removed before delivery, so nothing was sent.",
                next: "Reconnect the destination, then retry delivery.",
              }
            : {
                key: "delivery",
                label: "Delivery",
                status: "not_started",
                summary:
                  "No webhook or accounting connection was set up when this revision was saved.",
                next: null,
              };

  return [extraction, validation, questions, delivery];
}
