/**
 * Mailbox webhook acknowledgment boundary.
 *
 * The provider must be told to retry a transient intake failure and to stop
 * retrying a permanent one. These checks drive the real route handler with
 * local stubs only; no provider call leaves the machine.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

const TEAM_ID = "11111111-1111-4111-8111-111111111111";

let intakeResult:
  | { status: "rejected"; code: string; message: string }
  | { status: "accepted"; inboxId: string } = {
  status: "accepted",
  inboxId: "inbox-1",
};

const intakeCalls: { referenceId?: string }[] = [];
let inFlight = 0;
let maxInFlight = 0;

mock.module("@/utils/logger", () => ({
  logger: () => undefined,
}));

mock.module("@api/services/mail", () => ({
  deliverMail: async () => ({ transport: "log" }),
}));

mock.module("@invoicewise/events/server", () => ({
  setupAnalytics: async () => ({ track: () => undefined }),
}));

mock.module("@invoicewise/jobs/intake", () => ({
  acceptIntakeUpload: async (
    _db: unknown,
    _storage: unknown,
    input: { referenceId?: string },
  ) => {
    intakeCalls.push({ referenceId: input.referenceId });
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    // Yield so overlapping calls would be observable.
    await new Promise((resolve) => setTimeout(resolve, 1));
    inFlight -= 1;
    return intakeResult;
  },
  defaultIntakeStorage: {},
}));

mock.module("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "3.134.147.250" }),
}));

mock.module("@invoicewise/db/client", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: async () => [{ id: TEAM_ID, email: null }],
      }),
    }),
  },
  primaryDb: {},
}));

const { POST } = await import("./route");

const payloadFor = (name: string, count = 1, from = "vendor@example.com") => ({
  OriginalRecipient: "team-inbox@inbox.midday.ai",
  MessageID: "message-1",
  Subject: "Invoice",
  FromFull: { Name: "Vendor", Email: from },
  Attachments: Array.from({ length: count }, (_, index) => ({
    Name: name,
    Content: Buffer.from("%PDF-1.4 synthetic").toString("base64"),
    ContentType: "application/pdf",
    ContentID: `attachment-${index + 1}`,
    ContentLength: 250_000,
  })),
});

const post = (name: string, count = 1, from?: string) =>
  POST(
    new Request("http://localhost/api/webhook/inbox", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payloadFor(name, count, from)),
    }),
  );

describe("mailbox webhook acknowledgment", () => {
  beforeEach(() => {
    intakeCalls.length = 0;
    maxInFlight = 0;
  });

  test("asks the provider to retry a transient storage failure", async () => {
    intakeResult = {
      status: "rejected",
      code: "storage_unavailable",
      message: "The stored document could not be read back. Retry the upload.",
    };

    const response = await post("invoice.pdf");
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toContain("retry");
  });

  test("asks the provider to retry a parser-capacity failure", async () => {
    intakeResult = {
      status: "rejected",
      code: "temporarily_unavailable",
      message: "The document parser is temporarily at capacity.",
    };

    const response = await post("invoice.pdf");
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toContain("retry");
  });

  test("acknowledges a permanent rejection without retrying", async () => {
    intakeResult = {
      status: "rejected",
      code: "content_mismatch",
      message:
        "An existing object at this document path has different content.",
    };

    const response = await post("invoice.pdf");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
  });

  test("keeps separate occurrences of the same attachment name distinct", async () => {
    intakeResult = { status: "accepted", inboxId: "inbox-1" };

    const response = await post("invoice.pdf");
    expect(response.status).toBe(200);
    expect(intakeCalls).toHaveLength(1);
    expect(intakeCalls[0]?.referenceId).toBe("message-1_0_invoice.pdf");
  });

  test("validates many attachments one at a time instead of flooding the parser", async () => {
    intakeResult = { status: "accepted", inboxId: "inbox-1" };

    // More PDFs than the parser admits (2 running, 8 queued) at once.
    const response = await post("invoice.pdf", 12);
    expect(response.status).toBe(200);
    expect(intakeCalls).toHaveLength(12);
    expect(maxInFlight).toBe(1);
    expect(new Set(intakeCalls.map((call) => call.referenceId)).size).toBe(12);
  });

  test("ignores mail sent from the app's own configured sender", async () => {
    intakeResult = { status: "accepted", inboxId: "inbox-1" };
    const previousSender = process.env.AUTH_EMAIL_FROM;
    process.env.AUTH_EMAIL_FROM = "InvoiceWise <Auth@InvoiceWise.test>";

    try {
      const response = await post("invoice.pdf", 1, "auth@invoicewise.test");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ success: true });
      expect(intakeCalls).toHaveLength(0);

      const vendor = await post("invoice.pdf", 1, "vendor@example.com");
      expect(vendor.status).toBe(200);
      expect(intakeCalls).toHaveLength(1);
    } finally {
      if (previousSender === undefined)
        Reflect.deleteProperty(process.env, "AUTH_EMAIL_FROM");
      else process.env.AUTH_EMAIL_FROM = previousSender;
    }
  });
});
