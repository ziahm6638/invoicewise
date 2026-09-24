/**
 * Live proof against a provider sandbox company through self-hosted Nango
 * (docs/accounting-integrations.md, "Sandbox proof"). For a connection made
 * through Connect UI it forces a token refresh, posts a draft bill with the
 * synthetic invoice PDF attached, and replays the same idempotency key to
 * show the provider returns the original bill instead of a second one.
 *
 *   bun run prove:accounting-sandbox <xero|quickbooks> <connection id>
 *
 * Reads NANGO_BASE_URL, NANGO_SECRET_KEY and the integration IDs from the
 * environment. Prints IDs and timestamps only, never credentials.
 */
import { join } from "node:path";
import type { AccountingProvider } from "@invoicewise/db/queries";
import { type DraftBill, postProviderBill } from "./accounting-providers";
import { getNangoConfig, getNangoConnection } from "./nango";

const [provider, connectionId] = process.argv.slice(2);
if ((provider !== "xero" && provider !== "quickbooks") || !connectionId) {
  console.error(
    "usage: prove-accounting-sandbox.ts <xero|quickbooks> <connection id>",
  );
  process.exit(2);
}

async function main(provider: AccountingProvider, connectionId: string) {
  const config = getNangoConfig(provider);
  const before = await getNangoConnection(config, connectionId);
  const refreshed = await getNangoConnection(config, connectionId, {
    refresh: true,
  });

  const stamp = new Date().toISOString();
  const bill: DraftBill = {
    idempotencyKey: `invoicewise:sandbox-proof-${Date.now()}`,
    supplierName: "InvoiceWise Sandbox Supplier Ltd",
    supplierTaxNumber: null,
    invoiceNumber: `IW-PROOF-${Date.now()}`,
    invoiceDate: stamp.slice(0, 10),
    dueDate: null,
    currency: provider === "xero" ? "GBP" : null,
    netAmount: 100,
    vatAmount: 20,
    grossAmount: 120,
    description: "InvoiceWise sandbox proof",
    lineItems: [
      {
        description: "Sandbox proof line",
        quantity: 1,
        unitPrice: 100,
        total: 100,
      },
    ],
  };
  const attachment = {
    fileName: "invoicewise-sandbox-proof.pdf",
    contentType: "application/pdf",
    data: await Bun.file(
      join(__dirname, "../../documents/src/test/fixtures/uk-invoice.pdf"),
    ).arrayBuffer(),
  };

  const connection = { connectionId };
  const posted = await postProviderBill(
    provider,
    config,
    connection,
    bill,
    attachment,
  );
  const replayed = await postProviderBill(
    provider,
    config,
    connection,
    bill,
    null,
  );

  const result = {
    provider,
    connectionId,
    integrationId: config.integrationId,
    organisation:
      provider === "xero"
        ? before.connectionConfig.tenant_id
        : before.connectionConfig.realmId,
    tokenExpiresAt: {
      before: before.tokenExpiresAt,
      after: refreshed.tokenExpiresAt,
    },
    tokenRefreshed: refreshed.tokenExpiresAt !== before.tokenExpiresAt,
    bill: {
      providerId: posted.providerId,
      attached: posted.attached,
      attachmentError: posted.attachmentError,
      replayReturnedSameBill: replayed.providerId === posted.providerId,
    },
  };
  console.log(JSON.stringify(result, null, 2));
  if (
    !result.tokenRefreshed ||
    !posted.attached ||
    !result.bill.replayReturnedSameBill
  ) {
    process.exit(1);
  }
}

main(provider, connectionId).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
