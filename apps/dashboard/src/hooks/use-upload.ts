import type { AssetKind } from "@/lib/asset-kinds";
import { uploadFile as upload } from "@/utils/upload";
import { useState } from "react";

interface UploadParams {
  file: File;
  kind: AssetKind;
  bucket: string;
}

interface UploadResult {
  url: string;
  path: string[];
}

export function useUpload() {
  const [isLoading, setLoading] = useState<boolean>(false);

  const uploadFile = async ({
    file,
    kind,
    bucket,
  }: UploadParams): Promise<UploadResult> => {
    setLoading(true);

    try {
      const result = await upload({
        kind,
        file,
        bucket,
      });

      return {
        url: result.url,
        path: result.path,
      };
    } finally {
      setLoading(false);
    }
  };

  return {
    uploadFile,
    isLoading,
  };
}
