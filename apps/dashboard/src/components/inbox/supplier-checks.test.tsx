import { describe, expect, test } from "bun:test";
import { checkSupplierHistory } from "@invoicewise/documents";
import { renderToStaticMarkup } from "react-dom/server";
import { SupplierChecksView } from "./supplier-checks";

const invoice = (value: Record<string, unknown>) => ({
  documentType: "invoice",
  supplierName: "Northgate Scaffolding Ltd",
  supplierVatNumber: "GB314159283",
  invoiceNumber: "NS-20931",
  invoiceDate: "2026-09-08",
  currency: "GBP",
  grossAmount: 2400,
  ...value,
});

const earlier = {
  id: "2b5f0a36-0c63-4b4e-9d57-0e3e6a1f2f10",
  receivedAt: "2026-08-02T09:00:00.000Z",
  extraction: invoice({
    invoiceNumber: "NS-20100",
    bankDetails: { sortCode: "40-11-22", accountNumber: "10203040" },
  }),
};

const checks = checkSupplierHistory({
  extraction: invoice({
    bankDetails: { sortCode: "60-16-13", accountNumber: "31926819" },
  }),
  supplier: {
    status: "matched",
    supplierId: "0d6a2b5c-7f0e-4d1e-8a3b-5c2f9e1d4a77",
    name: "Northgate Scaffolding Ltd",
    method: "vat_number",
    message: "Matched by VAT number.",
  },
  history: [earlier],
  earlierInvoices: 1,
  firstInvoice: earlier,
  now: new Date("2026-09-09T00:00:00.000Z"),
});

describe("supplier checks view", () => {
  test("shows each result with the earlier documents it cites, bank details masked", () => {
    const html = renderToStaticMarkup(
      <SupplierChecksView
        checks={checks}
        evidence={[
          {
            id: earlier.id,
            status: "pending",
            receivedAt: earlier.receivedAt,
            documentType: "invoice",
            invoiceNumber: "NS-20100",
            invoiceDate: "2026-08-01",
            currency: "GBP",
            grossAmount: 2400,
          },
        ]}
        redeliveries={[
          {
            id: "r1",
            fileName: "northgate.pdf",
            receivedAt: "2026-09-10T08:00:00.000Z",
            inboxAccountId: null,
            referenceId: "gmail-1",
          },
        ]}
      />,
    );
    expect(html).toContain("Northgate Scaffolding Ltd");
    expect(html).toContain("Matched by VAT number");
    expect(html).toContain("Known supplier");
    expect(html).toContain("Changed");
    expect(html).toContain("Invoice NS-20100");
    expect(html).toContain("Most recent bank details");
    expect(html).toContain("ending 6819");
    expect(html).toContain("Received again");
    expect(html).toContain("Supplier checks v1");
    expect(html).not.toContain("31926819");
    expect(html).not.toContain("10203040");
  });

  test("an invoice processed before supplier checks existed says so", () => {
    expect(
      renderToStaticMarkup(<SupplierChecksView checks={null} />),
    ).toContain("have not run");
  });
});
