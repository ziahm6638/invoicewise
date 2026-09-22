import { uploadFile as upload } from "@/utils/upload";
import { useState } from "react";

interface UploadParams {
  file: File;
  path: string[];
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
    path,
    bucket,
  }: UploadParams): Promise<UploadResult> => {
    setLoading(true);

    try {
      const result = await upload({
        path,
        file,
        bucket,
      });

      return {
        url: result.url,
        path,
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
