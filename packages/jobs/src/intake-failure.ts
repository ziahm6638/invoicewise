/**
 * One classification for intake failures, shared by every mailbox caller.
 *
 * `storage_unavailable` means the object could not be stored or read back
 * within this attempt. `temporarily_unavailable` means validation could not
 * obtain a parser process (capacity, startup or resource-monitor failure). In
 * both cases nothing verifies a problem with the document, so the delivery
 * must be retried rather than acknowledged. `queue_full` means intake is
 * holding back new work while the processing queue is over its bound. Every other rejection is
 * permanent for this content and is surfaced without retry.
 */
export const TRANSIENT_INTAKE_CODES = [
  "storage_unavailable",
  "temporarily_unavailable",
  "queue_full",
] as const;

export type TransientIntakeCode = (typeof TRANSIENT_INTAKE_CODES)[number];

export const isTransientIntakeFailure = (
  code: string | null | undefined,
): code is TransientIntakeCode =>
  TRANSIENT_INTAKE_CODES.includes(code as TransientIntakeCode);
