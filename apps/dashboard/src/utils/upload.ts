import { stripSpecialCharacters } from "@invoicewise/utils";

type UploadParams = {
  file: File;
  path: string[];
  bucket: string;
  onProgress?: (bytesUploaded: number, bytesTotal: number) => void;
};

export async function uploadFile({
  file,
  path,
  bucket,
  onProgress,
}: UploadParams) {
  const filename = stripSpecialCharacters(file.name);
  const formData = new FormData();
  formData.set("bucket", bucket);
  formData.set("path", JSON.stringify([...path, filename]));
  formData.set("file", file);

  const response = await fetch("/api/storage/upload", {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    throw new Error((await response.text()) || "Upload failed");
  }

  onProgress?.(file.size, file.size);
  return { ...(await response.json()), file, filename };
}

export const resumableUpload = uploadFile;
