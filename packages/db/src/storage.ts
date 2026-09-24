import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, resolve, sep } from "node:path";
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
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
  /** Optional abort signal so a stalled operation settles instead of hanging. */
  signal?: AbortSignal;
};

type RemovePrefixInput = {
  bucket: string;
  /**
   * Directory-like prefix, removed with everything below it. It must be a
   * non-empty path, so a bucket can never be emptied wholesale.
   */
  prefix: string | string[];
  signal?: AbortSignal;
};

type RemoveInput = StoragePath & {
  /**
   * Optional cooperative abort. Local filesystem calls cannot be cancelled
   * once entered, so callers must treat an aborted operation as ambiguous and
   * retain durable cleanup state rather than assuming no effect occurred.
   */
  signal?: AbortSignal;
};

/**
 * Signed capability URLs are short lived. Callers may ask for less, never for
 * more, so a leaked link has a bounded window.
 */
export const MAX_SIGNED_URL_TTL_SECONDS = 900;

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
      input.signal?.throwIfAborted();
      await mkdir(dirname(absolutePath), { recursive: true });
      input.signal?.throwIfAborted();
      const data = await bytes(input.file);
      input.signal?.throwIfAborted();
      await writeFile(absolutePath, data);
      input.signal?.throwIfAborted();
      return { path };
    },
    async uploadIfAbsent(input: UploadInput) {
      const { absolutePath, path } = resolveStoragePath(input);
      input.signal?.throwIfAborted();
      await mkdir(dirname(absolutePath), { recursive: true });
      input.signal?.throwIfAborted();
      const data = await bytes(input.file);
      input.signal?.throwIfAborted();
      // Write to a sibling temp file first and publish with `link`, which is
      // atomic and never replaces an existing object. A reader can therefore
      // never observe a partially written immutable object.
      const temporaryPath = `${absolutePath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporaryPath, data);
        input.signal?.throwIfAborted();
        try {
          await link(temporaryPath, absolutePath);
          input.signal?.throwIfAborted();
          return { path, created: true };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            return { path, created: false };
          }
          throw error;
        }
      } finally {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
      }
    },
    async download(input: StoragePath & { signal?: AbortSignal }) {
      const { absolutePath } = resolveStoragePath(input);
      input.signal?.throwIfAborted();
      const data = await readFile(absolutePath);
      input.signal?.throwIfAborted();
      const contents = data.buffer.slice(
        data.byteOffset,
        data.byteOffset + data.byteLength,
      ) as ArrayBuffer;
      return new Blob([contents], { type: contentType(absolutePath) });
    },
    async remove(input: RemoveInput) {
      const { absolutePath } = resolveStoragePath(input);
      input.signal?.throwIfAborted();
      await rm(absolutePath, { force: true });
      input.signal?.throwIfAborted();
    },
    async removePrefix(input: RemovePrefixInput) {
      const { absolutePath } = resolveStoragePath({
        bucket: input.bucket,
        path: input.prefix,
      });
      input.signal?.throwIfAborted();
      await rm(absolutePath, { recursive: true, force: true });
      input.signal?.throwIfAborted();
    },
  };
}

const s3Status = (error: unknown) =>
  (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata
    ?.httpStatusCode;

const s3Name = (error: unknown) => (error as { name?: string } | null)?.name;

/** The object already exists, so the immutable write is complete. */
const isPreconditionFailure = (error: unknown) =>
  s3Status(error) === 412 || s3Name(error) === "PreconditionFailed";

/**
 * S3-compatible stores return 409 when a conditional write races another
 * in-flight write. That is a transient conflict, not proof that a stored
 * object is complete.
 */
const isConditionalConflict = (error: unknown) =>
  s3Status(error) === 409 || s3Name(error) === "ConditionalRequestConflict";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
        { abortSignal: input.signal },
      );
      return { path };
    },
    async uploadIfAbsent(input: UploadInput) {
      const path = normalizePath(input.path);
      const body = await bytes(input.file);
      let conflict: unknown;

      // A 409 means another conditional write is in flight: retry briefly and
      // never treat it as proof that complete bytes already exist.
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await client.send(
            new PutObjectCommand({
              Bucket: config.bucket,
              Key: key(input),
              Body: body,
              ContentType: input.contentType ?? contentType(path),
              IfNoneMatch: "*",
            }),
            { abortSignal: input.signal },
          );
          return { path, created: true };
        } catch (error) {
          if (isPreconditionFailure(error)) {
            return { path, created: false };
          }
          if (!isConditionalConflict(error)) throw error;
          conflict = error;
          await sleep(50 * 2 ** attempt);
        }
      }

      throw new Error(
        "Conditional write conflicted with another writer; the immutable object was not verified",
        { cause: conflict },
      );
    },
    async download(input: StoragePath & { signal?: AbortSignal }) {
      const response = await client.send(
        new GetObjectCommand({ Bucket: config.bucket, Key: key(input) }),
        { abortSignal: input.signal },
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
    async remove(input: RemoveInput) {
      await client.send(
        new DeleteObjectCommand({ Bucket: config.bucket, Key: key(input) }),
        { abortSignal: input.signal },
      );
    },
    async removePrefix(input: RemovePrefixInput) {
      // The trailing slash keeps `<id>/` from matching a sibling `<id>x/`.
      const prefix = `${key({ bucket: input.bucket, path: input.prefix })}/`;

      // Delete page by page and list again from the start: removed keys drop
      // out of the listing, so no continuation token can go stale. A page
      // that survives its own deletion fails instead of looping forever.
      let previousPage = "";
      for (;;) {
        const listed = await client.send(
          new ListObjectsV2Command({
            Bucket: config.bucket,
            Prefix: prefix,
            MaxKeys: 1000,
          }),
          { abortSignal: input.signal },
        );
        const keys = (listed.Contents ?? [])
          .map((object) => object.Key)
          .filter((value): value is string => !!value);

        if (keys.length === 0) return;

        const page = keys.join("\n");
        if (page === previousPage) {
          throw new Error("Stored objects remained after deletion");
        }
        previousPage = page;

        const deleted = await client.send(
          new DeleteObjectsCommand({
            Bucket: config.bucket,
            Delete: {
              Objects: keys.map((Key) => ({ Key })),
              Quiet: true,
            },
          }),
          { abortSignal: input.signal },
        );

        if (deleted.Errors?.length) {
          const [first] = deleted.Errors;
          throw new Error(
            `Unable to remove ${deleted.Errors.length} stored object(s): ${
              first?.Code ?? "unknown error"
            }`,
          );
        }
      }
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
    inboxId,
    options,
  }: StoragePath & {
    expireIn: number;
    /**
     * Workspace-owned inbox record this capability is bound to. The serving
     * route re-checks the persisted binding before reading any object.
     */
    inboxId: string;
    options?: { download?: boolean };
  }) => {
    if (!inboxId) throw new Error("Signed storage URLs require an inbox id");
    if (!Number.isFinite(expireIn) || expireIn <= 0) {
      throw new Error("Signed storage URLs require a positive expiry");
    }
    if (expireIn > MAX_SIGNED_URL_TTL_SECONDS) {
      throw new Error(
        `Signed storage URLs may not outlive ${MAX_SIGNED_URL_TTL_SECONDS} seconds`,
      );
    }
    const normalizedPath = normalizePath(path);
    const expires = Math.floor(Date.now() / 1000) + expireIn;
    const downloadFile = options?.download === true;
    const value = `${bucket}/${normalizedPath}:${expires}:${downloadFile}:${inboxId}`;
    const url = new URL(
      `/storage/${encodeURIComponent(bucket)}/${normalizedPath
        .split("/")
        .map(encodeURIComponent)
        .join("/")}`,
      config.publicUrl,
    );
    url.searchParams.set("expires", String(expires));
    url.searchParams.set("signature", signature(value));
    url.searchParams.set("inbox", inboxId);
    if (downloadFile) url.searchParams.set("download", "1");

    return url.toString();
  };

  const verifySignedUrl = ({
    bucket,
    path,
    expires,
    providedSignature,
    download: downloadFile,
    inboxId,
  }: StoragePath & {
    expires: number;
    providedSignature: string;
    download: boolean;
    inboxId: string;
  }) => {
    if (!inboxId) return false;
    if (!Number.isFinite(expires) || expires < Math.floor(Date.now() / 1000)) {
      return false;
    }

    const expected = signature(
      `${bucket}/${normalizePath(path)}:${expires}:${downloadFile}:${inboxId}`,
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

export const uploadIfAbsent = (
  input: Parameters<
    ReturnType<typeof createStorageClient>["uploadIfAbsent"]
  >[0],
) => defaultStorageClient().uploadIfAbsent(input);

export const download = (
  input: Parameters<ReturnType<typeof createStorageClient>["download"]>[0],
) => defaultStorageClient().download(input);

export const remove = (
  input: Parameters<ReturnType<typeof createStorageClient>["remove"]>[0],
) => defaultStorageClient().remove(input);

export const removePrefix = (
  input: Parameters<ReturnType<typeof createStorageClient>["removePrefix"]>[0],
) => defaultStorageClient().removePrefix(input);

export const signedUrl = (
  input: Parameters<ReturnType<typeof createStorageClient>["signedUrl"]>[0],
) => defaultStorageClient().signedUrl(input);

export const verifySignedUrl = (
  input: Parameters<
    ReturnType<typeof createStorageClient>["verifySignedUrl"]
  >[0],
) => defaultStorageClient().verifySignedUrl(input);
