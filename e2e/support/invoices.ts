/** Invoice helpers shared by journeys: upload through the dashboard and wait. */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { JourneyContext, Tenant } from "./journey";

/**
 * The committed synthetic invoice (ACME SUPPLIES LTD, INV-2026-0042, GBP
 * 1,000.00 net + 200.00 VAT = 1,200.00). The TypeSafe stub answers for it
 * like a correct model, so processing is deterministic.
 */
export const SYNTHETIC_INVOICE = {
  path: join(import.meta.dir, "..", "fixtures", "synthetic-invoice.pdf"),
  supplierName: "ACME SUPPLIES LTD",
  invoiceNumber: "INV-2026-0042",
  currency: "GBP",
  netAmount: 1000,
  vatAmount: 200,
  grossAmount: 1200,
};

export const syntheticInvoiceBytes = () => readFile(SYNTHETIC_INVOICE.path);

/**
 * Posts one upload to the dashboard's intake route. The parser pool answers
 * 503 `temporarily_unavailable` when it is at capacity (documented
 * back-pressure); like the dashboard, the caller retries after a pause.
 */
export async function postUpload(
  ctx: JourneyContext,
  tenant: Tenant,
  form: () => FormData,
) {
  for (let attempt = 1; ; attempt++) {
    const response = await ctx.http(`${ctx.appOrigin}/api/storage/upload`, {
      method: "POST",
      headers: { origin: ctx.appOrigin, cookie: tenant.cookie },
      body: form(),
    });
    if (response.status === 503 && attempt < 10) {
      await Bun.sleep(500 * attempt);
      continue;
    }
    const body = (await response.json().catch(() => null)) as {
      id?: string;
      path?: string[];
      error?: string;
    } | null;
    return { status: response.status, body };
  }
}

/** Uploads a PDF the way the dashboard's drop zone does. */
export async function uploadInvoice(
  ctx: JourneyContext,
  tenant: Tenant,
  bytes: Uint8Array,
  fileName: string,
) {
  const { status, body } = await postUpload(ctx, tenant, () => {
    const form = new FormData();
    form.set(
      "file",
      new File([new Uint8Array(bytes)], fileName, { type: "application/pdf" }),
    );
    return form;
  });
  if (status !== 200 || !body?.id) {
    throw new Error(`upload failed: ${status} ${JSON.stringify(body)}`);
  }
  return { id: body.id, path: body.path ?? [] };
}

export type InvoiceView = {
  id: string;
  status: string;
  processingRevision: number;
  processingError: string | null;
  extraction: Record<string, any> | null;
  validation: Record<string, any> | null;
  delivery: any;
  correctionCount: number;
  [key: string]: any;
};

/** Polls inbox.getById until the invoice has been read (or failed). */
export async function waitForProcessed(
  ctx: JourneyContext,
  tenant: Tenant,
  id: string,
  timeoutMs = 90_000,
): Promise<InvoiceView> {
  const deadline = Date.now() + timeoutMs;
  let last: InvoiceView | null = null;
  while (Date.now() < deadline) {
    const read = await ctx.trpcQuery(tenant, "inbox.getById", { id });
    last = read.json as InvoiceView | null;
    if (last?.processingError) {
      throw new Error(`processing failed: ${last.processingError}`);
    }
    if (last?.extraction && last.processingRevision > 0) return last;
    await Bun.sleep(500);
  }
  throw new Error(
    `invoice ${id} was not processed within ${timeoutMs}ms (last status ${last?.status})`,
  );
}

/** Polls until `predicate` holds for the invoice view. */
export async function waitForInvoice(
  ctx: JourneyContext,
  tenant: Tenant,
  id: string,
  predicate: (view: InvoiceView) => boolean,
  label: string,
  timeoutMs = 60_000,
): Promise<InvoiceView> {
  const deadline = Date.now() + timeoutMs;
  let last: InvoiceView | null = null;
  while (Date.now() < deadline) {
    const read = await ctx.trpcQuery(tenant, "inbox.getById", { id });
    last = read.json as InvoiceView | null;
    if (last && predicate(last)) return last;
    await Bun.sleep(500);
  }
  throw new Error(
    `${label} did not happen within ${timeoutMs}ms: ${JSON.stringify(last).slice(0, 600)}`,
  );
}

/** Opens a browser page signed in as `tenant` through the sign-in form. */
export async function signedInPage(ctx: JourneyContext, tenant: Tenant) {
  const page = await ctx.page();
  await page.goto("/login");
  await page.getByLabel("Email").fill(tenant.email);
  await page.getByLabel("Password").fill(tenant.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
    timeout: 30_000,
  });
  return page;
}

/**
 * Opens a browser page that carries `tenant`'s existing session cookie (no
 * new sign-in), for flows where signing in again would change what is seen.
 */
export async function sessionPage(ctx: JourneyContext, tenant: Tenant) {
  const page = await ctx.page();
  const separator = tenant.cookie.indexOf("=");
  const name = tenant.cookie.slice(0, separator);
  await page.context().addCookies([
    {
      name,
      value: tenant.cookie.slice(separator + 1),
      domain: new URL(ctx.appOrigin).hostname,
      path: "/",
      httpOnly: true,
      secure: name.startsWith("__Secure-"),
      sameSite: "Lax",
    },
  ]);
  return page;
}
