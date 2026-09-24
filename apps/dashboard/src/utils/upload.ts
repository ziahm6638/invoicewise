import type { AssetKind } from "@/lib/asset-kinds";
import { stripSpecialCharacters } from "@invoicewise/utils";

type UploadParams = {
  file: File;
  /** Asset kind; the server derives the namespace and object path from it. */
  kind: AssetKind;
  bucket: string;
  onProgress?: (bytesUploaded: number, bytesTotal: number) => void;
};

/**
 * Uploads a non-invoice asset (logo, avatar, app icon). The server derives the
 * object path; the returned URL is an authenticated same-origin read.
 */
export async function uploadFile({
  file,
  kind,
  bucket,
  onProgress,
}: UploadParams) {
  const filename = stripSpecialCharacters(file.name);
  const formData = new FormData();
  formData.set("bucket", bucket);
  formData.set("kind", kind);
  formData.set("file", file);

  const response = await fetch("/api/storage/asset", {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    throw new Error((await response.text()) || "Upload failed");
  }

  const { path: storedPath } = (await response.json()) as { path: string[] };
  onProgress?.(file.size, file.size);
  return {
    path: storedPath,
    url: `/api/storage/asset?path=${encodeURIComponent(storedPath.join("/"))}`,
    file,
    filename,
  };
}
