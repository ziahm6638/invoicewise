/**
 * Regenerates the UK invoice regression fixtures:
 *
 *   uk-invoice.pdf          text-layer invoice laid out like a real one
 *                           (two-column header, bill-to block, ruled table,
 *                           totals, payment details, registered-office footer)
 *   uk-invoice-scanned.pdf  the same page rasterised into an image-only PDF,
 *                           so it has no text layer and needs OCR
 *   uk-invoice-footer.pdf   a sole-trader style invoice: no supplier header,
 *                           the business and its address only in a centred
 *                           footer sentence that wraps mid-address, a "TO:"
 *                           customer block, HOURS/RATE columns, "Name" as the
 *                           bank account label and "Payment due on receipt"
 *   uk-invoice-scan.png     uk-invoice.pdf as a flatbed-style greyscale PNG
 *   uk-invoice-photo.jpg    uk-invoice.pdf as a phone photo: JPEG pixels
 *                           stored sideways with EXIF orientation 6
 *   uk-invoice-multipage.pdf
 *                           a two-page text-layer invoice whose line-item
 *                           table continues under a repeated header on page 2,
 *                           with the totals and payment details on page 2
 *   uk-invoice-multipage-mixed.pdf
 *                           the same invoice with page 2 scanned (no text
 *                           layer), so one document needs both text and OCR
 *   non-invoice-letter.pdf  a supplier's change-of-address letter: an
 *                           attachment with readable text but no invoice
 *   malformed-invoice.pdf   uk-invoice.pdf cut off part-way through
 *
 * Run from packages/documents: `bun src/test/fixtures/generate-uk-invoice.ts`.
 * The fixtures are committed; this script documents how they were made.
 * PDF output embeds a creation time, so pass fixture names to regenerate only
 * those files (e.g. `... generate-uk-invoice.ts uk-invoice-scan.png`).
 */
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
// @ts-expect-error: untyped; only used to regenerate the fixtures.
import PDFDocument from "@react-pdf/pdfkit";
import sharp from "sharp";
import { renderPdfPageIsolated } from "../../isolated";

const collect = (doc: InstanceType<typeof PDFDocument>) =>
  new Promise<Buffer>((done) => {
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => done(Buffer.concat(chunks)));
  });

const textInvoice = async () => {
  const doc = new PDFDocument({ size: "A4", margin: 0 });
  const done = collect(doc);
  const regular = "Helvetica";
  const bold = "Helvetica-Bold";

  doc.font(bold).fontSize(16).text("Northwind Joinery Ltd", 50, 50);
  doc.font(regular).fontSize(10);
  doc.text("Unit 4, Riverside Trading Estate", 50, 72);
  doc.text("Leeds", 50, 86);
  doc.text("LS11 5QP", 50, 100);
  doc.text("VAT Reg No: GB 293 4455 12", 50, 114);

  doc.font(bold).fontSize(22).text("INVOICE", 400, 50);
  doc.font(regular).fontSize(10);
  const meta: [string, string][] = [
    ["Invoice No:", "NJ-10457"],
    ["Invoice Date:", "1 September 2026"],
    ["Due Date:", "01-Oct-2026"],
    ["PO Number:", "PO-55120"],
  ];
  meta.forEach(([label, value], index) => {
    doc.text(label, 360, 86 + index * 14);
    doc.text(value, 450, 86 + index * 14);
  });

  doc.font(bold).text("Bill To", 50, 160);
  doc.font(regular);
  ["InvoiceWise Ltd", "22 Queen Street", "Manchester", "M2 4LQ"].forEach(
    (line, index) => doc.text(line, 50, 174 + index * 14),
  );

  const columns = {
    description: 50,
    qty: 300,
    unit: 350,
    vat: 430,
    amount: 480,
  };
  const tableTop = 250;
  doc
    .rect(45, tableTop - 6, 505, 20)
    .fill("#eeeeee")
    .fillColor("#000000");
  doc.font(bold);
  doc.text("Description", columns.description, tableTop);
  doc.text("Qty", columns.qty, tableTop);
  doc.text("Unit Price", columns.unit, tableTop);
  doc.text("VAT", columns.vat, tableTop);
  doc.text("Amount", columns.amount, tableTop);
  doc.font(regular);

  const rows: [string[], string, string, string, string][] = [
    [["Oak skirting board supply and fit"], "12", "£45.00", "20%", "£540.00"],
    [
      ["Kitchen worktop installation including", "sealing and edging"],
      "1",
      "£850.00",
      "20%",
      "£850.00",
    ],
    [["Bespoke shelving unit"], "2", "£325.50", "20%", "£651.00"],
    [["Site waste disposal"], "3", "£40.00", "20%", "£120.00"],
  ];
  let y = tableTop + 24;
  for (const [description, qty, unit, vat, amount] of rows) {
    description.forEach((line, index) =>
      doc.text(line, columns.description, y + index * 13),
    );
    doc.text(qty, columns.qty, y);
    doc.text(unit, columns.unit, y);
    doc.text(vat, columns.vat, y);
    doc.text(amount, columns.amount, y);
    y += description.length * 13 + 10;
    doc
      .moveTo(45, y - 5)
      .lineTo(550, y - 5)
      .strokeColor("#cccccc")
      .stroke();
  }

  y += 10;
  const totals: [string, string][] = [
    ["Subtotal", "£2,161.00"],
    ["VAT @ 20%", "£432.20"],
    ["Total Due", "£2,593.20"],
  ];
  totals.forEach(([label, value], index) => {
    doc.font(index === 2 ? bold : regular);
    doc.text(label, 380, y + index * 16);
    doc.text(value, 480, y + index * 16);
  });

  y += 70;
  doc.font(bold).text("Payment Details", 50, y);
  doc.font(regular);
  const payment: [string, string][] = [
    ["Account Name:", "Northwind Joinery Ltd"],
    ["Sort Code:", "40-11-62"],
    ["Account Number:", "71234598"],
    ["IBAN:", "GB29 NWBK 6016 1331 9268 19"],
    ["BIC:", "NWBKGB2L"],
  ];
  payment.forEach(([label, value], index) => {
    doc.text(label, 50, y + 16 + index * 14);
    doc.text(value, 150, y + 16 + index * 14);
  });
  doc.text("Payment terms: 30 days from the invoice date.", 50, y + 100);

  doc
    .fontSize(8)
    .text(
      "Northwind Joinery Ltd. Registered in England and Wales No. 08123456. Registered office: Unit 4, Riverside Trading Estate, Leeds LS11 5QP",
      50,
      790,
      { width: 500 },
    );

  doc.end();
  return done;
};

const footerInvoice = async () => {
  const doc = new PDFDocument({ size: "A4", margin: 0 });
  const done = collect(doc);
  const regular = "Helvetica";
  const bold = "Helvetica-Bold";

  doc.font(bold).fontSize(24).text("INVOICE", 50, 50);
  doc.font(regular).fontSize(10);
  doc.text("INVOICE NO. BW-2031", 50, 84);
  doc.text("DATE: 31/12/2025", 50, 98);
  doc.font(bold).text("TO:", 50, 130).text("FOR:", 330, 130);
  doc.font(regular);
  doc.text("Harlow Estates Ltd", 50, 144).text("Consultation", 330, 144);
  [
    "Suite 12",
    "48 Market Street",
    "Manchester",
    "M1 1PW",
    "0161 496 0000",
    "accounts@harlowestates.example",
  ].forEach((line, index) => doc.text(line, 50, 158 + index * 14));

  const tableTop = 270;
  doc.font(bold);
  doc.text("DESCRIPTION", 50, tableTop);
  doc.text("HOURS", 330, tableTop);
  doc.text("RATE", 400, tableTop);
  doc.text("AMOUNT", 480, tableTop);
  doc.font(regular);
  doc.text("Consultation – 1 DEC 25 to 31 DEC 25", 50, tableTop + 24);
  doc.text("4", 330, tableTop + 24);
  doc.text("300.00", 400, tableTop + 24);
  doc.text("£1,200.00", 480, tableTop + 24);
  doc
    .font(bold)
    .text("TOTAL", 400, tableTop + 56)
    .text("£1,200.00", 480, tableTop + 56);
  doc.font(regular);
  doc.text("Payment due on receipt", 50, tableTop + 100);
  doc.text("Name Brightwater Advisory Ltd", 50, tableTop + 118);
  doc.text("Sort Code 30-94-57", 50, tableTop + 132);
  doc.text("Account Number 41236789", 50, tableTop + 146);
  doc.text("Thank you for your business!", 0, 560, {
    width: 595,
    align: "center",
  });

  doc.fontSize(8);
  [
    "Brightwater is a trading name for Brightwater Advisory Ltd, registered in England and Wales at 7 Canal Wharf, Wharf Road,",
    "Leeds, LS1 4BR. Company number 12345678. For any queries in relation to this invoice please email us at",
    "hello@brightwater.example for more information.",
  ].forEach((line, index) =>
    doc.text(line, 0, 770 + index * 10, { width: 595, align: "center" }),
  );

  doc.end();
  return done;
};

const renderPage = async (source: Buffer, page: number, dpi = 200) => {
  const rendered = await renderPdfPageIsolated(
    new Uint8Array(source),
    {
      timeoutMs: 30_000,
      maxPages: 2,
      maxPageDimension: 4_000,
      maxTotalPixels: 12_000_000,
      maxChars: 1,
    },
    { page, scale: dpi / 72 },
  );
  if (!rendered.ok) throw new Error(rendered.message);
  return Buffer.from(rendered.result.png);
};

const A4 = { width: 595.28, height: 841.89 };

const scannedInvoice = async (source: Buffer) => {
  const doc = new PDFDocument({ size: "A4", margin: 0 });
  const done = collect(doc);
  doc.image(await renderPage(source, 1), 0, 0, A4);
  doc.end();
  return done;
};

/** A flatbed scan saved as an image: greyscale, slightly off-white paper. */
const scannedPng = async (source: Buffer) =>
  sharp(await renderPage(source, 1))
    .flatten({ background: "#ffffff" })
    .greyscale()
    .linear(0.92, 12)
    .png({ compressionLevel: 9, palette: true, colours: 16 })
    .toBuffer();

/**
 * A phone photo: JPEG pixels stored a quarter-turn anticlockwise with EXIF
 * orientation 6, so a viewer (and the pipeline) must turn it upright.
 */
const phonePhoto = async (source: Buffer) =>
  sharp(await renderPage(source, 1))
    .flatten({ background: "#ffffff" })
    .rotate(270)
    .withMetadata({ orientation: 6 })
    .jpeg({ quality: 82 })
    .toBuffer();

const multipageRows: [string, string, string, string][][] = [
  [
    ["Oak skirting board supply and fit", "12", "£45.00", "£540.00"],
    ["Kitchen worktop installation", "1", "£850.00", "£850.00"],
    ["Bespoke shelving unit", "2", "£325.50", "£651.00"],
    ["Internal door hanging", "6", "£95.00", "£570.00"],
    ["Door ironmongery set", "6", "£38.50", "£231.00"],
    ["Architrave supply and fit", "18", "£12.75", "£229.50"],
    ["Staircase spindle replacement", "24", "£14.20", "£340.80"],
    ["Handrail refinishing", "1", "£180.00", "£180.00"],
    ["Window board replacement", "5", "£42.00", "£210.00"],
    ["Loft hatch installation", "1", "£265.00", "£265.00"],
  ],
  [
    ["Wardrobe carcass assembly", "2", "£410.00", "£820.00"],
    ["Soft-close hinge upgrade", "20", "£6.40", "£128.00"],
    ["Site protection and cleaning", "1", "£150.00", "£150.00"],
    ["Site waste disposal", "3", "£40.00", "£120.00"],
  ],
];

const multipagePage = (doc: InstanceType<typeof PDFDocument>, page: 1 | 2) => {
  const regular = "Helvetica";
  const bold = "Helvetica-Bold";
  let tableTop: number;
  if (page === 1) {
    doc.font(bold).fontSize(16).text("Northwind Joinery Ltd", 50, 50);
    doc.font(regular).fontSize(10);
    doc.text("Unit 4, Riverside Trading Estate", 50, 72);
    doc.text("Leeds", 50, 86);
    doc.text("LS11 5QP", 50, 100);
    doc.text("VAT Reg No: GB 293 4455 12", 50, 114);
    doc.font(bold).fontSize(22).text("INVOICE", 400, 50);
    doc.font(regular).fontSize(10);
    const meta: [string, string][] = [
      ["Invoice No:", "NJ-10458"],
      ["Invoice Date:", "15 September 2026"],
      ["Due Date:", "15-Oct-2026"],
      ["PO Number:", "PO-55187"],
    ];
    meta.forEach(([label, value], index) => {
      doc.text(label, 360, 86 + index * 14);
      doc.text(value, 450, 86 + index * 14);
    });
    doc.font(bold).text("Bill To", 50, 160);
    doc.font(regular);
    ["InvoiceWise Ltd", "22 Queen Street", "Manchester", "M2 4LQ"].forEach(
      (line, index) => doc.text(line, 50, 174 + index * 14),
    );
    tableTop = 250;
  } else {
    doc.font(bold).fontSize(12).text("Northwind Joinery Ltd", 50, 50);
    doc.font(regular).fontSize(10).text("Continued from page 1", 50, 68);
    tableTop = 110;
  }

  const columns = { description: 50, qty: 330, unit: 390, amount: 480 };
  doc
    .rect(45, tableTop - 6, 505, 20)
    .fill("#eeeeee")
    .fillColor("#000000");
  doc.font(bold);
  doc.text("Description", columns.description, tableTop);
  doc.text("Qty", columns.qty, tableTop);
  doc.text("Unit Price", columns.unit, tableTop);
  doc.text("Amount", columns.amount, tableTop);
  doc.font(regular);
  let y = tableTop + 24;
  for (const [description, qty, unit, amount] of multipageRows[page - 1]!) {
    doc.text(description, columns.description, y);
    doc.text(qty, columns.qty, y);
    doc.text(unit, columns.unit, y);
    doc.text(amount, columns.amount, y);
    y += 30;
    doc
      .moveTo(45, y - 12)
      .lineTo(550, y - 12)
      .strokeColor("#cccccc")
      .stroke();
  }

  if (page === 1) {
    doc.text("Continued on page 2", 50, y + 20);
  } else {
    y += 10;
    const totals: [string, string][] = [
      ["Subtotal", "£5,285.30"],
      ["VAT @ 20%", "£1,057.06"],
      ["Total Due", "£6,342.36"],
    ];
    totals.forEach(([label, value], index) => {
      doc.font(index === 2 ? bold : regular);
      doc.text(label, 380, y + index * 16);
      doc.text(value, 480, y + index * 16);
    });
    y += 70;
    doc.font(bold).text("Payment Details", 50, y);
    doc.font(regular);
    const payment: [string, string][] = [
      ["Account Name:", "Northwind Joinery Ltd"],
      ["Sort Code:", "40-11-62"],
      ["Account Number:", "71234598"],
    ];
    payment.forEach(([label, value], index) => {
      doc.text(label, 50, y + 16 + index * 14);
      doc.text(value, 150, y + 16 + index * 14);
    });
  }

  doc.fontSize(8).text(`Page ${page} of 2`, 50, 800);
};

const multipageInvoice = async (page2?: Buffer) => {
  const doc = new PDFDocument({ size: "A4", margin: 0 });
  const done = collect(doc);
  multipagePage(doc, 1);
  doc.addPage({ size: "A4", margin: 0 });
  if (page2) doc.image(page2, 0, 0, A4);
  else multipagePage(doc, 2);
  doc.end();
  return done;
};

const nonInvoiceLetter = async () => {
  const doc = new PDFDocument({ size: "A4", margin: 0 });
  const done = collect(doc);
  doc.font("Helvetica-Bold").fontSize(16).text("Northwind Joinery Ltd", 50, 50);
  doc.font("Helvetica").fontSize(10);
  doc.text("Accounts department", 50, 72);
  doc.text("To our customers", 50, 130);
  doc.font("Helvetica-Bold").text("Notice of change of address", 50, 170);
  doc.font("Helvetica");
  [
    "From next month our workshop moves to a larger site on the same",
    "trading estate. Deliveries, collections and correspondence should use",
    "the new unit number from that date. Our opening hours, telephone",
    "number and email address are not changing, and existing orders will",
    "be completed as planned. Thank you for your continued custom.",
  ].forEach((line, index) => doc.text(line, 50, 200 + index * 14));
  doc.text("Kind regards,", 50, 290);
  doc.text("The Northwind team", 50, 304);
  doc.end();
  return done;
};

const directory = resolve(__dirname);
const requested = new Set(process.argv.slice(2));
const write = async (name: string, make: () => Promise<Buffer>) => {
  if (requested.size > 0 && !requested.has(name)) return;
  await writeFile(resolve(directory, name), await make());
  console.log(`wrote ${name}`);
};

const text = await textInvoice();
const multipage = await multipageInvoice();
await write("uk-invoice.pdf", async () => text);
await write("uk-invoice-scanned.pdf", () => scannedInvoice(text));
await write("uk-invoice-footer.pdf", footerInvoice);
await write("uk-invoice-scan.png", () => scannedPng(text));
await write("uk-invoice-photo.jpg", () => phonePhoto(text));
await write("uk-invoice-multipage.pdf", async () => multipage);
await write("uk-invoice-multipage-mixed.pdf", async () =>
  multipageInvoice(await renderPage(multipage, 2)),
);
await write("non-invoice-letter.pdf", nonInvoiceLetter);
await write("malformed-invoice.pdf", async () =>
  text.subarray(0, Math.floor(text.length * 0.6)),
);
