import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, resolve, sep } from "node:path";

type StoragePath = { bucket: string; path: string | string[] };

export type StorageClientConfig = {
  rootPath: string;
  publicUrl: string;
  signingSecret?: string;
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

export function createStorageClient(config: StorageClientConfig) {
  const root = resolve(config.rootPath);

  const resolveStoragePath = ({ bucket, path }: StoragePath) => {
    const relativePath = normalizePath([bucket, normalizePath(path)]);
    const absolutePath = resolve(root, relativePath);

    if (!absolutePath.startsWith(`${root}${sep}`)) {
      throw new Error("Storage path escapes the configured root");
    }

    return { absolutePath, relativePath };
  };

  const signature = (value: string) => {
    if (!config.signingSecret) {
      throw new Error("LOCAL_STORAGE_SIGNING_SECRET must be configured");
    }
    return createHmac("sha256", config.signingSecret)
      .update(value)
      .digest("hex");
  };

  const upload = async ({
    bucket,
    path,
    file,
  }: StoragePath & { file: Blob | Buffer | Uint8Array | ArrayBuffer }) => {
    const { absolutePath, relativePath } = resolveStoragePath({ bucket, path });
    const bytes =
      file instanceof Blob
        ? Buffer.from(await file.arrayBuffer())
        : file instanceof ArrayBuffer
          ? Buffer.from(file)
          : Buffer.from(file);

    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, bytes);

    return { path: relativePath.slice(bucket.length + 1) };
  };

  const download = async ({ bucket, path }: StoragePath) => {
    const { absolutePath } = resolveStoragePath({ bucket, path });
    const data = await readFile(absolutePath);
    const contents = data.buffer.slice(
      data.byteOffset,
      data.byteOffset + data.byteLength,
    ) as ArrayBuffer;
    return new Blob([contents], {
      type:
        MIME_TYPES[extname(absolutePath).toLowerCase()] ??
        "application/octet-stream",
    });
  };

  const remove = async ({ bucket, path }: StoragePath) => {
    const { absolutePath } = resolveStoragePath({ bucket, path });
    await rm(absolutePath, { force: true });
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

  return { download, remove, signedUrl, upload, verifySignedUrl };
}

const defaultStorageClient = () =>
  createStorageClient({
    rootPath:
      process.env.LOCAL_STORAGE_PATH ??
      resolve(tmpdir(), "invoicewise-storage"),
    publicUrl:
      process.env.STORAGE_PUBLIC_URL ??
      process.env.NEXT_PUBLIC_API_URL ??
      "http://localhost:3003",
    signingSecret: process.env.LOCAL_STORAGE_SIGNING_SECRET,
  });

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
