import { createHash } from "node:crypto";
import type { Database, PrimaryDatabase } from "@invoicewise/db/client";
import {
  type InboxQueryDatabase,
  enqueueWorkflowJob,
  getInboundEmailForProcessing,
  insertInboundEmail,
  isInboundLocalPart,
  listStalledInboundEmails,
  recordInboundEmailRedelivery,
  resolveInboundEmailRecipient,
  settleInboundEmail,
} from "@invoicewise/db/queries";
import type { InboundEmailAttachmentOutcome } from "@invoicewise/db/schema";
import { allowedMimeTypes } from "@invoicewise/documents";
import PostalMime, { type Address, type Email } from "postal-mime";
import { workflowKey } from "./client";
import { type IntakeStorage, acceptIntakeUpload } from "./intake";
import { isTransientIntakeFailure } from "./intake-failure";

/**
 * Dedicated-address mail (docs/inbound-email.md). A message is acknowledged
 * only once it is committed with its processing intent; the workflow then
 * hands each supported attachment to the same intake as an upload.
 */
export const INBOUND_EMAIL_LIMITS = {
  /** Whole message, as received. The Email Worker refuses larger mail first. */
  maxMessageBytes: 20 * 1024 * 1024,
  /** Header section read at acknowledgement time. */
  maxHeaderBytes: 64 * 1024,
  /** Attachments looked at in one message; the rest are recorded as skipped. */
  maxAttachments: 50,
  /** Supported attachments handed to intake from one message. */
  maxDocuments: 10,
  /** Images below this are logos, signatures and tracking pixels. */
  minImageBytes: 100_000,
  /** MIME nesting accepted before the message is refused as malformed. */
  maxNestingDepth: 32,
} as const;

/** The receiving domain; the addresses are `<local part>@<domain>`. */
export const DEFAULT_INBOUND_EMAIL_DOMAIN = "in.invoicewise.uk";

export const inboundEmailDomain = (env: NodeJS.ProcessEnv = process.env) =>
  env.INBOUND_EMAIL_DOMAIN?.trim().toLowerCase() ||
  DEFAULT_INBOUND_EMAIL_DOMAIN;

/**
 * Whether workspaces are shown their address. Off until the Cloudflare
 * receiving setup and its live proof pass; the endpoint accepts mail either
 * way (docs/inbound-email.md#going-live).
 */
export const inboundEmailLive = (env: NodeJS.ProcessEnv = process.env) =>
  env.INBOUND_EMAIL_LIVE?.trim().toLowerCase() === "true";

/** Stored header values are display and audit metadata, never identity. */
const clip = (value: string | null | undefined, max = 998) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, max) : null;
};

/**
 * The workspace local part of an envelope recipient on the receiving domain,
 * or null. Only the exact issued local part routes; a `+tag` subaddress is
 * an unknown recipient.
 */
export function inboundLocalPart(recipient: string, domain: string) {
  const address = recipient.trim().toLowerCase();
  const at = address.lastIndexOf("@");
  if (at <= 0 || address.slice(at + 1) !== domain.trim().toLowerCase()) {
    return null;
  }
  const localPart = address.slice(0, at);
  return isInboundLocalPart(localPart) ? localPart : null;
}

export function inboundAddress(localPart: string, domain: string) {
  return `${localPart}@${domain}`;
}

/** The bytes up to and including the blank line that ends the headers. */
function headerSection(raw: Uint8Array) {
  const limit = Math.min(raw.byteLength, INBOUND_EMAIL_LIMITS.maxHeaderBytes);
  for (let index = 0; index < limit - 1; index++) {
    if (raw[index] !== 10) continue;
    if (raw[index + 1] === 10) return raw.subarray(0, index + 2);
    if (raw[index + 1] === 13 && raw[index + 2] === 10) {
      return raw.subarray(0, index + 3);
    }
  }
  return raw.subarray(0, limit);
}

const formatAddress = (address: Address | undefined) => {
  if (!address) return null;
  const mailbox = address.address ?? address.group?.[0]?.address;
  if (!mailbox) return clip(address.name);
  return clip(address.name ? `${address.name} <${mailbox}>` : mailbox);
};

export type InboundEmailHeaders = {
  messageId: string | null;
  from: string | null;
  fromAddress: string | null;
  subject: string | null;
  date: string | null;
  authenticationResults: string | null;
};

/**
 * Reads identity and audit headers from the header section alone, so
 * acknowledging a message never depends on decoding its body.
 */
export async function readInboundEmailHeaders(
  raw: Uint8Array,
): Promise<InboundEmailHeaders> {
  let parsed: Email;
  try {
    parsed = await PostalMime.parse(headerSection(raw), {
      maxHeadersSize: INBOUND_EMAIL_LIMITS.maxHeaderBytes,
    });
  } catch {
    return {
      messageId: null,
      from: null,
      fromAddress: null,
      subject: null,
      date: null,
      authenticationResults: null,
    };
  }
  return {
    messageId: clip(parsed.messageId),
    from: formatAddress(parsed.from),
    fromAddress: clip(parsed.from?.address)?.toLowerCase() ?? null,
    subject: clip(parsed.subject),
    date: clip(parsed.date),
    authenticationResults: clip(
      parsed.headers.find(({ key }) => key === "authentication-results")?.value,
      2000,
    ),
  };
}

const sha256 = (data: Uint8Array | string) =>
  createHash("sha256").update(data).digest("hex");

/**
 * Redelivery identity: the Message-ID a sender's retries keep, else the raw
 * bytes. Attachment content is deduplicated by intake either way. Both are
 * hashes, so the key outlives the retention of the headers themselves.
 */
export const inboundMessageKey = (messageId: string | null, rawSha: string) =>
  messageId ? `mid:${sha256(messageId)}` : `sha256:${rawSha}`;

export type AcceptInboundEmailInput = {
  recipient: string;
  sender: string | null;
  raw: Uint8Array;
  domain: string;
};

export type AcceptInboundEmailResult =
  | { status: "accepted"; id: string; teamId: string; deduplicated: boolean }
  | {
      status: "rejected";
      code: "unknown_recipient" | "too_large" | "empty";
      message: string;
    };

/**
 * Commits a received message and its processing intent in one transaction.
 * The recipient is resolved only through the server-owned address mapping;
 * nothing in the message chooses the workspace. A redelivery of a message the
 * workspace already holds is acknowledged without a second job.
 */
export async function acceptInboundEmail(
  db: InboxQueryDatabase,
  input: AcceptInboundEmailInput,
): Promise<AcceptInboundEmailResult> {
  if (input.raw.byteLength === 0) {
    return { status: "rejected", code: "empty", message: "Empty message" };
  }
  if (input.raw.byteLength > INBOUND_EMAIL_LIMITS.maxMessageBytes) {
    return {
      status: "rejected",
      code: "too_large",
      message: `Messages must be ${INBOUND_EMAIL_LIMITS.maxMessageBytes} bytes or smaller`,
    };
  }

  const localPart = inboundLocalPart(input.recipient, input.domain);
  const address = localPart
    ? await resolveInboundEmailRecipient(db, localPart)
    : undefined;
  if (!address) {
    return {
      status: "rejected",
      code: "unknown_recipient",
      message: "Unknown recipient",
    };
  }

  const headers = await readInboundEmailHeaders(input.raw);
  const rawSha256 = sha256(input.raw);
  const messageKey = inboundMessageKey(headers.messageId, rawSha256);

  return db.transaction(async (tx) => {
    const executor = tx as unknown as Database;
    const inserted = await insertInboundEmail(executor, {
      teamId: address.teamId,
      addressId: address.addressId,
      recipient: input.recipient.trim().toLowerCase().slice(0, 320),
      envelopeFrom: clip(input.sender, 320),
      messageKey,
      messageId: headers.messageId,
      headerFrom: headers.from,
      subject: headers.subject,
      sentAt: headers.date,
      authenticationResults: headers.authenticationResults,
      size: input.raw.byteLength,
      rawSha256,
      raw: Buffer.from(input.raw),
    });

    if (!inserted) {
      const existing = await recordInboundEmailRedelivery(executor, {
        teamId: address.teamId,
        messageKey,
      });
      if (!existing) throw new Error("Inbound message conflict vanished");
      return {
        status: "accepted" as const,
        id: existing.id,
        teamId: address.teamId,
        deduplicated: true,
      };
    }

    await enqueueWorkflowJob(executor, {
      name: "process-inbound-email",
      teamId: address.teamId,
      idempotencyKey: workflowKey.inboundEmail(inserted.id),
      payload: { teamId: address.teamId, inboundEmailId: inserted.id },
    });

    return {
      status: "accepted" as const,
      id: inserted.id,
      teamId: address.teamId,
      deduplicated: false,
    };
  });
}

/**
 * Gmail asks the new forwarding address to confirm before it forwards
 * anything. Its message carries the confirmation link and code, which the
 * workspace needs to see; it is never an invoice. The From header is only
 * believed when Cloudflare's own receipt block shows a DKIM pass for
 * google.com.
 *
 * Observed in production (docs/inbound-email.md, live proof step 7), the
 * message the Worker delivers starts with Cloudflare's block, above
 * everything the sender supplied:
 *
 *   Received: from <sending host> by cloudflare-email.net (cloudflare) ...
 *   ARC-Seal: i=1; ... d=cloudflare-email.net
 *   ARC-Message-Signature: i=1; ...
 *   ARC-Authentication-Results: i=1; mx.cloudflare.net; dkim=... dmarc=... spf=...
 *   Received-SPF: ...
 *   Authentication-Results: mx.cloudflare.net; dkim=... dmarc=... spf=...
 *   X-CF-SpamH-Score: ...
 *   <the sender's headers>
 *
 * So the topmost header must be Cloudflare's Received, and only the first
 * Authentication-Results and the first ARC-Authentication-Results after it
 * are Cloudflare's. A sender can add headers claiming `mx.cloudflare.net`,
 * but they always come after Cloudflare's own, so they are never the first.
 */
const GMAIL_FORWARDING_SENDER = "forwarding-noreply@google.com";
const RECEIVING_AUTHSERV_ID = "mx.cloudflare.net";
const CLOUDFLARE_RECEIVED = /(^|\s)by\s+cloudflare-email\.net(\s|$)/i;

type MessageHeader = { key: string; value: string };

function receivingHopResults(headers: MessageHeader[]) {
  const [top, ...rest] = headers;
  if (top?.key !== "received" || !CLOUDFLARE_RECEIVED.test(top.value)) {
    return [];
  }
  const results: string[] = [];
  const authenticationResults = rest.find(
    ({ key }) => key === "authentication-results",
  );
  if (authenticationResults) results.push(authenticationResults.value);
  const arcResults = rest.find(
    ({ key }) => key === "arc-authentication-results",
  );
  const sealed = arcResults?.value.match(/^\s*i\s*=\s*1\s*;([\s\S]*)$/);
  if (sealed?.[1]) results.push(sealed[1]);
  return results;
}

export function isGoogleSigned(headers: MessageHeader[]) {
  return receivingHopResults(headers).some(showsGoogleDkimPass);
}

function showsGoogleDkimPass(authenticationResults: string) {
  const [authservId, ...results] = authenticationResults
    .toLowerCase()
    .split(";")
    .map((part) => part.trim());
  if (authservId?.split(/\s+/)[0] !== RECEIVING_AUTHSERV_ID) return false;
  return results.some(
    (result) =>
      /^dkim=pass(\s|$)/.test(result) &&
      /(^|\s)header\.d=google\.com(\s|$)/.test(result),
  );
}

const DOCUMENT_EXTENSIONS: Record<string, string> = {
  ".pdf": "application/pdf",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
};

const extensionType = (fileName: string | null) => {
  const match = fileName?.toLowerCase().match(/\.[a-z0-9]+$/);
  return match ? DOCUMENT_EXTENSIONS[match[0]] : undefined;
};

const attachmentBytes = (content: ArrayBuffer | Uint8Array | string) =>
  typeof content === "string"
    ? new TextEncoder().encode(content)
    : content instanceof Uint8Array
      ? content
      : new Uint8Array(content);

export class InboundEmailProcessingError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "InboundEmailProcessingError";
  }
}

export type ProcessInboundEmailResult = {
  inboundEmailId: string;
  status: "processed" | "failed" | "already_settled";
  accepted: number;
  duplicates: number;
  rejected: number;
  skipped: number;
};

const summarize = (
  inboundEmailId: string,
  status: ProcessInboundEmailResult["status"],
  outcomes: InboundEmailAttachmentOutcome[],
): ProcessInboundEmailResult => ({
  inboundEmailId,
  status,
  accepted: outcomes.filter(({ outcome }) => outcome === "accepted").length,
  duplicates: outcomes.filter(({ outcome }) => outcome === "duplicate").length,
  rejected: outcomes.filter(({ outcome }) => outcome === "rejected").length,
  skipped: outcomes.filter(({ outcome }) => outcome === "skipped").length,
});

/**
 * Reads a stored message and hands each supported attachment to intake.
 *
 * Permanent problems (unreadable MIME, no supported attachment, rejected
 * documents) settle the message with the reason and are never retried. A
 * transient intake failure (storage, parser capacity) throws a retryable
 * error; the attachments already accepted are replayed idempotently by
 * content, and on the final attempt the message settles as failed instead.
 */
export async function processInboundEmail(
  db: PrimaryDatabase | Database,
  storage: IntakeStorage,
  params: { teamId: string; inboundEmailId: string; finalAttempt: boolean },
): Promise<ProcessInboundEmailResult> {
  const email = await getInboundEmailForProcessing(db, {
    id: params.inboundEmailId,
    teamId: params.teamId,
  });
  if (!email) {
    throw new InboundEmailProcessingError(
      "Inbound message is not part of this workspace",
      false,
    );
  }
  if (email.status !== "received") {
    return summarize(email.id, "already_settled", email.attachments);
  }

  const fail = async (
    detail: string,
    outcomes: InboundEmailAttachmentOutcome[] = [],
  ) => {
    await settleInboundEmail(db, {
      id: email.id,
      teamId: params.teamId,
      status: "failed",
      attachments: outcomes,
      detail,
    });
    return summarize(email.id, "failed", outcomes);
  };

  if (!email.raw) {
    return fail("The stored message is missing.");
  }

  let parsed: Email;
  try {
    parsed = await PostalMime.parse(new Uint8Array(email.raw), {
      maxNestingDepth: INBOUND_EMAIL_LIMITS.maxNestingDepth,
      maxHeadersSize: INBOUND_EMAIL_LIMITS.maxHeaderBytes,
      attachmentEncoding: "arraybuffer",
    });
  } catch {
    return fail("This message could not be read as email.");
  }

  if (
    parsed.from?.address?.toLowerCase() === GMAIL_FORWARDING_SENDER &&
    isGoogleSigned(parsed.headers)
  ) {
    const text = (parsed.text ?? "").replace(/\s+/g, " ").trim();
    await settleInboundEmail(db, {
      id: email.id,
      teamId: params.teamId,
      status: "processed",
      attachments: [],
      detail: `Gmail forwarding confirmation: ${text.slice(0, 600)}`,
    });
    return summarize(email.id, "processed", []);
  }

  const outcomes: InboundEmailAttachmentOutcome[] = [];
  const transient: string[] = [];
  let documents = 0;

  for (const [index, attachment] of parsed.attachments.entries()) {
    const bytes = attachmentBytes(attachment.content);
    const fileName = clip(attachment.filename, 200);
    const declared = attachment.mimeType.toLowerCase();
    const base = {
      index,
      fileName,
      contentType: declared,
      size: bytes.byteLength,
      sha256: sha256(bytes),
    };

    if (index >= INBOUND_EMAIL_LIMITS.maxAttachments) {
      outcomes.push({
        ...base,
        outcome: "skipped",
        code: "too_many_attachments",
        message: `Only the first ${INBOUND_EMAIL_LIMITS.maxAttachments} attachments of a message are read.`,
      });
      continue;
    }

    const declaredType = allowedMimeTypes.includes(declared)
      ? declared
      : extensionType(fileName);
    if (!declaredType) {
      outcomes.push({
        ...base,
        outcome: "skipped",
        code: "unsupported_type",
        message: "Not a PDF, JPEG or PNG attachment.",
      });
      continue;
    }

    if (
      declaredType.startsWith("image/") &&
      bytes.byteLength < INBOUND_EMAIL_LIMITS.minImageBytes
    ) {
      outcomes.push({
        ...base,
        outcome: "skipped",
        code: "small_image",
        message: "Images under 100 KB (logos, signatures) are not read.",
      });
      continue;
    }

    if (documents >= INBOUND_EMAIL_LIMITS.maxDocuments) {
      outcomes.push({
        ...base,
        outcome: "skipped",
        code: "too_many_documents",
        message: `Only the first ${INBOUND_EMAIL_LIMITS.maxDocuments} documents of a message are read. Send the rest separately.`,
      });
      continue;
    }
    documents += 1;

    // Same server-owned intake as an upload: validate the real bytes, store
    // them immutably, then accept and queue processing in one transaction.
    const result = await acceptIntakeUpload(db, storage, {
      teamId: params.teamId,
      bytes,
      declaredMimeType: declaredType,
      fileName: fileName ?? `attachment-${index + 1}`,
      displayName: email.subject || fileName,
      // Stable across redeliveries and retries, and carries the Message-ID
      // into the invoice's provenance.
      referenceId: `email:${
        email.messageId ? `mid:${email.messageId}` : `sha256:${email.rawSha256}`
      }:${index}`,
      inboundEmailId: email.id,
    });

    if (result.status === "accepted") {
      outcomes.push({
        ...base,
        outcome: result.deduplicated ? "duplicate" : "accepted",
        inboxId: result.inboxId,
      });
    } else if (isTransientIntakeFailure(result.code)) {
      transient.push(`${fileName ?? index}: ${result.message}`);
      outcomes.push({
        ...base,
        outcome: "rejected",
        code: result.code,
        message: result.message,
      });
    } else {
      outcomes.push({
        ...base,
        outcome: "rejected",
        code: result.code,
        message: result.message,
      });
    }
  }

  if (transient.length > 0) {
    if (params.finalAttempt) {
      return fail(
        "Some attachments could not be stored after several attempts. Send the message again.",
        outcomes,
      );
    }
    throw new InboundEmailProcessingError(
      `Inbound message intake is temporarily unavailable: ${transient.join("; ")}`,
      true,
    );
  }

  const read = outcomes.some(
    ({ outcome }) => outcome === "accepted" || outcome === "duplicate",
  );
  const attempted = outcomes.some(({ outcome }) => outcome === "rejected");
  await settleInboundEmail(db, {
    id: email.id,
    teamId: params.teamId,
    status: "processed",
    attachments: outcomes,
    detail: read
      ? null
      : attempted
        ? "No attachment in this message could be read as an invoice."
        : "No PDF, JPEG or PNG attachment was found in this message.",
  });
  return summarize(email.id, "processed", outcomes);
}

/**
 * Records a message whose processing gave up for a reason outside the
 * document (for example the database was unavailable on every attempt).
 */
export async function failInboundEmail(
  db: PrimaryDatabase | Database,
  params: { teamId: string; inboundEmailId: string },
) {
  await settleInboundEmail(db, {
    id: params.inboundEmailId,
    teamId: params.teamId,
    status: "failed",
    detail:
      "A temporary processing problem stopped this message from being read. Send it again.",
  });
}

/**
 * Part of the periodic delivery reconciler: settles messages whose job ended
 * failed without the handler recording it, so none stays "received".
 */
export async function reconcileInboundEmails(
  db: PrimaryDatabase | Database,
  input: { limit?: number } = {},
) {
  const stalled = await listStalledInboundEmails(db, {
    limit: input.limit ?? 100,
  });
  for (const email of stalled) {
    await failInboundEmail(db, {
      teamId: email.teamId,
      inboundEmailId: email.id,
    });
  }
  return { failed: stalled.length };
}
