import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { PublicInvoiceRow } from "@invoicewise/db/queries";
import { InvoiceActionError } from "@invoicewise/jobs/exceptions";
import { intakeContentHash } from "@invoicewise/jobs/intake";
import { type Context, Layer } from "effect";
import { normalizeResponse } from "../rest/v1-errors";
import { csvCell } from "./csv";
import {
  PublicApiStore,
  PublicInvoicesLayer,
  apiSubmissionReference,
  decodeCursor,
  encodeCursor,
  idempotencyReference,
  isoTimestamp,
  toInvoice,
} from "./public-api";
import {
  TRUSTED_CALLER_HEADERS,
  makePublicApiHandler,
  publicApiContract,
} from "./public-api-http";

const TEAM = "7d1f0c2e-8f5a-4f0e-9a51-3c1b2a6d9e10";
const USER = "0b9e4a55-2f1d-4c83-9d4f-6a7e8b9c0d12";
const ID_1 = "4a80fbd7-898f-4896-af62-f4b21621988f";
const ID_2 = "5b91acd8-9a90-4a07-b073-05c32732a990";

const row = (overrides: Partial<PublicInvoiceRow> = {}): PublicInvoiceRow => ({
  id: ID_1,
  fileName: "invoice.pdf",
  displayName: "invoice.pdf",
  contentType: "application/pdf",
  size: 2048,
  contentHash: "cd".repeat(32),
  referenceId: "api:order-1",
  inboxAccountId: null,
  inboundEmailId: null,
  amount: 1200,
  currency: "GBP",
  status: "pending",
  createdAt: "2026-09-25 10:00:00.123456+00",
  extraction: {
    supplierName: '=HYPERLINK("http://evil")',
    supplierVatNumber: "GB123456789",
    invoiceNumber: "INV-2026-0042",
    invoiceDate: "2026-09-01",
    dueDate: "2026-09-30",
    currency: "GBP",
    netAmount: 1000,
    vatAmount: 200,
    grossAmount: 1200,
    documentType: "invoice",
  },
  judgments: [
    {
      questionId: "duplicate",
      questionVersionId: "q-v1",
      questionVersion: 2,
      label: "Duplicate?",
      question: "Is this a duplicate?",
      source: "default",
      status: "answered",
      type: "boolean",
      answer: false,
      probability: 0.05,
      evaluator: { model: "jev-1", version: "q3" },
      answeredAt: "2026-09-25T10:01:00.000Z",
    },
  ],
  validation: {
    status: "valid",
    documentType: "invoice",
    issues: [],
    accounting: { ready: true, blockers: [] },
  },
  supplierId: "5a0c3e59-2d3f-4d7c-9b44-9e1f7f0d6a11",
  supplierChecks: { version: 1 },
  processingError: null,
  processingRevision: 1,
  processingStalled: false,
  delivery: {
    state: "delivered",
    total: 1,
    succeeded: 1,
    pending: 0,
    failed: 0,
    cancelled: 0,
  },
  judgmentsRerunStatus: null,
  judgmentsRerunError: null,
  correctionCount: 0,
  accountingProvider: null,
  accountingPostStatus: null,
  accountingProviderId: null,
  reconciliation: null,
  ...overrides,
});

type Store = Context.Tag.Service<typeof PublicApiStore>;

const calls: { name: string; args: unknown }[] = [];

const baseStore = (rows: PublicInvoiceRow[]): Store => ({
  list: async (params) => {
    calls.push({ name: "list", args: params });
    const start = params.cursor
      ? rows.findIndex((item) => item.id === params.cursor?.id) + 1
      : 0;
    const page = rows.slice(start, start + params.limit);
    const last = page.at(-1);
    return {
      data: page,
      next:
        start + params.limit < rows.length && last
          ? { createdAt: last.createdAt, id: last.id }
          : null,
    };
  },
  get: async (teamId, id) =>
    teamId === TEAM ? rows.find((item) => item.id === id) : undefined,
  history: async () => [
    {
      id: "h1",
      invoiceId: ID_1,
      runId: "run-1",
      questionKey: "duplicate",
      questionVersionId: "q-v1",
      questionVersion: 2,
      invoiceRevision: 1,
      judgment: {
        questionId: "duplicate",
        label: "Duplicate?",
        status: "answered",
        type: "boolean",
        answer: true,
        runId: "run-1",
      },
      previous: {
        questionId: "duplicate",
        label: "Duplicate?",
        status: "answered",
        type: "boolean",
        answer: false,
      },
      createdAt: "2026-09-25T11:00:00.000Z",
    },
  ],
  questionKeys: async () => ["duplicate", "po_present"],
  deliveryStatus: async () => ({ webhooks: [], accounting: null }),
  documentUrl: async (_teamId, id) =>
    id === ID_1
      ? { url: "https://storage.test/signed", fileName: "a.pdf" }
      : null,
  referenceOwner: async (_teamId, reference) =>
    reference === idempotencyReference("order-1")
      ? { inboxId: ID_1, contentHash: intakeContentHash(new Uint8Array([1])) }
      : null,
  submit: async (input) => {
    calls.push({ name: "submit", args: input });
    return {
      status: "accepted",
      inboxId: ID_2,
      filePath: [TEAM, "inbox", ID_2, "x.pdf"],
      fileName: input.fileName,
      mimeType: "application/pdf",
      size: input.bytes.byteLength,
      pageCount: 1,
      deduplicated: false,
    };
  },
  reextract: async (_teamId, id, revision) => {
    calls.push({ name: "reextract", args: { id, revision } });
    if (revision !== 1) {
      throw new InvoiceActionError("conflict", "This invoice changed.");
    }
    return { deduplicated: false };
  },
  rerunQuestions: async (_teamId, _id, revision) => ({
    revision,
    deduplicated: true,
  }),
  retryDelivery: async (input) => {
    calls.push({ name: "retryDelivery", args: input });
    return {
      invoiceId: input.id,
      revision: input.revision,
      webhooks: { requeued: 1, skipped: 0 },
      accounting: input.role === "member" ? "admin_required" : "requeued",
      billUpdate: "not_needed",
    };
  },
});

const handlerFor = (store: Store) =>
  makePublicApiHandler(
    PublicInvoicesLayer.pipe(
      Layer.provide(Layer.succeed(PublicApiStore, store)),
    ),
  );

const rows = [
  row(),
  row({ id: ID_2, createdAt: "2026-09-25 09:00:00+00", referenceId: null }),
];
const handler = handlerFor(baseStore(rows));
afterAll(() => handler.dispose());

const request = (
  path: string,
  init: RequestInit & { role?: string; anonymous?: boolean } = {},
) => {
  const headers = new Headers(init.headers);
  if (!init.anonymous) {
    headers.set(TRUSTED_CALLER_HEADERS.teamId, TEAM);
    headers.set(TRUSTED_CALLER_HEADERS.userId, USER);
    headers.set(TRUSTED_CALLER_HEADERS.role, init.role ?? "admin");
  }
  return handler.handler(
    new Request(`http://api.test${path}`, { ...init, headers }),
  );
};

const upload = (bytes: Uint8Array, headers: Record<string, string> = {}) => {
  const form = new FormData();
  form.set(
    "file",
    new File([bytes], "invoice.pdf", { type: "application/pdf" }),
  );
  return request("/v1/invoices", { method: "POST", body: form, headers });
};

describe("public API v1", () => {
  test("refuses a request without the authenticated caller", async () => {
    const response = await request("/v1/invoices", { anonymous: true });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: "unauthorized", message: "Authentication required" },
    });
  });

  test("lists invoices in the contract's shape with an opaque cursor", async () => {
    const first = await request("/v1/invoices?limit=1");
    expect(first.status).toBe(200);
    const page = (await first.json()) as {
      data: { id: string; status: string; document: { source: string } }[];
      hasMore: boolean;
      nextCursor: string;
    };
    expect(page.data.map((item) => item.id)).toEqual([ID_1]);
    expect(page.data[0]?.status).toBe("processed");
    expect(page.data[0]?.document.source).toBe("api");
    expect(page.hasMore).toBe(true);

    const second = (await (
      await request(`/v1/invoices?limit=1&cursor=${page.nextCursor}`)
    ).json()) as { data: { id: string }[]; hasMore: boolean };
    expect(second.data.map((item) => item.id)).toEqual([ID_2]);
    expect(second.hasMore).toBe(false);
  });

  test("reports a keyless API submission as api and an upload as upload", async () => {
    const provenance = handlerFor(
      baseStore([
        row({ referenceId: apiSubmissionReference() }),
        row({ id: ID_2, referenceId: null }),
      ]),
    );
    const read = async (id: string) =>
      (
        (await (
          await provenance.handler(
            new Request(`http://api.test/v1/invoices/${id}`, {
              headers: {
                [TRUSTED_CALLER_HEADERS.teamId]: TEAM,
                [TRUSTED_CALLER_HEADERS.userId]: USER,
                [TRUSTED_CALLER_HEADERS.role]: "admin",
              },
            }),
          )
        ).json()) as {
          document: { source: string; idempotencyKey: string | null };
        }
      ).document;
    expect(await read(ID_1)).toMatchObject({
      source: "api",
      idempotencyKey: null,
    });
    expect(await read(ID_2)).toMatchObject({
      source: "upload",
      idempotencyKey: null,
    });
    await provenance.dispose();
  });

  test("a cursor is only valid for the order it was issued for", async () => {
    const cursor = encodeCursor("desc", {
      createdAt: "2026-09-25 10:00:00+00",
      id: ID_1,
    });
    const response = await request(`/v1/invoices?order=asc&cursor=${cursor}`);
    expect(response.status).toBe(400);
    expect(
      ((await response.json()) as { error: { code: string } }).error.code,
    ).toBe("invalid_cursor");
  });

  test("refuses an impossible calendar date as invalid_request", async () => {
    for (const query of ["createdFrom=2026-02-31", "createdTo=2026-13-01"]) {
      const response = await normalizeResponse(
        await request(`/v1/invoices?${query}`),
      );
      expect(response.status).toBe(400);
      expect(
        ((await response.json()) as { error: { code: string } }).error.code,
      ).toBe("invalid_request");
    }
    const valid = await request("/v1/invoices?createdFrom=2024-02-29");
    expect(valid.status).toBe(200);
  });

  test("an unknown invoice is not found", async () => {
    const missing = await request(
      "/v1/invoices/00000000-0000-4000-8000-000000000000",
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      error: { code: "not_found", message: "Invoice not found" },
    });
  });

  test("returns judgments with their rerun history", async () => {
    const body = (await (
      await request(`/v1/invoices/${ID_1}/judgments`)
    ).json()) as {
      judgments: { questionKey: string; answer: unknown }[];
      history: { answer: { answer: unknown }; previous: { answer: unknown } }[];
    };
    expect(body.judgments[0]).toMatchObject({
      questionKey: "duplicate",
      answer: false,
    });
    expect(body.history[0]?.answer.answer).toBe(true);
    expect(body.history[0]?.previous.answer).toBe(false);
  });

  test("signs a short-lived document link", async () => {
    const body = (await (
      await request(`/v1/invoices/${ID_1}/document`)
    ).json()) as { url: string; expiresAt: string };
    expect(body.url).toBe("https://storage.test/signed");
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now());
  });

  test("accepts a document asynchronously", async () => {
    const response = await upload(new Uint8Array([7, 7, 7]), {
      "idempotency-key": "order-2",
    });
    expect(response.status).toBe(202);
    expect(response.headers.get("location")).toBe(`/v1/invoices/${ID_2}`);
    const body = (await response.json()) as { id: string; sha256: string };
    expect(body.id).toBe(ID_2);
    expect(body.sha256).toBe(intakeContentHash(new Uint8Array([7, 7, 7])));
    const submitted = calls.findLast((call) => call.name === "submit")
      ?.args as { idempotencyKey: string; teamId: string };
    expect(submitted.idempotencyKey).toBe("order-2");
    expect(submitted.teamId).toBe(TEAM);
  });

  test("refuses an idempotency key reused for other bytes", async () => {
    const response = await upload(new Uint8Array([9]), {
      "idempotency-key": "order-1",
    });
    expect(response.status).toBe(409);
    expect(
      ((await response.json()) as { error: { code: string } }).error.code,
    ).toBe("idempotency_key_reused");
  });

  test("refuses an invalid idempotency key and a missing file", async () => {
    const invalid = await upload(new Uint8Array([1]), {
      "idempotency-key": "has space",
    });
    expect(invalid.status).toBe(400);
    const noFile = await request("/v1/invoices", {
      method: "POST",
      body: new FormData(),
    });
    expect(noFile.status).toBe(400);
  });

  test("maps intake refusals to their statuses", async () => {
    const full = handlerFor({
      ...baseStore(rows),
      submit: async () => ({
        status: "rejected",
        code: "queue_full",
        message: "Busy",
      }),
    });
    const form = new FormData();
    form.set("file", new File([new Uint8Array([1])], "a.pdf"));
    const response = await full.handler(
      new Request("http://api.test/v1/invoices", {
        method: "POST",
        body: form,
        headers: {
          [TRUSTED_CALLER_HEADERS.teamId]: TEAM,
          [TRUSTED_CALLER_HEADERS.userId]: USER,
          [TRUSTED_CALLER_HEADERS.role]: "member",
        },
      }),
    );
    await full.dispose();
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("120");
  });

  test("refuses an oversized upload before reading it", async () => {
    const response = await request("/v1/invoices", {
      method: "POST",
      headers: {
        "content-type": "multipart/form-data; boundary=x",
        "content-length": String(50_000_000),
      },
      body: "--x--",
    });
    expect(response.status).toBe(413);
  });

  test("actions carry the revision the caller read", async () => {
    const ok = await request(`/v1/invoices/${ID_1}/reextract`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: 1 }),
    });
    expect(ok.status).toBe(202);
    const stale = await request(`/v1/invoices/${ID_1}/reextract`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: 0 }),
    });
    expect(stale.status).toBe(409);
    expect(
      ((await stale.json()) as { error: { code: string } }).error.code,
    ).toBe("conflict");
  });

  test("a member's delivery retry leaves accounting to an admin", async () => {
    const response = await request(`/v1/invoices/${ID_1}/delivery/retry`, {
      method: "POST",
      role: "member",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: 1 }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      started: boolean;
      accounting: string;
    };
    expect(body.started).toBe(true);
    expect(body.accounting).toBe("admin_required");
    expect(
      calls.findLast((call) => call.name === "retryDelivery")?.args,
    ).toMatchObject({ role: "member", revision: 1, teamId: TEAM });
  });

  test("exports pages of injection-safe CSV", async () => {
    const response = await request("/v1/exports/invoices.csv?limit=1");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
    const next = response.headers.get("x-next-cursor");
    expect(next).toBeTruthy();
    expect(response.headers.get("link")).toContain('rel="next"');
    const [header, line] = (await response.text()).split("\r\n");
    expect(header).toContain("invoice_id,revision");
    expect(header).toContain("question:duplicate,question:po_present");
    expect(line).toContain(`${ID_1},1,processed`);
    expect(line).toContain("GBP");
    expect(line).toContain(`"'=HYPERLINK(""http://evil"")"`);

    const last = await request(
      `/v1/exports/invoices.csv?limit=1&cursor=${next}`,
    );
    expect(last.headers.get("x-next-cursor")).toBeNull();
  });

  test("exports current answers and rerun history", async () => {
    const csv = await (
      await request("/v1/exports/judgments.csv?limit=10")
    ).text();
    const lines = csv.split("\r\n");
    expect(lines[0]).toStartWith("invoice_id,invoice_revision,entry,run_id");
    expect(lines.some((line) => line.includes(",current,"))).toBe(true);
    expect(
      lines.some(
        (line) =>
          line.includes(",rerun,run-1,") && line.endsWith(",answered,false"),
      ),
    ).toBe(true);
  });
});

describe("reconciliation summary", () => {
  test("is null until reconciled", () => {
    expect(toInvoice(row()).reconciliation).toBeNull();
  });

  test("carries the status and finding codes, never the sources' amounts", () => {
    const invoice = toInvoice(
      row({
        reconciliation: {
          status: "discrepancy",
          discrepancies: ["over_authorized_total", "rate_above_authorized"],
          unresolved: [],
          revision: 2,
          reconciledAt: "2026-09-25 10:05:00.5+00",
        },
      }),
    );
    expect(invoice.reconciliation).toEqual({
      status: "discrepancy",
      discrepancies: ["over_authorized_total", "rate_above_authorized"],
      unresolved: [],
      revision: 2,
      reconciledAt: "2026-09-25T10:05:00.500Z",
    });
  });

  test("an unknown status is not published", () => {
    const invoice = toInvoice(
      row({
        reconciliation: {
          status: "approved",
          discrepancies: [],
          unresolved: [],
          revision: 1,
          reconciledAt: "2026-09-25T10:05:00.000Z",
        },
      }),
    );
    expect(invoice.reconciliation).toBeNull();
  });
});

describe("CSV cells", () => {
  test("neutralizes spreadsheet formulas but keeps numbers", () => {
    expect(csvCell("=1+1")).toBe("'=1+1");
    expect(csvCell("+44 20")).toBe("'+44 20");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("\tcmd")).toBe("'\tcmd");
    expect(csvCell("-12.50")).toBe("-12.50");
    expect(csvCell(-12.5)).toBe("-12.5");
    expect(csvCell("-1+cmd|' /C calc'!A0")).toBe("'-1+cmd|' /C calc'!A0");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell(null)).toBe("");
  });
});

describe("cursor", () => {
  test("round-trips and rejects tampering", async () => {
    const { Effect } = await import("effect");
    const position = { createdAt: "2026-09-25 10:00:00.123456+00", id: ID_1 };
    expect(
      await Effect.runPromise(
        decodeCursor(encodeCursor("asc", position), "asc"),
      ),
    ).toEqual(position);
    const exit = await Effect.runPromiseExit(
      decodeCursor("bm90LWpzb24", "asc"),
    );
    expect(exit._tag).toBe("Failure");
  });
});

describe("published contract", () => {
  test("matches the committed OpenAPI document", () => {
    const committed = JSON.parse(
      readFileSync(
        new URL("../../../../docs/api/openapi-v1.json", import.meta.url),
        "utf8",
      ),
    );
    // Regenerate with `bun run contract:v1` in apps/api after a deliberate,
    // backward-compatible change; see docs/api.md#versioning.
    expect(publicApiContract()).toEqual(committed);
  });

  test("documents every endpoint, bearer security and the error body", () => {
    const spec = publicApiContract() as {
      paths: Record<string, Record<string, unknown>>;
      security: unknown;
      components: { securitySchemes: Record<string, unknown> };
    };
    expect(Object.keys(spec.paths).sort()).toEqual([
      "/v1/exports/invoices.csv",
      "/v1/exports/judgments.csv",
      "/v1/invoices",
      "/v1/invoices/{id}",
      "/v1/invoices/{id}/delivery",
      "/v1/invoices/{id}/delivery/retry",
      "/v1/invoices/{id}/document",
      "/v1/invoices/{id}/judgments",
      "/v1/invoices/{id}/questions/rerun",
      "/v1/invoices/{id}/reextract",
    ]);
    expect(spec.security).toEqual([{ apiKey: [] }]);
    expect(spec.components.securitySchemes.apiKey).toBeTruthy();
    expect(JSON.stringify(spec)).not.toContain("x-invoicewise-team-id");
  });
});

describe("contract error bodies at the Hono boundary", () => {
  test("a malformed request becomes invalid_request", async () => {
    const response = await normalizeResponse(
      await request("/v1/invoices/not-a-uuid"),
    );
    expect(response.status).toBe(400);
    expect(
      ((await response.json()) as { error: { code: string } }).error.code,
    ).toBe("invalid_request");
  });

  test("an unknown endpoint becomes not_found", async () => {
    const response = await normalizeResponse(await request("/v1/nothing"));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "not_found", message: "No such endpoint" },
    });
  });

  test("contract errors pass through unchanged", async () => {
    const response = await normalizeResponse(
      await request("/v1/invoices?cursor=bad"),
    );
    expect(
      ((await response.json()) as { error: { code: string } }).error.code,
    ).toBe("invalid_cursor");
  });
});

describe("timestamps", () => {
  test("responses carry ISO 8601 while cursors keep the database value", async () => {
    const body = (await (await request(`/v1/invoices/${ID_1}`)).json()) as {
      createdAt: string;
    };
    expect(body.createdAt).toBe("2026-09-25T10:00:00.123Z");
    expect(isoTimestamp("2026-09-25 09:00:00+00")).toBe(
      "2026-09-25T09:00:00.000Z",
    );
  });
});
