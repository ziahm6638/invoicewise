/**
 * Hosted load and hostile-input test for a staging deployment
 * (docs/operations.md#service-and-load-targets).
 *
 *   LOAD_EMAIL=... LOAD_PASSWORD=... OPS_TOKEN=... \
 *     bun --no-env-file scripts/ops/load-test.ts \
 *       --app https://iw-staging-app.zzapp.uk \
 *       --api https://iw-staging-api.zzapp.uk \
 *       --documents 30 --concurrency 10
 *
 * 1. Sends hostile and oversized inputs through the real upload route and
 *    requires every one to be refused with a 4xx (never accepted, never 5xx).
 * 2. Uploads `--documents` distinct synthetic invoices, `--concurrency` at a
 *    time, and records each response. 503 `temporarily_unavailable` is
 *    parser admission shedding load; those uploads are retried with backoff.
 * 3. Polls /ops/metrics until document processing has drained, recording the
 *    deepest queue, the oldest due job, API memory and TypeSafe calls.
 *
 * `--via http://127.0.0.1:<port>` sends every request to that address (for
 * example an SSH tunnel to the host's kamal-proxy) with the real Host header,
 * to test a deployment before its public DNS exists.
 *
 * Prints one JSON report. Exits non-zero on any unexpected outcome. Refuses
 * production origins: every accepted document spends TypeSafe calls.
 */

import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    app: { type: "string" },
    api: { type: "string" },
    documents: { type: "string", default: "30" },
    concurrency: { type: "string", default: "10" },
    "drain-timeout": { type: "string", default: "900" },
    via: { type: "string" },
  },
});

const app = args.app?.replace(/\/$/, "");
const api = args.api?.replace(/\/$/, "");
const documents = Number(args.documents);
const concurrency = Number(args.concurrency);
const drainTimeoutSeconds = Number(args["drain-timeout"]);
const via = args.via?.replace(/\/$/, "");

/** fetch against a public URL, optionally routed through `--via`. */
const request = (url: string, init: RequestInit = {}) => {
  if (!via) return fetch(url, init);
  const target = new URL(url);
  return fetch(`${via}${target.pathname}${target.search}`, {
    ...init,
    headers: { ...(init.headers as Record<string, string>), host: target.host },
  });
};
const { LOAD_EMAIL, LOAD_PASSWORD, OPS_TOKEN } = process.env;

if (!app || !api || !LOAD_EMAIL || !LOAD_PASSWORD || !OPS_TOKEN) {
  console.error(
    "usage: LOAD_EMAIL LOAD_PASSWORD OPS_TOKEN bun scripts/ops/load-test.ts --app <origin> --api <origin>",
  );
  process.exit(2);
}
if (
  [app, api].some((origin) =>
    /\/\/(app|api)\.invoicewise\.uk$/.test(origin as string),
  )
) {
  console.error("refusing to load-test production");
  process.exit(2);
}

// ---------------------------------------------------------------- fixtures

const escapePdf = (text: string) => text.replace(/[\\()]/g, "\\$&");

/** A one-page text-layer PDF with the given lines (Helvetica, A4). */
function textPdf(lines: string[]): Uint8Array {
  const content = [
    "BT /F1 11 Tf 14 TL 50 790 Td",
    ...lines.map((line) => `(${escapePdf(line)}) '`),
    "ET",
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  return assemblePdf(objects);
}

function assemblePdf(objects: string[]): Uint8Array {
  let output = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(output.length);
    output += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = output.length;
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    output += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(output);
}

/** A synthetic UK invoice; `n` makes the number, lines and totals unique. */
function syntheticInvoice(run: string, n: number): Uint8Array {
  const net = 100 + n * 7;
  const vat = Math.round(net * 20) / 100;
  return textPdf([
    "Synthetic Test Supplies Ltd",
    "1 Example Street, Leeds LS1 1AA",
    "VAT Reg No: GB 123 4567 89",
    "",
    "INVOICE",
    `Invoice number: LT-${run}-${String(n).padStart(4, "0")}`,
    "Invoice date: 25/09/2026",
    "Due date: 25/10/2026",
    "",
    "Bill to: InvoiceWise Staging Load Test",
    "",
    "Description                     Qty     Unit price     Amount",
    `Load test widget ${n}              1        ${net.toFixed(2)}        ${net.toFixed(2)}`,
    "",
    `Subtotal: ${net.toFixed(2)}`,
    `VAT 20%: ${vat.toFixed(2)}`,
    `Total due: GBP ${(net + vat).toFixed(2)}`,
    "",
    "Sort code: 12-34-56   Account: 12345678",
  ]);
}

function manyPagePdf(pages: number): Uint8Array {
  const kids = Array.from({ length: pages }, (_, i) => `${i + 3} 0 R`);
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages} >>`,
    ...kids.map(
      () => "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>",
    ),
  ]);
}

/** A PNG whose header claims 20000 x 20000 pixels (a decompression bomb). */
function hugePngHeader(): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, 20_000);
  view.setUint32(20, 20_000);
  bytes.set([8, 2, 0, 0, 0], 24);
  return bytes;
}

// ------------------------------------------------------------------- HTTP

async function signIn() {
  const response = await request(`${app}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: app as string },
    body: JSON.stringify({ email: LOAD_EMAIL, password: LOAD_PASSWORD }),
  });
  if (response.status !== 200) {
    throw new Error(`sign-in failed with ${response.status}`);
  }
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

type UploadResult = { status: number; code?: string; ms: number };

async function upload(
  cookie: string,
  body: FormData | ReadableStream<Uint8Array>,
  headers: Record<string, string> = {},
): Promise<UploadResult> {
  const startedAt = performance.now();
  const response = await request(`${app}/api/storage/upload`, {
    method: "POST",
    headers: { origin: app as string, cookie, ...headers },
    body,
    // Required by fetch for a streamed request body.
    ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
  } as RequestInit);
  const json = (await response.json().catch(() => ({}))) as { code?: string };
  return {
    status: response.status,
    code: json.code,
    ms: Math.round(performance.now() - startedAt),
  };
}

const form = (bytes: Uint8Array, name: string, type: string) => {
  const data = new FormData();
  data.set("file", new File([Buffer.from(bytes)], name, { type }));
  return data;
};

async function metrics() {
  const response = await request(`${api}/ops/metrics`, {
    headers: { authorization: `Bearer ${OPS_TOKEN}` },
  });
  if (response.status !== 200) {
    throw new Error(`/ops/metrics returned ${response.status}`);
  }
  return (await response.json()) as {
    version: string;
    process: { rssBytes: number };
    queue: {
      workflow: string;
      due: number;
      running: number;
      oldestDueSeconds: number;
      failedLastHour: number;
    }[];
    latency: {
      extraction: {
        count: number;
        p50Seconds: number | null;
        p95Seconds: number | null;
      };
    };
    budget: { typesafe: { callsToday: number; dailyLimit: number } };
    alerts: { key: string; severity: string }[];
  };
}

const percentile = (values: number[], p: number) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
};

// -------------------------------------------------------------------- run

const failures: string[] = [];
const cookie = await signIn();
const before = await metrics();
const run = Date.now().toString(36);

// 1. Hostile and oversized inputs.
const oversized = new Uint8Array(5_200_000);
oversized.set(new TextEncoder().encode("%PDF-1.4\n"));
const streamedTooLarge = new ReadableStream<Uint8Array>({
  start(controller) {
    const boundary = "----invoicewise-load";
    controller.enqueue(
      new TextEncoder().encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="big.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
      ),
    );
    for (let i = 0; i < 8; i++) controller.enqueue(new Uint8Array(1_000_000));
    controller.close();
  },
});
const hostile: [string, () => Promise<UploadResult>][] = [
  [
    "oversized (5.2 MB)",
    () => upload(cookie, form(oversized, "big.pdf", "application/pdf")),
  ],
  [
    "chunked 8 MB body without content-length",
    () =>
      upload(cookie, streamedTooLarge, {
        "content-type": "multipart/form-data; boundary=----invoicewise-load",
      }),
  ],
  [
    "empty file",
    () =>
      upload(cookie, form(new Uint8Array(0), "empty.pdf", "application/pdf")),
  ],
  [
    "PNG bytes declared as PDF",
    () =>
      upload(cookie, form(hugePngHeader(), "invoice.pdf", "application/pdf")),
  ],
  [
    "truncated PDF",
    () =>
      upload(
        cookie,
        form(
          syntheticInvoice(run, 0).slice(0, 300),
          "cut.pdf",
          "application/pdf",
        ),
      ),
  ],
  [
    "60-page PDF",
    () => upload(cookie, form(manyPagePdf(60), "pages.pdf", "application/pdf")),
  ],
  [
    "20000 x 20000 PNG header",
    () => upload(cookie, form(hugePngHeader(), "bomb.png", "image/png")),
  ],
  [
    "HEIC photo",
    () =>
      upload(
        cookie,
        form(
          new TextEncoder().encode("\0\0\0\x18ftypheic"),
          "photo.heic",
          "image/heic",
        ),
      ),
  ],
];
const hostileResults: Record<string, UploadResult> = {};
for (const [name, send] of hostile) {
  const result = await send();
  hostileResults[name] = result;
  if (result.status < 400 || result.status >= 500) {
    failures.push(`hostile input "${name}" returned ${result.status}`);
  }
}

// 2. Concurrent distinct invoices.
const uploads: (UploadResult & { attempts: number })[] = [];
let next = 1;
const startedAt = performance.now();
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    while (next <= documents) {
      const n = next++;
      const bytes = syntheticInvoice(run, n);
      let attempts = 0;
      let result: UploadResult;
      do {
        attempts += 1;
        result = await upload(
          cookie,
          form(bytes, `load-${n}.pdf`, "application/pdf"),
        );
        if (result.status === 503 || result.status === 429) {
          await Bun.sleep(1000 * 2 ** attempts);
        }
      } while (
        (result.status === 503 || result.status === 429) &&
        attempts < 5
      );
      uploads.push({ ...result, attempts });
      if (result.status !== 200) {
        failures.push(
          `invoice ${n} ended with ${result.status} ${result.code ?? ""}`,
        );
      }
    }
  }),
);
const uploadSeconds = (performance.now() - startedAt) / 1000;

// 3. Drain.
let deepestDue = 0;
let oldestDueSeconds = 0;
let peakRssBytes = 0;
let drained = false;
let last = before;
const deadline = Date.now() + drainTimeoutSeconds * 1000;
let metricsUnavailable = 0;
while (Date.now() < deadline) {
  try {
    last = await metrics();
  } catch {
    // The API is restarting (a deploy or an interruption drill): keep waiting.
    metricsUnavailable += 1;
    await Bun.sleep(5000);
    continue;
  }
  const processing = last.queue.find(
    (q) => q.workflow === "process-attachment",
  );
  deepestDue = Math.max(deepestDue, processing?.due ?? 0);
  oldestDueSeconds = Math.max(
    oldestDueSeconds,
    processing?.oldestDueSeconds ?? 0,
  );
  peakRssBytes = Math.max(peakRssBytes, last.process.rssBytes);
  if (!processing || processing.due + processing.running === 0) {
    drained = true;
    break;
  }
  await Bun.sleep(5000);
}
if (!drained)
  failures.push(`queue did not drain within ${drainTimeoutSeconds}s`);

const latencies = uploads.map((u) => u.ms);
const report = {
  target: { app, api, version: last.version },
  hostile: hostileResults,
  uploads: {
    documents,
    concurrency,
    seconds: Math.round(uploadSeconds),
    statuses: uploads.reduce<Record<string, number>>((counts, u) => {
      counts[u.status] = (counts[u.status] ?? 0) + 1;
      return counts;
    }, {}),
    shedThenRetried: uploads.filter((u) => u.attempts > 1).length,
    p50Ms: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
    maxMs: Math.max(0, ...latencies),
  },
  processing: {
    drained,
    deepestDue,
    oldestDueSeconds,
    metricsUnavailableSamples: metricsUnavailable,
    peakApiRssMiB: Math.round(peakRssBytes / 1048576),
    extraction24h: last.latency.extraction,
    failedLastHour:
      last.queue.find((q) => q.workflow === "process-attachment")
        ?.failedLastHour ?? 0,
    typesafeCalls:
      last.budget.typesafe.callsToday - before.budget.typesafe.callsToday,
    typesafeBudget: last.budget.typesafe,
  },
  alertsAfter: last.alerts,
  failures,
};
console.log(JSON.stringify(report, null, 2));
process.exit(failures.length === 0 ? 0 : 1);
