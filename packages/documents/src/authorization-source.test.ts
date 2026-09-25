import { describe, expect, test } from "bun:test";
import {
  AUTHORIZATION_SOURCE_CSV_TEMPLATE,
  authorizationReferenceKey,
  authorizationSourceGaps,
  csvRowErrors,
  normalizeAuthorizationSource,
  parseAuthorizationSourcesCsv,
  parseCsvRecords,
  parseDecimal,
} from "./authorization-source";

const valid = {
  type: "purchase_order",
  reference: " PO-1001 ",
  supplier: { name: "Northwind Joinery Ltd", vatNumber: "GB293445512" },
  currency: "gbp",
  taxBasis: "exclusive",
  issuedOn: "2026-09-01",
  lines: [
    {
      reference: "1",
      description: "Oak boards",
      quantity: 120,
      unitPrice: "18.5",
      amount: "2220",
    },
    { description: "Delivery", amount: 80 },
  ],
};

const issuesOf = (input: unknown) => {
  const result = normalizeAuthorizationSource(input);
  if (result.ok) throw new Error("expected issues");
  return result.issues;
};

describe("normalizeAuthorizationSource", () => {
  test("normalises a valid purchase order and totals its lines", () => {
    const result = normalizeAuthorizationSource(valid);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.terms).toMatchObject({
      type: "purchase_order",
      reference: "PO-1001",
      referenceKey: "PO1001",
      status: null,
      currency: "GBP",
      taxBasis: "exclusive",
      authorizedTotal: "2300.00",
      effectiveFrom: null,
    });
    expect(result.terms.lines).toEqual([
      {
        reference: "1",
        description: "Oak boards",
        quantity: "120",
        unitPrice: "18.5",
        amount: "2220.00",
      },
      {
        reference: null,
        description: "Delivery",
        quantity: null,
        unitPrice: null,
        amount: "80.00",
      },
    ]);
  });

  test("accepts a total without lines and aliases for type, status and tax basis", () => {
    const result = normalizeAuthorizationSource({
      type: "PO",
      reference: "po 7",
      status: "Canceled",
      taxBasis: "gross",
      authorizedTotal: "1,250.5",
    });
    expect(result.ok && result.terms).toMatchObject({
      type: "purchase_order",
      status: "cancelled",
      taxBasis: "inclusive",
      authorizedTotal: "1250.50",
      currency: null,
    });
  });

  test("reports every problem, not just the first", () => {
    const issues = issuesOf({
      type: "invoice",
      reference: "",
      currency: "POUNDS",
      issuedOn: "01/09/2026",
      startsOn: "2026-09-10",
      endsOn: "2026-09-01",
    });
    expect(issues.map((issue) => issue.field).sort()).toEqual([
      "authorizedTotal",
      "currency",
      "endsOn",
      "issuedOn",
      "reference",
      "type",
    ]);
  });

  test("an amount is required, and never rounded silently", () => {
    expect(issuesOf({ type: "job", reference: "J1" })[0]?.message).toContain(
      "authorized total",
    );
    expect(
      issuesOf({ type: "job", reference: "J1", authorizedTotal: "10.005" })[0]
        ?.message,
    ).toBe("Must have at most 2 decimal places.");
    expect(
      issuesOf({ type: "job", reference: "J1", authorizedTotal: -5 })[0]
        ?.message,
    ).toBe("Must be a non-negative number.");
  });

  test("lines must agree with quantity × unit price and with the total", () => {
    const lineIssues = issuesOf({
      type: "job",
      reference: "J1",
      lines: [
        { description: "Labour", quantity: 2, unitPrice: 10, amount: 25 },
      ],
    });
    expect(lineIssues).toEqual([
      {
        field: "lines.amount",
        line: 0,
        message: "Does not equal quantity × unit price (20.00).",
      },
    ]);
    const totalIssues = issuesOf({
      type: "job",
      reference: "J1",
      authorizedTotal: 100,
      lines: [{ description: "Labour", amount: 90 }],
    });
    expect(totalIssues[0]?.message).toBe(
      "Does not equal the sum of the line amounts (90.00).",
    );
  });

  test("a line amount is derived from quantity and unit price when omitted", () => {
    const result = normalizeAuthorizationSource({
      type: "job",
      reference: "J1",
      lines: [{ description: "Labour", quantity: "3", unitPrice: "33.3333" }],
    });
    expect(result.ok && result.terms.authorizedTotal).toBe("100.00");
  });

  test("repeated line references and a bad supplier id are refused", () => {
    const issues = issuesOf({
      type: "job",
      reference: "J1",
      supplier: { id: "not-a-uuid" },
      lines: [
        { reference: "A", description: "One", amount: 1 },
        { reference: "a", description: "Two", amount: 1 },
      ],
    });
    expect(issues).toContainEqual({
      field: "lines.reference",
      line: 1,
      message: "Repeats the reference of line 1.",
    });
    expect(issues.some((issue) => issue.field === "supplier.id")).toBe(true);
  });
});

describe("helpers", () => {
  test("references compare without spacing, punctuation or case", () => {
    expect(authorizationReferenceKey("po-1001")).toBe(
      authorizationReferenceKey("PO 1001"),
    );
  });

  test("decimals parse exactly", () => {
    expect(parseDecimal("0.1", 2)).toBe(10n);
    expect(parseDecimal(0.3, 2)).toBe(30n);
    expect(parseDecimal("1e3", 2)).toBe("invalid");
    expect(parseDecimal("", 2)).toBeNull();
  });

  test("gaps state an unknown supplier, missing currency and tax basis", () => {
    expect(
      authorizationSourceGaps({
        supplierId: null,
        currency: null,
        taxBasis: null,
      }).map((gap) => gap.code),
    ).toEqual(["unknown_supplier", "missing_currency", "missing_tax_basis"]);
    expect(
      authorizationSourceGaps({
        supplierId: "s",
        currency: "GBP",
        taxBasis: "exclusive",
      }),
    ).toEqual([]);
  });
});

describe("CSV import", () => {
  test("quoted fields, doubled quotes and CRLF parse", () => {
    const { records, error } = parseCsvRecords(
      'a,b\r\n"x, y","say ""hi"""\r\n',
    );
    expect(error).toBeNull();
    expect(records).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"'],
    ]);
    expect(parseCsvRecords('a\n"open').error).toBe(
      "A quoted field is never closed.",
    );
  });

  test("the documented template parses into valid sources", () => {
    const parsed = parseAuthorizationSourcesCsv(
      AUTHORIZATION_SOURCE_CSV_TEMPLATE,
    );
    expect(parsed.errors).toEqual([]);
    expect(parsed.sources.map((source) => source.rows)).toEqual([
      [2, 3],
      [4],
      [5],
    ]);
    const totals = parsed.sources.map((source) => {
      const result = normalizeAuthorizationSource(source.input);
      if (!result.ok) throw new Error(JSON.stringify(result.issues));
      return [result.terms.type, result.terms.authorizedTotal];
    });
    expect(totals).toEqual([
      ["job", "4200.00"],
      ["purchase_order", "2220.00"],
      ["contract", "14400.00"],
    ]);
  });

  test("rows of one source must agree; errors name the row and column", () => {
    const csv = [
      "source_type,reference,currency,line_description,line_amount",
      "job,J-1,GBP,Labour,100",
      "job,J 1,EUR,Materials,oops",
    ].join("\n");
    const parsed = parseAuthorizationSourcesCsv(csv);
    expect(parsed.errors).toEqual([
      {
        row: 3,
        column: "currency",
        reference: "J 1",
        message:
          'Differs from row 2 of the same source ("GBP"); every row of one source must agree.',
      },
    ]);
    const [source] = parsed.sources;
    const result = normalizeAuthorizationSource(source!.input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(csvRowErrors(source!, result.issues)).toEqual([
      {
        row: 3,
        column: "line_amount",
        reference: "J-1",
        message: "Must be a non-negative number.",
      },
    ]);
  });

  test("unknown or missing columns reject the file", () => {
    expect(
      parseAuthorizationSourcesCsv("source_type,reference,colour\n").errors[0]
        ?.message,
    ).toBe("Unknown column: colour.");
    expect(
      parseAuthorizationSourcesCsv("reference,currency\nJ1,GBP\n").errors[0]
        ?.message,
    ).toBe("Missing required column: source_type.");
    expect(parseAuthorizationSourcesCsv("").errors[0]?.message).toBe(
      "The file is empty.",
    );
  });
});
