/**
 * The reviewed validation corpus: synthetic supplier documents, each with the
 * values a correct reading gives and the validation outcome those values
 * must produce. `generate-corpus.ts` renders every entry into a text-layer
 * PDF in this directory; `corpus.test.ts` reads the PDFs through the real
 * pipeline and scores them against `thresholds.json`.
 *
 * Every figure below was worked by hand. The documents are invented; names,
 * VAT numbers (with valid HMRC check digits), company numbers and bank
 * details are synthetic. `docs/document-intake.md#validation-corpus` lists
 * what each one proves.
 */
import type {
  InvoiceExtraction,
  InvoiceLineItem,
} from "../../typesafe/invoice";
import type {
  CheckOutcome,
  InvoiceValidation,
  ValidationCheckId,
} from "../../validation";

type Row = { description: string[]; cells: string[] };

export type CorpusLayout = {
  title: string;
  supplier: string[];
  meta: [string, string][];
  billTo: string[];
  /** Table header labels; the first is the description column. */
  columns: string[];
  rows: Row[];
  totals: [string, string][];
  notes: string[];
  footer?: string;
};

/** Extraction fields scored per document (evidence and text source aside). */
export type ScoredFields = Omit<
  InvoiceExtraction,
  "evidence" | "textSource" | "pageSources" | "lineItems" | "bankDetails"
> &
  InvoiceExtraction["bankDetails"];

export type CorpusDocument = {
  name: string;
  /** What the document is for, as reviewed. */
  purpose: string;
  layout: CorpusLayout;
  /** What a correct model selects, by TypeSafe question id. */
  selections: Record<string, string | number>;
  expected: {
    fields: ScoredFields;
    lineItems: InvoiceLineItem[];
  };
  validation: {
    status: InvoiceValidation["status"];
    taxBasis: InvoiceValidation["taxBasis"];
    checks: Record<ValidationCheckId, CheckOutcome>;
    /** Issue codes, in order. */
    issues: string[];
    accountingReady: boolean;
    /** Blocker codes, in order. */
    blockers: string[];
  };
  /** Earlier documents in the workspace (by corpus name) the entry is validated against. */
  history?: string[];
  /** With history: the corpus document it duplicates or credits. */
  duplicateOf?: string;
  creditsInvoice?: string;
};

const line = (description: string | string[], ...cells: string[]): Row => ({
  description: Array.isArray(description) ? description : [description],
  cells,
});

const item = (
  value: Partial<InvoiceLineItem> &
    Pick<InvoiceLineItem, "description" | "total">,
): InvoiceLineItem => ({
  quantity: null,
  unitPrice: null,
  discountAmount: null,
  discountRate: null,
  taxRate: null,
  taxAmount: null,
  ...value,
});

const NONE: ScoredFields = {
  documentType: null,
  supplierName: null,
  supplierAddress: null,
  supplierVatNumber: null,
  supplierCompanyNumber: null,
  invoiceNumber: null,
  originalInvoiceNumber: null,
  invoiceDate: null,
  dueDate: null,
  currency: null,
  netAmount: null,
  discountAmount: null,
  vatAmount: null,
  taxRate: null,
  grossAmount: null,
  amountsIncludeTax: null,
  description: null,
  purchaseOrderReference: null,
  paymentReference: null,
  accountName: null,
  accountNumber: null,
  sortCode: null,
  iban: null,
  bic: null,
};

const ALL_PASS: Record<ValidationCheckId, CheckOutcome> = {
  currency: "pass",
  line_arithmetic: "pass",
  line_totals: "pass",
  tax: "pass",
  gross: "pass",
};

const BILL_TO = ["InvoiceWise Ltd", "22 Queen Street", "Manchester", "M2 4LQ"];

export const CORPUS: CorpusDocument[] = [
  {
    name: "normal-invoice",
    purpose:
      "An ordinary VAT invoice: a ruled table with a wrapped description, one 20% rate, company number, payment reference and full bank details. Deliverable.",
    layout: {
      title: "INVOICE",
      supplier: [
        "Harbour Lane Plumbing Ltd",
        "12 Harbour Lane",
        "Bristol",
        "BS1 4RN",
        "VAT No: GB 481 5162 49",
      ],
      meta: [
        ["Invoice No:", "HLP-3101"],
        ["Invoice Date:", "3 September 2026"],
        ["Due Date:", "03/10/2026"],
        ["Your Order:", "PO-88120"],
      ],
      billTo: BILL_TO,
      columns: ["Description", "Qty", "Unit Price", "VAT", "Amount"],
      rows: [
        line(
          "Boiler service and safety check",
          "1",
          "£180.00",
          "20%",
          "£180.00",
        ),
        line(
          [
            "Replace kitchen mixer tap including",
            "isolation valves and flexible hoses",
          ],
          "2",
          "£245.00",
          "20%",
          "£490.00",
        ),
        line("Radiator power flush", "4", "£145.00", "20%", "£580.00"),
      ],
      totals: [
        ["Subtotal", "£1,250.00"],
        ["VAT @ 20%", "£250.00"],
        ["Total Due", "£1,500.00"],
      ],
      notes: [
        "Payment Details",
        "Account Name:  Harbour Lane Plumbing Ltd",
        "Sort Code:  20-45-77",
        "Account Number:  33445566",
        "Please quote reference:  HLP3101",
      ],
      footer:
        "Harbour Lane Plumbing Ltd. Registered in England and Wales No. 09876543.",
    },
    selections: {
      document_type: "invoice",
      supplier_name: "Harbour Lane Plumbing Ltd",
      supplier_address: "12 Harbour Lane, Bristol, BS1 4RN",
      supplier_vat_number: "GB481516249",
      supplier_company_number: "09876543",
      invoice_number: "HLP-3101",
      invoice_date: "3 September 2026",
      due_date: "03/10/2026",
      currency: "GBP",
      net_amount: 1250,
      vat_amount: 250,
      tax_rate: 20,
      gross_amount: 1500,
      bank_account_name: "Harbour Lane Plumbing Ltd",
      bank_account_number: "33445566",
      bank_sort_code: "20-45-77",
      purchase_order_reference: "PO-88120",
      payment_reference: "HLP3101",
    },
    expected: {
      fields: {
        ...NONE,
        documentType: "invoice",
        supplierName: "Harbour Lane Plumbing Ltd",
        supplierAddress: "12 Harbour Lane, Bristol, BS1 4RN",
        supplierVatNumber: "GB481516249",
        supplierCompanyNumber: "09876543",
        invoiceNumber: "HLP-3101",
        invoiceDate: "2026-09-03",
        dueDate: "2026-10-03",
        currency: "GBP",
        netAmount: 1250,
        vatAmount: 250,
        taxRate: 20,
        grossAmount: 1500,
        purchaseOrderReference: "PO-88120",
        paymentReference: "HLP3101",
        accountName: "Harbour Lane Plumbing Ltd",
        accountNumber: "33445566",
        sortCode: "20-45-77",
      },
      lineItems: [
        item({
          description: "Boiler service and safety check",
          quantity: 1,
          unitPrice: 180,
          taxRate: 20,
          total: 180,
        }),
        item({
          description:
            "Replace kitchen mixer tap including isolation valves and flexible hoses",
          quantity: 2,
          unitPrice: 245,
          taxRate: 20,
          total: 490,
        }),
        item({
          description: "Radiator power flush",
          quantity: 4,
          unitPrice: 145,
          taxRate: 20,
          total: 580,
        }),
      ],
    },
    validation: {
      status: "valid",
      taxBasis: "exclusive",
      checks: ALL_PASS,
      issues: [],
      accountingReady: true,
      blockers: [],
    },
  },
  {
    name: "tax-inclusive-invoice",
    purpose:
      "A retail-style tax invoice whose prices include VAT: the lines add up to the gross total and the VAT is the inclusive fraction. Deliverable.",
    layout: {
      title: "TAX INVOICE",
      supplier: [
        "Riverside Office Supplies Ltd",
        "4 Wharf Street",
        "Nottingham",
        "NG1 7EH",
        "VAT Reg No: GB 738 2019 38",
      ],
      meta: [
        ["Invoice No:", "ROS-55821"],
        ["Date:", "12/09/2026"],
      ],
      billTo: BILL_TO,
      columns: ["Description", "Qty", "Price inc VAT", "Total inc VAT"],
      rows: [
        line("Ergonomic office chair", "2", "£144.00", "£288.00"),
        line("A4 copier paper, 5 reams", "6", "£21.00", "£126.00"),
        line("Desk lamp", "1", "£36.00", "£36.00"),
      ],
      totals: [
        ["Total excluding VAT", "£375.00"],
        ["VAT @ 20% (included)", "£75.00"],
        ["Total (inc VAT)", "£450.00"],
      ],
      notes: ["All prices include VAT.", "Paid by card - thank you."],
    },
    selections: {
      document_type: "invoice",
      supplier_name: "Riverside Office Supplies Ltd",
      supplier_address: "4 Wharf Street, Nottingham, NG1 7EH",
      supplier_vat_number: "GB738201938",
      invoice_number: "ROS-55821",
      invoice_date: "12/09/2026",
      currency: "GBP",
      net_amount: 375,
      vat_amount: 75,
      tax_rate: 20,
      gross_amount: 450,
    },
    expected: {
      fields: {
        ...NONE,
        documentType: "invoice",
        supplierName: "Riverside Office Supplies Ltd",
        supplierAddress: "4 Wharf Street, Nottingham, NG1 7EH",
        supplierVatNumber: "GB738201938",
        invoiceNumber: "ROS-55821",
        invoiceDate: "2026-09-12",
        currency: "GBP",
        netAmount: 375,
        vatAmount: 75,
        taxRate: 20,
        grossAmount: 450,
        amountsIncludeTax: true,
      },
      lineItems: [
        item({
          description: "Ergonomic office chair",
          quantity: 2,
          unitPrice: 144,
          total: 288,
        }),
        item({
          description: "A4 copier paper, 5 reams",
          quantity: 6,
          unitPrice: 21,
          total: 126,
        }),
        item({
          description: "Desk lamp",
          quantity: 1,
          unitPrice: 36,
          total: 36,
        }),
      ],
    },
    validation: {
      status: "valid",
      taxBasis: "inclusive",
      checks: ALL_PASS,
      issues: [],
      accountingReady: true,
      blockers: [],
    },
  },
  {
    name: "multi-rate-invoice",
    purpose:
      "Standard (20%), reduced (5%) and zero (0%) rated lines in one table with a VAT summary per rate: tax is recomputed per rate. Deliverable.",
    layout: {
      title: "INVOICE",
      supplier: [
        "Greenfield Catering Supplies Ltd",
        "Unit 9, Hilltop Park",
        "Sheffield",
        "S9 1XU",
        "VAT No: GB 556 6778 85",
      ],
      meta: [
        ["Invoice No:", "GCS-7710"],
        ["Invoice Date:", "15 Sep 2026"],
        ["Due Date:", "15 Oct 2026"],
      ],
      billTo: BILL_TO,
      columns: ["Description", "Qty", "Unit Price", "VAT %", "Net"],
      rows: [
        line("Catering equipment hire", "1", "£320.00", "20%", "£320.00"),
        line("Hot buffet service", "40", "£8.50", "20%", "£340.00"),
        line("Cold platters (zero-rated food)", "40", "£6.25", "0%", "£250.00"),
        line("Children's car seats", "2", "£45.00", "5%", "£90.00"),
      ],
      totals: [
        ["Net Total", "£1,000.00"],
        ["VAT @ 20% on £660.00", "£132.00"],
        ["VAT @ 5% on £90.00", "£4.50"],
        ["VAT @ 0% on £250.00", "£0.00"],
        ["Total VAT", "£136.50"],
        ["Invoice Total", "£1,136.50"],
      ],
      notes: [
        "Account Name:  Greenfield Catering Supplies Ltd",
        "Sort Code:  30-12-44",
        "Account Number:  71829304",
      ],
    },
    selections: {
      document_type: "invoice",
      supplier_name: "Greenfield Catering Supplies Ltd",
      supplier_address: "Unit 9, Hilltop Park, Sheffield, S9 1XU",
      supplier_vat_number: "GB556677885",
      invoice_number: "GCS-7710",
      invoice_date: "15 Sep 2026",
      due_date: "15 Oct 2026",
      currency: "GBP",
      net_amount: 1000,
      vat_amount: 136.5,
      gross_amount: 1136.5,
      bank_account_name: "Greenfield Catering Supplies Ltd",
      bank_account_number: "71829304",
      bank_sort_code: "30-12-44",
    },
    expected: {
      fields: {
        ...NONE,
        documentType: "invoice",
        supplierName: "Greenfield Catering Supplies Ltd",
        supplierAddress: "Unit 9, Hilltop Park, Sheffield, S9 1XU",
        supplierVatNumber: "GB556677885",
        invoiceNumber: "GCS-7710",
        invoiceDate: "2026-09-15",
        dueDate: "2026-10-15",
        currency: "GBP",
        netAmount: 1000,
        vatAmount: 136.5,
        grossAmount: 1136.5,
        accountName: "Greenfield Catering Supplies Ltd",
        accountNumber: "71829304",
        sortCode: "30-12-44",
      },
      lineItems: [
        item({
          description: "Catering equipment hire",
          quantity: 1,
          unitPrice: 320,
          taxRate: 20,
          total: 320,
        }),
        item({
          description: "Hot buffet service",
          quantity: 40,
          unitPrice: 8.5,
          taxRate: 20,
          total: 340,
        }),
        item({
          description: "Cold platters (zero-rated food)",
          quantity: 40,
          unitPrice: 6.25,
          taxRate: 0,
          total: 250,
        }),
        item({
          description: "Children's car seats",
          quantity: 2,
          unitPrice: 45,
          taxRate: 5,
          total: 90,
        }),
      ],
    },
    validation: {
      status: "valid",
      taxBasis: "exclusive",
      checks: ALL_PASS,
      issues: [],
      accountingReady: true,
      blockers: [],
    },
  },
  {
    name: "credit-note",
    purpose:
      "A credit note printed with negative amounts that names the invoice it credits. Valid, linked to the original when that invoice is in the workspace, and not deliverable: draft bills cannot represent credits.",
    layout: {
      title: "CREDIT NOTE",
      supplier: [
        "Harbour Lane Plumbing Ltd",
        "12 Harbour Lane",
        "Bristol",
        "BS1 4RN",
        "VAT No: GB 481 5162 49",
      ],
      meta: [
        ["Credit Note No:", "CN-0042"],
        ["Date:", "20 September 2026"],
        ["Original Invoice:", "HLP-3101"],
      ],
      billTo: BILL_TO,
      columns: ["Description", "Qty", "Unit Price", "VAT", "Amount"],
      rows: [
        line(
          ["Radiator power flush - one radiator", "not treated, credited"],
          "-1",
          "£145.00",
          "20%",
          "-£145.00",
        ),
      ],
      totals: [
        ["Subtotal", "-£145.00"],
        ["VAT @ 20%", "-£29.00"],
        ["Total Credit", "-£174.00"],
      ],
      notes: ["This credit will be refunded to your account within 14 days."],
      footer:
        "Harbour Lane Plumbing Ltd. Registered in England and Wales No. 09876543.",
    },
    selections: {
      document_type: "credit_note",
      supplier_name: "Harbour Lane Plumbing Ltd",
      supplier_address: "12 Harbour Lane, Bristol, BS1 4RN",
      supplier_vat_number: "GB481516249",
      supplier_company_number: "09876543",
      invoice_number: "CN-0042",
      original_invoice_number: "HLP-3101",
      invoice_date: "20 September 2026",
      currency: "GBP",
      net_amount: -145,
      vat_amount: -29,
      tax_rate: 20,
      gross_amount: -174,
    },
    expected: {
      fields: {
        ...NONE,
        documentType: "credit_note",
        supplierName: "Harbour Lane Plumbing Ltd",
        supplierAddress: "12 Harbour Lane, Bristol, BS1 4RN",
        supplierVatNumber: "GB481516249",
        supplierCompanyNumber: "09876543",
        invoiceNumber: "CN-0042",
        originalInvoiceNumber: "HLP-3101",
        invoiceDate: "2026-09-20",
        currency: "GBP",
        netAmount: -145,
        vatAmount: -29,
        taxRate: 20,
        grossAmount: -174,
      },
      lineItems: [
        item({
          description:
            "Radiator power flush - one radiator not treated, credited",
          quantity: -1,
          unitPrice: 145,
          taxRate: 20,
          total: -145,
        }),
      ],
    },
    history: ["normal-invoice"],
    creditsInvoice: "normal-invoice",
    validation: {
      status: "valid",
      taxBasis: "exclusive",
      checks: ALL_PASS,
      issues: [],
      accountingReady: false,
      blockers: ["credit_note_unsupported"],
    },
  },
  {
    name: "inconsistent-total",
    purpose:
      "Lines, net and VAT agree but the printed total is £50 too high: net + VAT = gross fails, so the invoice is invalid and is not delivered.",
    layout: {
      title: "INVOICE",
      supplier: [
        "Northgate Scaffolding Ltd",
        "Yard 3, Northgate",
        "Wakefield",
        "WF1 3AB",
        "VAT Registration No: GB 314 1592 83",
      ],
      meta: [
        ["Invoice Number:", "NS-20931"],
        ["Invoice Date:", "08/09/2026"],
        ["Payment Due:", "08/10/2026"],
      ],
      billTo: BILL_TO,
      columns: ["Description", "Qty", "Rate", "Amount"],
      rows: [
        line(
          "Scaffold erection, two elevations",
          "1",
          "£1,400.00",
          "£1,400.00",
        ),
        line("Weekly hire after first four weeks", "3", "£200.00", "£600.00"),
      ],
      totals: [
        ["Net", "£2,000.00"],
        ["VAT 20%", "£400.00"],
        ["Total", "£2,450.00"],
      ],
      notes: ["Sort Code:  40-22-18", "Account Number:  55120934"],
    },
    selections: {
      document_type: "invoice",
      supplier_name: "Northgate Scaffolding Ltd",
      supplier_address: "Yard 3, Northgate, Wakefield, WF1 3AB",
      supplier_vat_number: "GB314159283",
      invoice_number: "NS-20931",
      invoice_date: "08/09/2026",
      due_date: "08/10/2026",
      currency: "GBP",
      net_amount: 2000,
      vat_amount: 400,
      tax_rate: 20,
      gross_amount: 2450,
      bank_account_number: "55120934",
      bank_sort_code: "40-22-18",
    },
    expected: {
      fields: {
        ...NONE,
        documentType: "invoice",
        supplierName: "Northgate Scaffolding Ltd",
        supplierAddress: "Yard 3, Northgate, Wakefield, WF1 3AB",
        supplierVatNumber: "GB314159283",
        invoiceNumber: "NS-20931",
        invoiceDate: "2026-09-08",
        dueDate: "2026-10-08",
        currency: "GBP",
        netAmount: 2000,
        vatAmount: 400,
        taxRate: 20,
        grossAmount: 2450,
        accountNumber: "55120934",
        sortCode: "40-22-18",
      },
      lineItems: [
        item({
          description: "Scaffold erection, two elevations",
          quantity: 1,
          unitPrice: 1400,
          total: 1400,
        }),
        item({
          description: "Weekly hire after first four weeks",
          quantity: 3,
          unitPrice: 200,
          total: 600,
        }),
      ],
    },
    validation: {
      status: "invalid",
      taxBasis: "exclusive",
      checks: { ...ALL_PASS, gross: "fail" },
      issues: ["gross"],
      accountingReady: false,
      blockers: ["gross"],
    },
  },
  {
    name: "no-vat-sole-trader",
    purpose:
      "A sole trader with no VAT number and no VAT line: tax is not assumed (neither registered nor zero-rated), so it is flagged for review but still deliverable.",
    layout: {
      title: "INVOICE",
      supplier: [
        "J. Patel Garden Services",
        "31 Elm Grove",
        "Leicester",
        "LE2 1TE",
      ],
      meta: [
        ["Invoice No:", "JP-118"],
        ["Date:", "1 September 2026"],
      ],
      billTo: BILL_TO,
      columns: ["Description", "Hours", "Rate", "Total"],
      rows: [
        line("Hedge cutting and clearance", "6", "£25.00", "£150.00"),
        line("Lawn treatment", "1", "£65.00", "£65.00"),
        line("Green waste removal", "1", "£125.00", "£125.00"),
      ],
      totals: [["Total", "£340.00"]],
      notes: [
        "Payment terms: 14 days",
        "Sort Code:  09-01-28",
        "Account Number:  40011872",
      ],
    },
    selections: {
      document_type: "invoice",
      supplier_name: "J. Patel Garden Services",
      supplier_address: "31 Elm Grove, Leicester, LE2 1TE",
      invoice_number: "JP-118",
      invoice_date: "1 September 2026",
      currency: "GBP",
      gross_amount: 340,
      bank_account_number: "40011872",
      bank_sort_code: "09-01-28",
    },
    expected: {
      fields: {
        ...NONE,
        documentType: "invoice",
        supplierName: "J. Patel Garden Services",
        supplierAddress: "31 Elm Grove, Leicester, LE2 1TE",
        invoiceNumber: "JP-118",
        invoiceDate: "2026-09-01",
        dueDate: "2026-09-15",
        currency: "GBP",
        grossAmount: 340,
        accountNumber: "40011872",
        sortCode: "09-01-28",
      },
      lineItems: [
        item({
          description: "Hedge cutting and clearance",
          quantity: 6,
          unitPrice: 25,
          total: 150,
        }),
        item({
          description: "Lawn treatment",
          quantity: 1,
          unitPrice: 65,
          total: 65,
        }),
        item({
          description: "Green waste removal",
          quantity: 1,
          unitPrice: 125,
          total: 125,
        }),
      ],
    },
    validation: {
      status: "needs_review",
      taxBasis: "no_tax",
      checks: { ...ALL_PASS, gross: "unknown" },
      issues: ["tax_not_stated"],
      accountingReady: true,
      blockers: [],
    },
  },
  {
    name: "usd-invoice",
    purpose:
      'A US supplier billing in US dollars with sales tax: the currency comes from the printed ISO code, bare "$" amounts are consistent with it, and nothing is converted. Deliverable.',
    layout: {
      title: "INVOICE",
      supplier: [
        "Brooklyn Design Studio LLC",
        "210 Kent Avenue",
        "Brooklyn, NY 11249",
      ],
      meta: [
        ["Invoice #:", "BDS-2026-091"],
        ["Invoice Date:", "September 10, 2026"],
        ["Due Date:", "October 10, 2026"],
      ],
      billTo: BILL_TO,
      columns: ["Description", "Hours", "Rate", "Amount"],
      rows: [
        line("Brand identity workshop", "8", "$150.00", "$1,200.00"),
        line("Logo and typography system", "20", "$150.00", "$3,000.00"),
      ],
      totals: [
        ["Subtotal", "$4,200.00"],
        ["Sales Tax (8%)", "$336.00"],
        ["Total Due (USD)", "USD 4,536.00"],
      ],
      notes: ["Wire transfer only. Amounts in US dollars (USD)."],
    },
    selections: {
      document_type: "invoice",
      supplier_name: "Brooklyn Design Studio LLC",
      invoice_number: "BDS-2026-091",
      invoice_date: "September 10, 2026",
      due_date: "October 10, 2026",
      currency: "USD",
      net_amount: 4200,
      vat_amount: 336,
      tax_rate: 8,
      gross_amount: 4536,
    },
    expected: {
      fields: {
        ...NONE,
        documentType: "invoice",
        supplierName: "Brooklyn Design Studio LLC",
        invoiceNumber: "BDS-2026-091",
        invoiceDate: "2026-09-10",
        dueDate: "2026-10-10",
        currency: "USD",
        netAmount: 4200,
        vatAmount: 336,
        taxRate: 8,
        grossAmount: 4536,
      },
      lineItems: [
        item({
          description: "Brand identity workshop",
          quantity: 8,
          unitPrice: 150,
          total: 1200,
        }),
        item({
          description: "Logo and typography system",
          quantity: 20,
          unitPrice: 150,
          total: 3000,
        }),
      ],
    },
    validation: {
      status: "valid",
      taxBasis: "exclusive",
      checks: ALL_PASS,
      issues: [],
      accountingReady: true,
      blockers: [],
    },
  },
  {
    name: "missing-currency",
    purpose:
      'Amounts printed only with a bare "$" and no currency code: the currency is not assumed to be US dollars, so the invoice cannot be delivered.',
    layout: {
      title: "INVOICE",
      supplier: [
        "Coastline Web Services Ltd",
        "5 Marine Parade",
        "Brighton",
        "BN2 1TL",
      ],
      meta: [
        ["Invoice No:", "CWS-4410"],
        ["Invoice Date:", "02/09/2026"],
      ],
      billTo: BILL_TO,
      columns: ["Description", "Qty", "Price", "Amount"],
      rows: [
        line("Website hosting, annual plan", "1", "$480.00", "$480.00"),
        line("SSL certificate", "1", "$60.00", "$60.00"),
      ],
      totals: [["Total", "$540.00"]],
      notes: ["Thank you for your business."],
    },
    selections: {
      document_type: "invoice",
      supplier_name: "Coastline Web Services Ltd",
      supplier_address: "5 Marine Parade, Brighton, BN2 1TL",
      invoice_number: "CWS-4410",
      invoice_date: "02/09/2026",
      gross_amount: 540,
    },
    expected: {
      fields: {
        ...NONE,
        documentType: "invoice",
        supplierName: "Coastline Web Services Ltd",
        supplierAddress: "5 Marine Parade, Brighton, BN2 1TL",
        invoiceNumber: "CWS-4410",
        invoiceDate: "2026-09-02",
        grossAmount: 540,
      },
      lineItems: [
        item({
          description: "Website hosting, annual plan",
          quantity: 1,
          unitPrice: 480,
          total: 480,
        }),
        item({
          description: "SSL certificate",
          quantity: 1,
          unitPrice: 60,
          total: 60,
        }),
      ],
    },
    validation: {
      status: "invalid",
      taxBasis: "no_tax",
      checks: { ...ALL_PASS, currency: "unknown", gross: "unknown" },
      issues: ["tax_not_stated", "missing_field"],
      accountingReady: false,
      blockers: ["missing_field"],
    },
  },
  {
    name: "eur-invoice-with-sterling-equivalent",
    purpose:
      "A euro invoice that also prints a sterling equivalent: the totals stay paired with EUR and the GBP figure is neither added in nor used as a rate. Deliverable.",
    layout: {
      title: "INVOICE",
      supplier: [
        "Lyon Textiles SARL",
        "14 Rue de la Soie",
        "69001 Lyon, France",
        "VAT No: FR 40 123456789",
      ],
      meta: [
        ["Invoice No:", "LT-2026-311"],
        ["Invoice Date:", "05/09/2026"],
        ["Due Date:", "05/10/2026"],
      ],
      billTo: BILL_TO,
      columns: ["Description", "Qty", "Unit Price", "Amount"],
      rows: [
        line("Linen fabric, natural, per metre", "120", "€15.00", "€1,800.00"),
        line("Cotton canvas, per metre", "40", "€15.00", "€600.00"),
      ],
      totals: [
        ["Net", "€2,400.00"],
        ["VAT 0% (reverse charge)", "€0.00"],
        ["Total EUR", "€2,400.00"],
      ],
      notes: [
        "Sterling equivalent for information only: £2,040.00",
        "IBAN:  FR76 3000 6000 0112 3456 7890 189",
        "BIC:  AGRIFRPP",
      ],
    },
    selections: {
      document_type: "invoice",
      supplier_name: "Lyon Textiles SARL",
      supplier_vat_number: "FR40123456789",
      invoice_number: "LT-2026-311",
      invoice_date: "05/09/2026",
      due_date: "05/10/2026",
      currency: "EUR",
      net_amount: 2400,
      vat_amount: 0,
      tax_rate: 0,
      gross_amount: 2400,
      bank_iban: "FR76 3000 6000 0112 3456 7890 189",
      bank_bic: "AGRIFRPP",
    },
    expected: {
      fields: {
        ...NONE,
        documentType: "invoice",
        supplierName: "Lyon Textiles SARL",
        supplierVatNumber: "FR40123456789",
        invoiceNumber: "LT-2026-311",
        invoiceDate: "2026-09-05",
        dueDate: "2026-10-05",
        currency: "EUR",
        netAmount: 2400,
        vatAmount: 0,
        taxRate: 0,
        grossAmount: 2400,
        iban: "FR76 3000 6000 0112 3456 7890 189",
        bic: "AGRIFRPP",
      },
      lineItems: [
        item({
          description: "Linen fabric, natural, per metre",
          quantity: 120,
          unitPrice: 15,
          total: 1800,
        }),
        item({
          description: "Cotton canvas, per metre",
          quantity: 40,
          unitPrice: 15,
          total: 600,
        }),
      ],
    },
    validation: {
      status: "valid",
      taxBasis: "exclusive",
      checks: ALL_PASS,
      issues: [],
      accountingReady: true,
      blockers: [],
    },
  },
  {
    name: "discount-invoice",
    purpose:
      "A row discount printed as a percentage and an invoice-level discount before VAT: both are applied before the lines are compared with the net total. Deliverable.",
    layout: {
      title: "INVOICE",
      supplier: [
        "Pennine Print Ltd",
        "2 Mill Yard",
        "Halifax",
        "HX1 5AX",
        "VAT No: GB 271 8281 49",
      ],
      meta: [
        ["Invoice No:", "PP-6620"],
        ["Invoice Date:", "11/09/2026"],
        ["Due Date:", "11/10/2026"],
      ],
      billTo: BILL_TO,
      columns: ["Description", "Qty", "Unit Price", "Disc %", "Net"],
      rows: [
        line("Business cards, 500", "4", "£40.00", "10%", "£144.00"),
        line("Folded leaflets, A5", "2000", "£0.18", "0%", "£360.00"),
      ],
      totals: [
        ["Subtotal", "£504.00"],
        ["Loyalty discount", "-£50.40"],
        ["Net after discount", "£453.60"],
        ["VAT @ 20%", "£90.72"],
        ["Total", "£544.32"],
      ],
      notes: ["Payment terms: 30 days"],
    },
    selections: {
      document_type: "invoice",
      supplier_name: "Pennine Print Ltd",
      supplier_address: "2 Mill Yard, Halifax, HX1 5AX",
      supplier_vat_number: "GB271828149",
      invoice_number: "PP-6620",
      invoice_date: "11/09/2026",
      due_date: "11/10/2026",
      currency: "GBP",
      net_amount: 453.6,
      discount_amount: -50.4,
      vat_amount: 90.72,
      tax_rate: 20,
      gross_amount: 544.32,
    },
    expected: {
      fields: {
        ...NONE,
        documentType: "invoice",
        supplierName: "Pennine Print Ltd",
        supplierAddress: "2 Mill Yard, Halifax, HX1 5AX",
        supplierVatNumber: "GB271828149",
        invoiceNumber: "PP-6620",
        invoiceDate: "2026-09-11",
        dueDate: "2026-10-11",
        currency: "GBP",
        netAmount: 453.6,
        discountAmount: 50.4,
        vatAmount: 90.72,
        taxRate: 20,
        grossAmount: 544.32,
      },
      lineItems: [
        item({
          description: "Business cards, 500",
          quantity: 4,
          unitPrice: 40,
          discountRate: 10,
          total: 144,
        }),
        item({
          description: "Folded leaflets, A5",
          quantity: 2000,
          unitPrice: 0.18,
          discountRate: 0,
          total: 360,
        }),
      ],
    },
    validation: {
      status: "valid",
      taxBasis: "exclusive",
      checks: ALL_PASS,
      issues: [],
      accountingReady: true,
      blockers: [],
    },
  },
  {
    name: "line-rounded-vat",
    purpose:
      "VAT rounded up on each of five lines: the printed VAT (£2.05) is 2p above 20% of the net total (£2.03) yet within the one-penny-per-line tolerance, so it passes; the same 2p on a one-line invoice fails (see validation.test.ts). Deliverable.",
    layout: {
      title: "INVOICE",
      supplier: [
        "Moorland Stationery Ltd",
        "8 Chapel Street",
        "Skipton",
        "BD23 1NS",
        "VAT No: GB 908 1726 23",
      ],
      meta: [
        ["Invoice No:", "MS-0907"],
        ["Invoice Date:", "14/09/2026"],
        ["Due Date:", "14/10/2026"],
      ],
      billTo: BILL_TO,
      columns: ["Description", "Qty", "Unit Price", "VAT %", "Net"],
      rows: [
        line("Ballpoint pens, box", "1", "£2.03", "20%", "£2.03"),
        line("Pencils, HB", "7", "£0.29", "20%", "£2.03"),
        line("Sticky notes", "1", "£2.03", "20%", "£2.03"),
        line("Rubber erasers", "7", "£0.29", "20%", "£2.03"),
        line("Highlighters", "1", "£2.03", "20%", "£2.03"),
      ],
      totals: [
        ["Subtotal", "£10.15"],
        ["VAT (rounded per line)", "£2.05"],
        ["Total", "£12.20"],
      ],
      notes: [],
    },
    selections: {
      document_type: "invoice",
      supplier_name: "Moorland Stationery Ltd",
      supplier_address: "8 Chapel Street, Skipton, BD23 1NS",
      supplier_vat_number: "GB908172623",
      invoice_number: "MS-0907",
      invoice_date: "14/09/2026",
      due_date: "14/10/2026",
      currency: "GBP",
      net_amount: 10.15,
      vat_amount: 2.05,
      gross_amount: 12.2,
    },
    expected: {
      fields: {
        ...NONE,
        documentType: "invoice",
        supplierName: "Moorland Stationery Ltd",
        supplierAddress: "8 Chapel Street, Skipton, BD23 1NS",
        supplierVatNumber: "GB908172623",
        invoiceNumber: "MS-0907",
        invoiceDate: "2026-09-14",
        dueDate: "2026-10-14",
        currency: "GBP",
        netAmount: 10.15,
        vatAmount: 2.05,
        grossAmount: 12.2,
      },
      lineItems: (
        [
          ["Ballpoint pens, box", 1, 2.03],
          ["Pencils, HB", 7, 0.29],
          ["Sticky notes", 1, 2.03],
          ["Rubber erasers", 7, 0.29],
          ["Highlighters", 1, 2.03],
        ] as const
      ).map(([description, quantity, unitPrice]) =>
        item({ description, quantity, unitPrice, taxRate: 20, total: 2.03 }),
      ),
    },
    validation: {
      status: "valid",
      taxBasis: "exclusive",
      checks: ALL_PASS,
      issues: [],
      accountingReady: true,
      blockers: [],
    },
  },
];
