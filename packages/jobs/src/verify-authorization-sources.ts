/**
 * Authorization sources, end to end against Postgres.
 *
 * A job, a purchase order and a contract are imported from CSV; the purchase
 * order is amended, and both its original and the version in effect on a date
 * (before and after the amendment, and as recorded before it) are read back.
 * Re-importing is idempotent, duplicates and invalid rows reject the whole
 * file without writing anything, a cancelled source refuses amendment,
 * versions cannot be edited in place, suppliers link by explicit identifiers
 * (and stay explicitly unknown otherwise), retained documents are kept once,
 * and nothing is visible from another workspace.
 *
 *   DATABASE_PRIMARY_URL=... LOCAL_STORAGE_PATH=... bun run verify:authorization-sources
 */
import { createDatabaseClient } from "@invoicewise/db/client";
import {
  getAuthorizationSource,
  getAuthorizationSourceVersion,
  getEffectiveAuthorizationSourceVersion,
  listAuthorizationSources,
} from "@invoicewise/db/queries";
import {
  authorizationSourceImports,
  authorizationSourceVersions,
  authorizationSources,
  suppliers,
  teams,
  users,
} from "@invoicewise/db/schema";
import { createStorageClientFromEnv } from "@invoicewise/db/storage";
import { eq, inArray, sql } from "drizzle-orm";
import {
  AuthorizationSourceError,
  amendAuthorizationSource,
  attachAuthorizationSourceDocument,
  createAuthorizationSource,
  importAuthorizationSourcesCsv,
  linkAuthorizationSourceSupplier,
  readAuthorizationSourceDocument,
  setAuthorizationSourceStatus,
  submitAuthorizationSources,
} from "./authorization-sources";
import { required } from "./verify-support";

const assert = (condition: unknown, message: string, detail?: unknown) => {
  if (!condition) {
    throw new Error(
      `${message}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`,
    );
  }
};

const rejects = async (work: () => Promise<unknown>, code: string) => {
  try {
    await work();
  } catch (error) {
    if (error instanceof AuthorizationSourceError && error.code === code) {
      return error;
    }
    throw error;
  }
  throw new Error(`expected an AuthorizationSourceError (${code})`);
};

const HEADER =
  "source_type,reference,status,title,scope,supplier_name,supplier_vat_number,supplier_company_number,currency,tax_basis,issued_on,starts_on,ends_on,effective_from,authorized_total,change_reason,line_reference,line_description,quantity,unit_price,line_amount";

const IMPORT = [
  HEADER,
  "job,JOB-1042,open,Kitchen refit,Refit kitchen at 12 High St,Northwind Joinery Ltd,GB293445512,,GBP,exclusive,2026-09-01,2026-09-07,2026-10-31,,,,1,Labour,40,45,1800.00",
  "job,JOB-1042,,,,,,,,,,,,,,,2,Materials,,,2400.00",
  "purchase_order,PO-55120,open,Timber,,Northwind Joinery Ltd,GB293445512,,GBP,exclusive,2026-09-02,,,,,,1,Oak boards,120,18.5,2220.00",
  "contract,CT-2026-07,open,Grounds maintenance,Monthly grounds maintenance,Unheard Of Gardens,,,,,2026-04-01,2026-04-01,2027-03-31,,14400.00,,,,,,",
].join("\n");

// The purchase order amended: 20 more boards, effective 2026-09-15.
const AMENDED = [
  HEADER,
  "purchase_order,po 55120,open,Timber,,Northwind Joinery Ltd,GB293445512,,GBP,exclusive,2026-09-02,,,2026-09-15,,Extra boards,1,Oak boards,140,18.5,2590.00",
].join("\n");

const PDF = new TextEncoder().encode(
  "%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n",
);

async function main() {
  const database = createDatabaseClient({
    primaryUrl: required("DATABASE_PRIMARY_URL"),
    isDevelopment: true,
  });
  const db = database.db;
  const storage = createStorageClientFromEnv();
  const teamIds: string[] = [];
  let actorId: string | null = null;

  try {
    for (const name of ["Authorization sources A", "Authorization sources B"]) {
      const [team] = await db
        .insert(teams)
        .values({ name })
        .returning({ id: teams.id });
      teamIds.push(team!.id);
    }
    const [teamA, teamB] = teamIds as [string, string];
    const [user] = await db
      .insert(users)
      .values({
        fullName: "Authorization verifier",
        email: `authorization-${teamA}@invoicewise.local`,
        teamId: teamA,
      })
      .returning({ id: users.id });
    actorId = user!.id;
    const [northwind] = await db
      .insert(suppliers)
      .values({
        teamId: teamA,
        name: "Northwind Joinery Ltd",
        nameKey: "northwind joinery",
        vatKey: "GB293445512",
      })
      .returning({ id: suppliers.id });
    // Two suppliers sharing a name: a name alone must not pick either.
    await db.insert(suppliers).values([
      {
        teamId: teamA,
        name: "Twin Traders Ltd",
        nameKey: "twin traders",
        vatKey: "GB100000001",
      },
      {
        teamId: teamA,
        name: "Twin Traders",
        nameKey: "twin traders",
        vatKey: "GB100000002",
      },
    ]);
    const countRows = async () => {
      const [row] = await db
        .select({
          sources: sql<number>`(select count(*)::int from authorization_sources where team_id = ${teamA})`,
          versions: sql<number>`(select count(*)::int from authorization_source_versions where team_id = ${teamA})`,
        })
        .from(teams)
        .where(eq(teams.id, teamA));
      return row!;
    };

    // --- An invalid file changes nothing and names each bad row.
    const invalid = await importAuthorizationSourcesCsv(db, {
      teamId: teamA,
      actorId,
      fileName: "bad.csv",
      csv: [
        IMPORT,
        "purchase_order,PO-9,open,,,,,,EURO,,2026-13-01,,,,,,1,Thing,,,abc",
        "job,JOB-2,open,,,,,,GBP,,,,,,,,,,,,",
      ].join("\n"),
    });
    assert(
      invalid.status === "rejected",
      "An invalid file is rejected",
      invalid,
    );
    const rows = invalid.errors.map((error) => [error.row, error.column]);
    assert(
      JSON.stringify(rows) ===
        JSON.stringify([
          [6, "currency"],
          [6, "issued_on"],
          [6, "line_amount"],
          [7, "authorized_total"],
        ]),
      "Each bad value is reported with its row and column",
      invalid.errors,
    );
    assert(
      (await countRows()).sources === 0,
      "A rejected import writes no source",
    );
    const [rejectedLog] = await db
      .select()
      .from(authorizationSourceImports)
      .where(eq(authorizationSourceImports.teamId, teamA));
    assert(
      rejectedLog?.status === "rejected" &&
        (rejectedLog.errors as unknown[]).length === 4,
      "The rejected import is recorded with its errors",
      rejectedLog,
    );

    // A duplicate source in one request rejects the request.
    const duplicate = await submitAuthorizationSources(db, {
      teamId: teamA,
      actorId,
      sources: [
        { type: "job", reference: "J-1", authorizedTotal: 1 },
        { type: "job", reference: "j 1", authorizedTotal: 2 },
      ],
    });
    assert(
      duplicate.status === "rejected" &&
        duplicate.errors[0]?.message === "Repeats source 1 of this request." &&
        (await countRows()).sources === 0,
      "A reference repeated in one request rejects it and writes nothing",
      duplicate,
    );

    // --- A dry run validates without writing.
    const dryRun = await importAuthorizationSourcesCsv(db, {
      teamId: teamA,
      actorId,
      csv: IMPORT,
      dryRun: true,
    });
    assert(
      dryRun.status === "validated" &&
        dryRun.summary.created === 3 &&
        (await countRows()).sources === 0,
      "A dry run reports what would happen and writes nothing",
      dryRun,
    );

    // --- Import a job, a purchase order and a contract.
    const imported = await importAuthorizationSourcesCsv(db, {
      teamId: teamA,
      actorId,
      csv: IMPORT,
      fileName: "sources.csv",
    });
    assert(
      imported.status === "applied" && imported.summary.created === 3,
      "The import creates three sources",
      imported,
    );
    const [job, po, contract] = imported.results;
    assert(
      job?.supplierId === northwind!.id && po?.supplierId === northwind!.id,
      "Sources resolve to the supplier holding their VAT number",
      imported.results,
    );
    assert(
      contract?.supplierId === null &&
        JSON.stringify(contract.gaps.map((gap) => gap.code)) ===
          JSON.stringify([
            "unknown_supplier",
            "missing_currency",
            "missing_tax_basis",
          ]),
      "An unknown supplier and a missing currency are explicit gaps",
      contract,
    );
    const jobSource = await getAuthorizationSource(db, {
      teamId: teamA,
      sourceId: job!.sourceId!,
    });
    assert(
      jobSource?.current.authorizedTotal === "4200.00" &&
        jobSource.current.lineItems.length === 2 &&
        jobSource.current.effectiveFrom === "2026-09-07" &&
        jobSource.current.importId === imported.importId,
      "The job keeps both authorized lines, its total and its import",
      jobSource?.current,
    );

    // Re-importing the same file is idempotent.
    const again = await importAuthorizationSourcesCsv(db, {
      teamId: teamA,
      actorId,
      csv: IMPORT,
    });
    assert(
      again.status === "applied" &&
        again.summary.unchanged === 3 &&
        (await countRows()).versions === 3,
      "An identical re-import records no new version",
      again,
    );

    // --- Amend the purchase order.
    const amended = await importAuthorizationSourcesCsv(db, {
      teamId: teamA,
      actorId,
      csv: AMENDED,
    });
    assert(
      amended.status === "applied" &&
        amended.results[0]?.outcome === "amended" &&
        amended.results[0].sourceId === po!.sourceId &&
        amended.results[0].version === 2,
      "Re-importing a changed reference amends the same source",
      amended,
    );
    const poId = po!.sourceId!;
    const original = await getAuthorizationSourceVersion(db, {
      teamId: teamA,
      sourceId: poId,
      version: 1,
    });
    const current = await getAuthorizationSourceVersion(db, {
      teamId: teamA,
      sourceId: poId,
      version: 2,
    });
    assert(
      original?.authorizedTotal === "2220.00" &&
        current?.authorizedTotal === "2590.00" &&
        current.changeReason === "Extra boards",
      "The original and the amendment are both retrievable",
      { original, current },
    );
    const before = await getEffectiveAuthorizationSourceVersion(db, {
      teamId: teamA,
      sourceId: poId,
      on: "2026-09-10",
    });
    const after = await getEffectiveAuthorizationSourceVersion(db, {
      teamId: teamA,
      sourceId: poId,
      on: "2026-09-20",
    });
    const asRecordedThen = await getEffectiveAuthorizationSourceVersion(db, {
      teamId: teamA,
      sourceId: poId,
      on: "2026-09-20",
      asOf: original!.createdAt,
    });
    const notYet = await getEffectiveAuthorizationSourceVersion(db, {
      teamId: teamA,
      sourceId: poId,
      on: "2026-09-01",
    });
    assert(
      before?.version === 1 &&
        after?.version === 2 &&
        asRecordedThen?.version === 1 &&
        notYet === null,
      "The effective version follows the effective date and the recorded time",
      { before, after, asRecordedThen, notYet },
    );

    // --- Versions are immutable in the database itself.
    let refused = false;
    try {
      await db
        .update(authorizationSourceVersions)
        .set({ authorizedTotal: "1.00" })
        .where(eq(authorizationSourceVersions.id, original!.id));
    } catch {
      refused = true;
    }
    assert(refused, "A stored version cannot be edited in place");

    // --- Manual entry: an existing reference is refused, a name-only
    // supplier shared by two suppliers stays unknown, then an admin links it.
    await rejects(
      () =>
        createAuthorizationSource(db, {
          teamId: teamA,
          actorId,
          source: {
            type: "purchase_order",
            reference: "PO-55120",
            authorizedTotal: 5,
          },
        }),
      "conflict",
    );
    const ambiguous = await createAuthorizationSource(db, {
      teamId: teamA,
      actorId,
      source: {
        type: "contract",
        reference: "CT-TWIN",
        supplier: { name: "Twin Traders" },
        currency: "GBP",
        taxBasis: "exclusive",
        authorizedTotal: "900",
      },
    });
    const twinSource = await getAuthorizationSource(db, {
      teamId: teamA,
      sourceId: ambiguous.sourceId!,
    });
    assert(
      ambiguous.supplierId === null &&
        (twinSource?.current.supplierResolution as { reason?: string })
          .reason === "ambiguous_name",
      "A name two suppliers share never links to either",
      twinSource?.current.supplierResolution,
    );
    const contractLinked = await linkAuthorizationSourceSupplier(db, {
      teamId: teamA,
      actorId,
      sourceId: contract!.sourceId!,
      supplierId: northwind!.id,
    });
    const contractSource = await getAuthorizationSource(db, {
      teamId: teamA,
      sourceId: contract!.sourceId!,
    });
    assert(
      contractLinked.outcome === "amended" &&
        contractSource?.current.supplierId === northwind!.id &&
        contractSource.current.effectiveFrom === "2026-04-01" &&
        contractSource.versions[1]?.supplierId === null,
      "Linking a supplier is a new version that keeps the effective date",
      contractSource,
    );
    // A later re-import with the same supplier details keeps the link.
    const keptLink = await importAuthorizationSourcesCsv(db, {
      teamId: teamA,
      actorId,
      csv: [HEADER, IMPORT.split("\n")[4]].join("\n"),
    });
    assert(
      keptLink.results[0]?.outcome === "unchanged" &&
        keptLink.results[0].supplierId === northwind!.id,
      "An unchanged re-import keeps a manual supplier link",
      keptLink.results,
    );

    // --- Close and reopen, then cancel: a cancelled source refuses changes.
    await setAuthorizationSourceStatus(db, {
      teamId: teamA,
      actorId,
      sourceId: job!.sourceId!,
      status: "cancelled",
      reason: "Customer withdrew",
    });
    await rejects(
      () =>
        amendAuthorizationSource(db, {
          teamId: teamA,
          actorId,
          sourceId: job!.sourceId!,
          source: {
            type: "job",
            reference: "JOB-1042",
            status: "open",
            authorizedTotal: 1,
          },
        }),
      "invalid",
    );
    const cancelledImport = await importAuthorizationSourcesCsv(db, {
      teamId: teamA,
      actorId,
      csv: IMPORT,
    });
    assert(
      cancelledImport.status === "rejected" &&
        cancelledImport.errors[0]?.row === 2 &&
        cancelledImport.errors[0].message.includes("cancelled"),
      "Re-opening a cancelled source by import is refused and applies nothing",
      cancelledImport,
    );
    const listed = await listAuthorizationSources(db, {
      teamId: teamA,
      status: "cancelled",
    });
    assert(
      listed.data.length === 1 && listed.data[0]?.id === job!.sourceId,
      "Sources can be listed by status",
      listed,
    );
    const searched = await listAuthorizationSources(db, {
      teamId: teamA,
      q: "po55120",
    });
    assert(
      searched.data.length === 1 && searched.data[0]?.id === poId,
      "A reference is found regardless of spacing and punctuation",
      searched,
    );

    // --- Retained documents: kept once, readable only in their workspace.
    const attached = await attachAuthorizationSourceDocument(
      db,
      {
        teamId: teamA,
        actorId,
        sourceId: poId,
        bytes: PDF,
        fileName: "po.pdf",
      },
      storage,
    );
    const reattached = await attachAuthorizationSourceDocument(
      db,
      {
        teamId: teamA,
        actorId,
        sourceId: poId,
        bytes: PDF,
        fileName: "copy.pdf",
      },
      storage,
    );
    assert(
      !attached.deduplicated &&
        reattached.deduplicated &&
        reattached.document.id === attached.document.id &&
        attached.document.versionId === current!.id,
      "A document is kept once, on the version current when it arrived",
      { attached, reattached },
    );
    await rejects(
      () =>
        attachAuthorizationSourceDocument(
          db,
          {
            teamId: teamA,
            actorId,
            sourceId: poId,
            bytes: new TextEncoder().encode("<html>"),
            fileName: "x.html",
          },
          storage,
        ),
      "invalid",
    );
    const read = await readAuthorizationSourceDocument(
      db,
      { teamId: teamA, sourceId: poId, documentId: attached.document.id },
      storage,
    );
    assert(
      read &&
        new Uint8Array(await read.data.arrayBuffer()).byteLength ===
          PDF.byteLength,
      "The retained document reads back",
    );

    // --- Another workspace sees nothing and keeps its own references.
    assert(
      (await getAuthorizationSource(db, { teamId: teamB, sourceId: poId })) ===
        null &&
        (await readAuthorizationSourceDocument(
          db,
          { teamId: teamB, sourceId: poId, documentId: attached.document.id },
          storage,
        )) === null &&
        (await listAuthorizationSources(db, { teamId: teamB })).data.length ===
          0,
      "Another workspace cannot read the sources or their documents",
    );
    await rejects(
      () =>
        amendAuthorizationSource(db, {
          teamId: teamB,
          actorId,
          sourceId: poId,
          source: {
            type: "purchase_order",
            reference: "PO-55120",
            authorizedTotal: 1,
          },
        }),
      "not_found",
    );
    await rejects(
      () =>
        linkAuthorizationSourceSupplier(db, {
          teamId: teamA,
          actorId,
          sourceId: ambiguous.sourceId!,
          supplierId: "00000000-0000-4000-8000-000000000000",
        }),
      "not_found",
    );
    const other = await importAuthorizationSourcesCsv(db, {
      teamId: teamB,
      actorId,
      csv: IMPORT,
    });
    assert(
      other.status === "applied" &&
        other.summary.created === 3 &&
        other.results.every((result) => result.supplierId === null),
      "The same references in another workspace are its own, never linked to this workspace's suppliers",
      other,
    );

    console.log(
      JSON.stringify({
        ok: true,
        imported: imported.summary,
        amendedVersion: amended.results[0]?.version,
        effectiveBefore: before?.version,
        effectiveAfter: after?.version,
        rejectedImportErrors: invalid.errors.length,
        immutable: refused,
      }),
    );
  } finally {
    if (teamIds.length > 0) {
      await db
        .delete(authorizationSources)
        .where(inArray(authorizationSources.teamId, teamIds));
      await db.delete(suppliers).where(inArray(suppliers.teamId, teamIds));
      await db
        .delete(authorizationSourceImports)
        .where(inArray(authorizationSourceImports.teamId, teamIds));
    }
    if (actorId) await db.delete(users).where(eq(users.id, actorId));
    if (teamIds.length > 0) {
      await db.delete(teams).where(inArray(teams.id, teamIds));
    }
    await database.close();
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
