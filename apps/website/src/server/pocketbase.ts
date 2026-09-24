import "server-only";
import type { LeadCreateInput } from "@/lib/leads";
import { normalizeText } from "@/lib/leads";

const LEADS = "leads";
const IP_ATTEMPTS = "ip_attempts";

interface PocketBaseConfig {
  url: string;
  token: string;
}

function readConfig(): PocketBaseConfig {
  const url = process.env.POCKETBASE_URL?.replace(/\/+$/, "");
  const token = process.env.POCKETBASE_TOKEN;

  if (!url) {
    throw new Error("POCKETBASE_URL is not set");
  }
  if (!token) {
    throw new Error("POCKETBASE_TOKEN is not set");
  }

  return { url, token };
}

function recordsUrl(collection: string, path = ""): string {
  const { url } = readConfig();
  return `${url}/api/collections/${collection}/records${path}`;
}

const USER_AGENT = "InvoiceWise-Website/1.0 (+https://invoicewise.uk)";

function authHeaders(json = false): HeadersInit {
  const { token } = readConfig();
  const headers: Record<string, string> = {
    authorization: token,
    "user-agent": USER_AGENT,
  };
  if (json) {
    headers["content-type"] = "application/json";
  }
  return headers;
}

function quoteFilter(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** PocketBase stores and compares datetimes as `YYYY-MM-DD HH:MM:SS.sssZ`. */
export function toPocketBaseDate(date: Date): string {
  return date.toISOString().replace("T", " ");
}

export interface NewLeadRecord {
  email: string;
  product: string;
  source: string;
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  referrer: string;
  user_agent: string;
  ip_hash: string;
  token: string;
  ref_code: string;
  submission_window_start: string;
  submission_count: number;
}

export interface StoredLeadRecord {
  id: string;
  email: string;
  created: string;
  product?: string;
  source?: string;
  user_agent?: string;
  ip_hash?: string;
  token?: string;
}

interface RecordsList<T> {
  totalItems: number;
  items: T[];
}

async function readError(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  return text.slice(0, 300);
}

export async function createLeadRecord(
  lead: NewLeadRecord,
): Promise<StoredLeadRecord> {
  const response = await fetch(recordsUrl(LEADS), {
    method: "POST",
    headers: authHeaders(true),
    body: JSON.stringify(lead),
  });

  if (!response.ok) {
    throw new Error(
      `PocketBase create failed (${response.status}): ${await readError(response)}`,
    );
  }

  return (await response.json()) as StoredLeadRecord;
}

export async function findLeadByEmailProduct(
  email: string,
  product: string,
): Promise<StoredLeadRecord | null> {
  const params = new URLSearchParams({
    filter: `email=${quoteFilter(email)} && product=${quoteFilter(product)}`,
    perPage: "1",
  });

  const response = await fetch(recordsUrl(LEADS, `?${params.toString()}`), {
    headers: authHeaders(),
  });

  if (!response.ok) {
    throw new Error(
      `PocketBase lookup failed (${response.status}): ${await readError(response)}`,
    );
  }

  const body = (await response.json()) as RecordsList<StoredLeadRecord>;
  return body.items[0] ?? null;
}

/**
 * Records one start attempt. Every attempt is counted, whether or not it
 * creates a lead, so the cap can be applied before the address is looked up.
 */
export async function recordIpAttempt(
  ipHash: string,
  product: string,
): Promise<void> {
  const response = await fetch(recordsUrl(IP_ATTEMPTS), {
    method: "POST",
    headers: authHeaders(true),
    body: JSON.stringify({ ip_hash: ipHash, product }),
  });

  if (!response.ok) {
    throw new Error(
      `PocketBase attempt failed (${response.status}): ${await readError(response)}`,
    );
  }
}

/** Counts start attempts from one hashed IP for this product in the window. */
export async function countRecentIpAttempts(
  ipHash: string,
  product: string,
  windowMinutes: number,
): Promise<number> {
  const since = toPocketBaseDate(new Date(Date.now() - windowMinutes * 60_000));

  const params = new URLSearchParams({
    filter: `ip_hash=${quoteFilter(ipHash)} && product=${quoteFilter(product)} && created>=${quoteFilter(since)}`,
    perPage: "1",
    fields: "id",
  });

  const response = await fetch(
    recordsUrl(IP_ATTEMPTS, `?${params.toString()}`),
    { headers: authHeaders() },
  );

  if (!response.ok) {
    throw new Error(
      `PocketBase attempt count failed (${response.status}): ${await readError(response)}`,
    );
  }

  const body = (await response.json()) as RecordsList<unknown>;
  return body.totalItems;
}

export function normalizeCampaignValue(value: unknown, max: number): string {
  return normalizeText(value, max);
}

export type { LeadCreateInput };
