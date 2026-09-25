import type { Database } from "@invoicewise/db/client";
import {
  type AuditEvent,
  getInvoiceActivitySources,
} from "@invoicewise/db/queries";
import {
  type ActivityAudience,
  auditActionLabel,
  buildInvoiceActivity,
} from "@invoicewise/jobs/activity";

/**
 * One invoice's activity trace for a workspace member (names shown) or an
 * operator (ids only); null for an invoice outside the workspace.
 */
export async function readInvoiceActivity(
  db: Database,
  input: { teamId: string; invoiceId: string; audience: ActivityAudience },
) {
  const sources = await getInvoiceActivitySources(db, input);
  return sources
    ? buildInvoiceActivity(sources, { audience: input.audience })
    : null;
}

type AuditRow = Pick<
  AuditEvent,
  | "id"
  | "actorType"
  | "actorRef"
  | "surface"
  | "action"
  | "category"
  | "targetType"
  | "targetId"
  | "revision"
  | "outcome"
  | "detail"
  | "purpose"
  | "createdAt"
  | "settledAt"
> & {
  actor: { id: string; fullName: string | null; email: string | null } | null;
};

/** An audit event as the workspace's audit log and the operator view show it. */
export const presentAuditEvent = (row: AuditRow) => ({
  id: row.id,
  at: row.createdAt,
  settledAt: row.settledAt,
  action: row.action,
  label: auditActionLabel(row.action),
  category: row.category,
  outcome: row.outcome,
  surface: row.surface,
  actor: {
    type: row.actorType,
    id: row.actor?.id ?? null,
    name:
      row.actorType === "operator"
        ? (row.actorRef ?? "Operator")
        : (row.actor?.fullName ?? row.actor?.email ?? null),
    credentialId: row.actorType === "operator" ? null : row.actorRef,
  },
  target: row.targetType ? { type: row.targetType, id: row.targetId } : null,
  revision: row.revision,
  purpose: row.purpose,
  detail: row.detail,
});
