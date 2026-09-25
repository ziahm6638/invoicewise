/**
 * Redaction for operational text: job errors, log fields, audit details and
 * operator responses. Error reasons can quote a provider response, a URL or a
 * header, so everything that reaches an operator surface passes through here
 * first. It masks what can be recognised (credentials, signing secrets, signed
 * URL parameters, bank identifiers, card numbers) and bounds the length, so a
 * whole document quoted in an error can never be carried into a log.
 *
 * Document contents themselves are never passed to logs; the length bound is
 * the backstop, not the policy.
 */

export const OPERATIONAL_TEXT_MAX_LENGTH = 500;

const REDACTED = "[redacted]";

const PATTERNS: readonly [RegExp, string][] = [
  // HTTP authorization values.
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{6,}/gi, `$1 ${REDACTED}`],
  // InvoiceWise API keys, OAuth tokens and client secrets; webhook signing
  // secrets; common provider key prefixes.
  [/\bmid_[A-Za-z0-9_]{8,}/g, REDACTED],
  [/\bwhsec_[A-Za-z0-9]{8,}/g, REDACTED],
  [/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/g, REDACTED],
  // JSON Web Tokens.
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, REDACTED],
  // Credentials inside a URL.
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${REDACTED}@`],
  // Secrets in query strings, headers, JSON or key=value pairs.
  [
    /\b((?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|client[_-]?secret|secret|password|passwd|token|signature|x-amz-signature|x-amz-credential|authorization|cookie|set-cookie)"?\s*[:=]\s*"?)[^\s"'&,;}]+/gi,
    `$1${REDACTED}`,
  ],
  // IBANs (with or without spaces).
  [
    /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,3})?\b/g,
    "[iban]",
  ],
  // UK sort codes, and account numbers named as such.
  [/\b\d{2}-\d{2}-\d{2}\b/g, "[sort-code]"],
  [
    /\b(account\s*(?:number|no\.?|#)?\s*[:=]?\s*)\d{6,10}\b/gi,
    "$1[account-number]",
  ],
  // Payment card numbers.
  [/\b(?:\d[ -]?){13,19}\b/g, "[card-number]"],
];

/** Masks secrets and bank details in `value` and bounds its length. */
export function redactOperationalText(
  value: string,
  maxLength = OPERATIONAL_TEXT_MAX_LENGTH,
): string {
  let text = value;
  for (const [pattern, replacement] of PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

/** `redactOperationalText` for optional values. */
export const redactOptionalText = (value: string | null | undefined) =>
  value == null ? null : redactOperationalText(value);
