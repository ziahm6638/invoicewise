import "server-only";
import { createHash, randomBytes } from "node:crypto";
import {
  type LeadCreateInput,
  type LeadCreateResult,
  SITE_PRODUCT,
  isDisposableEmail,
  isHoneypotFilled,
  isValidEmail,
  normalizeEmail,
  normalizeText,
} from "@/lib/leads";
import { headers } from "next/headers";
import { sendConfirmationEmail, sendNotificationEmail } from "./email";
import {
  countRecentIpAttempts,
  createLeadRecord,
  findLeadByEmailProduct,
  recordIpAttempt,
  toPocketBaseDate,
} from "./pocketbase";

const RATE_LIMIT_WINDOW_MINUTES = 60;
const RATE_LIMIT_MAX_PER_IP = 20;
const MAX_USER_AGENT_LENGTH = 1000;
const REF_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

const ACCEPTED: LeadCreateResult = { status: "ok" };

const RETRY_LATER: LeadCreateResult = {
  status: "error",
  code: "server_error",
  message: "We couldn't add you right now. Please try again later.",
};

const SERVER_ERROR: LeadCreateResult = {
  status: "error",
  code: "server_error",
  message: "Something went wrong. Please try again.",
};

function hashIp(ip: string): string {
  const salt = process.env.IP_HASH_SALT;
  if (!salt) {
    throw new Error("IP_HASH_SALT is not set");
  }
  return createHash("sha256").update(`${salt}:${ip}`).digest("hex");
}

function newToken(): string {
  return `submission.${randomBytes(32).toString("base64url")}`;
}

function newRefCode(): string {
  return Array.from(
    randomBytes(8),
    (byte) => REF_ALPHABET[byte % REF_ALPHABET.length],
  ).join("");
}

async function clientMeta(): Promise<{ ip: string; userAgent: string }> {
  const headerList = await headers();
  const forwarded = headerList.get("x-forwarded-for");
  const ip =
    forwarded?.split(",")[0]?.trim() || headerList.get("x-real-ip") || "";

  return {
    ip,
    userAgent: normalizeText(
      headerList.get("user-agent"),
      MAX_USER_AGENT_LENGTH,
    ),
  };
}

/**
 * Persist the lead first, then send. A duplicate email for the same product is
 * the unique index doing its job, not an error: the visitor is already on the
 * list, so we acknowledge without sending a second pair of emails.
 */
export async function createLead(
  input: LeadCreateInput,
): Promise<LeadCreateResult> {
  if (isHoneypotFilled(input.company_hp)) {
    return SERVER_ERROR;
  }

  const email = normalizeEmail(input.email);
  if (!isValidEmail(email)) {
    return {
      status: "error",
      code: "invalid_email",
      message: "Enter a valid email address.",
    };
  }
  if (isDisposableEmail(email)) {
    return {
      status: "error",
      code: "disposable_email",
      message: "Please use a permanent email address.",
    };
  }

  const { ip, userAgent } = await clientMeta();
  const source = normalizeText(input.source, 200);
  const submittedAt = toPocketBaseDate(new Date());
  const token = newToken();
  const refCode = newRefCode();

  let ipHash: string;
  try {
    ipHash = hashIp(ip);
    const attempts = await countRecentIpAttempts(
      ipHash,
      SITE_PRODUCT,
      RATE_LIMIT_WINDOW_MINUTES,
    );
    if (attempts >= RATE_LIMIT_MAX_PER_IP) {
      return SERVER_ERROR;
    }
    await recordIpAttempt(ipHash, SITE_PRODUCT);
  } catch (rateLimitError) {
    console.error("lead rate-limit check failed", rateLimitError);
    return RETRY_LATER;
  }

  let alreadySubscribed = false;
  try {
    await createLeadRecord({
      email,
      product: SITE_PRODUCT,
      source,
      utm_source: normalizeText(input.utm_source, 200),
      utm_medium: normalizeText(input.utm_medium, 200),
      utm_campaign: normalizeText(input.utm_campaign, 200),
      referrer: normalizeText(input.referrer, 2000),
      user_agent: userAgent,
      ip_hash: ipHash,
      token,
      ref_code: refCode,
      submission_window_start: submittedAt,
      submission_count: 1,
    });
  } catch (persistError) {
    const existing = await findLeadByEmailProduct(email, SITE_PRODUCT).catch(
      () => null,
    );
    if (!existing) {
      console.error("lead persistence failed", persistError);
      return SERVER_ERROR;
    }
    alreadySubscribed = true;
  }

  if (alreadySubscribed) {
    return ACCEPTED;
  }

  try {
    await sendConfirmationEmail({ email });
  } catch (emailError) {
    console.error("lead confirmation send failed", emailError);
  }

  try {
    await sendNotificationEmail({
      email,
      source,
      product: SITE_PRODUCT,
      createdAt: submittedAt,
      userAgent,
      ipHash,
    });
  } catch (emailError) {
    console.error("lead notification send failed", emailError);
  }

  return ACCEPTED;
}
