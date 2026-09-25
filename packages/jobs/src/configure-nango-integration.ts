/**
 * Creates or updates an accounting provider's integration in the self-hosted
 * Nango from the provider app credentials in Infisical, so the integration is
 * reproducible from the secret store rather than clicked together in the
 * Nango dashboard (docs/accounting-integrations.md, "Provider apps and Nango
 * integrations").
 *
 *   infisical run --env prod -- bun run nango:configure-integration quickbooks
 *
 * Reads NANGO_BASE_URL, NANGO_SECRET_KEY, the integration ID
 * (NANGO_<PROVIDER>_INTEGRATION_ID) and the app credentials; QuickBooks also
 * reads QUICKBOOKS_NANGO_PROVIDER (`quickbooks-sandbox` for the Intuit app's
 * development keys, `quickbooks` for its production keys). Prints the
 * integration key, Nango provider and scopes only, never a credential.
 */
import {
  NangoRequestError,
  asRecord,
  getNangoConfig,
  nangoRequest,
} from "./nango";

const PROVIDERS = {
  quickbooks: {
    clientId: "INTUIT_CLIENT_ID",
    clientSecret: "INTUIT_CLIENT_SECRET",
    nangoProviders: ["quickbooks-sandbox", "quickbooks"],
    providerSetting: "QUICKBOOKS_NANGO_PROVIDER",
    scopes: "com.intuit.quickbooks.accounting",
  },
  xero: {
    clientId: "XERO_CLIENT_ID",
    clientSecret: "XERO_CLIENT_SECRET",
    nangoProviders: ["xero"],
    providerSetting: undefined,
    scopes:
      "offline_access accounting.invoices accounting.contacts accounting.attachments",
  },
} as const;

const provider = process.argv[2];
if (provider !== "quickbooks" && provider !== "xero") {
  console.error("usage: configure-nango-integration.ts <quickbooks|xero>");
  process.exit(2);
}

async function main(provider: keyof typeof PROVIDERS) {
  const spec = PROVIDERS[provider];
  const config = getNangoConfig(provider);
  const clientId = process.env[spec.clientId];
  const clientSecret = process.env[spec.clientSecret];
  if (!clientId || !clientSecret) {
    throw new Error(`${spec.clientId} and ${spec.clientSecret} must be set`);
  }
  const nangoProvider =
    (spec.providerSetting && process.env[spec.providerSetting]) ||
    spec.nangoProviders[0];
  if (!(spec.nangoProviders as readonly string[]).includes(nangoProvider)) {
    throw new Error(
      `${spec.providerSetting} must be one of ${spec.nangoProviders.join(", ")}`,
    );
  }
  const credentials = {
    type: "OAUTH2",
    client_id: clientId,
    client_secret: clientSecret,
    scopes: spec.scopes,
  };
  const path = `/integrations/${encodeURIComponent(config.integrationId)}`;

  let existing: Record<string, unknown> | undefined;
  try {
    existing = asRecord(
      asRecord(await nangoRequest(config, path, { method: "GET" })).data,
    );
  } catch (error) {
    if (!(error instanceof NangoRequestError && error.status === 404)) {
      throw error;
    }
  }

  if (!existing) {
    await nangoRequest(config, "/integrations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        unique_key: config.integrationId,
        provider: nangoProvider,
        credentials,
      }),
    });
  } else if (existing.provider !== nangoProvider) {
    // Changing the provider means a new integration, and deleting the old
    // one deletes every connection made under it: an operator decision.
    throw new Error(
      `Integration ${config.integrationId} uses provider ${String(existing.provider)}, not ${nangoProvider}; ` +
        "delete it in the Nango dashboard first (its connections go with it)",
    );
  } else {
    await nangoRequest(config, path, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credentials }),
    });
  }

  const saved = asRecord(
    asRecord(
      await nangoRequest(config, `${path}?include=credentials`, {
        method: "GET",
      }),
    ).data,
  );
  const savedCredentials = asRecord(saved.credentials);
  console.log(
    JSON.stringify(
      {
        integration: saved.unique_key,
        provider: saved.provider,
        action: existing ? "updated" : "created",
        scopes: savedCredentials.scopes ?? null,
        clientIdMatches: savedCredentials.client_id === clientId,
      },
      null,
      2,
    ),
  );
}

main(provider).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
