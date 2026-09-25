import { randomInt } from "node:crypto";
import type { Database, PrimaryDatabase } from "@db/client";
import {
  type InboundEmailAttachmentOutcome,
  inboundEmailAddresses,
  inboundEmails,
  teams,
  workflowJobs,
} from "@db/schema";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";

type Executor = Database | PrimaryDatabase;

/**
 * Lowercase letters and digits without look-alikes (0/o, 1/l/i), so an
 * address read aloud or retyped still routes. 16 characters of a 31-symbol
 * alphabet is about 79 bits: an address cannot be guessed or enumerated.
 */
const LOCAL_PART_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
export const INBOUND_LOCAL_PART_LENGTH = 16;

export function generateInboundLocalPart() {
  let localPart = "";
  for (let index = 0; index < INBOUND_LOCAL_PART_LENGTH; index++) {
    localPart += LOCAL_PART_ALPHABET[randomInt(LOCAL_PART_ALPHABET.length)];
  }
  return localPart;
}

export const isInboundLocalPart = (value: string) =>
  value.length === INBOUND_LOCAL_PART_LENGTH &&
  [...value].every((character) => LOCAL_PART_ALPHABET.includes(character));

const addressColumns = {
  id: inboundEmailAddresses.id,
  teamId: inboundEmailAddresses.teamId,
  localPart: inboundEmailAddresses.localPart,
  createdAt: inboundEmailAddresses.createdAt,
};

export type InboundEmailAddress = {
  id: string;
  teamId: string;
  localPart: string;
  createdAt: string;
};

async function getActiveInboundEmailAddress(
  db: Pick<Database, "select">,
  teamId: string,
): Promise<InboundEmailAddress | undefined> {
  const [address] = await db
    .select(addressColumns)
    .from(inboundEmailAddresses)
    .where(
      and(
        eq(inboundEmailAddresses.teamId, teamId),
        isNull(inboundEmailAddresses.revokedAt),
      ),
    )
    .limit(1);
  return address;
}

/**
 * The workspace's active address, provisioned on first use. Concurrent first
 * reads converge on one row through the partial unique index on active
 * addresses.
 */
export async function ensureInboundEmailAddress(
  db: Executor,
  params: { teamId: string; userId?: string | null },
): Promise<InboundEmailAddress> {
  const existing = await getActiveInboundEmailAddress(db, params.teamId);
  if (existing) return existing;

  const [created] = await db
    .insert(inboundEmailAddresses)
    .values({
      teamId: params.teamId,
      localPart: generateInboundLocalPart(),
      createdBy: params.userId ?? null,
    })
    .onConflictDoNothing()
    .returning(addressColumns);
  if (created) return created;

  const concurrent = await getActiveInboundEmailAddress(db, params.teamId);
  if (!concurrent) throw new Error("Unable to provision an inbound address");
  return concurrent;
}

/**
 * Revokes the active address and issues a new one in one transaction under
 * the team row lock. Mail to the old address is refused from the moment this
 * commits; its local part is never issued again.
 */
export async function rotateInboundEmailAddress(
  db: Executor,
  params: { teamId: string; userId: string },
): Promise<InboundEmailAddress> {
  return db.transaction(async (tx) => {
    const [team] = await tx
      .select({ id: teams.id })
      .from(teams)
      .where(eq(teams.id, params.teamId))
      .for("update");
    if (!team) throw new Error("Workspace not found");

    await tx
      .update(inboundEmailAddresses)
      .set({ revokedAt: sql`now()` })
      .where(
        and(
          eq(inboundEmailAddresses.teamId, params.teamId),
          isNull(inboundEmailAddresses.revokedAt),
        ),
      );

    const [created] = await tx
      .insert(inboundEmailAddresses)
      .values({
        teamId: params.teamId,
        localPart: generateInboundLocalPart(),
        createdBy: params.userId,
      })
      .returning(addressColumns);
    if (!created) throw new Error("Unable to issue an inbound address");
    return created;
  });
}

/**
 * Server-owned recipient mapping: an active address of an existing
 * workspace. Revoked addresses and deleted workspaces (whose rows cascade)
 * resolve to nothing.
 */
export async function resolveInboundEmailRecipient(
  db: Pick<Database, "select">,
  localPart: string,
): Promise<{ addressId: string; teamId: string } | undefined> {
  const [address] = await db
    .select({
      addressId: inboundEmailAddresses.id,
      teamId: inboundEmailAddresses.teamId,
    })
    .from(inboundEmailAddresses)
    .innerJoin(teams, eq(teams.id, inboundEmailAddresses.teamId))
    .where(
      and(
        eq(inboundEmailAddresses.localPart, localPart),
        isNull(inboundEmailAddresses.revokedAt),
      ),
    )
    .limit(1);
  return address;
}

export type InsertInboundEmailParams = {
  teamId: string;
  addressId: string;
  recipient: string;
  envelopeFrom: string | null;
  messageKey: string;
  messageId: string | null;
  headerFrom: string | null;
  subject: string | null;
  sentAt: string | null;
  authenticationResults: string | null;
  size: number;
  rawSha256: string;
  raw: Buffer;
};

/**
 * Records a received message. Returns the new row, or `undefined` when the
 * workspace already holds this message (a redelivery), in which case the
 * existing row's delivery count is bumped by `recordInboundEmailRedelivery`.
 */
export async function insertInboundEmail(
  db: Pick<Database, "insert">,
  params: InsertInboundEmailParams,
) {
  const [row] = await db
    .insert(inboundEmails)
    .values(params)
    .onConflictDoNothing({
      target: [inboundEmails.teamId, inboundEmails.messageKey],
    })
    .returning({ id: inboundEmails.id });
  return row;
}

export async function recordInboundEmailRedelivery(
  db: Pick<Database, "update">,
  params: { teamId: string; messageKey: string },
) {
  const [row] = await db
    .update(inboundEmails)
    .set({
      deliveryCount: sql`${inboundEmails.deliveryCount} + 1`,
      lastDeliveredAt: sql`now()`,
    })
    .where(
      and(
        eq(inboundEmails.teamId, params.teamId),
        eq(inboundEmails.messageKey, params.messageKey),
      ),
    )
    .returning({ id: inboundEmails.id, status: inboundEmails.status });
  return row;
}

export async function getInboundEmailForProcessing(
  db: Pick<Database, "select">,
  params: { id: string; teamId: string },
) {
  const [row] = await db
    .select({
      id: inboundEmails.id,
      teamId: inboundEmails.teamId,
      messageId: inboundEmails.messageId,
      messageKey: inboundEmails.messageKey,
      subject: inboundEmails.subject,
      status: inboundEmails.status,
      raw: inboundEmails.raw,
      rawSha256: inboundEmails.rawSha256,
      attachments: inboundEmails.attachments,
    })
    .from(inboundEmails)
    .where(
      and(
        eq(inboundEmails.id, params.id),
        eq(inboundEmails.teamId, params.teamId),
      ),
    )
    .limit(1);
  return row;
}

/**
 * Settles a received message. A processed message drops its MIME source: the
 * accepted attachments live on as invoices in private storage and the
 * outcome list keeps the audit trail. A failed one keeps it for an operator.
 */
export async function settleInboundEmail(
  db: Pick<Database, "update">,
  params: {
    id: string;
    teamId: string;
    status: "processed" | "failed";
    attachments?: InboundEmailAttachmentOutcome[];
    detail?: string | null;
  },
) {
  await db
    .update(inboundEmails)
    .set({
      status: params.status,
      ...(params.attachments ? { attachments: params.attachments } : {}),
      detail: params.detail ?? null,
      processedAt: sql`now()`,
      ...(params.status === "processed" ? { raw: null } : {}),
    })
    .where(
      and(
        eq(inboundEmails.id, params.id),
        eq(inboundEmails.teamId, params.teamId),
        eq(inboundEmails.status, "received"),
      ),
    );
}

/**
 * Operator re-drive of a failed message whose MIME source is still kept:
 * the message goes back to `received` so its processing job can read it
 * again. Only a failed message with its source can be re-opened; returns the
 * message, or undefined when it cannot be.
 */
export async function reopenFailedInboundEmail(
  db: Pick<Database, "update">,
  params: { id: string; teamId: string },
) {
  const [row] = await db
    .update(inboundEmails)
    .set({ status: "received", detail: null, processedAt: null })
    .where(
      and(
        eq(inboundEmails.id, params.id),
        eq(inboundEmails.teamId, params.teamId),
        eq(inboundEmails.status, "failed"),
        sql`${inboundEmails.raw} is not null`,
      ),
    )
    .returning({ id: inboundEmails.id });
  return row;
}

/**
 * Messages still "received" whose processing job has already given up, for
 * example a lease that expired after the final attempt or a failure the
 * handler could not record.
 */
export async function listStalledInboundEmails(
  db: Pick<Database, "select">,
  params: { limit: number },
) {
  return db
    .select({ id: inboundEmails.id, teamId: inboundEmails.teamId })
    .from(inboundEmails)
    .innerJoin(
      workflowJobs,
      and(
        eq(workflowJobs.name, "process-inbound-email"),
        eq(workflowJobs.teamId, inboundEmails.teamId),
        eq(workflowJobs.idempotencyKey, sql`${inboundEmails.id}::text`),
      ),
    )
    .where(
      and(
        eq(inboundEmails.status, "received"),
        eq(workflowJobs.status, "failed"),
      ),
    )
    .orderBy(asc(inboundEmails.createdAt))
    .limit(params.limit);
}

/** Recent messages for the workspace settings page; never the MIME source. */
export async function listInboundEmails(
  db: Pick<Database, "select">,
  params: { teamId: string; limit?: number },
) {
  return db
    .select({
      id: inboundEmails.id,
      recipient: inboundEmails.recipient,
      envelopeFrom: inboundEmails.envelopeFrom,
      headerFrom: inboundEmails.headerFrom,
      subject: inboundEmails.subject,
      messageId: inboundEmails.messageId,
      status: inboundEmails.status,
      attachments: inboundEmails.attachments,
      detail: inboundEmails.detail,
      deliveryCount: inboundEmails.deliveryCount,
      createdAt: inboundEmails.createdAt,
      processedAt: inboundEmails.processedAt,
    })
    .from(inboundEmails)
    .where(eq(inboundEmails.teamId, params.teamId))
    .orderBy(desc(inboundEmails.createdAt))
    .limit(params.limit ?? 20);
}
