import { createHash, randomUUID } from "node:crypto";
import type { Database, PrimaryDatabase } from "@invoicewise/db/client";
import {
  type InboxIntakeBinding,
  type InboxIntakeBindingCursor,
  type InboxQueryDatabase,
  acceptInboxIntake,
  beginInboxIntakePublication,
  cancelInboxIntake,
  claimAmbiguousObjectRemovalForDiscard,
  claimReservedIntakeForDiscard,
  claimSettledObjectRemovalForDiscard,
  clearAcceptedObjectRemovalIntent,
  clearObjectRemovalPending,
  createInbox,
  documentBindingIssue,
  enqueueWorkflowJob,
  findInboxIntakeByContentHash,
  findPendingIntakeJob,
  getInboxByFilePath,
  getInboxIntakeBinding,
  getInboxIntakeBindingForUpdate,
  isStoredPathSharedByLiveDocument,
  listPendingObjectRemovals,
  listStaleReservedIntake,
  recordInboxIntakeError,
  recordInboxIntakeRemovalIntent,
  recordIntakeRemovalFailure,
  reserveInboxIntake,
  updateInbox,
} from "@invoicewise/db/queries";
import {
  type createStorageClient,
  download as downloadObject,
  remove as removeObject,
  uploadIfAbsent as uploadIfAbsentObject,
} from "@invoicewise/db/storage";
import {
  type IntakeFailureCode,
  checkStoredIntakeBytes,
  validateIntakeDocument,
} from "@invoicewise/documents";
import { workflowKey } from "./client";

/**
 * The intake lifecycle is owned by the server:
 *
 * 1. validate the real bytes before anything is written,
 * 2. reserve a durable inbox record with a server-generated object path,
 * 3. write the object immutably (an existing object is never replaced),
 * 4. finalize accepted content and the processing intent in one transaction.
 *
 * A crash between any two steps leaves either a reservation that the next
 * attempt with the same content resumes, or an object whose record is still
 * reserved. Neither can become an orphaned *accepted* invoice.
 */
export type IntakeStorage = Pick<
  ReturnType<typeof createStorageClient>,
  "uploadIfAbsent" | "remove" | "download"
>;

/** The environment-configured storage client used by the HTTP intake routes. */
export const defaultIntakeStorage: IntakeStorage = {
  uploadIfAbsent: (input) => uploadIfAbsentObject(input),
  remove: (input) => removeObject(input),
  download: (input) => downloadObject(input),
};

const VAULT_BUCKET = "vault";

/**
 * Resolves the persisted binding for one workspace document. Client input is
 * only an id; path, type and size always come from the row, and deleted or
 * cancelled records disappear immediately. An unfinished reservation is not a
 * document yet, so it is never read or signed either.
 */
export async function resolveTeamDocumentBinding(
  db: InboxQueryDatabase,
  params: { teamId: string; id: string },
): Promise<InboxIntakeBinding | null> {
  const binding = await getInboxIntakeBinding(db, {
    id: params.id,
    teamId: params.teamId,
  });

  if (!binding?.filePath?.length) return null;
  if (
    binding.status === "deleted" ||
    binding.intakeState === "cancelled" ||
    binding.intakeState === "reserved"
  ) {
    return null;
  }

  return binding;
}

const EXTENSION_BY_MIME: Record<string, string> = {
  "application/pdf": ".pdf",
  "image/jpeg": ".jpg",
  "image/png": ".png",
};

export type IntakeUploadInput = {
  teamId: string;
  bytes: Uint8Array;
  declaredMimeType?: string | null;
  fileName?: string | null;
  displayName?: string | null;
  referenceId?: string;
  website?: string;
  inboxAccountId?: string;
};

export type IntakeUploadResult =
  | {
      status: "accepted";
      inboxId: string;
      filePath: string[];
      fileName: string;
      mimeType: string;
      size: number;
      pageCount: number | null;
      /** True when this content was already accepted for the workspace. */
      deduplicated: boolean;
    }
  | {
      status: "rejected";
      code:
        | IntakeFailureCode
        | "storage_unavailable"
        | "malformed_binding"
        | "reference_conflict"
        | "superseded";
      message: string;
    };

export const intakeContentHash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/** Display-safe file name. Never used as an object identity. */
export const intakeFileName = (fileName?: string | null) => {
  const base = (fileName ?? "invoice").split(/[\\/]/).at(-1) ?? "invoice";
  const cleaned = base.replace(/[^\p{L}\p{N}._\- ]/gu, "").trim();
  return (cleaned || "invoice").slice(0, 200);
};

const isUniqueViolation = (error: unknown) =>
  (error as { code?: string } | null)?.code === "23505";

/** Bounded budget for the storage write and read-back of one attempt. */
export const INTAKE_STORAGE_TIMEOUT_MS = 60_000;

/**
 * Publication lease: the storage budget plus headroom for the short
 * acceptance transaction. Cleanup cannot claim a reservation inside it.
 */
export const INTAKE_PUBLICATION_LEASE_MS = INTAKE_STORAGE_TIMEOUT_MS + 30_000;

const supersededResult = {
  status: "rejected",
  code: "superseded",
  message: "This document was cancelled before it could be accepted.",
} as const satisfies IntakeUploadResult;

/**
 * Reads the reserved object back and proves it holds exactly the bytes this
 * record claims. Runs before acceptance and before any queueing.
 */
async function verifyReservedObject(
  storage: IntakeStorage,
  expected: {
    filePath: string[];
    contentHash: string;
    size: number;
    signal?: AbortSignal;
  },
): Promise<
  | { ok: true }
  | {
      ok: false;
      /** `storage_unavailable` is transient; `content_mismatch` is permanent. */
      code: "storage_unavailable" | "content_mismatch";
      reason: string;
    }
> {
  let stored: Uint8Array;
  try {
    const blob = await storage.download({
      bucket: VAULT_BUCKET,
      path: expected.filePath,
      signal: expected.signal,
    });
    stored = new Uint8Array(await blob.arrayBuffer());
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return {
      ok: false,
      // A read that failed is not proof that the bytes differ: keep it
      // transient so callers retry instead of acknowledging permanent loss.
      code: "storage_unavailable",
      reason: `The stored document could not be read back (${message}). Retry the upload.`,
    };
  }

  if (
    stored.byteLength !== expected.size ||
    intakeContentHash(stored) !== expected.contentHash
  ) {
    return {
      ok: false,
      code: "content_mismatch",
      reason:
        "An existing object at this document path has different content. The upload was rejected instead of replacing or queueing it.",
    };
  }

  return { ok: true };
}

/**
 * Writes the reserved object immutably and proves the stored bytes hash to
 * the content this record claims. Covers an existing object from an earlier
 * attempt, a partially published write and transport-level corruption. Runs
 * with no database connection held.
 */
async function publishReservedObject(
  storage: IntakeStorage,
  input: {
    filePath: string[];
    bytes: Uint8Array;
    mimeType: string;
    contentHash: string;
    size: number;
  },
): Promise<
  | { ok: true }
  | {
      ok: false;
      code: "storage_unavailable" | "content_mismatch";
      message: string;
    }
> {
  const controller = new AbortController();
  const abortTimer = setTimeout(
    () => controller.abort(),
    INTAKE_STORAGE_TIMEOUT_MS,
  );

  try {
    await storage.uploadIfAbsent({
      bucket: VAULT_BUCKET,
      path: input.filePath,
      file: input.bytes,
      contentType: input.mimeType,
      signal: controller.signal,
    });

    const storageCheck = await verifyReservedObject(storage, {
      filePath: input.filePath,
      contentHash: input.contentHash,
      size: input.size,
      signal: controller.signal,
    });
    if (!storageCheck.ok) {
      return {
        ok: false,
        code: storageCheck.code,
        message: storageCheck.reason,
      };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      code: "storage_unavailable",
      message:
        error instanceof Error
          ? `The document could not be stored or verified (${error.message}). Retry the upload.`
          : "The document could not be stored or verified. Retry the upload.",
    };
  } finally {
    clearTimeout(abortTimer);
  }
}

const acceptIntake = async (
  db: InboxQueryDatabase,
  storage: IntakeStorage,
  input: IntakeUploadInput,
): Promise<IntakeUploadResult> => {
  const validation = await validateIntakeDocument({
    bytes: input.bytes,
    declaredMimeType: input.declaredMimeType,
    fileName: input.fileName,
  });

  if (!validation.ok) {
    return {
      status: "rejected",
      code: validation.code,
      message: validation.message,
    };
  }

  const contentHash = intakeContentHash(input.bytes);
  const fileName = intakeFileName(input.fileName);

  let reservation = await findInboxIntakeByContentHash(db, {
    teamId: input.teamId,
    contentHash,
  });

  if (!reservation) {
    const inboxId = randomUUID();
    const filePath = [
      input.teamId,
      "inbox",
      inboxId,
      `${randomUUID()}${EXTENSION_BY_MIME[validation.mimeType] ?? ""}`,
    ];

    const inserted = await reserveInboxIntake(db, {
      id: inboxId,
      teamId: input.teamId,
      filePath,
      fileName,
      displayName: input.displayName?.trim() || fileName,
      contentType: validation.mimeType,
      size: validation.size,
      contentHash,
      referenceId: input.referenceId,
      website: input.website,
      inboxAccountId: input.inboxAccountId,
    });

    reservation =
      inserted ??
      (await findInboxIntakeByContentHash(db, {
        teamId: input.teamId,
        contentHash,
      }));

    if (!reservation) {
      // Nothing matches this content, so the conflict was on the scoped
      // provider reference: the same attachment identity already holds
      // different bytes for this workspace.
      return {
        status: "rejected",
        code: "reference_conflict",
        message:
          "An attachment with this provider reference already exists for this workspace with different content.",
      };
    }
  }

  if (!reservation?.filePath?.length) {
    return {
      status: "rejected",
      code: "malformed_binding",
      message: "The intake record could not be resolved to a stored document.",
    };
  }

  const reservationPath: string[] = reservation.filePath;

  const acceptedResult = (
    binding: InboxIntakeBinding,
    deduplicated: boolean,
  ): IntakeUploadResult => ({
    status: "accepted",
    inboxId: binding.id,
    filePath: binding.filePath ?? reservationPath,
    fileName: binding.fileName ?? fileName,
    mimeType: binding.contentType ?? validation.mimeType,
    size: binding.size ?? validation.size,
    pageCount: validation.pageCount,
    deduplicated,
  });

  if (reservation.intakeState === "accepted") {
    // Replay of an already accepted upload: same workspace document, no new
    // object, no second processing intent.
    return acceptedResult(reservation, true);
  }

  // No database connection or transaction is held while bytes move to or
  // from object storage. A short publication lease on the reservation keeps
  // cleanup from claiming it while this attempt writes and verifies the
  // object; acceptance and the processing intent then commit in one short
  // row-locked transaction. The write is immutable (an existing object is
  // never replaced) and every cancellation of a reservation records removal
  // intent with the ambiguity marker, so a write that lands after the record
  // was cancelled is still reclaimed by the next cleanup pass.
  const leased = await beginInboxIntakePublication(db, {
    id: reservation.id,
    teamId: input.teamId,
    leaseMs: INTAKE_PUBLICATION_LEASE_MS,
  });

  if (!leased) {
    const current = await getInboxIntakeBinding(db, {
      id: reservation.id,
      teamId: input.teamId,
    });
    if (current?.intakeState === "accepted" && current.status !== "deleted") {
      return acceptedResult(current, true);
    }
    return supersededResult;
  }

  const objectPath = leased.filePath ?? reservationPath;
  const publication = await publishReservedObject(storage, {
    filePath: objectPath,
    bytes: input.bytes,
    mimeType: validation.mimeType,
    contentHash,
    size: validation.size,
  });

  if (!publication.ok) {
    // Durable removal intent for whatever may have reached storage. The
    // statement is conditional, so it never attaches to accepted content.
    await recordInboxIntakeRemovalIntent(db, {
      id: reservation.id,
      teamId: input.teamId,
      error: publication.message,
    }).catch(() => undefined);
    return {
      status: "rejected",
      code: publication.code,
      message: publication.message,
    };
  }

  let outcome:
    | { type: "accepted" | "deduplicated"; binding: InboxIntakeBinding }
    | { type: "superseded" };
  try {
    outcome = await db.transaction(async (tx) => {
      const executor = tx as unknown as InboxQueryDatabase;
      const locked = await getInboxIntakeBindingForUpdate(executor, {
        id: reservation.id,
        teamId: input.teamId,
      });

      if (locked?.intakeState === "accepted" && locked.status !== "deleted") {
        return { type: "deduplicated" as const, binding: locked };
      }

      const accepted = locked
        ? await acceptInboxIntake(executor, {
            id: reservation.id,
            teamId: input.teamId,
            contentHash,
            contentType: validation.mimeType,
            size: validation.size,
            fileName,
          })
        : undefined;
      if (!accepted) {
        // Cancelled while this attempt was writing: the bytes it published
        // belong to no live record, so record their removal intent.
        if (locked) {
          await recordInboxIntakeRemovalIntent(executor, {
            id: reservation.id,
            teamId: input.teamId,
            error: supersededResult.message,
          });
        }
        return { type: "superseded" as const };
      }

      await enqueueWorkflowJob(executor, {
        name: "process-attachment",
        teamId: input.teamId,
        // Initial processing is keyed by the canonical inbox identity, so two
        // concurrent uploads of the same content cannot create two jobs.
        idempotencyKey: workflowKey.attachment(input.teamId, reservation.id),
        payload: { inboxId: reservation.id, teamId: input.teamId },
      });

      return { type: "accepted" as const, binding: accepted };
    });
  } catch (error) {
    // The transaction rolled back (for example a database error while
    // queueing), so the row is still reserved and its object exists. Record
    // the removal intent on its own statement.
    const message =
      error instanceof Error
        ? `The document could not be stored or verified (${error.message}). Retry the upload.`
        : "The document could not be stored or verified. Retry the upload.";
    await recordInboxIntakeRemovalIntent(db, {
      id: reservation.id,
      teamId: input.teamId,
      error: message,
    }).catch(() => undefined);
    return { status: "rejected", code: "storage_unavailable", message };
  }

  if (outcome.type === "superseded") return supersededResult;
  return acceptedResult(outcome.binding, outcome.type === "deduplicated");
};

export const acceptIntakeUpload = acceptIntake;

/**
 * Re-queues processing for an already accepted workspace document. The caller
 * supplies only an inbox id; path, type and size always come from the row.
 */
export async function retryIntakeProcessing(
  db: PrimaryDatabase,
  params: { teamId: string; inboxId: string },
): Promise<{ inboxId: string; jobId: string; deduplicated: boolean } | null> {
  const client = db as Database;
  return client.transaction(async (tx) => {
    const executor = tx as unknown as InboxQueryDatabase;
    // Lock the canonical inbox row first so concurrent retries serialize here
    // and see each other's pending job instead of enqueueing duplicates.
    const binding = await getInboxIntakeBindingForUpdate(executor, {
      id: params.inboxId,
      teamId: params.teamId,
    });

    if (!binding || binding.status === "deleted") return null;
    if (!binding.filePath?.length) return null;
    // Processing may only start for accepted work. A reservation is not
    // processable and a cancelled record must never restart.
    if (binding.intakeState !== "accepted" && binding.intakeState !== null) {
      return null;
    }

    // While work is already pending, a retry is idempotent: return the job
    // that exists instead of queueing a second one.
    const pending = await findPendingIntakeJob(
      executor as unknown as Database,
      {
        teamId: params.teamId,
        inboxId: binding.id,
      },
    );
    if (pending) {
      return { inboxId: binding.id, jobId: pending.id, deduplicated: true };
    }

    // The worker treats anything other than `processing` as already done, so
    // an explicit retry moves the record back into the processing state.
    await updateInbox(executor, {
      id: binding.id,
      teamId: params.teamId,
      status: "processing",
      processingError: null,
    });

    const enqueued = await enqueueWorkflowJob(executor, {
      name: "process-attachment",
      teamId: params.teamId,
      idempotencyKey: `${workflowKey.attachment(params.teamId, binding.id)}:retry:${randomUUID()}`,
      payload: { inboxId: binding.id, teamId: params.teamId },
    });

    return {
      inboxId: binding.id,
      jobId: enqueued.job.id,
      deduplicated: enqueued.deduplicated,
    };
  });
}

/**
 * Resolves the trusted storage binding a worker must use. New payloads are
 * inbox ids. Legacy payloads, queued before the intake contract, carry a
 * serialized path that only counts when it is this workspace's document path.
 */
export async function resolveWorkerIntakeBinding(
  db: InboxQueryDatabase,
  payload: {
    teamId: string;
    inboxId?: string;
    filePath?: readonly string[];
    mimetype?: string;
    size?: number;
    referenceId?: string;
    website?: string;
    inboxAccountId?: string;
  },
) {
  const binding = payload.inboxId
    ? await getInboxIntakeBinding(db, {
        id: payload.inboxId,
        teamId: payload.teamId,
      })
    : await resolveLegacyWorkerBinding(db, payload);

  if (!binding) return null;
  if (binding.status === "deleted" || binding.intakeState === "cancelled") {
    return null;
  }
  // Unaccepted content is never processable; only legacy rows (null state)
  // predate the intake contract.
  if (binding.intakeState !== null && binding.intakeState !== "accepted") {
    return null;
  }
  return binding;
}

async function resolveLegacyWorkerBinding(
  db: InboxQueryDatabase,
  payload: Parameters<typeof resolveWorkerIntakeBinding>[1],
) {
  const filePath = [...(payload.filePath ?? [])];
  if (documentBindingIssue({ teamId: payload.teamId, filePath }) !== null) {
    return undefined;
  }

  const existing = await getInboxByFilePath(db, {
    teamId: payload.teamId,
    filePath,
  });
  if (existing) return existing;

  if (!payload.mimetype || typeof payload.size !== "number") return undefined;

  const fileName = filePath.at(-1)!;
  const created = await createInbox(db as Database, {
    displayName: fileName,
    teamId: payload.teamId,
    filePath,
    fileName,
    contentType: payload.mimetype,
    size: payload.size,
    referenceId: payload.referenceId,
    website: payload.website,
    inboxAccountId: payload.inboxAccountId,
    status: "processing",
  });
  if (!created) return undefined;

  return getInboxIntakeBinding(db, { id: created.id, teamId: payload.teamId });
}

/**
 * Cheap pre-provider check of the stored bytes against the persisted binding.
 */
export function verifyStoredIntake(
  binding: InboxIntakeBinding,
  bytes: Uint8Array,
) {
  return checkStoredIntakeBytes({
    bytes,
    expectedMimeType: binding.contentType,
    expectedSize: binding.size,
    expectedHash: binding.contentHash,
  });
}

/**
 * Explicit recovery for reservations that never finished. There is no
 * automatic retention schedule in this slice: an operator (or a future
 * scheduled job) calls this with a bounded age.
 */
export async function discardStaleReservations(
  db: InboxQueryDatabase,
  storage: IntakeStorage,
  params: {
    olderThanMs: number;
    limit?: number;
    /** Continue a full pending-removal pass from a previous page. */
    pendingAfter?: InboxIntakeBindingCursor;
  },
) {
  const pendingPage = await listPendingObjectRemovals(db, {
    limit: params.limit,
    after: params.pendingAfter,
  });
  // A full page of outstanding removals (including permanent ambiguous
  // tombstones) must not prevent the finite stale reservation set from being
  // reached eventually. Stale rows are processed on the final pending page of
  // a full pass, when the cursor has reached the end.
  const stale = pendingPage.hasMore
    ? []
    : await listStaleReservedIntake(db, params);
  const discarded: string[] = [];
  const failed: { id: string; error: string }[] = [];
  const unresolved: string[] = [];
  const retained: string[] = [];
  const handled = new Set<string>();

  const removeClaimedObject = async (input: {
    id: string;
    teamId: string;
    filePath: string[] | null;
    /** Only non-ambiguous removals may clear their tombstone. */
    clearAfterRemoval: boolean;
  }) => {
    if (
      input.filePath?.length &&
      (await isStoredPathSharedByLiveDocument(db, {
        id: input.id,
        teamId: input.teamId,
        filePath: input.filePath,
      }))
    ) {
      // A legacy object shared with another live record still belongs to
      // that record. Keep the bytes; the last sharer to go removes them.
      if (input.clearAfterRemoval) {
        await clearObjectRemovalPending(db, {
          id: input.id,
          teamId: input.teamId,
        }).catch(() => undefined);
      }
      retained.push(input.id);
      return;
    }

    if (input.filePath?.length) {
      const controller = new AbortController();
      const abortTimer = setTimeout(
        () => controller.abort(),
        INTAKE_STORAGE_TIMEOUT_MS,
      );
      try {
        await storage.remove({
          bucket: VAULT_BUCKET,
          path: input.filePath,
          signal: controller.signal,
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "unknown removal error";
        await recordIntakeRemovalFailure(db, {
          id: input.id,
          teamId: input.teamId,
          error: `Object removal failed: ${message}`,
        }).catch(() => undefined);
        failed.push({ id: input.id, error: message });
        return;
      } finally {
        clearTimeout(abortTimer);
      }
    }

    if (!input.clearAfterRemoval) {
      // Ambiguous claims keep both the pending tombstone and the ambiguity
      // marker. No pass count can prove a remote write will not arrive later,
      // so the row remains in every full pass until explicit settlement.
      discarded.push(input.id);
      unresolved.push(input.id);
      return;
    }

    try {
      await clearObjectRemovalPending(db, {
        id: input.id,
        teamId: input.teamId,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "unknown tombstone error";
      failed.push({
        id: input.id,
        error: `Object removed but removal tombstone could not be cleared: ${message}`,
      });
      return;
    }
    discarded.push(input.id);
  };

  // Pending rows are processed first. Each one is re-checked with a
  // state-conditional claim, so an accepted row can never be removed and a
  // retry holding a live publication lease makes the cleanup claim a no-op.
  const reservedCutoff = Date.now() - params.olderThanMs;
  for (const pending of pendingPage.rows) {
    if (!pending.teamId || handled.has(pending.id)) continue;
    if (
      pending.intakeState === "reserved" &&
      new Date(pending.createdAt).getTime() >= reservedCutoff
    ) {
      continue;
    }
    handled.add(pending.id);

    if (pending.intakeState === "accepted") {
      // Repair tombstones left by the old bug without touching accepted bytes.
      await clearAcceptedObjectRemovalIntent(db, {
        id: pending.id,
        teamId: pending.teamId,
      }).catch(() => undefined);
      continue;
    }

    const ambiguousClaim = await claimAmbiguousObjectRemovalForDiscard(db, {
      id: pending.id,
      teamId: pending.teamId,
    });
    if (ambiguousClaim) {
      await removeClaimedObject({
        id: ambiguousClaim.id,
        teamId: pending.teamId,
        filePath: ambiguousClaim.filePath,
        clearAfterRemoval: false,
      });
      continue;
    }

    const settledClaim = await claimSettledObjectRemovalForDiscard(db, {
      id: pending.id,
      teamId: pending.teamId,
    });
    if (settledClaim) {
      await removeClaimedObject({
        id: settledClaim.id,
        teamId: pending.teamId,
        filePath: settledClaim.filePath,
        clearAfterRemoval: true,
      });
    }
  }

  for (const reservation of stale) {
    if (!reservation.teamId || handled.has(reservation.id)) continue;
    handled.add(reservation.id);

    // Claim the reservation first. If it finished accepting in the meantime
    // the claim matches nothing and the accepted document is left untouched.
    const claim = await claimReservedIntakeForDiscard(db, {
      id: reservation.id,
      teamId: reservation.teamId,
    });
    if (!claim) continue;

    await removeClaimedObject({
      id: claim.id,
      teamId: reservation.teamId,
      filePath: claim.filePath,
      // A reservation may have had an in-flight writer before this claim
      // acquired the row lock; keep the ambiguity until explicit settlement.
      clearAfterRemoval: false,
    });
  }

  return {
    discarded,
    failed,
    /** Rows whose object was removed but whose remote outcome is unresolved. */
    unresolved,
    /** Rows whose legacy object is still used by another live record. */
    retained,
    nextPendingCursor: pendingPage.nextCursor,
    hasMorePending: pendingPage.hasMore,
  };
}
