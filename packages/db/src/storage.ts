import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, resolve, sep } from "node:path";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

type StoragePath = { bucket: string; path: string | string[] };

type CommonStorageConfig = {
  publicUrl: string;
  signingSecret?: string;
};

export type StorageClientConfig = CommonStorageConfig &
  (
    | {
        backend?: "local";
        rootPath: string;
      }
    | {
        backend: "s3";
        endpoint: string;
        bucket: string;
        accessKeyId: string;
        secretAccessKey: string;
        region: string;
        forcePathStyle?: boolean;
      }
  );

type UploadInput = StoragePath & {
  file: Blob | Buffer | Uint8Array | ArrayBuffer;
  contentType?: string;
};

const MIME_TYPES: Record<string, string> = {
  ".csv": "text/csv",
  ".heic": "image/heic",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".webp": "image/webp",
  ".zip": "application/zip",
};

function normalizePath(path: string | string[]) {
  const value = (Array.isArray(path) ? path.join("/") : path)
    .replaceAll("\\", "/")
    .replace(/^\/+/, "");

  if (!value || value.split("/").some((part) => part === ".." || !part)) {
    throw new Error("Invalid storage path");
  }

  return value;
}

const bytes = async (file: UploadInput["file"]) =>
  file instanceof Blob
    ? Buffer.from(await file.arrayBuffer())
    : file instanceof ArrayBuffer
      ? Buffer.from(file)
      : Buffer.from(file);

const contentType = (path: string) =>
  MIME_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";

function createLocalBackend(
  config: Extract<StorageClientConfig, { backend?: "local" }>,
) {
  const root = resolve(config.rootPath);
  const resolveStoragePath = ({ bucket, path }: StoragePath) => {
    const relativePath = normalizePath([bucket, normalizePath(path)]);
    const absolutePath = resolve(root, relativePath);

    if (!absolutePath.startsWith(`${root}${sep}`)) {
      throw new Error("Storage path escapes the configured root");
    }

    return { absolutePath, path: normalizePath(path) };
  };

  return {
    async upload(input: UploadInput) {
      const { absolutePath, path } = resolveStoragePath(input);
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, await bytes(input.file));
      return { path };
    },
    async download(input: StoragePath) {
      const { absolutePath } = resolveStoragePath(input);
      const data = await readFile(absolutePath);
      const contents = data.buffer.slice(
        data.byteOffset,
        data.byteOffset + data.byteLength,
      ) as ArrayBuffer;
      return new Blob([contents], { type: contentType(absolutePath) });
    },
    async remove(input: StoragePath) {
      const { absolutePath } = resolveStoragePath(input);
      await rm(absolutePath, { force: true });
    },
  };
}

function createS3Backend(
  config: Extract<StorageClientConfig, { backend: "s3" }>,
) {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
  const key = ({ bucket, path }: StoragePath) =>
    normalizePath([bucket, normalizePath(path)]);

  return {
    async upload(input: UploadInput) {
      const path = normalizePath(input.path);
      await client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: key(input),
          Body: await bytes(input.file),
          ContentType: input.contentType ?? contentType(path),
        }),
      );
      return { path };
    },
    async download(input: StoragePath) {
      const response = await client.send(
        new GetObjectCommand({ Bucket: config.bucket, Key: key(input) }),
      );
      if (!response.Body) throw new Error("Storage object has no body");
      const data = Buffer.from(await response.Body.transformToByteArray());
      const contents = data.buffer.slice(
        data.byteOffset,
        data.byteOffset + data.byteLength,
      ) as ArrayBuffer;
      return new Blob([contents], {
        type: response.ContentType ?? contentType(normalizePath(input.path)),
      });
    },
    async remove(input: StoragePath) {
      await client.send(
        new DeleteObjectCommand({ Bucket: config.bucket, Key: key(input) }),
      );
    },
  };
}

export function createStorageClient(config: StorageClientConfig) {
  const backend =
    config.backend === "s3"
      ? createS3Backend(config)
      : createLocalBackend(config);

  const signature = (value: string) => {
    if (!config.signingSecret) {
      throw new Error("STORAGE_SIGNING_SECRET must be configured");
    }
    return createHmac("sha256", config.signingSecret)
      .update(value)
      .digest("hex");
  };

  const signedUrl = async ({
    bucket,
    path,
    expireIn,
    options,
  }: StoragePath & { expireIn: number; options?: { download?: boolean } }) => {
    const normalizedPath = normalizePath(path);
    const expires = Math.floor(Date.now() / 1000) + expireIn;
    const downloadFile = options?.download === true;
    const value = `${bucket}/${normalizedPath}:${expires}:${downloadFile}`;
    const url = new URL(
      `/storage/${encodeURIComponent(bucket)}/${normalizedPath
        .split("/")
        .map(encodeURIComponent)
        .join("/")}`,
      config.publicUrl,
    );
    url.searchParams.set("expires", String(expires));
    url.searchParams.set("signature", signature(value));
    if (downloadFile) url.searchParams.set("download", "1");

    return url.toString();
  };

  const verifySignedUrl = ({
    bucket,
    path,
    expires,
    providedSignature,
    download: downloadFile,
  }: StoragePath & {
    expires: number;
    providedSignature: string;
    download: boolean;
  }) => {
    if (expires < Math.floor(Date.now() / 1000)) return false;

    const expected = signature(
      `${bucket}/${normalizePath(path)}:${expires}:${downloadFile}`,
    );
    const expectedBuffer = Buffer.from(expected);
    const providedBuffer = Buffer.from(providedSignature);

    return (
      expectedBuffer.length === providedBuffer.length &&
      timingSafeEqual(expectedBuffer, providedBuffer)
    );
  };

  return { ...backend, signedUrl, verifySignedUrl };
}

const required = (env: NodeJS.ProcessEnv, name: string) => {
  const value = env[name];
  if (!value) throw new Error(`${name} must be configured`);
  return value;
};

export function createStorageClientFromEnv(env = process.env) {
  const common = {
    publicUrl:
      env.STORAGE_PUBLIC_URL ??
      env.NEXT_PUBLIC_API_URL ??
      "http://localhost:3003",
    signingSecret:
      env.STORAGE_SIGNING_SECRET ?? env.LOCAL_STORAGE_SIGNING_SECRET,
  };

  if ((env.STORAGE_BACKEND ?? "local") === "local") {
    return createStorageClient({
      ...common,
      backend: "local",
      rootPath:
        env.LOCAL_STORAGE_PATH ?? resolve(tmpdir(), "invoicewise-storage"),
    });
  }

  if (env.STORAGE_BACKEND !== "s3") {
    throw new Error(`Unsupported STORAGE_BACKEND: ${env.STORAGE_BACKEND}`);
  }

  return createStorageClient({
    ...common,
    backend: "s3",
    endpoint: required(env, "STORAGE_S3_ENDPOINT"),
    bucket: required(env, "STORAGE_S3_BUCKET"),
    accessKeyId: required(env, "STORAGE_S3_ACCESS_KEY_ID"),
    secretAccessKey: required(env, "STORAGE_S3_SECRET_ACCESS_KEY"),
    region: env.STORAGE_S3_REGION ?? "auto",
    forcePathStyle: env.STORAGE_S3_FORCE_PATH_STYLE === "true",
  });
}

let defaultClient: ReturnType<typeof createStorageClient> | undefined;
const defaultStorageClient = () => {
  defaultClient ??= createStorageClientFromEnv();
  return defaultClient;
};

export const upload = (
  input: Parameters<ReturnType<typeof createStorageClient>["upload"]>[0],
) => defaultStorageClient().upload(input);

export const download = (
  input: Parameters<ReturnType<typeof createStorageClient>["download"]>[0],
) => defaultStorageClient().download(input);

export const remove = (
  input: Parameters<ReturnType<typeof createStorageClient>["remove"]>[0],
) => defaultStorageClient().remove(input);

export const signedUrl = (
  input: Parameters<ReturnType<typeof createStorageClient>["signedUrl"]>[0],
) => defaultStorageClient().signedUrl(input);

export const verifySignedUrl = (
  input: Parameters<
    ReturnType<typeof createStorageClient>["verifySignedUrl"]
  >[0],
) => defaultStorageClient().verifySignedUrl(input);
