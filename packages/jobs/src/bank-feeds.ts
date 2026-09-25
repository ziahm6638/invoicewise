/**
 * Bank connections for optional bank-payment reconciliation
 * (docs/bank-payments.md): turning the feature on for a workspace, connecting,
 * reconnecting and disconnecting a bank through Salt Edge with explicit
 * consent, and the incremental sync that lands its transactions.
 *
 * A bank connection is attributed to a workspace only through the Salt Edge
 * customer InvoiceWise created for it: a returning browser, a callback or a
 * sync that names a connection of any other customer is refused.
 */
import { createHash } from "node:crypto";
import type { Database } from "@invoicewise/db/client";
import {
  type BankFeedConnectionRow,
  type BankFeedTransactionRow,
  createBankFeedConnection,
  enqueueWorkflowJob,
  findTeamByBankCustomer,
  getBankFeedConnection,
  getBankFeedConnectionByProviderId,
  getBankPaymentSettings,
  getUnattachedBankFeedConnection,
  hasActiveBankFeedConnection,
  listAccountTransactions,
  listBankFeedAccounts,
  listBankFeedConnections,
  lockBankPaymentSettings,
  markBankFeedTransaction,
  pruneUncountedBankFeedTransactions,
  setBankPaymentCustomer,
  setBankPaymentsEnabled,
  updateBankFeedAccountCursor,
  updateBankFeedConnection,
  upsertBankFeedAccount,
  upsertBankFeedTransactions,
} from "@invoicewise/db/queries";
import {
  type SaltEdgeClient,
  SaltEdgeError,
  type SaltEdgeTransaction,
  bankPaymentsAvailability,
  createSaltEdgeClient,
  saltEdgeCustomerIdentifier,
} from "./salt-edge";

export const BANK_FEED_PROVIDER = "saltedge";

export const BANK_FEED_LIMITS = {
  /** Consent periods an owner or admin may choose, in days. */
  consentPeriods: [30, 60, 90, 180] as const,
  defaultConsentDays: 90,
  /** How far back transactions are imported on connect. */
  importDays: 365,
  /** Pages of posted transactions per account per sync; the rest continues next run. */
  postedPagesPerSync: 10,
  pendingPagesPerSync: 5,
  /** A dropped pending entry and its posted one may be this many days apart. */
  pendingToPostedDays: 10,
  /** A reversal must follow the entry it offsets within this many days. */
  reversalWindowDays: 45,
  /** Scheduled pull interval for an active connection. */
  syncIntervalHours: 6,
  /** A manual "sync now" is honoured at most once in this many minutes. */
  manualSyncMinutes: 5,
} as const;

export class BankFeedError extends Error {
  override readonly name = "BankFeedError";
  constructor(
    message: string,
    readonly code:
      | "unavailable"
      | "disabled"
      | "not_found"
      | "conflict"
      | "invalid"
      | "forbidden"
      | "provider",
    readonly retryable = false,
  ) {
    super(message);
  }
}

export type BankFeedDeps = {
  env?: NodeJS.ProcessEnv;
  /** Overrides the live client (tests and the fake provider). */
  client?: SaltEdgeClient;
  now?: () => Date;
};

const clientOf = (deps: BankFeedDeps = {}) => {
  if (deps.client) return deps.client;
  const availability = bankPaymentsAvailability(deps.env ?? process.env);
  if (!availability.available) {
    throw new BankFeedError(availability.message, "unavailable");
  }
  return createSaltEdgeClient(availability.config);
};

/** Where the bank sends the browser back after connect or reconnect. */
export const bankReturnUrl = (
  connectionId: string,
  env: NodeJS.ProcessEnv = process.env,
) => {
  const origin = (
    env.NEXT_PUBLIC_URL ||
    env.BETTER_AUTH_URL ||
    "http://localhost:3001"
  ).replace(/\/+$/, "");
  return `${origin}/settings/bank-payments?connection=${encodeURIComponent(connectionId)}`;
};

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const providerError = (error: unknown, action: string) => {
  if (error instanceof BankFeedError) return error;
  if (error instanceof SaltEdgeError) {
    return new BankFeedError(
      `${action}: ${error.message}`,
      "provider",
      error.retryable,
    );
  }
  return new BankFeedError(`${action}: ${errorText(error)}`, "provider", true);
};

const addDays = (day: Date, days: number) => {
  const date = new Date(day);
  date.setUTCDate(date.getUTCDate() + days);
  return date;
};

const isoDay = (value: Date) => value.toISOString().slice(0, 10);

// --- Presenting -------------------------------------------------------------------

export const presentBankConnection = (
  row: BankFeedConnectionRow,
  extra: {
    consentGivenByName?: string | null;
    accounts?: number;
    transactions?: number;
  } = {},
) => ({
  id: row.id,
  provider: row.provider,
  bankName: row.providerName,
  status: row.status,
  consent: {
    status: row.consentStatus,
    periodDays: row.consentPeriodDays,
    givenAt: row.consentGivenAt,
    givenByName: extra.consentGivenByName ?? null,
    expiresAt: row.consentExpiresAt,
  },
  lastError: row.lastError
    ? { class: row.lastErrorClass, message: row.lastError }
    : null,
  sync: {
    status: row.lastSyncStatus,
    startedAt: row.lastSyncStartedAt,
    finishedAt: row.lastSyncFinishedAt,
    error: row.lastSyncError,
    summary: row.lastSyncSummary,
  },
  accounts: extra.accounts ?? 0,
  transactions: extra.transactions ?? 0,
  connectedAt: row.connectedAt,
  disconnectedAt: row.disconnectedAt,
  createdAt: row.createdAt,
});

export async function getBankPaymentsOverview(
  db: Database,
  input: { teamId: string; env?: NodeJS.ProcessEnv },
) {
  const availability = bankPaymentsAvailability(input.env ?? process.env);
  const [settings, connections] = await Promise.all([
    getBankPaymentSettings(db, input.teamId),
    listBankFeedConnections(db, input.teamId),
  ]);
  return {
    available: availability.available,
    unavailableReason: availability.available ? null : availability.message,
    enabled: settings?.enabled ?? false,
    changedAt: settings?.changedAt ?? null,
    consentPeriods: [...BANK_FEED_LIMITS.consentPeriods],
    defaultConsentDays: BANK_FEED_LIMITS.defaultConsentDays,
    connections: connections.map((row) =>
      presentBankConnection(row.connection, row),
    ),
  };
}

// --- Turning the feature on and off -----------------------------------------------

export async function setBankPayments(
  db: Database,
  input: {
    teamId: string;
    actorId: string;
    enabled: boolean;
    env?: NodeJS.ProcessEnv;
  },
) {
  if (input.enabled) {
    const availability = bankPaymentsAvailability(input.env ?? process.env);
    if (!availability.available) {
      throw new BankFeedError(availability.message, "unavailable");
    }
  } else if (await hasActiveBankFeedConnection(db, input.teamId)) {
    throw new BankFeedError(
      "Disconnect every bank before turning bank payments off.",
      "conflict",
    );
  }
  const row = await setBankPaymentsEnabled(db, input);
  return { enabled: row.enabled, changedAt: row.changedAt };
}

async function requireEnabled(db: Database, teamId: string) {
  const settings = await getBankPaymentSettings(db, teamId);
  if (!settings?.enabled) {
    throw new BankFeedError(
      "Turn on bank payments for this workspace first.",
      "disabled",
    );
  }
  return settings;
}

const consentPeriodOf = (days: number | undefined) => {
  const period = days ?? BANK_FEED_LIMITS.defaultConsentDays;
  if (!(BANK_FEED_LIMITS.consentPeriods as readonly number[]).includes(period)) {
    throw new BankFeedError(
      `Choose a consent period of ${BANK_FEED_LIMITS.consentPeriods.join(", ")} days.`,
      "invalid",
    );
  }
  return period;
};

// --- Connect, complete, reconnect, disconnect ------------------------------------------

/**
 * Starts a connect attempt after an owner or admin gave explicit consent:
 * read-only access to accounts and transactions for the chosen period.
 * Returns the provider's page the browser opens.
 */
export async function startBankConnection(
  db: Database,
  input: {
    teamId: string;
    actorId: string;
    consentAccepted: boolean;
    consentPeriodDays?: number;
  },
  deps: BankFeedDeps = {},
) {
  if (input.consentAccepted !== true) {
    throw new BankFeedError(
      "Confirm the consent to read this bank's accounts and transactions first.",
      "invalid",
    );
  }
  const periodDays = consentPeriodOf(input.consentPeriodDays);
  const client = clientOf(deps);
  const env = deps.env ?? process.env;
  await requireEnabled(db, input.teamId);

  // One customer per workspace, created once even when two admins connect at once.
  const customerId = await db.transaction(async (tx) => {
    const executor = tx as unknown as Database;
    const settings = await lockBankPaymentSettings(executor, input.teamId);
    if (settings.providerCustomerId) return settings.providerCustomerId;
    const customer = await client
      .createCustomer(saltEdgeCustomerIdentifier(input.teamId, env))
      .catch((error) => {
        throw providerError(error, "Unable to start the bank connection");
      });
    await setBankPaymentCustomer(executor, {
      teamId: input.teamId,
      customerId: customer.id,
    });
    return customer.id;
  });

  const connection = await createBankFeedConnection(db, {
    teamId: input.teamId,
    provider: BANK_FEED_PROVIDER,
    consentPeriodDays: periodDays,
    consentGivenBy: input.actorId,
  });
  const now = deps.now?.() ?? new Date();
  try {
    const session = await client.connect({
      customerId,
      periodDays,
      fromDate: isoDay(addDays(now, -BANK_FEED_LIMITS.importDays)),
      returnTo: bankReturnUrl(connection.id, env),
      customFields: { connection: connection.id },
    });
    return {
      connectionId: connection.id,
      connectUrl: session.connectUrl,
      expiresAt: session.expiresAt,
    };
  } catch (error) {
    await updateBankFeedConnection(db, {
      teamId: input.teamId,
      connectionId: connection.id,
      set: {
        status: "failed",
        lastError: errorText(error),
        lastErrorClass: error instanceof SaltEdgeError ? error.errorClass : null,
      },
    });
    throw providerError(error, "Unable to start the bank connection");
  }
}

/** Queues a sync of one connection; the key collapses repeats. */
export async function scheduleBankSync(
  db: Database,
  input: { teamId: string; connectionId: string; key: string; runAt?: Date },
) {
  const { job, deduplicated } = await enqueueWorkflowJob(db, {
    name: "sync-bank-connection",
    teamId: input.teamId,
    payload: { teamId: input.teamId, connectionId: input.connectionId },
    idempotencyKey: `${input.teamId}:${input.connectionId}:${input.key}`,
    runAt: input.runAt,
  });
  return { jobId: job.id, deduplicated };
}

/**
 * Attaches a provider connection to a workspace's connection row, after
 * checking with the provider that it belongs to this workspace's customer.
 */
async function attachProviderConnection(
  db: Database,
  input: {
    teamId: string;
    row: BankFeedConnectionRow;
    providerConnectionId: string;
    customerId: string;
    client: SaltEdgeClient;
    now: Date;
  },
) {
  const remote = await input.client
    .getConnection(input.providerConnectionId)
    .catch((error) => {
      if (error instanceof SaltEdgeError && error.notFound) {
        throw new BankFeedError("That bank connection was not found.", "not_found");
      }
      throw providerError(error, "Unable to confirm the bank connection");
    });
  if (remote.customerId !== input.customerId) {
    throw new BankFeedError(
      "That bank connection does not belong to this workspace.",
      "forbidden",
    );
  }
  const existing = await getBankFeedConnectionByProviderId(db, {
    teamId: input.teamId,
    provider: BANK_FEED_PROVIDER,
    providerConnectionId: input.providerConnectionId,
  });
  // The same bank connected again: keep the row that already holds it.
  if (existing && existing.id !== input.row.id) {
    await updateBankFeedConnection(db, {
      teamId: input.teamId,
      connectionId: input.row.id,
      set: {
        status: "failed",
        lastError: "This bank was already connected; the existing connection was kept.",
      },
    });
    return activate(db, {
      teamId: input.teamId,
      row: existing,
      providerName: remote.providerName,
      providerConnectionId: input.providerConnectionId,
      consent: {
        periodDays: input.row.consentPeriodDays,
        givenBy: input.row.consentGivenBy,
        givenAt: input.row.consentGivenAt,
      },
      now: input.now,
    });
  }
  return activate(db, {
    teamId: input.teamId,
    row: input.row,
    providerName: remote.providerName,
    providerConnectionId: input.providerConnectionId,
    now: input.now,
  });
}

async function activate(
  db: Database,
  input: {
    teamId: string;
    row: BankFeedConnectionRow;
    providerName: string | null;
    providerConnectionId: string;
    consent?: { periodDays: number; givenBy: string | null; givenAt: string };
    now: Date;
  },
) {
  const connection = await updateBankFeedConnection(db, {
    teamId: input.teamId,
    connectionId: input.row.id,
    set: {
      providerConnectionId: input.providerConnectionId,
      providerName: input.providerName ?? input.row.providerName,
      status: "active",
      consentStatus: "active",
      ...(input.consent
        ? {
            consentPeriodDays: input.consent.periodDays,
            consentGivenBy: input.consent.givenBy,
            consentGivenAt: input.consent.givenAt,
          }
        : {}),
      connectedAt: input.row.connectedAt ?? input.now.toISOString(),
      disconnectedAt: null,
      disconnectedBy: null,
      lastError: null,
      lastErrorClass: null,
    },
  });
  await scheduleBankSync(db, {
    teamId: input.teamId,
    connectionId: input.row.id,
    key: `connected:${input.now.toISOString()}`,
  });
  return connection!;
}

/**
 * The browser came back from the provider. `providerConnectionId` is what
 * the provider appended to the return URL; without it (or on an error class)
 * the attempt is resolved from the provider's own list for this customer.
 */
export async function completeBankConnection(
  db: Database,
  input: {
    teamId: string;
    connectionId: string;
    providerConnectionId?: string | null;
    errorClass?: string | null;
  },
  deps: BankFeedDeps = {},
) {
  const client = clientOf(deps);
  const now = deps.now?.() ?? new Date();
  const settings = await requireEnabled(db, input.teamId);
  const row = await getBankFeedConnection(db, {
    teamId: input.teamId,
    connectionId: input.connectionId,
  });
  if (!row) throw new BankFeedError("Bank connection not found", "not_found");
  if (!settings.providerCustomerId) {
    throw new BankFeedError("Bank connection not found", "not_found");
  }
  if (row.status === "disconnected") {
    throw new BankFeedError("This bank connection was disconnected.", "conflict");
  }

  if (input.errorClass) {
    const updated = await updateBankFeedConnection(db, {
      teamId: input.teamId,
      connectionId: row.id,
      set: {
        status: row.providerConnectionId ? row.status : "failed",
        lastErrorClass: input.errorClass.slice(0, 200),
        lastError: "The bank connection was not completed.",
      },
    });
    return presentBankConnection(updated!);
  }

  let providerConnectionId =
    input.providerConnectionId?.trim() || row.providerConnectionId || null;
  if (!providerConnectionId) {
    // No id on the return: take the customer's newest connection not yet held.
    const remote = await client
      .listConnections(settings.providerCustomerId)
      .catch((error) => {
        throw providerError(error, "Unable to confirm the bank connection");
      });
    const held = new Set(
      (await listBankFeedConnections(db, input.teamId))
        .map((item) => item.connection.providerConnectionId)
        .filter(Boolean),
    );
    providerConnectionId =
      remote
        .filter((item) => !held.has(item.id))
        .sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }))[0]
        ?.id ?? null;
  }
  if (!providerConnectionId) {
    return presentBankConnection(row);
  }
  const connection = await attachProviderConnection(db, {
    teamId: input.teamId,
    row,
    providerConnectionId,
    customerId: settings.providerCustomerId,
    client,
    now,
  });
  return presentBankConnection(connection);
}

/** Renews consent for an existing connection (expired, revoked, or before expiry). */
export async function reconnectBankConnection(
  db: Database,
  input: {
    teamId: string;
    actorId: string;
    connectionId: string;
    consentAccepted: boolean;
    consentPeriodDays?: number;
  },
  deps: BankFeedDeps = {},
) {
  if (input.consentAccepted !== true) {
    throw new BankFeedError(
      "Confirm the consent to read this bank's accounts and transactions first.",
      "invalid",
    );
  }
  const periodDays = consentPeriodOf(input.consentPeriodDays);
  const client = clientOf(deps);
  const env = deps.env ?? process.env;
  const now = deps.now?.() ?? new Date();
  await requireEnabled(db, input.teamId);
  const row = await getBankFeedConnection(db, {
    teamId: input.teamId,
    connectionId: input.connectionId,
  });
  if (!row) throw new BankFeedError("Bank connection not found", "not_found");
  if (row.status === "disconnected" || !row.providerConnectionId) {
    throw new BankFeedError(
      "Only a connected bank can be reconnected; connect it again instead.",
      "conflict",
    );
  }
  try {
    const session = await client.reconnect(row.providerConnectionId, {
      periodDays,
      fromDate: isoDay(addDays(now, -BANK_FEED_LIMITS.importDays)),
      returnTo: bankReturnUrl(row.id, env),
      customFields: { connection: row.id },
    });
    await updateBankFeedConnection(db, {
      teamId: input.teamId,
      connectionId: row.id,
      set: {
        consentPeriodDays: periodDays,
        consentGivenBy: input.actorId,
        consentGivenAt: now.toISOString(),
        attemptStartedAt: now.toISOString(),
      },
    });
    return { connectionId: row.id, connectUrl: session.connectUrl };
  } catch (error) {
    throw providerError(error, "Unable to reconnect the bank");
  }
}

/**
 * Disconnects a bank: removes the connection at the provider (which revokes
 * its consent), stops syncing, and deletes the transactions no payment
 * decision counts. Counted ones stay as those decisions' evidence.
 */
export async function disconnectBankConnection(
  db: Database,
  input: { teamId: string; actorId: string | null; connectionId: string },
  deps: BankFeedDeps = {},
) {
  const row = await getBankFeedConnection(db, {
    teamId: input.teamId,
    connectionId: input.connectionId,
  });
  if (!row) throw new BankFeedError("Bank connection not found", "not_found");
  if (row.status !== "disconnected" && row.providerConnectionId) {
    const client = clientOf(deps);
    await client.removeConnection(row.providerConnectionId).catch((error) => {
      throw providerError(error, "Unable to disconnect the bank");
    });
  }
  return finishDisconnect(db, {
    teamId: input.teamId,
    row,
    actorId: input.actorId,
    consentStatus: "withdrawn",
    now: deps.now?.() ?? new Date(),
  });
}

async function finishDisconnect(
  db: Database,
  input: {
    teamId: string;
    row: BankFeedConnectionRow;
    actorId: string | null;
    consentStatus: "withdrawn" | "revoked";
    now: Date;
    message?: string;
  },
) {
  return db.transaction(async (tx) => {
    const executor = tx as unknown as Database;
    const updated = await updateBankFeedConnection(executor, {
      teamId: input.teamId,
      connectionId: input.row.id,
      set: {
        status: "disconnected",
        consentStatus: input.consentStatus,
        disconnectedAt: input.row.disconnectedAt ?? input.now.toISOString(),
        disconnectedBy: input.actorId,
        ...(input.message ? { lastError: input.message } : {}),
      },
    });
    const removed = await pruneUncountedBankFeedTransactions(executor, {
      teamId: input.teamId,
      connectionId: input.row.id,
    });
    return { connection: presentBankConnection(updated!), removedTransactions: removed };
  });
}

/** "Sync now": asks the bank for fresh data (best effort) and queues a pull. */
export async function requestBankSync(
  db: Database,
  input: { teamId: string; connectionId: string },
  deps: BankFeedDeps = {},
) {
  const env = deps.env ?? process.env;
  const now = deps.now?.() ?? new Date();
  await requireEnabled(db, input.teamId);
  const row = await getBankFeedConnection(db, {
    teamId: input.teamId,
    connectionId: input.connectionId,
  });
  if (!row) throw new BankFeedError("Bank connection not found", "not_found");
  if (row.status !== "active" || !row.providerConnectionId) {
    throw new BankFeedError(
      row.status === "reconnect_required"
        ? "Renew this bank's consent (Reconnect) before syncing."
        : "Only an active bank connection can be synced.",
      "conflict",
    );
  }
  const client = clientOf(deps);
  const refreshed = await client
    .refresh(row.providerConnectionId, bankReturnUrl(row.id, env))
    .catch(() => false);
  const bucket = Math.floor(
    now.getTime() / (BANK_FEED_LIMITS.manualSyncMinutes * 60_000),
  );
  // Give the bank a moment to answer the refresh before pulling.
  const scheduled = await scheduleBankSync(db, {
    teamId: input.teamId,
    connectionId: row.id,
    key: `manual:${bucket}`,
    runAt: refreshed ? new Date(now.getTime() + 30_000) : undefined,
  });
  return { refreshed, queued: !scheduled.deduplicated };
}

// --- Sync --------------------------------------------------------------------------

const normalizedText = (value: string | null | undefined) =>
  (value ?? "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();

/** Identifies a pending entry across fetches when the provider renumbers it. */
export const transactionFingerprint = (transaction: {
  madeOn: string;
  amount: string;
  currency: string;
  description: string;
}) =>
  createHash("sha256")
    .update(
      [
        transaction.madeOn,
        Number(transaction.amount).toFixed(2),
        transaction.currency,
        normalizedText(transaction.description),
      ].join("|"),
    )
    .digest("hex")
    .slice(0, 32);

const REVERSAL_WORDS =
  /\b(REVERSAL|REVERSED|REVERSE|RETURN|RETURNED|RECALL|RECALLED|CHARGEBACK|UNPAID|BOUNCED|REJECTED|REFUSED)\b/;

const significantWords = (value: string | null | undefined) =>
  normalizedText(value)
    .split(" ")
    .filter(
      (word) =>
        word.length >= 3 && !REVERSAL_WORDS.test(word) && !/^\d{1,2}$/.test(word),
    );

const amountOf = (row: Pick<BankFeedTransactionRow, "amount">) =>
  Math.round(Number(row.amount) * 100);

const dayDiff = (from: string, to: string) =>
  Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);

/**
 * How strongly `entry` reverses `original`, or null when it does not: the
 * exact opposite amount in the same currency on the same account, shortly
 * after, described as a reversal, and naming the same counterparty or
 * repeating the original's words. An opposite amount alone (a supplier's
 * refund, say) is never taken for a reversal. The score (0-1) prefers the
 * original whose words the reversal repeats most.
 */
export const reversalScore = (
  entry: Pick<
    BankFeedTransactionRow,
    "amount" | "currency" | "madeOn" | "description" | "counterparty" | "reference"
  >,
  original: Pick<
    BankFeedTransactionRow,
    "amount" | "currency" | "madeOn" | "description" | "counterparty" | "reference"
  >,
): number | null => {
  if (entry.currency !== original.currency) return null;
  if (amountOf(entry) !== -amountOf(original) || amountOf(entry) === 0) {
    return null;
  }
  const days = dayDiff(original.madeOn, entry.madeOn);
  if (days < 0 || days > BANK_FEED_LIMITS.reversalWindowDays) return null;
  const entryText = normalizedText(
    [entry.description, entry.counterparty, entry.reference].join(" "),
  );
  if (!REVERSAL_WORDS.test(entryText)) return null;
  const sameCounterparty =
    Boolean(entry.counterparty && original.counterparty) &&
    normalizedText(entry.counterparty) === normalizedText(original.counterparty);
  const words = significantWords(
    [original.description, original.reference].join(" "),
  );
  const entryWords = new Set(entryText.split(" "));
  const share =
    words.length > 0
      ? words.filter((word) => entryWords.has(word)).length / words.length
      : 0;
  if (!sameCounterparty && share < 0.5) return null;
  return Math.max(share, sameCounterparty ? 0.5 : 0);
};

export const reverses = (
  entry: Parameters<typeof reversalScore>[0],
  original: Parameters<typeof reversalScore>[1],
) => reversalScore(entry, original) !== null;

const toRow = (transaction: SaltEdgeTransaction) => ({
  providerTransactionId: transaction.id,
  status: transaction.status,
  duplicated: transaction.duplicated,
  mode: transaction.mode,
  madeOn: transaction.madeOn,
  amount: transaction.amount,
  currency: transaction.currency,
  description: transaction.description.slice(0, 2_000),
  counterparty: transaction.counterparty?.slice(0, 500) ?? null,
  reference: transaction.reference?.slice(0, 1_000) ?? null,
  fingerprint: transactionFingerprint(transaction),
});

type SyncSummary = {
  accounts: number;
  postedFetched: number;
  postedNew: number;
  pending: number;
  superseded: number;
  reversed: number;
  duplicated: number;
  more: boolean;
};

export type SyncBankConnectionOutcome =
  | { outcome: "skipped"; reason: string }
  | { outcome: "waiting"; reason: string }
  | { outcome: "reconnect_required"; consent: string }
  | { outcome: "disconnected"; reason: string }
  | { outcome: "synced"; summary: SyncSummary; changed: boolean };

/** The provider is still fetching from the bank; the job retries shortly. */
export class BankSyncNotReady extends Error {
  readonly retryable = true;
}

/**
 * Pulls one connection: consent, accounts, posted transactions from each
 * account's durable cursor, and the current pending list. New posted entries
 * resolve pending ones they replace and reversals they offset. Stores what it
 * did on the connection for the dashboard.
 */
export async function syncBankConnection(
  db: Database,
  input: { teamId: string; connectionId: string; finalAttempt?: boolean },
  deps: BankFeedDeps = {},
): Promise<SyncBankConnectionOutcome> {
  const now = deps.now?.() ?? new Date();
  const settings = await getBankPaymentSettings(db, input.teamId);
  const row = await getBankFeedConnection(db, {
    teamId: input.teamId,
    connectionId: input.connectionId,
  });
  if (!row) return { outcome: "skipped", reason: "not_found" };
  if (!settings?.enabled) return { outcome: "skipped", reason: "disabled" };
  if (row.status !== "active" || !row.providerConnectionId) {
    return { outcome: "skipped", reason: row.status };
  }
  const client = clientOf(deps);
  const providerConnectionId = row.providerConnectionId;
  await updateBankFeedConnection(db, {
    teamId: input.teamId,
    connectionId: row.id,
    set: { lastSyncStartedAt: now.toISOString(), lastSyncStatus: "running" },
  });

  const fail = async (message: string) => {
    await updateBankFeedConnection(db, {
      teamId: input.teamId,
      connectionId: row.id,
      set: {
        lastSyncStatus: "failed",
        lastSyncFinishedAt: new Date().toISOString(),
        lastSyncError: message.slice(0, 1_000),
      },
    });
  };

  try {
    const remote = await client.getConnection(providerConnectionId);
    if (remote.customerId !== settings.providerCustomerId) {
      await fail("The provider reports this connection under another customer.");
      throw new BankFeedError(
        "Bank connection does not belong to this workspace",
        "forbidden",
      );
    }
    if (remote.lastAttemptFinished === false && !input.finalAttempt) {
      await updateBankFeedConnection(db, {
        teamId: input.teamId,
        connectionId: row.id,
        set: { lastSyncStatus: null },
      });
      throw new BankSyncNotReady("The bank is still sending data");
    }

    // Consent first: an expired or revoked consent stops the pull.
    const consents = await client.listConsents(providerConnectionId);
    const consent =
      consents.find((item) => item.status === "active") ??
      [...consents].sort((a, b) =>
        (b.expiresAt ?? "").localeCompare(a.expiresAt ?? ""),
      )[0];
    const consentStatus =
      consent?.status === "expired" || consent?.status === "revoked"
        ? consent.status
        : "active";
    const consentExpired =
      consent?.expiresAt && Date.parse(consent.expiresAt) <= now.getTime();
    if (consentStatus !== "active" || consentExpired || remote.status === "inactive") {
      const status = consentExpired ? "expired" : consentStatus === "active" ? "revoked" : consentStatus;
      await updateBankFeedConnection(db, {
        teamId: input.teamId,
        connectionId: row.id,
        set: {
          status: "reconnect_required",
          consentStatus: status,
          consentId: consent?.id ?? row.consentId,
          consentExpiresAt: consent?.expiresAt ?? row.consentExpiresAt,
          providerName: remote.providerName ?? row.providerName,
          lastSyncStatus: "failed",
          lastSyncFinishedAt: new Date().toISOString(),
          lastSyncError:
            status === "expired"
              ? "The bank consent has expired. Reconnect to renew it."
              : "The bank consent was revoked. Reconnect to give it again.",
        },
      });
      return { outcome: "reconnect_required", consent: status };
    }

    const summary: SyncSummary = {
      accounts: 0,
      postedFetched: 0,
      postedNew: 0,
      pending: 0,
      superseded: 0,
      reversed: 0,
      duplicated: 0,
      more: false,
    };
    const accounts = await client.listAccounts(providerConnectionId);
    summary.accounts = accounts.length;
    for (const account of accounts) {
      const stored = await upsertBankFeedAccount(db, {
        teamId: input.teamId,
        connectionId: row.id,
        providerAccountId: account.id,
        name: account.name,
        nature: account.nature,
        currency: account.currency,
      });

      // Posted: from the durable cursor (inclusive), page by page. The cursor
      // is saved after each page, so an interrupted sync resumes there.
      let cursor = stored.postedCursor;
      for (let page = 0; page < BANK_FEED_LIMITS.postedPagesPerSync; page += 1) {
        const { transactions, nextId } = await client.listTransactions({
          connectionId: providerConnectionId,
          accountId: account.id,
          pending: false,
          fromId: cursor,
        });
        const posted = transactions.filter((item) => item.status === "posted");
        summary.postedFetched += posted.length;
        summary.duplicated += posted.filter((item) => item.duplicated).length;
        const result = await upsertBankFeedTransactions(db, {
          teamId: input.teamId,
          connectionId: row.id,
          accountId: stored.id,
          transactions: posted.map(toRow),
        });
        summary.postedNew += result.inserted;
        const last = posted.at(-1)?.id ?? null;
        cursor = nextId ?? last ?? cursor;
        await updateBankFeedAccountCursor(db, {
          teamId: input.teamId,
          accountId: stored.id,
          postedCursor: cursor,
        });
        if (!nextId) break;
        if (page === BANK_FEED_LIMITS.postedPagesPerSync - 1) summary.more = true;
      }

      // Pending: the whole current list, every sync.
      const pending: SaltEdgeTransaction[] = [];
      let fromId: string | null = null;
      for (let page = 0; page < BANK_FEED_LIMITS.pendingPagesPerSync; page += 1) {
        const { transactions, nextId } = await client.listTransactions({
          connectionId: providerConnectionId,
          accountId: account.id,
          pending: true,
          fromId,
        });
        pending.push(...transactions.filter((item) => item.status === "pending"));
        fromId = nextId;
        if (!nextId) break;
      }
      summary.pending += pending.length;
      const resolved = await reconcileAccount(db, {
        teamId: input.teamId,
        connectionId: row.id,
        accountId: stored.id,
        pending,
        now,
      });
      summary.superseded += resolved.superseded;
      summary.reversed += resolved.reversed;
    }

    await updateBankFeedConnection(db, {
      teamId: input.teamId,
      connectionId: row.id,
      set: {
        providerName: remote.providerName ?? row.providerName,
        consentStatus: "active",
        consentId: consent?.id ?? row.consentId,
        consentExpiresAt: consent?.expiresAt ?? row.consentExpiresAt,
        lastSyncStatus: "succeeded",
        lastSyncFinishedAt: new Date().toISOString(),
        lastSyncError: null,
        lastSyncSummary: summary,
      },
    });
    if (summary.more) {
      await scheduleBankSync(db, {
        teamId: input.teamId,
        connectionId: row.id,
        key: `continue:${now.toISOString()}`,
      });
    }
    const changed =
      summary.postedNew + summary.pending + summary.superseded + summary.reversed >
      0;
    return { outcome: "synced", summary, changed };
  } catch (error) {
    if (error instanceof BankSyncNotReady || error instanceof BankFeedError) {
      throw error;
    }
    if (error instanceof SaltEdgeError) {
      if (error.consentGone) {
        await updateBankFeedConnection(db, {
          teamId: input.teamId,
          connectionId: row.id,
          set: {
            status: "reconnect_required",
            consentStatus: /Revoked/.test(error.errorClass ?? "")
              ? "revoked"
              : "expired",
            lastSyncStatus: "failed",
            lastSyncFinishedAt: new Date().toISOString(),
            lastSyncError: "The bank consent is no longer valid. Reconnect to renew it.",
          },
        });
        return { outcome: "reconnect_required", consent: "expired" };
      }
      if (error.notFound) {
        // Removed at the provider (by the customer at their bank, say).
        await finishDisconnect(db, {
          teamId: input.teamId,
          row,
          actorId: null,
          consentStatus: "revoked",
          now,
          message: "The bank connection was removed at the bank data provider.",
        });
        return { outcome: "disconnected", reason: "removed_at_provider" };
      }
      await fail(error.message);
      throw new BankFeedError(
        `Bank sync failed: ${error.message}`,
        "provider",
        error.retryable,
      );
    }
    await fail(errorText(error));
    throw error;
  }
}

/**
 * Resolves an account's pending entries against the current pending list and
 * newly posted entries, and marks reversals.
 */
async function reconcileAccount(
  db: Database,
  input: {
    teamId: string;
    connectionId: string;
    accountId: string;
    pending: SaltEdgeTransaction[];
    now: Date;
  },
) {
  let superseded = 0;
  let reversed = 0;
  const since = addDays(input.now, -BANK_FEED_LIMITS.importDays - 30)
    .toISOString()
    .slice(0, 10);
  const stored = await listAccountTransactions(db, {
    teamId: input.teamId,
    accountId: input.accountId,
    statuses: ["pending", "posted", "reversed", "superseded"],
    since,
  });
  const fetchedIds = new Set(input.pending.map((item) => item.id));
  const storedPending = stored.filter((row) => row.status === "pending");

  // A pending entry renumbered by the provider keeps its row.
  const byProviderId = new Set(stored.map((row) => row.providerTransactionId));
  for (const item of input.pending) {
    if (byProviderId.has(item.id)) continue;
    const fingerprint = transactionFingerprint(item);
    const renumbered = storedPending.find(
      (row) =>
        row.fingerprint === fingerprint && !fetchedIds.has(row.providerTransactionId),
    );
    if (renumbered) {
      await markBankFeedTransaction(db, {
        teamId: input.teamId,
        transactionId: renumbered.id,
        set: { providerTransactionId: item.id },
      });
      renumbered.providerTransactionId = item.id;
    }
  }
  await upsertBankFeedTransactions(db, {
    teamId: input.teamId,
    connectionId: input.connectionId,
    accountId: input.accountId,
    transactions: input.pending.map(toRow),
  });

  const rows = await listAccountTransactions(db, {
    teamId: input.teamId,
    accountId: input.accountId,
    statuses: ["pending", "posted", "reversed", "superseded"],
    since,
  });
  const posted = rows.filter((row) => row.status === "posted");
  const claimed = new Set(
    rows.map((row) => row.supersededById).filter((id): id is string => Boolean(id)),
  );

  // Pending entries no longer listed (and earlier ones marked dropped): the
  // posted entry that replaced them, else they were dropped by the bank.
  const vanished = rows.filter(
    (row) =>
      (row.status === "pending" && !fetchedIds.has(row.providerTransactionId)) ||
      (row.status === "reversed" &&
        (row.reversal as { kind?: string } | null)?.kind === "pending_dropped"),
  );
  for (const row of vanished) {
    const replacement = posted.find(
      (candidate) =>
        !claimed.has(candidate.id) &&
        candidate.currency === row.currency &&
        amountOf(candidate) === amountOf(row) &&
        dayDiff(row.madeOn, candidate.madeOn) >= -3 &&
        dayDiff(row.madeOn, candidate.madeOn) <= BANK_FEED_LIMITS.pendingToPostedDays,
    );
    if (replacement) {
      claimed.add(replacement.id);
      await markBankFeedTransaction(db, {
        teamId: input.teamId,
        transactionId: row.id,
        set: { status: "superseded", supersededById: replacement.id, reversal: null },
      });
      superseded += 1;
    } else if (row.status === "pending") {
      await markBankFeedTransaction(db, {
        teamId: input.teamId,
        transactionId: row.id,
        set: {
          status: "reversed",
          reversal: {
            kind: "pending_dropped",
            detectedAt: input.now.toISOString(),
            message: "The bank dropped this pending entry without posting it.",
          },
        },
      });
      reversed += 1;
    }
  }

  // Posted reversals: the offsetting entry and the entry it reverses.
  const open = posted.filter((row) => !row.reversedById);
  const used = new Set<string>();
  for (const entry of open) {
    if (used.has(entry.id)) continue;
    const original = open
      .filter((candidate) => candidate.id !== entry.id && !used.has(candidate.id))
      .map((candidate) => ({ candidate, score: reversalScore(entry, candidate) }))
      .filter((item): item is { candidate: BankFeedTransactionRow; score: number } =>
        item.score !== null,
      )
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.candidate.madeOn.localeCompare(a.candidate.madeOn),
      )[0]?.candidate;
    if (!original) continue;
    used.add(entry.id);
    used.add(original.id);
    await markBankFeedTransaction(db, {
      teamId: input.teamId,
      transactionId: original.id,
      set: {
        status: "reversed",
        reversedById: entry.id,
        reversal: {
          kind: "reversed_by",
          transactionId: entry.id,
          madeOn: entry.madeOn,
          detectedAt: input.now.toISOString(),
          message: `Reversed on ${entry.madeOn} by "${entry.description}".`,
        },
      },
    });
    await markBankFeedTransaction(db, {
      teamId: input.teamId,
      transactionId: entry.id,
      set: {
        status: "reversed",
        reversal: {
          kind: "reversal_of",
          transactionId: original.id,
          madeOn: original.madeOn,
          detectedAt: input.now.toISOString(),
          message: `Reverses the ${original.madeOn} entry "${original.description}".`,
        },
      },
    });
    reversed += 2;
  }
  return { superseded, reversed };
}

// --- Provider callbacks -----------------------------------------------------------------

export type SaltEdgeCallbackType = "success" | "fail" | "notify" | "destroy" | "service";

/**
 * A verified Salt Edge callback. The workspace is the one whose own customer
 * the callback names; anything else is acknowledged and ignored so the
 * provider stops retrying.
 */
export async function handleSaltEdgeCallback(
  db: Database,
  input: { type: SaltEdgeCallbackType; payload: unknown },
  deps: BankFeedDeps = {},
): Promise<{ outcome: string }> {
  const now = deps.now?.() ?? new Date();
  const data = (input.payload as { data?: Record<string, unknown> } | null)?.data;
  if (!data || typeof data !== "object") return { outcome: "ignored" };
  const connectionId = String(data.connection_id ?? "");
  const customerId = String(data.customer_id ?? "");
  const customFields = (data.custom_fields ?? {}) as Record<string, unknown>;
  if (input.type === "service") return { outcome: "ignored" };

  let team: { teamId: string } | null = null;
  if (customerId) {
    team = await findTeamByBankCustomer(db, {
      provider: BANK_FEED_PROVIDER,
      customerId,
    });
  }
  if (!team && input.type === "fail" && typeof customFields.connection === "string") {
    // A failure before the connection existed carries only our own row id;
    // it may only mark that row, which is still pending.
    const pending = /^[0-9a-f-]{36}$/i.test(customFields.connection)
      ? await getUnattachedBankFeedConnection(db, customFields.connection)
      : null;
    if (pending) {
      await updateBankFeedConnection(db, {
        teamId: pending.teamId,
        connectionId: pending.id,
        set: {
          status: "failed",
          lastErrorClass: String(data.error_class ?? "").slice(0, 200) || null,
          lastError: String(data.error_message ?? "The bank connection failed.").slice(0, 1_000),
        },
      });
      return { outcome: "failed_attempt" };
    }
    return { outcome: "ignored" };
  }
  if (!team) return { outcome: "ignored" };

  let row = connectionId
    ? await getBankFeedConnectionByProviderId(db, {
        teamId: team.teamId,
        provider: BANK_FEED_PROVIDER,
        providerConnectionId: connectionId,
      })
    : null;

  if (input.type === "destroy") {
    if (!row || row.status === "disconnected") return { outcome: "ignored" };
    await finishDisconnect(db, {
      teamId: team.teamId,
      row,
      actorId: null,
      consentStatus: "revoked",
      now,
      message: "The bank connection was removed at the bank or the provider.",
    });
    return { outcome: "disconnected" };
  }

  if (input.type === "fail") {
    if (!row) return { outcome: "ignored" };
    await updateBankFeedConnection(db, {
      teamId: team.teamId,
      connectionId: row.id,
      set: {
        lastErrorClass: String(data.error_class ?? "").slice(0, 200) || null,
        lastError: String(data.error_message ?? "The bank connection failed.").slice(0, 1_000),
        ...(row.providerConnectionId ? {} : { status: "failed" }),
      },
    });
    return { outcome: "failed" };
  }

  // success / notify
  if (!row && typeof customFields.connection === "string") {
    const own = await getBankFeedConnection(db, {
      teamId: team.teamId,
      connectionId: customFields.connection,
    });
    if (own && own.status !== "disconnected") {
      // Ownership is the customer's, which the provider confirmed by sending it.
      row = await activate(db, {
        teamId: team.teamId,
        row: own,
        providerName: null,
        providerConnectionId: connectionId,
        now,
      });
      return { outcome: "connected" };
    }
  }
  if (!row) return { outcome: "ignored" };
  const stage = String(data.stage ?? "");
  const finished =
    (input.type === "success" && stage === "finish") ||
    (input.type === "notify" && stage === "finish_fetching");
  if (row.status !== "active" && input.type === "success" && stage === "finish") {
    // A reconnect finished: the consent is live again.
    await activate(db, {
      teamId: team.teamId,
      row,
      providerName: null,
      providerConnectionId: connectionId,
      now,
    });
    return { outcome: "reconnected" };
  }
  if (finished && row.status === "active") {
    await scheduleBankSync(db, {
      teamId: team.teamId,
      connectionId: row.id,
      key: `callback:${input.type}:${now.toISOString()}`,
    });
    return { outcome: "sync_queued" };
  }
  return { outcome: "noted" };
}

/** Every connection a deleted workspace still holds at the provider. */
export async function workspaceBankCustomer(db: Database, teamId: string) {
  const settings = await getBankPaymentSettings(db, teamId);
  return settings?.providerCustomerId ?? null;
}

export { listBankFeedAccounts };
