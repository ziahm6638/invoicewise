/**
 * Production-entrypoint end-to-end smoke.
 *
 * Runs the built API executable on one origin and the built dashboard on a
 * second origin against one disposable database, then drives the real customer
 * boundaries: Better Auth sign-up/sign-in on the dashboard, the dashboard
 * upload route, the API's tRPC surface, the authenticated proxy and the
 * rendered original-document preview. Two tenants are created and the second
 * tenant must not be able to read the first tenant's document. A sole owner of
 * a single workspace then deletes their account, and that workspace with it,
 * and someone left with no workspace still reaches account deletion.
 *
 * Nothing here leaves the machine: provider credentials are synthetic values
 * and the storage backend is a temporary local directory.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import {
  connectDisposableDatabase,
  databaseUrl,
  dropDisposableDatabase,
  resetDisposableDatabase,
} from "./database";
import {
  ManagedProcess,
  ROOT,
  type Verification,
  assertHealthContract,
  executablePath,
  waitForHttp,
} from "./lib";

export const E2E_DATABASE = "invoicewise_e2e_test";

const FIXTURE_PDF = join(
  ROOT,
  "packages",
  "documents",
  "src",
  "test",
  "fixtures",
  "synthetic-invoice.pdf",
);

type Tenant = {
  email: string;
  password: string;
  cookie: string;
  userId: string;
  teamId: string;
};

/** Environment builder and workspace path resolver owned by the orchestrator. */
export type E2EContext = {
  env: (
    overrides?: Record<string, string | undefined>,
  ) => Record<string, string>;
  ws: (relativePath: string) => string;
  /** Per-run app ports chosen by the orchestrator (free at start). */
  apiPort: number;
  dashboardPort: number;
};

async function migrate(v: Verification, environment: E2EContext) {
  await v.runStep("e2e:migrate-disposable-database", {
    command: "bun",
    args: ["--no-env-file", "x", "drizzle-kit", "migrate"],
    cwd: environment.ws("packages/db"),
    env: environment.env({
      DATABASE_PRIMARY_URL: databaseUrl(E2E_DATABASE),
    }),
  });
}

async function buildExecutable(
  v: Verification,
  name: string,
  entry: string,
  cwd: string,
  outfile: string,
  env: Record<string, string>,
) {
  await v.runStep(name, {
    command: "bun",
    args: [
      "--no-env-file",
      "build",
      entry,
      "--target=bun",
      "--packages=external",
      `--outfile=${outfile}`,
    ],
    cwd,
    env,
  });
}

const cookieFrom = (response: Response) => {
  const cookie = response.headers.getSetCookie()[0];
  if (!cookie) throw new Error("no session cookie was issued");
  return cookie.split(";")[0]!;
};

async function createTenant(
  label: string,
  database: string,
  password: string,
  appOrigin: string,
): Promise<Tenant> {
  const email = `${label}-${crypto.randomUUID()}@example.test`;
  const signUp = await fetch(`${appOrigin}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: appOrigin },
    body: JSON.stringify({ email, password, name: label }),
  });
  if (signUp.status !== 200) {
    throw new Error(
      `sign-up for ${label} failed with ${signUp.status}: ${await signUp.text()}`,
    );
  }

  const { client, query } = await connectDisposableDatabase(database);
  let userId: string;
  let teamId: string;
  try {
    await query("update users set email_verified = true where email = $1", [
      email,
    ]);
    const [row] = await query<{ id: string; team_id: string }>(
      "select id, team_id from users where email = $1",
      [email],
    );
    if (!row?.team_id) {
      throw new Error(`sign-up for ${label} did not provision a workspace`);
    }
    userId = row.id;
    teamId = row.team_id;
  } finally {
    await client.end();
  }

  const signIn = await fetch(`${appOrigin}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: appOrigin },
    body: JSON.stringify({ email, password }),
  });
  if (signIn.status !== 200) {
    throw new Error(
      `sign-in for ${label} failed with ${signIn.status}: ${await signIn.text()}`,
    );
  }

  return { email, password, cookie: cookieFrom(signIn), userId, teamId };
}

async function uploadInvoice(
  tenant: Tenant,
  bytes: Buffer,
  fileName: string,
  appOrigin: string,
) {
  const form = new FormData();
  form.set(
    "file",
    new File([new Uint8Array(bytes)], fileName, { type: "application/pdf" }),
  );
  // A forged path/bucket must be ignored by the server-owned intake identity.
  form.set("path", JSON.stringify(["other-team", "inbox", "forged.pdf"]));
  form.set("bucket", "vault");

  const response = await fetch(`${appOrigin}/api/storage/upload`, {
    method: "POST",
    headers: { origin: appOrigin, cookie: tenant.cookie },
    body: form,
  });
  const body = (await response.json().catch(() => null)) as {
    id?: string;
    path?: string[];
    code?: string;
    error?: string;
    deduplicated?: boolean;
  } | null;
  return { status: response.status, body };
}

async function trpcQuery(
  tenant: Tenant,
  path: string,
  input: unknown,
  apiOrigin: string,
  appOrigin: string,
) {
  const response = await fetch(
    `${apiOrigin}/trpc/${path}?input=${encodeURIComponent(
      JSON.stringify({ json: input }),
    )}`,
    { headers: { origin: appOrigin, cookie: tenant.cookie } },
  );
  return { status: response.status, text: await response.text() };
}

async function trpcMutation(
  tenant: Tenant,
  path: string,
  input: unknown,
  apiOrigin: string,
  appOrigin: string,
) {
  const response = await fetch(`${apiOrigin}/trpc/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: appOrigin,
      cookie: tenant.cookie,
    },
    body: JSON.stringify(input === undefined ? {} : { json: input }),
  });
  return { status: response.status, text: await response.text() };
}

export async function runProductionE2E(v: Verification, context: E2EContext) {
  const APP_ORIGIN = `http://localhost:${context.dashboardPort}`;
  const API_ORIGIN = `http://localhost:${context.apiPort}`;
  const database = databaseUrl(E2E_DATABASE);
  const databaseEnv = context.env({
    DATABASE_PRIMARY_URL: database,
    BETTER_AUTH_URL: APP_ORIGIN,
    NEXT_PUBLIC_URL: APP_ORIGIN,
    NEXT_PUBLIC_API_URL: API_ORIGIN,
    STORAGE_PUBLIC_URL: API_ORIGIN,
    ALLOWED_API_ORIGINS: APP_ORIGIN,
    PORT: String(context.apiPort),
    NODE_ENV: "production",
  });

  v.onCleanup("drop e2e database", () => dropDisposableDatabase(E2E_DATABASE));
  await resetDisposableDatabase(E2E_DATABASE);
  await migrate(v, context);

  const apiDir = context.ws("apps/api");
  const jobsDir = context.ws("packages/jobs");
  const apiOutfile = executablePath(apiDir, "api-server.js");
  await buildExecutable(
    v,
    "e2e:build-api-executable",
    "./src/index.ts",
    apiDir,
    apiOutfile,
    databaseEnv,
  );

  const api = await ManagedProcess.start(v, "e2e:api-executable", {
    command: "bun",
    args: ["--no-env-file", apiOutfile],
    cwd: apiDir,
    env: databaseEnv,
  });
  await v.runCheck("e2e:api-executable-health", async () => {
    await waitForHttp(
      `${API_ORIGIN}/health`,
      (r) => r.status === 200,
      "API /health",
    );
    await assertHealthContract(API_ORIGIN);
    return `built API executable served the public health contract and operator metrics from ${API_ORIGIN}`;
  });

  const dashboard = await ManagedProcess.start(v, "e2e:dashboard-production", {
    command: "bun",
    args: [
      "--no-env-file",
      "x",
      "next",
      "start",
      "-p",
      String(context.dashboardPort),
    ],
    cwd: context.ws("apps/dashboard"),
    env: databaseEnv,
  });
  await v.runCheck("e2e:dashboard-production-server", async () => {
    await waitForHttp(
      `${APP_ORIGIN}/api/preview?id=missing`,
      (r) => r.status === 404 || r.status === 200,
      "dashboard server",
      90_000,
    );
    return `built dashboard served on ${APP_ORIGIN}`;
  });

  const fixture = await readFile(FIXTURE_PDF);
  const fixtureHash = createHash("sha256").update(fixture).digest("hex");

  let tenantA: Tenant | undefined;
  let tenantB: Tenant | undefined;
  let intakeId = "";

  await v.runCheck("e2e:two-tenant-intake-preview-and-isolation", async () => {
    const password = "VerifyPassword123!";
    tenantA = await createTenant(
      "verify-a",
      E2E_DATABASE,
      password,
      APP_ORIGIN,
    );
    tenantB = await createTenant(
      "verify-b",
      E2E_DATABASE,
      password,
      APP_ORIGIN,
    );

    if (tenantA.teamId === tenantB.teamId) {
      throw new Error("the two verification tenants share one workspace");
    }

    const uploaded = await uploadInvoice(
      tenantA,
      fixture,
      "invoice.pdf",
      APP_ORIGIN,
    );
    if (uploaded.status !== 200 || !uploaded.body?.id) {
      throw new Error(
        `intake upload failed: ${uploaded.status} ${JSON.stringify(uploaded.body)}`,
      );
    }
    intakeId = uploaded.body.id;
    if (uploaded.body.path?.[0] !== tenantA.teamId) {
      throw new Error(
        `server-owned intake path is not bound to the caller workspace: ${JSON.stringify(uploaded.body.path)}`,
      );
    }

    // Authenticated proxy returns the original documented bytes.
    const proxy = await fetch(
      `${APP_ORIGIN}/api/proxy?id=${encodeURIComponent(intakeId)}`,
      { headers: { cookie: tenantA.cookie } },
    );
    if (proxy.status !== 200) {
      throw new Error(`authenticated proxy failed with ${proxy.status}`);
    }
    const proxied = Buffer.from(await proxy.arrayBuffer());
    const proxiedHash = createHash("sha256").update(proxied).digest("hex");
    if (proxiedHash !== fixtureHash) {
      throw new Error("the proxied document is not the original fixture bytes");
    }
    const cacheControl = proxy.headers.get("cache-control") ?? "";
    if (!cacheControl.includes("no-store")) {
      throw new Error(`document proxy is cacheable: "${cacheControl}"`);
    }
    if (proxy.headers.get("x-content-type-options") !== "nosniff") {
      throw new Error("document proxy is missing nosniff");
    }

    // The built Next.js server renders the original invoice through the
    // isolated PDF pipeline.
    const preview = await fetch(
      `${APP_ORIGIN}/api/preview?id=${encodeURIComponent(intakeId)}`,
      { headers: { cookie: tenantA.cookie } },
    );
    if (preview.status !== 200) {
      throw new Error(
        `original-document preview failed with ${preview.status}: ${await preview.text()}`,
      );
    }
    if (preview.headers.get("content-type") !== "image/png") {
      throw new Error(
        `preview content-type: ${preview.headers.get("content-type")}`,
      );
    }
    const image = sharp(Buffer.from(await preview.arrayBuffer()));
    const metadata = await image.metadata();
    if (!metadata.width || !metadata.height) {
      throw new Error("preview did not decode into a raster image");
    }
    const stats = await image.stats();
    const ink = stats.channels[0]?.min ?? 255;
    if (ink > 200) {
      throw new Error("preview image appears blank (no rendered ink)");
    }

    // Cross-tenant isolation through every read surface.
    const foreignProxy = await fetch(
      `${APP_ORIGIN}/api/proxy?id=${encodeURIComponent(intakeId)}`,
      { headers: { cookie: tenantB.cookie } },
    );
    if (foreignProxy.status !== 404) {
      throw new Error(
        `second tenant read another workspace document via /api/proxy (${foreignProxy.status})`,
      );
    }
    const foreignPreview = await fetch(
      `${APP_ORIGIN}/api/preview?id=${encodeURIComponent(intakeId)}`,
      { headers: { cookie: tenantB.cookie } },
    );
    if (foreignPreview.status !== 404) {
      throw new Error(
        `second tenant rendered another workspace document (${foreignPreview.status})`,
      );
    }
    const unauthenticated = await fetch(
      `${APP_ORIGIN}/api/proxy?id=${encodeURIComponent(intakeId)}`,
    );
    if (unauthenticated.status === 200) {
      throw new Error("an unauthenticated request read an invoice document");
    }

    // The API origin is a separate surface; the second tenant must not see the
    // first tenant's invoice through it either.
    const foreignTrpc = await trpcQuery(
      tenantB,
      "inbox.getById",
      {
        id: intakeId,
      },
      API_ORIGIN,
      APP_ORIGIN,
    );
    if (foreignTrpc.status === 200 && foreignTrpc.text.includes(intakeId)) {
      throw new Error("second tenant read another workspace inbox over tRPC");
    }
    const ownTrpc = await trpcQuery(
      tenantA,
      "inbox.getById",
      { id: intakeId },
      API_ORIGIN,
      APP_ORIGIN,
    );
    if (ownTrpc.status !== 200 || !ownTrpc.text.includes(intakeId)) {
      throw new Error(
        `owner could not read their own invoice over tRPC: ${ownTrpc.status} ${ownTrpc.text.slice(0, 200)}`,
      );
    }

    // Durable handoff: the accepted intake queued real product work.
    const { client, query } = await connectDisposableDatabase(E2E_DATABASE);
    try {
      const [job] = await query<{ count: string }>(
        `select count(*)::text as count from workflow_jobs
          where team_id = $1 and payload::text like $2`,
        [tenantA.teamId, `%${intakeId}%`],
      );
      if (Number(job?.count ?? 0) < 1) {
        throw new Error(
          "accepted intake did not queue durable processing work",
        );
      }
      const [foreignJob] = await query<{ count: string }>(
        "select count(*)::text as count from workflow_jobs where team_id = $1",
        [tenantB.teamId],
      );
      if (Number(foreignJob?.count ?? 0) !== 0) {
        throw new Error("second tenant received the first tenant's work");
      }
    } finally {
      await client.end();
    }

    return `preview ${metadata.width}x${metadata.height}; proxy bytes ${proxiedHash.slice(0, 12)} match the original; cross-tenant reads denied`;
  });

  await v.runCheck("e2e:webhook-management-production-egress", async () => {
    if (!tenantA || !tenantB) throw new Error("verification tenants missing");
    // Production refuses private, loopback, link-local and metadata
    // destinations at registration, whatever form the address takes.
    const refused: string[] = [];
    for (const url of [
      "http://localhost:3014/hook",
      "https://127.0.0.1/hook",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/hook",
      "https://[::ffff:169.254.169.254]/hook",
      "https://[fd00:ec2::254]/hook",
      "https://2130706433/hook",
      "https://metadata.google.internal/computeMetadata",
    ]) {
      const created = await trpcMutation(
        tenantA,
        "webhooks.create",
        { url, events: ["invoice.processed"] },
        API_ORIGIN,
        APP_ORIGIN,
      );
      if (created.status === 200) {
        throw new Error(`production accepted a private webhook URL ${url}`);
      }
      refused.push(`${url}=${created.status}`);
    }
    const listed = await trpcQuery(
      tenantA,
      "webhooks.list",
      undefined,
      API_ORIGIN,
      APP_ORIGIN,
    );
    if (listed.status !== 200 || !listed.text.includes("invoice.processed")) {
      throw new Error(`webhooks.list failed: ${listed.status} ${listed.text}`);
    }
    const page = await fetch(`${APP_ORIGIN}/settings/webhooks`, {
      headers: { cookie: tenantA.cookie },
    });
    const html = await page.text();
    if (page.status !== 200 || !html.includes("Add endpoint")) {
      throw new Error(
        `dashboard webhooks page did not render: ${page.status} ${html.slice(0, 200)}`,
      );
    }
    return `owner dashboard /settings/webhooks rendered; production refused ${refused.length} private destinations (${refused.join(", ")})`;
  });

  await v.runCheck("e2e:sole-owner-account-deletion", async () => {
    const password = "VerifyPassword123!";
    // Sign-up provisions exactly one workspace this tenant solely owns.
    const solo = await createTenant(
      "verify-solo",
      E2E_DATABASE,
      password,
      APP_ORIGIN,
    );
    const { client, query } = await connectDisposableDatabase(E2E_DATABASE);
    try {
      const [team] = await query<{ name: string | null }>(
        "select name from teams where id = $1",
        [solo.teamId],
      );
      const confirmName = team?.name?.trim() || "DELETE";

      const blockers = await trpcQuery(
        solo,
        "user.soleOwnedWorkspaces",
        undefined,
        API_ORIGIN,
        APP_ORIGIN,
      );
      if (
        blockers.status !== 200 ||
        !blockers.text.includes(solo.teamId) ||
        !blockers.text.includes('"shared":false')
      ) {
        throw new Error(
          `sole-owned workspace was not offered for deletion: ${blockers.status} ${blockers.text.slice(0, 200)}`,
        );
      }

      const unconfirmed = await trpcMutation(
        solo,
        "user.delete",
        undefined,
        API_ORIGIN,
        APP_ORIGIN,
      );
      if (unconfirmed.status !== 409) {
        throw new Error(
          `account deletion without naming the workspace was not refused: ${unconfirmed.status}`,
        );
      }

      const deleted = await trpcMutation(
        solo,
        "user.delete",
        { deleteWorkspaces: [{ teamId: solo.teamId, confirmName }] },
        API_ORIGIN,
        APP_ORIGIN,
      );
      if (deleted.status !== 200) {
        throw new Error(
          `sole owner could not delete their account: ${deleted.status} ${deleted.text.slice(0, 200)}`,
        );
      }

      const [left] = await query<{ users: string; teams: string }>(
        `select
           (select count(*)::text from users where id = $1) as users,
           (select count(*)::text from teams where id = $2) as teams`,
        [solo.userId, solo.teamId],
      );
      if (left?.users !== "0" || left?.teams !== "0") {
        throw new Error(
          `account or workspace survived deletion: ${JSON.stringify(left)}`,
        );
      }
      const requests = await query<{ subject: string }>(
        "select subject::text from deletion_requests where subject_id in ($1, $2) order by subject",
        [solo.userId, solo.teamId],
      );
      if (
        requests.map((row) => row.subject).join(",") !== "account,workspace"
      ) {
        throw new Error(
          `deletion cleanup was not recorded for both: ${JSON.stringify(requests)}`,
        );
      }
    } finally {
      await client.end();
    }

    // Someone who deleted their last workspace first lands on workspace
    // creation, which must still lead to account deletion.
    const stranded = await createTenant(
      "verify-stranded",
      E2E_DATABASE,
      password,
      APP_ORIGIN,
    );
    const { client: strandedClient, query: strandedQuery } =
      await connectDisposableDatabase(E2E_DATABASE);
    let strandedName: string;
    try {
      const [team] = await strandedQuery<{ name: string | null }>(
        "select name from teams where id = $1",
        [stranded.teamId],
      );
      strandedName = team?.name?.trim() || "DELETE";
    } finally {
      await strandedClient.end();
    }
    const teamDeleted = await trpcMutation(
      stranded,
      "team.delete",
      { teamId: stranded.teamId, confirmName: strandedName },
      API_ORIGIN,
      APP_ORIGIN,
    );
    if (teamDeleted.status !== 200) {
      throw new Error(
        `workspace deletion failed: ${teamDeleted.status} ${teamDeleted.text.slice(0, 200)}`,
      );
    }
    const createPage = await fetch(`${APP_ORIGIN}/teams/create`, {
      headers: { cookie: stranded.cookie },
      redirect: "manual",
    });
    const createHtml = await createPage.text();
    if (
      createPage.status !== 200 ||
      !createHtml.includes("Delete your account")
    ) {
      throw new Error(
        `workspace creation page offers no account deletion: ${createPage.status}`,
      );
    }
    const strandedDeleted = await trpcMutation(
      stranded,
      "user.delete",
      undefined,
      API_ORIGIN,
      APP_ORIGIN,
    );
    if (strandedDeleted.status !== 200) {
      throw new Error(
        `a user with no workspace could not delete their account: ${strandedDeleted.status} ${strandedDeleted.text.slice(0, 200)}`,
      );
    }

    return "sole owner deleted account and workspace in one confirmed call; a user with no workspace reached and completed account deletion";
  });

  await v.runCheck("e2e:worker-executable-lifecycle", async () => {
    const workerOutfile = executablePath(jobsDir, "worker.js");
    await buildExecutable(
      v,
      "e2e:build-worker-executable",
      "./src/worker.ts",
      jobsDir,
      workerOutfile,
      databaseEnv,
    );
    const worker = await ManagedProcess.start(v, "e2e:worker-executable", {
      command: "bun",
      args: ["--no-env-file", workerOutfile],
      cwd: jobsDir,
      env: databaseEnv,
    });
    await worker.waitForOutput("workflow_runner_started", 30_000);
    if (!worker.output.includes("workflow_runner_started")) {
      throw new Error(
        `worker executable did not start the workflow runner: ${worker.output.slice(0, 400)}`,
      );
    }
    await worker.stop();
    return "worker executable claimed the queue and stopped cleanly on SIGTERM";
  });

  await api.stop();
  await dashboard.stop();
  return { intakeId, tenantA: tenantA?.teamId, tenantB: tenantB?.teamId };
}
