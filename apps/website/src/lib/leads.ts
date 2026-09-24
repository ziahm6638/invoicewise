export const SITE_PRODUCT = "invoicewise";

export const MAX_ANSWER_LENGTH = 2000;
export const MAX_TOKEN_LENGTH = 128;
export const MAX_TEXT_LENGTH = 2000;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * A small bundled list of known disposable domains. The live site used the
 * same approach: reject the obvious throwaway addresses without a network
 * lookup, so lead capture stays available even when a third party is down.
 */
const DISPOSABLE_DOMAINS = new Set([
  "10minutemail.com",
  "guerrillamail.com",
  "mailinator.com",
  "sharklasers.com",
  "tempmail.com",
  "throwawaymail.com",
  "trashmail.com",
  "yopmail.com",
  "getnada.com",
  "dispostable.com",
]);

export function normalizeText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().slice(0, maxLength);
}

export function normalizeEmail(value: unknown): string {
  return normalizeText(value, 320).toLowerCase();
}

export function isValidEmail(email: string): boolean {
  return email.length <= 320 && EMAIL_RE.test(email);
}

export function isDisposableEmail(email: string): boolean {
  const domain = email.split("@")[1]?.toLowerCase();
  return domain ? DISPOSABLE_DOMAINS.has(domain) : false;
}

export function isHoneypotFilled(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export type LeadSource = "waitlist";

export interface LeadCreateInput {
  email: string;
  source: string;
  company_hp?: string;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  referrer?: string;
}

export interface LeadCreateResult {
  status: "ok" | "error";
  code?: string;
  message?: string;
}
