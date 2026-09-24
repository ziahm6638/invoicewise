import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * PDF work runs in a separate OS process that the parent can kill.
 *
 * pdf.js selects a fake in-process worker under Node/Bun
 * (`isWorkerDisabled = true`), so neither a timer nor `worker.terminate()` can
 * interrupt synchronous decode work reliably. A child process gives real
 * containment: the parent enforces a wall-clock budget, an RSS budget sampled
 * from the child, an output budget and bounded admission, then kills and reaps
 * the process. Native canvas teardown crashes are contained too, because they
 * can only take down the child.
 */
export const isolatedPdfDiagnostics = {
  processesStarted: 0,
  processesTerminated: 0,
  processesCompleted: 0,
  rejectedByAdmission: 0,
  peakRssBytes: 0,
};

export type IsolatedPdfLimits = {
  timeoutMs: number;
  /** Output bounds applied inside the child. */
  maxPages: number;
  maxPageDimension: number;
  maxTotalPixels: number;
  maxChars: number;
  /** RSS budget enforced by the parent watchdog (default 320 MB). */
  maxProcessRssBytes?: number;
  /** Bytes of child stdout accepted before the child is killed. */
  maxOutputBytes?: number;
  /**
   * Admission bounds. The defaults are product limits; tests can set a bound
   * of zero to exercise the typed busy path without starting host processes.
   */
  maxConcurrentProcesses?: number;
  maxQueuedProcesses?: number;
  /** Test/operational override for the RSS sampler executable. */
  rssSamplerCommand?: string;
};

export type IsolatedPdfFailureCode =
  | "timeout"
  | "memory_limit"
  | "output_limit"
  | "busy"
  | "monitor_unavailable"
  | "password_protected"
  | "malformed"
  | "limit"
  | "task_failed";

export type IsolatedPdfResult<T> =
  | { ok: true; result: T; terminated: boolean }
  | {
      ok: false;
      code: IsolatedPdfFailureCode;
      message: string;
      terminated: boolean;
    };

export type IsolatedPdfStructure = {
  pageCount: number;
  maxPageDimension: number;
  totalPixels: number;
};

export type IsolatedPdfRender = { png: Uint8Array };
export type IsolatedPdfText = { text: string };

type Task = "inspect" | "render" | "text" | "__spin" | "__memory";

export const DEFAULT_PROCESS_RSS_BYTES = 320 * 1024 * 1024;
export const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_CONCURRENT_PROCESSES = 2;
const DEFAULT_MAX_QUEUED_PROCESSES = 8;
const RSS_SAMPLE_INTERVAL_MS = 150;
const RSS_SAMPLE_TIMEOUT_MS = 1_000;

const WORKER_SOURCE = `
const { readFileSync } = require("node:fs");
const write = (payload) => process.stdout.write(JSON.stringify(payload) + "\\n");

(async () => {
  const task = process.env.IW_TASK;
  const options = JSON.parse(process.env.IW_OPTIONS || "{}");
  const urls = { pdfjs: process.env.IW_PDFJS_URL, canvas: process.env.IW_CANVAS_URL };

  if (task === "__spin" || task === "__memory") {
    write({ ready: true });
    if (task === "__spin") {
      const end = Date.now() + options.spinMs;
      while (Date.now() < end) {}
      write({ ok: true, result: { spun: true, envKeys: Object.keys(process.env) } });
      return;
    }
    const chunks = [];
    let allocated = 0;
    while (allocated < options.targetBytes) {
      chunks.push(Buffer.alloc(4 * 1024 * 1024, 1));
      allocated += 4 * 1024 * 1024;
      // Allocate at a human-observable pace so the parent's RSS watchdog gets
      // a chance to act while the process is genuinely resident.
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    write({ ok: true, result: { allocated } });
    return;
  }

  const pdfjs = await import(urls.pdfjs);
  const bytes = new Uint8Array(readFileSync(0));
  const loadingTask = pdfjs.getDocument({
    data: bytes,
    isEvalSupported: false,
    disableFontFace: true,
    disableAutoFetch: true,
    disableStream: true,
  });

  let document;
  try {
    document = await loadingTask.promise;
  } catch (error) {
    write({
      ok: false,
      code: error && error.name === "PasswordException" ? "password_protected" : "malformed",
      message: String((error && error.message) || error),
    });
    return;
  }

  try {
    if (task === "inspect") {
      const limit = Math.min(document.numPages, options.maxPages + 1);
      let maxPageDimension = 0;
      let totalPixels = 0;
      for (let index = 1; index <= limit; index++) {
        const page = await document.getPage(index);
        const viewport = page.getViewport({ scale: 1 });
        page.cleanup();
        const width = Math.ceil(viewport.width);
        const height = Math.ceil(viewport.height);
        maxPageDimension = Math.max(maxPageDimension, width, height);
        totalPixels += width * height;
      }
      write({
        ok: true,
        result: { pageCount: document.numPages, maxPageDimension, totalPixels },
      });
      return;
    }

    if (task === "text") {
      if (document.numPages > options.maxPages) {
        write({
          ok: false,
          code: "limit",
          message: "The PDF has more pages than the extraction limit (" + options.maxPages + "). Nothing was extracted.",
        });
        return;
      }
      let text = "";
      for (let index = 1; index <= document.numPages; index++) {
        const page = await document.getPage(index);
        const content = await page.getTextContent();
        page.cleanup();
        text += content.items
          .map((item) => (typeof item.str === "string" ? item.str : ""))
          .join(" ");
        if (text.length > options.maxChars) {
          write({
            ok: false,
            code: "limit",
            message: "The extracted text exceeds the character limit (" + options.maxChars + "). Nothing was extracted.",
          });
          return;
        }
      }
      write({ ok: true, result: { text } });
      return;
    }

    if (task === "render") {
      if (document.numPages < 1) {
        write({ ok: false, code: "malformed", message: "The PDF contains no readable pages." });
        return;
      }
      const page = await document.getPage(options.page || 1);
      // Bounds apply to the rendered (scaled) viewport, not the unit box.
      const viewport = page.getViewport({ scale: options.scale || 1 });
      const width = Math.ceil(viewport.width);
      const height = Math.ceil(viewport.height);
      if (
        width > options.maxDimension ||
        height > options.maxDimension ||
        width * height > options.maxPixels
      ) {
        page.cleanup();
        write({
          ok: false,
          code: "limit",
          message: "The rendered page exceeds the preview bounds (" + width + "x" + height + ").",
        });
        return;
      }
      let canvasModule;
      try {
        canvasModule = await import(urls.canvas);
      } catch (error) {
        // The renderer is missing or broken on this host; that says nothing
        // about the document.
        write({ ok: false, code: "task_failed", message: String((error && error.message) || error) });
        return;
      }
      const canvas = canvasModule.createCanvas(width, height);
      const context = canvas.getContext("2d");
      await page.render({ canvasContext: context, viewport }).promise;
      page.cleanup();
      write({ ok: true, result: { png: canvas.toBuffer("image/png").toString("base64") } });
      return;
    }

    write({ ok: false, code: "task_failed", message: "Unknown isolated task" });
  } catch (error) {
    // The document opened, so a throw while walking it (broken or circular
    // page tree, /Kids that is not an array, a missing page object, a bad
    // content stream) is a property of the bytes. Report it as permanent
    // rather than as an operational failure that would be retried forever.
    write({
      ok: false,
      code: "malformed",
      message: String((error && error.message) || error),
    });
  } finally {
    await loadingTask.destroy().catch(() => undefined);
  }
  // Only failures before the document opened reach the handler below (loading
  // pdf.js, reading stdin), so they stay operational and retryable.
})().catch((error) =>
  write({
    ok: false,
    code: "task_failed",
    message: String((error && error.message) || error),
  }),
);
`;

/**
 * Resolves a module from the process working directory. `import.meta.url` is
 * unavailable because this package is type-checked in CommonJS contexts too;
 * every runtime (jobs worker, dashboard server, tests) starts in a directory
 * that can see the dependencies, and a bare specifier is passed through so the
 * child can still resolve it.
 */
const resolveModuleUrl = (id: string) => {
  try {
    const require = createRequire(
      pathToFileURL(join(process.cwd(), "package.json")),
    );
    return pathToFileURL(require.resolve(id)).href;
  } catch {
    return id;
  }
};

/**
 * The child parses untrusted bytes, so it gets only what the runtime and the
 * native renderer need, never the parent's database URL, storage keys or API
 * secrets.
 */
const CHILD_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "NODE_PATH",
  "FONTCONFIG_PATH",
  "FONTCONFIG_FILE",
  "SYSTEMROOT",
] as const;

const childBaseEnv = () => {
  const env: Record<string, string> = {};
  for (const name of CHILD_ENV_ALLOWLIST) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
};

/**
 * Bun loads `.env` files from the working directory by default, which would
 * hand the child the secrets the allowlist withholds. Node has no such
 * behaviour (and rejects the flag).
 */
const childRuntimeArgs = () =>
  process.versions.bun ? ["--no-env-file", "-e"] : ["-e"];

let activeProcesses = 0;
const admissionQueue: (() => void)[] = [];

const admissionNumber = (
  configured: number | undefined,
  envName: string,
  fallback: number,
) => {
  if (configured !== undefined) {
    return Number.isFinite(configured) && configured >= 0
      ? Math.floor(configured)
      : fallback;
  }
  const parsed = Number.parseInt(process.env[envName] ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const acquireAdmission = async (
  limits: IsolatedPdfLimits,
): Promise<boolean> => {
  const maxConcurrent = admissionNumber(
    limits.maxConcurrentProcesses,
    "IW_PDF_MAX_CONCURRENT",
    DEFAULT_MAX_CONCURRENT_PROCESSES,
  );
  const maxQueued = admissionNumber(
    limits.maxQueuedProcesses,
    "IW_PDF_MAX_QUEUED",
    DEFAULT_MAX_QUEUED_PROCESSES,
  );

  if (maxConcurrent <= 0) {
    isolatedPdfDiagnostics.rejectedByAdmission += 1;
    return false;
  }

  if (activeProcesses < maxConcurrent) {
    activeProcesses += 1;
    return true;
  }
  if (admissionQueue.length >= maxQueued) {
    isolatedPdfDiagnostics.rejectedByAdmission += 1;
    return false;
  }
  await new Promise<void>((resolve) => admissionQueue.push(resolve));
  activeProcesses += 1;
  return true;
};

const releaseAdmission = () => {
  activeProcesses -= 1;
  admissionQueue.shift()?.();
};

type RssSample = { ok: true; bytes: number } | { ok: false; reason: string };

/**
 * Samples the child's resident set size, in bytes. The sampler is itself
 * bounded: it never runs concurrently with another sample for the same child,
 * and an executable that is missing, hangs or returns unparseable output is a
 * measurement failure rather than an implicit pass.
 */
const sampleRssBytes = (pid: number, command: string): Promise<RssSample> =>
  new Promise((resolve) => {
    let sampler: ReturnType<typeof spawn>;
    try {
      sampler = spawn(command, ["-o", "rss=", "-p", String(pid)], {
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch (error) {
      resolve({
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    let settled = false;
    const finish = (
      result: RssSample,
      timer?: ReturnType<typeof setTimeout>,
    ) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      sampler.kill("SIGKILL");
      finish({ ok: false, reason: "measurement timed out" }, timer);
    }, RSS_SAMPLE_TIMEOUT_MS);

    let output = "";
    sampler.stdout?.on("data", (chunk) => {
      // Bound sampler output even if a hostile executable is configured or
      // found on PATH.
      if (output.length < 256) output += chunk.toString().slice(0, 256);
    });
    sampler.on("error", (error) =>
      finish({ ok: false, reason: error.message }, timer),
    );
    sampler.on("close", (code) => {
      if (code !== 0) {
        finish({ ok: false, reason: `exited with code ${code}` }, timer);
        return;
      }
      const kilobytes = Number.parseInt(output.trim(), 10);
      if (!Number.isFinite(kilobytes)) {
        finish({ ok: false, reason: "returned invalid output" }, timer);
        return;
      }
      finish({ ok: true, bytes: kilobytes * 1024 }, timer);
    });
  });

type ChildMessage<T> =
  | { ok: true; result: T }
  | { ok: false; code?: string; message?: string };

const parseChildOutput = <T>(stdout: string): ChildMessage<T> | null => {
  const lines = stdout
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith("{"));
  const line = lines.at(-1);
  if (!line) return null;
  try {
    return JSON.parse(line) as ChildMessage<T>;
  } catch {
    return null;
  }
};

async function spawnIsolatedTask<T>(
  task: Task,
  bytes: Uint8Array | undefined,
  options: Record<string, unknown>,
  limits: IsolatedPdfLimits,
): Promise<{ result: IsolatedPdfResult<T>; readySeen: boolean }> {
  const rssBudget = limits.maxProcessRssBytes ?? DEFAULT_PROCESS_RSS_BYTES;
  const outputBudget = limits.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const rssSamplerCommand =
    limits.rssSamplerCommand ?? process.env.IW_RSS_SAMPLER_COMMAND ?? "ps";

  return await new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(process.execPath, [...childRuntimeArgs(), WORKER_SOURCE], {
        env: {
          ...childBaseEnv(),
          // Not a secret; also required by the Next.js ProcessEnv typing.
          NODE_ENV: process.env.NODE_ENV,
          IW_TASK: task,
          IW_OPTIONS: JSON.stringify(options),
          IW_PDFJS_URL: resolveModuleUrl("pdfjs-dist/legacy/build/pdf.mjs"),
          IW_CANVAS_URL: resolveModuleUrl("canvas"),
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({
        readySeen: false,
        result: {
          ok: false,
          code: "task_failed",
          message: `Isolated PDF process could not start: ${
            error instanceof Error ? error.message : String(error)
          }`,
          terminated: false,
        },
      });
      return;
    }

    isolatedPdfDiagnostics.processesStarted += 1;

    let stdout = "";
    let readySeen = false;
    let terminated = false;
    let forced: {
      code: IsolatedPdfFailureCode;
      message: string;
    } | null = null;
    let settled = false;

    const kill = (failure: {
      code: IsolatedPdfFailureCode;
      message: string;
    }) => {
      if (terminated) return;
      terminated = true;
      forced = forced ?? failure;
      isolatedPdfDiagnostics.processesTerminated += 1;
      child.kill("SIGKILL");
    };

    // The wall-clock budget stays armed until the process actually exits, so
    // cleanup/tail work cannot outlive it.
    const timer = setTimeout(
      () =>
        kill({
          code: "timeout",
          message: `PDF work exceeded ${limits.timeoutMs}ms and the process was terminated.`,
        }),
      Math.max(1, limits.timeoutMs),
    );

    let sampleInFlight = false;
    let closed = false;
    const runWatchdogSample = async () => {
      const pid = child.pid;
      if (!pid || terminated || settled || closed || sampleInFlight) return;
      sampleInFlight = true;
      const sample = await sampleRssBytes(pid, rssSamplerCommand);
      sampleInFlight = false;
      if (terminated || settled || closed) return;
      if (!sample.ok) {
        // A missing or unreliable sampler must not silently disable memory
        // containment. Fail the operation as a retryable operational failure
        // and kill the child instead of treating measurement as success.
        kill({
          code: "monitor_unavailable",
          message: `PDF memory monitoring was unavailable (${sample.reason}); the document was not accepted. Retry.`,
        });
        return;
      }
      if (sample.bytes > isolatedPdfDiagnostics.peakRssBytes) {
        isolatedPdfDiagnostics.peakRssBytes = sample.bytes;
      }
      if (sample.bytes > rssBudget) {
        kill({
          code: "memory_limit",
          message: `PDF work exceeded the sampled RSS budget (${Math.round(
            sample.bytes / (1024 * 1024),
          )} MB > ${Math.round(rssBudget / (1024 * 1024))} MB) and was terminated.`,
        });
      }
    };
    const watchdog = setInterval(
      () => void runWatchdogSample(),
      RSS_SAMPLE_INTERVAL_MS,
    );

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (!readySeen && stdout.includes('"ready":true')) {
        readySeen = true;
        // Test seams and slow-starting children announce that work has begun.
        // Sample immediately so a fast allocation cannot finish before the
        // first interval tick.
        void runWatchdogSample();
      }
      if (stdout.length > outputBudget) {
        kill({
          code: "output_limit",
          message: `PDF work produced more than ${outputBudget} bytes of output and was terminated.`,
        });
      }
    });
    // Drain stderr so a noisy child cannot fill its pipe and stall.
    child.stderr?.on("data", () => undefined);
    child.stdin?.on("error", () => undefined);

    child.on("error", (error) => {
      forced = forced ?? {
        code: "task_failed",
        message: `PDF process failed: ${error.message}`,
      };
    });

    child.on("close", (code) => {
      closed = true;
      clearInterval(watchdog);
      clearTimeout(timer);
      if (settled) return;
      settled = true;

      if (forced) {
        resolve({
          readySeen,
          result: { ok: false, ...forced, terminated },
        });
        return;
      }

      const parsed = parseChildOutput<T>(stdout);
      if (!parsed) {
        resolve({
          readySeen,
          result: {
            ok: false,
            code: "task_failed",
            message: `PDF process exited with code ${code} without a result.`,
            terminated,
          },
        });
        return;
      }

      if (parsed.ok) {
        isolatedPdfDiagnostics.processesCompleted += 1;
        resolve({
          readySeen,
          result: { ok: true, result: parsed.result, terminated },
        });
        return;
      }

      resolve({
        readySeen,
        result: {
          ok: false,
          code: (parsed.code as IsolatedPdfFailureCode) ?? "task_failed",
          message: parsed.message ?? "The document could not be read.",
          terminated,
        },
      });
    });

    if (bytes) child.stdin?.write(Buffer.from(bytes));
    child.stdin?.end();
  });
}

async function runIsolatedTask<T>(
  task: Task,
  bytes: Uint8Array | undefined,
  options: Record<string, unknown>,
  limits: IsolatedPdfLimits,
): Promise<IsolatedPdfResult<T>> {
  const admitted = await acquireAdmission(limits);
  if (!admitted) {
    return {
      ok: false,
      code: "busy",
      message:
        "Too many documents are being processed at once. Retry the upload.",
      terminated: false,
    };
  }
  try {
    const { result } = await spawnIsolatedTask<T>(task, bytes, options, limits);
    return result;
  } finally {
    releaseAdmission();
  }
}

export function inspectPdfIsolated(
  bytes: Uint8Array,
  limits: IsolatedPdfLimits,
): Promise<IsolatedPdfResult<IsolatedPdfStructure>> {
  return runIsolatedTask<IsolatedPdfStructure>(
    "inspect",
    bytes,
    // The child caps the loop; the caller enforces the geometry bounds.
    { maxPages: limits.maxPages },
    limits,
  );
}

export function extractPdfTextIsolated(
  bytes: Uint8Array,
  limits: IsolatedPdfLimits,
): Promise<IsolatedPdfResult<IsolatedPdfText>> {
  return runIsolatedTask<IsolatedPdfText>(
    "text",
    bytes,
    { maxPages: limits.maxPages, maxChars: limits.maxChars },
    limits,
  );
}

export function renderPdfPageIsolated(
  bytes: Uint8Array,
  limits: IsolatedPdfLimits,
  options: {
    page?: number;
    scale?: number;
    maxDimension?: number;
    maxPixels?: number;
  },
): Promise<IsolatedPdfResult<IsolatedPdfRender>> {
  return runIsolatedTask<{ png: string }>(
    "render",
    bytes,
    {
      page: options.page ?? 1,
      scale: options.scale ?? 1,
      maxDimension: options.maxDimension ?? limits.maxPageDimension,
      maxPixels: options.maxPixels ?? limits.maxTotalPixels,
    },
    limits,
  ).then((result) =>
    result.ok
      ? {
          ok: true as const,
          result: {
            png: new Uint8Array(Buffer.from(result.result.png, "base64")),
          },
          terminated: result.terminated,
        }
      : result,
  );
}

/**
 * Test seam: starts a child that reports when it is actually working and then
 * spins synchronously, so termination of active work can be asserted instead
 * of merely observing a startup timeout.
 */
export async function runBusyProcessForTest(input: {
  spinMs: number;
  timeoutMs: number;
}): Promise<{
  readySeen: boolean;
  result: IsolatedPdfResult<{ spun: boolean; envKeys: string[] }>;
}> {
  return await spawnIsolatedTask<{ spun: boolean; envKeys: string[] }>(
    "__spin",
    undefined,
    { spinMs: input.spinMs },
    {
      timeoutMs: input.timeoutMs,
      maxPages: 1,
      maxPageDimension: 1,
      maxTotalPixels: 1,
      maxChars: 1,
    },
  );
}

/**
 * Test seam: starts a child that allocates bounded chunks after its ready
 * handshake, proving the parent's RSS watchdog kills it (and that the parent
 * itself survives).
 */
export function runMemoryHogForTest(input: {
  targetBytes: number;
  maxProcessRssBytes: number;
  timeoutMs: number;
  /** Used by the fail-closed monitor regression. */
  rssSamplerCommand?: string;
}): Promise<{
  readySeen: boolean;
  result: IsolatedPdfResult<{ allocated: number }>;
}> {
  return spawnIsolatedTask<{ allocated: number }>(
    "__memory",
    undefined,
    { targetBytes: input.targetBytes },
    {
      timeoutMs: input.timeoutMs,
      maxPages: 1,
      maxPageDimension: 1,
      maxTotalPixels: 1,
      maxChars: 1,
      maxProcessRssBytes: input.maxProcessRssBytes,
      rssSamplerCommand: input.rssSamplerCommand,
    },
  );
}
