import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  download,
  remove,
  signedUrl,
  upload,
  verifySignedUrl,
} from "./storage";

describe("local storage", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "invoicewise-storage-test-"));
    process.env.LOCAL_STORAGE_PATH = root;
    process.env.LOCAL_STORAGE_SIGNING_SECRET = "test-secret";
    process.env.STORAGE_PUBLIC_URL = "http://localhost:3003";
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("writes, reads, signs, and removes a file", async () => {
    const path = ["team-id", "inbox", "invoice.pdf"];
    await upload({ bucket: "vault", path, file: Buffer.from("invoice") });

    expect(await (await download({ bucket: "vault", path })).text()).toBe(
      "invoice",
    );

    const url = new URL(
      await signedUrl({ bucket: "vault", path, expireIn: 60 }),
    );
    expect(
      verifySignedUrl({
        bucket: "vault",
        path,
        expires: Number(url.searchParams.get("expires")),
        providedSignature: url.searchParams.get("signature")!,
        download: false,
      }),
    ).toBe(true);

    await remove({ bucket: "vault", path });
    expect(download({ bucket: "vault", path })).rejects.toThrow();
  });

  test("rejects paths outside the storage root", async () => {
    await expect(
      upload({ bucket: "vault", path: "../escape", file: Buffer.from("x") }),
    ).rejects.toThrow("Invalid storage path");
  });

  test("preserves literal percent characters in file names", async () => {
    const path = ["team-id", "inbox", "invoice-100%.pdf"];
    await upload({ bucket: "vault", path, file: Buffer.from("invoice") });

    expect(await (await download({ bucket: "vault", path })).text()).toBe(
      "invoice",
    );
  });
});
