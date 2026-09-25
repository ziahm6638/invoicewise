import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildExportRecords,
  exportFailureMessage,
  isDataExportObjectPath,
  removeStaleExportTempFiles,
} from "./data-export";
import { nextRetentionSlot } from "./retention";
import {
  DEFAULT_RETENTION_POLICY,
  describeRetentionPolicy,
  resolveRetentionPolicy,
} from "./retention-policy";
import { ZipFileWriter, readStoredZip } from "./zip";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "invoicewise-lifecycle-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("ZipFileWriter", () => {
  test("writes stored entries that read back byte for byte", async () => {
    const path = join(dir, "archive.zip");
    const writer = await ZipFileWriter.create(path);
    const pdf = Buffer.from("%PDF-1.4 synthetic");
    await writer.addFile("documents/a/invoice.pdf", pdf);
    await writer.addFile("manifest.json", Buffer.from('{"ok":true}'));
    await writer.addFile("documents/b/rechnung-ü.pdf", Buffer.alloc(0));
    const summary = await writer.close();

    const archive = await readFile(path);
    expect(summary.size).toBe(archive.byteLength);
    expect(summary.entries).toBe(3);
    const entries = readStoredZip(archive);
    expect(entries.get("documents/a/invoice.pdf")?.equals(pdf)).toBe(true);
    expect(entries.get("manifest.json")?.toString()).toBe('{"ok":true}');
    expect(entries.get("documents/b/rechnung-ü.pdf")?.byteLength).toBe(0);
  });

  test("produces an archive the system unzip accepts", async () => {
    const unzip = spawnSync("unzip", ["-v"]);
    if (unzip.error) return; // not installed on this machine

    const path = join(dir, "archive.zip");
    const writer = await ZipFileWriter.create(path);
    await writer.addFile("a.txt", Buffer.from("alpha"));
    await writer.addFile("nested/b.txt", Buffer.from("beta"));
    await writer.close();

    const check = spawnSync("unzip", ["-t", path]);
    expect(check.status).toBe(0);
    expect(String(check.stdout)).toContain("No errors detected");
  });

  test("refuses unsafe or duplicate entry names", async () => {
    const writer = await ZipFileWriter.create(join(dir, "archive.zip"));
    await expect(
      writer.addFile("../escape", Buffer.from("")),
    ).rejects.toThrow();
    await expect(
      writer.addFile("/absolute", Buffer.from("")),
    ).rejects.toThrow();
    await writer.addFile("once.txt", Buffer.from(""));
    await expect(writer.addFile("once.txt", Buffer.from(""))).rejects.toThrow();
    await writer.abort();
  });
});

describe("retention policy", () => {
  test("defaults to the documented operating policy", () => {
    expect(resolveRetentionPolicy({})).toEqual({
      failedUploadDays: 30,
      sourceEmailDays: 90,
      jobPayloadDays: 30,
      backupDays: 30,
      exportLinkHours: 24,
    });
  });

  test("is changeable by configuration and rejects invalid values", () => {
    expect(
      resolveRetentionPolicy({ RETENTION_SOURCE_EMAIL_DAYS: "45" })
        .sourceEmailDays,
    ).toBe(45);
    expect(() =>
      resolveRetentionPolicy({ EXPORT_LINK_TTL_HOURS: "0" }),
    ).toThrow("EXPORT_LINK_TTL_HOURS");
    expect(() =>
      resolveRetentionPolicy({ RETENTION_JOB_PAYLOAD_DAYS: "thirty" }),
    ).toThrow("RETENTION_JOB_PAYLOAD_DAYS");
  });

  test("describes every category with its period", () => {
    const entries = describeRetentionPolicy(DEFAULT_RETENTION_POLICY);
    expect(entries.map((entry) => entry.key)).toEqual([
      "active",
      "failed-uploads",
      "source-email",
      "job-payloads",
      "logs",
      "backups",
      "exports",
    ]);
    expect(entries.find((entry) => entry.key === "exports")?.period).toBe(
      "24 hours",
    );
  });

  test("schedules the next run on the next hour", () => {
    expect(
      nextRetentionSlot(new Date("2026-09-25T10:17:03Z")).toISOString(),
    ).toBe("2026-09-25T11:00:00.000Z");
    expect(
      nextRetentionSlot(new Date("2026-09-25T23:00:00Z")).toISOString(),
    ).toBe("2026-09-26T00:00:00.000Z");
  });
});

describe("export records", () => {
  const teamId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const exportId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

  test("only accepts the export's own archive path", () => {
    expect(
      isDataExportObjectPath(
        [teamId, "exports", exportId, "x.zip"],
        teamId,
        exportId,
      ),
    ).toBe(true);
    for (const path of [
      [teamId, "inbox", exportId, "x.zip"],
      ["cccccccc-cccc-4ccc-8ccc-cccccccccccc", "exports", exportId, "x.zip"],
      [teamId, "exports", "other", "x.zip"],
      [teamId, "exports", exportId],
      [teamId, "exports", exportId, ".."],
      null,
    ]) {
      expect(isDataExportObjectPath(path, teamId, exportId)).toBe(false);
    }
  });

  test("links invoices, judgments, suppliers and audit events by id", () => {
    const acme = "33333333-3333-4333-8333-333333333333";
    const bolt = "44444444-4444-4444-8444-444444444444";
    const firstId = "11111111-1111-4111-8111-111111111111";
    const secondId = "22222222-2222-4222-8222-222222222222";
    const invoice = (id: string, extra: Record<string, unknown> = {}) => ({
      id,
      createdAt: "2026-09-01T10:00:00.000Z",
      fileName: "invoice.pdf",
      filePath: [teamId, "inbox", id, "file.pdf"],
      contentType: "application/pdf",
      size: 10,
      contentHash: "hash",
      displayName: "Invoice",
      status: "done" as const,
      type: "invoice" as const,
      amount: 12,
      currency: "GBP",
      taxAmount: 2,
      taxRate: 20,
      taxType: "vat",
      date: "2026-09-01",
      description: null,
      website: null,
      extraction: { supplierName: "Acme Ltd" },
      judgments: [
        { questionId: "duplicate", answer: "no" },
        { questionId: "known_supplier", answer: "yes" },
      ],
      processingError: null,
      intakeState: "accepted" as const,
      referenceId: null,
      inboxAccountId: null,
      accountingProvider: null,
      accountingPostStatus: null,
      accountingProviderId: null,
      accountingPostError: null,
      accountingPostedAt: null,
      supplierId: acme,
      supplierResolution: { status: "resolved", method: "name" },
      supplierChecks: { version: 1 },
      extractionOriginal: null,
      ...extra,
    });

    const records = buildExportRecords(
      {
        team: {
          id: teamId,
          name: "Workspace",
          email: null,
          baseCurrency: "GBP",
          countryCode: "GB",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        invoices: [
          invoice(firstId),
          // Extracted as Acme, reassigned to Bolt by a member.
          invoice(secondId, {
            supplierId: bolt,
            supplierResolution: { status: "manual", method: "manual" },
            accountingProvider: "xero",
            accountingPostStatus: "posted",
            accountingPostedAt: "2026-09-02T10:00:00.000Z",
            // Corrected after it was posted; the reading is kept.
            extractionOriginal: { grossAmount: 150 },
          }),
        ],
        suppliers: [acme, bolt].map((id, index) => ({
          id,
          name: index ? "Bolt Electrical" : "Acme Ltd",
          nameKey: index ? "bolt electrical" : "acme",
          vatKey: null,
          companyKey: null,
          mergedIntoId: null,
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:00:00.000Z",
        })),
        supplierEvents: [
          {
            id: "55555555-5555-4555-8555-555555555555",
            action: "assign_invoice",
            supplierId: acme,
            targetSupplierId: bolt,
            inboxId: secondId,
            actorId: null,
            data: { previousSupplierId: acme },
            revertsEventId: null,
            revertedAt: null,
            createdAt: "2026-09-03T10:00:00.000Z",
          },
        ],
        corrections: [
          {
            id: "77777777-7777-4777-8777-777777777777",
            invoiceId: secondId,
            version: 1,
            baseRevision: 1,
            revision: 2,
            actorId: null,
            reason: "Gross read from the balance-due line",
            changes: [{ field: "grossAmount", from: 150, to: 120 }],
            accountingOutcome: "keep_bill",
            provider: "xero",
            providerId: "xero-bill-1",
            updateStatus: null,
            updateError: null,
            updatedAt: null,
            createdAt: "2026-09-05T10:00:00.000Z",
          },
        ],
        redeliveries: [
          {
            id: "66666666-6666-4666-8666-666666666666",
            inboxId: firstId,
            referenceId: "msg-2_0_invoice.pdf",
            inboxAccountId: null,
            fileName: "invoice.pdf",
            receivedAt: "2026-09-04T10:00:00.000Z",
          },
        ],
        questions: [],
        questionRuns: [],
        questionAnswers: [],
        deliveryPolicies: [],
        deliveryDecisions: [],
        members: [],
        mailboxes: [],
        accounting: [],
        endpoints: [],
        deliveries: [],
        jobs: [],
        exports: [],
        inboundEmails: [
          {
            id: "77777777-7777-4777-8777-777777777777",
            createdAt: "2026-09-01T09:59:00.000Z",
            recipient: "abc@in.invoicewise.uk",
            envelopeFrom: "bounce@acme.example",
            headerFrom: "Acme Ltd <billing@acme.example>",
            subject: "Invoice 42",
            status: "processed" as const,
            detail: null,
            deliveryCount: 2,
            processedAt: "2026-09-01T10:00:00.000Z",
            attachments: [
              {
                index: 0,
                fileName: "invoice.pdf",
                contentType: "application/pdf",
                size: 10,
                sha256: "hash",
                outcome: "accepted" as const,
                inboxId: firstId,
              },
              {
                index: 1,
                fileName: "logo.png",
                contentType: "image/png",
                size: 5,
                sha256: null,
                outcome: "skipped" as const,
                code: "small_image",
              },
            ],
          },
        ],
      },
      new Map(),
    );

    expect(records.inboundEmails).toEqual([
      expect.objectContaining({
        id: "77777777-7777-4777-8777-777777777777",
        receivedAt: "2026-09-01T09:59:00.000Z",
        recipient: "abc@in.invoicewise.uk",
        sender: "Acme Ltd <billing@acme.example>",
        envelopeSender: "bounce@acme.example",
        subject: "Invoice 42",
        status: "processed",
        invoiceIds: [firstId],
      }),
    ]);
    expect(records.inboundEmails[0]).not.toHaveProperty("raw");

    // Suppliers are the workspace's own records, grouped by assignment, not
    // by what the extraction says.
    expect(records.suppliers.map((row) => [row.id, row.invoiceIds])).toEqual([
      [acme, [firstId]],
      [bolt, [secondId]],
    ]);
    expect(records.invoices.map((row) => row.supplierId)).toEqual([acme, bolt]);
    expect(records.invoices[1]?.supplierResolution).toMatchObject({
      status: "manual",
    });
    expect(records.invoices[0]?.source.redeliveries).toMatchObject([
      { messageReference: "msg-2_0_invoice.pdf" },
    ]);
    expect(records.invoices[1]?.source.redeliveries).toEqual([]);
    expect(records.supplierEvents).toHaveLength(1);
    // Corrections keep who changed what and why, and the reading they
    // replaced stays on the invoice.
    expect(records.corrections).toMatchObject([
      {
        invoiceId: secondId,
        version: 1,
        reason: "Gross read from the balance-due line",
        changes: [{ field: "grossAmount", from: 150, to: 120 }],
        providerId: "xero-bill-1",
      },
    ]);
    expect(records.invoices[1]?.extractionOriginal).toEqual({
      grossAmount: 150,
    });
    expect(records.invoices[0]?.extractionOriginal).toBeNull();
    expect(records.judgments.map((row) => row.id)).toEqual([
      `${firstId}:duplicate`,
      `${firstId}:known_supplier`,
      `${secondId}:duplicate`,
      `${secondId}:known_supplier`,
    ]);
    expect(records.invoices[0]?.judgmentIds).toEqual([
      `${firstId}:duplicate`,
      `${firstId}:known_supplier`,
    ]);
    expect(records.audit.map((event) => event.type)).toEqual([
      "invoice.received",
      "invoice.received",
      "invoice.accounting_posted",
      "supplier.assign_invoice",
      "invoice.corrected",
    ]);
    expect(records.audit.at(-2)).toMatchObject({
      subject: { kind: "invoice", id: secondId },
      detail: { supplierId: acme, targetSupplierId: bolt },
    });
    expect(records.audit.at(-1)).toMatchObject({
      id: "invoice.corrected:77777777-7777-4777-8777-777777777777",
      subject: { kind: "invoice", id: secondId },
      detail: { version: 1, accountingOutcome: "keep_bill" },
    });
  });
});

test("removes only stale build files", async () => {
  const stale = join(dir, "stale.zip");
  const fresh = join(dir, "fresh.zip");
  const other = join(dir, "notes.txt");
  await writeFile(stale, "x");
  await writeFile(fresh, "x");
  await writeFile(other, "x");
  const old = new Date(Date.now() - 7 * 3_600_000);
  await utimes(stale, old, old);
  await utimes(other, old, old);

  const removed = await removeStaleExportTempFiles(dir, 6 * 3_600_000);
  expect(removed).toEqual(["stale.zip"]);
});

describe("exportFailureMessage", () => {
  const temporary =
    "A temporary storage problem stopped the export. It will be retried.";

  test("promises a retry only while one is still coming", () => {
    expect(
      exportFailureMessage({
        userMessage: temporary,
        retryable: true,
        final: false,
      }),
    ).toBe(temporary);
    // Retries exhausted: the owner must request a new export.
    expect(
      exportFailureMessage({
        userMessage: temporary,
        retryable: true,
        final: true,
      }),
    ).toBe("The export could not be prepared. Request a new export.");
  });

  test("keeps a permanent failure's own message", () => {
    expect(
      exportFailureMessage({
        userMessage: "The workspace no longer exists.",
        retryable: false,
        final: true,
      }),
    ).toBe("The workspace no longer exists.");
  });
});
