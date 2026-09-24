import { describe, expect, test } from "bun:test";
import { getInvoiceState } from "./invoice-state";

describe("invoice state", () => {
  test("maps the processing pipeline to honest dashboard states", () => {
    expect(getInvoiceState({ status: "processing" })).toBe("processing");
    expect(getInvoiceState({ status: "pending" })).toBe("failed");
    expect(
      getInvoiceState({ status: "pending", extraction: { grossAmount: 120 } }),
    ).toBe("extracted");
    expect(
      getInvoiceState({
        status: "pending",
        extraction: { grossAmount: 120 },
        judgments: [{ status: "answered" }],
      }),
    ).toBe("judged");
    expect(getInvoiceState({ status: "done", extraction: {} })).toBe(
      "delivered",
    );
    expect(
      getInvoiceState({
        status: "pending",
        extraction: null,
        processingError: "No invoice details could be read from this document.",
      }),
    ).toBe("failed");
    // A retry clears the reason while it runs again.
    expect(
      getInvoiceState({ status: "processing", processingError: null }),
    ).toBe("processing");
  });
});
