import { resolve } from "node:path";
import { createDatabaseClient } from "@midday/db/client";
import { createInbox, updateInboxWithProcessedData } from "@midday/db/queries";
import { teams } from "@midday/db/schema";
import { createStorageClientFromEnv } from "@midday/db/storage";
import type { InvoiceExtraction } from "@midday/documents";
import { eq } from "drizzle-orm";
import { processDocumentAttachment } from "./tasks/inbox/process-document";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const priorExtraction: InvoiceExtraction = {
  supplierName: "ACME SUPPLIES LTD",
  supplierVatNumber: "GB123456789",
  invoiceNumber: "INV-2026-0042",
  invoiceDate: "2026-09-01",
  dueDate: "2026-09-30",
  currency: "GBP",
  netAmount: 1000,
  vatAmount: 200,
  grossAmount: 1200,
  lineItems: [
    {
      description: "Consulting services",
      quantity: 2,
      unitPrice: 500,
      total: 1000,
    },
  ],
  bankDetails: {
    accountName: "ACME SUPPLIES LTD",
    accountNumber: "12345678",
    sortCode: "12-34-56",
    iban: "GB12 ACME 1234 5678 9012 34",
    bic: "ACMEGB2L",
  },
  description: "September consulting services",
  purchaseOrderReference: "PO-7788",
};

async function main() {
  const database = createDatabaseClient({
    primaryUrl: required("DATABASE_PRIMARY_URL"),
    isDevelopment: true,
  });
  const storage = createStorageClientFromEnv();
  const fixture = Bun.file(
    resolve(
      process.cwd(),
      "../documents/src/test/fixtures/synthetic-invoice.pdf",
    ),
  );
  const bytes = Buffer.from(await fixture.arrayBuffer());
  let teamId: string | undefined;
  let uploadedPath: string[] | undefined;
  try {
    const [team] = await database.db
      .insert(teams)
      .values({ name: "InvoiceWise Ltd" })
      .returning({ id: teams.id });
    if (!team) throw new Error("Unable to create verification team");
    teamId = team.id;

    const previous = await createInbox(database.db, {
      displayName: "Historical synthetic invoice",
      teamId,
      filePath: [teamId, "inbox", "historical-synthetic-invoice.pdf"],
      fileName: "historical-synthetic-invoice.pdf",
      contentType: "application/pdf",
      size: bytes.length,
      status: "pending",
    });
    if (!previous) throw new Error("Unable to create historical invoice");
    await updateInboxWithProcessedData(database.db, {
      id: previous.id,
      displayName: priorExtraction.supplierName,
      amount: priorExtraction.grossAmount,
      currency: priorExtraction.currency,
      date: priorExtraction.dueDate,
      type: "invoice",
      extraction: priorExtraction,
      judgments: [],
      status: "pending",
    });

    const filePath = [teamId, "inbox", "synthetic-invoice.pdf"];
    uploadedPath = filePath;
    await storage.upload({ bucket: "vault", path: filePath, file: bytes });
    const stored = await storage.download({ bucket: "vault", path: filePath });
    const storedBytes = Buffer.from(await stored.arrayBuffer());
    const current = await createInbox(database.db, {
      displayName: "synthetic-invoice.pdf",
      teamId,
      filePath,
      fileName: "synthetic-invoice.pdf",
      contentType: "application/pdf",
      size: bytes.length,
      status: "processing",
    });
    if (!current) throw new Error("Unable to create current invoice");

    const { record } = await processDocumentAttachment(database.db, {
      inboxId: current.id,
      teamId,
      documentUrl: `data:application/pdf;base64,${storedBytes.toString("base64")}`,
      mimetype: "application/pdf",
      companyName: "InvoiceWise Ltd",
    });

    console.log(
      JSON.stringify(
        {
          id: record?.id,
          filePath: record?.filePath,
          extraction: record?.extraction,
          judgments: record?.judgments,
        },
        null,
        2,
      ),
    );
  } finally {
    if (uploadedPath) {
      await storage.remove({ bucket: "vault", path: uploadedPath });
    }
    if (teamId) await database.db.delete(teams).where(eq(teams.id, teamId));
    await database.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
