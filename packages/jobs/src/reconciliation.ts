/**
 * Reconciling invoices with the authorization sources they are matched to.
 *
 * Every match decision (automatic or a person's) and every new revision of
 * an invoice queues a `reconcile-invoice` job for that decision at that
 * revision. The job asks TypeSafe, outside any transaction, only whether
 * unpaired invoice lines fall within their source's written scope; then,
 * under the invoice's lock and its sources' locks (so two invoices billing
 * one source are reconciled one after the other), it reads what the
 * sources' other invoices consume, reconciles in plain code, records the
 * immutable result, announces `invoice.reconciled` and decides the revision
 * when the delivery rules were waiting for it.
 *
 * The rules are in `packages/documents/src/reconciliation.ts`;
 * `docs/reconciliation.md` publishes them.
 */
import type { Database } from "@invoicewise/db/client";
import {
  type MatchSourceVersionRow,
  type ReconciliationRow,
  WEBHOOK_PAYLOAD_VERSION,
  enqueueWorkflowJob,
  getInvoiceForMatching,
  getMatchSourceVersions,
  getMatchSources,
  getReconciliation,
  getReconciliationFor,
  getSourceMatch,
  listSourceConsumption,
  listStalledPendingDecisions,
  lockInvoiceForMatching,
  lockSourcesForReconciliation,
  recordReconciliation,
} from "@invoicewise/db/queries";
import {
  type AuthorizationLine,
  RECONCILIATION_VERSION,
  type ReconciliationForPolicy,
  type ReconciliationResult,
  type ReconciliationSource,
  type ReconciliationTerms,
  type ScopeJudge,
  type ScopeJudgment,
  type SourceMatchResult,
  judgeScopeLive,
  reconcileInvoice,
  reconciliationFingerprint,
  scopeQuestionsFor,
  sourceBalance,
  sourceBasisOf,
  summarizeConsumption,
} from "@invoicewise/documents";
import { workflowKey } from "./client";
import {
  decideDeferredRevision,
  logicalEventId,
  scheduleWebhookEvent,
} from "./delivery";

/** TypeSafe was unavailable and another attempt may succeed. */
class ScopeJudgmentUnavailable extends Error {
  readonly retryable = true;
}

export const termsOf = (row: MatchSourceVersionRow): ReconciliationTerms => ({
  versionId: row.id,
  version: row.version,
  status: row.status,
  title: row.title,
  scope: row.scope,
  currency: row.currency,
  taxBasis: row.taxBasis,
  startsOn: row.startsOn,
  endsOn: row.endsOn,
  authorizedTotal: row.authorizedTotal,
  lines: (row.lineItems ?? []) as unknown as AuthorizationLine[],
});

const today = (now: Date) => now.toISOString().slice(0, 10);

/**
 * Queues the reconciliation of one match decision at one invoice revision.
 * Runs in the transaction that records the decision or the revision; the
 * key makes retries and replays share one job.
 */
export async function scheduleReconciliation(
  db: Database,
  input: {
    teamId: string;
    invoiceId: string;
    matchId: string;
    revision: number;
  },
) {
  const { job } = await enqueueWorkflowJob(db, {
    name: "reconcile-invoice",
    teamId: input.teamId,
    payload: input,
    idempotencyKey: workflowKey.reconcile(
      input.teamId,
      input.invoiceId,
      input.matchId,
      input.revision,
    ),
  });
  return job;
}

// --- Presenting ----------------------------------------------------------------------

/** A reconciliation as REST, MCP, the dashboard and webhooks show it. */
export const presentReconciliation = (row: ReconciliationRow) => {
  const { scopeJudgments: _cache, ...result } = row.result as Omit<
    ReconciliationResult,
    "status" | "consumes"
  > & { scopeJudgments?: unknown };
  return {
    ...result,
    id: row.id,
    sequence: row.sequence,
    matchId: row.matchId,
    processingRevision: row.processingRevision,
    status: row.status,
    consumes: row.consumes,
    rulesVersion: row.rulesVersion,
    reconciledAt: row.createdAt,
  };
};

/** What the delivery rules and a revision's events read of a reconciliation. */
export const reconciliationForPolicy = (
  row: Pick<ReconciliationRow, "status" | "result">,
): ReconciliationForPolicy => {
  const result = row.result as unknown as ReconciliationResult;
  return {
    status: row.status,
    discrepancies: result.discrepancies ?? [],
    unresolved: result.unresolved ?? [],
  };
};

/** The compact form a revision's `invoice.processed` event carries. */
const eventSummary = (row: ReconciliationRow) => {
  const result = row.result as unknown as ReconciliationResult;
  return {
    id: row.id,
    status: row.status,
    message: result.message,
    sources: result.sources.map((source) => ({
      sourceId: source.sourceId,
      reference: source.reference,
      balance: source.balance,
    })),
    discrepancies: result.discrepancies.map((item) => item.code),
    unresolved: result.unresolved.map((item) => item.code),
  };
};

async function announce(
  db: Database,
  input: { teamId: string; invoiceId: string; row: ReconciliationRow },
) {
  return scheduleWebhookEvent(db, {
    id: logicalEventId(input.invoiceId, "reconciliation", input.row.id),
    type: "invoice.reconciled",
    version: WEBHOOK_PAYLOAD_VERSION,
    createdAt: new Date().toISOString(),
    teamId: input.teamId,
    invoiceId: input.invoiceId,
    revision: input.row.processingRevision,
    data: {
      invoiceId: input.invoiceId,
      reconciliation: presentReconciliation(input.row),
    },
  });
}

// --- Reading the sources ---------------------------------------------------------------

/**
 * Each linked source's cited version (the one the match compared), the
 * version in effect today (else its newest) and what its other invoices
 * consume now. Call under the sources' locks for a reconciliation that
 * will be recorded.
 */
async function reconciliationSources(
  db: Database,
  input: {
    teamId: string;
    invoiceId: string;
    links: SourceMatchResult["links"];
    now: Date;
  },
): Promise<ReconciliationSource[]> {
  if (input.links.length === 0) return [];
  const sourceIds = input.links.map((link) => link.sourceId);
  const [cited, heads, rows] = await Promise.all([
    getMatchSourceVersions(db, {
      teamId: input.teamId,
      versionIds: input.links.map((link) => link.versionId),
    }),
    getMatchSources(db, {
      teamId: input.teamId,
      sourceIds,
      on: today(input.now),
      asOf: input.now.toISOString(),
    }),
    listSourceConsumption(db, {
      teamId: input.teamId,
      sourceIds,
      excludeInboxId: input.invoiceId,
    }),
  ]);
  return input.links.flatMap((link) => {
    const version = cited.find((row) => row.id === link.versionId);
    const head = heads.find((row) => row.id === link.sourceId);
    if (!version || !head) return [];
    const current = termsOf(head.effective ?? head.current);
    return [
      {
        sourceId: link.sourceId,
        type: head.type,
        reference: head.reference,
        cited: termsOf(version),
        current,
        prior: summarizeConsumption(
          rows.filter((row) => row.sourceId === link.sourceId),
          {
            currency: current.currency,
            basis: sourceBasisOf(current.taxBasis),
          },
        ),
      },
    ];
  });
}

// --- The job -----------------------------------------------------------------------------

export type ReconcileOutcome =
  | { outcome: "skipped"; reason: "not_found" | "superseded" }
  | { outcome: "unchanged"; reconciliationId: string; decided: boolean }
  | {
      outcome: "recorded";
      reconciliationId: string;
      status: string;
      webhooks: number;
      decided: boolean;
    };

/**
 * Reconciles one match decision at one invoice revision and, when the
 * delivery rules waited for it, decides the revision. A decision or
 * revision replaced meanwhile is skipped (its own job reconciles it); a
 * replay records nothing new.
 */
export async function reconcileInvoiceMatch(
  db: Database,
  input: {
    teamId: string;
    invoiceId: string;
    matchId: string;
    revision: number;
    judge?: ScopeJudge;
    finalAttempt?: boolean;
    now?: Date;
  },
): Promise<ReconcileOutcome> {
  const judge = input.judge ?? judgeScopeLive;
  const now = input.now ?? new Date();
  const invoice = await getInvoiceForMatching(db, {
    teamId: input.teamId,
    inboxId: input.invoiceId,
  });
  if (!invoice) return { outcome: "skipped", reason: "not_found" };
  if (
    invoice.status === "processing" ||
    invoice.processingRevision !== input.revision ||
    invoice.sourceMatchId !== input.matchId
  ) {
    return { outcome: "skipped", reason: "superseded" };
  }
  const match = await getSourceMatch(db, {
    teamId: input.teamId,
    matchId: input.matchId,
  });
  if (!match) return { outcome: "skipped", reason: "not_found" };
  const matched = match.result as unknown as SourceMatchResult;

  // Scope judgments are made before the transaction: TypeSafe is never
  // called while the sources are locked. A line already judged against the
  // same terms (a replay, an earlier revision) is not asked again.
  const unlocked = await reconciliationSources(db, {
    teamId: input.teamId,
    invoiceId: input.invoiceId,
    links: matched.links,
    now,
  });
  const questions = scopeQuestionsFor({
    extraction: invoice.extraction,
    match: { allocations: matched.allocations },
    sources: unlocked,
  });
  const previous = invoice.reconciliationId
    ? await getReconciliation(db, {
        teamId: input.teamId,
        id: invoice.reconciliationId,
      })
    : null;
  const cache = (previous?.result as { scopeJudgments?: CachedScope[] })
    ?.scopeJudgments;
  const scope: Record<string, ScopeJudgment> = {};
  const cached: CachedScope[] = [];
  const asked = questions.filter((question) => {
    const source = unlocked.find(
      (item) => item.sourceId === question.sourceId,
    )!;
    const hit = cache?.find(
      (item) =>
        item.key === question.key &&
        item.versionId === source.cited.versionId &&
        item.description === question.description,
    );
    if (hit) {
      scope[question.key] = hit.judgment;
      cached.push(hit);
      return false;
    }
    return true;
  });
  if (asked.length > 0) {
    const answer = await judge(
      asked.map((question) => {
        const source = unlocked.find(
          (item) => item.sourceId === question.sourceId,
        )!;
        return {
          key: question.key,
          description: question.description,
          quantity: question.quantity,
          unitPrice: question.unitPrice,
          total: question.total,
          source: {
            type: source.type,
            reference: source.reference,
            title: source.cited.title,
            scope: source.cited.scope,
            lines: source.cited.lines,
          },
        };
      }),
    );
    if (answer.status === "unavailable") {
      if (answer.retryable && !input.finalAttempt) {
        throw new ScopeJudgmentUnavailable(answer.reason);
      }
      for (const question of asked) {
        scope[question.key] = { status: "failed", reason: answer.reason };
      }
    } else {
      for (const question of asked) {
        const judgment = answer.judgments[question.key];
        scope[question.key] = judgment ?? {
          status: "failed",
          reason: "TypeSafe did not answer",
        };
        const source = unlocked.find(
          (item) => item.sourceId === question.sourceId,
        )!;
        if (judgment?.status === "answered") {
          cached.push({
            key: question.key,
            versionId: source.cited.versionId,
            description: question.description,
            judgment,
          });
        }
      }
    }
  }

  return db.transaction(async (tx) => {
    const executor = tx as unknown as Database;
    const locked = await lockInvoiceForMatching(executor, {
      teamId: input.teamId,
      inboxId: input.invoiceId,
    });
    if (!locked) return { outcome: "skipped", reason: "not_found" } as const;
    if (
      locked.status === "processing" ||
      locked.processingRevision !== input.revision ||
      locked.sourceMatchId !== input.matchId
    ) {
      return { outcome: "skipped", reason: "superseded" } as const;
    }
    const existing = await getReconciliationFor(executor, {
      teamId: input.teamId,
      inboxId: input.invoiceId,
      matchId: input.matchId,
      processingRevision: input.revision,
    });
    if (existing) {
      const decided = await decideDeferredRevision(executor, {
        teamId: input.teamId,
        invoiceId: input.invoiceId,
        revision: input.revision,
        reconciliation: reconciliationForPolicy(existing),
        summary: eventSummary(existing),
      });
      return {
        outcome: "unchanged",
        reconciliationId: existing.id,
        decided: decided !== null,
      } as const;
    }
    await lockSourcesForReconciliation(executor, {
      teamId: input.teamId,
      sourceIds: matched.links.map((link) => link.sourceId),
    });
    // Read again under the locks: what the sources' other invoices consume
    // now includes every reconciliation committed before this one.
    const sources = await reconciliationSources(executor, {
      teamId: input.teamId,
      invoiceId: input.invoiceId,
      links: matched.links,
      now,
    });
    const result = reconcileInvoice({
      extraction: locked.extraction,
      validation: locked.validation,
      match: {
        id: match.id,
        status: match.status as SourceMatchResult["status"],
        needsConfirmation: matched.needsConfirmation,
        invoiceDate: matched.invoiceDate ?? null,
        links: matched.links,
        allocations: matched.allocations,
        unallocatedLines: matched.allocation?.unallocatedLines ?? [],
      },
      sources,
      scope,
    });
    const row = await recordReconciliation(executor, {
      teamId: input.teamId,
      inboxId: input.invoiceId,
      matchId: match.id,
      processingRevision: input.revision,
      status: result.status,
      consumes: result.consumes,
      result: {
        ...result,
        scopeJudgments: cached,
        asOf: now.toISOString(),
      } as unknown as Record<string, unknown>,
      rulesVersion: RECONCILIATION_VERSION,
      fingerprint: reconciliationFingerprint(result),
      consumption: result.sources.flatMap((source) =>
        source.consumption.map((item) => ({
          sourceId: source.sourceId,
          ...item,
        })),
      ),
    });
    const webhooks = await announce(executor, {
      teamId: input.teamId,
      invoiceId: input.invoiceId,
      row,
    });
    const decided = await decideDeferredRevision(executor, {
      teamId: input.teamId,
      invoiceId: input.invoiceId,
      revision: input.revision,
      reconciliation: reconciliationForPolicy(row),
      summary: eventSummary(row),
    });
    return {
      outcome: "recorded",
      reconciliationId: row.id,
      status: row.status,
      webhooks,
      decided: decided !== null,
    } as const;
  });
}

type CachedScope = {
  key: string;
  versionId: string;
  description: string | null;
  judgment: ScopeJudgment;
};

// --- Stalled decisions ----------------------------------------------------------------

/**
 * Decides current revisions still waiting for a reconciliation whose job
 * was lost or failed for good, so no invoice waits for ever: with the
 * revision's reconciliation when it was recorded, else as not reconciled
 * (which the rules read as unresolved, never as reconciled). Run by the
 * workflow runner's reconciler.
 */
export async function settleStalledDecisions(
  db: Database,
  input: { teamId?: string; invoiceId?: string; limit?: number } = {},
) {
  const stalled = await listStalledPendingDecisions(db, {
    ...input,
    limit: input.limit ?? 100,
  });
  let decided = 0;
  for (const item of stalled) {
    const settled = await db.transaction(async (tx) => {
      const executor = tx as unknown as Database;
      const locked = await lockInvoiceForMatching(executor, {
        teamId: item.teamId,
        inboxId: item.invoiceId,
      });
      if (!locked || locked.processingRevision !== item.revision) return null;
      const current = locked.reconciliationId
        ? await getReconciliation(executor, {
            teamId: item.teamId,
            id: locked.reconciliationId,
          })
        : null;
      const usable =
        current &&
        current.processingRevision === item.revision &&
        current.matchId === locked.sourceMatchId
          ? current
          : null;
      return decideDeferredRevision(executor, {
        teamId: item.teamId,
        invoiceId: item.invoiceId,
        revision: item.revision,
        reconciliation: usable ? reconciliationForPolicy(usable) : null,
        summary: usable ? eventSummary(usable) : null,
      });
    });
    if (settled) decided += 1;
  }
  return { decided };
}

// --- A source's balance ------------------------------------------------------------------

/**
 * A source's balance now: the version in effect today (else its newest)
 * against every invoice currently counted against it. Returns null for a
 * source of another workspace.
 */
export async function getSourceBalance(
  db: Database,
  input: { teamId: string; sourceId: string; now?: Date },
) {
  const now = input.now ?? new Date();
  const [head] = await getMatchSources(db, {
    teamId: input.teamId,
    sourceIds: [input.sourceId],
    on: today(now),
    asOf: now.toISOString(),
  });
  if (!head) return null;
  const rows = await listSourceConsumption(db, {
    teamId: input.teamId,
    sourceIds: [input.sourceId],
  });
  return {
    sourceId: head.id,
    type: head.type,
    reference: head.reference,
    ...sourceBalance({
      terms: termsOf(head.effective ?? head.current),
      rows,
    }),
  };
}
