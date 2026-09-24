/**
 * Transactional-mail policy checks for the workflow mailer.
 *
 * The worker runs without the API's auth import, so it enforces the same
 * fail-closed production configuration and the same explicit non-production
 * capture. Every provider request in these checks is captured in-process by
 * the fetch stub below.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The provider SDK fixes its base URL when its module first loads, and another
// test file in this run may load it before this one, so provider requests are
// captured at fetch itself instead of through a base-URL override. Nothing
// leaves the process.
const requests: string[] = [];
const originalFetch = globalThis.fetch;
const previousEnv = { ...process.env };
let sinkDir: string;

globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url,
  );

  requests.push(url.pathname);
  return Response.json({ id: "mailer-policy-probe" });
}) as typeof fetch;

const loadMailer = async () => {
  const { WorkflowMailer, WorkflowMailerLive } = await import("./workflows.js");

  return { WorkflowMailer, WorkflowMailerLive };
};

const sendOnce = async (message: {
  from?: string;
  to: string;
  subject: string;
  text: string;
}) => {
  const { Effect } = await import("effect");
  const { WorkflowMailer, WorkflowMailerLive } = await loadMailer();

  return await Effect.runPromise(
    Effect.gen(function* () {
      const mailer = yield* WorkflowMailer;
      yield* mailer.send(message as never);
    }).pipe(Effect.provide(WorkflowMailerLive)),
  );
};

describe("workflow mailer transactional-mail policy", () => {
  beforeAll(async () => {
    sinkDir = await mkdtemp(join(tmpdir(), "jobs-mailer-policy-"));
  });

  afterAll(async () => {
    globalThis.fetch = originalFetch;
    process.env = previousEnv;
    await rm(sinkDir, { recursive: true, force: true });
  });

  test("refuses production without a configured sender and contacts nothing", async () => {
    process.env.NODE_ENV = "production";
    process.env.RESEND_API_KEY = "re_worker_probe";
    // An empty value is "not configured" for the shared policy helper.
    process.env.AUTH_EMAIL_FROM = "";
    process.env.AUTH_MAIL_SINK_PATH = "";

    await expect(
      sendOnce({
        from: "Inherited Sender <hello@example.test>",
        to: "synthetic@example.test",
        subject: "Local policy probe",
        text: "Synthetic, no token",
      }),
    ).rejects.toThrow(/Transactional email is not configured/);

    expect(requests).toHaveLength(0);
  });

  test("refuses production with the development placeholder key", async () => {
    process.env.NODE_ENV = "production";
    process.env.RESEND_API_KEY = "re_local_development";
    process.env.AUTH_EMAIL_FROM = "InvoiceWise <auth@invoicewise.test>";
    process.env.AUTH_MAIL_SINK_PATH = "";

    await expect(
      sendOnce({
        to: "synthetic@example.test",
        subject: "Local policy probe",
        text: "Synthetic, no token",
      }),
    ).rejects.toThrow(/Transactional email is not configured/);

    expect(requests).toHaveLength(0);
  });

  test("captures non-production mail locally without contacting the provider", async () => {
    const sink = join(sinkDir, "mail.jsonl");
    process.env.NODE_ENV = "test";
    process.env.RESEND_API_KEY = "re_worker_probe";
    process.env.AUTH_EMAIL_FROM = "InvoiceWise <auth@invoicewise.test>";
    process.env.AUTH_MAIL_SINK_PATH = sink;

    await sendOnce({
      from: "Inherited Sender <hello@example.test>",
      to: "invitee@example.test",
      subject: "Invitation",
      text: "Local capture",
    });

    const [line] = (await readFile(sink, "utf8")).trim().split("\n");
    const record = JSON.parse(line!) as {
      to?: string;
      from?: string | null;
      subject?: string;
    };

    expect(record.to).toBe("invitee@example.test");
    expect(record.from).toBe("InvoiceWise <auth@invoicewise.test>");
    expect(record.subject).toBe("Invitation");
    expect(requests).toHaveLength(0);
  });

  test("sends configured production mail through the provider", async () => {
    process.env.NODE_ENV = "production";
    process.env.RESEND_API_KEY = "re_worker_probe";
    process.env.AUTH_EMAIL_FROM = "InvoiceWise <auth@invoicewise.test>";
    process.env.AUTH_MAIL_SINK_PATH = "";

    await sendOnce({
      from: "Inherited Sender <hello@example.test>",
      to: "invitee@example.test",
      subject: "Invitation",
      text: "Configured production send",
    });

    expect(requests).toHaveLength(1);
  });
});
