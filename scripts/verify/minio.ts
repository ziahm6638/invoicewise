/**
 * Disposable MinIO bootstrap.
 *
 * Creates the private verification bucket through the S3 API that the product
 * already depends on, so CI and local runs need no `mc` container and no
 * additional tooling. Existing objects are never listed, rewritten or removed.
 */

import {
  CreateBucketCommand,
  HeadBucketCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  LOCAL_MINIO_ACCESS_KEY,
  LOCAL_MINIO_BUCKET,
  LOCAL_MINIO_ENDPOINT,
  LOCAL_MINIO_SECRET_KEY,
  assertLoopbackUrl,
} from "./lib";

export function createVerificationS3Client(endpoint = LOCAL_MINIO_ENDPOINT) {
  const parsed = assertLoopbackUrl("STORAGE_S3_ENDPOINT", endpoint);
  return new S3Client({
    endpoint: parsed.origin,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: {
      accessKeyId: LOCAL_MINIO_ACCESS_KEY,
      secretAccessKey: LOCAL_MINIO_SECRET_KEY,
    },
  });
}

/** Creates the private bucket if it is missing; a no-op when it exists. */
export async function ensurePrivateBucket(
  endpoint = LOCAL_MINIO_ENDPOINT,
  bucket = LOCAL_MINIO_BUCKET,
) {
  const client = createVerificationS3Client(endpoint);
  try {
    try {
      await client.send(new HeadBucketCommand({ Bucket: bucket }));
      return { bucket, created: false };
    } catch {
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
      await client.send(new HeadBucketCommand({ Bucket: bucket }));
      return { bucket, created: true };
    }
  } finally {
    client.destroy();
  }
}
