import type { Database, PrimaryDatabase } from "@db/client";
import {
  documentTexts,
  inboundEmails,
  inbox,
  inboxAccounts,
  inboxEmbeddings,
  inboxRedeliveries,
  invoicePaymentMatches,
  invoiceSourceMatches,
  questionAnswers,
  suppliers,
  transactionAttachments,
  transactionEmbeddings,
  transactionMatchSuggestions,
  transactions,
  userQuestions,
} from "@db/schema";
import { remove as removeStoredFile } from "@db/storage";
import { buildSearchQuery } from "@invoicewise/db/utils/search-query";
import { logger } from "@invoicewise/logger";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
  sql,
} from "drizzle-orm";
import type { SQL } from "drizzle-orm/sql/sql";

/**
 * Product and API reads show accepted documents and legacy rows (null
 * `intake_state`). An unfinished `reserved` intake is not an invoice yet, so
 * it never appears in listings, exports or detail reads.
 */
const visibleIntakeState = () =>
  or(isNull(inbox.intakeState), ne(inbox.intakeState, "reserved"))!;

export type InvoiceDeliveryState =
  | "none"
  | "held"
  | "dismissed"
  | "pending"
  | "delivered"
  | "failed"
  | "cancelled";

export type InvoiceDeliverySummary = {
  state: InvoiceDeliveryState;
  total: number;
  succeeded: number;
  pending: number;
  failed: number;
  cancelled: number;
};

/**
 * The current revision's delivery decision held a destination and no one has
 * released or dismissed it yet (docs/delivery.md#delivery-rules).
 */
const decisionIs = (resolution: "unresolved" | "dismissed") =>
  sql`exists (
    select 1 from delivery_decisions dd
    where dd.invoice_id = ${inbox.id}
      and dd.team_id = ${inbox.teamId}
      and dd.revision = ${inbox.processingRevision}
      and dd.outcome = 'hold'
      and (dd.accounting = 'held' or dd.webhooks = 'held')
      and ${resolution === "unresolved" ? sql`dd.resolution is null` : sql`dd.resolution = 'dismissed'`}
  )`;

/**
 * Outcome of the destinations the current processing revision was delivered
 * to: its webhook deliveries (not `delivery.failed` notifications) and the
 * invoice's accounting post. "held" means the delivery rules withheld a
 * destination and it awaits a person; "dismissed" that a person decided it
 * is not delivered. "delivered" means at least one destination was
 * configured and every one that was not cancelled succeeded. Legacy
 * `inbox.status` values play no part.
 */
const invoiceDeliverySummary = () =>
  sql<InvoiceDeliverySummary>`(
    select json_build_object(
      'state', case
        when ${decisionIs("unresolved")} then 'held'
        when count(*) filter (where d.status = 'failed') > 0 then 'failed'
        when ${decisionIs("dismissed")} then 'dismissed'
        when count(*) filter (where d.status in ('queued', 'delivering')) > 0 then 'pending'
        when count(*) filter (where d.status = 'succeeded') > 0 then 'delivered'
        when count(*) > 0 then 'cancelled'
        else 'none'
      end,
      'total', count(*),
      'succeeded', count(*) filter (where d.status = 'succeeded'),
      'pending', count(*) filter (where d.status in ('queued', 'delivering')),
      'failed', count(*) filter (where d.status = 'failed'),
      'cancelled', count(*) filter (where d.status = 'cancelled')
    )
    from (
      select wd.status::text as status
      from webhook_deliveries wd
      where wd.invoice_id = ${inbox.id}
        and wd.team_id = ${inbox.teamId}
        and wd.revision = ${inbox.processingRevision}
        and wd.event <> 'delivery.failed'
      union all
      select case
        when ${inbox.accountingPostStatus} in ('posted', 'already_posted') then 'succeeded'
        -- A post held for review awaits the user like a failure does.
        when ${inbox.accountingPostStatus}::text = 'needs_review' then 'failed'
        else ${inbox.accountingPostStatus}::text
      end
      where ${inbox.accountingPostStatus} is not null
      union all
      -- The in-place update of a posted bill the newest correction asked
      -- for: an update still queued is not delivered, and a failed or
      -- cancelled one needs retrying. A later correction or a re-extraction
      -- supersedes an earlier update.
      select * from (
        select case c.update_status
          when 'updated' then 'succeeded'
          when 'cancelled' then 'failed'
          when 'superseded' then null
          else c.update_status
        end as status
        from invoice_corrections c
        where c.invoice_id = ${inbox.id}
          and c.team_id = ${inbox.teamId}
        order by c.version desc
        limit 1
      ) latest_update
      where latest_update.status is not null
    ) d
  )`;

/**
 * The decision of the invoice's current revision as JSON, for list and
 * detail reads: null for invoices processed before delivery rules existed.
 */
export const currentDeliveryDecisionSql = () =>
  sql<Record<string, unknown> | null>`(
    select json_build_object(
      'id', d.id,
      'revision', d.revision,
      'policyVersion', d.policy_version,
      'rulesVersion', d.rules_version,
      'outcome', d.outcome,
      'reasons', d.reasons,
      'accounting', d.accounting,
      'webhooks', d.webhooks,
      'resolution', d.resolution,
      'resolutionReason', d.resolution_reason,
      'resolvedAt', d.resolved_at,
      'resolvedBy', d.resolved_by,
      'createdAt', d.created_at
    )
    from delivery_decisions d
    where d.invoice_id = ${inbox.id}
      and d.team_id = ${inbox.teamId}
      and d.revision = ${inbox.processingRevision}
  )`;

/**
 * A document left `processing` although its processing job has failed and
 * none is pending: the worker died after its final attempt before recording
 * the failure. It is shown as failed and may be re-extracted; the delivery
 * reconciler records the failure (`listStalledProcessing`).
 */
const processingJobs = () =>
  sql`select 1 from workflow_jobs j
      where j.name = 'process-attachment'
        and j.team_id = ${inbox.teamId}
        and j.payload ->> 'inboxId' = ${inbox.id}::text`;

export const processingStalledSql = () =>
  sql<boolean>`(${inbox.status} = 'processing'
    and exists (${processingJobs()} and j.status = 'failed')
    and not exists (${processingJobs()} and j.status in ('queued', 'running')))`;

/** Whether the invoice has been corrected by a user at any revision. */
const correctionCount = () =>
  sql<number>`(select count(*)::int from invoice_corrections c where c.invoice_id = ${inbox.id} and c.team_id = ${inbox.teamId})`;

/**
 * Exception states the invoice list can be filtered by. They follow the
 * dashboard's own reading of a record (`getInvoiceState`), so a filter shows
 * exactly the invoices that carry that badge.
 */
export const INVOICE_STATE_FILTERS = [
  "needs_attention",
  "processing",
  "failed",
  "invalid",
  "needs_review",
  "held",
  "delivering",
  "delivery_failed",
  "delivered",
  "corrected",
] as const;

export type InvoiceStateFilter = (typeof INVOICE_STATE_FILTERS)[number];

const deliveryStateIs = (state: InvoiceDeliveryState) =>
  sql`(${invoiceDeliverySummary()} ->> 'state') = ${state}`;

const extractionFailed = () =>
  sql`((${inbox.status} is null or ${inbox.status} not in ('new', 'processing', 'analyzing'))
    and (${inbox.processingError} is not null or ${inbox.extraction} is null))
    or ${processingStalledSql()}`;

/** The delivery badge, which processing and failed extraction take precedence over. */
const deliveryStateIsShown = (state: InvoiceDeliveryState) =>
  sql`(coalesce(${inbox.status}::text, '') not in ('new', 'processing', 'analyzing')
    and not coalesce(${extractionFailed()}, false)
    and ${deliveryStateIs(state)})`;

const validationIs = (status: "invalid" | "needs_review") =>
  sql`(${inbox.processingError} is null and ${inbox.extraction} is not null
    and ${inbox.status} not in ('new', 'processing', 'analyzing')
    and ${inbox.validation} ->> 'status' = ${status})`;

const stateCondition = (state: InvoiceStateFilter): SQL => {
  switch (state) {
    case "processing":
      return sql`(${inbox.status} in ('new', 'processing', 'analyzing') and not ${processingStalledSql()})`;
    case "failed":
      return sql`(${extractionFailed()})`;
    case "invalid":
      return validationIs("invalid");
    case "needs_review":
      return validationIs("needs_review");
    case "held":
      return deliveryStateIsShown("held");
    case "delivering":
      return deliveryStateIsShown("pending");
    case "delivery_failed":
      return deliveryStateIsShown("failed");
    case "delivered":
      return deliveryStateIsShown("delivered");
    case "corrected":
      return sql`${correctionCount()} > 0`;
    case "needs_attention":
      // An invoice an owner or admin dismissed has been dealt with.
      return sql`((${extractionFailed()}
        or ${validationIs("invalid")}
        or ${validationIs("needs_review")}
        or ${deliveryStateIs("failed")}
        or ${deliveryStateIs("held")}
        or ${inbox.judgmentsRerunStatus} = 'failed')
        and not ${decisionIs("dismissed")})`;
  }
};

// Scoring functions for suggestion ranking
function calculateAmountScore(
  item1: { amount: number | null },
  item2: { amount: number | null },
): number {
  const amount1 = item1.amount;
  const amount2 = item2.amount;

  if (amount1 === null || amount2 === null) return 0.0;

  const abs1 = Math.abs(amount1);
  const abs2 = Math.abs(amount2);

  if (abs1 === abs2) return 1.0;

  const diff = Math.abs(abs1 - abs2);
  const max = Math.max(abs1, abs2);
  const percentDiff = diff / max;

  if (percentDiff <= 0.05) return 0.9;
  if (percentDiff <= 0.15) return 0.7;
  return 0.3;
}

function calculateCurrencyScore(
  currency1?: string,
  currency2?: string,
): number {
  if (!currency1 || !currency2) return 0.5;
  if (currency1 === currency2) return 1.0;
  return 0.3;
}

function calculateDateScore(
  inboxDate: string,
  transactionDate: string,
): number {
  const inboxDateObj = new Date(inboxDate);
  const transactionDateObj = new Date(transactionDate);
  const diffTime = Math.abs(
    transactionDateObj.getTime() - inboxDateObj.getTime(),
  );
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return 1.0;
  if (diffDays <= 1) return 0.9;
  if (diffDays <= 3) return 0.8;
  if (diffDays <= 7) return 0.7;
  if (diffDays <= 14) return 0.6;
  return 0.5;
}

export type GetInboxParams = {
  teamId: string;
  cursor?: string | null;
  order?: string | null;
  sort?: string | null;
  pageSize?: number;
  q?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  status?:
    | "new"
    | "archived"
    | "processing"
    | "done"
    | "pending"
    | "analyzing"
    | "suggested_match"
    | "no_match"
    | null;
  /** Exception state, as the dashboard reads the record. */
  state?: InvoiceStateFilter | null;
};

/**
 * Provenance of a document received on the workspace's dedicated address:
 * the message it was attached to. Null for uploads and synced mailboxes.
 */
/**
 * The invoice's current authorization-source decision as reads present it:
 * the stored result (candidates with evidence, links, allocations) with the
 * decision's identity, who-made-it kind, reason and time. Null until matched.
 */
const currentSourceMatch = () =>
  sql<Record<string, unknown> | null>`(
    select m.result || jsonb_build_object(
      'id', m.id,
      'sequence', m.sequence,
      'status', m.status,
      'origin', m.origin,
      'action', m.action,
      'method', m.method,
      'reason', m.reason,
      'processingRevision', m.processing_revision,
      'rulesVersion', m.rules_version,
      'decidedAt', m.created_at
    )
    from ${invoiceSourceMatches} m
    where m.id = ${inbox.sourceMatchId}
  )`;

/**
 * The invoice's current bank-payment decision (optional feature): payment
 * status, what counts and the evidence for each transaction considered.
 * Null when the workspace does not use bank payments or nothing was decided.
 */
const currentPaymentMatch = () =>
  sql<Record<string, unknown> | null>`(
    select m.result || jsonb_build_object(
      'id', m.id,
      'sequence', m.sequence,
      'status', m.status,
      'paymentStatus', m.payment_status,
      'origin', m.origin,
      'action', m.action,
      'currency', m.currency,
      'dueAmount', m.due_amount::text,
      'paidAmount', m.paid_amount::text,
      'reason', m.reason,
      'processingRevision', m.processing_revision,
      'rulesVersion', m.rules_version,
      'decidedAt', m.created_at
    )
    from ${invoicePaymentMatches} m
    where m.id = ${inbox.paymentMatchId}
  )`;

const inboundEmailSource = {
  id: inboundEmails.id,
  messageId: inboundEmails.messageId,
  from: inboundEmails.headerFrom,
  envelopeFrom: inboundEmails.envelopeFrom,
  recipient: inboundEmails.recipient,
  subject: inboundEmails.subject,
  receivedAt: inboundEmails.createdAt,
};

const inboundEmailJoin = () =>
  and(
    eq(inboundEmails.id, inbox.inboundEmailId),
    eq(inboundEmails.teamId, inbox.teamId),
  );

export async function getInbox(db: Database, params: GetInboxParams) {
  const {
    teamId,
    cursor,
    order,
    sort,
    pageSize = 20,
    q,
    dateFrom,
    dateTo,
    status,
    state,
  } = params;

  const whereConditions: SQL[] = [
    eq(inbox.teamId, teamId),
    ne(inbox.status, "deleted"),
    visibleIntakeState(),
  ];

  // Apply status filter
  if (status) {
    whereConditions.push(eq(inbox.status, status));
  }

  if (state) {
    whereConditions.push(stateCondition(state));
  }

  if (dateFrom) {
    whereConditions.push(sql`${inbox.createdAt} >= ${dateFrom}::date`);
  }

  if (dateTo) {
    whereConditions.push(
      sql`${inbox.createdAt} < (${dateTo}::date + interval '1 day')`,
    );
  }

  // Apply search query filter
  if (q) {
    // If the query is a number, search by amount (or an invoice number
    // that starts with digits)
    if (!Number.isNaN(Number.parseInt(q))) {
      whereConditions.push(
        sql`(${inbox.amount}::text LIKE '%' || ${q} || '%'
          OR ${inbox.extraction} ->> 'invoiceNumber' ILIKE '%' || ${q} || '%')`,
      );
    } else {
      // Use both FTS and ILIKE for better special character support
      const query = buildSearchQuery(q);
      whereConditions.push(
        sql`(
          to_tsquery('english', ${query}) @@ ${inbox.fts}
          OR ${inbox.displayName} ILIKE '%' || ${q} || '%'
          OR ${inbox.fileName} ILIKE '%' || ${q} || '%'
          OR ${inbox.description} ILIKE '%' || ${q} || '%'
          OR ${inbox.extraction} ->> 'supplierName' ILIKE '%' || ${q} || '%'
          OR ${inbox.extraction} ->> 'invoiceNumber' ILIKE '%' || ${q} || '%'
        )`,
      );
    }
  }

  // Start building the query
  const query = db
    .select({
      id: inbox.id,
      fileName: inbox.fileName,
      filePath: inbox.filePath,
      displayName: inbox.displayName,
      transactionId: inbox.transactionId,
      amount: inbox.amount,
      currency: inbox.currency,
      contentType: inbox.contentType,
      date: inbox.date,
      status: inbox.status,
      createdAt: inbox.createdAt,
      website: inbox.website,
      description: inbox.description,
      extraction: inbox.extraction,
      judgments: inbox.judgments,
      validation: inbox.validation,
      supplierId: inbox.supplierId,
      supplierChecks: inbox.supplierChecks,
      sourceMatch: currentSourceMatch(),
      paymentMatch: currentPaymentMatch(),
      processingError: inbox.processingError,
      processingRevision: inbox.processingRevision,
      delivery: invoiceDeliverySummary(),
      deliveryDecision: currentDeliveryDecisionSql(),
      processingStalled: processingStalledSql(),
      judgmentsRerunStatus: inbox.judgmentsRerunStatus,
      judgmentsRerunError: inbox.judgmentsRerunError,
      correctionCount: correctionCount(),
      accountingProvider: inbox.accountingProvider,
      accountingPostStatus: inbox.accountingPostStatus,
      accountingProviderId: inbox.accountingProviderId,
      inboxAccountId: inbox.inboxAccountId,
      inboxAccount: {
        id: inboxAccounts.id,
        email: inboxAccounts.email,
        provider: inboxAccounts.provider,
      },
      inboundEmail: inboundEmailSource,
      transaction: {
        id: transactions.id,
        amount: transactions.amount,
        currency: transactions.currency,
        name: transactions.name,
        date: transactions.date,
      },
    })
    .from(inbox)
    .leftJoin(transactions, eq(inbox.transactionId, transactions.id))
    .leftJoin(inboxAccounts, eq(inbox.inboxAccountId, inboxAccounts.id))
    .leftJoin(inboundEmails, inboundEmailJoin())
    .where(and(...whereConditions));

  // Apply sorting
  if (sort === "amount") {
    query.orderBy(
      order === "asc"
        ? sql`${inbox.amount} asc nulls last`
        : sql`${inbox.amount} desc nulls last`,
      desc(inbox.createdAt),
    );
  } else {
    query.orderBy(
      order === "asc" ? asc(inbox.createdAt) : desc(inbox.createdAt),
    );
  }

  // Apply pagination
  const offset = cursor ? Number.parseInt(cursor, 10) : 0;
  query.limit(pageSize).offset(offset);

  const data = await query;

  // Calculate next cursor
  const nextCursor =
    data && data.length === pageSize
      ? (offset + pageSize).toString()
      : undefined;

  return {
    meta: {
      cursor: nextCursor,
      hasPreviousPage: offset > 0,
      hasNextPage: data && data.length === pageSize,
    },
    data: data ?? [],
  };
}

export type GetInboxByIdParams = {
  id: string;
  teamId: string;
};

export async function getInboxById(db: Database, params: GetInboxByIdParams) {
  const { id, teamId } = params;

  const [result] = await db
    .select({
      id: inbox.id,
      fileName: inbox.fileName,
      filePath: inbox.filePath,
      displayName: inbox.displayName,
      transactionId: inbox.transactionId,
      amount: inbox.amount,
      currency: inbox.currency,
      contentType: inbox.contentType,
      date: inbox.date,
      status: inbox.status,
      createdAt: inbox.createdAt,
      website: inbox.website,
      description: inbox.description,
      extraction: inbox.extraction,
      judgments: inbox.judgments,
      validation: inbox.validation,
      supplierId: inbox.supplierId,
      supplierChecks: inbox.supplierChecks,
      sourceMatch: currentSourceMatch(),
      paymentMatch: currentPaymentMatch(),
      processingError: inbox.processingError,
      processingRevision: inbox.processingRevision,
      delivery: invoiceDeliverySummary(),
      deliveryDecision: currentDeliveryDecisionSql(),
      processingStalled: processingStalledSql(),
      judgmentsRerunStatus: inbox.judgmentsRerunStatus,
      judgmentsRerunError: inbox.judgmentsRerunError,
      correctionCount: correctionCount(),
      accountingProvider: inbox.accountingProvider,
      accountingPostStatus: inbox.accountingPostStatus,
      accountingProviderId: inbox.accountingProviderId,
      inboxAccountId: inbox.inboxAccountId,
      inboxAccount: {
        id: inboxAccounts.id,
        email: inboxAccounts.email,
        provider: inboxAccounts.provider,
      },
      inboundEmail: inboundEmailSource,
      transaction: {
        id: transactions.id,
        amount: transactions.amount,
        currency: transactions.currency,
        name: transactions.name,
        date: transactions.date,
      },
      suggestion: {
        id: transactionMatchSuggestions.id,
        transactionId: transactionMatchSuggestions.transactionId,
        confidenceScore: transactionMatchSuggestions.confidenceScore,
        matchType: transactionMatchSuggestions.matchType,
        status: transactionMatchSuggestions.status,
      },
    })
    .from(inbox)
    .leftJoin(transactions, eq(inbox.transactionId, transactions.id))
    .leftJoin(inboxAccounts, eq(inbox.inboxAccountId, inboxAccounts.id))
    .leftJoin(inboundEmails, inboundEmailJoin())
    .leftJoin(
      transactionMatchSuggestions,
      and(
        eq(transactionMatchSuggestions.inboxId, inbox.id),
        eq(transactionMatchSuggestions.status, "pending"),
      ),
    )
    .where(
      and(eq(inbox.id, id), eq(inbox.teamId, teamId), visibleIntakeState()),
    )
    .limit(1);

  // If there's a suggestion, get the suggested transaction details
  if (result?.suggestion?.transactionId) {
    const [suggestedTransaction] = await db
      .select({
        id: transactions.id,
        name: transactions.name,
        amount: transactions.amount,
        currency: transactions.currency,
        date: transactions.date,
      })
      .from(transactions)
      .where(eq(transactions.id, result.suggestion.transactionId))
      .limit(1);

    return {
      ...result,
      suggestion: {
        ...result.suggestion,
        suggestedTransaction,
      },
    };
  }

  return result;
}

export function getInvoiceExportRows(db: Database, teamId: string) {
  return db
    .select({
      id: inbox.id,
      fileName: inbox.fileName,
      filePath: inbox.filePath,
      displayName: inbox.displayName,
      amount: inbox.amount,
      currency: inbox.currency,
      contentType: inbox.contentType,
      date: inbox.date,
      status: inbox.status,
      createdAt: inbox.createdAt,
      website: inbox.website,
      description: inbox.description,
      extraction: inbox.extraction,
      judgments: inbox.judgments,
      validation: inbox.validation,
    })
    .from(inbox)
    .where(
      and(
        eq(inbox.teamId, teamId),
        ne(inbox.status, "deleted"),
        visibleIntakeState(),
      ),
    )
    .orderBy(desc(inbox.createdAt));
}

/**
 * Where a record stands in the public API (`/v1`): still being read,
 * read (whatever validation and delivery then made of it), or failed to read.
 */
export const PUBLIC_INVOICE_STATUSES = [
  "processing",
  "processed",
  "failed",
] as const;

export type PublicInvoiceStatus = (typeof PUBLIC_INVOICE_STATUSES)[number];

const publicStatusCondition = (status: PublicInvoiceStatus): SQL => {
  switch (status) {
    case "processing":
      return stateCondition("processing");
    case "failed":
      return sql`(${extractionFailed()})`;
    case "processed":
      return sql`(coalesce(${inbox.status}::text, '') not in ('new', 'processing', 'analyzing')
        and not coalesce(${extractionFailed()}, false))`;
  }
};

/** The columns the public API reads for an invoice. */
const publicInvoiceColumns = () => ({
  id: inbox.id,
  fileName: inbox.fileName,
  displayName: inbox.displayName,
  contentType: inbox.contentType,
  size: inbox.size,
  contentHash: inbox.contentHash,
  referenceId: inbox.referenceId,
  inboxAccountId: inbox.inboxAccountId,
  inboundEmailId: inbox.inboundEmailId,
  amount: inbox.amount,
  currency: inbox.currency,
  status: inbox.status,
  createdAt: inbox.createdAt,
  extraction: inbox.extraction,
  judgments: inbox.judgments,
  validation: inbox.validation,
  supplierId: inbox.supplierId,
  supplierChecks: inbox.supplierChecks,
  processingError: inbox.processingError,
  processingRevision: inbox.processingRevision,
  processingStalled: processingStalledSql(),
  delivery: invoiceDeliverySummary(),
  judgmentsRerunStatus: inbox.judgmentsRerunStatus,
  judgmentsRerunError: inbox.judgmentsRerunError,
  correctionCount: correctionCount(),
  accountingProvider: inbox.accountingProvider,
  accountingPostStatus: inbox.accountingPostStatus,
  accountingProviderId: inbox.accountingProviderId,
});

/** Position of the last record of a page: its creation time and id. */
export type PublicInvoiceCursor = { createdAt: string; id: string };

export type ListPublicInvoicesParams = {
  teamId: string;
  cursor?: PublicInvoiceCursor | null;
  order?: "asc" | "desc";
  limit: number;
  status?: PublicInvoiceStatus | null;
  state?: InvoiceStateFilter | null;
  q?: string | null;
  createdFrom?: string | null;
  createdTo?: string | null;
  supplierId?: string | null;
};

/**
 * Invoices for the public API, paged by keyset on (created_at, id) so a
 * document accepted while a client pages cannot shift or repeat a page.
 * Returns one page and the cursor of its last record when more follow.
 */
export async function listPublicInvoices(
  db: Database,
  params: ListPublicInvoicesParams,
) {
  const order = params.order ?? "desc";
  const conditions: SQL[] = [
    eq(inbox.teamId, params.teamId),
    ne(inbox.status, "deleted"),
    visibleIntakeState(),
  ];
  if (params.status) conditions.push(publicStatusCondition(params.status));
  if (params.state) conditions.push(stateCondition(params.state));
  if (params.supplierId)
    conditions.push(eq(inbox.supplierId, params.supplierId));
  if (params.createdFrom) {
    conditions.push(sql`${inbox.createdAt} >= ${params.createdFrom}::date`);
  }
  if (params.createdTo) {
    conditions.push(
      sql`${inbox.createdAt} < (${params.createdTo}::date + interval '1 day')`,
    );
  }
  if (params.q) {
    conditions.push(
      sql`(${inbox.displayName} ILIKE '%' || ${params.q} || '%'
        OR ${inbox.fileName} ILIKE '%' || ${params.q} || '%'
        OR ${inbox.extraction} ->> 'supplierName' ILIKE '%' || ${params.q} || '%'
        OR ${inbox.extraction} ->> 'invoiceNumber' ILIKE '%' || ${params.q} || '%')`,
    );
  }
  if (params.cursor) {
    conditions.push(
      order === "desc"
        ? sql`(${inbox.createdAt}, ${inbox.id}) < (${params.cursor.createdAt}::timestamptz, ${params.cursor.id}::uuid)`
        : sql`(${inbox.createdAt}, ${inbox.id}) > (${params.cursor.createdAt}::timestamptz, ${params.cursor.id}::uuid)`,
    );
  }

  const rows = await db
    .select(publicInvoiceColumns())
    .from(inbox)
    .where(and(...conditions))
    .orderBy(
      order === "desc" ? desc(inbox.createdAt) : asc(inbox.createdAt),
      order === "desc" ? desc(inbox.id) : asc(inbox.id),
    )
    .limit(params.limit + 1);

  const page = rows.slice(0, params.limit);
  const last = page.at(-1);
  return {
    data: page,
    next:
      rows.length > params.limit && last
        ? { createdAt: last.createdAt, id: last.id }
        : null,
  };
}

export type PublicInvoiceRow = Awaited<
  ReturnType<typeof listPublicInvoices>
>["data"][number];

/** One invoice of the workspace in the public API's shape, or undefined. */
export async function getPublicInvoice(
  db: Database,
  params: { teamId: string; id: string },
): Promise<PublicInvoiceRow | undefined> {
  if (!isUuid(params.id)) return undefined;
  const rows = await db
    .select(publicInvoiceColumns())
    .from(inbox)
    .where(
      and(
        eq(inbox.id, params.id),
        eq(inbox.teamId, params.teamId),
        ne(inbox.status, "deleted"),
        visibleIntakeState(),
      ),
    )
    .limit(1);
  return rows[0];
}

const isUuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

/**
 * The invoice a public-API idempotency key already names in this workspace,
 * either as the document it created or as a re-delivery it was recorded as,
 * with that document's content hash.
 */
export async function findIntakeByReference(
  db: Pick<Database, "select">,
  params: { teamId: string; referenceId: string },
): Promise<{ inboxId: string; contentHash: string | null } | null> {
  const [own] = await db
    .select({ inboxId: inbox.id, contentHash: inbox.contentHash })
    .from(inbox)
    .where(
      and(
        eq(inbox.teamId, params.teamId),
        eq(inbox.referenceId, params.referenceId),
      ),
    )
    .limit(1);
  if (own) return own;
  const [redelivery] = await db
    .select({ inboxId: inbox.id, contentHash: inbox.contentHash })
    .from(inboxRedeliveries)
    .innerJoin(
      inbox,
      and(
        eq(inbox.id, inboxRedeliveries.inboxId),
        eq(inbox.teamId, inboxRedeliveries.teamId),
      ),
    )
    .where(
      and(
        eq(inboxRedeliveries.teamId, params.teamId),
        eq(inboxRedeliveries.referenceId, params.referenceId),
      ),
    )
    .limit(1);
  return redelivery ?? null;
}

/**
 * Every question key the workspace has ever defined, in key order. The
 * export's question columns come from it, so they are the same on every page.
 */
export async function listWorkspaceQuestionKeys(
  db: Pick<Database, "selectDistinct">,
  teamId: string,
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ questionKey: userQuestions.questionKey })
    .from(userQuestions)
    .where(eq(userQuestions.teamId, teamId))
    .orderBy(asc(userQuestions.questionKey));
  return rows.map((row) => row.questionKey);
}

/**
 * The deliberate rerun answers recorded on these invoices of the workspace,
 * oldest first, with the question revision each one asked.
 */
export async function listQuestionAnswerHistory(
  db: Pick<Database, "select">,
  params: { teamId: string; invoiceIds: string[] },
) {
  if (params.invoiceIds.length === 0) return [];
  return db
    .select({
      id: questionAnswers.id,
      invoiceId: questionAnswers.invoiceId,
      runId: questionAnswers.runId,
      questionKey: questionAnswers.questionKey,
      questionVersionId: questionAnswers.questionVersionId,
      questionVersion: userQuestions.version,
      invoiceRevision: questionAnswers.invoiceRevision,
      judgment: questionAnswers.judgment,
      previous: questionAnswers.previous,
      createdAt: questionAnswers.createdAt,
    })
    .from(questionAnswers)
    .leftJoin(
      userQuestions,
      eq(userQuestions.id, questionAnswers.questionVersionId),
    )
    .where(
      and(
        eq(questionAnswers.teamId, params.teamId),
        inArray(questionAnswers.invoiceId, params.invoiceIds),
      ),
    )
    .orderBy(asc(questionAnswers.createdAt), asc(questionAnswers.id));
}

export type DeleteInboxParams = {
  id: string;
  teamId: string;
};

export async function deleteInbox(
  db: InboxQueryDatabase,
  params: DeleteInboxParams,
) {
  const { id, teamId } = params;

  // First get the inbox item to check if it has attachments
  const [result] = await db
    .select({
      id: inbox.id,
      transactionId: inbox.transactionId,
      attachmentId: inbox.attachmentId,
      filePath: inbox.filePath,
    })
    .from(inbox)
    .where(and(eq(inbox.id, id), eq(inbox.teamId, teamId)))
    .limit(1);

  if (!result) {
    throw new Error("Inbox item not found");
  }

  // Clean up transaction attachment if it exists (same logic as unmatchTransaction)
  if (result.attachmentId && result.transactionId) {
    // Delete the specific transaction attachment for this inbox item
    await db
      .delete(transactionAttachments)
      .where(
        and(
          eq(transactionAttachments.id, result.attachmentId),
          eq(transactionAttachments.teamId, teamId),
        ),
      );

    // Check if this transaction still has other attachments before resetting tax info
    const remainingAttachments = await db
      .select({ count: sql<number>`count(*)` })
      .from(transactionAttachments)
      .where(
        and(
          eq(transactionAttachments.transactionId, result.transactionId),
          eq(transactionAttachments.teamId, teamId),
        ),
      );

    // Only reset tax rate and type if no more attachments exist for this transaction
    if (remainingAttachments[0]?.count === 0) {
      await db
        .update(transactions)
        .set({
          taxRate: null,
          taxType: null,
        })
        .where(eq(transactions.id, result.transactionId));
    }
  }

  // Mark inbox item as deleted and clear attachment/transaction references
  const deleted = await db
    .update(inbox)
    .set({
      status: "deleted",
      transactionId: null,
      attachmentId: null,
      // Explicit deletion ends the intake binding: a later upload of the same
      // bytes is a new document, and every capability URL stops working.
      intakeState: "cancelled",
      contentHash: null,
      // Intent first: the deletion is durable even if the process dies before
      // the object is removed, and the next cleanup pass finishes the job.
      objectRemovalPending: true,
      // Preserve any unresolved publication outcome. A reservation may still
      // have an in-flight writer, so cancellation is conservative until
      // explicit settlement or verified acceptance proves otherwise. The
      // expression is evaluated against the current row inside this UPDATE;
      // legacy rows have a null state, which must not yield a null flag.
      objectRemovalAmbiguous: sql<boolean>`(${inbox.objectRemovalAmbiguous} or coalesce(${inbox.intakeState} = 'reserved', false))`,
    })
    .where(
      and(
        eq(inbox.id, id),
        eq(inbox.teamId, teamId),
        ne(inbox.status, "deleted"),
      ),
    )
    .returning();

  // The document's retained text goes with the document, at once.
  if (deleted.length > 0) {
    await db
      .delete(documentTexts)
      .where(
        and(eq(documentTexts.inboxId, id), eq(documentTexts.teamId, teamId)),
      );
  }

  if (result.filePath?.length) {
    const bindingIssue = documentBindingIssue({
      teamId,
      filePath: result.filePath,
    });

    if (bindingIssue) {
      // The persisted path is not a document path for this workspace (for
      // example an inconsistent legacy row pointing into another tenant).
      // Never touch that object; leave the row deleted and record why.
      await recordIntakeRemovalFailure(db, {
        id,
        teamId,
        error: `Object retained: ${bindingIssue}`,
      }).catch(() => undefined);
    } else if (
      await isStoredPathSharedByLiveDocument(db, {
        id,
        teamId,
        filePath: result.filePath,
      })
    ) {
      // Legacy rows (`<team>/inbox/<filename>`) could share one object. The
      // bytes still belong to another live document, so only this record
      // goes; whichever sharer is deleted last removes the object. The check
      // runs after this row's tombstone committed, so two concurrent deletes
      // cannot both skip the removal.
      await clearObjectRemovalPending(db, { id, teamId }).catch(
        () => undefined,
      );
    } else {
      try {
        // If removal fails the record stays cancelled (capability URLs and the
        // asset route already refuse the retained bytes) and the durable flag
        // lets a later cleanup finish the removal.
        await removeStoredFile({ bucket: "vault", path: result.filePath });
        await clearObjectRemovalPending(db, { id, teamId }).catch(
          () => undefined,
        );
      } catch (error) {
        await recordIntakeRemovalFailure(db, {
          id,
          teamId,
          error: `Object removal failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        }).catch(() => undefined);
        throw error;
      }
    }
  }

  return deleted;
}

export type GetInboxSearchParams = {
  teamId: string;
  limit?: number;
  q?: string; // Search query (text or amount)
  transactionId?: string; // For AI suggestions
};

export async function getInboxSearch(
  db: Database,
  params: GetInboxSearchParams,
) {
  try {
    const { teamId, q, transactionId, limit = 10 } = params;

    const whereConditions: SQL[] = [
      eq(inbox.teamId, teamId),
      ne(inbox.status, "deleted"),
      visibleIntakeState(),
      // Exclude items that are already matched to other transactions
      sql`${inbox.transactionId} IS NULL`,
    ];

    // PRIORITY 1: User is searching with query
    if (q && q.trim().length > 0) {
      const searchTerm = q.trim();
      const searchQuery = buildSearchQuery(searchTerm); // Use FTS format

      logger.info("🔍 SEARCH DEBUG:", {
        searchTerm,
        searchQuery,
        teamId,
        limit,
      });

      // Check if search term is a number (for amount searching)
      const numericSearch = Number.parseFloat(
        searchTerm.replace(/[^\d.-]/g, ""),
      );

      const isNumericSearch =
        !Number.isNaN(numericSearch) && Number.isFinite(numericSearch);

      if (isNumericSearch) {
        // Search by amount (exact match or close match within 10%)
        const tolerance = Math.max(1, Math.abs(numericSearch) * 0.1);
        whereConditions.push(
          sql`(
            to_tsquery('english', ${searchQuery}) @@ ${inbox.fts}
            OR ABS(COALESCE(${inbox.amount}, 0) - ${numericSearch}) <= ${tolerance}
            OR ${inbox.displayName} ILIKE '%' || ${searchTerm} || '%'
            OR ${inbox.fileName} ILIKE '%' || ${searchTerm} || '%'
            OR ${inbox.description} ILIKE '%' || ${searchTerm} || '%'
          )`,
        );
      } else {
        // Text-only search using both FTS and ILIKE for better special character support
        whereConditions.push(
          sql`(
            to_tsquery('english', ${searchQuery}) @@ ${inbox.fts}
            OR ${inbox.displayName} ILIKE '%' || ${searchTerm} || '%'
            OR ${inbox.fileName} ILIKE '%' || ${searchTerm} || '%'
            OR ${inbox.description} ILIKE '%' || ${searchTerm} || '%'
          )`,
        );
      }

      // For search, return results ordered by date (most recent first)
      const searchResults = await db
        .select({
          id: inbox.id,
          createdAt: inbox.createdAt,
          fileName: inbox.fileName,
          amount: inbox.amount,
          currency: inbox.currency,
          filePath: inbox.filePath,
          contentType: inbox.contentType,
          date: inbox.date,
          displayName: inbox.displayName,
          size: inbox.size,
          description: inbox.description,
          status: inbox.status,
          website: inbox.website,
          baseAmount: inbox.baseAmount,
          baseCurrency: inbox.baseCurrency,
          taxAmount: inbox.taxAmount,
          taxRate: inbox.taxRate,
          taxType: inbox.taxType,
        })
        .from(inbox)
        .where(and(...whereConditions))
        .orderBy(desc(inbox.date), desc(inbox.createdAt)) // Most recent first
        .limit(limit);

      logger.info("🎯 SEARCH RESULTS:", {
        searchTerm,
        resultsCount: searchResults.length,
        results: searchResults.slice(0, 3).map((r) => ({
          id: r.id,
          displayName: r.displayName,
          amount: r.amount,
          currency: r.currency,
        })),
      });

      return searchResults;
    }

    // PRIORITY 2: AI suggestions for transaction
    if (transactionId) {
      // Get transaction details for context-aware matching
      const transactionData = await db
        .select({
          id: transactions.id,
          name: transactions.name,
          amount: transactions.amount,
          currency: transactions.currency,
          baseAmount: transactions.baseAmount,
          baseCurrency: transactions.baseCurrency,
          date: transactions.date,
          counterpartyName: transactions.counterpartyName,
          description: transactions.description,
        })
        .from(transactions)
        .where(
          and(
            eq(transactions.id, transactionId),
            eq(transactions.teamId, teamId),
          ),
        )
        .limit(1);

      if (transactionData.length > 0) {
        const transaction = transactionData[0]!;

        // Check if transaction already has attachments - if so, don't show suggestions
        const [hasAttachments] = await db
          .select({ count: sql`count(*)` })
          .from(transactionAttachments)
          .where(
            and(
              eq(transactionAttachments.transactionId, transactionId),
              eq(transactionAttachments.teamId, teamId),
            ),
          );

        const attachmentCount = hasAttachments?.count
          ? Number(hasAttachments.count)
          : 0;

        if (attachmentCount > 0) {
          return [];
        }

        // Use the same successful approach as batch-process-matching
        // Get candidates first, then score them with the same logic that works
        const candidates = await db
          .select({
            id: inbox.id,
            createdAt: inbox.createdAt,
            fileName: inbox.fileName,
            amount: inbox.amount,
            currency: inbox.currency,
            filePath: inbox.filePath,
            contentType: inbox.contentType,
            date: inbox.date,
            displayName: inbox.displayName,
            size: inbox.size,
            description: inbox.description,
            baseAmount: inbox.baseAmount,
            baseCurrency: inbox.baseCurrency,
            status: inbox.status,
            website: inbox.website,
            taxAmount: inbox.taxAmount,
            taxRate: inbox.taxRate,
            taxType: inbox.taxType,
            embeddingScore:
              sql<number>`(${transactionEmbeddings.embedding} <-> ${inboxEmbeddings.embedding})`.as(
                "embedding_score",
              ),
          })
          .from(inbox)
          .innerJoin(inboxEmbeddings, eq(inbox.id, inboxEmbeddings.inboxId))
          .crossJoin(transactionEmbeddings)
          .where(
            and(
              ...whereConditions,
              eq(transactionEmbeddings.transactionId, transactionId),
              // More permissive threshold for manual suggestions (80%+)
              sql`(${transactionEmbeddings.embedding} <-> ${inboxEmbeddings.embedding}) < 0.2`,
              // Very wide date range for manual suggestions (full year)
              sql`${inbox.date} BETWEEN (${sql.param(transaction.date)}::date - INTERVAL '365 days') 
                  AND (${sql.param(transaction.date)}::date + INTERVAL '90 days')`,
            ),
          )
          .orderBy(
            sql`(${transactionEmbeddings.embedding} <-> ${inboxEmbeddings.embedding})`,
          )
          .limit(20); // Get more candidates for better scoring

        logger.info(
          "🔍 Main candidates found:",
          candidates.length,
          candidates.map((c) => ({
            displayName: c.displayName,
            amount: c.amount,
            currency: c.currency,
            embeddingScore: c.embeddingScore,
            semanticSimilarity: (1 - c.embeddingScore).toFixed(3),
          })),
        );

        if (candidates.length > 0) {
          // Score candidates using the same logic as successful batch-process-matching
          const scoredCandidates = candidates.map((candidate) => {
            const embeddingScore = Math.max(0, 1 - candidate.embeddingScore);
            const amountScore = calculateAmountScore(candidate, transaction);
            const currencyScore = calculateCurrencyScore(
              candidate.currency || undefined,
              transaction.currency || undefined,
            );
            const dateScore = calculateDateScore(
              candidate.date!,
              transaction.date,
            );

            // Same confidence calculation as successful matching
            let confidenceScore =
              embeddingScore * 0.5 + // Same weights as successful matching
              amountScore * 0.35 +
              currencyScore * 0.1 +
              dateScore * 0.05;

            // Apply same currency penalty reduction for high semantic matches
            if (
              candidate.currency !== transaction.currency &&
              currencyScore < 0.8
            ) {
              const currencyPenalty = embeddingScore >= 0.85 ? 0.92 : 0.85;
              confidenceScore *= currencyPenalty;
            }

            return {
              ...candidate,
              confidenceScore,
              embeddingScore,
              amountScore,
              currencyScore,
              dateScore,
            };
          });

          // Sort by confidence score first, then by date (more recent first) for ties
          const sortedSuggestions = scoredCandidates
            .sort((a, b) => {
              const confidenceDiff = b.confidenceScore - a.confidenceScore;
              // If confidence scores are very close (within 1%), use date as tiebreaker
              if (Math.abs(confidenceDiff) < 0.01) {
                const dateA = new Date(a.date || 0).getTime();
                const dateB = new Date(b.date || 0).getTime();
                return dateB - dateA; // More recent first
              }
              return confidenceDiff;
            })
            .slice(0, limit);

          logger.info(
            "🎯 Found and scored suggestions:",
            sortedSuggestions.length,
            sortedSuggestions.map((s) => ({
              displayName: s.displayName,
              amount: s.amount,
              confidence: s.confidenceScore,
            })),
          );

          return sortedSuggestions;
        }

        // No matches found
        return [];
      }
    }

    // PRIORITY 3: Recent unmatched items
    const data = await db
      .select({
        id: inbox.id,
        createdAt: inbox.createdAt,
        fileName: inbox.fileName,
        amount: inbox.amount,
        currency: inbox.currency,
        filePath: inbox.filePath,
        contentType: inbox.contentType,
        date: inbox.date,
        displayName: inbox.displayName,
        size: inbox.size,
        description: inbox.description,
        status: inbox.status,
        website: inbox.website,
        baseAmount: inbox.baseAmount,
        baseCurrency: inbox.baseCurrency,
        taxAmount: inbox.taxAmount,
        taxRate: inbox.taxRate,
        taxType: inbox.taxType,
      })
      .from(inbox)
      .where(and(...whereConditions))
      .orderBy(desc(inbox.createdAt))
      .limit(limit);

    return data;
  } catch (error) {
    logger.error("Error in getInboxSearch:", error);
    return [];
  }
}

export type UpdateInboxParams = {
  id: string;
  teamId: string;
  transactionId?: string | null;
  /**
   * `deleted` is deliberately absent: deletion must go through `deleteInbox`,
   * which tombstones the intake binding and removes the stored object.
   */
  status?:
    | "new"
    | "archived"
    | "processing"
    | "done"
    | "pending"
    | "analyzing"
    | "suggested_match";
  /** Only ever cleared here, e.g. when a retry starts processing again. */
  processingError?: null;
};

export async function updateInbox(
  db: InboxQueryDatabase,
  params: UpdateInboxParams,
) {
  const { id, teamId, ...data } = params;

  if ((data.status as string | undefined) === "deleted") {
    // Defence in depth for untyped callers; the API schemas reject it too.
    throw new Error("Use deleteInbox to delete an inbox item");
  }

  // Update the inbox record
  await db
    .update(inbox)
    .set(data)
    .where(
      and(
        eq(inbox.id, id),
        eq(inbox.teamId, teamId),
        // A worker that finishes after an explicit deletion must not restore
        // the record or its invoice status.
        ne(inbox.status, "deleted"),
        // A reservation is not an invoice yet and cannot be edited.
        visibleIntakeState(),
      ),
    );

  // Return the updated record with transaction data
  const [result] = await db
    .select({
      id: inbox.id,
      fileName: inbox.fileName,
      filePath: inbox.filePath,
      displayName: inbox.displayName,
      transactionId: inbox.transactionId,
      amount: inbox.amount,
      currency: inbox.currency,
      contentType: inbox.contentType,
      date: inbox.date,
      status: inbox.status,
      createdAt: inbox.createdAt,
      website: inbox.website,
      description: inbox.description,
      transaction: {
        id: transactions.id,
        amount: transactions.amount,
        currency: transactions.currency,
        name: transactions.name,
        date: transactions.date,
      },
    })
    .from(inbox)
    .leftJoin(transactions, eq(inbox.transactionId, transactions.id))
    .where(
      and(eq(inbox.id, id), eq(inbox.teamId, teamId), visibleIntakeState()),
    )
    .limit(1);

  return result;
}

export type MatchTransactionParams = {
  id: string;
  transactionId: string;
  teamId: string;
};

export async function matchTransaction(
  db: Database,
  params: MatchTransactionParams,
) {
  const { id, transactionId, teamId } = params;

  // Get inbox data and check if already matched
  const [result] = await db
    .select({
      id: inbox.id,
      contentType: inbox.contentType,
      filePath: inbox.filePath,
      size: inbox.size,
      fileName: inbox.fileName,
      taxRate: inbox.taxRate,
      taxType: inbox.taxType,
      transactionId: inbox.transactionId, // Check if already matched
      status: inbox.status,
    })
    .from(inbox)
    .where(and(eq(inbox.id, id), eq(inbox.teamId, teamId)))
    .limit(1);

  if (!result) return null;

  // Check if inbox item is already matched
  if (result.transactionId) {
    throw new Error("Inbox item is already matched to a transaction");
  }

  // Check if the target transaction is already matched to another inbox item
  const [existingMatch] = await db
    .select({ id: inbox.id })
    .from(inbox)
    .where(
      and(
        eq(inbox.transactionId, transactionId),
        eq(inbox.teamId, teamId),
        ne(inbox.id, id), // Not the same inbox item
      ),
    )
    .limit(1);

  if (existingMatch) {
    throw new Error("Transaction is already matched to another inbox item");
  }

  // Insert transaction attachment
  const [attachmentData] = await db
    .insert(transactionAttachments)
    .values({
      type: result.contentType ?? "",
      path: result.filePath ?? [],
      transactionId,
      size: result.size ?? 0,
      name: result.fileName ?? "",
      teamId,
    })
    .returning({ id: transactionAttachments.id });

  // Update transaction with tax rate and type
  if (result.taxRate && result.taxType) {
    await db
      .update(transactions)
      .set({
        taxRate: result.taxRate,
        taxType: result.taxType,
      })
      .where(eq(transactions.id, transactionId));
  }

  if (attachmentData) {
    // Update inbox with attachment and transaction IDs
    await db
      .update(inbox)
      .set({
        attachmentId: attachmentData.id,
        transactionId: transactionId,
        status: "done",
      })
      .where(and(eq(inbox.id, id), eq(inbox.teamId, teamId)));
  }

  // Return updated inbox with transaction data
  const [data] = await db
    .select({
      id: inbox.id,
      fileName: inbox.fileName,
      filePath: inbox.filePath,
      displayName: inbox.displayName,
      transactionId: inbox.transactionId,
      amount: inbox.amount,
      currency: inbox.currency,
      contentType: inbox.contentType,
      date: inbox.date,
      status: inbox.status,
      createdAt: inbox.createdAt,
      website: inbox.website,
      description: inbox.description,
      transaction: {
        id: transactions.id,
        amount: transactions.amount,
        currency: transactions.currency,
        name: transactions.name,
        date: transactions.date,
      },
    })
    .from(inbox)
    .leftJoin(transactions, eq(inbox.transactionId, transactions.id))
    .where(and(eq(inbox.id, id), eq(inbox.teamId, teamId)))
    .limit(1);

  return data;
}

export type UnmatchTransactionParams = {
  id: string;
  teamId: string;
};

export async function unmatchTransaction(
  db: Database,
  params: UnmatchTransactionParams & { userId?: string },
) {
  const { id, teamId, userId } = params;

  // Get inbox data
  const [result] = await db
    .select({
      id: inbox.id,
      transactionId: inbox.transactionId,
      attachmentId: inbox.attachmentId,
    })
    .from(inbox)
    .where(and(eq(inbox.id, id), eq(inbox.teamId, teamId)))
    .limit(1);

  // LEARNING FEEDBACK: Find the original match suggestion to mark as incorrect
  if (result?.transactionId) {
    // Look for the match suggestion that led to this pairing
    const [originalSuggestion] = await db
      .select({
        id: transactionMatchSuggestions.id,
        status: transactionMatchSuggestions.status,
        matchType: transactionMatchSuggestions.matchType,
        confidenceScore: transactionMatchSuggestions.confidenceScore,
      })
      .from(transactionMatchSuggestions)
      .where(
        and(
          eq(transactionMatchSuggestions.inboxId, id),
          eq(transactionMatchSuggestions.transactionId, result.transactionId),
          eq(transactionMatchSuggestions.teamId, teamId),
          eq(transactionMatchSuggestions.status, "confirmed"),
        ),
      )
      .orderBy(desc(transactionMatchSuggestions.createdAt))
      .limit(1);

    // Mark the suggestion as "unmatched" to provide negative feedback for learning
    if (originalSuggestion) {
      await db
        .update(transactionMatchSuggestions)
        .set({
          status: "unmatched", // New status for post-match removal
          userActionAt: new Date().toISOString(),
          userId: userId || null,
        })
        .where(eq(transactionMatchSuggestions.id, originalSuggestion.id));

      // Log for debugging/monitoring
      logger.info("📚 UNMATCH LEARNING FEEDBACK", {
        teamId,
        inboxId: id,
        transactionId: result.transactionId,
        originalMatchType: originalSuggestion.matchType,
        originalConfidence: Number(originalSuggestion.confidenceScore),
        originalStatus: originalSuggestion.status,
        message:
          "User unmatched a previously confirmed/auto-matched pair - negative feedback for learning",
      });
    }
  }

  // Update inbox record
  await db
    .update(inbox)
    .set({
      transactionId: null,
      attachmentId: null,
      status: "pending",
    })
    .where(and(eq(inbox.id, id), eq(inbox.teamId, teamId)));

  // Delete only the specific transaction attachment for this inbox item
  if (result?.attachmentId) {
    await db
      .delete(transactionAttachments)
      .where(
        and(
          eq(transactionAttachments.id, result.attachmentId),
          eq(transactionAttachments.teamId, teamId),
        ),
      );
  }

  // Check if this transaction still has other attachments before resetting tax info
  if (result?.transactionId) {
    const remainingAttachments = await db
      .select({ count: sql<number>`count(*)` })
      .from(transactionAttachments)
      .where(
        and(
          eq(transactionAttachments.transactionId, result.transactionId),
          eq(transactionAttachments.teamId, teamId),
        ),
      );

    // Only reset tax rate and type if no more attachments exist for this transaction
    if (remainingAttachments[0]?.count === 0) {
      await db
        .update(transactions)
        .set({
          taxRate: null,
          taxType: null,
        })
        .where(eq(transactions.id, result.transactionId));
    }
  }

  // Return updated inbox with transaction data
  return db
    .select({
      id: inbox.id,
      fileName: inbox.fileName,
      filePath: inbox.filePath,
      displayName: inbox.displayName,
      transactionId: inbox.transactionId,
      amount: inbox.amount,
      currency: inbox.currency,
      contentType: inbox.contentType,
      date: inbox.date,
      status: inbox.status,
      createdAt: inbox.createdAt,
      website: inbox.website,
      description: inbox.description,
      transaction: {
        id: transactions.id,
        amount: transactions.amount,
        currency: transactions.currency,
        name: transactions.name,
        date: transactions.date,
      },
    })
    .from(inbox)
    .leftJoin(transactions, eq(inbox.transactionId, transactions.id))
    .where(and(eq(inbox.id, id), eq(inbox.teamId, teamId)))
    .limit(1);
}

export type GetInboxByFilePathParams = {
  filePath: string[];
  teamId: string;
};

export type InboxIntakeState = "reserved" | "accepted" | "cancelled" | null;

/**
 * Intake binding reads are deliberately usable with either the replica-aware
 * client or the primary connection, so authorization-sensitive callers can
 * read the primary without a widened cast.
 */
export type InboxQueryDatabase = Database | PrimaryDatabase;

export type InboxIntakeBinding = {
  id: string;
  createdAt: string;
  teamId: string | null;
  filePath: string[] | null;
  fileName: string | null;
  contentType: string | null;
  size: number | null;
  status: string | null;
  intakeState: InboxIntakeState;
  contentHash: string | null;
  intakeError: string | null;
  objectRemovalPending: boolean | null;
  objectRemovalAmbiguous: boolean | null;
  processingRevision?: number;
};

/** The only storage namespace that may hold workspace documents. */
export const DOCUMENT_NAMESPACE = "inbox";

export type DocumentBindingLike = {
  teamId: string | null;
  filePath: string[] | null;
};

/**
 * One validator for every persisted document binding.
 *
 * A stored path is only usable when it belongs to the record's exact workspace
 * and lives in the document namespace, with unambiguous segments. Legacy rows
 * that point at another workspace (or at a non-document namespace such as
 * `assets`) are rejected before any storage access, so no read, signature,
 * worker run or deletion can touch another tenant's object.
 */
export function documentBindingIssue(
  binding: DocumentBindingLike,
): string | null {
  const { teamId, filePath } = binding;

  if (!teamId) return "The record has no workspace.";
  if (!filePath?.length) return "The record has no stored document path.";
  if (filePath.length < 3) {
    return "The stored path is not a workspace document path.";
  }
  if (filePath[0] !== teamId) {
    return "The stored path belongs to another workspace.";
  }
  if (filePath[1] !== DOCUMENT_NAMESPACE) {
    return "The stored path is not in the document namespace.";
  }

  for (const segment of filePath) {
    if (
      !segment ||
      segment === "." ||
      segment === ".." ||
      segment.includes("/") ||
      segment.includes("\\")
    ) {
      return "The stored path contains an ambiguous segment.";
    }
  }

  return null;
}

export const isValidDocumentBinding = (binding: DocumentBindingLike) =>
  documentBindingIssue(binding) === null;

const intakeBindingColumns = {
  id: inbox.id,
  createdAt: inbox.createdAt,
  teamId: inbox.teamId,
  filePath: inbox.filePath,
  fileName: inbox.fileName,
  contentType: inbox.contentType,
  size: inbox.size,
  status: inbox.status,
  intakeState: inbox.intakeState,
  contentHash: inbox.contentHash,
  intakeError: inbox.intakeError,
  objectRemovalPending: inbox.objectRemovalPending,
  objectRemovalAmbiguous: inbox.objectRemovalAmbiguous,
  processingRevision: inbox.processingRevision,
};

/**
 * Resolves the persisted workspace binding for an intake record. Every read,
 * sign, retry, delete and worker path derives storage location and metadata
 * from this row rather than from client input.
 */
export async function getInboxIntakeBinding(
  db: InboxQueryDatabase,
  params: { id: string; teamId?: string },
): Promise<InboxIntakeBinding | undefined> {
  const conditions = [eq(inbox.id, params.id)];
  if (params.teamId) conditions.push(eq(inbox.teamId, params.teamId));

  const [result] = await db
    .select(intakeBindingColumns)
    .from(inbox)
    .where(and(...conditions))
    .limit(1);

  // Every read path inherits the shared binding guard: a row whose persisted
  // path does not belong to its own workspace is never usable.
  if (!result || !isValidDocumentBinding(result)) return undefined;

  return result;
}

/**
 * Row-locked binding read used to serialize lifecycle transitions (retry
 * decisions, cleanup claims) on the canonical inbox record.
 */
export async function getInboxIntakeBindingForUpdate(
  db: InboxQueryDatabase,
  params: { id: string; teamId: string },
): Promise<InboxIntakeBinding | undefined> {
  const [result] = await db
    .select(intakeBindingColumns)
    .from(inbox)
    .where(and(eq(inbox.id, params.id), eq(inbox.teamId, params.teamId)))
    .limit(1)
    .for("update");

  if (!result || !isValidDocumentBinding(result)) return undefined;

  return result;
}

export async function findInboxIntakeByContentHash(
  db: InboxQueryDatabase,
  params: { teamId: string; contentHash: string },
): Promise<InboxIntakeBinding | undefined> {
  const [result] = await db
    .select(intakeBindingColumns)
    .from(inbox)
    .where(
      and(
        eq(inbox.teamId, params.teamId),
        eq(inbox.contentHash, params.contentHash),
        inArray(inbox.intakeState, ["reserved", "accepted"]),
        ne(inbox.status, "deleted"),
      ),
    )
    .limit(1);

  if (!result || !isValidDocumentBinding(result)) return undefined;

  return result;
}

export type ReserveInboxIntakeParams = {
  id: string;
  teamId: string;
  filePath: string[];
  fileName: string;
  displayName: string;
  contentType: string;
  size: number;
  contentHash: string;
  referenceId?: string;
  website?: string;
  inboxAccountId?: string;
  inboundEmailId?: string;
};

/**
 * Durably reserves an intake record before any object is written. Returns
 * `undefined` when a concurrent request already reserved or accepted the same
 * workspace content, so the caller can resume that record instead.
 */
export async function reserveInboxIntake(
  db: InboxQueryDatabase,
  params: ReserveInboxIntakeParams,
): Promise<InboxIntakeBinding | undefined> {
  const [result] = await db
    .insert(inbox)
    .values({
      id: params.id,
      teamId: params.teamId,
      filePath: params.filePath,
      fileName: params.fileName,
      displayName: params.displayName,
      contentType: params.contentType,
      size: params.size,
      contentHash: params.contentHash,
      intakeState: "reserved",
      referenceId: params.referenceId,
      website: params.website,
      inboxAccountId: params.inboxAccountId,
      inboundEmailId: params.inboundEmailId,
      status: "new",
    })
    .onConflictDoNothing()
    .returning(intakeBindingColumns);

  return result;
}

/**
 * True when no intake attempt holds a live publication lease on the row. A
 * cleanup claim never takes a reservation whose object may still be being
 * written and verified.
 */
const noLivePublicationLease = () =>
  or(
    isNull(inbox.intakePublishingUntil),
    lt(inbox.intakePublishingUntil, sql`now()`),
  )!;

/**
 * Takes (or extends) the publication lease on a reservation before its object
 * is written. The write and read-back then run outside any transaction, so no
 * database connection is held while bytes move to or from object storage;
 * cleanup claims skip the row until the lease expires. Returns `undefined`
 * when the row is no longer a live reservation.
 */
export async function beginInboxIntakePublication(
  db: InboxQueryDatabase,
  params: { id: string; teamId: string; leaseMs: number },
): Promise<InboxIntakeBinding | undefined> {
  const leaseUntil = sql`now() + ${Math.max(0, Math.ceil(params.leaseMs))} * interval '1 millisecond'`;
  const [result] = await db
    .update(inbox)
    .set({
      // Concurrent attempts for the same content share one lease; a shorter
      // lease never cuts another attempt's lease short.
      intakePublishingUntil: sql`greatest(coalesce(${inbox.intakePublishingUntil}, now()), ${leaseUntil})`,
    })
    .where(
      and(
        eq(inbox.id, params.id),
        eq(inbox.teamId, params.teamId),
        eq(inbox.intakeState, "reserved"),
        ne(inbox.status, "deleted"),
      ),
    )
    .returning(intakeBindingColumns);

  return result;
}

export type AcceptInboxIntakeParams = {
  id: string;
  teamId: string;
  contentHash: string;
  contentType: string;
  size: number;
  fileName: string;
  pageCount?: number | null;
};

/** Finalizes accepted content and makes the record visible as processing. */
export async function acceptInboxIntake(
  db: InboxQueryDatabase,
  params: AcceptInboxIntakeParams,
): Promise<InboxIntakeBinding | undefined> {
  const [result] = await db
    .update(inbox)
    .set({
      intakeState: "accepted",
      intakeError: null,
      // Acceptance and removal intent describe opposite lifecycle outcomes.
      // Clear any intent recorded by an earlier failed attempt before the row
      // becomes visible as processing, so a later cleanup pass cannot reclaim
      // accepted bytes.
      objectRemovalPending: false,
      objectRemovalAmbiguous: false,
      intakePublishingUntil: null,
      contentHash: params.contentHash,
      contentType: params.contentType,
      size: params.size,
      fileName: params.fileName,
      status: "processing",
    })
    .where(
      and(
        eq(inbox.id, params.id),
        eq(inbox.teamId, params.teamId),
        // Only a reservation may become accepted. An already accepted record
        // must never be moved back into an earlier state by a late writer, and
        // a cancelled or deleted record must never resurrect.
        eq(inbox.intakeState, "reserved"),
        ne(inbox.status, "deleted"),
      ),
    )
    .returning(intakeBindingColumns);

  return result;
}

/**
 * Records why an unaccepted attempt did not finish. The record stays reserved
 * so the next attempt with the same content resumes the same object path
 * instead of creating a second document.
 */
export async function recordInboxIntakeError(
  db: InboxQueryDatabase,
  params: { id: string; teamId: string; error: string },
) {
  await db
    .update(inbox)
    .set({ intakeError: params.error.slice(0, 2000) })
    .where(and(eq(inbox.id, params.id), eq(inbox.teamId, params.teamId)));
}

export async function cancelInboxIntake(
  db: InboxQueryDatabase,
  params: {
    id: string;
    teamId: string;
    error?: string;
    /** Cleanup paths may only end reservations, never accepted work. */
    onlyReserved?: boolean;
  },
) {
  const conditions = [
    eq(inbox.id, params.id),
    eq(inbox.teamId, params.teamId),
    ne(inbox.status, "deleted"),
  ];
  if (params.onlyReserved) {
    conditions.push(eq(inbox.intakeState, "reserved"));
  }

  const [result] = await db
    .update(inbox)
    .set({
      intakeState: "cancelled",
      contentHash: null,
      status: "deleted",
      intakeError: params.error?.slice(0, 2000) ?? null,
      // Removal intent is durable with the cancellation: a crash before the
      // object is removed is recovered by the next cleanup pass.
      objectRemovalPending: true,
      // Preserve any unresolved publication outcome and treat a reservation
      // as ambiguous: it may still have an in-flight writer. Do not use a
      // stale pre-update read for this decision.
      objectRemovalAmbiguous: sql<boolean>`(${inbox.objectRemovalAmbiguous} or coalesce(${inbox.intakeState} = 'reserved', false))`,
    })
    .where(and(...conditions))
    .returning({ id: inbox.id, filePath: inbox.filePath });

  return result;
}

/**
 * Conditionally ends one unaccepted reservation. Returns the claim only when
 * this caller is the one that moved `reserved` to `cancelled`, so cleanup can
 * never delete a document that finished accepting in the meantime.
 */
export async function claimReservedIntakeForDiscard(
  db: InboxQueryDatabase,
  params: { id: string; teamId: string },
): Promise<{ id: string; filePath: string[] | null } | undefined> {
  const [result] = await db
    .update(inbox)
    .set({
      intakeState: "cancelled",
      contentHash: null,
      status: "deleted",
      intakeError: "Unaccepted intake reservation discarded",
      // Intent first, effect second: a crash after this claim is recovered.
      objectRemovalPending: true,
      // The reservation may have had an in-flight writer before this claim
      // acquired the row lock; keep the ambiguity until explicit settlement.
      objectRemovalAmbiguous: true,
    })
    .where(
      and(
        eq(inbox.id, params.id),
        eq(inbox.teamId, params.teamId),
        eq(inbox.intakeState, "reserved"),
        ne(inbox.status, "deleted"),
        noLivePublicationLease(),
      ),
    )
    .returning({ id: inbox.id, filePath: inbox.filePath });

  return result;
}

/**
 * Claims a pending removal whose publication outcome was ambiguous. The
 * returned object is removed, but the tombstone and ambiguity marker stay set.
 * There is no pass-count or TTL that can prove a remote write will not arrive
 * later; only explicit provider/operator settlement may clear it.
 */
export async function claimAmbiguousObjectRemovalForDiscard(
  db: InboxQueryDatabase,
  params: { id: string; teamId: string },
): Promise<{ id: string; filePath: string[] | null } | undefined> {
  const [result] = await db
    .update(inbox)
    .set({
      intakeState: "cancelled",
      contentHash: null,
      status: "deleted",
      objectRemovalPending: true,
      objectRemovalAmbiguous: true,
    })
    .where(
      and(
        eq(inbox.id, params.id),
        eq(inbox.teamId, params.teamId),
        eq(inbox.objectRemovalPending, true),
        eq(inbox.objectRemovalAmbiguous, true),
        // Accepted content is never eligible for removal, and a retry that
        // is still writing holds a publication lease that excludes the row
        // until it has accepted (or the lease has expired).
        inArray(inbox.intakeState, ["reserved", "cancelled"]),
        noLivePublicationLease(),
      ),
    )
    .returning({ id: inbox.id, filePath: inbox.filePath });

  return result;
}

/**
 * Claims a non-ambiguous pending removal. These rows have no outstanding
 * writer (for example an explicit delete); the caller may clear the tombstone
 * after the object has been removed successfully.
 */
export async function claimSettledObjectRemovalForDiscard(
  db: InboxQueryDatabase,
  params: { id: string; teamId: string },
): Promise<{ id: string; filePath: string[] | null } | undefined> {
  const [result] = await db
    .update(inbox)
    .set({
      intakeState: "cancelled",
      contentHash: null,
      status: "deleted",
      objectRemovalPending: true,
      objectRemovalAmbiguous: false,
    })
    .where(
      and(
        eq(inbox.id, params.id),
        eq(inbox.teamId, params.teamId),
        eq(inbox.objectRemovalPending, true),
        eq(inbox.objectRemovalAmbiguous, false),
        inArray(inbox.intakeState, ["reserved", "cancelled"]),
        noLivePublicationLease(),
      ),
    )
    .returning({ id: inbox.id, filePath: inbox.filePath });

  return result;
}

/**
 * Clears a stale removal tombstone that was accidentally left on an accepted
 * row. It never removes the object; accepted bytes remain owned by the
 * document binding.
 */
export async function clearAcceptedObjectRemovalIntent(
  db: InboxQueryDatabase,
  params: { id: string; teamId: string },
) {
  await db
    .update(inbox)
    .set({
      objectRemovalPending: false,
      objectRemovalAmbiguous: false,
      intakeError: null,
    })
    .where(
      and(
        eq(inbox.id, params.id),
        eq(inbox.teamId, params.teamId),
        eq(inbox.intakeState, "accepted"),
        eq(inbox.objectRemovalPending, true),
      ),
    );
}

/**
 * Persists removal intent for an object that may exist at the record's path.
 * Called when a publication fails, or when it wrote bytes for a record that
 * was cancelled meanwhile, so the next cleanup pass reclaims them.
 */
export async function recordInboxIntakeRemovalIntent(
  db: InboxQueryDatabase,
  params: { id: string; teamId: string; error: string },
) {
  await db
    .update(inbox)
    .set({
      intakeError: params.error.slice(0, 2000),
      objectRemovalPending: true,
      // A failed publication cannot prove that the remote write did not
      // complete after the local abort. Keep the reconciliation tombstone
      // until verified acceptance or explicit provider/operator settlement.
      objectRemovalAmbiguous: true,
      // The publication lease is shared with any concurrent attempt for the
      // same content, so it is left to expire rather than cleared here.
    })
    .where(
      and(
        eq(inbox.id, params.id),
        eq(inbox.teamId, params.teamId),
        // A concurrent retry may have accepted the row meanwhile. Never
        // re-attach removal intent to accepted content.
        inArray(inbox.intakeState, ["reserved", "cancelled"]),
      ),
    );
}

/**
 * Records a removal failure durably. The record keeps `object_removal_pending`
 * so the next cleanup pass revisits it instead of orphaning the bytes.
 */
export async function recordIntakeRemovalFailure(
  db: InboxQueryDatabase,
  params: { id: string; teamId: string; error: string },
) {
  await db
    .update(inbox)
    .set({
      intakeError: params.error.slice(0, 2000),
      objectRemovalPending: true,
      // Preserve the row's existing ambiguity. A removal failure on an
      // explicit delete still has no publication writer, while an ambiguous
      // publication must remain ambiguous.
    })
    .where(
      and(
        eq(inbox.id, params.id),
        eq(inbox.teamId, params.teamId),
        inArray(inbox.intakeState, ["reserved", "cancelled"]),
      ),
    );
}

/**
 * Unaccepted reservations that never finished. They hold no processing intent
 * and never become accepted invoices; operators may discard them explicitly.
 * There is deliberately no automatic retention schedule in this slice.
 */
export async function listStaleReservedIntake(
  db: InboxQueryDatabase,
  params: { olderThanMs: number; limit?: number },
): Promise<InboxIntakeBinding[]> {
  const cutoff = new Date(Date.now() - params.olderThanMs).toISOString();

  const rows = await db
    .select(intakeBindingColumns)
    .from(inbox)
    .where(
      and(
        eq(inbox.intakeState, "reserved"),
        lt(inbox.createdAt, cutoff),
        ne(inbox.status, "deleted"),
      ),
    )
    .orderBy(asc(inbox.createdAt), asc(inbox.id))
    .limit(params.limit ?? 50);

  // Cleanup must never touch an object whose persisted path is not this
  // workspace's document path.
  return rows.filter((row) => isValidDocumentBinding(row));
}

export type InboxIntakeBindingCursor = {
  /** Stable timestamp/id tuple used by the explicit cleanup helper. */
  createdAt: string;
  id: string;
};

export type PendingObjectRemovalPage = {
  rows: InboxIntakeBinding[];
  /** Pass this back as `after` to continue a full pass. */
  nextCursor: InboxIntakeBindingCursor | null;
  /** True when another page exists after this one. */
  hasMore: boolean;
};

/**
 * Documents whose object removal is still outstanding. Removal failures and
 * ambiguous publications are durable, so a later cleanup pass can finish the
 * work instead of leaving the bytes behind forever. The cursor is over
 * `(created_at, id)`, which is immutable and deterministic even while a row
 * remains pending across passes.
 */
export async function listPendingObjectRemovals(
  db: InboxQueryDatabase,
  params: { limit?: number; after?: InboxIntakeBindingCursor } = {},
): Promise<PendingObjectRemovalPage> {
  const limit = Math.max(1, params.limit ?? 50);
  const conditions = [eq(inbox.objectRemovalPending, true)];

  if (params.after) {
    const cursor = params.after;
    conditions.push(
      or(
        gt(inbox.createdAt, cursor.createdAt),
        and(eq(inbox.createdAt, cursor.createdAt), gt(inbox.id, cursor.id)),
      )!,
    );
  }

  // Fetch one extra row to determine whether another page exists without a
  // second query. The cursor advances over raw rows, including rows later
  // filtered by the binding validator, so invalid legacy rows cannot cause a
  // loop over the same page.
  const rows = await db
    .select(intakeBindingColumns)
    .from(inbox)
    .where(and(...conditions))
    .orderBy(asc(inbox.createdAt), asc(inbox.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);
  const last = pageRows.at(-1);

  return {
    rows: pageRows.filter((row) => isValidDocumentBinding(row)),
    nextCursor:
      hasMore && last ? { createdAt: last.createdAt, id: last.id } : null,
    hasMore,
  };
}

/**
 * True when another live (not deleted) record in the workspace points at the
 * same stored object. New intake paths are unique per record, but legacy rows
 * used `<team>/inbox/<filename>` and may share one object, which must not be
 * removed while any of them is still in use.
 */
export async function isStoredPathSharedByLiveDocument(
  db: InboxQueryDatabase,
  params: { id: string; teamId: string; filePath: string[] },
) {
  const [shared] = await db
    .select({ id: inbox.id })
    .from(inbox)
    .where(
      and(
        eq(inbox.teamId, params.teamId),
        ne(inbox.id, params.id),
        ne(inbox.status, "deleted"),
        eq(inbox.filePath, params.filePath),
      ),
    )
    .limit(1);

  return Boolean(shared);
}

/** Clears the outstanding-removal flag once the bytes are proven gone. */
export async function clearObjectRemovalPending(
  db: InboxQueryDatabase,
  params: { id: string; teamId: string },
) {
  await db
    .update(inbox)
    .set({
      objectRemovalPending: false,
      objectRemovalAmbiguous: false,
      intakeError: null,
    })
    .where(
      and(
        eq(inbox.id, params.id),
        eq(inbox.teamId, params.teamId),
        // Ambiguous rows require explicit settlement; this generic clear must
        // never erase an unresolved remote outcome.
        eq(inbox.objectRemovalAmbiguous, false),
      ),
    );
}

/**
 * Explicitly settles an ambiguous removal after provider/operator evidence
 * proves no late write can still arrive. This is the only automatic-code path
 * other than verified accepted retry that may clear the ambiguity marker; the
 * cleanup helper itself never guesses settlement from a pass count.
 */
export async function settleAmbiguousObjectRemoval(
  db: InboxQueryDatabase,
  params: { id: string; teamId: string; evidence: string },
) {
  const [result] = await db
    .update(inbox)
    .set({
      objectRemovalPending: false,
      objectRemovalAmbiguous: false,
      intakeError: `Ambiguous removal settled: ${params.evidence}`.slice(
        0,
        2000,
      ),
    })
    .where(
      and(
        eq(inbox.id, params.id),
        eq(inbox.teamId, params.teamId),
        eq(inbox.intakeState, "cancelled"),
        eq(inbox.objectRemovalPending, true),
        eq(inbox.objectRemovalAmbiguous, true),
      ),
    )
    .returning({ id: inbox.id });

  return result;
}

export async function getInboxByFilePath(
  db: InboxQueryDatabase,
  params: GetInboxByFilePathParams,
) {
  const { filePath, teamId } = params;

  const [result] = await db
    .select(intakeBindingColumns)
    .from(inbox)
    .where(
      and(
        eq(inbox.filePath, filePath),
        eq(inbox.teamId, teamId),
        ne(inbox.status, "deleted"),
      ),
    )
    .limit(1);

  // A legacy payload path only counts when the matched row itself holds a
  // valid binding for this workspace.
  if (!result || !isValidDocumentBinding(result)) return undefined;

  return result;
}

/**
 * The live, processed documents in the workspace received before (or after)
 * the given one, ordered by `created_at` then id: the earliest copy of an
 * invoice is its original whatever order the copies were processed in, and a
 * deleted or reserved document is never a duplicate or credit candidate.
 */
export const liveDocumentsReceived = (
  direction: "before" | "after",
  teamId: string,
  documentId: string,
) =>
  and(
    eq(inbox.teamId, teamId),
    ne(inbox.status, "deleted"),
    visibleIntakeState(),
    isNotNull(inbox.extraction),
    direction === "before"
      ? sql`(${inbox.createdAt}, ${inbox.id}) < (select current.created_at, current.id from ${inbox} as current where current.id = ${documentId})`
      : sql`(${inbox.createdAt}, ${inbox.id}) > (select current.created_at, current.id from ${inbox} as current where current.id = ${documentId})`,
  );

/** A document's supplier after merges; null when none was resolved. Needs `suppliers` left-joined. */
const canonicalSupplierOf = sql<
  string | null
>`coalesce(${suppliers.mergedIntoId}, ${suppliers.id})`;

export const documentNumberKeys = (numbers: string[]) => [
  ...new Set(
    numbers
      .map((number) => number.toUpperCase().replace(/[^A-Z0-9]/g, ""))
      .filter(Boolean),
  ),
];

export const documentNumberOf = (
  field: "invoiceNumber" | "originalInvoiceNumber",
) =>
  sql<string>`upper(regexp_replace(${inbox.extraction} ->> ${field}::text, '[^A-Za-z0-9]', '', 'g'))`;

/**
 * Earlier documents in the workspace with the given document numbers,
 * compared without spacing, punctuation or case: the candidates for a
 * duplicate or for the invoice a credit note credits, however far back.
 */
export async function getInvoicesByDocumentNumber(
  db: Database,
  params: { teamId: string; documentId: string; numbers: string[] },
) {
  const keys = documentNumberKeys(params.numbers);
  if (keys.length === 0) return [];
  return db
    .select({
      id: inbox.id,
      extraction: inbox.extraction,
      supplierId: canonicalSupplierOf,
    })
    .from(inbox)
    .leftJoin(suppliers, eq(suppliers.id, inbox.supplierId))
    .where(
      and(
        liveDocumentsReceived("before", params.teamId, params.documentId),
        inArray(documentNumberOf("invoiceNumber"), keys),
      ),
    )
    .orderBy(inbox.createdAt, inbox.id)
    .limit(20);
}

/**
 * Later documents, not yet sent to accounting, that carry the given number
 * or credit it: the copies and credit notes whose validation depends on a
 * document that was processed after them.
 */
export async function getLaterDocumentsByNumber(
  db: Database,
  params: { teamId: string; documentId: string; number: string },
) {
  const keys = documentNumberKeys([params.number]);
  if (keys.length === 0) return [];
  return db
    .select({
      id: inbox.id,
      extraction: inbox.extraction,
      supplierId: canonicalSupplierOf,
    })
    .from(inbox)
    .leftJoin(suppliers, eq(suppliers.id, inbox.supplierId))
    .where(
      and(
        liveDocumentsReceived("after", params.teamId, params.documentId),
        isNull(inbox.accountingProviderId),
        or(
          inArray(documentNumberOf("invoiceNumber"), keys),
          inArray(documentNumberOf("originalInvoiceNumber"), keys),
        ),
      ),
    )
    .orderBy(inbox.createdAt, inbox.id)
    .limit(20);
}

/**
 * Serialises validation of a workspace's documents until the transaction
 * ends, so two copies saved at once still see each other.
 */
export async function lockDocumentIdentities(db: Database, teamId: string) {
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`inbox-identity:${teamId}`}))`,
  );
}

export async function updateInboxValidation(
  db: Database,
  params: { id: string; teamId: string; validation: Record<string, unknown> },
) {
  await db
    .update(inbox)
    .set({ validation: params.validation })
    .where(and(eq(inbox.id, params.id), eq(inbox.teamId, params.teamId)));
}

export async function getExistingInboxAttachments(
  db: InboxQueryDatabase,
  teamId: string,
  referenceIds: string[],
) {
  if (referenceIds.length === 0) return [];

  const live = and(
    eq(inbox.teamId, teamId),
    ne(inbox.status, "deleted"),
    // A reservation is not a delivered attachment: the next sync must try
    // to recover it instead of skipping it as already handled. Legacy rows
    // predate the intake state and count as accepted.
    or(isNull(inbox.intakeState), eq(inbox.intakeState, "accepted")),
  );
  const [documents, redeliveries] = await Promise.all([
    db
      .select({ referenceId: inbox.referenceId })
      .from(inbox)
      .where(and(live, inArray(inbox.referenceId, referenceIds))),
    // An attachment whose bytes matched an earlier document was recorded as
    // a re-delivery of it; it is handled too.
    db
      .select({ referenceId: inboxRedeliveries.referenceId })
      .from(inboxRedeliveries)
      .innerJoin(inbox, eq(inbox.id, inboxRedeliveries.inboxId))
      .where(
        and(
          eq(inboxRedeliveries.teamId, teamId),
          inArray(inboxRedeliveries.referenceId, referenceIds),
          live,
        ),
      ),
  ]);
  return [...documents, ...redeliveries];
}

export type CreateInboxParams = {
  displayName: string;
  teamId: string;
  filePath: string[];
  fileName: string;
  contentType: string;
  size: number;
  referenceId?: string;
  website?: string;
  inboxAccountId?: string;
  status?:
    | "new"
    | "analyzing"
    | "pending"
    | "done"
    | "processing"
    | "archived"
    | "deleted";
};

export async function createInbox(db: Database, params: CreateInboxParams) {
  const {
    displayName,
    teamId,
    filePath,
    fileName,
    contentType,
    size,
    referenceId,
    website,
    inboxAccountId,
    status = "new",
  } = params;

  const [result] = await db
    .insert(inbox)
    .values({
      displayName,
      teamId,
      filePath,
      fileName,
      contentType,
      size,
      referenceId,
      website,
      inboxAccountId,
      status,
    })
    .returning({
      id: inbox.id,
      teamId: inbox.teamId,
      fileName: inbox.fileName,
      filePath: inbox.filePath,
      displayName: inbox.displayName,
      transactionId: inbox.transactionId,
      amount: inbox.amount,
      currency: inbox.currency,
      contentType: inbox.contentType,
      date: inbox.date,
      status: inbox.status,
      createdAt: inbox.createdAt,
      website: inbox.website,
      description: inbox.description,
      referenceId: inbox.referenceId,
      size: inbox.size,
    });

  return result;
}

export type UpdateInboxWithProcessedDataParams = {
  id: string;
  amount?: number | null;
  currency?: string | null;
  displayName?: string | null;
  website?: string | null;
  date?: string | null;
  taxAmount?: number | null;
  taxRate?: number | null;
  taxType?: string | null;
  description?: string | null;
  extraction?: Record<string, unknown> | null;
  judgments?: Record<string, unknown>[] | null;
  validation?: Record<string, unknown> | null;
  processingError?: string | null;
  type?: "invoice" | "expense" | null;
  status?:
    | "pending"
    | "new"
    | "archived"
    | "processing"
    | "analyzing"
    | "done"
    | "deleted";
};

/**
 * What a completed revision carries into its delivery intents: the record
 * delivered to webhooks plus the accounting state that decides whether a
 * bill is scheduled. Shared by processing and by user revisions
 * (`reviseInvoice`).
 */
export const completedInvoiceColumns = {
  id: inbox.id,
  teamId: inbox.teamId,
  fileName: inbox.fileName,
  filePath: inbox.filePath,
  displayName: inbox.displayName,
  transactionId: inbox.transactionId,
  amount: inbox.amount,
  currency: inbox.currency,
  contentType: inbox.contentType,
  date: inbox.date,
  status: inbox.status,
  createdAt: inbox.createdAt,
  website: inbox.website,
  description: inbox.description,
  referenceId: inbox.referenceId,
  inboundEmailId: inbox.inboundEmailId,
  size: inbox.size,
  taxAmount: inbox.taxAmount,
  taxRate: inbox.taxRate,
  taxType: inbox.taxType,
  type: inbox.type,
  extraction: inbox.extraction,
  judgments: inbox.judgments,
  validation: inbox.validation,
  processingRevision: inbox.processingRevision,
  accountingPostStatus: inbox.accountingPostStatus,
  accountingProviderId: inbox.accountingProviderId,
};

/**
 * Persists a processing result as the next revision, but only while the
 * record is still `processing`. Two workers that raced on one document (an
 * expired lease) cannot both complete it: the loser gets no row back and
 * schedules nothing.
 */
export async function completeInboxProcessing(
  db: Pick<Database, "update">,
  params: Omit<UpdateInboxWithProcessedDataParams, "status"> & {
    teamId: string;
  },
) {
  const { id, teamId, ...updateData } = params;
  const [result] = await db
    .update(inbox)
    .set({
      ...updateData,
      status: "pending",
      processingRevision: sql`${inbox.processingRevision} + 1`,
      // A fresh reading replaces any corrected record and supersedes a
      // question rerun that was requested for an earlier revision.
      extractionOriginal: null,
      judgmentsRerunStatus: null,
      judgmentsRerunError: null,
      judgmentsRerunRevision: null,
    })
    .where(
      and(
        eq(inbox.id, id),
        eq(inbox.teamId, teamId),
        eq(inbox.status, "processing"),
      ),
    )
    .returning(completedInvoiceColumns);
  return result;
}

/**
 * Locks an invoice row for a delivery retry so concurrent retries and a
 * finishing worker serialize on it.
 */
export async function getInvoiceForDeliveryUpdate(
  db: Pick<Database, "select">,
  params: { id: string; teamId: string },
) {
  const [result] = await db
    .select({
      id: inbox.id,
      teamId: inbox.teamId,
      status: inbox.status,
      intakeState: inbox.intakeState,
      processingRevision: inbox.processingRevision,
      accountingPostStatus: inbox.accountingPostStatus,
      accountingProviderId: inbox.accountingProviderId,
      accountingRevision: inbox.accountingRevision,
    })
    .from(inbox)
    .where(and(eq(inbox.id, params.id), eq(inbox.teamId, params.teamId)))
    .for("update")
    .limit(1);
  return result;
}

export async function updateInboxWithProcessedData(
  db: Database,
  params: UpdateInboxWithProcessedDataParams & { teamId?: string },
) {
  const { id, teamId, ...updateData } = params;

  const [result] = await db
    .update(inbox)
    .set(updateData)
    .where(
      and(
        eq(inbox.id, id),
        // Extraction that finishes after the invoice was deleted must not
        // recreate derived state or emit downstream work.
        ne(inbox.status, "deleted"),
        ...(teamId ? [eq(inbox.teamId, teamId)] : []),
      ),
    )
    .returning({
      id: inbox.id,
      teamId: inbox.teamId,
      fileName: inbox.fileName,
      filePath: inbox.filePath,
      displayName: inbox.displayName,
      transactionId: inbox.transactionId,
      amount: inbox.amount,
      currency: inbox.currency,
      contentType: inbox.contentType,
      date: inbox.date,
      status: inbox.status,
      createdAt: inbox.createdAt,
      website: inbox.website,
      description: inbox.description,
      referenceId: inbox.referenceId,
      size: inbox.size,
      taxAmount: inbox.taxAmount,
      taxRate: inbox.taxRate,
      taxType: inbox.taxType,
      type: inbox.type,
      extraction: inbox.extraction,
      judgments: inbox.judgments,
      validation: inbox.validation,
      processingError: inbox.processingError,
    });

  return result;
}

/**
 * Records a failed extraction on an accepted document. Every input format
 * fails into the same shape: status `pending` with the reason in
 * `processing_error`, so a failure can never be mistaken for a processed
 * invoice. Only a document still `processing` is marked failed, and a failed
 * re-extraction keeps the reading it already had: a later failure never
 * erases a saved extraction.
 */
export async function recordInboxProcessingFailure(
  db: InboxQueryDatabase,
  params: { id: string; teamId: string; error: string },
) {
  const [result] = await db
    .update(inbox)
    .set({
      status: "pending",
      processingError: params.error,
      judgmentsRerunStatus: null,
      judgmentsRerunError: null,
      judgmentsRerunRevision: null,
    })
    .where(
      and(
        eq(inbox.id, params.id),
        eq(inbox.teamId, params.teamId),
        eq(inbox.status, "processing"),
        visibleIntakeState(),
      ),
    )
    .returning({ id: inbox.id, processingError: inbox.processingError });

  return result;
}
