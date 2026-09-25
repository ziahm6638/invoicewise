/**
 * Matching invoices to the authorization sources they bill.
 *
 * `matchInvoice` runs as the `match-invoice` workflow once an invoice
 * revision has been processed (and again on request): it finds the
 * workspace's candidate sources, lets plain code decide on exact references,
 * asks TypeSafe only when none links the invoice, and records the decision.
 * Owners and admins confirm, correct or unlink a match; each change is a new
 * immutable decision with its reason, and a processing retry never replaces a
 * person's decision. Every decision is announced as `invoice.matched`.
 *
 * The rules are in `packages/documents/src/source-matching.ts`;
 * `docs/authorization-matching.md` publishes them.
 */
import { randomUUID } from "node:crypto";
import type { Database } from "@invoicewise/db/client";
import {
  type MatchSourceVersionRow,
  type NewSourceMatchLink,
  type SourceMatchRow,
  WEBHOOK_PAYLOAD_VERSION,
  enqueueWorkflowJob,
  findMatchCandidateSourceIds,
  getAuthorizationSourceVersion,
  getInvoiceForMatching,
  getMatchSourceVersions,
  getMatchSources,
  getSourceMatch,
  lockInvoiceForMatching,
  recordSourceMatch,
  workspaceHasAuthorizationSources,
} from "@invoicewise/db/queries";
import {
  type AllocationTarget,
  type AuthorizationLine,
  type AuthorizationSourceType,
  type InvoiceForMatching,
  type ManualAllocationInput,
  SOURCE_MATCHING_VERSION,
  SOURCE_MATCH_LIMITS,
  type SemanticSourceCandidate,
  type SourceCandidateInput,
  type SourceJudge,
  type SourceMatchResult,
  type SourceSemanticJudgment,
  type SourceVersionTerms,
  decideSourceMatch,
  invoiceReferencesOf,
  judgeSourceCandidatesLive,
  manualAllocations,
  matchingDateOf,
  prepareSourceMatch,
  referenceLookupKeys,
  sourceMatchFingerprint,
  summarizeAllocations,
  supplierKey,
} from "@invoicewise/documents";
import { logicalEventId, scheduleWebhookEvent } from "./delivery";

/** Unlinked sources compared by their supplied identifiers per invoice. */
const UNLINKED_SOURCES = 50;

export class SourceMatchError extends Error {
  override readonly name = "SourceMatchError";
  constructor(
    message: string,
    readonly code: "not_found" | "conflict" | "invalid" | "forbidden",
  ) {
    super(message);
  }
}

/** TypeSafe was unavailable and another attempt may succeed. */
class SemanticJudgmentUnavailable extends Error {
  readonly retryable = true;
}

// --- Reading sources ------------------------------------------------------------

const termsOf = (row: MatchSourceVersionRow): SourceVersionTerms => ({
  id: row.id,
  version: row.version,
  status: row.status,
  title: row.title,
  scope: row.scope,
  linkedSupplier: row.linkedSupplierId
    ? {
        id: row.linkedSupplierId,
        name: row.linkedSupplierName,
        nameKey: row.linkedSupplierNameKey ?? "",
        vatKey: row.linkedSupplierVatKey ?? "",
        companyKey: row.linkedSupplierCompanyKey ?? "",
      }
    : null,
  suppliedSupplier: {
    name: row.supplierName,
    nameKey: supplierKey(row.supplierName),
    vatKey: (row.supplierVatNumber ?? "")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, ""),
    companyKey: (() => {
      const compact = (row.supplierCompanyNumber ?? "")
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "");
      return /^\d{1,8}$/.test(compact) ? compact.padStart(8, "0") : compact;
    })(),
  },
  currency: row.currency,
  taxBasis: row.taxBasis,
  issuedOn: row.issuedOn,
  startsOn: row.startsOn,
  endsOn: row.endsOn,
  effectiveFrom: row.effectiveFrom,
  authorizedTotal: row.authorizedTotal,
  lines: (row.lineItems ?? []) as unknown as AuthorizationLine[],
});

const targetOf = (source: SourceCandidateInput): AllocationTarget => {
  const version = source.effective ?? source.current;
  return {
    sourceId: source.sourceId,
    versionId: version.id,
    referenceKey: source.referenceKey,
    taxBasis: version.taxBasis,
    lines: version.lines,
  };
};

const semanticCandidateOf = (
  source: SourceCandidateInput,
): SemanticSourceCandidate => {
  const version = source.effective ?? source.current;
  return {
    sourceId: source.sourceId,
    type: source.type,
    reference: source.reference,
    title: version.title,
    scope: version.scope,
    supplierName: version.linkedSupplier?.name ?? version.suppliedSupplier.name,
    currency: version.currency,
    startsOn: version.startsOn,
    endsOn: version.endsOn,
    authorizedTotal: version.authorizedTotal,
    lines: version.lines,
  };
};

type MatchingInvoice = NonNullable<
  Awaited<ReturnType<typeof getInvoiceForMatching>>
>;

const matchingInputOf = (invoice: MatchingInvoice): InvoiceForMatching => ({
  extraction: invoice.extraction,
  supplierId: invoice.supplierId,
  receivedOn: invoice.createdAt.slice(0, 10),
});

/** The workspace's candidate sources for an invoice, with the versions compared. */
async function candidateSources(
  db: Database,
  teamId: string,
  invoice: InvoiceForMatching,
  asOf: string,
): Promise<SourceCandidateInput[]> {
  const { keys, numberKeys } = referenceLookupKeys(
    invoiceReferencesOf(invoice.extraction),
  );
  const found = await findMatchCandidateSourceIds(db, {
    teamId,
    keys,
    numberKeys,
    supplierId: invoice.supplierId,
    limits: {
      supplierSources: SOURCE_MATCH_LIMITS.supplierSources,
      unlinkedSources: UNLINKED_SOURCES,
    },
  });
  const rows = await getMatchSources(db, {
    teamId,
    sourceIds: [
      ...new Set([
        ...found.byReference,
        ...found.bySupplier,
        ...found.unlinked,
      ]),
    ],
    on: matchingDateOf(invoice).value,
    asOf,
  });
  return rows.map((row) => ({
    sourceId: row.id,
    type: row.type as AuthorizationSourceType,
    reference: row.reference,
    referenceKey: row.referenceKey,
    current: termsOf(row.current),
    effective: row.effective ? termsOf(row.effective) : null,
  }));
}

// --- Presenting and announcing a decision ------------------------------------------

/** A decision as REST, MCP, the dashboard and webhooks show it. */
export const presentSourceMatch = (row: {
  id: string;
  sequence: number;
  status: string;
  origin: string;
  action: string;
  method: string | null;
  result: Record<string, unknown>;
  reason: string | null;
  processingRevision: number | null;
  rulesVersion: number;
  createdAt: string;
}) => ({
  ...row.result,
  id: row.id,
  sequence: row.sequence,
  status: row.status,
  origin: row.origin,
  action: row.action,
  method: row.method,
  reason: row.reason,
  processingRevision: row.processingRevision,
  rulesVersion: row.rulesVersion,
  decidedAt: row.createdAt,
});

async function announce(
  db: Database,
  input: {
    teamId: string;
    invoiceId: string;
    revision: number;
    match: SourceMatchRow;
  },
) {
  return scheduleWebhookEvent(db, {
    id: logicalEventId(input.invoiceId, "source-match", input.match.id),
    type: "invoice.matched",
    version: WEBHOOK_PAYLOAD_VERSION,
    createdAt: new Date().toISOString(),
    teamId: input.teamId,
    invoiceId: input.invoiceId,
    revision: input.revision,
    data: {
      invoiceId: input.invoiceId,
      match: presentSourceMatch(input.match),
    },
  });
}

const linksOf = (result: {
  links: readonly { sourceId: string; versionId: string }[];
  allocations: SourceMatchResult["allocations"];
}): NewSourceMatchLink[] =>
  result.links.map((link) => ({
    sourceId: link.sourceId,
    versionId: link.versionId,
    allocations: result.allocations
      .filter((allocation) => allocation.sourceId === link.sourceId)
      .map((allocation) => ({
        sourceLineReference: allocation.sourceLineReference,
        invoiceLineIndex: allocation.invoiceLineIndex,
        amount: allocation.amount,
        currency: allocation.currency,
        basis: allocation.basis,
      })),
  }));

// --- Automatic matching ------------------------------------------------------------

export const matchWorkflowKey = {
  processing: (teamId: string, invoiceId: string, revision: number) =>
    `${teamId}:${invoiceId}:r${revision}`,
  rematch: (teamId: string, invoiceId: string) =>
    `${teamId}:${invoiceId}:rematch:${randomUUID()}`,
};

/**
 * Queues automatic matching for a processed revision. Runs inside the
 * processing transaction, so a completed revision always has its match
 * intent; the key makes retries of that revision share one job.
 */
export async function scheduleInvoiceMatch(
  db: Database,
  input: { teamId: string; invoiceId: string; revision: number },
) {
  const { job } = await enqueueWorkflowJob(db, {
    name: "match-invoice",
    teamId: input.teamId,
    payload: {
      teamId: input.teamId,
      invoiceId: input.invoiceId,
      trigger: "processing",
    },
    idempotencyKey: matchWorkflowKey.processing(
      input.teamId,
      input.invoiceId,
      input.revision,
    ),
  });
  return job;
}

export type MatchInvoiceOutcome =
  | { outcome: "skipped"; reason: "not_found" | "not_processed" | "superseded" }
  | { outcome: "kept_override"; matchId: string }
  | { outcome: "unchanged"; matchId: string; status: string }
  | { outcome: "recorded"; matchId: string; status: string; webhooks: number };

/**
 * Matches one invoice and records the decision. A processing run keeps a
 * person's decision; an explicit rematch records a fresh automatic one (the
 * earlier decisions stay in the history). Re-running with an unchanged
 * result records nothing.
 */
export async function matchInvoice(
  db: Database,
  input: {
    teamId: string;
    invoiceId: string;
    trigger: "processing" | "rematch";
    requestedBy?: string | null;
    judge?: SourceJudge;
    finalAttempt?: boolean;
    now?: Date;
  },
): Promise<MatchInvoiceOutcome> {
  const judge = input.judge ?? judgeSourceCandidatesLive;
  const invoice = await getInvoiceForMatching(db, {
    teamId: input.teamId,
    inboxId: input.invoiceId,
  });
  if (!invoice) return { outcome: "skipped", reason: "not_found" };
  if (!invoice.extraction || invoice.status === "processing") {
    return { outcome: "skipped", reason: "not_processed" };
  }
  const current = invoice.sourceMatchId
    ? await getSourceMatch(db, {
        teamId: input.teamId,
        matchId: invoice.sourceMatchId,
      })
    : null;
  if (input.trigger === "processing" && current?.origin === "manual") {
    return { outcome: "kept_override", matchId: current.id };
  }

  const asOf = (input.now ?? new Date()).toISOString();
  const matching = matchingInputOf(invoice);
  const [sources, hasSources] = await Promise.all([
    candidateSources(db, input.teamId, matching, asOf),
    workspaceHasAuthorizationSources(db, input.teamId),
  ]);
  const preparation = prepareSourceMatch({ invoice: matching, sources });

  // TypeSafe runs outside any transaction, and only when no exact
  // reference decided.
  let semantic: SourceSemanticJudgment | null = null;
  if (preparation.semanticPool.length > 0) {
    const pool = new Set(preparation.semanticPool.map((c) => c.sourceId));
    const answer = await judge(
      invoice.extraction,
      sources
        .filter((source) => pool.has(source.sourceId))
        .map(semanticCandidateOf),
    );
    if (answer.status === "unavailable") {
      if (answer.retryable && !input.finalAttempt) {
        throw new SemanticJudgmentUnavailable(answer.reason);
      }
      semantic = { status: "failed", reason: answer.reason };
    } else {
      semantic = answer;
    }
  }
  const result = decideSourceMatch({
    invoice: matching,
    preparation,
    semantic,
    allocationTargets: sources.map(targetOf),
    workspaceHasSources: hasSources,
    asOf,
  });
  const fingerprint = sourceMatchFingerprint(result);

  return db.transaction(async (tx) => {
    const executor = tx as unknown as Database;
    const locked = await lockInvoiceForMatching(executor, {
      teamId: input.teamId,
      inboxId: input.invoiceId,
    });
    if (!locked) return { outcome: "skipped", reason: "not_found" } as const;
    // A newer revision was saved meanwhile; its own match job decides.
    if (locked.processingRevision !== invoice.processingRevision) {
      return { outcome: "skipped", reason: "superseded" } as const;
    }
    const latest = locked.sourceMatchId
      ? await getSourceMatch(executor, {
          teamId: input.teamId,
          matchId: locked.sourceMatchId,
        })
      : null;
    if (input.trigger === "processing" && latest?.origin === "manual") {
      return { outcome: "kept_override", matchId: latest.id } as const;
    }
    if (
      latest?.origin === "automatic" &&
      latest.fingerprint === fingerprint &&
      latest.processingRevision === locked.processingRevision
    ) {
      return {
        outcome: "unchanged",
        matchId: latest.id,
        status: latest.status,
      } as const;
    }
    const match = await recordSourceMatch(executor, {
      teamId: input.teamId,
      inboxId: input.invoiceId,
      status: result.status,
      origin: "automatic",
      action: input.trigger === "rematch" ? "rematch" : "automatic",
      method: result.method,
      result: { ...result, ...(latest ? { previousMatchId: latest.id } : {}) },
      reason: null,
      processingRevision: locked.processingRevision,
      rulesVersion: SOURCE_MATCHING_VERSION,
      fingerprint,
      actorId: input.trigger === "rematch" ? (input.requestedBy ?? null) : null,
      links: linksOf(result),
    });
    const webhooks = await announce(executor, {
      teamId: input.teamId,
      invoiceId: input.invoiceId,
      revision: locked.processingRevision,
      match,
    });
    return {
      outcome: "recorded",
      matchId: match.id,
      status: match.status,
      webhooks,
    } as const;
  });
}

// --- A person's decisions ----------------------------------------------------------

const MAX_REASON = 1_000;

const reasonOf = (reason: string | null | undefined, required: boolean) => {
  const value = reason?.trim() ?? "";
  if (required && !value) {
    throw new SourceMatchError("Give a reason for this change.", "invalid");
  }
  if (value.length > MAX_REASON) {
    throw new SourceMatchError(
      `The reason can be at most ${MAX_REASON} characters.`,
      "invalid",
    );
  }
  return value || null;
};

/**
 * Locks a processed invoice and its current decision for a manual change,
 * refusing one made against a decision that has since been replaced.
 */
async function lockForDecision(
  db: Database,
  input: { teamId: string; inboxId: string; expectedMatchId?: string | null },
) {
  const invoice = await lockInvoiceForMatching(db, {
    teamId: input.teamId,
    inboxId: input.inboxId,
  });
  if (!invoice) throw new SourceMatchError("Invoice not found", "not_found");
  if (!invoice.extraction || invoice.status === "processing") {
    throw new SourceMatchError(
      "The invoice has not been processed yet.",
      "conflict",
    );
  }
  if (
    input.expectedMatchId !== undefined &&
    (input.expectedMatchId ?? null) !== (invoice.sourceMatchId ?? null)
  ) {
    throw new SourceMatchError(
      "The match changed since it was opened. Reload and try again.",
      "conflict",
    );
  }
  const current = invoice.sourceMatchId
    ? await getSourceMatch(db, {
        teamId: input.teamId,
        matchId: invoice.sourceMatchId,
      })
    : null;
  return { invoice, current };
}

async function recordManual(
  db: Database,
  input: {
    teamId: string;
    invoice: MatchingInvoice;
    current: SourceMatchRow | null;
    actorId: string;
    action: "confirm" | "correct" | "unlink";
    reason: string | null;
    result: SourceMatchResult;
  },
) {
  const match = await recordSourceMatch(db, {
    teamId: input.teamId,
    inboxId: input.invoice.id,
    status: input.result.status,
    origin: "manual",
    action: input.action,
    method: input.result.method,
    result: {
      ...input.result,
      ...(input.current ? { previousMatchId: input.current.id } : {}),
    },
    reason: input.reason,
    processingRevision: input.invoice.processingRevision,
    rulesVersion: SOURCE_MATCHING_VERSION,
    fingerprint: sourceMatchFingerprint(input.result),
    actorId: input.actorId,
    links: linksOf(input.result),
  });
  await announce(db, {
    teamId: input.teamId,
    invoiceId: input.invoice.id,
    revision: input.invoice.processingRevision,
    match,
  });
  return presentSourceMatch(match);
}

const inTransaction = <T>(db: Database, work: (tx: Database) => Promise<T>) =>
  db.transaction((tx) => work(tx as unknown as Database));

/**
 * Confirms the current match as it stands (typically a TypeSafe proposal).
 * An ambiguous or unmatched invoice is linked with `linkInvoiceSources`.
 */
export async function confirmInvoiceMatch(
  db: Database,
  input: {
    teamId: string;
    inboxId: string;
    actorId: string;
    expectedMatchId?: string | null;
    reason?: string | null;
  },
) {
  return inTransaction(db, async (tx) => {
    const { invoice, current } = await lockForDecision(tx, input);
    if (!current || current.status !== "matched") {
      throw new SourceMatchError(
        "Only a matched invoice can be confirmed; choose its source instead.",
        "conflict",
      );
    }
    const reason = reasonOf(input.reason, false);
    const previous = current.result as unknown as SourceMatchResult;
    return recordManual(tx, {
      teamId: input.teamId,
      invoice,
      current,
      actorId: input.actorId,
      action: "confirm",
      reason,
      result: {
        ...previous,
        method: "manual",
        needsConfirmation: false,
        message: `Confirmed: ${previous.links
          .map((link) => link.reference)
          .join(", ")}.`,
        candidates: previous.candidates.map((candidate) =>
          previous.links.some((link) => link.sourceId === candidate.sourceId)
            ? {
                ...candidate,
                evidence: [
                  ...candidate.evidence,
                  {
                    kind: "manual",
                    outcome: "supports",
                    message: "Confirmed by an owner or admin.",
                  },
                ],
              }
            : candidate,
        ),
      },
    });
  });
}

/**
 * Links an invoice to the sources a person chose, replacing the current
 * decision with a new one (the earlier one stays in the history). Each
 * source is compared at the version in effect on the invoice date unless a
 * version is named; several sources need an explicit split.
 */
export async function linkInvoiceSources(
  db: Database,
  input: {
    teamId: string;
    inboxId: string;
    actorId: string;
    expectedMatchId?: string | null;
    reason?: string | null;
    sources: { sourceId: string; version?: number | null }[];
    allocations?: ManualAllocationInput[] | null;
  },
) {
  const sourceIds = [
    ...new Set(input.sources.map((source) => source.sourceId)),
  ];
  if (sourceIds.length === 0 || sourceIds.length !== input.sources.length) {
    throw new SourceMatchError("Choose each source once.", "invalid");
  }
  if (sourceIds.length > SOURCE_MATCH_LIMITS.semanticCandidates) {
    throw new SourceMatchError(
      `At most ${SOURCE_MATCH_LIMITS.semanticCandidates} sources can be linked to one invoice.`,
      "invalid",
    );
  }
  return inTransaction(db, async (tx) => {
    const { invoice, current } = await lockForDecision(tx, input);
    const asOf = new Date().toISOString();
    const matching = matchingInputOf(invoice);
    const rows = await getMatchSources(tx, {
      teamId: input.teamId,
      sourceIds,
      on: matchingDateOf(matching).value,
      asOf,
    });
    if (rows.length !== sourceIds.length) {
      throw new SourceMatchError("Authorization source not found", "not_found");
    }
    const on = matchingDateOf(matching).value;
    const chosen: SourceCandidateInput[] = [];
    for (const row of rows) {
      const wanted = input.sources.find((source) => source.sourceId === row.id);
      let current = row.current;
      let effective = row.effective;
      // A named version is compared as given; it must be one of the source's
      // own, and is described as in effect only if it was on the invoice date.
      if (wanted?.version != null) {
        const named = await versionByNumber(
          tx,
          input.teamId,
          row.id,
          wanted.version,
        );
        if (!named) {
          throw new SourceMatchError(
            `${row.reference} has no version ${wanted.version}.`,
            "not_found",
          );
        }
        if (named.effectiveFrom <= on) {
          effective = named;
        } else {
          current = named;
          effective = null;
        }
      }
      chosen.push({
        sourceId: row.id,
        type: row.type as AuthorizationSourceType,
        reference: row.reference,
        referenceKey: row.referenceKey,
        current: termsOf(current),
        effective: effective ? termsOf(effective) : null,
      });
    }
    const preparation = prepareSourceMatch({
      invoice: matching,
      sources: chosen,
      keepAll: true,
    });
    const assessed = chosen.map((source) => {
      const candidate = preparation.candidates.find(
        (item) => item.sourceId === source.sourceId,
      );
      return { source, candidate };
    });
    for (const { source, candidate } of assessed) {
      const version = source.effective ?? source.current;
      if (version.status === "cancelled") {
        throw new SourceMatchError(
          `${source.reference} is cancelled and cannot be linked.`,
          "invalid",
        );
      }
      if (candidate?.rejection === "currency_conflict") {
        throw new SourceMatchError(
          `${source.reference} authorizes ${version.currency}; the invoice is in another currency.`,
          "invalid",
        );
      }
    }
    const links = chosen.map((source) => {
      const version = source.effective ?? source.current;
      return {
        sourceId: source.sourceId,
        versionId: version.id,
        version: version.version,
        type: source.type,
        reference: source.reference,
        title: version.title,
      };
    });
    const { allocations, issues } = manualAllocations({
      extraction: invoice.extraction,
      targets: chosen.map((source, index) => {
        const version = source.effective ?? source.current;
        return {
          link: links[index]!,
          lines: version.lines,
          currency: version.currency,
        };
      }),
      allocations: input.allocations ?? null,
    });
    if (issues.length) throw new SourceMatchError(issues.join(" "), "invalid");

    const previousLinks = new Set(
      (
        (current?.result as { links?: { sourceId: string }[] } | undefined)
          ?.links ?? []
      ).map((link) => link.sourceId),
    );
    const changesALink =
      current?.status === "matched" &&
      (previousLinks.size !== sourceIds.length ||
        sourceIds.some((id) => !previousLinks.has(id)));
    const reason = reasonOf(input.reason, changesALink);
    const candidates = [
      ...preparation.candidates.map((candidate) => ({
        ...candidate,
        evidence: [
          ...candidate.evidence,
          {
            kind: "manual" as const,
            outcome: "supports" as const,
            message: "Linked by an owner or admin.",
          },
        ],
      })),
      // What was considered before stays visible.
      ...((
        (current?.result as unknown as SourceMatchResult | undefined)
          ?.candidates ?? []
      ).filter(
        (candidate) => !sourceIds.includes(candidate.sourceId),
      ) as SourceMatchResult["candidates"]),
    ];
    const result: SourceMatchResult = {
      version: SOURCE_MATCHING_VERSION,
      status: "matched",
      method: "manual",
      confidence: null,
      needsConfirmation: false,
      message: `Linked by an owner or admin to ${links
        .map((link) => link.reference)
        .join(", ")}.`,
      invoiceDate: preparation.invoiceDate,
      references: preparation.references,
      links,
      allocations,
      allocation: summarizeAllocations(invoice.extraction, allocations),
      candidates,
      semantic: { status: "not_needed" },
      asOf,
    };
    return recordManual(tx, {
      teamId: input.teamId,
      invoice,
      current,
      actorId: input.actorId,
      action: "correct",
      reason,
      result,
    });
  });
}

async function versionByNumber(
  db: Database,
  teamId: string,
  sourceId: string,
  version: number,
) {
  const found = await getAuthorizationSourceVersion(db, {
    teamId,
    sourceId,
    version,
  });
  if (!found) return null;
  const [row] = await getMatchSourceVersions(db, {
    teamId,
    versionIds: [found.id],
  });
  return row ?? null;
}

/** Records that the invoice bills no source, with the reason. */
export async function unlinkInvoiceSources(
  db: Database,
  input: {
    teamId: string;
    inboxId: string;
    actorId: string;
    expectedMatchId?: string | null;
    reason: string;
  },
) {
  return inTransaction(db, async (tx) => {
    const { invoice, current } = await lockForDecision(tx, input);
    const reason = reasonOf(input.reason, true);
    const previous = current?.result as unknown as
      | SourceMatchResult
      | undefined;
    const matching = matchingInputOf(invoice);
    const result: SourceMatchResult = {
      version: SOURCE_MATCHING_VERSION,
      status: "unmatched",
      method: "manual",
      confidence: null,
      needsConfirmation: false,
      message:
        "Marked by an owner or admin as billing no authorization source.",
      invoiceDate: previous?.invoiceDate ?? matchingDateOf(matching),
      references:
        previous?.references ?? invoiceReferencesOf(invoice.extraction),
      links: [],
      allocations: [],
      allocation: summarizeAllocations(invoice.extraction, []),
      candidates: previous?.candidates ?? [],
      semantic: { status: "not_needed" },
      asOf: new Date().toISOString(),
    };
    return recordManual(tx, {
      teamId: input.teamId,
      invoice,
      current,
      actorId: input.actorId,
      action: "unlink",
      reason,
      result,
    });
  });
}

/**
 * Queues a fresh automatic match. Replacing a person's decision (it stays in
 * the history) needs `mayReplaceDecision`: only an owner or admin may.
 */
export async function requestInvoiceRematch(
  db: Database,
  input: {
    teamId: string;
    inboxId: string;
    actorId: string;
    mayReplaceDecision: boolean;
  },
) {
  const invoice = await getInvoiceForMatching(db, {
    teamId: input.teamId,
    inboxId: input.inboxId,
  });
  if (!invoice) throw new SourceMatchError("Invoice not found", "not_found");
  if (!invoice.extraction || invoice.status === "processing") {
    throw new SourceMatchError(
      "The invoice has not been processed yet.",
      "conflict",
    );
  }
  if (!input.mayReplaceDecision && invoice.sourceMatchId) {
    const current = await getSourceMatch(db, {
      teamId: input.teamId,
      matchId: invoice.sourceMatchId,
    });
    if (current?.origin === "manual") {
      throw new SourceMatchError(
        "An owner or admin decided this match; only an owner or admin can replace it.",
        "forbidden",
      );
    }
  }
  const { job } = await enqueueWorkflowJob(db, {
    name: "match-invoice",
    teamId: input.teamId,
    payload: {
      teamId: input.teamId,
      invoiceId: input.inboxId,
      trigger: "rematch",
      requestedBy: input.actorId,
    },
    idempotencyKey: matchWorkflowKey.rematch(input.teamId, input.inboxId),
  });
  return { jobId: job.id };
}
