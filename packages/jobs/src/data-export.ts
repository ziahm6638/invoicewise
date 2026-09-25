import { createHash } from "node:crypto";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "@invoicewise/db/client";
import {
  type WorkspaceExportData,
  beginDataExport,
  completeDataExport,
  documentBindingIssue,
  getWorkspaceExportData,
  recordDataExportObject,
  recordDataExportProgress,
} from "@invoicewise/db/queries";
import type { DataExportSummary } from "@invoicewise/db/schema";
import type { RetentionPolicy } from "./retention-policy";
import { ZipFileWriter, ZipLimitError } from "./zip";

const VAULT_BUCKET = "vault";

/** Version of the archive layout described in docs/data-lifecycle.md. */
export const EXPORT_FORMAT_VERSION = 1;

export class DataExportError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    /** Safe to show the owner. */
    readonly userMessage: string,
  ) {
    super(message);
  }
}

/**
 * What the owner sees when a build stops. A retryable message promises a
 * retry, so once the job gives up it is replaced by a terminal one.
 */
export function exportFailureMessage(params: {
  userMessage?: string;
  retryable: boolean;
  final: boolean;
}) {
  if (params.final && params.retryable) {
    return "The export could not be prepared. Request a new export.";
  }
  return (
    params.userMessage ?? "The export could not be prepared. Try again shortly."
  );
}

export type DataExportStorage = {
  download: (input: {
    bucket: string;
    path: string[];
    signal?: AbortSignal;
  }) => Promise<Blob>;
  uploadFile: (input: {
    bucket: string;
    path: string[];
    sourcePath: string;
    contentType?: string;
  }) => Promise<unknown>;
  remove: (input: { bucket: string; path: string[] }) => Promise<unknown>;
};

export type DataExportDeps = {
  db: Database;
  storage: DataExportStorage;
  policy: RetentionPolicy;
  /** Directory for the archive while it is built; removed afterwards. */
  tempDir?: string;
  now?: () => Date;
};

export type DataExportResult =
  | {
      exportId: string;
      status: "ready";
      size: number;
      sha256: string;
      summary: DataExportSummary;
    }
  | { exportId: string; status: "skipped"; reason: string };

export const defaultExportTempDir = () => join(tmpdir(), "invoicewise-exports");

/** Where an export's archive lives: inside the workspace's private prefix. */
export const dataExportObjectPath = (
  teamId: string,
  exportId: string,
  fileName: string,
) => [teamId, "exports", exportId, fileName];

/** True when `path` is exactly an export archive of this workspace/export. */
export const isDataExportObjectPath = (
  path: readonly string[] | null | undefined,
  teamId: string,
  exportId: string,
) =>
  !!path &&
  path.length === 4 &&
  path[0] === teamId &&
  path[1] === "exports" &&
  path[2] === exportId &&
  !!path[3] &&
  !path[3].includes("/") &&
  path[3] !== "..";

const sha256 = (data: Uint8Array | string) =>
  createHash("sha256").update(data).digest("hex");

/** A document's name inside the archive: no directories, no control bytes. */
const archiveFileName = (
  fileName: string | null,
  contentType: string | null,
) => {
  const cleaned = Array.from(fileName ?? "", (character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 ||
      code === 0x7f ||
      character === "/" ||
      character === "\\"
      ? "_"
      : character;
  })
    .join("")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 150);
  if (cleaned) return cleaned;
  const extension =
    contentType === "application/pdf"
      ? ".pdf"
      : contentType === "image/png"
        ? ".png"
        : contentType === "image/jpeg"
          ? ".jpg"
          : "";
  return `document${extension}`;
};

const isMissingObject = (error: unknown) => {
  const value = error as {
    code?: string;
    name?: string;
    $metadata?: { httpStatusCode?: number };
  } | null;
  return (
    value?.code === "ENOENT" ||
    value?.name === "NoSuchKey" ||
    value?.name === "NotFound" ||
    value?.$metadata?.httpStatusCode === 404
  );
};

const text = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

type Judgment = Record<string, unknown> & { questionId?: unknown };

const judgmentId = (invoiceId: string, judgment: Judgment, index: number) =>
  `${invoiceId}:${text(judgment.questionId) ?? `#${index}`}`;

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

type DocumentRecord = {
  invoiceId: string;
  path: string | null;
  /** `withheld`: the stored path failed the workspace ownership check. */
  status: "included" | "missing" | "withheld";
  reason?: string;
  size: number | null;
  sha256: string | null;
  contentType: string | null;
  /** Hash recorded at intake; `intakeHashMatches` compares the two. */
  intakeSha256: string | null;
  intakeHashMatches: boolean | null;
};

/** Builds the JSON records of an export from the workspace's rows. */
export function buildExportRecords(
  data: WorkspaceExportData,
  documents: Map<string, DocumentRecord>,
) {
  const supplierInvoices = new Map<string, string[]>();
  const redeliveries = new Map<string, Record<string, unknown>[]>();
  for (const redelivery of data.redeliveries) {
    const list = redeliveries.get(redelivery.inboxId) ?? [];
    list.push({
      id: redelivery.id,
      receivedAt: redelivery.receivedAt,
      fileName: redelivery.fileName,
      mailboxId: redelivery.inboxAccountId,
      messageReference: redelivery.referenceId,
    });
    redeliveries.set(redelivery.inboxId, list);
  }
  const judgments: Record<string, unknown>[] = [];

  const invoices = data.invoices.map((invoice) => {
    const extraction = (invoice.extraction ?? null) as Record<
      string,
      unknown
    > | null;
    if (invoice.supplierId) {
      const list = supplierInvoices.get(invoice.supplierId) ?? [];
      list.push(invoice.id);
      supplierInvoices.set(invoice.supplierId, list);
    }

    const invoiceJudgments = Array.isArray(invoice.judgments)
      ? (invoice.judgments as Judgment[])
      : [];
    const judgmentIds = invoiceJudgments.map((judgment, index) => {
      const id = judgmentId(invoice.id, judgment, index);
      judgments.push({ id, invoiceId: invoice.id, ...judgment });
      return id;
    });

    return {
      id: invoice.id,
      receivedAt: invoice.createdAt,
      status: invoice.status,
      type: invoice.type,
      displayName: invoice.displayName,
      fileName: invoice.fileName,
      supplierId: invoice.supplierId,
      supplierResolution: invoice.supplierResolution,
      supplierChecks: invoice.supplierChecks,
      amount: invoice.amount,
      currency: invoice.currency,
      taxAmount: invoice.taxAmount,
      taxRate: invoice.taxRate,
      taxType: invoice.taxType,
      date: invoice.date,
      description: invoice.description,
      website: invoice.website,
      processingError: invoice.processingError,
      extraction,
      // The reading a user corrected, when the extraction holds corrections;
      // `invoice-corrections.json` has each change.
      extractionOriginal: invoice.extractionOriginal ?? null,
      judgmentIds,
      source: {
        mailboxId: invoice.inboxAccountId,
        messageReference: invoice.referenceId,
        redeliveries: redeliveries.get(invoice.id) ?? [],
      },
      accounting: invoice.accountingProvider
        ? {
            provider: invoice.accountingProvider,
            status: invoice.accountingPostStatus,
            providerId: invoice.accountingProviderId,
            postedAt: invoice.accountingPostedAt,
            error: invoice.accountingPostError,
          }
        : null,
      document: documents.get(invoice.id) ?? null,
    };
  });

  const supplierRecords = data.suppliers.map((supplier) => ({
    ...supplier,
    invoiceIds: supplierInvoices.get(supplier.id) ?? [],
  }));

  const audit: Record<string, unknown>[] = [];
  for (const invoice of data.invoices) {
    audit.push({
      id: `invoice.received:${invoice.id}`,
      at: invoice.createdAt,
      type: "invoice.received",
      subject: { kind: "invoice", id: invoice.id },
    });
    if (invoice.accountingPostedAt) {
      audit.push({
        id: `invoice.accounting_posted:${invoice.id}`,
        at: invoice.accountingPostedAt,
        type: "invoice.accounting_posted",
        subject: { kind: "invoice", id: invoice.id },
        detail: {
          provider: invoice.accountingProvider,
          status: invoice.accountingPostStatus,
        },
      });
    }
  }
  for (const delivery of data.deliveries) {
    audit.push({
      id: `webhook.delivery:${delivery.id}`,
      at: delivery.createdAt,
      type: "webhook.delivery",
      subject: { kind: "invoice", id: delivery.invoiceId },
      detail: {
        endpointId: delivery.endpointId,
        event: delivery.event,
        status: delivery.status,
        attempts: delivery.attempts,
        deliveredAt: delivery.deliveredAt,
      },
    });
  }
  for (const job of data.jobs) {
    audit.push({
      id: `job:${job.id}`,
      at: job.createdAt,
      type: `job.${job.name}`,
      subject: { kind: "job", id: job.id },
      detail: {
        status: job.status,
        attempts: job.attempts,
        finishedAt: job.finishedAt,
      },
    });
  }
  for (const event of data.supplierEvents) {
    audit.push({
      id: `supplier.${event.action}:${event.id}`,
      at: event.createdAt,
      type: `supplier.${event.action}`,
      subject: event.inboxId
        ? { kind: "invoice", id: event.inboxId }
        : { kind: "supplier", id: event.supplierId },
      detail: {
        supplierEventId: event.id,
        supplierId: event.supplierId,
        targetSupplierId: event.targetSupplierId,
        actorId: event.actorId,
        revertsEventId: event.revertsEventId,
        revertedAt: event.revertedAt,
      },
    });
  }
  for (const correction of data.corrections) {
    audit.push({
      id: `invoice.corrected:${correction.id}`,
      at: correction.createdAt,
      type: "invoice.corrected",
      subject: { kind: "invoice", id: correction.invoiceId },
      detail: {
        correctionId: correction.id,
        version: correction.version,
        actorId: correction.actorId,
        accountingOutcome: correction.accountingOutcome,
        billUpdate: correction.updateStatus,
      },
    });
  }
  for (const request of data.exports) {
    audit.push({
      id: `export.requested:${request.id}`,
      at: request.createdAt,
      type: "export.requested",
      subject: { kind: "export", id: request.id },
      detail: { requestedBy: request.requestedBy, status: request.status },
    });
  }
  const inboundEmails = data.inboundEmails.map((email) => ({
    id: email.id,
    receivedAt: email.createdAt,
    recipient: email.recipient,
    sender: email.headerFrom,
    envelopeSender: email.envelopeFrom,
    subject: email.subject,
    status: email.status,
    detail: email.detail,
    deliveryCount: email.deliveryCount,
    processedAt: email.processedAt,
    attachments: email.attachments,
    invoiceIds: email.attachments.flatMap((attachment) =>
      attachment.inboxId ? [attachment.inboxId] : [],
    ),
  }));

  audit.sort(
    (a, b) =>
      String(a.at).localeCompare(String(b.at)) ||
      String(a.id).localeCompare(String(b.id)),
  );

  return {
    workspace: {
      id: data.team.id,
      name: data.team.name,
      email: data.team.email,
      baseCurrency: data.team.baseCurrency,
      countryCode: data.team.countryCode,
      createdAt: data.team.createdAt,
      members: data.members,
      mailboxes: data.mailboxes,
      accountingConnections: data.accounting,
      webhookEndpoints: data.endpoints,
    },
    invoices,
    judgments,
    suppliers: supplierRecords,
    supplierEvents: data.supplierEvents,
    corrections: data.corrections,
    questions: data.questions,
    inboundEmails,
    audit,
  };
}

/** Removes archives left in the build directory by an interrupted run. */
export async function removeStaleExportTempFiles(
  dir: string,
  olderThanMs: number,
  now = Date.now(),
) {
  const removed: string[] = [];
  const names = await readdir(dir).catch(() => [] as string[]);
  for (const name of names) {
    if (!name.endsWith(".zip")) continue;
    const path = join(dir, name);
    const info = await stat(path).catch(() => null);
    if (info && now - info.mtimeMs > olderThanMs) {
      await rm(path, { force: true });
      removed.push(name);
    }
  }
  return removed;
}

/**
 * Builds one workspace export archive and publishes it.
 *
 * The archive is written to a private temporary file (removed in every case)
 * and streamed once to the workspace's private storage prefix; that stored
 * archive is the only lasting copy and is removed when the request expires.
 * A run that is interrupted starts the archive again from the beginning, so a
 * retried build always produces a complete archive at the same path.
 */
export async function buildDataExport(
  deps: DataExportDeps,
  params: { exportId: string; teamId: string },
): Promise<DataExportResult> {
  const now = deps.now ?? (() => new Date());
  const request = await beginDataExport(deps.db, {
    id: params.exportId,
    teamId: params.teamId,
  });

  if (!request) {
    return {
      exportId: params.exportId,
      status: "skipped",
      reason: "export request is no longer pending",
    };
  }

  const data = await getWorkspaceExportData(deps.db, params.teamId);
  if (!data) {
    return {
      exportId: params.exportId,
      status: "skipped",
      reason: "workspace no longer exists",
    };
  }

  const createdOn = request.createdAt.slice(0, 10);
  const fileName = `invoicewise-export-${createdOn}-${params.exportId.slice(0, 8)}.zip`;
  const objectPath = dataExportObjectPath(
    params.teamId,
    params.exportId,
    fileName,
  );
  const tempDir = deps.tempDir ?? defaultExportTempDir();
  await mkdir(tempDir, { recursive: true, mode: 0o700 });
  const tempPath = join(tempDir, `${params.exportId}.zip`);

  const writer = await ZipFileWriter.create(tempPath);
  let closed = false;

  try {
    const generatedAt = now();
    const documents = new Map<string, DocumentRecord>();
    const withDocuments = data.invoices.filter(
      (invoice) => invoice.filePath?.length,
    );
    const total = withDocuments.length;
    let written = 0;

    await recordDataExportProgress(deps.db, {
      id: params.exportId,
      teamId: params.teamId,
      documentsWritten: 0,
      documentsTotal: total,
    });

    for (const invoice of data.invoices) {
      if (!invoice.filePath?.length) continue;

      // Only the workspace's own document objects are ever read into its
      // export. A record whose stored path fails that check is listed as
      // withheld, never read.
      const bindingIssue = documentBindingIssue({
        teamId: params.teamId,
        filePath: invoice.filePath,
      });
      if (bindingIssue) {
        documents.set(invoice.id, {
          invoiceId: invoice.id,
          path: null,
          status: "withheld",
          reason: bindingIssue,
          size: null,
          sha256: null,
          contentType: invoice.contentType,
          intakeSha256: invoice.contentHash,
          intakeHashMatches: null,
        });
        written += 1;
        continue;
      }

      let bytes: Uint8Array | null = null;
      try {
        const blob = await deps.storage.download({
          bucket: VAULT_BUCKET,
          path: [...invoice.filePath],
        });
        bytes = new Uint8Array(await blob.arrayBuffer());
      } catch (error) {
        if (!isMissingObject(error)) {
          throw new DataExportError(
            `Unable to read document for invoice ${invoice.id}: ${
              error instanceof Error ? error.message : String(error)
            }`,
            true,
            "A temporary storage problem stopped the export. It will be retried.",
          );
        }
      }

      if (!bytes) {
        documents.set(invoice.id, {
          invoiceId: invoice.id,
          path: null,
          status: "missing",
          size: null,
          sha256: null,
          contentType: invoice.contentType,
          intakeSha256: invoice.contentHash,
          intakeHashMatches: null,
        });
      } else {
        const path = `documents/${invoice.id}/${archiveFileName(
          invoice.fileName,
          invoice.contentType,
        )}`;
        const digest = sha256(bytes);
        await writer.addFile(path, bytes, new Date(invoice.createdAt));
        documents.set(invoice.id, {
          invoiceId: invoice.id,
          path,
          status: "included",
          size: bytes.byteLength,
          sha256: digest,
          contentType: invoice.contentType,
          intakeSha256: invoice.contentHash,
          intakeHashMatches: invoice.contentHash
            ? invoice.contentHash === digest
            : null,
        });
      }

      written += 1;
      if (written % 10 === 0 || written === total) {
        await recordDataExportProgress(deps.db, {
          id: params.exportId,
          teamId: params.teamId,
          documentsWritten: written,
          documentsTotal: total,
        });
      }
    }

    const records = buildExportRecords(data, documents);
    const dataFiles: { path: string; records: number; content: string }[] = [
      { path: "workspace.json", records: 1, content: json(records.workspace) },
      {
        path: "invoices.json",
        records: records.invoices.length,
        content: json(records.invoices),
      },
      {
        path: "judgments.json",
        records: records.judgments.length,
        content: json(records.judgments),
      },
      {
        path: "suppliers.json",
        records: records.suppliers.length,
        content: json(records.suppliers),
      },
      {
        path: "supplier-events.json",
        records: records.supplierEvents.length,
        content: json(records.supplierEvents),
      },
      {
        path: "invoice-corrections.json",
        records: records.corrections.length,
        content: json(records.corrections),
      },
      {
        path: "questions.json",
        records: records.questions.length,
        content: json(records.questions),
      },
      {
        path: "inbound-emails.json",
        records: records.inboundEmails.length,
        content: json(records.inboundEmails),
      },
      {
        path: "audit.json",
        records: records.audit.length,
        content: json(records.audit),
      },
    ];

    for (const file of dataFiles) {
      await writer.addFile(file.path, Buffer.from(file.content), generatedAt);
    }

    const documentList = [...documents.values()];
    const missing = documentList.filter(
      (document) => document.status !== "included",
    );
    const summary: DataExportSummary = {
      invoices: records.invoices.length,
      documents: documentList.length - missing.length,
      missingDocuments: missing.length,
      suppliers: records.suppliers.length,
      judgments: records.judgments.length,
      auditEvents: records.audit.length,
    };

    // One expiry for the manifest and the request: the download route and
    // the retention job enforce exactly what the archive says.
    const expiresAt = new Date(
      now().getTime() + deps.policy.exportLinkHours * 3_600_000,
    );

    const manifest = {
      format: "invoicewise-workspace-export",
      formatVersion: EXPORT_FORMAT_VERSION,
      exportId: params.exportId,
      workspaceId: params.teamId,
      requestedBy: request.requestedBy,
      requestedAt: request.createdAt,
      generatedAt: generatedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      counts: summary,
      identifiers: {
        invoice: "InvoiceWise invoice id (UUID), stable across exports",
        document: "documents/<invoice id>/<file name>, with its SHA-256",
        supplier:
          "InvoiceWise supplier id (UUID) from the workspace's supplier records, stable across exports; a merged supplier names the one it was merged into in mergedIntoId",
        supplierEvent: "InvoiceWise supplier event id (UUID)",
        judgment: "<invoice id>:<question id>",
        inboundEmail:
          "InvoiceWise received-message id (UUID); invoiceIds name the invoices its attachments became",
        auditEvent: "<event type>:<source record id>",
      },
      retentionPolicy: {
        note: "InvoiceWise's current operating policy, changeable by configuration; not a legal promise.",
        ...deps.policy,
      },
      files: dataFiles.map((file) => ({
        path: file.path,
        records: file.records,
        sha256: sha256(file.content),
        size: Buffer.byteLength(file.content),
      })),
      documents: documentList,
    };

    await writer.addFile(
      "manifest.json",
      Buffer.from(json(manifest)),
      generatedAt,
    );
    const archive = await writer.close();
    closed = true;

    // Record the object before it exists, so a failure after the upload
    // still leaves a reference the retention job removes.
    await recordDataExportObject(deps.db, {
      id: params.exportId,
      teamId: params.teamId,
      filePath: objectPath,
      fileName,
    });

    try {
      await deps.storage.uploadFile({
        bucket: VAULT_BUCKET,
        path: objectPath,
        sourcePath: tempPath,
        contentType: "application/zip",
      });
    } catch (error) {
      throw new DataExportError(
        `Unable to store export archive: ${
          error instanceof Error ? error.message : String(error)
        }`,
        true,
        "A temporary storage problem stopped the export. It will be retried.",
      );
    }

    const completed = await completeDataExport(deps.db, {
      id: params.exportId,
      teamId: params.teamId,
      filePath: objectPath,
      fileName,
      size: archive.size,
      sha256: archive.sha256,
      summary,
      expiresAt,
    });

    if (!completed) {
      // The request (or its workspace) went away during the build: the
      // archive must not outlive it.
      await deps.storage
        .remove({ bucket: VAULT_BUCKET, path: objectPath })
        .catch(() => undefined);
      return {
        exportId: params.exportId,
        status: "skipped",
        reason: "export request was removed while it was built",
      };
    }

    return {
      exportId: params.exportId,
      status: "ready",
      size: archive.size,
      sha256: archive.sha256,
      summary,
    };
  } catch (error) {
    if (error instanceof ZipLimitError) {
      throw new DataExportError(
        error.message,
        false,
        `${error.message}. Contact support for a split export.`,
      );
    }
    throw error;
  } finally {
    if (!closed) await writer.abort();
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}
