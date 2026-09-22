import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStorageClient, createStorageClientFromEnv } from "./storage";

describe("local storage", () => {
  let root: string;
  let storage: ReturnType<typeof createStorageClient>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "invoicewise-storage-test-"));
    storage = createStorageClient({
      backend: "local",
      rootPath: root,
      signingSecret: "test-secret",
      publicUrl: "http://localhost:3003",
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("writes, reads, signs, and removes a file", async () => {
    const path = ["team-id", "inbox", "invoice.pdf"];
    await storage.upload({
      bucket: "vault",
      path,
      file: Buffer.from("invoice"),
    });

    expect(
      await (await storage.download({ bucket: "vault", path })).text(),
    ).toBe("invoice");

    const url = new URL(
      await storage.signedUrl({ bucket: "vault", path, expireIn: 60 }),
    );
    expect(
      storage.verifySignedUrl({
        bucket: "vault",
        path,
        expires: Number(url.searchParams.get("expires")),
        providedSignature: url.searchParams.get("signature")!,
        download: false,
      }),
    ).toBe(true);

    await storage.remove({ bucket: "vault", path });
    expect(storage.download({ bucket: "vault", path })).rejects.toThrow();
  });

  test("rejects paths outside the storage root", async () => {
    await expect(
      storage.upload({
        bucket: "vault",
        path: "../escape",
        file: Buffer.from("x"),
      }),
    ).rejects.toThrow("Invalid storage path");
  });

  test("preserves literal percent characters in file names", async () => {
    const path = ["team-id", "inbox", "invoice-100%.pdf"];
    await storage.upload({
      bucket: "vault",
      path,
      file: Buffer.from("invoice"),
    });

    expect(
      await (await storage.download({ bucket: "vault", path })).text(),
    ).toBe("invoice");
  });

  test("selects the local backend by default", async () => {
    const client = createStorageClientFromEnv({
      LOCAL_STORAGE_PATH: root,
      STORAGE_SIGNING_SECRET: "test-secret",
      STORAGE_PUBLIC_URL: "http://localhost:3003",
    });

    await client.upload({
      bucket: "vault",
      path: "invoice.pdf",
      file: Buffer.from("invoice"),
    });
    expect(
      await (
        await client.download({ bucket: "vault", path: "invoice.pdf" })
      ).text(),
    ).toBe("invoice");
  });

  test("rejects incomplete S3 configuration", () => {
    expect(() =>
      createStorageClientFromEnv({
        STORAGE_BACKEND: "s3",
        STORAGE_SIGNING_SECRET: "test-secret",
      }),
    ).toThrow("STORAGE_S3_ENDPOINT must be configured");
  });
});
