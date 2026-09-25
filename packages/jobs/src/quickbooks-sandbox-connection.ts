/**
 * Operator-only: puts the QuickBooks sandbox company the account owner
 * authorised in Intuit's OAuth playground into the self-hosted Nango as an
 * ordinary connection, so the sandbox proof runs through exactly the path
 * customers use (Nango token refresh and proxy) without a Connect UI sign-in
 * (docs/accounting-integrations.md, "QuickBooks sandbox connection").
 * Customers never reach this: it needs the Infisical `prod` secrets and the
 * Nango secret key, and it refuses an integration that is not
 * `quickbooks-sandbox`, so it can never bind a production company.
 *
 *   infisical run --env prod -- bun run quickbooks:sandbox-connection import <workspace id>
 *   infisical run --env prod -- bun run quickbooks:sandbox-connection sync
 *
 * `import` mints a fresh access token from INTUIT_SANDBOX_REFRESH_TOKEN and
 * imports it (with INTUIT_SANDBOX_REALM_ID) tagged with the workspace that may
 * bind it. Intuit rotates the refresh token on refresh, so every rotated value
 * is written back to Infisical before anything else happens. From then on
 * Nango refreshes the token; `sync` copies Nango's current refresh token back
 * to Infisical so the stored value stays the live one. Tokens pass through
 * mode-600 files that are deleted afterwards and are never printed.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asRecord, getNangoConfig, nangoRequest } from "./nango";

const INTUIT_TOKEN_URL =
  "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const SANDBOX_PROVIDER = "quickbooks-sandbox";
const REPO_ROOT = join(__dirname, "../../..");

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set`);
  return value;
};

/** Writes one secret to Infisical `prod` from a mode-600 file. */
function persistSecret(name: string, value: string) {
  const dir = mkdtempSync(join(tmpdir(), "iw-secret-"));
  const file = join(dir, "value");
  writeFileSync(file, value, { mode: 0o600 });
  const result = spawnSync(
    "infisical",
    ["secrets", "set", `${name}=@${file}`, "--env", "prod", "--silent"],
    { cwd: REPO_ROOT, stdio: ["ignore", "ignore", "pipe"] },
  );
  if (result.status !== 0) {
    // The rotated value exists nowhere else: keep the mode-600 file so the
    // operator can store it by hand, then delete it.
    throw new Error(
      `Writing ${name} to Infisical failed (value kept in ${file}): ${result.stderr.toString().slice(0, 300)}`,
    );
  }
  rmSync(dir, { recursive: true, force: true });
}

/** One sandbox connection; the company ID stays in the connection config. */
const CONNECTION_ID = "quickbooks-sandbox";

async function sandboxConfig() {
  const config = getNangoConfig("quickbooks");
  const integration = asRecord(
    asRecord(
      await nangoRequest(
        config,
        `/integrations/${encodeURIComponent(config.integrationId)}`,
        { method: "GET" },
      ),
    ).data,
  );
  if (integration.provider !== SANDBOX_PROVIDER) {
    throw new Error(
      `Integration ${config.integrationId} is ${String(integration.provider)}, not ${SANDBOX_PROVIDER}; ` +
        "the sandbox connection is only imported into a sandbox integration",
    );
  }
  return config;
}

async function importConnection(workspaceId: string) {
  const config = await sandboxConfig();
  const realmId = required("INTUIT_SANDBOX_REALM_ID");
  const refreshToken = required("INTUIT_SANDBOX_REFRESH_TOKEN");
  const basic = Buffer.from(
    `${required("INTUIT_CLIENT_ID")}:${required("INTUIT_CLIENT_SECRET")}`,
  ).toString("base64");
  const response = await fetch(INTUIT_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  const token = asRecord(await response.json().catch(() => ({})));
  if (
    !response.ok ||
    typeof token.access_token !== "string" ||
    typeof token.refresh_token !== "string"
  ) {
    throw new Error(
      `Intuit refused the refresh (HTTP ${response.status}: ${String(token.error ?? "no error code")})`,
    );
  }
  // Persist first: once Intuit has rotated it, the old value is dead.
  const rotated = token.refresh_token !== refreshToken;
  if (rotated)
    persistSecret("INTUIT_SANDBOX_REFRESH_TOKEN", token.refresh_token);

  const connectionId = CONNECTION_ID;
  await nangoRequest(config, "/connections", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider_config_key: config.integrationId,
      connection_id: connectionId,
      credentials: {
        type: "OAUTH2",
        access_token: token.access_token,
        refresh_token: token.refresh_token,
        expires_at: new Date(
          Date.now() + Number(token.expires_in ?? 3600) * 1000,
        ).toISOString(),
      },
      connection_config: { realmId },
      tags: { workspace_id: workspaceId, origin: "operator-sandbox-import" },
    }),
  });
  return { connectionId, workspaceId, refreshTokenRotated: rotated };
}

async function syncRefreshToken() {
  const config = await sandboxConfig();
  const connectionId = CONNECTION_ID;
  const body = asRecord(
    await nangoRequest(
      config,
      `/connection/${encodeURIComponent(connectionId)}?${new URLSearchParams({
        provider_config_key: config.integrationId,
        // Nango leaves the refresh token out of a connection unless asked.
        refresh_token: "true",
      })}`,
      { method: "GET" },
    ),
  );
  const current = asRecord(body.credentials).refresh_token;
  if (typeof current !== "string" || !current) {
    throw new Error("Nango holds no refresh token for the sandbox connection");
  }
  const changed = current !== process.env.INTUIT_SANDBOX_REFRESH_TOKEN;
  if (changed) persistSecret("INTUIT_SANDBOX_REFRESH_TOKEN", current);
  return { connectionId, infisicalUpdated: changed };
}

const [command, workspaceId] = process.argv.slice(2);
const run =
  command === "import" && workspaceId
    ? importConnection(workspaceId)
    : command === "sync"
      ? syncRefreshToken()
      : null;
if (!run) {
  console.error(
    "usage: quickbooks-sandbox-connection.ts import <workspace id> | sync",
  );
  process.exit(2);
}
run
  .then((result) => console.log(JSON.stringify(result, null, 2)))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
