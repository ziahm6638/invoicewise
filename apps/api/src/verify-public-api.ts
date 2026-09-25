/**
 * Local proof of the public API contract (part of `bun run verify`).
 *
 * Starts the API from source with its workflow runner and a loopback
 * TypeSafe stub, creates two throwaway workspaces and their API keys through
 * the product's own key query (what Settings → Developer does), then:
 *
 * 1. runs the clean-room smoke check (`public-api-smoke.ts`) as a separate
 *    process that receives nothing but the API URL, a key and a loopback
 *    webhook receiver: no database URL, no repository state;
 * 2. proves what the smoke check cannot see from one key: tenant isolation
 *    over REST, export and MCP; scope enforcement; paging without repeats;
 *    formula-safe export of a hostile file name; a deleted key refused on its
 *    next request and its replacement accepted at once; and that no key ever
 *    appears in the API's output.
 *
 * Requires DATABASE_PRIMARY_URL (a disposable, migrated database), storage
 * and the synthetic provider settings of the verification environment.
 */
import { closeDatabase, db } from "@invoicewise/db/client";
import { deleteApiKey, upsertApiKey } from "@invoicewise/db/queries";
import { teams, users, usersOnTeam } from "@invoicewise/db/schema";
import { startTypeSafeStub } from "@invoicewise/jobs/verify-support";
import { inArray } from "drizzle-orm";
import { connectMcpStdio } from "./mcp/stdio-client";

const check = (condition: unknown, message: string) => {
  if (!condition) throw new Error(`Public API proof failed: ${message}`);
};

const freePort = () => {
  const probe = Bun.serve({ port: 0, fetch: () => new Response(null) });
  const port = probe.port;
  probe.stop(true);
  return port;
};

const teamIds: string[] = [];
const userIds: string[] = [];
const typeSafe = startTypeSafeStub();
const received: { event: string; invoiceId: string | null }[] = [];
const receiver = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: async (request) => {
    const body = JSON.parse(await request.text()) as {
      type: string;
      data?: { id?: string };
    };
    received.push({ event: body.type, invoiceId: body.data?.id ?? null });
    return new Response(null, { status: 204 });
  },
});

const port = freePort();
const apiUrl = `http://localhost:${port}`;
let output = "";
const api = Bun.spawn(["bun", "--no-env-file", "src/index.ts"], {
  cwd: new URL("..", import.meta.url).pathname,
  env: {
    ...process.env,
    PORT: String(port),
    STORAGE_PUBLIC_URL: apiUrl,
    TYPESAFE_BASE_URL: `http://127.0.0.1:${typeSafe.port}`,
    // Loopback webhook endpoints are only accepted outside production.
    NODE_ENV: "test",
    WORKFLOW_POLL_MS: "50",
    WORKFLOW_RETRY_BASE_MS: "50",
    WORKFLOW_RETRY_MAX_MS: "200",
  },
  stdout: "pipe",
  stderr: "pipe",
});
const drain = async (stream: ReadableStream<Uint8Array>) => {
  const decoder = new TextDecoder();
  for await (const chunk of stream) output += decoder.decode(chunk);
};
void drain(api.stdout);
void drain(api.stderr);

type Json = Record<string, any>;

const call = async (
  path: string,
  key: string,
  init: RequestInit = {},
): Promise<{ status: number; body: any; text: string; headers: Headers }> => {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${key}`);
  const response = await fetch(`${apiUrl}${path}`, { ...init, headers });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // CSV and empty bodies stay text.
  }
  return { status: response.status, body, text, headers: response.headers };
};

const submit = (key: string, fileName: string, reference: string) => {
  const form = new FormData();
  const text = `ACME SUPPLIES LTD\nInvoice number: INV-2026-0042\n${reference}`;
  form.set(
    "file",
    new File([minimalPdf(text)], fileName, { type: "application/pdf" }),
  );
  return call("/v1/invoices", key, { method: "POST", body: form });
};

/** A one-page text PDF; only its uniqueness matters here. */
const minimalPdf = (text: string) => {
  const content = text
    .split("\n")
    .map(
      (line, index) =>
        `BT /F1 10 Tf 50 ${780 - index * 16} Td (${line.replace(/[\\()]/g, "\\$&")}) Tj ET`,
    )
    .join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
};

/** One `get_invoice` call through a fresh stdio MCP server with `key`. */
const mcpCall = async (key: string, id: string) => {
  const { client } = await connectMcpStdio({ apiUrl, apiKey: key });
  try {
    const response = await client.request("tools/call", {
      name: "get_invoice",
      arguments: { id },
    });
    return response.result as {
      isError: boolean;
      structuredContent: Json;
    };
  } finally {
    await client.close();
  }
};

const workspace = async (label: string, role: "owner" | "member") => {
  const [team] = await db
    .insert(teams)
    .values({
      name: `Public API proof ${label}`,
      slug: `public-api-proof-${label}-${crypto.randomUUID()}`,
    })
    .returning({ id: teams.id });
  if (!team) throw new Error("Unable to create proof workspace");
  teamIds.push(team.id);
  const [user] = await db
    .insert(users)
    .values({
      email: `public-api-${label}-${crypto.randomUUID()}@example.test`,
      fullName: `Public API proof ${label}`,
      teamId: team.id,
    })
    .returning({ id: users.id });
  if (!user) throw new Error("Unable to create proof user");
  userIds.push(user.id);
  await db
    .insert(usersOnTeam)
    .values({ userId: user.id, teamId: team.id, role });
  return { teamId: team.id, userId: user.id };
};

const createKey = async (
  owner: { teamId: string; userId: string },
  scopes: ("inbox.read" | "inbox.write")[],
) => {
  const created = await upsertApiKey(db, {
    name: "Public API proof key",
    teamId: owner.teamId,
    userId: owner.userId,
    scopes,
  });
  if (!created.key || !created.data) throw new Error("Unable to create key");
  return { key: created.key, id: created.data.id };
};

try {
  const deadline = Date.now() + 60_000;
  while (true) {
    const ready = await fetch(`${apiUrl}/health`).catch(() => null);
    if (ready?.ok) break;
    if (Date.now() > deadline) {
      throw new Error(`API did not start: ${output.slice(-2000)}`);
    }
    await Bun.sleep(250);
  }

  const a = await workspace("a", "owner");
  const b = await workspace("b", "owner");
  const keyA = await createKey(a, ["inbox.read", "inbox.write"]);
  const keyB = await createKey(b, ["inbox.read", "inbox.write"]);
  const readOnlyA = await createKey(a, ["inbox.read"]);

  // 1. The clean-room smoke check: URL, key and a webhook receiver only.
  const smoke = Bun.spawn(["bun", "--no-env-file", "src/public-api-smoke.ts"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? "/tmp",
      INVOICEWISE_API_URL: apiUrl,
      INVOICEWISE_API_KEY: keyA.key,
      SMOKE_WEBHOOK_URL: `http://127.0.0.1:${receiver.port}/invoicewise`,
      SMOKE_TIMEOUT_MS: "120000",
      SMOKE_POLL_MS: "500",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [smokeOut, smokeErr, smokeExit] = await Promise.all([
    new Response(smoke.stdout).text(),
    new Response(smoke.stderr).text(),
    smoke.exited,
  ]);
  check(
    smokeExit === 0,
    `smoke check exited ${smokeExit}: ${smokeErr || smokeOut}\n${output.slice(-3000)}`,
  );
  const smokeSummary = JSON.parse(smokeOut) as Json;
  const invoiceId: string = smokeSummary.submission.id;
  check(
    received.some(
      (item) =>
        item.event === "invoice.processed" && item.invoiceId === invoiceId,
    ),
    "the webhook receiver got invoice.processed",
  );

  // 2. Tenant isolation: REST, export and MCP of another workspace.
  const foreign = await call(`/v1/invoices/${invoiceId}`, keyB.key);
  check(foreign.status === 404, `foreign read: ${foreign.status}`);
  const foreignExport = await call("/v1/exports/invoices.csv", keyB.key);
  check(
    foreignExport.status === 200 && !foreignExport.text.includes(invoiceId),
    "foreign export excludes the invoice",
  );
  const foreignRetry = await call(
    `/v1/invoices/${invoiceId}/delivery/retry`,
    keyB.key,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: 1 }),
    },
  );
  check(foreignRetry.status === 404, `foreign retry: ${foreignRetry.status}`);
  const foreignMcp = await mcpCall(keyB.key, invoiceId);
  check(
    foreignMcp.isError === true && foreignMcp.structuredContent.status === 404,
    `foreign MCP read: ${JSON.stringify(foreignMcp)}`,
  );
  const ownMcp = await mcpCall(readOnlyA.key, invoiceId);
  check(ownMcp.isError === false, "read-only key reads via MCP");

  // Scopes: a read-only key cannot submit or retry.
  const readOnlySubmit = await submit(readOnlyA.key, "ro.pdf", "read-only");
  check(
    readOnlySubmit.status === 403 &&
      readOnlySubmit.body.error?.code === "insufficient_scope",
    `read-only submission: ${readOnlySubmit.status}`,
  );

  // Paging never repeats, and a hostile file name exports as text.
  const hostile = await submit(keyA.key, "-2-3.pdf", `hostile ${Date.now()}`);
  check(hostile.status === 202, `hostile submission: ${hostile.status}`);
  await submit(keyA.key, "third.pdf", `third ${Date.now()}`);
  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const page = await call(
      `/v1/invoices?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      keyA.key,
    );
    check(page.status === 200, `page: ${page.status}`);
    seen.push(...page.body.data.map((item: Json) => item.id));
    cursor = page.body.nextCursor;
  } while (cursor);
  check(
    seen.length === 3 && new Set(seen).size === 3,
    `paging returned ${JSON.stringify(seen)}`,
  );
  const exported = await call("/v1/exports/invoices.csv?limit=10", keyA.key);
  check(
    exported.text.includes(",'-2-3.pdf,"),
    "the hostile file name is neutralized in the export",
  );

  // Revocation and rotation: the deleted key fails on its next request, the
  // new one works at once.
  const beforeRevoke = await call("/v1/invoices?limit=1", keyA.key);
  check(beforeRevoke.status === 200, "key works before revocation");
  const rotated = await createKey(a, ["inbox.read", "inbox.write"]);
  await deleteApiKey(db, { id: keyA.id, teamId: a.teamId });
  const afterRevoke = await call("/v1/invoices?limit=1", keyA.key);
  check(afterRevoke.status === 401, `revoked key: ${afterRevoke.status}`);
  const revokedMcp = await mcpCall(keyA.key, invoiceId);
  check(
    revokedMcp.isError === true && revokedMcp.structuredContent.status === 401,
    `revoked key MCP: ${JSON.stringify(revokedMcp)}`,
  );
  const replacement = await call("/v1/invoices?limit=1", rotated.key);
  check(replacement.status === 200, "replacement key works at once");

  // No credential is ever written to the API's output.
  await Bun.sleep(200);
  for (const secret of [keyA.key, keyB.key, readOnlyA.key, rotated.key]) {
    check(!output.includes(secret), "an API key appeared in the API output");
    check(
      !output.includes(secret.slice(4, 24)),
      "part of an API key appeared in the API output",
    );
  }

  console.log(
    JSON.stringify(
      {
        smoke: smokeSummary,
        isolation: {
          foreignRead: foreign.status,
          foreignRetry: foreignRetry.status,
          foreignExportExcludes: true,
          foreignMcp: foreignMcp.structuredContent.status,
        },
        scopes: { readOnlySubmit: readOnlySubmit.status, readOnlyMcp: "ok" },
        paging: { pages: seen.length, distinct: new Set(seen).size },
        export: { hostileFileName: "'-2-3.pdf" },
        keys: {
          revokedRest: afterRevoke.status,
          revokedMcp: revokedMcp.structuredContent.status,
          replacement: replacement.status,
          loggedAnywhere: false,
        },
      },
      null,
      2,
    ),
  );
} finally {
  api.kill("SIGTERM");
  await Promise.race([api.exited, Bun.sleep(10_000)]);
  api.kill("SIGKILL");
  receiver.stop(true);
  typeSafe.stop(true);
  if (teamIds.length > 0) {
    await db.delete(usersOnTeam).where(inArray(usersOnTeam.teamId, teamIds));
    await db.delete(teams).where(inArray(teams.id, teamIds));
  }
  if (userIds.length > 0) {
    await db.delete(users).where(inArray(users.id, userIds));
  }
  await closeDatabase();
}
