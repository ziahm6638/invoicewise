import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { S3_UPLOAD_PART_BYTES, createStorageClientFromEnv } from "./storage";

const integrationTest = process.env.STORAGE_S3_INTEGRATION ? test : test.skip;

describe("S3-compatible storage", () => {
  integrationTest(
    "uploads, replaces, signs, downloads, and removes one private object",
    async () => {
      const storage = createStorageClientFromEnv();
      const path = ["storage-test", crypto.randomUUID(), "invoice.pdf"];
      const input = { bucket: "vault", path };
      const pdf = await readFile(
        resolve(
          __dirname,
          "../../documents/src/test/fixtures/synthetic-invoice.pdf",
        ),
      );

      try {
        await storage.upload({ ...input, file: Buffer.from("stale") });
        await storage.upload({ ...input, file: pdf });

        const downloaded = Buffer.from(
          await (await storage.download(input)).arrayBuffer(),
        );
        expect(createHash("sha256").update(downloaded).digest("hex")).toBe(
          createHash("sha256").update(pdf).digest("hex"),
        );
        const signed = new URL(
          await storage.signedUrl({
            ...input,
            expireIn: 60,
            inboxId: "11111111-1111-4111-8111-111111111111",
          }),
        );
        expect(
          storage.verifySignedUrl({
            ...input,
            expires: Number(signed.searchParams.get("expires")),
            providedSignature: signed.searchParams.get("signature") ?? "",
            download: false,
            inboxId: "11111111-1111-4111-8111-111111111111",
          }),
        ).toBe(true);
        expect(
          storage.verifySignedUrl({
            ...input,
            expires: Number(signed.searchParams.get("expires")),
            providedSignature: signed.searchParams.get("signature") ?? "",
            download: false,
            inboxId: "22222222-2222-4222-8222-222222222222",
          }),
        ).toBe(false);

        // A second immutable write must not replace the stored object.
        const immutableInput = {
          bucket: "vault",
          path: [...path.slice(0, -1), "immutable.pdf"],
        };
        const firstWrite = await storage.uploadIfAbsent({
          ...immutableInput,
          file: Buffer.from("first"),
        });
        const secondWrite = await storage.uploadIfAbsent({
          ...immutableInput,
          file: Buffer.from("second"),
        });
        expect(firstWrite.created).toBe(true);
        expect(secondWrite.created).toBe(false);
        expect(
          Buffer.from(
            await (await storage.download(immutableInput)).arrayBuffer(),
          ).toString("utf8"),
        ).toBe("first");
        await storage.remove(immutableInput);

        const s3 = new S3Client({
          endpoint: process.env.STORAGE_S3_ENDPOINT,
          region: process.env.STORAGE_S3_REGION ?? "auto",
          forcePathStyle: process.env.STORAGE_S3_FORCE_PATH_STYLE === "true",
          credentials: {
            accessKeyId: process.env.STORAGE_S3_ACCESS_KEY_ID!,
            secretAccessKey: process.env.STORAGE_S3_SECRET_ACCESS_KEY!,
          },
        });
        const listed = await s3.send(
          new ListObjectsV2Command({
            Bucket: process.env.STORAGE_S3_BUCKET,
            Prefix: `vault/${path.join("/")}`,
          }),
        );
        expect(listed.KeyCount).toBe(1);
      } finally {
        await storage.remove(input);
      }

      expect(storage.download(input)).rejects.toThrow();
    },
  );

  integrationTest(
    "removes a workspace prefix across pages without touching a sibling",
    async () => {
      const storage = createStorageClientFromEnv();
      const run = `storage-prefix-test-${crypto.randomUUID()}`;
      const target = [run, "workspace"];
      const sibling = [run, "workspace-sibling"];
      // A few objects keep the run fast: removal lists again after every
      // batch, so one batch and many take the same path.
      const targetPaths = Array.from({ length: 25 }, (_, index) => [
        ...target,
        "documents",
        String(index),
        "invoice.pdf",
      ]);
      const siblingPath = [...sibling, "documents", "0", "invoice.pdf"];

      try {
        for (const path of [...targetPaths, siblingPath]) {
          await storage.upload({
            bucket: "vault",
            path,
            file: Buffer.from("x"),
          });
        }

        await storage.removePrefix({ bucket: "vault", prefix: target });
        await storage.removePrefix({ bucket: "vault", prefix: target });

        for (const path of targetPaths) {
          await expect(
            storage.download({ bucket: "vault", path }),
          ).rejects.toThrow();
        }
        expect(
          Buffer.from(
            await (
              await storage.download({ bucket: "vault", path: siblingPath })
            ).arrayBuffer(),
          ).toString("utf8"),
        ).toBe("x");
      } finally {
        await storage.removePrefix({ bucket: "vault", prefix: [run] });
      }
    },
  );
  integrationTest(
    "streams an archive file into a private object and back out",
    async () => {
      const storage = createStorageClientFromEnv();
      const dir = await mkdtemp(join(tmpdir(), "invoicewise-s3-stream-"));
      const source = join(dir, "export.zip");
      // Larger than one part, so the multipart path runs; the last part is
      // short.
      const bytes = Buffer.alloc(S3_UPLOAD_PART_BYTES * 2 + 12_345);
      for (let index = 0; index < bytes.byteLength; index += 4096) {
        bytes[index] = index % 251;
      }
      await writeFile(source, bytes);
      const input = {
        bucket: "vault",
        path: ["storage-test", crypto.randomUUID(), "exports", "export.zip"],
      };

      try {
        await storage.uploadFile({ ...input, sourcePath: source });
        const opened = await storage.openRead(input);
        expect(opened.size).toBe(bytes.byteLength);
        const read = Buffer.from(
          await new Response(opened.stream).arrayBuffer(),
        );
        expect(createHash("sha256").update(read).digest("hex")).toBe(
          createHash("sha256").update(bytes).digest("hex"),
        );
      } finally {
        await storage.remove(input).catch(() => undefined);
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});
