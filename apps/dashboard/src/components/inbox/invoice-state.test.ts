import { describe, expect, test } from "bun:test";
import {
  STALLED_PROCESSING_REASON,
  describeInvoiceWorkflow,
  getInvoiceState,
} from "./invoice-state";

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

describe("invoice workflow", () => {
  const stage = (
    invoice: Parameters<typeof describeInvoiceWorkflow>[0],
    key: string,
    viewer = { postToAccounting: true },
  ) =>
    describeInvoiceWorkflow(invoice, viewer).find(
      (entry) => entry.key === key,
    )!;
  const extracted = {
    status: "pending",
    extraction: { grossAmount: 120 },
    judgments: [{ status: "answered" }],
    validation: { status: "valid", issues: [] },
  };

  test("a stalled processing job reads as failed and offers re-extraction", () => {
    const stalled = { status: "processing", processingStalled: true };
    expect(getInvoiceState(stalled)).toBe("failed");
    expect(stage(stalled, "extraction")).toMatchObject({
      status: "failed",
      summary: STALLED_PROCESSING_REASON,
      next: "Re-extract the document, or upload a clearer copy.",
    });
  });

  test("a failed extraction carries its reason and blocks later stages", () => {
    const failed = {
      status: "pending",
      processingError: "No invoice details could be read from this document.",
    };
    expect(stage(failed, "extraction")).toMatchObject({
      status: "failed",
      summary: "No invoice details could be read from this document.",
    });
    expect(stage(failed, "validation").status).toBe("not_started");
    expect(stage(failed, "delivery").status).toBe("not_started");
  });

  test("a failed re-read keeps the previous reading and its delivery", () => {
    const rereadFailed = {
      ...extracted,
      processingError: "TypeSafe is unavailable. Try again shortly.",
      accountingProviderId: "xero-bill-1",
      delivery: { state: "delivered", total: 1, succeeded: 1 },
    };
    expect(stage(rereadFailed, "extraction")).toMatchObject({
      status: "failed",
      summary:
        "The last re-read failed: TypeSafe is unavailable. Try again shortly. The previous reading is kept.",
      next: "Re-extract the document, or upload a clearer copy.",
    });
    expect(stage(rereadFailed, "validation").status).toBe("done");
    expect(stage(rereadFailed, "questions").summary).toBe("1 question answered.");
    expect(stage(rereadFailed, "delivery")).toMatchObject({
      status: "done",
      summary: "Delivered to 1 destination, including the accounting bill.",
    });
  });

  test("invalid totals name the error and the correction as the next step", () => {
    const invalid = {
      ...extracted,
      validation: {
        status: "invalid",
        issues: [
          {
            severity: "error",
            message:
              "Net 100.00 + VAT 20.00 = 120.00, but the gross total is 150.00.",
          },
        ],
      },
      accountingPostStatus: "failed",
      delivery: { state: "failed", total: 1, failed: 1 },
    };
    expect(stage(invalid, "validation")).toMatchObject({
      status: "failed",
      summary:
        "1 error: Net 100.00 + VAT 20.00 = 120.00, but the gross total is 150.00.",
    });
    expect(stage(invalid, "delivery").next).toBe(
      "Correct the invoice; once it validates it is sent again.",
    );
    expect(
      stage(invalid, "delivery", { postToAccounting: false }).next,
    ).toBe(
      "Correct the invoice; once it validates an admin must send it again.",
    );
  });

  test("queued work is in progress, never delivered", () => {
    const queued = {
      ...extracted,
      delivery: { state: "pending", total: 2, pending: 1, succeeded: 1 },
    };
    expect(stage(queued, "delivery")).toMatchObject({
      status: "in_progress",
      summary: "Queued for 1 destination; not delivered yet.",
    });
    expect(
      stage(
        {
          ...extracted,
          accountingProviderId: "xero-bill-1",
          delivery: { state: "delivered", total: 1, succeeded: 1 },
        },
        "delivery",
      ),
    ).toMatchObject({
      status: "done",
      summary: "Delivered to 1 destination, including the accounting bill.",
    });
  });

  test("question reruns and corrections are visible", () => {
    expect(
      stage({ ...extracted, judgmentsRerunStatus: "queued" }, "questions")
        .status,
    ).toBe("in_progress");
    expect(
      stage(
        {
          ...extracted,
          judgmentsRerunStatus: "failed",
          judgmentsRerunError: "Try again shortly.",
        },
        "questions",
      ),
    ).toMatchObject({
      status: "failed",
      summary: "Try again shortly.",
      next: "Rerun the questions.",
    });
    expect(
      stage({ ...extracted, correctionCount: 2 }, "extraction").summary,
    ).toBe(
      "Read from the document and corrected 2 times. The original reading is kept in the history.",
    );
  });
});
