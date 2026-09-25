/**
 * Authorization sources: capturing, versioning, importing and evidencing the
 * jobs, purchase orders and contracts invoices are checked against.
 *
 * Every write runs in one transaction under the workspace's
 * authorization-source lock. A batch (CSV file or REST request) is validated
 * in full before anything is written, so a rejected batch changes nothing and
 * an accepted one lands whole. Versions are immutable; an amendment, status
 * change or supplier link is a new version. The rules are in
 * `packages/documents/src/authorization-source.ts`; `docs/authorization-sources.md`
 * publishes them.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Database } from "@invoicewise/db/client";
import {
  type AuthorizationSourceHead,
  type AuthorizationSourceVersionRow,
  authorizationDocumentBindingIssue,
  findAuthorizationSourceDocumentByHash,
  findAuthorizationSourcesByKeys,
  findSupplierCandidates,
  getAuthorizationSourceDocument,
  getAuthorizationSourceHead,
  getAuthorizationSourceVersionRows,
  getCanonicalSupplier,
  insertAuthorizationSource,
  insertAuthorizationSourceDocument,
  insertAuthorizationSourceVersion,
  lockAuthorizationSources,
  recordAuthorizationSourceImport,
  setAuthorizationSourceHead,
} from "@invoicewise/db/queries";
import {
  AUTHORIZATION_SOURCE_LIMITS,
  type AuthorizationGap,
  type AuthorizationIssue,
  type AuthorizationLine,
  type AuthorizationSourceStatus,
  type AuthorizationTerms,
  INTAKE_LIMITS,
  authorizationSourceGaps,
  companyNumberKey,
  csvRowErrors,
  normalizeAuthorizationSource,
  parseAuthorizationSourcesCsv,
  resolveSupplier,
  sniffIntakeKind,
  supplierKey,
  vatKey,
} from "@invoicewise/documents";
import { type IntakeStorage, defaultIntakeStorage } from "./intake";

export class AuthorizationSourceError extends Error {
  override readonly name = "AuthorizationSourceError";
  constructor(
    message: string,
    readonly code: "not_found" | "invalid" | "conflict",
    readonly errors: AuthorizationBatchError[] = [],
  ) {
    super(message);
  }
}

export type AuthorizationOrigin = "manual" | "csv" | "api";

/** One problem with one supplied source; a batch reports all of them. */
export type AuthorizationBatchError = {
  /** Position of the source in the request (0-based). */
  index: number | null;
  /** CSV row (the header is row 1), for imports. */
  row: number | null;
  column: string | null;
  field: string | null;
  reference: string | null;
  message: string;
};

export type AuthorizationBatchOutcome = {
  index: number;
  sourceId: string | null;
  type: string;
  reference: string;
  version: number;
  outcome: "created" | "amended" | "unchanged";
  status: AuthorizationSourceStatus;
  supplierId: string | null;
  gaps: AuthorizationGap[];
};

export type AuthorizationBatchResult = {
  /** `validated` is a dry run that would have applied. */
  status: "applied" | "validated" | "rejected";
  importId: string | null;
  summary: {
    sources: number;
    created: number;
    amended: number;
    unchanged: number;
  };
  results: AuthorizationBatchOutcome[];
  errors: AuthorizationBatchError[];
};

/** What `authorization_source_versions.supplier_resolution` holds. */
export type AuthorizationSupplierResolution = {
  status: "linked" | "unknown";
  method: "explicit" | "kept" | "vat_number" | "company_number" | "name" | null;
  reason?:
    | "not_provided"
    | "no_match"
    | "ambiguous_name"
    | "conflicting_identifiers";
  candidateIds?: string[];
  message: string;
};

type BatchItem = {
  index: number;
  rows: number[] | null;
  terms: AuthorizationTerms;
  /** `create` refuses an existing reference; `amend` needs one (by id). */
  mode: "upsert" | "create" | { amend: string };
  /** Overrides the default effective date (a supplier link keeps the current one). */
  effectiveFrom?: string;
  /**
   * Derives the terms from the current version, read under the lock, so a
   * status change or supplier link never reverts a concurrent amendment.
   */
  fromCurrent?: (
    terms: AuthorizationTerms,
    current: AuthorizationSourceVersionRow,
  ) => Pick<BatchItem, "terms" | "effectiveFrom">;
};

type Plan = {
  item: BatchItem;
  head: AuthorizationSourceHead | null;
  outcome: AuthorizationBatchOutcome["outcome"];
  status: AuthorizationSourceStatus;
  supplierId: string | null;
  resolution: AuthorizationSupplierResolution;
  contentHash: string;
  effectiveFrom: string;
  version: number;
};

const today = () => new Date().toISOString().slice(0, 10);

const emptySummary = (sources: number) => ({
  sources,
  created: 0,
  amended: 0,
  unchanged: 0,
});

/**
 * What a version's terms hash covers: everything that states the commitment.
 * The effective date, change reason and an explicitly chosen supplier id are
 * not part of it (the supplier link is compared separately), so re-importing
 * an unchanged source is recognised as unchanged.
 */
export const authorizationContentHash = (
  terms: AuthorizationTerms,
  status: AuthorizationSourceStatus,
) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        terms.type,
        terms.referenceKey,
        status,
        terms.title,
        terms.scope,
        terms.supplier.name,
        terms.supplier.vatNumber,
        terms.supplier.companyNumber,
        terms.currency,
        terms.taxBasis,
        terms.issuedOn,
        terms.startsOn,
        terms.endsOn,
        terms.authorizedTotal,
        terms.lines.map((line) => [
          line.reference,
          line.description,
          line.quantity,
          line.unitPrice,
          line.amount,
        ]),
      ]),
    )
    .digest("hex");

const sameSuppliedSupplier = (
  version: AuthorizationSourceVersionRow,
  terms: AuthorizationTerms,
) =>
  version.supplierName === terms.supplier.name &&
  version.supplierVatNumber === terms.supplier.vatNumber &&
  version.supplierCompanyNumber === terms.supplier.companyNumber;

/** The terms a stored version states, for a status change or supplier link. */
export const termsFromVersion = (
  head: AuthorizationSourceHead,
  version: AuthorizationSourceVersionRow,
): AuthorizationTerms => ({
  type: head.sourceType as AuthorizationTerms["type"],
  reference: head.reference,
  referenceKey: head.referenceKey,
  status: version.status as AuthorizationSourceStatus,
  title: version.title,
  scope: version.scope,
  supplier: {
    id: null,
    name: version.supplierName,
    vatNumber: version.supplierVatNumber,
    companyNumber: version.supplierCompanyNumber,
  },
  currency: version.currency,
  taxBasis: version.taxBasis as AuthorizationTerms["taxBasis"],
  issuedOn: version.issuedOn,
  startsOn: version.startsOn,
  endsOn: version.endsOn,
  effectiveFrom: null,
  authorizedTotal: version.authorizedTotal,
  lines: version.lineItems as AuthorizationLine[],
  changeReason: null,
});

/**
 * Links a source to a workspace supplier by the same rules invoices use
 * (explicit identifiers first, a name only when unique). A supplier is never
 * created from a source: one nobody has invoiced from yet stays explicitly
 * unknown until an admin links it or a later version resolves it.
 */
async function resolveSourceSupplier(
  db: Database,
  input: {
    teamId: string;
    terms: AuthorizationTerms;
    current: AuthorizationSourceVersionRow | null;
  },
): Promise<
  | {
      ok: true;
      supplierId: string | null;
      resolution: AuthorizationSupplierResolution;
    }
  | { ok: false; message: string }
> {
  const { supplier } = input.terms;
  if (supplier.id) {
    const chosen = await getCanonicalSupplier(db, {
      teamId: input.teamId,
      supplierId: supplier.id,
    });
    if (!chosen) {
      return {
        ok: false,
        message: "No supplier with this id in this workspace.",
      };
    }
    return {
      ok: true,
      supplierId: chosen.id,
      resolution: {
        status: "linked",
        method: "explicit",
        message: `Linked to ${chosen.name} by an explicit choice.`,
      },
    };
  }

  const current = input.current;
  if (current?.supplierId && sameSuppliedSupplier(current, input.terms)) {
    const kept = await getCanonicalSupplier(db, {
      teamId: input.teamId,
      supplierId: current.supplierId,
    });
    if (kept) {
      return {
        ok: true,
        supplierId: kept.id,
        resolution: {
          status: "linked",
          method: "kept",
          message: `Still linked to ${kept.name}; the supplier details did not change.`,
        },
      };
    }
  }

  const identifiers = {
    name: supplier.name,
    nameKey: supplierKey(supplier.name),
    vatKey: vatKey(supplier.vatNumber),
    companyKey: companyNumberKey(supplier.companyNumber),
  };
  if (!identifiers.nameKey && !identifiers.vatKey && !identifiers.companyKey) {
    return {
      ok: true,
      supplierId: null,
      resolution: {
        status: "unknown",
        method: null,
        reason: "not_provided",
        message: "No supplier was given.",
      },
    };
  }
  const candidates = await findSupplierCandidates(db, {
    teamId: input.teamId,
    nameKey: identifiers.nameKey,
    vatKey: identifiers.vatKey,
    companyKey: identifiers.companyKey,
  });
  const resolution = resolveSupplier(identifiers, candidates);
  if (resolution.status === "matched") {
    return {
      ok: true,
      supplierId: resolution.supplierId,
      resolution: {
        status: "linked",
        method: resolution.method,
        message: resolution.message,
      },
    };
  }
  if (resolution.status === "new") {
    return {
      ok: true,
      supplierId: null,
      resolution: {
        status: "unknown",
        method: null,
        reason: "no_match",
        message:
          "No workspace supplier has this VAT number, company number or name yet.",
      },
    };
  }
  return {
    ok: true,
    supplierId: null,
    resolution: {
      status: "unknown",
      method: null,
      reason:
        resolution.reason === "no_supplier_identity"
          ? "not_provided"
          : resolution.reason,
      candidateIds: resolution.candidateIds,
      message: resolution.message,
    },
  };
}

const batchError = (
  item: Pick<BatchItem, "index" | "rows" | "terms">,
  message: string,
  field: string | null = null,
): AuthorizationBatchError => ({
  index: item.index,
  row: item.rows?.[0] ?? null,
  column: null,
  field,
  reference: item.terms.reference,
  message,
});

/**
 * Validates and (unless `dryRun`) applies a batch in one transaction. Any
 * error rejects the whole batch; an import or REST batch is recorded either
 * way so a rejected file stays visible.
 */
async function applyBatch(
  db: Database,
  input: {
    teamId: string;
    actorId: string | null;
    origin: AuthorizationOrigin;
    items: BatchItem[];
    /** Errors found before the batch reached the database (parsing, validation). */
    errors: AuthorizationBatchError[];
    sourceCount: number;
    dryRun: boolean;
    record: boolean;
    fileName?: string | null;
  },
): Promise<AuthorizationBatchResult> {
  return db.transaction(async (tx) => {
    const executor = tx as unknown as Database;
    await lockAuthorizationSources(executor, input.teamId);
    const errors = [...input.errors];

    const amendIds = input.items.flatMap((item) =>
      typeof item.mode === "object" ? [item.mode.amend] : [],
    );
    const byId = new Map<string, AuthorizationSourceHead>();
    for (const id of amendIds) {
      const head = await getAuthorizationSourceHead(executor, {
        teamId: input.teamId,
        sourceId: id,
      });
      if (head) byId.set(id, head);
    }
    const byKey = new Map(
      (
        await findAuthorizationSourcesByKeys(executor, {
          teamId: input.teamId,
          keys: input.items.map((item) => ({
            sourceType: item.terms.type,
            referenceKey: item.terms.referenceKey,
          })),
        })
      ).map((head) => [`${head.sourceType}\u0000${head.referenceKey}`, head]),
    );
    const heads = [...byKey.values(), ...byId.values()];
    const currentVersions = new Map(
      (
        await getAuthorizationSourceVersionRows(executor, {
          teamId: input.teamId,
          versionIds: heads.flatMap((head) =>
            head.currentVersionId ? [head.currentVersionId] : [],
          ),
        })
      ).map((version) => [version.sourceId, version]),
    );

    const seen = new Map<string, BatchItem>();
    const plans: Plan[] = [];
    for (const item of input.items) {
      let head: AuthorizationSourceHead | null;
      if (typeof item.mode === "object") {
        head = byId.get(item.mode.amend) ?? null;
        if (!head) {
          errors.push(batchError(item, "Authorization source not found."));
          continue;
        }
        const locked = currentVersions.get(head.id);
        if (item.fromCurrent && locked) {
          Object.assign(
            item,
            item.fromCurrent(termsFromVersion(head, locked), locked),
          );
        }
        // The type and reference are the source's identity and never change.
        item.terms = {
          ...item.terms,
          type: head.sourceType as AuthorizationTerms["type"],
          reference: head.reference,
          referenceKey: head.referenceKey,
        };
      } else {
        head =
          byKey.get(`${item.terms.type}\u0000${item.terms.referenceKey}`) ??
          null;
      }

      const key = `${item.terms.type}\u0000${item.terms.referenceKey}`;
      const earlier = seen.get(key);
      if (earlier) {
        errors.push(
          batchError(
            item,
            earlier.rows
              ? `Repeats the source on row ${earlier.rows[0]}.`
              : `Repeats source ${earlier.index + 1} of this request.`,
            "reference",
          ),
        );
        continue;
      }
      seen.set(key, item);

      if (item.mode === "create" && head) {
        errors.push(
          batchError(
            item,
            "A source with this type and reference already exists; amend it instead.",
            "reference",
          ),
        );
        continue;
      }

      const current = head ? (currentVersions.get(head.id) ?? null) : null;
      const status: AuthorizationSourceStatus =
        item.terms.status ??
        (head?.status as AuthorizationSourceStatus | undefined) ??
        "open";
      const supplier = await resolveSourceSupplier(executor, {
        teamId: input.teamId,
        terms: item.terms,
        current,
      });
      if (!supplier.ok) {
        errors.push(batchError(item, supplier.message, "supplier.id"));
        continue;
      }
      const contentHash = authorizationContentHash(item.terms, status);
      let currentSupplierId: string | null = null;
      if (current?.supplierId) {
        currentSupplierId =
          (
            await getCanonicalSupplier(executor, {
              teamId: input.teamId,
              supplierId: current.supplierId,
            })
          )?.id ?? null;
      }
      const changed =
        !current ||
        current.contentHash !== contentHash ||
        currentSupplierId !== supplier.supplierId;

      if (changed && head?.status === "cancelled") {
        errors.push(
          batchError(
            item,
            "This source is cancelled and cannot be amended; record the work under a new reference.",
            "status",
          ),
        );
        continue;
      }

      const effectiveFrom =
        item.effectiveFrom ??
        item.terms.effectiveFrom ??
        (head
          ? today()
          : (item.terms.startsOn ?? item.terms.issuedOn ?? today()));

      plans.push({
        item,
        head,
        outcome: !head ? "created" : changed ? "amended" : "unchanged",
        status: changed ? status : (head!.status as AuthorizationSourceStatus),
        supplierId: changed ? supplier.supplierId : currentSupplierId,
        resolution: supplier.resolution,
        contentHash,
        effectiveFrom,
        version: head ? head.currentVersion + (changed ? 1 : 0) : 1,
      });
    }

    const summary = emptySummary(input.sourceCount);
    if (errors.length > 0) {
      errors.sort(
        (a, b) =>
          (a.row ?? 0) - (b.row ?? 0) || (a.index ?? 0) - (b.index ?? 0),
      );
      const importId =
        input.record && !input.dryRun
          ? await recordAuthorizationSourceImport(executor, {
              teamId: input.teamId,
              actorId: input.actorId,
              origin: input.origin,
              fileName: input.fileName ?? null,
              status: "rejected",
              summary,
              errors: errors.slice(0, 500),
            })
          : null;
      return { status: "rejected", importId, summary, results: [], errors };
    }

    for (const plan of plans) summary[plan.outcome] += 1;

    const results: AuthorizationBatchOutcome[] = plans.map((plan) => ({
      index: plan.item.index,
      sourceId: plan.head?.id ?? null,
      type: plan.item.terms.type,
      reference: plan.head?.reference ?? plan.item.terms.reference,
      version: plan.version,
      outcome: plan.outcome,
      status: plan.status,
      supplierId: plan.supplierId,
      gaps: authorizationSourceGaps({
        supplierId: plan.supplierId,
        currency: plan.item.terms.currency,
        taxBasis: plan.item.terms.taxBasis,
      }),
    }));

    if (input.dryRun) {
      return {
        status: "validated",
        importId: null,
        summary,
        results,
        errors: [],
      };
    }

    const importId = input.record
      ? await recordAuthorizationSourceImport(executor, {
          teamId: input.teamId,
          actorId: input.actorId,
          origin: input.origin,
          fileName: input.fileName ?? null,
          status: "applied",
          summary,
          errors: [],
        })
      : null;

    for (const [position, plan] of plans.entries()) {
      if (plan.outcome === "unchanged") continue;
      const { terms } = plan.item;
      const sourceId =
        plan.head?.id ??
        (
          await insertAuthorizationSource(executor, {
            teamId: input.teamId,
            sourceType: terms.type,
            reference: terms.reference,
            referenceKey: terms.referenceKey,
            currentVersion: 0,
            status: plan.status,
            title: terms.title,
            supplierId: plan.supplierId,
            supplierName: terms.supplier.name,
            currency: terms.currency,
            authorizedTotal: terms.authorizedTotal,
            effectiveFrom: plan.effectiveFrom,
            createdBy: input.actorId,
          })
        ).id;
      const version = await insertAuthorizationSourceVersion(executor, {
        teamId: input.teamId,
        sourceId,
        version: plan.version,
        status: plan.status,
        title: terms.title,
        scope: terms.scope,
        supplierId: plan.supplierId,
        supplierName: terms.supplier.name,
        supplierVatNumber: terms.supplier.vatNumber,
        supplierCompanyNumber: terms.supplier.companyNumber,
        supplierResolution: plan.resolution,
        currency: terms.currency,
        taxBasis: terms.taxBasis,
        issuedOn: terms.issuedOn,
        startsOn: terms.startsOn,
        endsOn: terms.endsOn,
        effectiveFrom: plan.effectiveFrom,
        authorizedTotal: terms.authorizedTotal,
        lineItems: terms.lines,
        changeReason: terms.changeReason,
        origin: input.origin,
        importId,
        contentHash: plan.contentHash,
        actorId: input.actorId,
      });
      await setAuthorizationSourceHead(executor, {
        teamId: input.teamId,
        version,
      });
      results[position]!.sourceId = sourceId;
    }

    return { status: "applied", importId, summary, results, errors: [] };
  });
}

const issueErrors = (
  index: number,
  reference: string | null,
  issues: readonly AuthorizationIssue[],
): AuthorizationBatchError[] =>
  issues.map((issue) => ({
    index,
    row: null,
    column: null,
    field:
      issue.line === undefined
        ? issue.field
        : `lines[${issue.line}].${issue.field.replace(/^lines\./, "")}`,
    reference,
    message: issue.message,
  }));

const referenceOf = (input: unknown) => {
  const value = (input as { reference?: unknown } | null)?.reference;
  return typeof value === "string" && value.trim() ? value.trim() : null;
};

/**
 * Imports a CSV file (format in `docs/authorization-sources.md`). All rows
 * are validated first; one bad row rejects the file and nothing is written.
 */
export async function importAuthorizationSourcesCsv(
  db: Database,
  input: {
    teamId: string;
    actorId: string | null;
    csv: string;
    fileName?: string | null;
    dryRun?: boolean;
  },
): Promise<AuthorizationBatchResult> {
  const parsed = parseAuthorizationSourcesCsv(input.csv);
  const errors: AuthorizationBatchError[] = parsed.errors.map((error) => ({
    index: null,
    field: null,
    ...error,
  }));
  const items: BatchItem[] = [];
  parsed.sources.forEach((source, index) => {
    const normalized = normalizeAuthorizationSource(source.input);
    if (!normalized.ok) {
      for (const error of csvRowErrors(source, normalized.issues)) {
        errors.push({ index, field: null, ...error });
      }
      return;
    }
    items.push({
      index,
      rows: source.rows,
      terms: normalized.terms,
      mode: "upsert",
    });
  });
  if (parsed.sources.length === 0 && errors.length === 0) {
    errors.push({
      index: null,
      row: null,
      column: null,
      field: null,
      reference: null,
      message: "The file has no sources.",
    });
  }
  return applyBatch(db, {
    teamId: input.teamId,
    actorId: input.actorId,
    origin: "csv",
    items,
    errors,
    sourceCount: parsed.sources.length,
    dryRun: input.dryRun ?? false,
    record: true,
    fileName: input.fileName ?? null,
  });
}

/**
 * The REST batch: external systems send sources as they now stand, keyed by
 * type and reference. An unknown reference is created, a changed one amended,
 * an identical one reported unchanged; the batch is all-or-nothing.
 */
export async function submitAuthorizationSources(
  db: Database,
  input: {
    teamId: string;
    actorId: string | null;
    sources: readonly unknown[];
    dryRun?: boolean;
  },
): Promise<AuthorizationBatchResult> {
  if (input.sources.length > AUTHORIZATION_SOURCE_LIMITS.maxSourcesPerBatch) {
    throw new AuthorizationSourceError(
      `At most ${AUTHORIZATION_SOURCE_LIMITS.maxSourcesPerBatch} sources per request.`,
      "invalid",
    );
  }
  const errors: AuthorizationBatchError[] = [];
  const items: BatchItem[] = [];
  input.sources.forEach((source, index) => {
    const normalized = normalizeAuthorizationSource(source);
    if (!normalized.ok) {
      errors.push(
        ...issueErrors(index, referenceOf(source), normalized.issues),
      );
      return;
    }
    items.push({ index, rows: null, terms: normalized.terms, mode: "upsert" });
  });
  return applyBatch(db, {
    teamId: input.teamId,
    actorId: input.actorId,
    origin: "api",
    items,
    errors,
    sourceCount: input.sources.length,
    dryRun: input.dryRun ?? false,
    record: true,
  });
}

const single = async (
  db: Database,
  input: {
    teamId: string;
    actorId: string | null;
    item: Omit<BatchItem, "index" | "rows">;
  },
) => {
  const result = await applyBatch(db, {
    teamId: input.teamId,
    actorId: input.actorId,
    origin: "manual",
    items: [{ ...input.item, index: 0, rows: null }],
    errors: [],
    sourceCount: 1,
    dryRun: false,
    record: false,
  });
  if (result.status === "rejected") {
    const [first] = result.errors;
    throw new AuthorizationSourceError(
      first?.message ?? "The source is invalid.",
      first?.message === "Authorization source not found."
        ? "not_found"
        : first?.message.startsWith("A source with this type and reference")
          ? "conflict"
          : "invalid",
      result.errors,
    );
  }
  return result.results[0]!;
};

const normalizedOrThrow = (source: unknown) => {
  const normalized = normalizeAuthorizationSource(source);
  if (!normalized.ok) {
    const errors = issueErrors(0, referenceOf(source), normalized.issues);
    throw new AuthorizationSourceError(
      errors.map((error) => `${error.field}: ${error.message}`).join(" "),
      "invalid",
      errors,
    );
  }
  return normalized.terms;
};

/** Manual entry of a new source; an existing reference is refused. */
export async function createAuthorizationSource(
  db: Database,
  input: { teamId: string; actorId: string | null; source: unknown },
) {
  return single(db, {
    teamId: input.teamId,
    actorId: input.actorId,
    item: { terms: normalizedOrThrow(input.source), mode: "create" },
  });
}

/** Manual amendment: the source's terms as they now stand, as a new version. */
export async function amendAuthorizationSource(
  db: Database,
  input: {
    teamId: string;
    actorId: string | null;
    sourceId: string;
    source: unknown;
  },
) {
  return single(db, {
    teamId: input.teamId,
    actorId: input.actorId,
    item: {
      terms: normalizedOrThrow(input.source),
      mode: { amend: input.sourceId },
    },
  });
}

async function currentTerms(
  db: Database,
  input: { teamId: string; sourceId: string },
) {
  const head = await getAuthorizationSourceHead(db, input);
  const [version] = head?.currentVersionId
    ? await getAuthorizationSourceVersionRows(db, {
        teamId: input.teamId,
        versionIds: [head.currentVersionId],
      })
    : [];
  if (!head || !version) {
    throw new AuthorizationSourceError(
      "Authorization source not found.",
      "not_found",
    );
  }
  return { head, version, terms: termsFromVersion(head, version) };
}

/** Opens, closes or cancels a source as a new version with the same terms. */
export async function setAuthorizationSourceStatus(
  db: Database,
  input: {
    teamId: string;
    actorId: string | null;
    sourceId: string;
    status: AuthorizationSourceStatus;
    reason?: string | null;
    effectiveFrom?: string | null;
  },
) {
  const { terms } = await currentTerms(db, input);
  return single(db, {
    teamId: input.teamId,
    actorId: input.actorId,
    item: {
      terms,
      mode: { amend: input.sourceId },
      fromCurrent: (current) => ({
        terms: {
          ...current,
          status: input.status,
          changeReason: input.reason?.trim() || `Marked ${input.status}.`,
          effectiveFrom: input.effectiveFrom ?? null,
        },
      }),
    },
  });
}

/**
 * Links a source to a workspace supplier as a new version. The terms did not
 * change, so the new version takes effect from the same date as the current one.
 */
export async function linkAuthorizationSourceSupplier(
  db: Database,
  input: {
    teamId: string;
    actorId: string | null;
    sourceId: string;
    supplierId: string;
  },
) {
  const { terms } = await currentTerms(db, input);
  const supplier = await getCanonicalSupplier(db, {
    teamId: input.teamId,
    supplierId: input.supplierId,
  });
  if (!supplier) {
    throw new AuthorizationSourceError("Supplier not found.", "not_found");
  }
  return single(db, {
    teamId: input.teamId,
    actorId: input.actorId,
    item: {
      terms,
      mode: { amend: input.sourceId },
      fromCurrent: (current, version) => ({
        terms: {
          ...current,
          supplier: { ...current.supplier, id: supplier.id },
          changeReason: `Linked to supplier ${supplier.name}.`,
        },
        effectiveFrom: version.effectiveFrom,
      }),
    },
  });
}

// --- Retained documents ------------------------------------------------------------

const DOCUMENT_TYPES = {
  pdf: { contentType: "application/pdf", extension: "pdf" },
  png: { contentType: "image/png", extension: "png" },
  jpeg: { contentType: "image/jpeg", extension: "jpg" },
} as const;

export type AuthorizationDocumentStorage = Pick<
  IntakeStorage,
  "uploadIfAbsent" | "remove" | "download"
>;

const safeFileName = (value: string, extension: string) => {
  const name = value
    .replace(/[\\/]/g, "_")
    .split("")
    .filter((char) => char.charCodeAt(0) >= 0x20)
    .join("")
    .trim()
    .slice(0, 200);
  return name || `document.${extension}`;
};

/**
 * Keeps a PDF, PNG or JPEG (the signed PO, the contract) as evidence on the
 * source's current version. The same bytes attached twice are kept once.
 */
export async function attachAuthorizationSourceDocument(
  db: Database,
  input: {
    teamId: string;
    actorId: string | null;
    sourceId: string;
    bytes: Uint8Array;
    fileName: string;
  },
  storage: AuthorizationDocumentStorage = defaultIntakeStorage,
) {
  if (input.bytes.byteLength === 0) {
    throw new AuthorizationSourceError("The file is empty.", "invalid");
  }
  if (input.bytes.byteLength > INTAKE_LIMITS.maxBytes) {
    throw new AuthorizationSourceError(
      `The file is larger than ${INTAKE_LIMITS.maxBytes / 1_000_000} MB.`,
      "invalid",
    );
  }
  const kind = sniffIntakeKind(input.bytes);
  if (!kind) {
    throw new AuthorizationSourceError(
      "Attach a PDF, PNG or JPEG file.",
      "invalid",
    );
  }
  const type = DOCUMENT_TYPES[kind];
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");

  const head = await getAuthorizationSourceHead(db, input);
  if (!head?.currentVersionId) {
    throw new AuthorizationSourceError(
      "Authorization source not found.",
      "not_found",
    );
  }
  const existing = await findAuthorizationSourceDocumentByHash(db, {
    teamId: input.teamId,
    sourceId: head.id,
    sha256,
  });
  if (existing) return { document: existing, deduplicated: true };

  const id = randomUUID();
  const filePath = [
    input.teamId,
    "authorization-sources",
    head.id,
    `${id}.${type.extension}`,
  ];
  await storage.uploadIfAbsent({
    bucket: "vault",
    path: filePath,
    file: input.bytes,
    contentType: type.contentType,
  });

  try {
    const document = await db.transaction(async (tx) => {
      const executor = tx as unknown as Database;
      await lockAuthorizationSources(executor, input.teamId);
      const locked = await getAuthorizationSourceHead(executor, input);
      if (!locked?.currentVersionId) {
        throw new AuthorizationSourceError(
          "Authorization source not found.",
          "not_found",
        );
      }
      const duplicate = await findAuthorizationSourceDocumentByHash(executor, {
        teamId: input.teamId,
        sourceId: locked.id,
        sha256,
      });
      if (duplicate) return { document: duplicate, deduplicated: true };
      return {
        document: await insertAuthorizationSourceDocument(executor, {
          id,
          teamId: input.teamId,
          sourceId: locked.id,
          versionId: locked.currentVersionId,
          filePath,
          fileName: safeFileName(input.fileName, type.extension),
          contentType: type.contentType,
          size: input.bytes.byteLength,
          sha256,
          uploadedBy: input.actorId,
        }),
        deduplicated: false,
      };
    });
    if (document.deduplicated) {
      await storage.remove({ bucket: "vault", path: filePath }).catch(() => {});
    }
    return document;
  } catch (error) {
    await storage.remove({ bucket: "vault", path: filePath }).catch(() => {});
    throw error;
  }
}

/** A retained document's bytes, only from the caller's own workspace. */
export async function readAuthorizationSourceDocument(
  db: Database,
  input: { teamId: string; sourceId: string; documentId: string },
  storage: AuthorizationDocumentStorage = defaultIntakeStorage,
) {
  const document = await getAuthorizationSourceDocument(db, input);
  if (!document || authorizationDocumentBindingIssue(document)) return null;
  const data = await storage.download({
    bucket: "vault",
    path: document.filePath,
  });
  return {
    data,
    fileName: document.fileName,
    contentType: document.contentType,
  };
}
