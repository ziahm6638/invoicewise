import type { Database } from "@db/client";
import { deliveryDecisions, deliveryPolicies, inbox, users } from "@db/schema";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { completedInvoiceColumns } from "./inbox";

/**
 * Durable state of the delivery rules (docs/delivery.md#delivery-rules):
 * immutable policy versions per workspace and one decision per invoice
 * revision. What a policy means is decided in `@invoicewise/jobs`; these
 * queries only store and read it.
 */

type Executor = Pick<Database, "select" | "insert" | "update" | "delete">;

export type DeliveryDecisionAccounting =
  (typeof deliveryDecisions.$inferSelect)["accounting"];

/** The workspace's newest policy version, or undefined for the defaults. */
export async function getLatestDeliveryPolicy(
  db: Pick<Database, "select">,
  teamId: string,
) {
  const [row] = await db
    .select({
      id: deliveryPolicies.id,
      version: deliveryPolicies.version,
      settings: deliveryPolicies.settings,
      createdAt: deliveryPolicies.createdAt,
      createdBy: {
        id: users.id,
        fullName: users.fullName,
      },
    })
    .from(deliveryPolicies)
    .leftJoin(users, eq(users.id, deliveryPolicies.createdBy))
    .where(eq(deliveryPolicies.teamId, teamId))
    .orderBy(desc(deliveryPolicies.version))
    .limit(1);
  return row;
}

/** Every version of the workspace's policy, newest first. */
export async function listDeliveryPolicyVersions(
  db: Pick<Database, "select">,
  teamId: string,
  limit = 20,
) {
  return db
    .select({
      id: deliveryPolicies.id,
      version: deliveryPolicies.version,
      settings: deliveryPolicies.settings,
      createdAt: deliveryPolicies.createdAt,
      createdBy: {
        id: users.id,
        fullName: users.fullName,
      },
    })
    .from(deliveryPolicies)
    .leftJoin(users, eq(users.id, deliveryPolicies.createdBy))
    .where(eq(deliveryPolicies.teamId, teamId))
    .orderBy(desc(deliveryPolicies.version))
    .limit(limit);
}

/**
 * Serialises policy changes of one workspace, so two saves of the same
 * version produce one new version and the other is refused.
 */
export async function lockDeliveryPolicies(db: Database, teamId: string) {
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`delivery-policy:${teamId}`}))`,
  );
}

export async function insertDeliveryPolicyVersion(
  db: Executor,
  values: {
    teamId: string;
    version: number;
    settings: Record<string, unknown>;
    createdBy: string | null;
  },
) {
  const [row] = await db
    .insert(deliveryPolicies)
    .values(values)
    .onConflictDoNothing({
      target: [deliveryPolicies.teamId, deliveryPolicies.version],
    })
    .returning();
  return row;
}

export const deliveryDecisionColumns = {
  id: deliveryDecisions.id,
  invoiceId: deliveryDecisions.invoiceId,
  revision: deliveryDecisions.revision,
  policyId: deliveryDecisions.policyId,
  policyVersion: deliveryDecisions.policyVersion,
  policy: deliveryDecisions.policy,
  rulesVersion: deliveryDecisions.rulesVersion,
  outcome: deliveryDecisions.outcome,
  reasons: deliveryDecisions.reasons,
  accounting: deliveryDecisions.accounting,
  webhooks: deliveryDecisions.webhooks,
  resolution: deliveryDecisions.resolution,
  resolutionReason: deliveryDecisions.resolutionReason,
  resolvedBy: deliveryDecisions.resolvedBy,
  resolvedAt: deliveryDecisions.resolvedAt,
  createdAt: deliveryDecisions.createdAt,
};

export type DeliveryDecisionRecord = Awaited<
  ReturnType<typeof insertDeliveryDecision>
>;

/**
 * Records the decision of one invoice revision. A revision is decided once:
 * a replay of the same revision returns the decision already made.
 */
export async function insertDeliveryDecision(
  db: Executor,
  values: typeof deliveryDecisions.$inferInsert,
) {
  const [inserted] = await db
    .insert(deliveryDecisions)
    .values(values)
    .onConflictDoNothing({
      target: [deliveryDecisions.invoiceId, deliveryDecisions.revision],
    })
    .returning(deliveryDecisionColumns);
  if (inserted) return inserted;
  const [existing] = await db
    .select(deliveryDecisionColumns)
    .from(deliveryDecisions)
    .where(
      and(
        eq(deliveryDecisions.invoiceId, values.invoiceId),
        eq(deliveryDecisions.revision, values.revision),
      ),
    )
    .limit(1);
  if (!existing) throw new Error("Unable to record the delivery decision");
  return existing;
}

export async function getDeliveryDecision(
  db: Pick<Database, "select">,
  params: { invoiceId: string; teamId: string; revision: number },
) {
  const [row] = await db
    .select(deliveryDecisionColumns)
    .from(deliveryDecisions)
    .where(
      and(
        eq(deliveryDecisions.invoiceId, params.invoiceId),
        eq(deliveryDecisions.teamId, params.teamId),
        eq(deliveryDecisions.revision, params.revision),
      ),
    )
    .limit(1);
  return row;
}

/** The invoice's decisions, newest revision first, with who resolved them. */
export async function listDeliveryDecisions(
  db: Pick<Database, "select">,
  params: { invoiceId: string; teamId: string; limit?: number },
) {
  return db
    .select({
      ...deliveryDecisionColumns,
      resolver: { id: users.id, fullName: users.fullName },
    })
    .from(deliveryDecisions)
    .leftJoin(users, eq(users.id, deliveryDecisions.resolvedBy))
    .where(
      and(
        eq(deliveryDecisions.invoiceId, params.invoiceId),
        eq(deliveryDecisions.teamId, params.teamId),
      ),
    )
    .orderBy(desc(deliveryDecisions.revision))
    .limit(params.limit ?? 20);
}

/**
 * Settles a held decision as released or dismissed, once: a second
 * resolution (a double click, a second tab) updates nothing and gets null.
 */
export async function resolveDeliveryDecision(
  db: Executor,
  params: {
    id: string;
    teamId: string;
    resolution: "released" | "dismissed";
    reason: string;
    resolvedBy: string;
  },
) {
  const [row] = await db
    .update(deliveryDecisions)
    .set({
      resolution: params.resolution,
      resolutionReason: params.reason,
      resolvedBy: params.resolvedBy,
      resolvedAt: sql`now()`,
    })
    .where(
      and(
        eq(deliveryDecisions.id, params.id),
        eq(deliveryDecisions.teamId, params.teamId),
        eq(deliveryDecisions.outcome, "hold"),
        isNull(deliveryDecisions.resolution),
      ),
    )
    .returning(deliveryDecisionColumns);
  return row;
}

/**
 * Whether webhook events of this invoice revision are withheld: its decision
 * held them and no one has released it.
 */
export async function webhooksHeldFor(
  db: Pick<Database, "select">,
  params: { invoiceId: string; teamId: string; revision: number },
) {
  const decision = await getDeliveryDecision(db, params);
  return decision?.webhooks === "held" && decision.resolution !== "released";
}

/** A processed invoice as its revision's deliveries carry it, locked. */
export async function getCompletedInvoiceForUpdate(
  db: Executor,
  params: { id: string; teamId: string },
) {
  const [row] = await db
    .select({
      ...completedInvoiceColumns,
      intakeState: inbox.intakeState,
      processingError: inbox.processingError,
    })
    .from(inbox)
    .where(and(eq(inbox.id, params.id), eq(inbox.teamId, params.teamId)))
    .for("update")
    .limit(1);
  return row;
}

/** The supplier-history checks recorded for an invoice. */
export async function getInvoiceSupplierChecks(
  db: Pick<Database, "select">,
  params: { id: string; teamId: string },
) {
  const [row] = await db
    .select({ supplierChecks: inbox.supplierChecks })
    .from(inbox)
    .where(and(eq(inbox.id, params.id), eq(inbox.teamId, params.teamId)))
    .limit(1);
  return row?.supplierChecks ?? null;
}
