/**
 * Negative controls for the verification tooling itself.
 *
 * These tests fail if a guard, parser or scanner silently passes something it
 * should reject, which is the failure mode that would make a green
 * verification run meaningless.
 */

import { afterAll, describe, expect, test } from "bun:test";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertTransactionalMailConfigured,
  sendTransactionalSmtp,
} from "../../packages/utils/src/transactional-mail";
import {
  buildRangeProbe,
  diffMismatches,
  parseMismatches,
} from "./dependency-ranges";
import {
  ARTIFACTS_ROOT,
  Verification,
  VerificationAborted,
  assertDisposableDatabaseName,
  assertLoopbackUrl,
  assertSyntheticEnvironment,
  createIsolatedWorkspace,
  redact,
  setProviderStubBaseUrl,
  setSmtpTrapPort,
  startProviderTrap,
  startSmtpTrap,
  syntheticEnv,
} from "./lib";
import {
  RETIRED_MATCHING_EXPECTED_FAILURES,
  parseRetiredMatchingOutcome,
} from "./scopes";
import {
  SECRET_EXCEPTIONS,
  candidateFiles,
  scanContentForSecrets,
  scanFiles,
  scanRepository,
} from "./security";

const created: string[] = [];

async function tempDir(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

afterAll(async () => {
  for (const dir of created) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("safety guards", () => {
  test("rejects protected, unknown and public targets", () => {
    for (const name of ["invoicewise", "postgres", "template0", "appdb"]) {
      expect(() => assertDisposableDatabaseName(name)).toThrow();
    }
    expect(assertDisposableDatabaseName("invoicewise_x_test")).toBe(
      "invoicewise_x_test",
    );

    for (const url of [
      "https://api.resend.com",
      "https://api.typesafe.ai",
      "http://db.internal:5432",
    ]) {
      expect(() => assertLoopbackUrl("probe", url)).toThrow();
    }
    expect(() =>
      assertLoopbackUrl("probe", "http://127.0.0.1:9000"),
    ).not.toThrow();
  });

  test("blocks provider keys and pins provider base URLs to loopback", () => {
    const built = syntheticEnv();
    expect(() => assertSyntheticEnvironment(built)).not.toThrow();
    expect(built.POLAR_SERVER_URL).toMatch(/^http:\/\/127\.0\.0\.1/);
    expect(built.SMTP_HOST).toBe("127.0.0.1");
    expect(built.RESEND_API_KEY).toBe("");
    expect(built.NEXT_PUBLIC_SUPABASE_URL).toBe("");
    expect(built.DATABASE_FRA_URL).toBe("");

    // A real-looking value for a blocked key must fail the guard.
    expect(() =>
      assertSyntheticEnvironment({
        ...built,
        NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co",
      }),
    ).toThrow();
    expect(() =>
      assertSyntheticEnvironment({
        ...built,
        POLAR_SERVER_URL: "https://api.polar.sh",
      }),
    ).toThrow();
    expect(() => setProviderStubBaseUrl("https://api.nango.dev")).toThrow();
  });

  test("pins transactional mail to the loopback SMTP trap", () => {
    const built = syntheticEnv();

    const overrides: Record<string, string>[] = [
      { SMTP_HOST: "smtp.purelymail.com" },
      { SMTP_HOST: "" },
      { SMTP_PORT: "" },
      { SMTP_PASS: "a-real-looking-smtp-password" },
      { RESEND_API_KEY: "re_liveabcdefghijklmnopqrst" },
    ];
    for (const override of overrides) {
      expect(() =>
        assertSyntheticEnvironment({ ...built, ...override }),
      ).toThrow();
    }
  });

  test("redacts live-looking credentials from captured output", () => {
    const output = redact(
      "key re_ABCDEFGHIJKLMNOPQRSTUV token polar_live_abcdefghij Bearer abcdefghijklmnopqrstuvwx postgresql://invoicewise:supersecret@localhost:5432/db",
    );
    expect(output).not.toContain("re_ABCDEFGHIJKLMNOPQRSTUV");
    expect(output).not.toContain("polar_live_abcdefghij");
    expect(output).not.toContain("supersecret");
  });

  test("requireCheck aborts instead of continuing after a failed guard", async () => {
    const v = new Verification(`selftest-${crypto.randomUUID()}`);
    await mkdir(v.artifactsDir, { recursive: true });
    await mkdir(v.tmpDir, { recursive: true });

    await expect(
      v.requireCheck("selftest:rejected-target", async () => {
        throw new Error("rejected target");
      }),
    ).rejects.toBeInstanceOf(VerificationAborted);

    expect(v.failures).toHaveLength(1);
    expect(v.results[0]?.ok).toBe(false);
    await rm(v.artifactsDir, { recursive: true, force: true });
  });
});

describe("isolated workspace", () => {
  test("excludes dotenv files but links the working tree", async () => {
    const source = await tempDir("verify-overlay-source-");
    await mkdir(join(source, "apps", "app"), { recursive: true });
    await writeFile(join(source, ".env"), "ROOT_CANARY=1\n");
    await writeFile(
      join(source, "apps", "app", ".env.production.local"),
      "APP_CANARY=1\n",
    );
    await writeFile(join(source, "apps", "app", "keep.txt"), "keep\n");
    await writeFile(join(source, "package.json"), "{}\n");

    const target = await tempDir("verify-overlay-target-");
    const overlay = createIsolatedWorkspace(join(target, "workspace"), source);

    expect([...overlay.skippedEnvFiles].sort()).toEqual(
      [".env", join("apps", "app", ".env.production.local")].sort(),
    );
    expect(
      await readFile(join(overlay.root, "apps", "app", "keep.txt"), "utf8"),
    ).toBe("keep\n");
    expect(await Bun.file(join(overlay.root, ".env")).exists()).toBe(false);
    expect(
      await Bun.file(
        join(overlay.root, "apps", "app", ".env.production.local"),
      ).exists(),
    ).toBe(false);
    expect(overlay.linkedEntries).toBeGreaterThanOrEqual(2);
  });
});

describe("provider trap", () => {
  test("records loopback requests and answers", async () => {
    const trap = startProviderTrap();
    try {
      expect(trap.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const response = await fetch(`${trap.origin}/emails`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ id: "verify-stub-1" });
      expect(trap.requests).toHaveLength(1);
      expect(trap.requests[0]?.path).toBe("/emails");
    } finally {
      trap.stop();
    }
  });
});

describe("SMTP trap", () => {
  test("receives production-mode mail sent with the synthetic environment", async () => {
    const trap = await startSmtpTrap();
    try {
      setSmtpTrapPort(trap.port);
      const env = syntheticEnv({
        NODE_ENV: "production",
        AUTH_MAIL_SINK_PATH: join(tmpdir(), "verify-sink-ignored.jsonl"),
      });
      expect(() => assertSyntheticEnvironment(env)).not.toThrow();
      expect(() => assertTransactionalMailConfigured(env)).not.toThrow();

      await sendTransactionalSmtp(
        {
          to: "tenant@example.test",
          subject: "Verify your InvoiceWise email",
          text: "Synthetic verification probe",
        },
        env,
      );

      expect(trap.connections).toBe(1);
      expect(trap.messages).toHaveLength(1);
      expect(trap.messages[0]?.from).toBe(env.AUTH_EMAIL_FROM);
      expect(trap.messages[0]?.recipients).toEqual(["tenant@example.test"]);
    } finally {
      setSmtpTrapPort(9);
      await trap.stop();
    }
  });
});

describe("hard abort", () => {
  test("a rejected target aborts before any later step and never leaks the value", async () => {
    // Synthetic credential-shaped marker: it must not appear in stdout,
    // stderr or the serialized summary.
    const marker = `re_${"A".repeat(24)}`;
    const child = Bun.spawn({
      cmd: [
        "bun",
        "--no-env-file",
        join("scripts", "verify", "release.ts"),
        "--preflight-only",
      ],
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        TMPDIR: process.env.TMPDIR ?? "/tmp",
        // Non-loopback target: the guard must reject it.
        VERIFY_REDIS_URL: `invalid ${marker}`,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const exitCode = await child.exited;
    const output = `${stdout}${stderr}`;

    expect(exitCode).not.toBe(0);
    expect(output).toContain("[abort]");
    expect(output).toContain("preflight:isolated-synthetic-environment");
    expect(output).not.toContain(marker);

    const artifactsDir = output.match(/artifacts in (\S+)/)?.[1];
    expect(artifactsDir).toBeTruthy();
    const summaryText = await Bun.file(
      join(artifactsDir!, "summary.json"),
    ).text();
    expect(summaryText).not.toContain(marker);
    const summary = JSON.parse(summaryText);

    expect(summary.aborted?.step).toBe(
      "preflight:isolated-synthetic-environment",
    );
    const stepNames = summary.steps.map((step: { name: string }) => step.name);
    expect(stepNames).toEqual(["preflight:isolated-synthetic-environment"]);
    expect(
      stepNames.some((name: string) => name.startsWith("migrations:")),
    ).toBe(false);

    await rm(artifactsDir!, { recursive: true, force: true });
  }, 120_000);
});

describe("secret-scanner fail-closed", () => {
  test("fails when Git enumeration is unavailable", async () => {
    const outsideGit = await tempDir("verify-not-a-repo-");
    expect(() => candidateFiles(outsideGit)).toThrow();
    await expect(scanRepository(outsideGit)).rejects.toThrow();
  });

  test("fails on missing and unreadable candidate paths", async () => {
    const root = await tempDir("verify-scan-root-");
    await mkdir(join(root, "candidate-dir"), { recursive: true });
    const unreadable = join(root, "unreadable.env");
    await writeFile(unreadable, "SYNTHETIC=1\n");
    await chmod(unreadable, 0o000);

    await expect(scanFiles(root, ["missing.ts"])).rejects.toThrow(
      /missing from the worktree/,
    );
    await expect(scanFiles(root, ["candidate-dir"])).rejects.toThrow(
      /is not a regular file/,
    );
    await expect(scanFiles(root, ["unreadable.env"])).rejects.toThrow(
      /could not read candidate file/,
    );
    await chmod(unreadable, 0o600);
  });
});

describe("dependency-range exceptions", () => {
  const output = [
    "\u001b[0m☔️ error @invoicewise/api has a dependency on @types/bun@^1.2.16 but the most common range in the repo is ^1.2.21, the range should be set to ^1.2.21",
    "☔️ success workspaces valid!",
  ].join("\n");

  test("parses exact workspace/dependency/range identities", () => {
    expect(parseMismatches(output)).toEqual([
      {
        workspace: "@invoicewise/api",
        dependency: "@types/bun",
        range: "^1.2.16",
        mostCommonRange: "^1.2.21",
      },
    ]);
  });

  test("fails on an unrelated or changed mismatch and on stale exceptions", () => {
    const found = parseMismatches(output);
    const exceptions = found.map((mismatch) => ({ ...mismatch, reason: "t" }));

    expect(diffMismatches(found, exceptions)).toEqual({
      unexpected: [],
      missing: [],
    });

    const withExtra = [
      ...found,
      {
        workspace: "@invoicewise/website",
        dependency: "left-pad",
        range: "1.0.0",
        mostCommonRange: "2.0.0",
      },
      {
        workspace: "@invoicewise/api",
        dependency: "@types/bun",
        range: "^1.1.0",
        mostCommonRange: "^1.2.21",
      },
    ];
    const drifted = diffMismatches(withExtra, exceptions);
    expect(drifted.unexpected).toHaveLength(2);
    expect(drifted.missing).toHaveLength(0);

    expect(diffMismatches([], exceptions).missing).toHaveLength(1);
  });

  test("the repo manypkg configuration waives only external range mismatches", async () => {
    const probe = await mkdtemp(join(tmpdir(), "manypkg-waiver-"));
    const manypkg = (cwd: string) => {
      const run = Bun.spawnSync(
        [join(process.cwd(), "node_modules", ".bin", "manypkg"), "check"],
        { cwd, stdout: "pipe", stderr: "pipe" },
      );
      return {
        exitCode: run.exitCode,
        output:
          new TextDecoder().decode(run.stdout) +
          new TextDecoder().decode(run.stderr),
      };
    };
    try {
      await buildRangeProbe(process.cwd(), probe);

      // Without the waiver the recorded external mismatches are reported.
      const unwaived = manypkg(probe);
      expect(unwaived.exitCode).not.toBe(0);
      expect(parseMismatches(unwaived.output).length).toBeGreaterThan(0);

      // With the repository configuration the same manifests pass.
      await copyFile(
        join(process.cwd(), "package.json"),
        join(probe, "package.json"),
      );
      expect(manypkg(probe).exitCode).toBe(0);

      // Every other rule is still enforced under that configuration.
      const apiManifestPath = join(probe, "apps", "api", "package.json");
      const apiManifest = JSON.parse(await readFile(apiManifestPath, "utf8"));
      apiManifest.dependencies["@invoicewise/db"] = "0.0.1";
      await writeFile(apiManifestPath, JSON.stringify(apiManifest, null, 2));
      const internal = manypkg(probe);
      expect(internal.exitCode).not.toBe(0);
      expect(internal.output).toContain("@invoicewise/db");
    } finally {
      await rm(probe, { recursive: true, force: true });
    }
  });
});

describe("secret scanner", () => {
  test("detects live-shaped credentials even when the value contains 'test'", () => {
    const resendLike = "re_testabcdefghijklmnopqrst";
    const assigned = 'api_key = "test_abcdefghijklmnopqrstuvwx"';
    const providerHits = scanContentForSecrets(
      "tmp/probe.env",
      `RESEND_API_KEY=${resendLike}`,
    );
    expect(providerHits.length).toBeGreaterThan(0);
    expect(providerHits.map((hit) => hit.pattern)).toContain("resend-key");
    expect(scanContentForSecrets("tmp/probe.ts", assigned)).toHaveLength(1);
  });

  test("detects generic secrets assigned to credential-named variables", () => {
    const value = ["Q8vN2kL7", "pR4tX9zB", "1mC6wY3h"].join("");
    for (const name of [
      "BETTER_AUTH_SECRET",
      "STORAGE_SIGNING_SECRET",
      "MIDDAY_ENCRYPTION_KEY",
      "POLAR_WEBHOOK_SECRET",
      "NANGO_SECRET_KEY",
      "STORAGE_S3_SECRET_ACCESS_KEY",
    ]) {
      const hits = scanContentForSecrets(
        "apps/api/.env-template",
        `${name}=${value}`,
      );
      expect(hits.map((hit) => hit.pattern)).toContain("env-credential");
      expect(
        scanContentForSecrets("tmp/probe.yml", `  ${name}: "${value}"`),
      ).toHaveLength(1);
    }

    // References to other variables are not credentials.
    expect(
      scanContentForSecrets(
        "tmp/probe.ts",
        "  STORAGE_S3_SECRET_ACCESS_KEY: LOCAL_MINIO_SECRET_KEY,",
      ),
    ).toHaveLength(0);
  });

  test("only waives exact fixture path/value pairs", () => {
    const exception = SECRET_EXCEPTIONS[0]!;
    expect(
      scanContentForSecrets(
        exception.path,
        `BETTER_AUTH_SECRET=${exception.value}`,
      ),
    ).toHaveLength(0);

    // Same path, different (live-shaped) value must still fail.
    expect(
      scanContentForSecrets(
        exception.path,
        "BETTER_AUTH_SECRET=re_liveabcdefghijklmnop",
      ).length,
    ).toBeGreaterThan(0);

    // Template-looking path with an unlisted value must still fail.
    expect(
      scanContentForSecrets(
        "apps/api/.env-template",
        "RESEND_API_KEY=re_liveabcdefghijklmnopqrst",
      ).length,
    ).toBeGreaterThan(0);
  });

  test("reports location and pattern without exposing the value", () => {
    const value = "re_testabcdefghijklmnopqrst";
    const hits = scanContentForSecrets("tmp/probe.env", `RESEND=${value}`);
    expect(hits).toHaveLength(1);
    const hit = hits[0]!;
    expect(hit.path).toBe("tmp/probe.env");
    expect(hit.line).toBe(1);
    expect(hit.pattern).toBe("resend-key");
    expect(Object.values(hit).join(" ")).not.toContain(value);
  });
});

describe("retired-scope parsing", () => {
  const completed = [
    ...RETIRED_MATCHING_EXPECTED_FAILURES.map(
      (name) => `(fail) ${name} [0.1ms]`,
    ),
    " 3 fail",
    "Ran 25 tests across 1 file.",
  ].join("\n");

  test("accepts only the recorded completed failure set", () => {
    expect(parseRetiredMatchingOutcome(completed)).toEqual({
      ok: true,
      failures: 3,
    });
  });

  test("rejects crashed, missing and changed runs instead of reading zero", () => {
    expect(parseRetiredMatchingOutcome("error: no test files found").ok).toBe(
      false,
    );
    expect(
      parseRetiredMatchingOutcome("0 tests failed\nRan 1 test across 1 file.")
        .ok,
    ).toBe(false);
    expect(
      parseRetiredMatchingOutcome(`${completed}\n(fail) suite > extra [0.1ms]`)
        .ok,
    ).toBe(false);
  });

  test("rejects a swapped failure even when the count is unchanged", () => {
    const swapped = [
      ...RETIRED_MATCHING_EXPECTED_FAILURES.slice(1).map(
        (name) => `(fail) ${name} [0.1ms]`,
      ),
      "(fail) Cross-Currency Matching Algorithm > another case [0.1ms]",
      " 3 fail",
      "Ran 25 tests across 1 file.",
    ].join("\n");
    const outcome = parseRetiredMatchingOutcome(swapped);
    expect(outcome.ok).toBe(false);
  });

  test("the recorded failures match a real run of the retired suite", () => {
    const run = Bun.spawnSync(
      ["bun", "--no-env-file", "test", "src/test/transaction-matching.test.ts"],
      {
        cwd: join(process.cwd(), "packages", "db"),
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    const output =
      new TextDecoder().decode(run.stdout) +
      new TextDecoder().decode(run.stderr);
    expect(parseRetiredMatchingOutcome(output)).toEqual({
      ok: true,
      failures: RETIRED_MATCHING_EXPECTED_FAILURES.length,
    });
  });
});
