/**
 * Deploy wiring (config/deploy.yml, the staging destination
 * config/deploy.staging.yml, .kamal/secrets{,.staging} and the role
 * entrypoints' preflight) must stay in step: a secret named in the Kamal
 * config but absent from the secrets file fails the deploy, and a setting the
 * preflight requires but Kamal never provides stops a release from booting.
 * Staging must share nothing stateful with production.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { YAML } from "bun";

const ROOT = join(import.meta.dir, "../..");
const PREFLIGHT = join(ROOT, "scripts/deploy/require-env.sh");

type EnvBlock = { clear?: Record<string, unknown>; secret?: string[] };
type DeployConfig = {
  service: string;
  env: EnvBlock;
  volumes: string[];
  builder: { remote?: string; args?: Record<string, string> };
  servers: Record<
    string,
    {
      hosts: string[];
      env?: EnvBlock;
      options?: Record<string, string>;
      proxy: { host: string; healthcheck?: { path?: string } };
    }
  >;
  accessories: Record<
    string,
    {
      host: string;
      env?: EnvBlock;
      port?: string;
      options?: Record<string, string>;
      directories?: string[];
    }
  >;
};

// A Kamal secret entry is `NAME` or `NAME:SOURCE`: the container sees NAME,
// set from SOURCE in .kamal/secrets.
const secretSource = (entry: string) => entry.split(":").pop()!;
const secretName = (entry: string) => entry.split(":")[0]!;

const readYaml = (path: string) =>
  YAML.parse(readFileSync(join(ROOT, path), "utf8")) as Record<string, unknown>;

/** Kamal's destination merge: hashes merge key by key, anything else replaces. */
const deepMerge = (
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> => {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = merged[key];
    merged[key] =
      isHash(current) && isHash(value) ? deepMerge(current, value) : value;
  }
  return merged;
};
const isHash = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const config = readYaml("config/deploy.yml") as unknown as DeployConfig;
const staging = deepMerge(
  readYaml("config/deploy.yml"),
  readYaml("config/deploy.staging.yml"),
) as unknown as DeployConfig;

const readSecrets = (path: string) =>
  readFileSync(join(ROOT, path), "utf8")
    .split("\n")
    .filter((line) => line.trim() && !line.startsWith("#"))
    .map((line) => line.split("=")[0]);
const kamalSecrets = readSecrets(".kamal/secrets");
const stagingSecrets = readSecrets(".kamal/secrets.staging");

const namedSecrets = (deploy: DeployConfig) =>
  new Set<string>(
    [
      ...(deploy.env.secret ?? []),
      ...Object.values(deploy.servers).flatMap((s) => s.env?.secret ?? []),
      ...Object.values(deploy.accessories).flatMap((a) => a.env?.secret ?? []),
    ].map(secretSource),
  );

// Synthetic stand-ins; the test asserts none of them is ever printed.
const SECRET_VALUE = "synthetic-secret-value-must-not-print";
const ENCRYPTION_KEY = "ab".repeat(32);

/** The environment Kamal gives a role's container, with synthetic secrets. */
function roleEnv(
  role: string,
  deploy: DeployConfig = config,
): Record<string, string> {
  const blocks = [deploy.env, deploy.servers[role]?.env ?? {}];
  const env: Record<string, string> = {};
  for (const block of blocks) {
    for (const [key, value] of Object.entries(block.clear ?? {})) {
      env[key] = String(value);
    }
    for (const key of (block.secret ?? []).map(secretName)) {
      env[key] =
        key === "MIDDAY_ENCRYPTION_KEY" ? ENCRYPTION_KEY : SECRET_VALUE;
    }
  }
  return env;
}

function preflight(role: string, env: Record<string, string>) {
  const result = Bun.spawnSync(["sh", PREFLIGHT, role], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
  });
  return {
    exitCode: result.exitCode,
    output: `${result.stdout.toString()}${result.stderr.toString()}`,
  };
}

const ROLES = Object.keys(config.servers);

describe("deploy config", () => {
  test("serves the web and api roles", () => {
    expect(ROLES.sort()).toEqual(["api", "web"]);
  });

  test(".kamal/secrets lists exactly the secrets the config names", () => {
    expect([...kamalSecrets].sort()).toEqual([...namedSecrets(config)].sort());
  });

  test(".kamal/secrets.staging lists exactly the staging secrets", () => {
    expect([...stagingSecrets].sort()).toEqual(
      [...namedSecrets(staging)].sort(),
    );
  });

  test("bounds every role's memory and gates the API on readiness", () => {
    expect(config.servers.web?.options?.memory).toBe("1g");
    expect(config.servers.api?.options?.memory).toBe("2g");
    expect(config.servers.api?.proxy.healthcheck?.path).toBe("/health/ready");
    expect(config.servers.api?.env?.secret).toContain("OPS_TOKEN");
    expect(roleEnv("api").DATABASE_POOL_MAX).toBe("8");
    expect(Number(roleEnv("api").TYPESAFE_DAILY_CALL_LIMIT)).toBeGreaterThan(0);
  });

  test("never sets a secret in clear", () => {
    for (const block of [
      config.env,
      ...Object.values(config.servers).map((s) => s.env ?? {}),
    ]) {
      for (const key of Object.keys(block.clear ?? {})) {
        expect(kamalSecrets).not.toContain(key);
      }
    }
  });
});

describe("staging destination", () => {
  const productionHosts = new Set([
    ...Object.values(config.servers).flatMap((server) => server.hosts),
    ...Object.values(config.accessories).map((accessory) => accessory.host),
  ]);

  test("runs on its own host, service, storage and data directories", () => {
    expect(staging.service).not.toBe(config.service);
    for (const server of Object.values(staging.servers)) {
      for (const host of server.hosts) {
        expect(productionHosts.has(host)).toBe(false);
      }
    }
    for (const [name, accessory] of Object.entries(staging.accessories)) {
      expect(productionHosts.has(accessory.host)).toBe(false);
      for (const directory of accessory.directories ?? []) {
        expect(config.accessories[name]?.directories ?? []).not.toContain(
          directory,
        );
      }
    }
    expect(staging.volumes).not.toEqual(config.volumes);
    expect(staging.builder.remote).not.toBe(config.builder.remote);
  });

  test("serves only staging origins on a cookie domain production does not share", () => {
    const productionProxyHosts = Object.values(config.servers).map(
      (server) => server.proxy.host,
    );
    for (const role of ["web", "api"]) {
      const env = roleEnv(role, staging);
      expect(env.INVOICEWISE_ENVIRONMENT).toBe("staging");
      const cookieDomain = env.BETTER_AUTH_COOKIE_DOMAIN!.replace(/^\./, "");
      expect(cookieDomain).toBe("zzapp.uk");
      for (const host of productionProxyHosts) {
        expect(host === cookieDomain || host.endsWith(`.${cookieDomain}`)).toBe(
          false,
        );
      }
      for (const value of Object.values(env)) {
        if (!value.startsWith("https://")) continue;
        expect(new URL(value).hostname).not.toEndWith("invoicewise.uk");
      }
      expect(env.REDIS_URL).toContain("invoicewise-staging-redis");
    }
    expect(roleEnv("api", staging).NANGO_BASE_URL).toBe(
      "http://invoicewise-staging-nango:3003",
    );
    expect(Object.values(staging.builder.args ?? {}).join(" ")).not.toContain(
      "invoicewise.uk",
    );
    expect(staging.servers.web?.proxy.host).toBe("iw-staging-app.zzapp.uk");
    expect(staging.servers.api?.proxy.host).toBe("iw-staging-api.zzapp.uk");
  });

  for (const role of ["web", "api"]) {
    test(`${role}: the staging config satisfies the preflight`, () => {
      const result = preflight(role, roleEnv(role, staging));
      expect(result.output).toBe("");
      expect(result.exitCode).toBe(0);
    });
  }

  test("refuses a staging cookie domain that reaches production hosts", () => {
    for (const domain of [
      "",
      ".invoicewise.uk",
      "invoicewise.uk",
      ".INVOICEWISE.UK",
      ".uk",
      "app.invoicewise.uk",
    ]) {
      const result = preflight("web", {
        ...roleEnv("web", staging),
        BETTER_AUTH_COOKIE_DOMAIN: domain,
      });
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("BETTER_AUTH_COOKIE_DOMAIN");
    }
  });
});

describe("self-hosted Nango", () => {
  const nango = config.accessories.nango!;
  const api = roleEnv("api");

  test("the API reaches the Nango accessory, never Nango Cloud", () => {
    expect(api.NANGO_BASE_URL).toBe(
      `http://invoicewise-nango:${nango.env?.clear?.SERVER_PORT}`,
    );
    expect(api.NANGO_PUBLIC_URL).toBe(
      String(nango.env?.clear?.NANGO_SERVER_URL),
    );
    expect(Object.values(api).join(" ")).not.toContain("nango.dev");
  });

  test("the API key is the Nango prod environment secret key", () => {
    expect(nango.env?.secret).toContain(
      "NANGO_SECRET_KEY_PROD:NANGO_SECRET_KEY",
    );
    expect(config.servers.api?.env?.secret).toContain("NANGO_SECRET_KEY");
  });

  test("publishes Nango on loopback only, behind the tunnel", () => {
    expect(nango.port).toStartWith("127.0.0.1:");
    expect(nango.options?.publish).toStartWith("127.0.0.1:");
  });
});

describe("production preflight", () => {
  for (const role of ["web", "api"]) {
    test(`${role}: the Kamal config satisfies it`, () => {
      const result = preflight(role, roleEnv(role));
      expect(result.output).toBe("");
      expect(result.exitCode).toBe(0);
    });

    test(`${role}: refuses each missing setting by name only`, () => {
      const full = roleEnv(role);
      for (const name of Object.keys(full)) {
        const { [name]: _removed, ...env } = full;
        const result = preflight(role, env);
        if (result.exitCode === 0) continue; // optional for this role
        expect(result.exitCode).toBe(1);
        expect(result.output).toContain(name);
        expect(result.output).not.toContain(SECRET_VALUE);
        expect(result.output).not.toContain(ENCRYPTION_KEY);
      }
    });
  }

  test("api requires the TypeSafe key; web does not", () => {
    const { TYPESAFE_API_KEY: _key, ...api } = roleEnv("api");
    const refused = preflight("api", api);
    expect(refused.exitCode).toBe(1);
    expect(refused.output).toContain("TYPESAFE_API_KEY");
    expect(roleEnv("web").TYPESAFE_API_KEY).toBeUndefined();
  });

  test("empty values count as missing", () => {
    const result = preflight("api", { ...roleEnv("api"), SMTP_PASS: "" });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("SMTP_PASS");
  });

  test("local storage requires a persistent path", () => {
    const { LOCAL_STORAGE_PATH: _path, ...env } = roleEnv("web");
    const result = preflight("web", env);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("LOCAL_STORAGE_PATH");
  });

  test("refuses a non-production NODE_ENV", () => {
    const result = preflight("api", {
      ...roleEnv("api"),
      NODE_ENV: "development",
    });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("NODE_ENV must be production");
  });

  test("refuses a malformed encryption key without printing it", () => {
    const badKey = "not-a-hex-key-synthetic";
    const result = preflight("web", {
      ...roleEnv("web"),
      MIDDAY_ENCRYPTION_KEY: badKey,
    });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("MIDDAY_ENCRYPTION_KEY");
    expect(result.output).not.toContain(badKey);
  });

  test("refuses malformed bounds, plain-http origins and a short ops token", () => {
    for (const [name, value, message] of [
      ["DATABASE_POOL_MAX", "0", "DATABASE_POOL_MAX must be a positive"],
      [
        "WORKFLOW_CONCURRENCY",
        "four",
        "WORKFLOW_CONCURRENCY must be a positive",
      ],
      [
        "TYPESAFE_DAILY_CALL_LIMIT",
        "1e3",
        "TYPESAFE_DAILY_CALL_LIMIT must be a positive",
      ],
      [
        "BETTER_AUTH_URL",
        "http://app.invoicewise.uk",
        "BETTER_AUTH_URL must be an https URL",
      ],
      ["OPS_TOKEN", "short-synthetic", "OPS_TOKEN must be at least 32"],
      ["INVOICEWISE_ENVIRONMENT", "prod", "INVOICEWISE_ENVIRONMENT must be"],
    ] as const) {
      const result = preflight("api", { ...roleEnv("api"), [name]: value });
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain(message);
      expect(result.output).not.toContain("short-synthetic");
    }
  });

  test("rejects an unknown role", () => {
    expect(preflight("worker", roleEnv("api")).exitCode).toBe(2);
  });
});

// The marketing site (Vercel, root apps/website) is built through Turbo, whose
// strict env mode hands a task only the variables it declares. A build-time
// setting missing from the declaration is silently dropped, as
// INBOUND_EMAIL_LIVE was: the site kept saying the mailbox was "coming soon"
// after the flag was set in Vercel (docs/inbound-email.md#going-live).
describe("website build environment", () => {
  test("Turbo passes the website's build-time settings to its build", () => {
    const result = Bun.spawnSync(
      [
        "bun",
        "--no-env-file",
        "x",
        "turbo",
        "run",
        "build",
        "--filter=@invoicewise/website",
        "--dry=json",
      ],
      { cwd: ROOT, env: { ...process.env, TURBO_TELEMETRY_DISABLED: "1" } },
    );
    expect(result.exitCode).toBe(0);
    const plan = JSON.parse(result.stdout.toString()) as {
      envMode: string;
      tasks: {
        taskId: string;
        environmentVariables: { specified: { passThroughEnv: string[] } };
      }[];
    };
    const build = plan.tasks.find(
      ({ taskId }) => taskId === "@invoicewise/website#build",
    );
    expect(build).toBeDefined();
    expect(build!.environmentVariables.specified.passThroughEnv).toContain(
      "INBOUND_EMAIL_LIVE",
    );
  });
});
