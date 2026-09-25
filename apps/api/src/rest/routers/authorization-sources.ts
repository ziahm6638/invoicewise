import { readBoundedBody, readBoundedFormData } from "@api/intake/http";
import type { Context } from "@api/rest/types";
import {
  authorizationSourceDocumentSchema,
  authorizationSourceEffectiveSchema,
  authorizationSourceIdSchema,
  authorizationSourceListSchema,
  authorizationSourceVersionSchema,
  submitAuthorizationSourcesSchema,
} from "@api/schemas/authorization-sources";
import {
  presentAuthorizationSource,
  presentAuthorizationSourceList,
  presentAuthorizationVersion,
} from "@api/utils/authorization-sources";
import { OpenAPIHono } from "@hono/zod-openapi";
import {
  getAuthorizationSource,
  getAuthorizationSourceHead,
  getAuthorizationSourceVersion,
  getEffectiveAuthorizationSourceVersion,
  listAuthorizationSourceImports,
  listAuthorizationSources,
} from "@invoicewise/db/queries";
import {
  AUTHORIZATION_SOURCE_LIMITS,
  INTAKE_LIMITS,
} from "@invoicewise/documents";
import {
  type AuthorizationBatchResult,
  AuthorizationSourceError,
  attachAuthorizationSourceDocument,
  importAuthorizationSourcesCsv,
  readAuthorizationSourceDocument,
  submitAuthorizationSources,
} from "@invoicewise/jobs/authorization-sources";
import { withRequiredScope, withRequiredTeamRole } from "../middleware";

const app = new OpenAPIHono<Context>();

const NOT_FOUND = { error: "Authorization source not found" };

const batchStatus = (result: AuthorizationBatchResult) =>
  result.status === "rejected" ? 422 : 200;

const failure = (error: unknown) => {
  if (error instanceof AuthorizationSourceError) {
    return {
      body: { error: error.message, errors: error.errors },
      status:
        error.code === "not_found"
          ? 404
          : error.code === "conflict"
            ? 409
            : 400,
    } as const;
  }
  throw error;
};

const MAX_IMPORT_BODY_BYTES = AUTHORIZATION_SOURCE_LIMITS.maxCsvBytes + 10_000;
const MAX_BATCH_BODY_BYTES = 20_000_000;

const tooLarge = { error: "The request body is too large" };

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const dryRunParam = (value: string | undefined) =>
  value === "1" || value === "true";

app.get("/", withRequiredScope("sources.read"), async (c) => {
  const parsed = authorizationSourceListSchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ error: "Invalid query", issues: parsed.error.issues }, 400);
  }
  return c.json(
    presentAuthorizationSourceList(
      await listAuthorizationSources(c.get("db"), {
        ...parsed.data,
        teamId: c.get("teamId"),
      }),
    ),
  );
});

/**
 * Sources as they now stand, keyed by type and reference: an unknown
 * reference is created, a changed one amended (a new version), an identical
 * one reported unchanged. All-or-nothing; `dryRun` validates only.
 */
app.post(
  "/",
  withRequiredScope("sources.write"),
  withRequiredTeamRole("admin"),
  async (c) => {
    const read = await readBoundedBody(c.req.raw, MAX_BATCH_BODY_BYTES);
    if (!read.ok && read.code === "too_large") {
      return c.json(tooLarge, 413, { connection: "close" });
    }
    const parsed = submitAuthorizationSourcesSchema.safeParse(
      read.ok ? parseJson(new TextDecoder().decode(read.bytes)) : undefined,
    );
    if (!parsed.success) {
      return c.json(
        {
          error: `Send {"sources": [...]} with 1 to ${AUTHORIZATION_SOURCE_LIMITS.maxSourcesPerBatch} sources`,
          issues: parsed.error.issues,
        },
        400,
      );
    }
    try {
      const result = await submitAuthorizationSources(c.get("db"), {
        teamId: c.get("teamId"),
        actorId: c.get("session").user.id,
        sources: parsed.data.sources,
        dryRun: parsed.data.dryRun,
      });
      return c.json(result, batchStatus(result));
    } catch (error) {
      const { body, status } = failure(error);
      return c.json(body, status);
    }
  },
);

/** A CSV file in the documented format, as `text/csv` (or `{"csv": "..."}`). */
app.post(
  "/import",
  withRequiredScope("sources.write"),
  withRequiredTeamRole("admin"),
  async (c) => {
    const read = await readBoundedBody(c.req.raw, MAX_IMPORT_BODY_BYTES);
    if (!read.ok && read.code === "too_large") {
      return c.json(tooLarge, 413, { connection: "close" });
    }
    const text = read.ok ? new TextDecoder().decode(read.bytes) : undefined;
    const contentType = c.req.header("content-type") ?? "";
    let csv: string | undefined;
    let fileName: string | null = c.req.query("fileName") ?? null;
    if (contentType.includes("application/json")) {
      const body = (text === undefined ? undefined : parseJson(text)) as
        | { csv?: unknown; fileName?: unknown }
        | undefined;
      if (typeof body?.csv === "string") csv = body.csv;
      if (typeof body?.fileName === "string") fileName = body.fileName;
    } else {
      csv = text;
    }
    if (csv === undefined) {
      return c.json({ error: "Send the CSV file as the request body" }, 400);
    }
    if (csv.length > AUTHORIZATION_SOURCE_LIMITS.maxCsvBytes) {
      return c.json({ error: "The file is too large" }, 413);
    }
    const result = await importAuthorizationSourcesCsv(c.get("db"), {
      teamId: c.get("teamId"),
      actorId: c.get("session").user.id,
      csv,
      fileName: fileName?.slice(0, 200) ?? null,
      dryRun: dryRunParam(c.req.query("dryRun")),
    });
    return c.json(result, batchStatus(result));
  },
);

app.get(
  "/imports",
  withRequiredScope("sources.read"),
  withRequiredTeamRole("admin"),
  async (c) =>
    c.json({
      data: await listAuthorizationSourceImports(c.get("db"), {
        teamId: c.get("teamId"),
        limit: 50,
      }),
    }),
);

app.get("/:id", withRequiredScope("sources.read"), async (c) => {
  const parsed = authorizationSourceIdSchema.safeParse(c.req.param());
  if (!parsed.success) return c.json(NOT_FOUND, 404);
  const source = await getAuthorizationSource(c.get("db"), {
    teamId: c.get("teamId"),
    sourceId: parsed.data.id,
  });
  return source
    ? c.json(presentAuthorizationSource(source))
    : c.json(NOT_FOUND, 404);
});

app.get(
  "/:id/versions/:version",
  withRequiredScope("sources.read"),
  async (c) => {
    const parsed = authorizationSourceVersionSchema.safeParse(c.req.param());
    if (!parsed.success) return c.json(NOT_FOUND, 404);
    const version = await getAuthorizationSourceVersion(c.get("db"), {
      teamId: c.get("teamId"),
      sourceId: parsed.data.id,
      version: parsed.data.version,
    });
    return version
      ? c.json(presentAuthorizationVersion(version))
      : c.json({ error: "Version not found" }, 404);
  },
);

/** `?on=YYYY-MM-DD[&asOf=<ISO time>]`: the version in effect on that date. */
app.get("/:id/effective", withRequiredScope("sources.read"), async (c) => {
  const parsed = authorizationSourceEffectiveSchema.safeParse({
    ...c.req.query(),
    id: c.req.param("id"),
  });
  if (!parsed.success) {
    return c.json(
      { error: "Give ?on=YYYY-MM-DD", issues: parsed.error.issues },
      400,
    );
  }
  const head = await getAuthorizationSourceHead(c.get("db"), {
    teamId: c.get("teamId"),
    sourceId: parsed.data.id,
  });
  if (!head) return c.json(NOT_FOUND, 404);
  const version = await getEffectiveAuthorizationSourceVersion(c.get("db"), {
    teamId: c.get("teamId"),
    sourceId: parsed.data.id,
    on: parsed.data.on,
    asOf: parsed.data.asOf,
  });
  return version
    ? c.json(presentAuthorizationVersion(version))
    : c.json({ error: "No version was in effect on that date" }, 404);
});

/** Attaches a PDF, PNG or JPEG (multipart field `file`) to the current version. */
app.post(
  "/:id/documents",
  withRequiredScope("sources.write"),
  withRequiredTeamRole("admin"),
  async (c) => {
    const id = authorizationSourceIdSchema.safeParse(c.req.param());
    if (!id.success) return c.json(NOT_FOUND, 404);
    const parsed = await readBoundedFormData(
      c.req.raw,
      INTAKE_LIMITS.maxBytes + 1_000_000,
    );
    if (!parsed.ok) {
      return c.json(
        { error: parsed.message },
        parsed.code === "too_large" ? 413 : 400,
        { connection: "close" },
      );
    }
    const file = parsed.formData.get("file");
    if (!(file instanceof Blob)) {
      return c.json({ error: "Send the document as the `file` field" }, 400);
    }
    try {
      const result = await attachAuthorizationSourceDocument(c.get("db"), {
        teamId: c.get("teamId"),
        actorId: c.get("session").user.id,
        sourceId: id.data.id,
        bytes: new Uint8Array(await file.arrayBuffer()),
        fileName:
          "name" in file && typeof file.name === "string" ? file.name : "",
      });
      return c.json(
        {
          id: result.document.id,
          versionId: result.document.versionId,
          fileName: result.document.fileName,
          contentType: result.document.contentType,
          size: result.document.size,
          deduplicated: result.deduplicated,
        },
        result.deduplicated ? 200 : 201,
      );
    } catch (error) {
      const { body, status } = failure(error);
      return c.json(body, status);
    }
  },
);

app.get(
  "/:id/documents/:documentId",
  withRequiredScope("sources.read"),
  async (c) => {
    const parsed = authorizationSourceDocumentSchema.safeParse(c.req.param());
    if (!parsed.success) return c.json({ error: "Document not found" }, 404);
    const document = await readAuthorizationSourceDocument(c.get("db"), {
      teamId: c.get("teamId"),
      sourceId: parsed.data.id,
      documentId: parsed.data.documentId,
    }).catch(() => null);
    if (!document) return c.json({ error: "Document not found" }, 404);
    return new Response(document.data, {
      headers: {
        "Content-Type": document.contentType,
        "Content-Disposition": `attachment; filename="${document.fileName.replace(/[^\w.\- ]/g, "_")}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  },
);

export { app as authorizationSourcesRouter };
