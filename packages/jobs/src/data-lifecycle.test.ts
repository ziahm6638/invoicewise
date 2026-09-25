import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildExportRecords,
  isDataExportObjectPath,
  removeStaleExportTempFiles,
  supplierId,
  supplierKey,
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

  test("gives suppliers stable ids by VAT number, else normalised name", () => {
    expect(supplierKey({ supplierVatNumber: " gb 123 4567 89 " })).toBe(
      "vat:GB123456789",
    );
    expect(supplierKey({ supplierName: "ACME Ltd." })).toBe("name:acme ltd");
    expect(supplierKey({ supplierName: "acme  LTD" })).toBe("name:acme ltd");
    expect(supplierKey({})).toBeNull();
    expect(supplierId("name:acme ltd")).toBe(supplierId("name:acme ltd"));
    expect(supplierId("name:acme ltd")).toMatch(/^sup_[0-9a-f]{16}$/);
  });

  test("links invoices, judgments, suppliers and audit events by id", () => {
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
          invoice("11111111-1111-4111-8111-111111111111"),
          invoice("22222222-2222-4222-8222-222222222222", {
            accountingProvider: "xero",
            accountingPostStatus: "posted",
            accountingPostedAt: "2026-09-02T10:00:00.000Z",
          }),
        ],
        questions: [],
        members: [],
        mailboxes: [],
        accounting: [],
        endpoints: [],
        deliveries: [],
        jobs: [],
        exports: [],
      },
      new Map(),
    );

    expect(records.suppliers).toHaveLength(1);
    expect(records.suppliers[0]?.invoiceIds).toHaveLength(2);
    expect(
      records.invoices.every(
        (row) => row.supplierId === records.suppliers[0]?.id,
      ),
    ).toBe(true);
    expect(records.judgments.map((row) => row.id)).toEqual([
      "11111111-1111-4111-8111-111111111111:duplicate",
      "11111111-1111-4111-8111-111111111111:known_supplier",
      "22222222-2222-4222-8222-222222222222:duplicate",
      "22222222-2222-4222-8222-222222222222:known_supplier",
    ]);
    expect(records.invoices[0]?.judgmentIds).toEqual([
      "11111111-1111-4111-8111-111111111111:duplicate",
      "11111111-1111-4111-8111-111111111111:known_supplier",
    ]);
    expect(records.audit.map((event) => event.type)).toEqual([
      "invoice.received",
      "invoice.received",
      "invoice.accounting_posted",
    ]);
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
