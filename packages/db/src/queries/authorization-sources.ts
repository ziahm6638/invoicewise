import type { Database } from "@db/client";
import {
  authorizationSourceDocuments,
  authorizationSourceImports,
  authorizationSourceVersions,
  authorizationSources,
  suppliers,
  users,
} from "@db/schema";
import {
  type SQL,
  and,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { type AnyPgColumn, alias } from "drizzle-orm/pg-core";

/**
 * Serialises every authorization-source write in a workspace, so version
 * numbers, reference uniqueness and all-or-nothing imports never race.
 */
export async function lockAuthorizationSources(db: Database, teamId: string) {
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`authorization-sources:${teamId}`}))`,
  );
}

export type AuthorizationSourceHead = typeof authorizationSources.$inferSelect;
export type AuthorizationSourceVersionRow =
  typeof authorizationSourceVersions.$inferSelect;

export async function findAuthorizationSourcesByKeys(
  db: Database,
  params: {
    teamId: string;
    keys: { sourceType: string; referenceKey: string }[];
  },
): Promise<AuthorizationSourceHead[]> {
  if (params.keys.length === 0) return [];
  const referenceKeys = [
    ...new Set(params.keys.map((key) => key.referenceKey)),
  ];
  const rows = await db
    .select()
    .from(authorizationSources)
    .where(
      and(
        eq(authorizationSources.teamId, params.teamId),
        inArray(authorizationSources.referenceKey, referenceKeys),
      ),
    );
  const wanted = new Set(
    params.keys.map((key) => `${key.sourceType}\u0000${key.referenceKey}`),
  );
  return rows.filter((row) =>
    wanted.has(`${row.sourceType}\u0000${row.referenceKey}`),
  );
}

export async function getAuthorizationSourceHead(
  db: Database,
  params: { teamId: string; sourceId: string },
) {
  const [row] = await db
    .select()
    .from(authorizationSources)
    .where(
      and(
        eq(authorizationSources.id, params.sourceId),
        eq(authorizationSources.teamId, params.teamId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function getAuthorizationSourceVersionRows(
  db: Database,
  params: { teamId: string; versionIds: string[] },
): Promise<AuthorizationSourceVersionRow[]> {
  if (params.versionIds.length === 0) return [];
  return db
    .select()
    .from(authorizationSourceVersions)
    .where(
      and(
        eq(authorizationSourceVersions.teamId, params.teamId),
        inArray(authorizationSourceVersions.id, params.versionIds),
      ),
    );
}

export async function insertAuthorizationSource(
  db: Database,
  values: typeof authorizationSources.$inferInsert,
) {
  const [row] = await db
    .insert(authorizationSources)
    .values(values)
    .returning();
  return row!;
}

export async function insertAuthorizationSourceVersion(
  db: Database,
  values: typeof authorizationSourceVersions.$inferInsert,
) {
  const [row] = await db
    .insert(authorizationSourceVersions)
    .values(values)
    .returning();
  return row!;
}

/** Points a source at its newest version and refreshes the listed values. */
export async function setAuthorizationSourceHead(
  db: Database,
  params: { teamId: string; version: AuthorizationSourceVersionRow },
) {
  const { version } = params;
  await db
    .update(authorizationSources)
    .set({
      currentVersionId: version.id,
      currentVersion: version.version,
      status: version.status,
      title: version.title,
      supplierId: version.supplierId,
      supplierName: version.supplierName,
      currency: version.currency,
      authorizedTotal: version.authorizedTotal,
      effectiveFrom: version.effectiveFrom,
      updatedAt: version.createdAt,
    })
    .where(
      and(
        eq(authorizationSources.id, version.sourceId),
        eq(authorizationSources.teamId, params.teamId),
      ),
    );
}

export async function recordAuthorizationSourceImport(
  db: Database,
  values: typeof authorizationSourceImports.$inferInsert,
) {
  const [row] = await db
    .insert(authorizationSourceImports)
    .values(values)
    .returning({ id: authorizationSourceImports.id });
  return row!.id;
}

export async function listAuthorizationSourceImports(
  db: Database,
  params: { teamId: string; limit?: number },
) {
  return db
    .select({
      id: authorizationSourceImports.id,
      origin: authorizationSourceImports.origin,
      fileName: authorizationSourceImports.fileName,
      status: authorizationSourceImports.status,
      summary: authorizationSourceImports.summary,
      errorCount: sql<number>`jsonb_array_length(${authorizationSourceImports.errors})`,
      actorName: users.fullName,
      createdAt: authorizationSourceImports.createdAt,
    })
    .from(authorizationSourceImports)
    .leftJoin(users, eq(users.id, authorizationSourceImports.actorId))
    .where(eq(authorizationSourceImports.teamId, params.teamId))
    .orderBy(desc(authorizationSourceImports.createdAt))
    .limit(params.limit ?? 10);
}

// --- Reads -----------------------------------------------------------------------

const linked = alias(suppliers, "linked_supplier");
const canonical = alias(suppliers, "canonical_supplier");

/** The canonical supplier a stored supplier id now belongs to (merges followed). */
const canonicalJoin = (column: AnyPgColumn) =>
  [
    [linked, eq(linked.id, column)],
    [
      canonical,
      eq(canonical.id, sql`coalesce(${linked.mergedIntoId}, ${linked.id})`),
    ],
  ] as const;

export type AuthorizationSourceListFilter = {
  teamId: string;
  q?: string | null;
  type?: string | null;
  status?: string | null;
  supplierId?: string | null;
  /** Only sources with no linked supplier, or with no currency. */
  gap?: "unknown_supplier" | "missing_currency" | null;
  cursor?: string | null;
  pageSize?: number;
};

export async function listAuthorizationSources(
  db: Database,
  filter: AuthorizationSourceListFilter,
) {
  const pageSize = Math.min(Math.max(filter.pageSize ?? 50, 1), 100);
  const offset = Math.max(Number.parseInt(filter.cursor ?? "0", 10) || 0, 0);
  const [[linkedTable, linkedOn], [canonicalTable, canonicalOn]] =
    canonicalJoin(authorizationSources.supplierId);

  const conditions: (SQL | undefined)[] = [
    eq(authorizationSources.teamId, filter.teamId),
  ];
  if (filter.type)
    conditions.push(eq(authorizationSources.sourceType, filter.type));
  if (filter.status)
    conditions.push(eq(authorizationSources.status, filter.status));
  if (filter.supplierId) conditions.push(eq(canonical.id, filter.supplierId));
  if (filter.gap === "unknown_supplier") {
    conditions.push(isNull(authorizationSources.supplierId));
  }
  if (filter.gap === "missing_currency") {
    conditions.push(isNull(authorizationSources.currency));
  }
  const q = filter.q?.trim();
  if (q) {
    const pattern = `%${q.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
    const key = q.toUpperCase().replace(/[^A-Z0-9]/g, "");
    conditions.push(
      or(
        ilike(authorizationSources.reference, pattern),
        ilike(authorizationSources.title, pattern),
        ilike(authorizationSources.supplierName, pattern),
        ilike(canonical.name, pattern),
        key
          ? sql`${authorizationSources.referenceKey} like ${`%${key}%`}`
          : undefined,
      ),
    );
  }

  const rows = await db
    .select({
      id: authorizationSources.id,
      type: authorizationSources.sourceType,
      reference: authorizationSources.reference,
      status: authorizationSources.status,
      title: authorizationSources.title,
      version: authorizationSources.currentVersion,
      supplierId: canonical.id,
      supplierName: canonical.name,
      suppliedSupplierName: authorizationSources.supplierName,
      currency: authorizationSources.currency,
      authorizedTotal: authorizationSources.authorizedTotal,
      effectiveFrom: authorizationSources.effectiveFrom,
      createdAt: authorizationSources.createdAt,
      updatedAt: authorizationSources.updatedAt,
    })
    .from(authorizationSources)
    .leftJoin(linkedTable, linkedOn)
    .leftJoin(canonicalTable, canonicalOn)
    .where(and(...conditions))
    .orderBy(
      desc(authorizationSources.updatedAt),
      desc(authorizationSources.id),
    )
    .limit(pageSize + 1)
    .offset(offset);

  const hasMore = rows.length > pageSize;
  return {
    data: rows.slice(0, pageSize),
    meta: { cursor: hasMore ? String(offset + pageSize) : null, hasMore },
  };
}

const versionColumns = {
  id: authorizationSourceVersions.id,
  sourceId: authorizationSourceVersions.sourceId,
  version: authorizationSourceVersions.version,
  status: authorizationSourceVersions.status,
  title: authorizationSourceVersions.title,
  scope: authorizationSourceVersions.scope,
  supplierId: canonical.id,
  supplierName: canonical.name,
  suppliedSupplier: {
    name: authorizationSourceVersions.supplierName,
    vatNumber: authorizationSourceVersions.supplierVatNumber,
    companyNumber: authorizationSourceVersions.supplierCompanyNumber,
  },
  supplierResolution: authorizationSourceVersions.supplierResolution,
  currency: authorizationSourceVersions.currency,
  taxBasis: authorizationSourceVersions.taxBasis,
  issuedOn: authorizationSourceVersions.issuedOn,
  startsOn: authorizationSourceVersions.startsOn,
  endsOn: authorizationSourceVersions.endsOn,
  effectiveFrom: authorizationSourceVersions.effectiveFrom,
  authorizedTotal: authorizationSourceVersions.authorizedTotal,
  lineItems: authorizationSourceVersions.lineItems,
  changeReason: authorizationSourceVersions.changeReason,
  origin: authorizationSourceVersions.origin,
  importId: authorizationSourceVersions.importId,
  contentHash: authorizationSourceVersions.contentHash,
  actorName: users.fullName,
  createdAt: authorizationSourceVersions.createdAt,
};

const selectVersions = (db: Database) => {
  const [[linkedTable, linkedOn], [canonicalTable, canonicalOn]] =
    canonicalJoin(authorizationSourceVersions.supplierId);
  return db
    .select(versionColumns)
    .from(authorizationSourceVersions)
    .leftJoin(linkedTable, linkedOn)
    .leftJoin(canonicalTable, canonicalOn)
    .leftJoin(users, eq(users.id, authorizationSourceVersions.actorId))
    .$dynamic();
};

/** A source with every version (newest first) and its retained documents. */
export async function getAuthorizationSource(
  db: Database,
  params: { teamId: string; sourceId: string },
) {
  const head = await getAuthorizationSourceHead(db, params);
  if (!head) return null;
  const [versions, documents] = await Promise.all([
    selectVersions(db)
      .where(
        and(
          eq(authorizationSourceVersions.teamId, params.teamId),
          eq(authorizationSourceVersions.sourceId, head.id),
        ),
      )
      .orderBy(desc(authorizationSourceVersions.version)),
    listAuthorizationSourceDocuments(db, params),
  ]);
  return {
    id: head.id,
    type: head.sourceType,
    reference: head.reference,
    createdAt: head.createdAt,
    updatedAt: head.updatedAt,
    current: versions[0]!,
    versions,
    documents,
  };
}

export async function getAuthorizationSourceVersion(
  db: Database,
  params: { teamId: string; sourceId: string; version: number },
) {
  const [row] = await selectVersions(db)
    .where(
      and(
        eq(authorizationSourceVersions.teamId, params.teamId),
        eq(authorizationSourceVersions.sourceId, params.sourceId),
        eq(authorizationSourceVersions.version, params.version),
      ),
    )
    .limit(1);
  return row ?? null;
}

export type AuthorizationSourceVersion = NonNullable<
  Awaited<ReturnType<typeof getAuthorizationSourceVersion>>
>;

/**
 * The version in effect on `on`: the newest version whose effective date is
 * on or before it. With `asOf`, only versions recorded by then count, so a
 * comparison made at that time can be reproduced after later amendments.
 */
export async function getEffectiveAuthorizationSourceVersion(
  db: Database,
  params: {
    teamId: string;
    sourceId: string;
    on: string;
    asOf?: string | null;
  },
) {
  const [row] = await selectVersions(db)
    .where(
      and(
        eq(authorizationSourceVersions.teamId, params.teamId),
        eq(authorizationSourceVersions.sourceId, params.sourceId),
        lte(authorizationSourceVersions.effectiveFrom, params.on),
        params.asOf
          ? lte(authorizationSourceVersions.createdAt, params.asOf)
          : undefined,
      ),
    )
    .orderBy(desc(authorizationSourceVersions.version))
    .limit(1);
  return row ?? null;
}

// --- Documents -------------------------------------------------------------------

export async function listAuthorizationSourceDocuments(
  db: Database,
  params: { teamId: string; sourceId: string },
) {
  return db
    .select({
      id: authorizationSourceDocuments.id,
      versionId: authorizationSourceDocuments.versionId,
      version: authorizationSourceVersions.version,
      fileName: authorizationSourceDocuments.fileName,
      contentType: authorizationSourceDocuments.contentType,
      size: authorizationSourceDocuments.size,
      uploadedByName: users.fullName,
      createdAt: authorizationSourceDocuments.createdAt,
    })
    .from(authorizationSourceDocuments)
    .innerJoin(
      authorizationSourceVersions,
      eq(
        authorizationSourceVersions.id,
        authorizationSourceDocuments.versionId,
      ),
    )
    .leftJoin(users, eq(users.id, authorizationSourceDocuments.uploadedBy))
    .where(
      and(
        eq(authorizationSourceDocuments.teamId, params.teamId),
        eq(authorizationSourceDocuments.sourceId, params.sourceId),
      ),
    )
    .orderBy(desc(authorizationSourceDocuments.createdAt));
}

export async function getAuthorizationSourceDocument(
  db: Database,
  params: { teamId: string; sourceId: string; documentId: string },
) {
  const [row] = await db
    .select()
    .from(authorizationSourceDocuments)
    .where(
      and(
        eq(authorizationSourceDocuments.id, params.documentId),
        eq(authorizationSourceDocuments.sourceId, params.sourceId),
        eq(authorizationSourceDocuments.teamId, params.teamId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function findAuthorizationSourceDocumentByHash(
  db: Database,
  params: { teamId: string; sourceId: string; sha256: string },
) {
  const [row] = await db
    .select()
    .from(authorizationSourceDocuments)
    .where(
      and(
        eq(authorizationSourceDocuments.teamId, params.teamId),
        eq(authorizationSourceDocuments.sourceId, params.sourceId),
        eq(authorizationSourceDocuments.sha256, params.sha256),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function insertAuthorizationSourceDocument(
  db: Database,
  values: typeof authorizationSourceDocuments.$inferInsert,
) {
  const [row] = await db
    .insert(authorizationSourceDocuments)
    .values(values)
    .returning();
  return row!;
}

/** Why a stored source-document path must not be read, or null when it is the workspace's own. */
export function authorizationDocumentBindingIssue(document: {
  teamId: string;
  sourceId: string;
  filePath: string[] | null;
}): string | null {
  const path = document.filePath ?? [];
  if (
    path.length !== 4 ||
    path[0] !== document.teamId ||
    path[1] !== "authorization-sources" ||
    path[2] !== document.sourceId
  ) {
    return "The stored path is not this source's document path.";
  }
  if (
    path.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        segment.includes("/") ||
        segment.includes("\\"),
    )
  ) {
    return "The stored path contains an ambiguous segment.";
  }
  return null;
}

/** Every source, version and retained document of a workspace, for its export. */
export async function getAuthorizationSourcesForExport(
  db: Database,
  teamId: string,
) {
  const [sources, versions, documents] = await Promise.all([
    db
      .select()
      .from(authorizationSources)
      .where(eq(authorizationSources.teamId, teamId))
      .orderBy(authorizationSources.createdAt, authorizationSources.id),
    db
      .select()
      .from(authorizationSourceVersions)
      .where(eq(authorizationSourceVersions.teamId, teamId))
      .orderBy(
        authorizationSourceVersions.sourceId,
        authorizationSourceVersions.version,
      ),
    db
      .select()
      .from(authorizationSourceDocuments)
      .where(eq(authorizationSourceDocuments.teamId, teamId))
      .orderBy(
        authorizationSourceDocuments.createdAt,
        authorizationSourceDocuments.id,
      ),
  ]);
  return { sources, versions, documents };
}
