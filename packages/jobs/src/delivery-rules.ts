import type { Database } from "@invoicewise/db/client";
import {
  type DeliveryDecisionRecord,
  type TeamRole,
  canManageDeliveryRules,
  getActiveAccountingConnection,
  getInvoiceSupplierChecks,
  getLatestDeliveryPolicy,
  getUserQuestions,
  insertDeliveryDecision,
  insertDeliveryPolicyVersion,
  lockDeliveryPolicies,
} from "@invoicewise/db/queries";
import {
  CONFIGURABLE_DELIVERY_RULES,
  DEFAULT_DELIVERY_POLICY,
  DELIVERY_RULES_VERSION,
  type DeliveryPolicy,
  type DeliveryReason,
  type PolicyQuestion,
  evaluateDeliveryPolicy,
  normalizeDeliveryPolicy,
  validateInvoice,
} from "@invoicewise/documents";
import { InvoiceActionError } from "./action-error";

/**
 * The workspace delivery policy and the decision each invoice revision gets
 * from it (docs/delivery.md#delivery-rules). The decision is made in the
 * transaction that schedules the revision's deliveries, so a destination is
 * scheduled if and only if its decision let it through, and the decision
 * records the policy version and reasons it was made with.
 */

/** A stored policy, completed with the defaults for any rule added since. */
const policyFrom = (settings: unknown): DeliveryPolicy => {
  const stored = (settings ?? {}) as Partial<DeliveryPolicy>;
  return {
    destinations: {
      ...DEFAULT_DELIVERY_POLICY.destinations,
      ...stored.destinations,
    },
    rules: Object.fromEntries(
      CONFIGURABLE_DELIVERY_RULES.map((rule) => [
        rule,
        stored.rules?.[rule] ?? DEFAULT_DELIVERY_POLICY.rules[rule],
      ]),
    ) as DeliveryPolicy["rules"],
    requiredQuestions: stored.requiredQuestions ?? [],
    conditions: stored.conditions ?? [],
  };
};

/**
 * The policy in force for a workspace: its newest version, or the built-in
 * defaults as version 0 when no one has changed them.
 */
export async function loadDeliveryPolicy(db: Database, teamId: string) {
  const latest = await getLatestDeliveryPolicy(db, teamId);
  return {
    id: latest?.id ?? null,
    version: latest?.version ?? 0,
    policy: policyFrom(latest?.settings),
    createdAt: latest?.createdAt ?? null,
    createdBy: latest?.createdBy?.id ? latest.createdBy : null,
  };
}

/**
 * The workspace's questions as a condition may refer to them. A disabled
 * question is not asked, so requiring it holds every invoice.
 */
export async function policyQuestions(
  db: Database,
  teamId: string,
): Promise<(PolicyQuestion & { enabled: boolean })[]> {
  return (await getUserQuestions(db, teamId)).map((question) => ({
    key: question.questionKey,
    label: question.label,
    type: question.type,
    options: question.options,
    enabled: question.enabled,
  }));
}

/**
 * Saves a new version of the workspace's policy. The caller names the
 * version it edited, so two admins saving at once produce one new version
 * and the other is refused as a conflict. Decisions already made keep the
 * version they were made under: nothing is re-decided or re-sent.
 */
export async function saveDeliveryPolicy(
  db: Database,
  input: {
    teamId: string;
    actorId: string | null;
    teamRole: TeamRole | null;
    expectedVersion: number;
    settings: unknown;
  },
) {
  if (!canManageDeliveryRules(input.teamRole)) {
    throw new InvoiceActionError(
      "forbidden",
      "Only workspace owners and admins can change the delivery rules.",
    );
  }
  const questions = await policyQuestions(db, input.teamId);
  const normalized = normalizeDeliveryPolicy(input.settings, questions);
  if (!normalized.ok) {
    throw new InvoiceActionError(
      "invalid",
      normalized.issues.map((issue) => issue.message).join(" "),
      normalized.issues.map((issue) => ({
        field: issue.path,
        message: issue.message,
      })),
    );
  }
  return db.transaction(async (tx) => {
    const executor = tx as unknown as Database;
    await lockDeliveryPolicies(executor, input.teamId);
    const current = await loadDeliveryPolicy(executor, input.teamId);
    if (current.version !== input.expectedVersion) {
      throw new InvoiceActionError(
        "conflict",
        "The delivery rules changed since you opened them. Reload them to see the current rules, then try again.",
      );
    }
    const saved = await insertDeliveryPolicyVersion(executor, {
      teamId: input.teamId,
      version: current.version + 1,
      settings: normalized.policy as unknown as Record<string, unknown>,
      createdBy: input.actorId,
    });
    if (!saved) {
      throw new InvoiceActionError(
        "conflict",
        "The delivery rules changed since you opened them. Reload them and try again.",
      );
    }
    return {
      id: saved.id,
      version: saved.version,
      policy: normalized.policy,
      createdAt: saved.createdAt,
    };
  });
}

/** An invoice revision as the delivery decision reads it. */
export type DecidedInvoice = {
  id: string;
  teamId: string | null;
  processingRevision: number;
  extraction: unknown;
  validation: unknown;
  judgments: unknown;
  accountingPostStatus: string | null;
  accountingProviderId: string | null;
};

/**
 * Decides one invoice revision under the workspace's current policy and
 * records it. `approval`, when given, is an extra hold only an admin's
 * release clears (a member corrected an invoice that was held).
 * `accounting: false` records a post the rules would let through as
 * `not_scheduled`: the caller schedules none for this revision. A revision
 * is decided once: replaying it returns the decision already recorded.
 */
export async function decideRevision(
  db: Database,
  invoice: DecidedInvoice & { teamId: string },
  options: { approval?: string | null; accounting?: boolean } = {},
) {
  const current = await loadDeliveryPolicy(db, invoice.teamId);
  const supplierChecks = await getInvoiceSupplierChecks(db, {
    id: invoice.id,
    teamId: invoice.teamId,
  });
  const evaluation = evaluateDeliveryPolicy({
    policy: current.policy,
    extraction: invoice.extraction,
    // A record completed without a stored validation is validated from its
    // extraction, as the accounting job does at posting time.
    validation:
      invoice.validation ??
      (invoice.extraction ? validateInvoice(invoice.extraction) : null),
    supplierChecks,
    judgments: invoice.judgments,
  });
  const reasons: DeliveryReason[] = [...evaluation.reasons];
  if (options.approval) {
    reasons.push({
      code: "awaiting_approval",
      rule: "approval",
      message: options.approval,
      locked: false,
    });
  }
  const outcome = reasons.length > 0 ? "hold" : "deliver";
  const posted =
    Boolean(invoice.accountingProviderId) ||
    invoice.accountingPostStatus === "posted" ||
    invoice.accountingPostStatus === "already_posted";
  const accounting = !current.policy.destinations.accounting
    ? "off"
    : !evaluation.accountingApplicable
      ? "not_applicable"
      : posted
        ? "already_posted"
        : !(await getActiveAccountingConnection(db, invoice.teamId))
          ? "not_connected"
          : outcome === "hold"
            ? "held"
            : options.accounting === false
              ? "not_scheduled"
              : "deliver";
  const webhooks =
    outcome === "hold" && current.policy.destinations.webhooks === "eligible"
      ? "held"
      : "deliver";
  return insertDeliveryDecision(db, {
    teamId: invoice.teamId,
    invoiceId: invoice.id,
    revision: invoice.processingRevision,
    policyId: current.id,
    policyVersion: current.version,
    policy: current.policy as unknown as Record<string, unknown>,
    rulesVersion: DELIVERY_RULES_VERSION,
    outcome,
    reasons: reasons as unknown as Record<string, unknown>[],
    accounting,
    webhooks,
  });
}

/** Whether a decision withheld any destination. */
export const decisionHeld = (
  decision: Pick<DeliveryDecisionRecord, "accounting" | "webhooks">,
) => decision.accounting === "held" || decision.webhooks === "held";

/**
 * What a delivery carries about the decision that let it through: consumers
 * see the policy version, the verdict, its reasons and any release.
 */
export const decisionSummary = (decision: DeliveryDecisionRecord) => ({
  id: decision.id,
  policyVersion: decision.policyVersion,
  rulesVersion: decision.rulesVersion,
  outcome: decision.outcome,
  reasons: decision.reasons,
  accounting: decision.accounting,
  webhooks: decision.webhooks,
  resolution: decision.resolution,
  resolutionReason: decision.resolutionReason,
  resolvedAt: decision.resolvedAt,
});
