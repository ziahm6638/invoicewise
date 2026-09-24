import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStorageClient, createStorageClientFromEnv } from "./storage";

const inboxId = "11111111-1111-4111-8111-111111111111";

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
      await storage.signedUrl({
        bucket: "vault",
        path,
        expireIn: 60,
        inboxId,
      }),
    );
    expect(url.searchParams.get("inbox")).toBe(inboxId);
    expect(
      storage.verifySignedUrl({
        bucket: "vault",
        path,
        expires: Number(url.searchParams.get("expires")),
        providedSignature: url.searchParams.get("signature")!,
        download: false,
        inboxId,
      }),
    ).toBe(true);

    // A capability minted for one inbox record never authorizes another.
    expect(
      storage.verifySignedUrl({
        bucket: "vault",
        path,
        expires: Number(url.searchParams.get("expires")),
        providedSignature: url.searchParams.get("signature")!,
        download: false,
        inboxId: "22222222-2222-4222-8222-222222222222",
      }),
    ).toBe(false);

    expect(
      storage.verifySignedUrl({
        bucket: "vault",
        path: ["team-id", "inbox", "other.pdf"],
        expires: Number(url.searchParams.get("expires")),
        providedSignature: url.searchParams.get("signature")!,
        download: false,
        inboxId,
      }),
    ).toBe(false);

    await storage.remove({ bucket: "vault", path });
    expect(storage.download({ bucket: "vault", path })).rejects.toThrow();
  });

  test("requires an inbox binding and a bounded expiry for signed URLs", async () => {
    const path = ["team-id", "inbox", "invoice.pdf"];

    expect(
      storage.signedUrl({
        bucket: "vault",
        path,
        expireIn: 60,
        inboxId: "",
      }),
    ).rejects.toThrow("inbox id");

    expect(
      storage.signedUrl({
        bucket: "vault",
        path,
        expireIn: 60 * 60 * 24,
        inboxId,
      }),
    ).rejects.toThrow("may not outlive");

    const expired = await storage.signedUrl({
      bucket: "vault",
      path,
      expireIn: 1,
      inboxId,
    });
    const expiredUrl = new URL(expired);
    expect(
      storage.verifySignedUrl({
        bucket: "vault",
        path,
        expires: Number(expiredUrl.searchParams.get("expires")) - 10,
        providedSignature: expiredUrl.searchParams.get("signature")!,
        download: false,
        inboxId,
      }),
    ).toBe(false);
  });

  test("writes immutably and never replaces an existing object", async () => {
    const path = ["team-id", "inbox", "1111", "object.pdf"];

    const first = await storage.uploadIfAbsent({
      bucket: "vault",
      path,
      file: Buffer.from("original"),
    });
    expect(first.created).toBe(true);

    const second = await storage.uploadIfAbsent({
      bucket: "vault",
      path,
      file: Buffer.from("replacement"),
    });
    expect(second.created).toBe(false);
    expect(
      await (await storage.download({ bucket: "vault", path })).text(),
    ).toBe("original");
  });

  test("honours abort signals on local reads and removals", async () => {
    const path = ["team-id", "inbox", "abort.pdf"];
    await storage.upload({
      bucket: "vault",
      path,
      file: Buffer.from("invoice"),
    });

    const controller = new AbortController();
    controller.abort();

    await expect(
      storage.download({ bucket: "vault", path, signal: controller.signal }),
    ).rejects.toThrow();
    await expect(
      storage.remove({ bucket: "vault", path, signal: controller.signal }),
    ).rejects.toThrow();

    // The aborted removal did not touch the immutable object.
    expect(
      await (await storage.download({ bucket: "vault", path })).text(),
    ).toBe("invoice");
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
