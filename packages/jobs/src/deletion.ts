import type { Database } from "@invoicewise/db/client";
import {
  beginDeletionAttempt,
  completeDeletionRequest,
  recordDeletionProgress,
} from "@invoicewise/db/queries";
import type { DeletionConnection } from "@invoicewise/db/schema";
import { decrypt } from "@invoicewise/encryption";
import { revokeAccountingConnection } from "./accounting";

const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";

/** Workspace and account ids are UUIDs; anything else never names a prefix. */
const SUBJECT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class DeletionCleanupError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export type DeletionCleanupDeps = {
  db: Database;
  storage: {
    removePrefix: (input: {
      bucket: string;
      prefix: string[];
    }) => Promise<void>;
  };
  revokeConnection: (connection: DeletionConnection) => Promise<void>;
  now?: () => Date;
};

export type DeletionCleanupResult =
  | { deletionId: string; status: "completed" }
  | { deletionId: string; status: "waiting"; resumeAt: string }
  | { deletionId: string; status: "skipped"; reason: string };

/**
 * Revokes a Google mailbox grant. Google answers `invalid_token` for a token it
 * no longer honours, which is the state revocation is after.
 */
export async function revokeGoogleToken(
  refreshToken: string,
  fetcher: typeof fetch = fetch,
) {
  const response = await fetcher(GOOGLE_REVOKE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: refreshToken }),
  });

  if (response.ok) return;

  const body = (await response.json().catch(() => null)) as {
    error?: unknown;
  } | null;

  if (response.status === 400 && body?.error === "invalid_token") return;

  throw new DeletionCleanupError(
    `Google token revocation returned HTTP ${response.status}`,
    response.status === 429 || response.status >= 500,
  );
}

/** Revokes one captured provider connection with the live provider clients. */
export const revokeDeletionConnection = async (
  connection: DeletionConnection,
  env = process.env,
) => {
  if (connection.kind === "accounting") {
    await revokeAccountingConnection(connection, env);
    return;
  }

  // Deleting the account row already destroyed the stored tokens. Gmail can
  // also revoke the grant itself; other mailbox providers have no
  // per-token revocation, so destroying the tokens is the revocation.
  if (connection.provider === "gmail" && connection.refreshToken) {
    await revokeGoogleToken(decrypt(connection.refreshToken));
  }
};

const markRevoked = (
  connection: DeletionConnection,
  at: string,
): DeletionConnection =>
  connection.kind === "mailbox"
    ? { ...connection, refreshToken: null, revokedAt: at }
    : { ...connection, revokedAt: at };

/**
 * Finishes a recorded deletion outside the database.
 *
 * Every step records its progress on the deletion request before the next one
 * starts, so a run that fails or is interrupted resumes where it stopped: a
 * revoked connection is not revoked twice and a purged prefix is not listed
 * again. Private objects are purged only after the request's quiesce time; an
 * earlier run returns `waiting` and the caller schedules the rest.
 */
export async function runDeletionCleanup(
  deps: DeletionCleanupDeps,
  deletionId: string,
): Promise<DeletionCleanupResult> {
  const now = deps.now ?? (() => new Date());
  const request = await beginDeletionAttempt(deps.db, deletionId);

  if (!request) {
    return { deletionId, status: "skipped", reason: "not found" };
  }

  if (request.status === "completed") {
    return { deletionId, status: "skipped", reason: "already completed" };
  }

  if (!SUBJECT_ID.test(request.subjectId)) {
    throw new DeletionCleanupError(
      "Deletion subject is not a valid id; nothing was purged",
      false,
    );
  }

  if (!request.connectionsRevokedAt) {
    const connections = [...request.connections];

    for (const [index, connection] of connections.entries()) {
      if (connection.revokedAt) continue;

      try {
        await deps.revokeConnection(connection);
      } catch (error) {
        throw new DeletionCleanupError(
          `Unable to revoke ${connection.kind} connection (${connection.provider}): ${
            error instanceof Error ? error.message : String(error)
          }`,
          !(error instanceof DeletionCleanupError) || error.retryable,
        );
      }

      connections[index] = markRevoked(connection, now().toISOString());
      await recordDeletionProgress(deps.db, deletionId, { connections });
    }

    await recordDeletionProgress(deps.db, deletionId, {
      connections,
      connectionsRevokedAt: now().toISOString(),
    });
  }

  if (!request.storagePurgedAt) {
    if (now().getTime() < Date.parse(request.quiesceUntil)) {
      return {
        deletionId,
        status: "waiting",
        resumeAt: new Date(request.quiesceUntil).toISOString(),
      };
    }

    try {
      await deps.storage.removePrefix({
        bucket: "vault",
        prefix: [request.subjectId],
      });
    } catch (error) {
      throw new DeletionCleanupError(
        `Unable to purge stored objects: ${
          error instanceof Error ? error.message : String(error)
        }`,
        true,
      );
    }

    await recordDeletionProgress(deps.db, deletionId, {
      storagePurgedAt: now().toISOString(),
    });
  }

  await completeDeletionRequest(deps.db, deletionId);

  return { deletionId, status: "completed" };
}
