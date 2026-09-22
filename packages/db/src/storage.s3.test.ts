import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { createStorageClientFromEnv } from "./storage";

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
          await storage.signedUrl({ ...input, expireIn: 60 }),
        );
        expect(
          storage.verifySignedUrl({
            ...input,
            expires: Number(signed.searchParams.get("expires")),
            providedSignature: signed.searchParams.get("signature") ?? "",
            download: false,
          }),
        ).toBe(true);

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
});
