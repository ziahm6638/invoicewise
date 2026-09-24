"use client";

import { useTRPC } from "@/trpc/client";
import { cn } from "@invoicewise/ui/cn";
import { useToast } from "@invoicewise/ui/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useDropzone } from "react-dropzone";

type UploadOutcome = {
  fileName: string;
  error: string | null;
};

type Props = {
  children: ReactNode;
  onUploadComplete?: () => void;
};

/**
 * Intake is a single server call per file: the server owns the object path,
 * validates the real bytes and only reports success once the processing
 * intent is durable.
 */
async function uploadInvoice(file: File): Promise<UploadOutcome> {
  const formData = new FormData();
  formData.set("file", file);

  try {
    const response = await fetch("/api/storage/upload", {
      method: "POST",
      body: formData,
    });
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;

    if (!response.ok) {
      return {
        fileName: file.name,
        error: body?.error ?? "Upload failed. Try again.",
      };
    }

    return { fileName: file.name, error: null };
  } catch {
    return { fileName: file.name, error: "Upload failed. Try again." };
  }
}

export function UploadZone({ children, onUploadComplete }: Props) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [progress, setProgress] = useState(0);
  const [showProgress, setShowProgress] = useState(false);
  const [toastId, setToastId] = useState<string | undefined>(undefined);
  const uploadProgress = useRef<number[]>([]);
  const { toast, dismiss, update } = useToast();

  useEffect(() => {
    if (!toastId && showProgress) {
      const { id } = toast({
        title: `Uploading ${uploadProgress.current.length} files`,
        progress,
        variant: "progress",
        description: "Please do not close browser until completed",
        duration: Number.POSITIVE_INFINITY,
      });

      if (id) {
        setToastId(id);
      }
    } else if (toastId) {
      update(toastId, {
        id: toastId,
        progress,
        title: `Uploading ${uploadProgress.current.length} files`,
      });
    }
  }, [showProgress, progress, toastId]);

  const onDrop = async (files: File[]) => {
    if (!files.length) {
      return;
    }

    uploadProgress.current = files.map(() => 0);
    setProgress(0);
    setShowProgress(true);

    let completed = 0;
    const outcomes = await Promise.all(
      files.map(async (file) => {
        const outcome = await uploadInvoice(file);
        completed += 1;
        setProgress(Math.round((completed / files.length) * 100));
        return outcome;
      }),
    );

    // Refresh inbox to show the accepted records (and any rejected attempt).
    queryClient.invalidateQueries({ queryKey: trpc.inbox.get.queryKey() });

    uploadProgress.current = [];
    setProgress(0);
    setShowProgress(false);
    setToastId(undefined);
    dismiss(toastId);

    const failed = outcomes.filter(
      (outcome): outcome is UploadOutcome & { error: string } =>
        outcome.error !== null,
    );

    const first = failed.at(0);
    if (first) {
      toast({
        duration: 5000,
        variant: "error",
        title:
          failed.length === 1
            ? `${first.fileName} was not accepted`
            : `${failed.length} files were not accepted`,
        description:
          failed.length === 1
            ? first.error
            : `${first.fileName}: ${first.error}`,
      });
    }

    if (failed.length < files.length) {
      toast({
        title:
          failed.length === 0 ? "Upload successful." : "Some files uploaded.",
        variant: "success",
        duration: 2000,
      });
      onUploadComplete?.();
    }
  };

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    onDropRejected: ([reject]) => {
      if (reject?.errors.find(({ code }) => code === "file-too-large")) {
        toast({
          duration: 2500,
          variant: "error",
          title: "File size to large.",
        });
      }

      if (reject?.errors.find(({ code }) => code === "file-invalid-type")) {
        const heic = /\.hei[cf]$/i.test(reject.file.name);
        toast({
          duration: heic ? 8000 : 4000,
          variant: "error",
          title: "File type not supported.",
          description: heic
            ? "HEIC photos (the iPhone camera default) are not supported. Send the photo as a JPEG or upload a PDF."
            : "Upload a PDF, JPEG or PNG invoice.",
        });
      }
    },
    maxSize: 5000000, // 5MB
    maxFiles: 25,
    accept: {
      "image/jpeg": [".jpg", ".jpeg"],
      "image/png": [".png"],
      "application/pdf": [".pdf"],
    },
  });

  return (
    <div
      {...getRootProps({ onClick: (evt) => evt.stopPropagation() })}
      className="relative h-full"
    >
      <div className="absolute top-0 bottom-0 right-0 left-0 z-[51] pointer-events-none">
        <div
          className={cn(
            "bg-background dark:bg-[#1A1A1A] h-full flex items-center justify-center text-center invisible",
            isDragActive && "visible",
          )}
        >
          <input {...getInputProps()} id="upload-files" />
          <p className="text-xs">
            Drop your invoices here. <br />
            Maximum of 25 files at a time.
          </p>
        </div>
      </div>

      {children}
    </div>
  );
}
