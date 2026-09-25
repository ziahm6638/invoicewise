"use client";

import { useInboxParams } from "@/hooks/use-inbox-params";
import { useTRPC } from "@/trpc/client";
import { Button } from "@invoicewise/ui/button";
import { cn } from "@invoicewise/ui/cn";
import { useToast } from "@invoicewise/ui/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, LoaderCircle, X, XCircle } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useDropzone } from "react-dropzone";

/** One file's intake, as the server has acknowledged it so far. */
type Upload = {
  key: string;
  fileName: string;
  status: "uploading" | "accepted" | "failed" | "interrupted";
  /** The accepted invoice, once the server has stored it and queued it. */
  inboxId?: string;
  deduplicated?: boolean;
  message?: string;
  /** Whether sending the same file again can succeed. */
  retryable?: boolean;
};

type Props = {
  children: ReactNode;
  onUploadComplete?: () => void;
};

const STORAGE_KEY = "invoicewise:uploads";
const UPLOAD_TIMEOUT_MS = 120_000;
const PARALLEL_UPLOADS = 3;

const INTERRUPTED =
  "The page closed before this upload finished. Upload the file again: InvoiceWise continues where it stopped and never keeps a second copy.";

/**
 * Intake is a single server call per file: the server owns the object path,
 * validates the real bytes and only answers 200 once the document is stored,
 * its record accepted and its processing queued. Nothing else counts as
 * accepted here. A rejected, failed or timed-out call is a terminal failure
 * for that file with its reason; the transient ones can be retried with the
 * same bytes, which resume the same reservation instead of duplicating it.
 */
async function uploadInvoice(
  file: File,
): Promise<Omit<Upload, "key" | "fileName">> {
  const formData = new FormData();
  formData.set("file", file);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);

  try {
    const response = await fetch("/api/storage/upload", {
      method: "POST",
      body: formData,
      signal: controller.signal,
    });
    const body = (await response.json().catch(() => null)) as {
      id?: string;
      deduplicated?: boolean;
      error?: string;
    } | null;

    if (!response.ok || !body?.id) {
      return {
        status: "failed",
        message: body?.error ?? "Upload failed. Try again.",
        // Capacity, storage and server errors pass; a rejected document
        // (type, size, unreadable) needs a different file.
        retryable: response.status === 429 || response.status >= 500,
      };
    }

    return {
      status: "accepted",
      inboxId: body.id,
      deduplicated: body.deduplicated ?? false,
    };
  } catch {
    return {
      status: "failed",
      message: controller.signal.aborted
        ? "The upload took too long and was stopped. Retry it."
        : "The connection was interrupted. Retry the upload.",
      retryable: true,
    };
  } finally {
    clearTimeout(timer);
  }
}

const readStored = (): Upload[] => {
  try {
    const stored = JSON.parse(
      window.sessionStorage.getItem(STORAGE_KEY) ?? "[]",
    ) as Upload[];
    // An upload that was still running when the page went away never got
    // an answer; it is shown as interrupted, never as still uploading.
    return stored.map((upload) =>
      upload.status === "uploading"
        ? { ...upload, status: "interrupted", message: INTERRUPTED }
        : upload,
    );
  } catch {
    return [];
  }
};

export function UploadZone({ children, onUploadComplete }: Props) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { setParams } = useInboxParams();
  const { toast } = useToast();
  const [uploads, setUploads] = useState<Upload[]>([]);
  const files = useRef(new Map<string, File>());

  // Restored once per page load; nothing is written back before that, so an
  // empty first render never erases the uploads of the page before.
  const [restored, setRestored] = useState(false);
  const restoring = useRef(false);
  useEffect(() => {
    if (restoring.current) return;
    restoring.current = true;
    setUploads((current) => [...current, ...readStored()]);
    setRestored(true);
  }, []);

  useEffect(() => {
    if (!restored) return;
    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(uploads));
    } catch {
      // Storage may be unavailable (private mode); the panel still works.
    }
  }, [restored, uploads]);

  const uploading = uploads.some((upload) => upload.status === "uploading");
  useEffect(() => {
    if (!uploading) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [uploading]);

  const settle = (key: string, outcome: Omit<Upload, "key" | "fileName">) =>
    setUploads((current) =>
      current.map((upload) =>
        upload.key === key ? { ...upload, ...outcome } : upload,
      ),
    );

  const send = useCallback(
    async (entries: { key: string; file: File }[]) => {
      let accepted = 0;
      const queue = [...entries];
      await Promise.all(
        Array.from({ length: Math.min(PARALLEL_UPLOADS, queue.length) }, () =>
          (async () => {
            for (let next = queue.shift(); next; next = queue.shift()) {
              const outcome = await uploadInvoice(next.file);
              if (outcome.status === "accepted") {
                accepted += 1;
                files.current.delete(next.key);
              }
              settle(next.key, outcome);
            }
          })(),
        ),
      );
      await queryClient.invalidateQueries({
        queryKey: trpc.inbox.get.queryKey(),
      });
      if (accepted > 0) onUploadComplete?.();
    },
    [onUploadComplete, queryClient, trpc],
  );

  const onDrop = (dropped: File[]) => {
    if (!dropped.length) return;
    const entries = dropped.map((file) => ({
      key: crypto.randomUUID(),
      file,
    }));
    for (const entry of entries) files.current.set(entry.key, entry.file);
    setUploads((current) => [
      ...entries.map(
        (entry): Upload => ({
          key: entry.key,
          fileName: entry.file.name,
          status: "uploading",
        }),
      ),
      ...current,
    ]);
    void send(entries);
  };

  const retry = (key: string) => {
    const file = files.current.get(key);
    if (!file) return;
    settle(key, {
      status: "uploading",
      message: undefined,
      retryable: undefined,
    });
    void send([{ key, file }]);
  };

  const dismiss = (key: string) => {
    files.current.delete(key);
    setUploads((current) => current.filter((upload) => upload.key !== key));
  };

  const clearFinished = () => {
    setUploads((current) => {
      for (const upload of current) {
        if (upload.status !== "uploading") files.current.delete(upload.key);
      }
      return current.filter((upload) => upload.status === "uploading");
    });
  };

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    onDropRejected: (rejections) => {
      for (const reject of rejections) {
        const heic = /\.hei[cf]$/i.test(reject.file.name);
        const message = reject.errors.some(
          ({ code }) => code === "file-too-large",
        )
          ? "The file is larger than 5 MB."
          : heic
            ? "HEIC photos (the iPhone camera default) are not supported. Send the photo as a JPEG or upload a PDF."
            : reject.errors.some(({ code }) => code === "file-invalid-type")
              ? "Upload a PDF, JPEG or PNG invoice."
              : "Upload at most 25 files at a time.";
        setUploads((current) => [
          {
            key: crypto.randomUUID(),
            fileName: reject.file.name,
            status: "failed",
            message,
            retryable: false,
          },
          ...current,
        ]);
      }
      if (rejections.length) {
        toast({
          duration: 4000,
          variant: "error",
          title:
            rejections.length === 1
              ? `${rejections[0]?.file.name} was not accepted`
              : `${rejections.length} files were not accepted`,
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

  const received = uploads.filter((upload) => upload.status === "accepted");

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

      {uploads.length > 0 && (
        <section
          aria-label="Uploads"
          aria-live="polite"
          className="fixed right-4 bottom-4 z-50 w-[360px] max-w-[calc(100vw-2rem)] border bg-background shadow-lg"
        >
          <header className="flex items-center justify-between gap-3 border-b px-3 py-2">
            <p className="text-sm font-medium">
              Uploads · {received.length} of {uploads.length} received
            </p>
            {!uploading && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={clearFinished}
              >
                Clear
              </Button>
            )}
          </header>
          <ul className="max-h-72 divide-y overflow-y-auto">
            {uploads.map((upload) => (
              <li key={upload.key} className="flex gap-2.5 px-3 py-2">
                {upload.status === "uploading" ? (
                  <LoaderCircle
                    aria-hidden
                    className="mt-0.5 size-4 shrink-0 animate-spin text-sky-700 dark:text-sky-300"
                  />
                ) : upload.status === "accepted" ? (
                  <CheckCircle2
                    aria-hidden
                    className="mt-0.5 size-4 shrink-0 text-emerald-700 dark:text-emerald-300"
                  />
                ) : (
                  <XCircle
                    aria-hidden
                    className="mt-0.5 size-4 shrink-0 text-destructive"
                  />
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{upload.fileName}</p>
                  <p className="text-xs text-muted-foreground">
                    {upload.status === "uploading"
                      ? "Uploading…"
                      : upload.status === "accepted"
                        ? upload.deduplicated
                          ? "Already received; nothing new was stored."
                          : "Received and queued for reading."
                        : (upload.message ?? "Not accepted.")}
                  </p>
                  <div className="mt-1 flex gap-3 text-xs">
                    {upload.status === "accepted" && upload.inboxId && (
                      <button
                        type="button"
                        className="underline underline-offset-2"
                        onClick={() => setParams({ inboxId: upload.inboxId })}
                      >
                        Open
                      </button>
                    )}
                    {upload.status === "failed" &&
                      upload.retryable &&
                      files.current.has(upload.key) && (
                        <button
                          type="button"
                          className="underline underline-offset-2"
                          onClick={() => retry(upload.key)}
                        >
                          Retry
                        </button>
                      )}
                  </div>
                </div>
                {upload.status !== "uploading" && (
                  <button
                    type="button"
                    aria-label={`Dismiss ${upload.fileName}`}
                    className="self-start text-muted-foreground hover:text-foreground"
                    onClick={() => dismiss(upload.key)}
                  >
                    <X aria-hidden className="size-3.5" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
