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

  test("derives delivery from destination outcomes, not the legacy status", () => {
    const judged = {
      status: "pending",
      extraction: { grossAmount: 120 },
      judgments: [{ status: "answered" }],
    };
    // A legacy `done` status with no configured destination is not delivered.
    expect(getInvoiceState({ status: "done", extraction: {} })).toBe(
      "extracted",
    );
    expect(getInvoiceState({ ...judged, delivery: { state: "none" } })).toBe(
      "judged",
    );
    expect(getInvoiceState({ ...judged, delivery: { state: "pending" } })).toBe(
      "delivering",
    );
    expect(
      getInvoiceState({ ...judged, delivery: { state: "delivered" } }),
    ).toBe("delivered");
    expect(getInvoiceState({ ...judged, delivery: { state: "failed" } })).toBe(
      "delivery_failed",
    );
    // Every destination cancelled (disabled or disconnected): nothing was
    // delivered, so the invoice keeps its extraction state.
    expect(
      getInvoiceState({ ...judged, delivery: { state: "cancelled" } }),
    ).toBe("judged");
    expect(
      getInvoiceState({ status: "pending", delivery: { state: "delivered" } }),
    ).toBe("failed");
  });
});
