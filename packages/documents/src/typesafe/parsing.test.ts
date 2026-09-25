import { describe, expect, test } from "bun:test";
import {
  layoutRuns,
  linesFromPlainText,
  runsFromTesseractTsv,
} from "../layout";
import { lineItem } from "../test/oracle";
import {
  accountNumberCandidates,
  addressCandidates,
  dateCandidates,
  ibanCandidates,
  ibanChecksumValid,
  invoiceNumberCandidates,
  parseMoney,
  sortCodeCandidates,
  supplierNameCandidates,
  vatNumberCandidates,
} from "./candidates";
import { parseInvoiceDate } from "./dates";
import { lineItemRows } from "./line-items";

const values = <T>(candidates: { value: T }[]) =>
  candidates.map((candidate) => candidate.value);

describe("layout", () => {
  test("rebuilds rows and column gaps from positioned runs", () => {
    const lines = layoutRuns([
      { x: 360, y: 90, width: 50, height: 10, text: "Invoice No:" },
      { x: 50, y: 91, width: 30, height: 10, text: "Leeds" },
      { x: 450, y: 90, width: 43, height: 10, text: "NJ-10457" },
      { x: 50, y: 104, width: 30, height: 10, text: "LS11" },
      { x: 83, y: 104, width: 20, height: 10, text: "5QP" },
    ]);
    expect(lines.map((line) => line.text)).toEqual([
      "Leeds  Invoice No:  NJ-10457",
      "LS11 5QP",
    ]);
    expect(lines[0]!.segments.map((segment) => segment.x)).toEqual([
      50, 360, 450,
    ]);
  });

  test("reads tesseract word boxes, dropping low-confidence noise", () => {
    const tsv = [
      "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
      "5\t1\t1\t1\t1\t1\t100\t200\t80\t30\t96.1\tSort",
      "5\t1\t1\t1\t1\t2\t190\t200\t80\t30\t95.0\tCode:",
      "5\t1\t2\t1\t1\t1\t600\t201\t160\t30\t93.2\t40-11-62",
      "5\t1\t2\t1\t1\t2\t900\t201\t20\t30\t4.0\t|",
    ].join("\n");
    expect(layoutRuns(runsFromTesseractTsv(tsv))[0]!.text).toBe(
      "Sort Code:  40-11-62",
    );
  });
});

describe("UK dates", () => {
  test.each([
    ["1 September 2026", "2026-09-01"],
    ["01-Sep-2026", "2026-09-01"],
    ["1st Sept 2026", "2026-09-01"],
    ["24 Sep 26", "2026-09-24"],
    ["September 1, 2026", "2026-09-01"],
    ["01/09/2026", "2026-09-01"],
    ["1.9.2026", "2026-09-01"],
    ["2026-09-01", "2026-09-01"],
    // Only month-first can be real here, so it is read that way.
    ["09/24/2026", "2026-09-24"],
    ["31/02/2026", null],
  ])("%s -> %s", (raw, iso) => {
    expect(parseInvoiceDate(raw)).toBe(iso);
  });

  test("finds written and numeric dates in a row", () => {
    const found = dateCandidates(
      linesFromPlainText(
        "Invoice Date:  1 September 2026   Due:  01-Oct-2026\nTax point 15/09/2026",
      ),
    );
    expect(found.map((date) => date.iso)).toEqual([
      "2026-09-01",
      "2026-10-01",
      "2026-09-15",
    ]);
  });
});

describe("candidates", () => {
  test("pairs labels with values beside them, after them, or stacked beneath", () => {
    const lines = linesFromPlainText(
      [
        "Brightside Cleaning Ltd                 Invoice Number",
        "                                        BC-2231",
        "VAT Registration No. GB 123 4567 89",
        "Sort code: 20 45 77      Account no: 1234 5678",
      ].join("\n"),
    );
    expect(values(invoiceNumberCandidates(lines))).toEqual(["BC-2231"]);
    expect(values(vatNumberCandidates(lines))).toEqual(["GB123456789"]);
    expect(values(sortCodeCandidates(lines))).toEqual(["20-45-77"]);
    expect(values(accountNumberCandidates(lines))).toEqual(["12345678"]);
    expect(values(supplierNameCandidates(lines))).toContain(
      "Brightside Cleaning Ltd",
    );
  });

  test("normalises IBANs and checks them", () => {
    const lines = linesFromPlainText("IBAN: gb29nwbk60161331926819");
    expect(values(ibanCandidates(lines))).toEqual([
      "GB29 NWBK 6016 1331 9268 19",
    ]);
    expect(ibanChecksumValid("GB29 NWBK 6016 1331 9268 19")).toBe(true);
    expect(ibanChecksumValid("GB12 ACME 1234 5678 9012 34")).toBe(false);
  });

  test("offers aligned address blocks and labels the customer's", () => {
    const lines = linesFromPlainText(
      [
        "Northwind Joinery Ltd",
        "Unit 4, Riverside Trading Estate",
        "Leeds",
        "LS11 5QP",
        "",
        "Bill To",
        "22 Queen Street",
        "Manchester M2 4LQ",
      ].join("\n"),
    );
    const found = addressCandidates(lines);
    expect(values(found)).toContain(
      "Unit 4, Riverside Trading Estate, Leeds, LS11 5QP",
    );
    expect(
      found.find(
        (candidate) => candidate.value === "22 Queen Street, Manchester M2 4LQ",
      )?.label,
    ).toBe("Bill To");
  });

  test.each([
    ["£1,234.56", 1234.56],
    ["1.234,56 EUR", 1234.56],
    ["(45.00)", -45],
    ["GBP 500", 500],
  ])("parses %s", (raw, value) => {
    expect(parseMoney(raw)).toBe(value);
  });
});

describe("line items", () => {
  test("maps table cells to their header columns and joins wrapped descriptions", () => {
    const rows = lineItemRows(
      linesFromPlainText(
        [
          "Item                         Hours    Rate       VAT     Total",
          "Site survey                  3        £60.00     20%     £180.00",
          "Design work including        10.5     £80.00     20%     £840.00",
          "two revision rounds",
          "Subtotal                                                 £1,020.00",
          "Misc note  1  2  3",
        ].join("\n"),
      ),
    );
    expect(rows.map((row) => row.value)).toEqual([
      lineItem({
        description: "Site survey",
        quantity: 3,
        unitPrice: 60,
        taxRate: 20,
        total: 180,
      }),
      lineItem({
        description: "Design work including two revision rounds",
        quantity: 10.5,
        unitPrice: 80,
        taxRate: 20,
        total: 840,
      }),
    ]);
  });

  test("reads header cells printed close together as separate columns", () => {
    const rows = lineItemRows(
      linesFromPlainText(
        [
          "Description  Qty Unit Price VAT  Net",
          "Boiler service and safety inspection  1  £180.00  20% £180.00",
          "Replacement thermostatic radiator valve 4  £35.00  20% £140.00",
          "Net Total:  £320.00",
        ].join("\n"),
      ),
    );
    expect(rows.map((row) => row.value)).toEqual([
      lineItem({
        description: "Boiler service and safety inspection",
        quantity: 1,
        unitPrice: 180,
        taxRate: 20,
        total: 180,
      }),
      lineItem({
        description: "Replacement thermostatic radiator valve",
        quantity: 4,
        unitPrice: 35,
        taxRate: 20,
        total: 140,
      }),
    ]);
  });

  test("uses arithmetic to find rows when a table has no header", () => {
    const rows = lineItemRows(
      linesFromPlainText(
        [
          "Printer paper A4 box   4   12.50   50.00",
          "Total   50.00",
          "Call us on 0113 496 0000",
        ].join("\n"),
      ),
    );
    expect(rows.map((row) => row.value)).toEqual([
      lineItem({
        description: "Printer paper A4 box",
        quantity: 4,
        unitPrice: 12.5,
        total: 50,
      }),
    ]);
  });
});
