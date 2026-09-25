import type { Database } from "@invoicewise/db/client";
import {
  type DeliveryDecisionRecord,
  type TeamRole,
  canManageDeliveryRules,
  enqueueWorkflowJob,
  finalizeDeliveryDecision,
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
  type ReconciliationForPolicy,
  evaluateDeliveryPolicy,
  normalizeDeliveryPolicy,
  policyUsesReconciliation,
  validateInvoice,
} from "@invoicewise/documents";
import { InvoiceActionError } from "./action-error";
import { workflowKey } from "./client";

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

/** What the scheduling of a revision asks of its decision. */
export type DecisionOptions = {
  /** An extra hold only an admin's release clears (a member corrected an invoice that was held). */
  approval?: string | null;
  /** False: the caller schedules no post for this revision. */
  accounting?: boolean;
  /** What the revision's webhook events carry beyond the record. */
  data?: Record<string, unknown>;
};

/**
 * The decision's verdict for one revision under the policy in force, with
 * its reconciliation when the policy reads one.
 */
async function evaluateRevision(
  db: Database,
  invoice: DecidedInvoice & { teamId: string },
  current: Awaited<ReturnType<typeof loadDeliveryPolicy>>,
  options: Omit<DecisionOptions, "data"> & {
    reconciliation: ReconciliationForPolicy | null;
  },
) {
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
    reconciliation: options.reconciliation,
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
  const outcome = reasons.length > 0 ? ("hold" as const) : ("deliver" as const);
  const posted =
    Boolean(invoice.accountingProviderId) ||
    invoice.accountingPostStatus === "posted" ||
    invoice.accountingPostStatus === "already_posted";
  const accounting = !current.policy.destinations.accounting
    ? ("off" as const)
    : !evaluation.accountingApplicable
      ? ("not_applicable" as const)
      : posted
        ? ("already_posted" as const)
        : !(await getActiveAccountingConnection(db, invoice.teamId))
          ? ("not_connected" as const)
          : outcome === "hold"
            ? ("held" as const)
            : options.accounting === false
              ? ("not_scheduled" as const)
              : ("deliver" as const);
  const webhooks =
    outcome === "hold" && current.policy.destinations.webhooks === "eligible"
      ? ("held" as const)
      : ("deliver" as const);
  return {
    policyId: current.id,
    policyVersion: current.version,
    policy: current.policy as unknown as Record<string, unknown>,
    rulesVersion: DELIVERY_RULES_VERSION,
    outcome,
    reasons: reasons as unknown as Record<string, unknown>[],
    accounting,
    webhooks,
  };
}

/**
 * Decides one invoice revision under the workspace's current policy and
 * records it. A revision is decided once: replaying it returns the decision
 * already recorded.
 *
 * When the policy holds on an authorization check, the revision cannot be
 * decided before it is reconciled: it gets a `pending` decision that
 * schedules nothing, keeps what `options` asked for, and queues the
 * revision's matching (which then reconciles it and decides it with
 * `decideDeferredRevision`). `options.reconciliation` decides it now instead.
 */
export async function decideRevision(
  db: Database,
  invoice: DecidedInvoice & { teamId: string },
  options: DecisionOptions & {
    reconciliation?: ReconciliationForPolicy | null;
  } = {},
) {
  const current = await loadDeliveryPolicy(db, invoice.teamId);
  if (
    options.reconciliation === undefined &&
    policyUsesReconciliation(current.policy)
  ) {
    const decision = await insertDeliveryDecision(db, {
      teamId: invoice.teamId,
      invoiceId: invoice.id,
      revision: invoice.processingRevision,
      policyId: current.id,
      policyVersion: current.version,
      policy: current.policy as unknown as Record<string, unknown>,
      rulesVersion: DELIVERY_RULES_VERSION,
      outcome: "pending",
      reasons: [
        {
          code: "awaiting_reconciliation",
          rule: "reconciliation",
          message:
            "Waiting for the invoice to be matched and reconciled with its authorization sources; it is decided then.",
          locked: false,
        },
      ],
      accounting: "pending",
      webhooks: "pending",
      deferred: {
        approval: options.approval ?? null,
        accounting: options.accounting ?? null,
        data: options.data ?? null,
      },
    });
    // Processing and corrections queue this already; a question rerun's
    // revision is matched (and so reconciled) here.
    await enqueueWorkflowJob(db, {
      name: "match-invoice",
      teamId: invoice.teamId,
      payload: { teamId: invoice.teamId, invoiceId: invoice.id },
      idempotencyKey: workflowKey.match(
        invoice.teamId,
        invoice.id,
        invoice.processingRevision,
      ),
    });
    return decision;
  }
  return insertDeliveryDecision(db, {
    teamId: invoice.teamId,
    invoiceId: invoice.id,
    revision: invoice.processingRevision,
    ...(await evaluateRevision(db, invoice, current, {
      approval: options.approval,
      accounting: options.accounting,
      reconciliation: options.reconciliation ?? null,
    })),
  });
}

/**
 * Decides a revision whose decision waited for its reconciliation, under
 * the policy in force now and with what its scheduling asked for. Returns
 * null when it is not pending (already decided by a replay).
 */
export async function finalizeDeferredDecision(
  db: Database,
  invoice: DecidedInvoice & { teamId: string },
  pending: DeliveryDecisionRecord,
  reconciliation: ReconciliationForPolicy | null,
) {
  const deferred = (pending.deferred ?? {}) as {
    approval?: string | null;
    accounting?: boolean | null;
  };
  const current = await loadDeliveryPolicy(db, invoice.teamId);
  const values = await evaluateRevision(db, invoice, current, {
    approval: deferred.approval ?? null,
    accounting: deferred.accounting ?? undefined,
    reconciliation,
  });
  return finalizeDeliveryDecision(db, {
    id: pending.id,
    teamId: invoice.teamId,
    values,
  });
}

/** Whether a decision withheld any destination. */
export const decisionHeld = (
  decision: Pick<DeliveryDecisionRecord, "accounting" | "webhooks">,
) => decision.accounting === "held" || decision.webhooks === "held";

/** Whether a decision still waits for the revision's reconciliation. */
export const decisionPending = (
  decision: Pick<DeliveryDecisionRecord, "outcome"> | null | undefined,
) => decision?.outcome === "pending";

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
