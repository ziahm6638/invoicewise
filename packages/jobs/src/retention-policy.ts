/**
 * InvoiceWise's current operating retention policy.
 *
 * These are operating defaults, changeable by configuration. They describe
 * what the service does today; they are not a legal or contractual promise.
 * Each value can be overridden with the environment variable named beside it
 * (a whole number of days, or hours for the export link).
 */
export type RetentionPolicy = {
  /**
   * Uploads that never became documents, and the records of deleted invoices
   * (both are cancelled intake).
   */
  failedUploadDays: number;
  /** The provider message reference kept from a source email. */
  sourceEmailDays: number;
  /** Payloads, results and errors of finished jobs and webhook deliveries. */
  jobPayloadDays: number;
  /** Application logs on the production host. */
  logDays: number;
  /** Nightly database dumps (ops/backup). */
  backupDays: number;
  /** How long a finished data export can be downloaded. */
  exportLinkHours: number;
};

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  failedUploadDays: 30,
  sourceEmailDays: 90,
  jobPayloadDays: 30,
  logDays: 30,
  backupDays: 30,
  exportLinkHours: 24,
};

const ENV_NAMES: Record<keyof RetentionPolicy, string> = {
  failedUploadDays: "RETENTION_FAILED_UPLOAD_DAYS",
  sourceEmailDays: "RETENTION_SOURCE_EMAIL_DAYS",
  jobPayloadDays: "RETENTION_JOB_PAYLOAD_DAYS",
  logDays: "RETENTION_LOG_DAYS",
  backupDays: "RETENTION_BACKUP_DAYS",
  exportLinkHours: "EXPORT_LINK_TTL_HOURS",
};

/**
 * Reads the policy from the environment. A value that is set but is not a
 * positive whole number is a configuration error, never silently replaced by
 * the default.
 */
export function resolveRetentionPolicy(
  env: Record<string, string | undefined> = process.env,
): RetentionPolicy {
  const policy = { ...DEFAULT_RETENTION_POLICY };

  for (const key of Object.keys(ENV_NAMES) as (keyof RetentionPolicy)[]) {
    const name = ENV_NAMES[key];
    const raw = env[name]?.trim();
    if (!raw) continue;
    if (!/^\d+$/.test(raw) || Number(raw) < 1) {
      throw new Error(`${name} must be a positive whole number, got "${raw}"`);
    }
    policy[key] = Number(raw);
  }

  return policy;
}

export type RetentionPolicyEntry = {
  key: string;
  label: string;
  period: string;
  /** What happens when the period ends, and what applies it. */
  appliedBy: string;
};

const days = (value: number) => `${value} day${value === 1 ? "" : "s"}`;
const hours = (value: number) => `${value} hour${value === 1 ? "" : "s"}`;

/** The policy as the owner-facing schedule and docs present it. */
export function describeRetentionPolicy(
  policy: RetentionPolicy,
): RetentionPolicyEntry[] {
  return [
    {
      key: "active",
      label: "Invoices, original documents and judgments",
      period: "While the workspace exists",
      appliedBy:
        "A member deleting an invoice removes its file at once and its record with the failed uploads below; deleting the workspace removes everything.",
    },
    {
      key: "failed-uploads",
      label: "Failed uploads and deleted invoices",
      period: `${days(policy.failedUploadDays)} after upload`,
      appliedBy:
        "Uploads that never became documents, and the records of invoices a member deleted, are removed by the hourly retention job.",
    },
    {
      key: "source-email",
      label: "Source email reference",
      period: `${days(policy.sourceEmailDays)} after processing`,
      appliedBy:
        "Email bodies are never stored. The provider message reference kept for de-duplication is cleared by the retention job; the invoice itself stays.",
    },
    {
      key: "job-payloads",
      label: "Job and webhook payloads",
      period: days(policy.jobPayloadDays),
      appliedBy:
        "Finished jobs and webhook deliveries keep their status and times; their payloads are emptied by the retention job.",
    },
    {
      key: "logs",
      label: "Application logs",
      period: days(policy.logDays),
      appliedBy:
        "Operating target for host logs. Logs are rotated by size today, so this period is not yet enforced by time.",
    },
    {
      key: "backups",
      label: "Database backups",
      period: days(policy.backupDays),
      appliedBy:
        "Nightly dumps older than this are removed by the backup job. Deleted data stays in older dumps until they expire.",
    },
    {
      key: "exports",
      label: "Data export downloads",
      period: hours(policy.exportLinkHours),
      appliedBy:
        "The archive stops downloading when it expires and is removed by the hourly retention job.",
    },
    {
      key: "deletion-requests",
      label: "Deletion records",
      period: `${days(policy.backupDays)} after completion`,
      appliedBy:
        "Kept only while a backup could restore the deleted data, and never with names or email addresses; then removed.",
    },
  ];
}
