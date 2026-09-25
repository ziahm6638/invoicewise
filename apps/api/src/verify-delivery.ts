import { closeDatabase, db } from "@invoicewise/db/client";
import {
  createInbox,
  updateInboxWithProcessedData,
  upsertApiKey,
} from "@invoicewise/db/queries";
import {
  teams,
  users,
  usersOnTeam,
  webhookDeliveries,
  webhookEndpoints,
} from "@invoicewise/db/schema";
import {
  emitWebhookEvent,
  verifyWebhookSignature,
} from "@invoicewise/jobs/webhooks";
import { and, eq, inArray, sql } from "drizzle-orm";

const apiUrl = process.env.INVOICEWISE_API_URL ?? "http://localhost:3003";

const check = (condition: boolean, message: string) => {
  if (!condition) throw new Error(`Delivery proof failed: ${message}`);
};
const teamIds: string[] = [];
const userIds: string[] = [];
let listener: ReturnType<typeof Bun.serve> | undefined;

const waitFor = async <T>(
  read: () => Promise<T>,
  ready: (value: T) => boolean,
  timeoutMs = 30_000,
  intervalMs = 500,
) => {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    const value = await read();
    last = value;
    if (ready(value)) return value;
    // Protected REST endpoints allow 100 requests per 10 minutes per user, so
    // the proof polls at a rate that cannot exhaust that budget.
    await Bun.sleep(intervalMs);
  }
  throw new Error(
    `Timed out waiting for delivery proof: ${JSON.stringify(last)}`,
  );
};

const api = async <T>(
  path: string,
  key: string,
  init?: RequestInit,
): Promise<{ response: Response; body: T }> => {
  const response = await fetch(new URL(path, apiUrl), {
    ...init,
    headers: {
      Authorization: `Bearer ${key}`,
      "content-type": "application/json",
      ...init?.headers,
    },
  });
  const text = await response.text();
  let body: T;
  try {
    body = (text ? JSON.parse(text) : null) as T;
  } catch {
    body = { error: text } as T;
  }
  return { response, body };
};

const runMcpJudgmentCall = async (apiKey: string, invoiceId: string) => {
  const process = Bun.spawn(["bun", "run", "mcp"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: {
      ...Bun.env,
      INVOICEWISE_API_KEY: apiKey,
      INVOICEWISE_API_URL: apiUrl,
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const messages = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "delivery-proof-agent", version: "1.0" },
      },
    },
    {
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "get_invoice_judgments",
        arguments: { id: invoiceId },
      },
    },
  ];
  process.stdin.write(
    `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`,
  );
  const reader = process.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let response: { id?: number; result?: unknown; error?: unknown } | undefined;
  while (!response) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    response = lines
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as {
            id?: number;
            result?: unknown;
            error?: unknown;
          },
      )
      .find((line) => line.id === 2);
  }
  process.stdin.end();
  const [stderr, exitCode] = await Promise.all([
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0 || response?.error) {
    throw new Error(
      `MCP failed: ${JSON.stringify(response?.error) || stderr || buffer}`,
    );
  }
  if (!response?.result) throw new Error(`MCP response missing: ${buffer}`);
  return response.result;
};

type Received = {
  path: string;
  body: string;
  signature: string;
  version: string | null;
  status: number;
};

/**
 * Self-service endpoint management over REST against the running API and its
 * workflow runner: a synthetic test event, secret rotation with and without
 * overlap, a terminal failure recovered by explicit redelivery of the same
 * event, no cascade of failure notifications, and cross-workspace refusals.
 */
async function proveEndpointManagement(input: {
  keyA: string;
  keyB: string;
  teamId: string;
  invoice: { id: string } & Record<string, unknown>;
  listenerPort: number;
  goodEndpoint: { id: string; secret: string };
  unreachableEndpointId: string;
  deliveries: Received[];
  repair: () => void;
}) {
  const { keyA, keyB, teamId, invoice, deliveries } = input;
  const good = input.goodEndpoint;
  const received = (eventId: string, path = "/invoicewise") =>
    waitFor(
      async () =>
        deliveries.find(
          (delivery) =>
            delivery.path === path &&
            delivery.status === 204 &&
            JSON.parse(delivery.body).id === eventId,
        ),
      Boolean,
    ) as Promise<Received>;
  const emit = async (type: "invoice.processed" = "invoice.processed") => {
    const id = crypto.randomUUID();
    await emitWebhookEvent(db, {
      id,
      type,
      version: 1,
      createdAt: new Date().toISOString(),
      teamId,
      invoiceId: invoice.id,
      revision: 1,
      data: invoice,
    });
    return id;
  };
  type EndpointDelivery = {
    id: string;
    event: string;
    eventId: string;
    status: string;
    attempts: number;
  };
  const endpointDeliveries = async (endpointId: string) =>
    (
      await api<{ data: EndpointDelivery[] }>(
        `/webhooks/${endpointId}/deliveries`,
        keyA,
      )
    ).body.data;

  // Synthetic test event, signed like any other.
  const test = await api<{ deliveryId: string; eventId: string }>(
    `/webhooks/${good.id}/test`,
    keyA,
    { method: "POST" },
  );
  check(
    test.response.status === 202,
    `test event status ${test.response.status}`,
  );
  const testDelivery = await received(test.body.eventId);
  const testBody = JSON.parse(testDelivery.body);
  check(testBody.type === "webhook.test", "test event type");
  check(
    verifyWebhookSignature(
      good.secret,
      testDelivery.signature,
      testDelivery.body,
    ),
    "test event signature",
  );
  check(
    testDelivery.version === "1" && testBody.version === 1,
    "payload version",
  );

  // Rotation with overlap: both secrets verify.
  const rotated = await api<{
    secret: string;
    previousSecretExpiresAt: string;
  }>(`/webhooks/${good.id}/rotate-secret`, keyA, {
    method: "POST",
    body: "{}",
  });
  check(
    rotated.response.status === 200,
    `rotate status ${rotated.response.status}`,
  );
  const overlapEvent = await received(await emit());
  const overlap = {
    oldSecretVerifies: verifyWebhookSignature(
      good.secret,
      overlapEvent.signature,
      overlapEvent.body,
    ),
    newSecretVerifies: verifyWebhookSignature(
      rotated.body.secret,
      overlapEvent.signature,
      overlapEvent.body,
    ),
    previousSecretExpiresAt: rotated.body.previousSecretExpiresAt,
  };
  check(
    overlap.oldSecretVerifies && overlap.newSecretVerifies,
    "overlap signatures",
  );

  // Overlap expiry: once the previous secret expires only the new one signs.
  const expiring = await api<{ secret: string }>(
    `/webhooks/${good.id}/rotate-secret`,
    keyA,
    { method: "POST", body: "{}" },
  );
  await db
    .update(webhookEndpoints)
    .set({ previousSecretExpiresAt: sql`now() - interval '1 second'` })
    .where(eq(webhookEndpoints.id, good.id));
  const expiredEvent = await received(await emit());
  const expired = {
    previousSecretVerifies: verifyWebhookSignature(
      rotated.body.secret,
      expiredEvent.signature,
      expiredEvent.body,
    ),
    newSecretVerifies: verifyWebhookSignature(
      expiring.body.secret,
      expiredEvent.signature,
      expiredEvent.body,
    ),
  };
  check(
    !expired.previousSecretVerifies && expired.newSecretVerifies,
    "expired overlap",
  );

  // Immediate revocation for a leaked secret.
  const revoked = await api<{ secret: string; previousSecretExpiresAt: null }>(
    `/webhooks/${good.id}/rotate-secret`,
    keyA,
    { method: "POST", body: JSON.stringify({ revokePrevious: true }) },
  );
  const revokedEvent = await received(await emit());
  const revocation = {
    previousSecretExpiresAt: revoked.body.previousSecretExpiresAt,
    previousSecretVerifies: verifyWebhookSignature(
      expiring.body.secret,
      revokedEvent.signature,
      revokedEvent.body,
    ),
    newSecretVerifies: verifyWebhookSignature(
      revoked.body.secret,
      revokedEvent.signature,
      revokedEvent.body,
    ),
  };
  check(
    revocation.previousSecretExpiresAt === null &&
      !revocation.previousSecretVerifies &&
      revocation.newSecretVerifies,
    "revoked rotation",
  );

  // A failing endpoint exhausts its attempts; the failure is announced once.
  const flaky = await api<{ id: string; secret: string }>("/webhooks", keyA, {
    method: "POST",
    body: JSON.stringify({
      url: `http://127.0.0.1:${input.listenerPort}/flaky`,
      events: ["invoice.processed"],
    }),
  });
  check(
    flaky.response.status === 201,
    `flaky registration ${flaky.response.status}`,
  );
  const duplicate = await api<{ error: string }>("/webhooks", keyA, {
    method: "POST",
    body: JSON.stringify({
      url: `http://127.0.0.1:${input.listenerPort}/flaky`,
      events: ["invoice.processed"],
    }),
  });
  check(duplicate.response.status === 409, "duplicate active URL refused");
  const failingEventId = await emit();
  const [failed] = await waitFor(
    () => endpointDeliveries(flaky.body.id),
    (rows) => rows.some((row) => row.status === "failed"),
  );
  check(
    failed?.eventId === failingEventId && failed.attempts === 4,
    `failed delivery ${JSON.stringify(failed)}`,
  );
  const failureNotice = await waitFor(
    async () =>
      deliveries.filter((delivery) => {
        const body = JSON.parse(delivery.body);
        return (
          body.type === "delivery.failed" && body.data.deliveryId === failed!.id
        );
      }),
    (rows) => rows.length > 0,
  );

  // Cross-workspace: B cannot see or act on A's endpoint or delivery.
  const crossWorkspace = {
    deliveries: (await api(`/webhooks/${flaky.body.id}/deliveries`, keyB))
      .response.status,
    test: (
      await api(`/webhooks/${flaky.body.id}/test`, keyB, { method: "POST" })
    ).response.status,
    rotate: (
      await api(`/webhooks/${flaky.body.id}/rotate-secret`, keyB, {
        method: "POST",
        body: "{}",
      })
    ).response.status,
    redeliver: (
      await api(
        `/webhooks/${flaky.body.id}/deliveries/${failed!.id}/redeliver`,
        keyB,
        { method: "POST" },
      )
    ).response.status,
    disable: (
      await api(`/webhooks/${flaky.body.id}`, keyB, { method: "DELETE" })
    ).response.status,
  };
  check(
    Object.values(crossWorkspace).every((status) => status === 404),
    `cross-workspace ${JSON.stringify(crossWorkspace)}`,
  );

  // Explicit redelivery: the same delivery row and logical event id.
  input.repair();
  const redelivery = await api<{ status: string; eventId: string }>(
    `/webhooks/${flaky.body.id}/deliveries/${failed!.id}/redeliver`,
    keyA,
    { method: "POST" },
  );
  check(
    redelivery.response.status === 202,
    `redeliver ${redelivery.response.status}`,
  );
  const recovered = await received(failingEventId, "/flaky");
  const [settled] = await waitFor(
    () => endpointDeliveries(flaky.body.id),
    (rows) => rows[0]?.status === "succeeded",
  );
  const again = await api(
    `/webhooks/${flaky.body.id}/deliveries/${failed!.id}/redeliver`,
    keyA,
    { method: "POST" },
  );
  check(again.response.status === 409, "a delivered event is not redelivered");
  check(
    verifyWebhookSignature(
      flaky.body.secret,
      recovered.signature,
      recovered.body,
    ),
    "redelivered signature",
  );

  // A failing test event and a failing failure notification announce nothing.
  const unreachableTest = await api<{ deliveryId: string }>(
    `/webhooks/${input.unreachableEndpointId}/test`,
    keyA,
    { method: "POST" },
  );
  await waitFor(
    () => endpointDeliveries(input.unreachableEndpointId),
    (rows) =>
      rows.some(
        (row) =>
          row.id === unreachableTest.body.deliveryId && row.status === "failed",
      ),
  );
  const [cascades] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.teamId, teamId),
        eq(webhookDeliveries.event, "delivery.failed"),
        sql`${webhookDeliveries.payload}->'data'->>'event' in ('delivery.failed', 'webhook.test')`,
      ),
    );
  check(cascades?.count === 0, "failure notifications do not cascade");

  // Disable: further events are not scheduled for the endpoint.
  const disabled = await api<{ active: boolean }>(
    `/webhooks/${flaky.body.id}`,
    keyA,
    { method: "DELETE" },
  );
  const refusedTest = await api(`/webhooks/${flaky.body.id}/test`, keyA, {
    method: "POST",
  });
  check(
    disabled.body.active === false && refusedTest.response.status === 404,
    "disabled endpoint",
  );

  return {
    testEvent: {
      status: test.response.status,
      type: testBody.type,
      version: testBody.version,
      signatureValid: true,
    },
    rotation: { overlap, expired, revocation },
    failure: {
      attempts: failed!.attempts,
      failureNotices: failureNotice.length,
      duplicateUrlStatus: duplicate.response.status,
    },
    redelivery: {
      status: redelivery.response.status,
      sameEventId: JSON.parse(recovered.body).id === failingEventId,
      finalStatus: settled?.status,
      attempts: settled?.attempts,
      redeliverDeliveredStatus: again.response.status,
    },
    crossWorkspace,
    cascadingFailureNotices: cascades?.count,
    disabled: {
      active: disabled.body.active,
      testStatus: refusedTest.response.status,
    },
  };
}

try {
  await waitFor(
    () => fetch(new URL("/health", apiUrl)),
    (response) => response.ok,
  );

  const [teamA, teamB] = await db
    .insert(teams)
    .values([
      {
        name: "Delivery proof A",
        slug: `delivery-proof-a-${crypto.randomUUID()}`,
      },
      {
        name: "Delivery proof B",
        slug: `delivery-proof-b-${crypto.randomUUID()}`,
      },
    ])
    .returning({ id: teams.id });
  if (!teamA || !teamB) throw new Error("Unable to create proof workspaces");
  teamIds.push(teamA.id, teamB.id);

  const [userA, userB] = await db
    .insert(users)
    .values([
      {
        email: `delivery-a-${crypto.randomUUID()}@example.test`,
        fullName: "Delivery Proof A",
        teamId: teamA.id,
      },
      {
        email: `delivery-b-${crypto.randomUUID()}@example.test`,
        fullName: "Delivery Proof B",
        teamId: teamB.id,
      },
    ])
    .returning({ id: users.id });
  if (!userA || !userB) throw new Error("Unable to create proof users");
  userIds.push(userA.id, userB.id);

  // Current authorization resolves the caller's workspace role from
  // `users_on_team` on every request, so the proof users need real membership.
  await db.insert(usersOnTeam).values([
    { userId: userA.id, teamId: teamA.id, role: "owner" },
    { userId: userB.id, teamId: teamB.id, role: "owner" },
  ]);

  const [{ key: keyA }, { key: keyB }] = await Promise.all([
    upsertApiKey(db, {
      name: "Delivery proof key A",
      teamId: teamA.id,
      userId: userA.id,
      scopes: ["inbox.read", "inbox.write"],
    }),
    upsertApiKey(db, {
      name: "Delivery proof key B",
      teamId: teamB.id,
      userId: userB.id,
      // Write access too, so the cross-workspace refusals below come from
      // tenant isolation rather than a missing scope.
      scopes: ["inbox.read", "inbox.write"],
    }),
  ]);
  if (!keyA || !keyB) throw new Error("Unable to create proof API keys");

  const created = await createInbox(db, {
    displayName: "Proof Supplier",
    teamId: teamA.id,
    filePath: [teamA.id, "inbox", "proof-invoice.pdf"],
    fileName: "proof-invoice.pdf",
    contentType: "application/pdf",
    size: 1024,
    status: "pending",
  });
  if (!created) throw new Error("Unable to create proof invoice");
  const invoice = await updateInboxWithProcessedData(db, {
    id: created.id,
    amount: 125.5,
    currency: "GBP",
    date: "2026-09-22",
    displayName: "Proof Supplier",
    type: "invoice",
    status: "pending",
    extraction: {
      supplierName: "Proof Supplier Ltd",
      invoiceNumber: "PROOF-100",
      invoiceDate: "2026-09-22",
      dueDate: "2026-10-22",
      lineItems: [{ description: "Materials", amount: 125.5 }],
    },
    judgments: [{ questionId: "duplicate", answer: false, confidence: 0.99 }],
  });
  if (!invoice) throw new Error("Unable to process proof invoice");

  const list = await api<{ data: Array<{ id: string }> }>(
    "/invoices?pageSize=10&status=pending",
    keyA,
  );
  const detail = await api<Record<string, unknown>>(
    `/invoices/${invoice.id}`,
    keyA,
  );
  const refused = await api<{ error: string }>(`/invoices/${invoice.id}`, keyB);
  const csvResponse = await fetch(new URL("/invoices/export.csv", apiUrl), {
    headers: { Authorization: `Bearer ${keyA}` },
  });
  const csv = await csvResponse.text();

  const deliveries: Array<{
    path: string;
    body: string;
    signature: string;
    version: string | null;
    status: number;
  }> = [];
  // `/flaky` answers 500 until the proof repairs it, then 204.
  let flakyFailing = true;
  listener = Bun.serve({
    // Port 0 lets the OS choose a free loopback port, so parallel verification
    // runs cannot collide on the webhook listener.
    port: Number(process.env.VERIFY_DELIVERY_LISTENER_PORT ?? 0),
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      const status = path === "/flaky" && flakyFailing ? 500 : 204;
      deliveries.push({
        path,
        body: await request.text(),
        signature: request.headers.get("invoicewise-signature") ?? "",
        version: request.headers.get("invoicewise-webhook-version"),
        status,
      });
      return new Response(null, { status });
    },
  });
  const listenerPort = listener.port;

  const successfulEndpoint = await api<{
    id: string;
    secret: string;
  }>("/webhooks", keyA, {
    method: "POST",
    body: JSON.stringify({
      url: `http://127.0.0.1:${listenerPort}/invoicewise`,
      events: [
        "invoice.processed",
        "invoice.judgments.attached",
        "delivery.failed",
      ],
    }),
  });
  if (successfulEndpoint.response.status !== 201) {
    throw new Error(
      `Webhook registration failed: ${JSON.stringify(successfulEndpoint.body)}`,
    );
  }
  const refusedEndpoint = await api<{ error: string }>(
    `/webhooks/${successfulEndpoint.body.id}/attempts`,
    keyB,
  );

  await emitWebhookEvent(db, {
    id: crypto.randomUUID(),
    type: "invoice.processed",
    createdAt: new Date().toISOString(),
    teamId: teamA.id,
    invoiceId: invoice.id,
    data: invoice,
  });
  await waitFor(
    async () =>
      api<{ data: unknown[] }>(
        `/webhooks/${successfulEndpoint.body.id}/attempts`,
        keyA,
      ),
    ({ body }) => body.data.length >= 1,
  );
  const signedDelivery = deliveries[0];
  if (!signedDelivery) throw new Error("Signed webhook was not received");

  const failedEndpoint = await api<{ id: string }>("/webhooks", keyA, {
    method: "POST",
    body: JSON.stringify({
      url: "http://127.0.0.1:39999/unreachable",
      events: ["invoice.processed"],
    }),
  });
  if (failedEndpoint.response.status !== 201) {
    throw new Error(
      `Failure endpoint registration failed: ${JSON.stringify(failedEndpoint.body)}`,
    );
  }
  await emitWebhookEvent(db, {
    id: crypto.randomUUID(),
    type: "invoice.processed",
    createdAt: new Date().toISOString(),
    teamId: teamA.id,
    invoiceId: invoice.id,
    data: invoice,
  });
  const failedAttempts = await waitFor(
    async () =>
      api<{
        data?: Array<{ attempt: number; error: string | null }>;
        error?: string;
      }>(`/webhooks/${failedEndpoint.body.id}/attempts`, keyA),
    ({ body }) => Array.isArray(body.data) && body.data.length === 4,
  );
  if (!Array.isArray(failedAttempts.body.data)) {
    throw new Error(
      `Webhook attempts were not readable: status ${failedAttempts.response.status} body ${JSON.stringify(failedAttempts.body)}`,
    );
  }
  const deliveryStatus = await api<{
    data?: Array<{ status: string }>;
    error?: string;
  }>(`/invoices/${invoice.id}/delivery-status`, keyA);
  if (!Array.isArray(deliveryStatus.body.data)) {
    throw new Error(
      `Delivery status was not readable: status ${deliveryStatus.response.status} body ${JSON.stringify(deliveryStatus.body)}`,
    );
  }

  const management = await proveEndpointManagement({
    keyA,
    keyB,
    teamId: teamA.id,
    invoice,
    listenerPort: Number(listenerPort),
    goodEndpoint: successfulEndpoint.body,
    unreachableEndpointId: failedEndpoint.body.id,
    deliveries,
    repair: () => {
      flakyFailing = false;
    },
  });

  const mcp = await runMcpJudgmentCall(keyA, invoice.id);
  console.log(
    JSON.stringify(
      {
        apiKeyCreatedThrough: "upsertApiKey",
        rest: {
          listStatus: list.response.status,
          listedInvoice: list.body.data.some(({ id }) => id === invoice.id),
          status: detail.response.status,
          invoiceId: detail.body.id,
          hasExtraction: Boolean(detail.body.extraction),
          lineItems: Array.isArray(detail.body.lineItems)
            ? detail.body.lineItems.length
            : 0,
          hasSignedDocumentUrl:
            typeof detail.body.documentUrl === "string" &&
            detail.body.documentUrl.includes("signature="),
        },
        crossWorkspace: {
          status: refused.response.status,
          error: refused.body.error,
          webhookAttemptsStatus: refusedEndpoint.response.status,
        },
        webhook: {
          registrationStatus: successfulEndpoint.response.status,
          received: deliveries.length,
          signatureValid: verifyWebhookSignature(
            successfulEndpoint.body.secret,
            signedDelivery.signature,
            signedDelivery.body,
          ),
        },
        retry: {
          attempts: failedAttempts.body.data
            .map(({ attempt }) => attempt)
            .sort(),
          finalError: failedAttempts.body.data[0]?.error,
          deliveryStatuses: deliveryStatus.body.data.map(
            ({ status }) => status,
          ),
        },
        management,
        csv: {
          status: csvResponse.status,
          header: csv.split("\r\n")[0],
          row: csv.split("\r\n")[1],
        },
        mcp,
      },
      null,
      2,
    ),
  );
} finally {
  listener?.stop(true);
  if (teamIds.length > 0) {
    await db.delete(usersOnTeam).where(inArray(usersOnTeam.teamId, teamIds));
    await db.delete(teams).where(inArray(teams.id, teamIds));
  }
  if (userIds.length > 0) {
    await db.delete(users).where(inArray(users.id, userIds));
  }
  await closeDatabase();
}
