import { type SQL, relations, sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  customType,
  date,
  foreignKey,
  index,
  integer,
  json,
  jsonb,
  numeric,
  pgEnum,
  pgMaterializedView,
  pgPolicy,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
  vector,
} from "drizzle-orm/pg-core";

export const tsvector = customType<{
  data: string;
}>({
  dataType() {
    return "tsvector";
  },
});

type NumericConfig = {
  precision?: number;
  scale?: number;
};

/** Raw bytes (Postgres `bytea`), read and written as a Buffer. */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const numericCasted = customType<{
  data: number;
  driverData: string;
  config: NumericConfig;
}>({
  dataType: (config) => {
    if (config?.precision && config?.scale) {
      return `numeric(${config.precision}, ${config.scale})`;
    }
    return "numeric";
  },
  fromDriver: (value: string) => Number.parseFloat(value),
  toDriver: (value: number) => value.toString(),
});

export const accountTypeEnum = pgEnum("account_type", [
  "depository",
  "credit",
  "other_asset",
  "loan",
  "other_liability",
]);

export const bankProvidersEnum = pgEnum("bank_providers", [
  "gocardless",
  "plaid",
  "teller",
  "enablebanking",
]);

export const connectionStatusEnum = pgEnum("connection_status", [
  "disconnected",
  "connected",
  "unknown",
]);

export const documentProcessingStatusEnum = pgEnum(
  "document_processing_status",
  ["pending", "processing", "completed", "failed"],
);

export const inboxAccountProvidersEnum = pgEnum("inbox_account_providers", [
  "gmail",
  "outlook",
]);

export const inboxAccountStatusEnum = pgEnum("inbox_account_status", [
  "connected",
  "disconnected",
]);

export const inboxStatusEnum = pgEnum("inbox_status", [
  "processing",
  "pending",
  "archived",
  "new",
  "analyzing",
  "suggested_match",
  "no_match",
  "done",
  "deleted",
]);

export const inboxIntakeStateEnum = pgEnum("inbox_intake_state", [
  "reserved",
  "accepted",
  "cancelled",
]);

export const inboxTypeEnum = pgEnum("inbox_type", ["invoice", "expense"]);
export const invoiceQuestionTypeEnum = pgEnum("invoice_question_type", [
  "boolean",
  "choice",
  "score",
  "number",
]);
export const workflowStatusEnum = pgEnum("workflow_status", [
  "queued",
  "running",
  "succeeded",
  "failed",
]);
export const webhookDeliveryStatusEnum = pgEnum("webhook_delivery_status", [
  "queued",
  "delivering",
  "succeeded",
  "failed",
  "cancelled",
]);
export const accountingProviderEnum = pgEnum("accounting_provider", [
  "xero",
  "quickbooks",
]);
export const deletionSubjectEnum = pgEnum("deletion_subject", [
  "workspace",
  "account",
]);
export const deletionStatusEnum = pgEnum("deletion_status", [
  "pending",
  "completed",
  "failed",
]);
// A message received on a workspace's dedicated address: stored with its
// processing intent, then read into invoices (or recorded as failed).
export const inboundEmailStatusEnum = pgEnum("inbound_email_status", [
  "received",
  "processed",
  "failed",
]);
export const dataExportStatusEnum = pgEnum("data_export_status", [
  "queued",
  "running",
  "ready",
  "failed",
  "expired",
]);
export const accountingPostStatusEnum = pgEnum("accounting_post_status", [
  "posted",
  "already_posted",
  "failed",
  "needs_review",
  "queued",
  "cancelled",
]);
export const invoiceDeliveryTypeEnum = pgEnum("invoice_delivery_type", [
  "create",
  "create_and_send",
  "scheduled",
]);

export const invoiceSizeEnum = pgEnum("invoice_size", ["a4", "letter"]);
export const invoiceStatusEnum = pgEnum("invoice_status", [
  "draft",
  "overdue",
  "paid",
  "unpaid",
  "canceled",
  "scheduled",
]);

export const plansEnum = pgEnum("plans", ["trial", "starter", "pro"]);
export const subscriptionStatusEnum = pgEnum("subscription_status", [
  "active",
  "canceled",
  "past_due",
  "unpaid",
  "trialing",
  "incomplete",
  "incomplete_expired",
]);
export const reportTypesEnum = pgEnum("reportTypes", [
  "profit",
  "revenue",
  "burn_rate",
  "expense",
]);

export const teamRolesEnum = pgEnum("teamRoles", ["owner", "admin", "member"]);
export const trackerStatusEnum = pgEnum("trackerStatus", [
  "in_progress",
  "completed",
]);

export const transactionMethodsEnum = pgEnum("transactionMethods", [
  "payment",
  "card_purchase",
  "card_atm",
  "transfer",
  "other",
  "unknown",
  "ach",
  "interest",
  "deposit",
  "wire",
  "fee",
]);

export const transactionStatusEnum = pgEnum("transactionStatus", [
  "posted",
  "pending",
  "excluded",
  "completed",
  "archived",
]);

export const transactionFrequencyEnum = pgEnum("transaction_frequency", [
  "weekly",
  "biweekly",
  "monthly",
  "semi_monthly",
  "annually",
  "irregular",
  "unknown",
]);

export const activityTypeEnum = pgEnum("activity_type", [
  // System-generated activities
  "transactions_enriched",
  "transactions_created",
  "invoice_paid",
  "inbox_new",
  "inbox_auto_matched",
  "inbox_needs_review",
  "inbox_cross_currency_matched",
  "invoice_overdue",
  "invoice_sent",
  "inbox_match_confirmed",

  // User actions
  "document_uploaded",
  "document_processed",
  "invoice_duplicated",
  "invoice_scheduled",
  "invoice_reminder_sent",
  "invoice_cancelled",
  "invoice_created",
  "draft_invoice_created",
  "tracker_entry_created",
  "tracker_project_created",
  "transactions_categorized",
  "transactions_assigned",
  "transaction_attachment_created",
  "transaction_category_created",
  "transactions_exported",
  "customer_created",
]);

export const activitySourceEnum = pgEnum("activity_source", [
  "system", // Automated system processes
  "user", // Direct user actions
]);

export const activityStatusEnum = pgEnum("activity_status", [
  "unread",
  "read",
  "archived",
]);

export const documentTagEmbeddings = pgTable(
  "document_tag_embeddings",
  {
    slug: text().primaryKey().notNull(),
    embedding: vector({ dimensions: 768 }),
    name: text().notNull(),
    model: text().notNull().default("gemini-embedding-001"),
  },
  (table) => [
    index("document_tag_embeddings_idx")
      .using("hnsw", table.embedding.asc().nullsLast().op("vector_cosine_ops"))
      .with({ m: "16", ef_construction: "64" }),
    pgPolicy("Enable insert for authenticated users only", {
      as: "permissive",
      for: "insert",
      to: ["authenticated"],
      withCheck: sql`true`,
    }),
  ],
);

export const transactionCategoryEmbeddings = pgTable(
  "transaction_category_embeddings",
  {
    name: text().primaryKey().notNull(), // Unique by name - same embedding for all teams
    embedding: vector({ dimensions: 768 }),
    model: text().notNull().default("gemini-embedding-001"),
    system: boolean().default(false).notNull(), // Whether this comes from system categories
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // Vector similarity index for fast cosine similarity search
    index("transaction_category_embeddings_vector_idx")
      .using("hnsw", table.embedding.asc().nullsLast().op("vector_cosine_ops"))
      .with({ m: "16", ef_construction: "64" }),
    // System categories index for filtering
    index("transaction_category_embeddings_system_idx").using(
      "btree",
      table.system.asc().nullsLast().op("bool_ops"),
    ),
    pgPolicy("Enable read access for authenticated users", {
      as: "permissive",
      for: "select",
      to: ["authenticated"],
      using: sql`true`,
    }),
    pgPolicy("Enable insert for authenticated users only", {
      as: "permissive",
      for: "insert",
      to: ["authenticated"],
      withCheck: sql`true`,
    }),
    pgPolicy("Enable update for authenticated users only", {
      as: "permissive",
      for: "update",
      to: ["authenticated"],
      using: sql`true`,
    }),
  ],
);

export const transactions = pgTable(
  "transactions",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    date: date().notNull(),
    name: text().notNull(),
    method: transactionMethodsEnum().notNull(),
    amount: numericCasted({ precision: 10, scale: 2 }).notNull(),
    currency: text().notNull(),
    teamId: uuid("team_id").notNull(),
    assignedId: uuid("assigned_id"),
    note: varchar(),
    bankAccountId: uuid("bank_account_id"),
    internalId: text("internal_id").notNull(),
    status: transactionStatusEnum().default("posted"),
    balance: numericCasted({ precision: 10, scale: 2 }),
    manual: boolean().default(false),
    notified: boolean().default(false),
    internal: boolean().default(false),
    description: text(),
    categorySlug: text("category_slug"),
    baseAmount: numericCasted({ precision: 10, scale: 2 }),
    counterpartyName: text("counterparty_name"),
    baseCurrency: text("base_currency"),
    taxAmount: numericCasted("tax_amount", { precision: 10, scale: 2 }),
    taxRate: numericCasted("tax_rate", { precision: 10, scale: 2 }),
    taxType: text("tax_type"),
    recurring: boolean(),
    frequency: transactionFrequencyEnum(),
    merchantName: text("merchant_name"),
    enrichmentCompleted: boolean("enrichment_completed").default(false),
    ftsVector: tsvector("fts_vector")
      .notNull()
      .generatedAlwaysAs(
        (): SQL => sql`
				to_tsvector(
					'english',
					(
						(COALESCE(name, ''::text) || ' '::text) || COALESCE(description, ''::text)
					)
				)
			`,
      ),
  },
  (table) => [
    index("idx_transactions_date").using(
      "btree",
      table.date.asc().nullsLast().op("date_ops"),
    ),
    index("idx_transactions_fts").using(
      "gin",
      table.ftsVector.asc().nullsLast().op("tsvector_ops"),
    ),
    index("idx_transactions_fts_vector").using(
      "gin",
      table.ftsVector.asc().nullsLast().op("tsvector_ops"),
    ),
    index("idx_transactions_id").using(
      "btree",
      table.id.asc().nullsLast().op("uuid_ops"),
    ),
    index("idx_transactions_name").using(
      "btree",
      table.name.asc().nullsLast().op("text_ops"),
    ),
    index("idx_transactions_name_trigram").using(
      "gin",
      table.name.asc().nullsLast().op("gin_trgm_ops"),
    ),
    index("idx_transactions_team_id_date_name").using(
      "btree",
      table.teamId.asc().nullsLast().op("uuid_ops"),
      table.date.asc().nullsLast().op("date_ops"),
      table.name.asc().nullsLast().op("text_ops"),
    ),
    index("idx_transactions_team_id_name").using(
      "btree",
      table.teamId.asc().nullsLast().op("uuid_ops"),
      table.name.asc().nullsLast().op("text_ops"),
    ),
    index("idx_trgm_name").using(
      "gist",
      table.name.asc().nullsLast().op("gist_trgm_ops"),
    ),
    index("transactions_assigned_id_idx").using(
      "btree",
      table.assignedId.asc().nullsLast().op("uuid_ops"),
    ),
    index("transactions_bank_account_id_idx").using(
      "btree",
      table.bankAccountId.asc().nullsLast().op("uuid_ops"),
    ),
    index("transactions_category_slug_idx").using(
      "btree",
      table.categorySlug.asc().nullsLast().op("text_ops"),
    ),
    index(
      "transactions_team_id_date_currency_bank_account_id_category_idx",
    ).using(
      "btree",
      table.teamId.asc().nullsLast().op("uuid_ops"),
      table.date.asc().nullsLast().op("date_ops"),
      table.currency.asc().nullsLast().op("text_ops"),
      table.bankAccountId.asc().nullsLast().op("uuid_ops"),
    ),
    index("transactions_team_id_idx").using(
      "btree",
      table.teamId.asc().nullsLast().op("uuid_ops"),
    ),
    foreignKey({
      columns: [table.assignedId],
      foreignColumns: [users.id],
      name: "public_transactions_assigned_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.teamId],
      foreignColumns: [teams.id],
      name: "public_transactions_team_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.bankAccountId],
      foreignColumns: [bankAccounts.id],
      name: "transactions_bank_account_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.teamId, table.categorySlug],
      foreignColumns: [
        transactionCategories.teamId,
        transactionCategories.slug,
      ],
      name: "transactions_category_slug_team_id_fkey",
    }),
    unique("transactions_internal_id_key").on(table.internalId),
    pgPolicy("Transactions can be created by a member of the team", {
      as: "permissive",
      for: "insert",
      to: ["public"],
      withCheck: sql`(team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user))`,
    }),
    pgPolicy("Transactions can be deleted by a member of the team", {
      as: "permissive",
      for: "delete",
      to: ["public"],
    }),
    pgPolicy("Transactions can be selected by a member of the team", {
      as: "permissive",
      for: "select",
      to: ["public"],
    }),
    pgPolicy("Transactions can be updated by a member of the team", {
      as: "permissive",
      for: "update",
      to: ["public"],
    }),
  ],
);

export const trackerEntries = pgTable(
  "tracker_entries",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    duration: bigint({ mode: "number" }),
    projectId: uuid("project_id"),
    start: timestamp({ withTimezone: true, mode: "string" }),
    stop: timestamp({ withTimezone: true, mode: "string" }),
    assignedId: uuid("assigned_id"),
    teamId: uuid("team_id"),
    description: text(),
    rate: numericCasted({ precision: 10, scale: 2 }),
    currency: text(),
    billed: boolean().default(false),
    date: date().defaultNow(),
  },
  (table) => [
    index("tracker_entries_team_id_idx").using(
      "btree",
      table.teamId.asc().nullsLast().op("uuid_ops"),
    ),
    foreignKey({
      columns: [table.assignedId],
      foreignColumns: [users.id],
      name: "tracker_entries_assigned_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [trackerProjects.id],
      name: "tracker_entries_project_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.teamId],
      foreignColumns: [teams.id],
      name: "tracker_entries_team_id_fkey",
    }).onDelete("cascade"),
    pgPolicy("Entries can be created by a member of the team", {
      as: "permissive",
      for: "insert",
      to: ["authenticated"],
      withCheck: sql`(team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user))`,
    }),
    pgPolicy("Entries can be deleted by a member of the team", {
      as: "permissive",
      for: "delete",
      to: ["authenticated"],
    }),
    pgPolicy("Entries can be selected by a member of the team", {
      as: "permissive",
      for: "select",
      to: ["authenticated"],
    }),
    pgPolicy("Entries can be updated by a member of the team", {
      as: "permissive",
      for: "update",
      to: ["authenticated"],
    }),
  ],
);

export const customerTags = pgTable(
  "customer_tags",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    customerId: uuid("customer_id").notNull(),
    teamId: uuid("team_id").notNull(),
    tagId: uuid("tag_id").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.customerId],
      foreignColumns: [customers.id],
      name: "customer_tags_customer_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tagId],
      foreignColumns: [tags.id],
      name: "customer_tags_tag_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.teamId],
      foreignColumns: [teams.id],
      name: "customer_tags_team_id_fkey",
    }).onDelete("cascade"),
    unique("unique_customer_tag").on(table.customerId, table.tagId),
    pgPolicy("Tags can be handled by a member of the team", {
      as: "permissive",
      for: "all",
      to: ["public"],
      using: sql`(team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user))`,
    }),
  ],
);

export const inboxAccounts = pgTable(
  "inbox_accounts",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    email: text().notNull(),
    accessToken: text("access_token").notNull(),
    refreshToken: text("refresh_token").notNull(),
    teamId: uuid("team_id").notNull(),
    lastAccessed: timestamp("last_accessed", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    provider: inboxAccountProvidersEnum().notNull(),
    externalId: text("external_id").notNull(),
    expiryDate: timestamp("expiry_date", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    scheduleId: text("schedule_id"),
    status: inboxAccountStatusEnum().default("connected").notNull(),
    errorMessage: text("error_message"),
  },
  (table) => [
    foreignKey({
      columns: [table.teamId],
      foreignColumns: [teams.id],
      name: "inbox_accounts_team_id_fkey",
    }).onDelete("cascade"),
    unique("inbox_accounts_email_key").on(table.email),
    unique("inbox_accounts_external_id_key").on(table.externalId),
    pgPolicy("Inbox accounts can be deleted by a member of the team", {
      as: "permissive",
      for: "delete",
      to: ["public"],
      using: sql`(team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user))`,
    }),
    pgPolicy("Inbox accounts can be selected by a member of the team", {
      as: "permissive",
      for: "select",
      to: ["public"],
    }),
    pgPolicy("Inbox accounts can be updated by a member of the team", {
      as: "permissive",
      for: "update",
      to: ["public"],
    }),
  ],
);

export const bankAccounts = pgTable(
  "bank_accounts",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    createdBy: uuid("created_by").notNull(),
    teamId: uuid("team_id").notNull(),
    name: text(),
    currency: text(),
    bankConnectionId: uuid("bank_connection_id"),
    enabled: boolean().default(true).notNull(),
    accountId: text("account_id").notNull(),
    balance: numericCasted({ precision: 10, scale: 2 }).default(0),
    manual: boolean().default(false),
    type: accountTypeEnum(),
    baseCurrency: text("base_currency"),
    baseBalance: numericCasted({ precision: 10, scale: 2 }),
    errorDetails: text("error_details"),
    errorRetries: smallint("error_retries"),
    accountReference: text("account_reference"),
  },
  (table) => [
    index("bank_accounts_bank_connection_id_idx").using(
      "btree",
      table.bankConnectionId.asc().nullsLast().op("uuid_ops"),
    ),
    index("bank_accounts_created_by_idx").using(
      "btree",
      table.createdBy.asc().nullsLast().op("uuid_ops"),
    ),
    index("bank_accounts_team_id_idx").using(
      "btree",
      table.teamId.asc().nullsLast().op("uuid_ops"),
    ),
    foreignKey({
      columns: [table.bankConnectionId],
      foreignColumns: [bankConnections.id],
      name: "bank_accounts_bank_connection_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [users.id],
      name: "bank_accounts_created_by_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.teamId],
      foreignColumns: [teams.id],
      name: "public_bank_accounts_team_id_fkey",
    }).onDelete("cascade"),
    pgPolicy("Bank Accounts can be created by a member of the team", {
      as: "permissive",
      for: "insert",
      to: ["public"],
      withCheck: sql`(team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user))`,
    }),
    pgPolicy("Bank Accounts can be deleted by a member of the team", {
      as: "permissive",
      for: "delete",
      to: ["public"],
    }),
    pgPolicy("Bank Accounts can be selected by a member of the team", {
      as: "permissive",
      for: "select",
      to: ["public"],
    }),
    pgPolicy("Bank Accounts can be updated by a member of the team", {
      as: "permissive",
      for: "update",
      to: ["public"],
    }),
  ],
);

export const invoices = pgTable(
  "invoices",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "string",
    }).defaultNow(),
    dueDate: timestamp("due_date", { withTimezone: true, mode: "string" }),
    invoiceNumber: text("invoice_number"),
    customerId: uuid("customer_id"),
    amount: numericCasted({ precision: 10, scale: 2 }),
    currency: text(),
    lineItems: jsonb("line_items"),
    paymentDetails: jsonb("payment_details"),
    customerDetails: jsonb("customer_details"),
    companyDatails: jsonb("company_datails"),
    note: text(),
    internalNote: text("internal_note"),
    teamId: uuid("team_id").notNull(),
    paidAt: timestamp("paid_at", { withTimezone: true, mode: "string" }),
    fts: tsvector("fts")
      .notNull()
      .generatedAlwaysAs(
        (): SQL => sql`
        to_tsvector(
          'english',
          (
            (COALESCE((amount)::text, ''::text) || ' '::text) || COALESCE(invoice_number, ''::text)
          )
        )
      `,
      ),
    vat: numericCasted({ precision: 10, scale: 2 }),
    tax: numericCasted({ precision: 10, scale: 2 }),
    url: text(),
    filePath: text("file_path").array(),
    status: invoiceStatusEnum().default("draft").notNull(),
    viewedAt: timestamp("viewed_at", { withTimezone: true, mode: "string" }),
    fromDetails: jsonb("from_details"),
    issueDate: timestamp("issue_date", { withTimezone: true, mode: "string" }),
    template: jsonb(),
    noteDetails: jsonb("note_details"),
    customerName: text("customer_name"),
    token: text().default("").notNull(),
    sentTo: text("sent_to"),
    reminderSentAt: timestamp("reminder_sent_at", {
      withTimezone: true,
      mode: "string",
    }),
    discount: numericCasted({ precision: 10, scale: 2 }),
    fileSize: bigint("file_size", { mode: "number" }),
    userId: uuid("user_id"),
    subtotal: numericCasted({ precision: 10, scale: 2 }),
    topBlock: jsonb("top_block"),
    bottomBlock: jsonb("bottom_block"),
    sentAt: timestamp("sent_at", { withTimezone: true, mode: "string" }),
    scheduledAt: timestamp("scheduled_at", {
      withTimezone: true,
      mode: "string",
    }),
    scheduledJobId: text("scheduled_job_id"),
  },
  (table) => [
    index("invoices_created_at_idx").using(
      "btree",
      table.createdAt.asc().nullsLast().op("timestamptz_ops"),
    ),
    index("invoices_fts").using(
      "gin",
      table.fts.asc().nullsLast().op("tsvector_ops"),
    ),
    index("invoices_team_id_idx").using(
      "btree",
      table.teamId.asc().nullsLast().op("uuid_ops"),
    ),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: "invoices_created_by_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.customerId],
      foreignColumns: [customers.id],
      name: "invoices_customer_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.teamId],
      foreignColumns: [teams.id],
      name: "invoices_team_id_fkey",
    }).onDelete("cascade"),
    unique("invoices_scheduled_job_id_key").on(table.scheduledJobId),
    pgPolicy("Invoices can be handled by a member of the team", {
      as: "permissive",
      for: "all",
      to: ["public"],
      using: sql`(team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user))`,
    }),
  ],
);

export const customers = pgTable(
  "customers",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    name: text().notNull(),
    email: text().notNull(),
    billingEmail: text(),
    country: text(),
    addressLine1: text("address_line_1"),
    addressLine2: text("address_line_2"),
    city: text(),
    state: text(),
    zip: text(),
    note: text(),
    teamId: uuid("team_id").defaultRandom().notNull(),
    website: text(),
    phone: text(),
    vatNumber: text("vat_number"),
    countryCode: text("country_code"),
    token: text().default("").notNull(),
    contact: text(),
    fts: tsvector("fts")
      .notNull()
      .generatedAlwaysAs(
        (): SQL => sql`
				to_tsvector(
					'english'::regconfig,
					COALESCE(name, ''::text) || ' ' ||
					COALESCE(contact, ''::text) || ' ' ||
					COALESCE(phone, ''::text) || ' ' ||
					COALESCE(email, ''::text) || ' ' ||
					COALESCE(address_line_1, ''::text) || ' ' ||
					COALESCE(address_line_2, ''::text) || ' ' ||
					COALESCE(city, ''::text) || ' ' ||
					COALESCE(state, ''::text) || ' ' ||
					COALESCE(zip, ''::text) || ' ' ||
					COALESCE(country, ''::text)
				)
			`,
      ),
  },
  (table) => [
    index("customers_fts").using(
      "gin",
      table.fts.asc().nullsLast().op("tsvector_ops"),
    ),
    foreignKey({
      columns: [table.teamId],
      foreignColumns: [teams.id],
      name: "customers_team_id_fkey",
    }).onDelete("cascade"),
    pgPolicy("Customers can be handled by members of the team", {
      as: "permissive",
      for: "all",
      to: ["public"],
      using: sql`(team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user))`,
    }),
  ],
);

export const exchangeRates = pgTable(
  "exchange_rates",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    base: text(),
    rate: numericCasted({ precision: 10, scale: 2 }),
    target: text(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }),
  },
  (table) => [
    index("exchange_rates_base_target_idx").using(
      "btree",
      table.base.asc().nullsLast().op("text_ops"),
      table.target.asc().nullsLast().op("text_ops"),
    ),
    unique("unique_rate").on(table.base, table.target),
    pgPolicy("Enable read access for authenticated users", {
      as: "permissive",
      for: "select",
      to: ["public"],
      using: sql`true`,
    }),
  ],
);

export const tags = pgTable(
  "tags",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    teamId: uuid("team_id").notNull(),
    name: text().notNull(),
  },
  (table) => [
    index("tags_team_id_idx").using(
      "btree",
      table.teamId.asc().nullsLast().op("uuid_ops"),
    ),
    foreignKey({
      columns: [table.teamId],
      foreignColumns: [teams.id],
      name: "tags_team_id_fkey",
    }).onDelete("cascade"),
    unique("unique_tag_name").on(table.teamId, table.name),
    pgPolicy("Tags can be handled by a member of the team", {
      as: "permissive",
      for: "all",
      to: ["public"],
      using: sql`(team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user))`,
    }),
  ],
);

export const trackerReports = pgTable(
  "tracker_reports",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    linkId: text("link_id"),
    shortLink: text("short_link"),
    teamId: uuid("team_id").defaultRandom(),
    projectId: uuid("project_id").defaultRandom(),
    createdBy: uuid("created_by"),
  },
  (table) => [
    index("tracker_reports_team_id_idx").using(
      "btree",
      table.teamId.asc().nullsLast().op("uuid_ops"),
    ),
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [users.id],
      name: "public_tracker_reports_created_by_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [trackerProjects.id],
      name: "public_tracker_reports_project_id_fkey",
    })
      .onUpdate("cascade")
      .onDelete("cascade"),
    foreignKey({
      columns: [table.teamId],
      foreignColumns: [teams.id],
      name: "tracker_reports_team_id_fkey",
    })
      .onUpdate("cascade")
      .onDelete("cascade"),
    pgPolicy("Reports can be handled by a member of the team", {
      as: "permissive",
      for: "all",
      to: ["public"],
      using: sql`(team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user))`,
    }),
  ],
);

export const invoiceComments = pgTable("invoice_comments", {
  id: uuid().defaultRandom().primaryKey().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
});

export const trackerProjectTags = pgTable(
  "tracker_project_tags",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    trackerProjectId: uuid("tracker_project_id").notNull(),
    tagId: uuid("tag_id").notNull(),
    teamId: uuid("team_id").notNull(),
  },
  (table) => [
    index("tracker_project_tags_team_id_idx").using(
      "btree",
      table.teamId.asc().nullsLast().op("uuid_ops"),
    ),
    index("tracker_project_tags_tracker_project_id_tag_id_team_id_idx").using(
      "btree",
      table.trackerProjectId.asc().nullsLast().op("uuid_ops"),
      table.tagId.asc().nullsLast().op("uuid_ops"),
      table.teamId.asc().nullsLast().op("uuid_ops"),
    ),
    foreignKey({
      columns: [table.tagId],
      foreignColumns: [tags.id],
      name: "project_tags_tag_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.trackerProjectId],
      foreignColumns: [trackerProjects.id],
      name: "project_tags_tracker_project_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.teamId],
      foreignColumns: [teams.id],
      name: "tracker_project_tags_team_id_fkey",
    }).onDelete("cascade"),
    unique("unique_project_tag").on(table.trackerProjectId, table.tagId),
    pgPolicy("Tags can be handled by a member of the team", {
      as: "permissive",
      for: "all",
      to: ["public"],
      using: sql`(team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user))`,
    }),
  ],
);

export const reports = pgTable(
  "reports",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    linkId: text("link_id"),
    teamId: uuid("team_id"),
    shortLink: text("short_link"),
    from: timestamp({ withTimezone: true, mode: "string" }),
    to: timestamp({ withTimezone: true, mode: "string" }),
    type: reportTypesEnum(),
    expireAt: timestamp("expire_at", { withTimezone: true, mode: "string" }),
    currency: text(),
    createdBy: uuid("created_by"),
  },
  (table) => [
    index("reports_team_id_idx").using(
      "btree",
      table.teamId.asc().nullsLast().op("uuid_ops"),
    ),
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [users.id],
      name: "public_reports_created_by_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.teamId],
      foreignColumns: [teams.id],
      name: "reports_team_id_fkey",
    }).onDelete("cascade"),
    pgPolicy("Reports can be created by a member of the team", {
      as: "permissive",
      for: "insert",
      to: ["public"],
      withCheck: sql`(team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user))`,
    }),
    pgPolicy("Reports can be deleted by a member of the team", {
      as: "permissive",
      for: "delete",
      to: ["public"],
    }),
    pgPolicy("Reports can be selected by a member of the team", {
      as: "permissive",
      for: "select",
      to: ["public"],
    }),
    pgPolicy("Reports can be updated by member of team", {
      as: "permissive",
      for: "update",
      to: ["public"],
    }),
  ],
);

export const bankConnections = pgTable(
  "bank_connections",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    institutionId: text("institution_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }),
    teamId: uuid("team_id").notNull(),
    name: text().notNull(),
    logoUrl: text("logo_url"),
    accessToken: text("access_token"),
    enrollmentId: text("enrollment_id"),
    provider: bankProvidersEnum().notNull(),
    lastAccessed: timestamp("last_accessed", {
      withTimezone: true,
      mode: "string",
    }),
    referenceId: text("reference_id"),
    status: connectionStatusEnum().default("connected"),
    errorDetails: text("error_details"),
    errorRetries: smallint("error_retries").default(sql`'0'`),
  },
  (table) => [
    index("bank_connections_team_id_idx").using(
      "btree",
      table.teamId.asc().nullsLast().op("uuid_ops"),
    ),
    foreignKey({
      columns: [table.teamId],
      foreignColumns: [teams.id],
      name: "bank_connections_team_id_fkey",
    }).onDelete("cascade"),
    unique("unique_bank_connections").on(table.institutionId, table.teamId),
    pgPolicy("Bank Connections can be created by a member of the team", {
      as: "permissive",
      for: "insert",
      to: ["public"],
      withCheck: sql`(team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user))`,
    }),
    pgPolicy("Bank Connections can be deleted by a member of the team", {
      as: "permissive",
      for: "delete",
      to: ["public"],
    }),
    pgPolicy("Bank Connections can be selected by a member of the team", {
      as: "permissive",
      for: "select",
      to: ["public"],
    }),
    pgPolicy("Bank Connections can be updated by a member of the team", {
      as: "permissive",
      for: "update",
      to: ["public"],
    }),
  ],
);

export const userInvites = pgTable(
  "user_invites",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    teamId: uuid("team_id"),
    email: text(),
    role: teamRolesEnum(),
    code: text().default(sql`gen_random_uuid()::text`),
    invitedBy: uuid("invited_by"),
    status: text().default("pending").notNull(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "date",
    })
      .default(sql`now() + interval '2 days'`)
      .notNull(),
  },
  (table) => [
    index("user_invites_team_id_idx").using(
      "btree",
      table.teamId.asc().nullsLast().op("uuid_ops"),
    ),
    foreignKey({
      columns: [table.teamId],
      foreignColumns: [teams.id],
      name: "public_user_invites_team_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.invitedBy],
      foreignColumns: [users.id],
      name: "user_invites_invited_by_fkey",
    }).onDelete("cascade"),
    unique("unique_team_invite").on(table.teamId, table.email),
    unique("user_invites_code_key").on(table.code),
    pgPolicy("Enable select for users based on email", {
      as: "permissive",
      for: "select",
      to: ["public"],
      using: sql`((auth.jwt() ->> 'email'::text) = email)`,
    }),
    pgPolicy("User Invites can be created by a member of the team", {
      as: "permissive",
      for: "insert",
      to: ["public"],
    }),
    pgPolicy("User Invites can be deleted by a member of the team", {
      as: "permissive",
      for: "delete",
      to: ["public"],
    }),
    pgPolicy("User Invites can be deleted by invited email", {
      as: "permissive",
      for: "delete",
      to: ["public"],
    }),
    pgPolicy("User Invites can be selected by a member of the team", {
      as: "permissive",
      for: "select",
      to: ["public"],
    }),
    pgPolicy("User Invites can be updated by a member of the team", {
      as: "permissive",
      for: "update",
      to: ["public"],
    }),
  ],
);

export const documentTags = pgTable(
  "document_tags",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    name: text().notNull(),
    slug: text().notNull(),
    teamId: uuid("team_id").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.teamId],
      foreignColumns: [teams.id],
      name: "document_tags_team_id_fkey",
    }).onDelete("cascade"),
    unique("unique_slug_per_team").on(table.slug, table.teamId),
    pgPolicy("Tags can be handled by a member of the team", {
      as: "permissive",
      for: "all",
      to: ["public"],
      using: sql`(team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user))`,
    }),
  ],
);

export const transactionTags = pgTable(
  "transaction_tags",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    teamId: uuid("team_id").notNull(),
    tagId: uuid("tag_id").notNull(),
    transactionId: uuid("transaction_id").notNull(),
  },
  (table) => [
    index("transaction_tags_tag_id_idx").using(
      "btree",
      table.tagId.asc().nullsLast().op("uuid_ops"),
    ),
    index("transaction_tags_team_id_idx").using(
      "btree",
      table.teamId.asc().nullsLast().op("uuid_ops"),
    ),
    index("transaction_tags_transaction_id_tag_id_team_id_idx").using(
      "btree",
      table.transactionId.asc().nullsLast().op("uuid_ops"),
      table.tagId.asc().nullsLast().op("uuid_ops"),
      table.teamId.asc().nullsLast().op("uuid_ops"),
    ),
    foreignKey({
      columns: [table.tagId],
      foreignColumns: [tags.id],
      name: "transaction_tags_tag_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.teamId],
      foreignColumns: [teams.id],
      name: "transaction_tags_team_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.transactionId],
      foreignColumns: [transactions.id],
      name: "transaction_tags_transaction_id_fkey",
    }).onDelete("cascade"),
    unique("unique_tag").on(table.tagId, table.transactionId),
    pgPolicy("Transaction Tags can be handled by a member of the team", {
      as: "permissive",
      for: "all",
      to: ["public"],
      using: sql`(team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user))`,
    }),
  ],
);

export const transactionAttachments = pgTable(
  "transaction_attachments",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    type: text(),
    transactionId: uuid("transaction_id"),
    teamId: uuid("team_id"),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    size: bigint({ mode: "number" }),
    name: text(),
    path: text().array(),
  },
  (table) => [
    index("transaction_attachments_team_id_idx").using(
      "btree",
      table.teamId.asc().nullsLast().op("uuid_ops"),
    ),
    index("transaction_attachments_transaction_id_idx").using(
      "btree",
      table.transactionId.asc().nullsLast().op("uuid_ops"),
    ),
    foreignKey({
      columns: [table.teamId],
      foreignColumns: [teams.id],
      name: "public_transaction_attachments_team_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.transactionId],
      foreignColumns: [transactions.id],
      name: "public_transaction_attachments_transaction_id_fkey",
    }).onDelete("set null"),
    pgPolicy("Transaction Attachments can be created by a member of the team", {
      as: "permissive",
      for: "insert",
      to: ["public"],
      withCheck: sql`(team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user))`,
    }),
    pgPolicy("Transaction Attachments can be deleted by a member of the team", {
      as: "permissive",
      for: "delete",
      to: ["public"],
    }),
    pgPolicy(
      "Transaction Attachments can be selected by a member of the team",
      { as: "permissive", for: "select", to: ["public"] },
    ),
    pgPolicy("Transaction Attachments can be updated by a member of the team", {
      as: "permissive",
      for: "update",
      to: ["public"],
    }),
  ],
);

export const teams = pgTable(
  "teams",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    name: text(),
    slug: text().default(sql`gen_random_uuid()::text`).notNull(),
    logoUrl: text("logo_url"),
    metadata: text(),
    inboxId: text("inbox_id").default(
      sql`substr(replace(gen_random_uuid()::text, '-', ''), 1, 10)`,
    ),
    email: text(),
    inboxEmail: text("inbox_email"),
    inboxForwarding: boolean("inbox_forwarding").default(true),
    baseCurrency: text("base_currency"),
    countryCode: text("country_code"),
    documentClassification: boolean("document_classification").default(false),
    flags: text().array(),
    canceledAt: timestamp("canceled_at", {
      withTimezone: true,
      mode: "string",
    }),
    plan: plansEnum().default("trial").notNull(),
    // subscriptionStatus: subscriptionStatusEnum("subscription_status"),
    exportSettings: jsonb("export_settings"),
  },
  (table) => [
    unique("teams_slug_key").on(table.slug),
    unique("teams_inbox_id_key").on(table.inboxId),
    pgPolicy("Enable insert for authenticated users only", {
      as: "permissive",
      for: "insert",
      to: ["authenticated"],
      withCheck: sql`true`,
    }),
    pgPolicy("Invited users can select team if they are invited.", {
      as: "permissive",
      for: "select",
      to: ["public"],
    }),
    pgPolicy("Teams can be deleted by a member of the team", {
      as: "permissive",
      for: "delete",
      to: ["public"],
    }),
    pgPolicy("Teams can be selected by a member of the team", {
      as: "permissive",
      for: "select",
      to: ["public"],
    }),
    pgPolicy("Teams can be updated by a member of the team", {
      as: "permissive",
      for: "update",
      to: ["public"],
    }),
  ],
);

export const userQuestions = pgTable(
  "user_questions",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    questionKey: text("question_key").notNull(),
    teamId: uuid("team_id").notNull(),
    version: integer().notNull(),
    label: text().notNull(),
    question: text().notNull(),
    type: invoiceQuestionTypeEnum().notNull(),
    options: jsonb().$type<string[]>(),
    // A number question's unit and range: { unit, unitLabel, min, max }.
    numberFormat: jsonb("number_format").$type<{
      unit: "currency" | "percent" | "days" | "count" | "other";
      unitLabel?: string | null;
      min?: number | null;
      max?: number | null;
    }>(),
    context: text(),
    enabled: boolean().default(true).notNull(),
    isDefault: boolean("is_default").default(false).notNull(),
    deletedAt: timestamp("deleted_at", {
      withTimezone: true,
      mode: "string",
    }),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("user_questions_team_id_idx").on(table.teamId),
    unique("user_questions_team_key_version_key").on(
      table.teamId,
      table.questionKey,
      table.version,
    ),
    foreignKey({
      columns: [table.teamId],
      foreignColumns: [teams.id],
      name: "user_questions_team_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [users.id],
      name: "user_questions_created_by_fkey",
    }).onDelete("set null"),
  ],
);

export const workflowJobs = pgTable(
  "workflow_jobs",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    name: text().notNull(),
    teamId: uuid("team_id"),
    payload: jsonb().$type<Record<string, unknown>>().notNull(),
    status: workflowStatusEnum().default("queued").notNull(),
    attempts: integer().default(0).notNull(),
    maxAttempts: integer("max_attempts").default(3).notNull(),
    runAt: timestamp("run_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    lockedBy: text("locked_by"),
    lockedAt: timestamp("locked_at", {
      withTimezone: true,
      mode: "string",
    }),
    heartbeatAt: timestamp("heartbeat_at", {
      withTimezone: true,
      mode: "string",
    }),
    leaseExpiresAt: timestamp("lease_expires_at", {
      withTimezone: true,
      mode: "string",
    }),
    finishedAt: timestamp("finished_at", {
      withTimezone: true,
      mode: "string",
    }),
    result: jsonb().$type<Record<string, unknown>>(),
    lastError: text("last_error"),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.teamId],
      foreignColumns: [teams.id],
      name: "workflow_jobs_team_id_fkey",
    }).onDelete("cascade"),
    unique("workflow_jobs_idempotency_key").on(
      table.name,
      table.idempotencyKey,
    ),
    index("workflow_jobs_due_idx").on(table.status, table.runAt),
    index("workflow_jobs_team_id_idx").on(table.teamId),
    // The links an invoice's activity trace follows (invoiceJobsQuery).
    index("workflow_jobs_team_inbox_id_idx")
      .on(table.teamId, sql`(${table.payload} ->> 'inboxId')`)
      .where(sql`(${table.payload} ->> 'inboxId') is not null`),
    index("workflow_jobs_team_invoice_id_idx")
      .on(table.teamId, sql`(${table.payload} ->> 'invoiceId')`)
      .where(sql`(${table.payload} ->> 'invoiceId') is not null`),
    index("workflow_jobs_team_delivery_id_idx")
      .on(table.teamId, sql`(${table.payload} ->> 'deliveryId')`)
      .where(sql`(${table.payload} ->> 'deliveryId') is not null`),
    index("workflow_jobs_team_correction_id_idx")
      .on(table.teamId, sql`(${table.payload} ->> 'correctionId')`)
      .where(sql`(${table.payload} ->> 'correctionId') is not null`),
  ],
);

/**
 * Hourly totals of outbound provider calls (TypeSafe, Nango), written by the
 * workflow runner after each call. Holds counts, tokens and timings only,
 * never request or response content. Read by the operator metrics endpoint
 * and by the daily provider budget that pauses extraction when spent.
 */
export const providerUsage = pgTable(
  "provider_usage",
  {
    hour: timestamp({ withTimezone: true, mode: "string" }).notNull(),
    provider: text().notNull(),
    operation: text().notNull(),
    calls: integer().default(0).notNull(),
    failures: integer().default(0).notNull(),
    throttled: integer().default(0).notNull(),
    inputTokens: bigint("input_tokens", { mode: "number" })
      .default(0)
      .notNull(),
    outputTokens: bigint("output_tokens", { mode: "number" })
      .default(0)
      .notNull(),
    totalMs: bigint("total_ms", { mode: "number" }).default(0).notNull(),
    maxMs: integer("max_ms").default(0).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.hour, table.provider, table.operation],
      name: "provider_usage_pkey",
    }),
  ],
);

/**
 * A provider connection captured when its workspace was deleted, so cleanup
 * can still revoke it after the workspace's own rows are gone. A mailbox keeps
 * only the encrypted refresh token, and only until it has been revoked.
 */
export type DeletionConnection =
  | {
      kind: "accounting";
      provider: "xero" | "quickbooks";
      connectionId: string;
      integrationId: string;
      revokedAt?: string;
    }
  | {
      kind: "mailbox";
      provider: "gmail" | "outlook";
      accountId: string;
      refreshToken: string | null;
      revokedAt?: string;
    };

/**
 * Durable record of an account or workspace deletion.
 *
 * The subject's database rows are removed when the request is accepted; this
 * row carries what cleanup still has to do outside the database (provider
 * connections and private objects), its progress and its last error. It has no
 * foreign key to the subject, so it survives the deletion it describes.
 */
export const deletionRequests = pgTable(
  "deletion_requests",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    subject: deletionSubjectEnum().notNull(),
    subjectId: uuid("subject_id").notNull(),
    requestedBy: uuid("requested_by"),
    status: deletionStatusEnum().default("pending").notNull(),
    connections: jsonb()
      .$type<DeletionConnection[]>()
      .default(sql`'[]'::jsonb`)
      .notNull(),
    quiesceUntil: timestamp("quiesce_until", {
      withTimezone: true,
      mode: "string",
    })
      .defaultNow()
      .notNull(),
    connectionsRevokedAt: timestamp("connections_revoked_at", {
      withTimezone: true,
      mode: "string",
    }),
    storagePurgedAt: timestamp("storage_purged_at", {
      withTimezone: true,
      mode: "string",
    }),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "string",
    }),
    attempts: integer().default(0).notNull(),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("deletion_requests_subject_key").on(table.subject, table.subjectId),
    index("deletion_requests_status_idx").on(table.status),
  ],
);

/** Counts recorded on a finished export, shown to the owner. */
export type DataExportSummary = {
  invoices: number;
  documents: number;
  missingDocuments: number;
  suppliers: number;
  /** Absent on exports built before authorization sources existed. */
  authorizationSources?: number;
  judgments: number;
  auditEvents: number;
};

/**
 * An owner's request for a portable copy of the workspace.
 *
 * The archive is built by the `build-data-export` workflow into the
 * workspace's private storage prefix and removed when the request expires, so
 * the row outlives its archive but never the workspace: deleting the
 * workspace removes the row, its queued work and (through the workspace
 * purge) the archive.
 */
export const dataExports = pgTable(
  "data_exports",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    teamId: uuid("team_id").notNull(),
    requestedBy: uuid("requested_by"),
    status: dataExportStatusEnum().default("queued").notNull(),
    /** Documents written so far and in total while the archive is built. */
    progress: jsonb()
      .$type<{ documentsWritten: number; documentsTotal: number }>()
      .default(sql`'{"documentsWritten":0,"documentsTotal":0}'::jsonb`)
      .notNull(),
    summary: jsonb().$type<DataExportSummary>(),
    filePath: text("file_path").array(),
    fileName: text("file_name"),
    size: bigint({ mode: "number" }),
    sha256: text(),
    attempts: integer().default(0).notNull(),
    /** Safe to show the owner; internal detail stays in the logs. */
    error: text(),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "string",
    }),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }),
    expiredAt: timestamp("expired_at", { withTimezone: true, mode: "string" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("data_exports_team_id_idx").on(table.teamId, table.createdAt),
    index("data_exports_status_idx").on(table.status),
    foreignKey({
      columns: [table.teamId],
      foreignColumns: [teams.id],
      name: "data_exports_team_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.requestedBy],
      foreignColumns: [users.id],
      name: "data_exports_requested_by_fkey",
    }).onDelete("set null"),
  ],
);

export const documents = pgTable(
  "documents",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    name: text(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "string",
    }).defaultNow(),
    metadata: jsonb(),
    pathTokens: text("path_tokens").array(),
    teamId: uuid("team_id"),
    parentId: text("parent_id"),
    objectId: uuid("object_id"),
    ownerId: uuid("owner_id"),
    tag: text(),
    title: text(),
    body: text(),
    fts: tsvector("fts")
      .notNull()
      .generatedAlwaysAs(
        (): SQL =>
          sql`to_tsvector('english'::regconfig, ((title || ' '::text) || body))`,
      ),
    summary: text(),
    content: text(),
    date: date(),
    language: text(),
    processingStatus:
      documentProcessingStatusEnum("processing_status").default("pending"),
    ftsSimple: tsvector("fts_simple"),
    ftsEnglish: tsvector("fts_english"),
    ftsLanguage: tsvector("fts_language"),
  },
  (table) => [
    index("documents_name_idx").using(
      "btree",
      table.name.asc().nullsLast().op("text_ops"),
    ),
    index("documents_team_id_idx").using(
      "btree",
      table.teamId.asc().nullsLast().op("uuid_ops"),
    ),
    index("documents_team_id_parent_id_idx").using(
      "btree",
      table.teamId.asc().nullsLast().op("uuid_ops"),
      table.parentId.asc().nullsLast().op("text_ops"),
    ),
    index("idx_documents_fts_english").using(
      "gin",
      table.ftsEnglish.asc().nullsLast().op("tsvector_ops"),
    ),
    index("idx_documents_fts_language").using(
      "gin",
      table.ftsLanguage.asc().nullsLast().op("tsvector_ops"),
    ),
    index("idx_documents_fts_simple").using(
      "gin",
      table.ftsSimple.asc().nullsLast().op("tsvector_ops"),
    ),
    index("idx_gin_documents_title").using(
      "gin",
      table.title.asc().nullsLast().op("gin_trgm_ops"),
    ),
    index("idx_gin_documents_name").using(
      "gin",
      table.name.asc().nullsLast().op("gin_trgm_ops"),
    ),
    foreignKey({
      columns: [table.ownerId],
      foreignColumns: [users.id],
      name: "documents_created_by_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.teamId],
      foreignColumns: [teams.id],
      name: "storage_team_id_fkey",
    }).onDelete("cascade"),
    pgPolicy("Documents can be deleted by a member of the team", {
      as: "permissive",
      for: "all",
      to: ["public"],
      using: sql`(team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user))`,
    }),
    pgPolicy("Documents can be selected by a member of the team", {
      as: "permissive",
      for: "all",
      to: ["public"],
    }),
    pgPolicy("Documents can be updated by a member of the team", {
      as: "permissive",
      for: "update",
      to: ["public"],
    }),
    pgPolicy("Enable insert for authenticated users only", {
      as: "permissive",
      for: "insert",
      to: ["authenticated"],
    }),
  ],
);

export const apps = pgTable(
  "apps",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    teamId: uuid("team_id").defaultRandom(),
    config: jsonb(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "string",
    }).defaultNow(),
    appId: text("app_id").notNull(),
    createdBy: uuid("created_by").defaultRandom(),
    settings: jsonb(),
  },
  (table) => [
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [users.id],
      name: "apps_created_by_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.teamId],
      foreignColumns: [teams.id],
      name: "integrations_team_id_fkey",
    }).onDelete("cascade"),
    unique("unique_app_id_team_id").on(table.teamId, table.appId),
    pgPolicy("Apps can be deleted by a member of the team", {
      as: "permissive",
      for: "delete",
      to: ["public"],
      using: sql`(team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user))`,
    }),
    pgPolicy("Apps can be inserted by a member of the team", {
      as: "permissive",
      for: "insert",
      to: ["public"],
    }),
    pgPolicy("Apps can be selected by a member of the team", {
      as: "permissive",
      for: "select",
      to: ["public"],
    }),
    pgPolicy("Apps can be updated by a member of the team", {
      as: "permissive",
      for: "update",
      to: ["public"],
    }),
  ],
);

export const invoiceTemplates = pgTable(
  "invoice_templates",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    teamId: uuid("team_id").notNull(),
    customerLabel: text("customer_label"),
    fromLabel: text("from_label"),
    invoiceNoLabel: text("invoice_no_label"),
    issueDateLabel: text("issue_date_label"),
    dueDateLabel: text("due_date_label"),
    descriptionLabel: text("description_label"),
    priceLabel: text("price_label"),
    quantityLabel: text("quantity_label"),
    totalLabel: text("total_label"),
    vatLabel: text("vat_label"),
    taxLabel: text("tax_label"),
    paymentLabel: text("payment_label"),
    noteLabel: text("note_label"),
    logoUrl: text("logo_url"),
    currency: text(),
    paymentDetails: jsonb("payment_details"),
    fromDetails: jsonb("from_details"),
    noteDetails: jsonb("note_details"),
    size: invoiceSizeEnum().default("a4"),
    dateFormat: text("date_format"),
    includeVat: boolean("include_vat"),
    includeTax: boolean("include_tax"),
    taxRate: numericCasted("tax_rate", { precision: 10, scale: 2 }),
    deliveryType: invoiceDeliveryTypeEnum("delivery_type")
      .default("create")
      .notNull(),
    discountLabel: text("discount_label"),
    includeDiscount: boolean("include_discount"),
    includeDecimals: boolean("include_decimals"),
    includeQr: boolean("include_qr"),
    totalSummaryLabel: text("total_summary_label"),
    title: text(),
    vatRate: numericCasted("vat_rate", { precision: 10, scale: 2 }),
    includeUnits: boolean("include_units"),
    subtotalLabel: text("subtotal_label"),
    includePdf: boolean("include_pdf"),
    sendCopy: boolean("send_copy"),
  },
  (table) => [
    foreignKey({
      columns: [table.teamId],
      foreignColumns: [teams.id],
      name: "invoice_settings_team_id_fkey",
    }).onDelete("cascade"),
    unique("invoice_templates_team_id_key").on(table.teamId),
    pgPolicy("Invoice templates can be handled by a member of the team", {
      as: "permissive",
      for: "all",
      to: ["public"],
      using: sql`(team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user))`,
    }),
  ],
);

export const invoiceProducts = pgTable(
  "invoice_products",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "string",
    }).defaultNow(),
    teamId: uuid("team_id").notNull(),
    createdBy: uuid("created_by"),
    name: text().notNull(),
    description: text(),
    price: numericCasted({ precision: 10, scale: 2 }),
    currency: text(),
    unit: text(),
    isActive: boolean().default(true).notNull(),
    usageCount: integer("usage_count").default(0).notNull(),
    lastUsedAt: timestamp("last_used_at", {
      withTimezone: true,
      mode: "string",
    }),
    // Full-text search for product names and descriptions
    fts: tsvector("fts")
      .notNull()
      .generatedAlwaysAs(
        (): SQL => sql`
          to_tsvector(
            'english',
            (
              (COALESCE(name, ''::text) || ' '::text) || COALESCE(description, ''::text)
            )
          )
        `,
      ),
  },
  (table) => [
    foreignKey({
      columns: [table.teamId],
      foreignColumns: [teams.id],
      name: "invoice_products_team_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [users.id],
      name: "invoice_products_created_by_fkey",
    }).onDelete("set null"),
    index("invoice_products_team_id_idx").on(table.teamId),
    index("invoice_products_created_by_idx").on(table.createdBy),
    index("invoice_products_fts_idx").using("gin", table.fts),
    index("invoice_products_name_idx").on(table.name),
    index("invoice_products_usage_count_idx").on(table.usageCount),
    index("invoice_products_last_used_at_idx").on(table.lastUsedAt),
    // Composite index for team + active status for fast filtering
    index("invoice_products_team_active_idx").on(table.teamId, table.isActive),
    // Unique constraint for upsert operations (team + name + currency + price combination)
    unique("invoice_products_team_name_currency_price_unique").on(
      table.teamId,
      table.name,
      table.currency,
      table.price,
    ),
    pgPolicy("Enable read access for team members", {
      as: "permissive",
      for: "select",
      to: ["public"],
      using: sql`team_id = (select auth.jwt() ->> 'team_id')::uuid`,
    }),
    pgPolicy("Enable insert access for team members", {
      as: "permissive",
      for: "insert",
      to: ["public"],
      withCheck: sql`team_id = (select auth.jwt() ->> 'team_id')::uuid`,
    }),
    pgPolicy("Enable update access for team members", {
      as: "permissive",
      for: "update",
      to: ["public"],
      using: sql`team_id = (select auth.jwt() ->> 'team_id')::uuid`,
    }),
    pgPolicy("Enable delete access for team members", {
      as: "permissive",
      for: "delete",
      to: ["public"],
      using: sql`team_id = (select auth.jwt() ->> 'team_id')::uuid`,
    }),
  ],
);

export const transactionEnrichments = pgTable(
  "transaction_enrichments",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    name: text(),
    teamId: uuid("team_id"),
    categorySlug: text("category_slug"),
    system: boolean().default(false),
  },
  (table) => [
    index("transaction_enrichments_category_slug_team_id_idx").using(
      "btree",
      table.categorySlug.asc().nullsLast().op("text_ops"),
      table.teamId.asc().nullsLast().op("uuid_ops"),
    ),
    foreignKey({
      columns: [table.teamId, table.categorySlug],
      foreignColumns: [
        transactionCategories.teamId,
        transactionCategories.slug,
      ],
      name: "transaction_enrichments_category_slug_team_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.teamId],
      foreignColumns: [teams.id],
      name: "transaction_enrichments_team_id_fkey",
    }).onDelete("cascade"),
    unique("unique_team_name").on(table.name, table.teamId),
    pgPolicy("Enable insert for authenticated users only", {
      as: "permissive",
      for: "insert",
      to: ["authenticated"],
      withCheck: sql`true`,
    }),
    pgPolicy("Enable update for authenticated users only", {
      as: "permissive",
      for: "update",
      to: ["authenticated"],
    }),
  ],
);

export const users = pgTable(
  "users",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    fullName: text("full_name"),
    avatarUrl: text("avatar_url"),
    email: text(),
    emailVerified: boolean("email_verified").default(false).notNull(),
    teamId: uuid("team_id"),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "string",
    }).defaultNow(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "date",
    })
      .defaultNow()
      .notNull(),
    locale: text().default("en"),
    weekStartsOnMonday: boolean("week_starts_on_monday").default(false),
    timezone: text(),
    timezoneAutoSync: boolean("timezone_auto_sync").default(true),
    timeFormat: numericCasted("time_format").default(24),
    // UK day-first for new accounts; the dashboard falls back to the same.
    dateFormat: text("date_format").default("dd/MM/yyyy"),
    // Better Auth two-factor plugin: set only once an authenticator code has
    // been verified, cleared when the second factor is disabled or reset.
    twoFactorEnabled: boolean("two_factor_enabled").default(false).notNull(),
  },
  (table) => [
    uniqueIndex("users_email_key").on(table.email),
    index("users_team_id_idx").using(
      "btree",
      table.teamId.asc().nullsLast().op("uuid_ops"),
    ),
    foreignKey({
      columns: [table.id],
      foreignColumns: [table.id],
      name: "users_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.teamId],
      foreignColumns: [teams.id],
      name: "users_team_id_fkey",
    }).onDelete("set null"),
    pgPolicy("Users can insert their own profile.", {
      as: "permissive",
      for: "insert",
      to: ["public"],
      withCheck: sql`(auth.uid() = id)`,
    }),
    pgPolicy("Users can select their own profile.", {
      as: "permissive",
      for: "select",
      to: ["public"],
    }),
    pgPolicy("Users can select users if they are in the same team", {
      as: "permissive",
      for: "select",
      to: ["authenticated"],
    }),
    pgPolicy("Users can update own profile.", {
      as: "permissive",
      for: "update",
      to: ["public"],
    }),
  ],
);

export const trackerProjects = pgTable(
  "tracker_projects",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    teamId: uuid("team_id"),
    rate: numericCasted({ precision: 10, scale: 2 }),
    currency: text(),
    status: trackerStatusEnum().default("in_progress").notNull(),
    description: text(),
    name: text().notNull(),
    billable: boolean().default(false),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    estimate: bigint({ mode: "number" }),
    customerId: uuid("customer_id"),
    fts: tsvector("fts")
      .notNull()
      .generatedAlwaysAs(
        (): SQL => sql`
          to_tsvector(
            'english'::regconfig,
            (
              (COALESCE(name, ''::text) || ' '::text) || COALESCE(description, ''::text)
            )
          )
        `,
      ),
  },
  (table) => [
    index("tracker_projects_fts").using(
      "gin",
      table.fts.asc().nullsLast().op("tsvector_ops"),
    ),
    index("tracker_projects_team_id_idx").using(
      "btree",
      table.teamId.asc().nullsLast().op("uuid_ops"),
    ),
    foreignKey({
      columns: [table.customerId],
      foreignColumns: [customers.id],
      name: "tracker_projects_customer_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.teamId],
      foreignColumns: [teams.id],
      name: "tracker_projects_team_id_fkey",
    }).onDelete("cascade"),
    pgPolicy("Projects can be created by a member of the team", {
      as: "permissive",
      for: "insert",
      to: ["authenticated"],
      withCheck: sql`(team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user))`,
    }),
    pgPolicy("Projects can be deleted by a member of the team", {
      as: "permissive",
      for: "delete",
      to: ["authenticated"],
    }),
    pgPolicy("Projects can be selected by a member of the team", {
      as: "permissive",
      for: "select",
      to: ["authenticated"],
    }),
    pgPolicy("Projects can be updated by a member of the team", {
      as: "permissive",
      for: "update",
      to: ["authenticated"],
    }),
  ],
);

// A workspace-local supplier. Invoices resolve to one by explicit identifiers
// (VAT number, company number), else by a name no other supplier shares; see
// docs/document-intake.md#supplier-identity-and-history. A merged supplier
// points at the supplier it was merged into (always a canonical one), keeps
// its own identifiers and can be unmerged.
export const suppliers = pgTable(
  "suppliers",
  {
    id: uuid("id").defaultRandom().primaryKey().notNull(),
    teamId: uuid("team_id").notNull(),
    name: text("name").notNull(),
    nameKey: text("name_key").notNull(),
    vatKey: text("vat_key"),
    companyKey: text("company_key"),
    mergedIntoId: uuid("merged_into_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("suppliers_team_name_key_idx").on(table.teamId, table.nameKey),
    index("suppliers_merged_into_id_idx").on(table.mergedIntoId),
    uniqueIndex("suppliers_team_vat_key_key")
      .on(table.teamId, table.vatKey)
      .where(sql`${table.vatKey} IS NOT NULL`),
    uniqueIndex("suppliers_team_company_key_key")
      .on(table.teamId, table.companyKey)
      .where(sql`${table.companyKey} IS NOT NULL`),
    foreignKey({
      columns: [table.teamId],
      foreignColumns: [teams.id],
      name: "suppliers_team_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.mergedIntoId],
      foreignColumns: [table.id],
      name: "suppliers_merged_into_id_fkey",
    }).onDelete("set null"),
  ],
);

/**
 * A workspace's dedicated receiving address (`<local_part>@<INBOUND_EMAIL_DOMAIN>`).
 * The local part is random and never reused, even after it is revoked, so a
 * rotated address cannot start delivering to another workspace. At most one
 * address per workspace is active. See docs/inbound-email.md.
 */
export const inboundEmailAddresses = pgTable(
  "inbound_email_addresses",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    teamId: uuid("team_id").notNull(),
    localPart: text("local_part").notNull(),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "string" }),
  },
  (table) => [
    unique("inbound_email_addresses_local_part_key").on(table.localPart),
    uniqueIndex("inbound_email_addresses_active_team_key")
      .on(table.teamId)
      .where(sql`${table.revokedAt} is null`),
    foreignKey({
      columns: [table.teamId],
      foreignColumns: [teams.id],
      name: "inbound_email_addresses_team_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [users.id],
      name: "inbound_email_addresses_created_by_fkey",
    }).onDelete("set null"),
  ],
);

export type InboundEmailAttachmentOutcome = {
  index: number;
  fileName: string | null;
  contentType: string | null;
  size: number;
  sha256: string | null;
  outcome: "accepted" | "duplicate" | "rejected" | "skipped";
  code?: string;
  message?: string;
  inboxId?: string;
};

/**
 * One message delivered to a workspace address. `(team_id, message_key)` is
 * the redelivery identity (a hash of the Message-ID header, else of the raw
 * bytes). `raw` holds the MIME source only until the message is processed,
 * or until retention clears it from a failed one; retention also clears the
 * header fields (docs/data-lifecycle.md).
 */
export const inboundEmails = pgTable(
  "inbound_emails",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    teamId: uuid("team_id").notNull(),
    addressId: uuid("address_id"),
    recipient: text().notNull(),
    envelopeFrom: text("envelope_from"),
    messageKey: text("message_key").notNull(),
    messageId: text("message_id"),
    headerFrom: text("header_from"),
    subject: text(),
    sentAt: text("sent_at"),
    authenticationResults: text("authentication_results"),
    size: integer().notNull(),
    rawSha256: text("raw_sha256").notNull(),
    raw: bytea(),
    status: inboundEmailStatusEnum().default("received").notNull(),
    attachments: jsonb()
      .$type<InboundEmailAttachmentOutcome[]>()
      .default(sql`'[]'::jsonb`)
      .notNull(),
    // Why nothing (or not everything) became an invoice, or why processing
    // failed; shown beside the message in settings.
    detail: text(),
    deliveryCount: integer("delivery_count").default(1).notNull(),
    lastDeliveredAt: timestamp("last_delivered_at", {
      withTimezone: true,
      mode: "string",
    })
      .defaultNow()
      .notNull(),
    processedAt: timestamp("processed_at", {
      withTimezone: true,
      mode: "string",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("inbound_emails_team_message_key").on(
      table.teamId,
      table.messageKey,
    ),
    index("inbound_emails_team_created_at_idx").on(
      table.teamId,
      table.createdAt,
    ),
    foreignKey({
      columns: [table.teamId],
      foreignColumns: [teams.id],
      name: "inbound_emails_team_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.addressId],
      foreignColumns: [inboundEmailAddresses.id],
      name: "inbound_emails_address_id_fkey",
    }).onDelete("set null"),
  ],
);

export const inbox = pgTable(
  "inbox",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    teamId: uuid("team_id"),
    filePath: text("file_path").array(),
    fileName: text("file_name"),
    transactionId: uuid("transaction_id"),
    amount: numericCasted("amount", { precision: 10, scale: 2 }),
    currency: text(),
    contentType: text("content_type"),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    size: bigint({ mode: "number" }),
    attachmentId: uuid("attachment_id"),
    date: date(),
    forwardedTo: text("forwarded_to"),
    referenceId: text("reference_id"),
    meta: json(),
    extraction: jsonb("extraction").$type<Record<string, unknown>>(),
    judgments: jsonb("judgments").$type<Record<string, unknown>[]>(),
    // Deterministic checks of the extraction (arithmetic, currency, identity,
    // required fields) and whether it may be posted to accounting; see
    // docs/document-intake.md#validation. Null until processed.
    validation: jsonb("validation").$type<Record<string, unknown>>(),
    // The workspace supplier the document resolved to (possibly merged since;
    // follow suppliers.merged_into_id), how it was resolved or who assigned
    // it, and the supplier-history checks with their evidence and version.
    supplierId: uuid("supplier_id"),
    supplierResolution: jsonb("supplier_resolution").$type<
      Record<string, unknown>
    >(),
    supplierChecks: jsonb("supplier_checks").$type<Record<string, unknown>>(),
    accountingProvider: accountingProviderEnum("accounting_provider"),
    accountingPostStatus: accountingPostStatusEnum("accounting_post_status"),
    accountingProviderId: text("accounting_provider_id"),
    accountingPostError: text("accounting_post_error"),
    // Set when a user retries a post held for review (another supplier's
    // bill already has its number): it then posts under its own key.
    accountingPostReleased: boolean("accounting_post_released")
      .default(false)
      .notNull(),
    accountingPostedAt: timestamp("accounting_posted_at", {
      withTimezone: true,
      mode: "string",
    }),
    accountingIdempotencyKey: text("accounting_idempotency_key"),
    // Whether a terminal accounting failure is worth an explicit retry
    // (provider outage, exhausted retries) or needs a configuration change.
    accountingPostRetryable: boolean("accounting_post_retryable"),
    // The processing revision whose accounting intent is scheduled; the
    // workflow key is derived from it.
    accountingRevision: integer("accounting_revision"),
    // Incremented in the same transaction that persists a processing result
    // and schedules its deliveries, so (id, revision) names one accepted
    // invoice revision across worker retries and replays.
    processingRevision: integer("processing_revision").default(0).notNull(),
    // The extraction as read from the document, kept when a user first
    // corrects it; `extraction` then holds the corrected record. Null while
    // the current reading is uncorrected, and reset by a re-extraction.
    extractionOriginal: jsonb("extraction_original").$type<
      Record<string, unknown>
    >(),
    // Explicit question rerun: `queued` while its job runs for
    // `judgments_rerun_revision`, `failed` with the reason when it could not
    // finish; null when no rerun is outstanding.
    judgmentsRerunStatus: text("judgments_rerun_status", {
      enum: ["queued", "failed"],
    }),
    judgmentsRerunError: text("judgments_rerun_error"),
    judgmentsRerunRevision: integer("judgments_rerun_revision"),
    status: inboxStatusEnum().default("new"),
    website: text(),
    displayName: text("display_name"),
    fts: tsvector("fts")
      .notNull()
      .generatedAlwaysAs(
        (): SQL =>
          sql`generate_inbox_fts(display_name, extract_product_names((meta -> 'products'::text)))`,
      ),
    type: inboxTypeEnum(),
    description: text(),
    baseAmount: numericCasted("base_amount", { precision: 10, scale: 2 }),
    baseCurrency: text("base_currency"),
    taxAmount: numericCasted("tax_amount", { precision: 10, scale: 2 }),
    taxRate: numericCasted("tax_rate", { precision: 10, scale: 2 }),
    taxType: text("tax_type"),
    inboxAccountId: uuid("inbox_account_id"),
    // Workspace-owned intake lifecycle. Rows created before issue #34 keep a
    // null state and are treated as legacy accepted documents.
    intakeState: inboxIntakeStateEnum("intake_state"),
    // sha256 of the accepted bytes. Replay identity is (team_id, content_hash).
    contentHash: text("content_hash"),
    intakeError: text("intake_error"),
    // Why extraction failed for an accepted document (unreadable, not an
    // invoice, over a limit, provider failure). Null while processing and
    // after a successful run; the same for every input format.
    processingError: text("processing_error"),
    // Set when an object removal failed; the next cleanup pass retries it so
    // bytes are never orphaned behind a record that no longer matches the
    // cleanup selection.
    objectRemovalPending: boolean("object_removal_pending")
      .default(false)
      .notNull(),
    // A failed publication may have reached storage after the local abort.
    // The tombstone stays set until explicit provider/operator settlement or a
    // verified accepted retry, so a late effect is never mistaken for a
    // settled write based only on elapsed cleanup passes.
    objectRemovalAmbiguous: boolean("object_removal_ambiguous")
      .default(false)
      .notNull(),
    // Lease taken by an intake attempt while it writes and verifies the
    // object outside any database transaction. Cleanup cannot claim the
    // reservation until the lease has expired.
    intakePublishingUntil: timestamp("intake_publishing_until", {
      withTimezone: true,
      mode: "string",
    }),
    // The received message this document was an attachment of, when it came
    // in through the workspace's dedicated address.
    inboundEmailId: uuid("inbound_email_id"),
    // The invoice's current decision about which authorization sources it
    // bills; earlier decisions stay in `invoice_source_matches`.
    sourceMatchId: uuid("source_match_id").references(
      (): AnyPgColumn => invoiceSourceMatches.id,
      { onDelete: "set null" },
    ),
  },
  (table) => [
    index("inbox_attachment_id_idx").using(
      "btree",
      table.attachmentId.asc().nullsLast().op("uuid_ops"),
    ),
    index("inbox_created_at_idx").using(
      "btree",
      table.createdAt.asc().nullsLast().op("timestamptz_ops"),
    ),
    // Serves the delivery reconciler's scan for queued accounting intents.
    // Not partial on 'queued': that enum value is added in the same
    // migration batch and cannot be referenced until it commits.
    index("inbox_accounting_post_status_idx").on(table.accountingPostStatus),
    index("inbox_team_id_idx").using(
      "btree",
      table.teamId.asc().nullsLast().op("uuid_ops"),
    ),
    index("inbox_transaction_id_idx").using(
      "btree",
      table.transactionId.asc().nullsLast().op("uuid_ops"),
    ),
    index("inbox_inbox_account_id_idx").using(
      "btree",
      table.inboxAccountId.asc().nullsLast().op("uuid_ops"),
    ),
    index("inbox_team_supplier_created_at_idx")
      .on(table.teamId, table.supplierId, table.createdAt)
      .where(sql`${table.supplierId} IS NOT NULL`),
    foreignKey({
      columns: [table.supplierId],
      foreignColumns: [suppliers.id],
      name: "inbox_supplier_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.attachmentId],
      foreignColumns: [transactionAttachments.id],
      name: "inbox_attachment_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.teamId],
      foreignColumns: [teams.id],
      name: "public_inbox_team_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.transactionId],
      foreignColumns: [transactions.id],
      name: "public_inbox_transaction_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.inboxAccountId],
      foreignColumns: [inboxAccounts.id],
      name: "inbox_inbox_account_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.inboundEmailId],
      foreignColumns: [inboundEmails.id],
      name: "inbox_inbound_email_id_fkey",
    }).onDelete("set null"),
    index("inbox_inbound_email_id_idx").on(table.inboundEmailId),
    // Provider/attachment identity is workspace-scoped: two tenants may both
    // receive the same provider reference without colliding.
    uniqueIndex("inbox_team_reference_id_key")
      .on(table.teamId, table.referenceId)
      .where(sql`${table.referenceId} is not null`),
    // At most one reserved-or-accepted record per workspace and content hash,
    // so a repeated upload is idempotent and a conflicting replay cannot
    // replace the first accepted document.
    uniqueIndex("inbox_team_content_hash_intake_idx")
      .on(table.teamId, table.contentHash)
      .where(
        sql`${table.intakeState} in ('reserved'::"public"."inbox_intake_state", 'accepted'::"public"."inbox_intake_state")`,
      ),
    pgPolicy("Inbox can be deleted by a member of the team", {
      as: "permissive",
      for: "delete",
      to: ["public"],
      using: sql`(team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user))`,
    }),
    pgPolicy("Inbox can be selected by a member of the team", {
      as: "permissive",
      for: "select",
      to: ["public"],
    }),
    pgPolicy("Inbox can be updated by a member of the team", {
      as: "permissive",
      for: "update",
      to: ["public"],
    }),
  ],
);

export const accountingConnections = pgTable(
  "accounting_connections",
  {
    id: uuid("id").defaultRandom().primaryKey().notNull(),
    teamId: uuid("team_id").notNull(),
    provider: accountingProviderEnum("provider").notNull(),
    integrationId: text("integration_id").notNull(),
    connectionId: text("connection_id").notNull(),
    capabilities: text("capabilities")
      .array()
      .default(sql`ARRAY['draft_bills']::text[]`)
      .notNull(),
    connectedAt: timestamp("connected_at", {
      withTimezone: true,
      mode: "string",
    })
      .defaultNow()
      .notNull(),
    disconnectedAt: timestamp("disconnected_at", {
      withTimezone: true,
      mode: "string",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("accounting_connections_team_id_idx").on(table.teamId),
    unique("accounting_connections_team_provider_key").on(
      table.teamId,
      table.provider,
    ),
    uniqueIndex("accounting_connections_one_active_per_team_key")
      .on(table.teamId)
      .where(sql`${table.disconnectedAt} IS NULL`),
    foreignKey({
      columns: [table.teamId],
      foreignColumns: [teams.id],
      name: "accounting_connections_team_id_fkey",
    }).onDelete("cascade"),
  ],
);

// Every supplier-identity correction: an invoice assigned to another
// supplier, or one supplier merged into another. `data` holds what the change
// replaced, so a mistaken change can be reverted exactly; a revert is itself
// an event and marks the one it undid.
export const supplierEvents = pgTable(
  "supplier_events",
  {
    id: uuid("id").defaultRandom().primaryKey().notNull(),
    teamId: uuid("team_id").notNull(),
    action: text("action").notNull(),
    supplierId: uuid("supplier_id"),
    targetSupplierId: uuid("target_supplier_id"),
    inboxId: uuid("inbox_id"),
    actorId: uuid("actor_id"),
    data: jsonb("data").$type<Record<string, unknown>>().notNull(),
    revertsEventId: uuid("reverts_event_id"),
    revertedAt: timestamp("reverted_at", {
      withTimezone: true,
      mode: "string",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("supplier_events_team_created_at_idx").on(
      table.teamId,
      table.createdAt,
    ),
    foreignKey({
      columns: [table.teamId],
      foreignColumns: [teams.id],
      name: "supplier_events_team_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.actorId],
      foreignColumns: [users.id],
      name: "supplier_events_actor_id_fkey",
    }).onDelete("set null"),
  ],
);

// The document's laid-out text as read by the processing run that produced
// the invoice's current revision. Questions previewed or rerun later read it
// as the invoice's source evidence; it goes with the document (deleting the
// invoice removes it at once). See docs/document-intake.md#questions.
export const documentTexts = pgTable(
  "document_texts",
  {
    inboxId: uuid("inbox_id").primaryKey().notNull(),
    teamId: uuid("team_id").notNull(),
    // The processing revision whose run read this text.
    revision: integer("revision").notNull(),
    text: text("text").notNull(),
    // Characters the document had before the retention cap.
    chars: integer("chars").notNull(),
    truncated: boolean("truncated").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("document_texts_team_id_idx").on(table.teamId),
    foreignKey({
      columns: [table.inboxId],
      foreignColumns: [inbox.id],
      name: "document_texts_inbox_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.teamId],
      foreignColumns: [teams.id],
      name: "document_texts_team_id_fkey",
    }).onDelete("cascade"),
  ],
);

// A deliberate rerun of one question revision over a bounded selection of
// invoices, requested by a workspace admin. Its answers replace the
// question's current answer on each invoice; what they replaced is kept in
// question_answers.
export const questionRuns = pgTable(
  "question_runs",
  {
    id: uuid("id").defaultRandom().primaryKey().notNull(),
    teamId: uuid("team_id").notNull(),
    questionKey: text("question_key").notNull(),
    questionVersionId: uuid("question_version_id").notNull(),
    questionVersion: integer("question_version").notNull(),
    invoiceIds: uuid("invoice_ids").array().notNull(),
    // queued | running | completed | failed | cancelled
    status: text("status").notNull(),
    answered: integer("answered").default(0).notNull(),
    unknown: integer("unknown").default(0).notNull(),
    failed: integer("failed").default(0).notNull(),
    // Invoices left unchanged: deleted, not processed, or reprocessed since.
    skipped: integer("skipped").default(0).notNull(),
    error: text("error"),
    requestedBy: uuid("requested_by"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "string",
    }),
  },
  (table) => [
    index("question_runs_team_question_idx").on(
      table.teamId,
      table.questionKey,
      table.createdAt,
    ),
    foreignKey({
      columns: [table.teamId],
      foreignColumns: [teams.id],
      name: "question_runs_team_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.questionVersionId],
      foreignColumns: [userQuestions.id],
      name: "question_runs_question_version_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.requestedBy],
      foreignColumns: [users.id],
      name: "question_runs_requested_by_fkey",
    }).onDelete("set null"),
  ],
);

// One answer a rerun recorded on one invoice, with the answer it replaced
// (null when the invoice had none for that question). Append-only: earlier
// answers stay readable, labelled with the question revision and evaluator
// that produced them.
export const questionAnswers = pgTable(
  "question_answers",
  {
    id: uuid("id").defaultRandom().primaryKey().notNull(),
    teamId: uuid("team_id").notNull(),
    invoiceId: uuid("invoice_id").notNull(),
    runId: uuid("run_id").notNull(),
    questionKey: text("question_key").notNull(),
    questionVersionId: uuid("question_version_id").notNull(),
    // The invoice's processing revision the answer was made for.
    invoiceRevision: integer("invoice_revision").notNull(),
    judgment: jsonb("judgment").$type<Record<string, unknown>>().notNull(),
    previous: jsonb("previous").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("question_answers_run_invoice_key").on(table.runId, table.invoiceId),
    index("question_answers_team_invoice_idx").on(
      table.teamId,
      table.invoiceId,
    ),
    foreignKey({
      columns: [table.teamId],
      foreignColumns: [teams.id],
      name: "question_answers_team_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.invoiceId],
      foreignColumns: [inbox.id],
      name: "question_answers_invoice_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.runId],
      foreignColumns: [questionRuns.id],
      name: "question_answers_run_id_fkey",
    }).onDelete("cascade"),
  ],
);

// A document received again with identical bytes. Intake keeps one document
// per content (see docs/document-intake.md#identity), so a re-delivery is
// recorded here instead of being processed or delivered a second time.
export const inboxRedeliveries = pgTable(
  "inbox_redeliveries",
  {
    id: uuid("id").defaultRandom().primaryKey().notNull(),
    teamId: uuid("team_id").notNull(),
    inboxId: uuid("inbox_id").notNull(),
    referenceId: text("reference_id"),
    inboxAccountId: uuid("inbox_account_id"),
    fileName: text("file_name"),
    receivedAt: timestamp("received_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("inbox_redeliveries_inbox_id_idx").on(table.inboxId),
    uniqueIndex("inbox_redeliveries_team_reference_id_key")
      .on(table.teamId, table.referenceId)
      .where(sql`${table.referenceId} IS NOT NULL`),
    foreignKey({
      columns: [table.teamId],
      foreignColumns: [teams.id],
      name: "inbox_redeliveries_team_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.inboxId],
      foreignColumns: [inbox.id],
      name: "inbox_redeliveries_inbox_id_fkey",
    }).onDelete("cascade"),
  ],
);

// Authorized work invoices are checked against: a job, purchase order or
// contract, identified by the workspace's own stable reference. The row holds
// the current version's headline values for listing and search; the terms
// themselves live in immutable `authorization_source_versions`. See
// docs/authorization-sources.md.
export const authorizationSources = pgTable(
  "authorization_sources",
  {
    id: uuid("id").defaultRandom().primaryKey().notNull(),
    teamId: uuid("team_id").notNull(),
    sourceType: text("source_type").notNull(),
    reference: text("reference").notNull(),
    referenceKey: text("reference_key").notNull(),
    currentVersionId: uuid("current_version_id"),
    currentVersion: integer("current_version").notNull(),
    status: text("status").notNull(),
    title: text("title"),
    supplierId: uuid("supplier_id"),
    supplierName: text("supplier_name"),
    currency: text("currency"),
    authorizedTotal: numeric("authorized_total", {
      precision: 16,
      scale: 2,
    }).notNull(),
    effectiveFrom: date("effective_from", { mode: "string" }).notNull(),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("authorization_sources_team_type_reference_key").on(
      table.teamId,
      table.sourceType,
      table.referenceKey,
    ),
    index("authorization_sources_team_updated_at_idx").on(
      table.teamId,
      table.updatedAt,
    ),
    index("authorization_sources_team_supplier_idx")
      .on(table.teamId, table.supplierId)
      .where(sql`${table.supplierId} IS NOT NULL`),
    foreignKey({
      columns: [table.teamId],
      foreignColumns: [teams.id],
      name: "authorization_sources_team_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.supplierId],
      foreignColumns: [suppliers.id],
      name: "authorization_sources_supplier_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [users.id],
      name: "authorization_sources_created_by_fkey",
    }).onDelete("set null"),
  ],
);

// One version of a source's terms. A version is never edited (a database
// trigger refuses it); an amendment, status change or supplier link is a new
// version, so a comparison that cited a version stays explainable.
export const authorizationSourceVersions = pgTable(
  "authorization_source_versions",
  {
    id: uuid("id").defaultRandom().primaryKey().notNull(),
    teamId: uuid("team_id").notNull(),
    sourceId: uuid("source_id").notNull(),
    version: integer("version").notNull(),
    status: text("status").notNull(),
    title: text("title"),
    scope: text("scope"),
    supplierId: uuid("supplier_id"),
    supplierName: text("supplier_name"),
    supplierVatNumber: text("supplier_vat_number"),
    supplierCompanyNumber: text("supplier_company_number"),
    supplierResolution: jsonb("supplier_resolution")
      .$type<Record<string, unknown>>()
      .notNull(),
    currency: text("currency"),
    taxBasis: text("tax_basis"),
    issuedOn: date("issued_on", { mode: "string" }),
    startsOn: date("starts_on", { mode: "string" }),
    endsOn: date("ends_on", { mode: "string" }),
    effectiveFrom: date("effective_from", { mode: "string" }).notNull(),
    authorizedTotal: numeric("authorized_total", {
      precision: 16,
      scale: 2,
    }).notNull(),
    lineItems: jsonb("line_items").$type<Record<string, unknown>[]>().notNull(),
    changeReason: text("change_reason"),
    origin: text("origin").notNull(),
    importId: uuid("import_id"),
    contentHash: text("content_hash").notNull(),
    actorId: uuid("actor_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("authorization_source_versions_source_version_key").on(
      table.sourceId,
      table.version,
    ),
    index("authorization_source_versions_team_id_idx").on(table.teamId),
    foreignKey({
      columns: [table.teamId],
      foreignColumns: [teams.id],
      name: "authorization_source_versions_team_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.sourceId],
      foreignColumns: [authorizationSources.id],
      name: "authorization_source_versions_source_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.supplierId],
      foreignColumns: [suppliers.id],
      name: "authorization_source_versions_supplier_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.actorId],
      foreignColumns: [users.id],
      name: "authorization_source_versions_actor_id_fkey",
    }).onDelete("set null"),
  ],
);

// A retained source document (the signed PO, the contract PDF) attached as
// evidence to the version that was current when it arrived.
export const authorizationSourceDocuments = pgTable(
  "authorization_source_documents",
  {
    id: uuid("id").defaultRandom().primaryKey().notNull(),
    teamId: uuid("team_id").notNull(),
    sourceId: uuid("source_id").notNull(),
    versionId: uuid("version_id").notNull(),
    filePath: text("file_path").array().notNull(),
    fileName: text("file_name").notNull(),
    contentType: text("content_type").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    sha256: text("sha256").notNull(),
    uploadedBy: uuid("uploaded_by"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("authorization_source_documents_source_sha256_key").on(
      table.sourceId,
      table.sha256,
    ),
    index("authorization_source_documents_team_id_idx").on(table.teamId),
    foreignKey({
      columns: [table.teamId],
      foreignColumns: [teams.id],
      name: "authorization_source_documents_team_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.sourceId],
      foreignColumns: [authorizationSources.id],
      name: "authorization_source_documents_source_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.versionId],
      foreignColumns: [authorizationSourceVersions.id],
      name: "authorization_source_documents_version_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.uploadedBy],
      foreignColumns: [users.id],
      name: "authorization_source_documents_uploaded_by_fkey",
    }).onDelete("set null"),
  ],
);

// Every applied or rejected batch (CSV or API), with its per-source outcomes
// or row errors. A rejected batch changed nothing.
export const authorizationSourceImports = pgTable(
  "authorization_source_imports",
  {
    id: uuid("id").defaultRandom().primaryKey().notNull(),
    teamId: uuid("team_id").notNull(),
    actorId: uuid("actor_id"),
    origin: text("origin").notNull(),
    fileName: text("file_name"),
    status: text("status").notNull(),
    summary: jsonb("summary").$type<Record<string, unknown>>().notNull(),
    errors: jsonb("errors").$type<Record<string, unknown>[]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("authorization_source_imports_team_created_at_idx").on(
      table.teamId,
      table.createdAt,
    ),
    foreignKey({
      columns: [table.teamId],
      foreignColumns: [teams.id],
      name: "authorization_source_imports_team_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.actorId],
      foreignColumns: [users.id],
      name: "authorization_source_imports_actor_id_fkey",
    }).onDelete("set null"),
  ],
);

// Every decision about which authorization sources an invoice bills: an
// automatic one (an exact reference, or TypeSafe choosing among the
// workspace's candidates) or a person's confirmation, correction or unlink.
// Decisions are never edited (a trigger refuses it); the invoice points at
// its current one, so overrides, earlier decisions and their reasons are
// kept. See docs/authorization-matching.md.
export const invoiceSourceMatches = pgTable(
  "invoice_source_matches",
  {
    id: uuid("id").defaultRandom().primaryKey().notNull(),
    teamId: uuid("team_id").notNull(),
    inboxId: uuid("inbox_id").notNull(),
    // 1, 2, ... per invoice.
    sequence: integer("sequence").notNull(),
    status: text("status").notNull(),
    origin: text("origin").notNull(),
    action: text("action").notNull(),
    method: text("method"),
    // The whole decision: candidates with their evidence, links, allocations,
    // the semantic answer and the lookup time.
    result: jsonb("result").$type<Record<string, unknown>>().notNull(),
    reason: text("reason"),
    // The processing revision whose extraction was matched.
    processingRevision: integer("processing_revision"),
    rulesVersion: integer("rules_version").notNull(),
    fingerprint: text("fingerprint").notNull(),
    actorId: uuid("actor_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("invoice_source_matches_inbox_sequence_key").on(
      table.inboxId,
      table.sequence,
    ),
    index("invoice_source_matches_team_id_idx").on(table.teamId),
    foreignKey({
      columns: [table.teamId],
      foreignColumns: [teams.id],
      name: "invoice_source_matches_team_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.inboxId],
      foreignColumns: [inbox.id],
      name: "invoice_source_matches_inbox_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.actorId],
      foreignColumns: [users.id],
      name: "invoice_source_matches_actor_id_fkey",
    }).onDelete("set null"),
  ],
);

// A source (and the version compared) that one decision links the invoice to.
export const invoiceSourceLinks = pgTable(
  "invoice_source_links",
  {
    id: uuid("id").defaultRandom().primaryKey().notNull(),
    teamId: uuid("team_id").notNull(),
    matchId: uuid("match_id").notNull(),
    inboxId: uuid("inbox_id").notNull(),
    sourceId: uuid("source_id").notNull(),
    versionId: uuid("version_id").notNull(),
  },
  (table) => [
    uniqueIndex("invoice_source_links_match_source_key").on(
      table.matchId,
      table.sourceId,
    ),
    index("invoice_source_links_team_source_idx").on(
      table.teamId,
      table.sourceId,
    ),
    foreignKey({
      columns: [table.teamId],
      foreignColumns: [teams.id],
      name: "invoice_source_links_team_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.matchId],
      foreignColumns: [invoiceSourceMatches.id],
      name: "invoice_source_links_match_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.inboxId],
      foreignColumns: [inbox.id],
      name: "invoice_source_links_inbox_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.sourceId],
      foreignColumns: [authorizationSources.id],
      name: "invoice_source_links_source_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.versionId],
      foreignColumns: [authorizationSourceVersions.id],
      name: "invoice_source_links_version_id_fkey",
    }).onDelete("cascade"),
  ],
);

// Part of the invoice billed against a linked source: one of its lines (or
// the whole invoice when null), optionally against one authorized line. The
// amount is signed (a credit note is negative) in the invoice's currency.
export const invoiceSourceAllocations = pgTable(
  "invoice_source_allocations",
  {
    id: uuid("id").defaultRandom().primaryKey().notNull(),
    teamId: uuid("team_id").notNull(),
    linkId: uuid("link_id").notNull(),
    sourceLineReference: text("source_line_reference"),
    invoiceLineIndex: integer("invoice_line_index"),
    amount: numeric("amount", { precision: 16, scale: 2 }),
    currency: text("currency"),
    basis: text("basis").notNull(),
  },
  (table) => [
    index("invoice_source_allocations_link_id_idx").on(table.linkId),
    foreignKey({
      columns: [table.teamId],
      foreignColumns: [teams.id],
      name: "invoice_source_allocations_team_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.linkId],
      foreignColumns: [invoiceSourceLinks.id],
      name: "invoice_source_allocations_link_id_fkey",
    }).onDelete("cascade"),
  ],
);

// One claim per document type and number: only the document holding it may
// post a bill, so two documents with one number are never both posted
// automatically. Kept after a successful post; released only on a definitive
// provider failure.
export const accountingPostClaims = pgTable(
  "accounting_post_claims",
  {
    teamId: uuid("team_id").notNull(),
    identityKey: text("identity_key").notNull(),
    invoiceId: uuid("invoice_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.teamId, table.identityKey],
      name: "accounting_post_claims_pkey",
    }),
    foreignKey({
      columns: [table.teamId],
      foreignColumns: [teams.id],
      name: "accounting_post_claims_team_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.invoiceId],
      foreignColumns: [inbox.id],
      name: "accounting_post_claims_invoice_id_fkey",
    }).onDelete("cascade"),
  ],
);

/**
 * One user correction of an invoice's extracted fields: who made it, when,
 * why, each field's value before and after, and what it meant for the bill
 * already in the accounting provider (docs/delivery.md#corrections).
 */
export const invoiceCorrections = pgTable(
  "invoice_corrections",
  {
    id: uuid("id").defaultRandom().primaryKey().notNull(),
    teamId: uuid("team_id").notNull(),
    invoiceId: uuid("invoice_id").notNull(),
    // 1, 2, 3… per invoice, across re-extractions.
    version: integer("version").notNull(),
    // The processing revision the user corrected and the one it created.
    baseRevision: integer("base_revision").notNull(),
    revision: integer("revision").notNull(),
    actorId: uuid("actor_id"),
    reason: text("reason").notNull(),
    changes: jsonb("changes")
      .$type<{ field: string; from: unknown; to: unknown }[]>()
      .notNull(),
    // The corrected extraction, which a bill update sends as it was approved.
    extraction: jsonb("extraction").$type<Record<string, unknown>>().notNull(),
    // not_posted: no bill existed; keep_bill: the bill was left as posted;
    // update_bill: the same bill is updated in place at the provider.
    accountingOutcome: text("accounting_outcome", {
      enum: ["not_posted", "keep_bill", "update_bill"],
    }).notNull(),
    provider: accountingProviderEnum("provider"),
    providerId: text("provider_id"),
    // superseded: a re-extraction replaced the corrected reading before the
    // update was sent, so it is never sent.
    updateStatus: text("update_status", {
      enum: ["queued", "updated", "failed", "cancelled", "superseded"],
    }),
    updateError: text("update_error"),
    updateRetryable: boolean("update_retryable"),
    // Bumped by each explicit retry, so a retry is a new provider request
    // while the runner's own attempts share one idempotency key.
    updateAttempt: integer("update_attempt").default(0).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("invoice_corrections_invoice_version_key").on(
      table.invoiceId,
      table.version,
    ),
    index("invoice_corrections_team_invoice_idx").on(
      table.teamId,
      table.invoiceId,
    ),
    foreignKey({
      columns: [table.teamId],
      foreignColumns: [teams.id],
      name: "invoice_corrections_team_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.invoiceId],
      foreignColumns: [inbox.id],
      name: "invoice_corrections_invoice_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.actorId],
      foreignColumns: [users.id],
      name: "invoice_corrections_actor_id_fkey",
    }).onDelete("set null"),
  ],
);

/**
 * Who changed what in a workspace, and every operator action and operator
 * access to customer data (docs/operations.md#audit-trail). One row per
 * action: written as `started` before the change runs and settled with its
 * outcome after, so an action that crashed mid-way still reads as attempted.
 * `detail` holds only named, redacted fields: never document contents,
 * extracted values, bank details, tokens or secrets.
 */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").defaultRandom().primaryKey().notNull(),
    // Null for an operator action that belongs to no workspace.
    teamId: uuid("team_id"),
    actorType: text("actor_type", {
      enum: ["user", "api_key", "oauth", "operator"],
    }).notNull(),
    // The acting user (the key's or grant's owner for API access); null for
    // an operator, and once the user's account is deleted.
    actorUserId: uuid("actor_user_id"),
    // The API key or OAuth application id, or the operator's name.
    actorRef: text("actor_ref"),
    // app (dashboard, tRPC), api (REST), ops (operator routes).
    surface: text("surface", { enum: ["app", "api", "ops"] }).notNull(),
    action: text("action").notNull(),
    category: text("category", {
      enum: [
        "invoice",
        "delivery",
        "question",
        "supplier",
        "authorization_source",
        "integration",
        "access",
        "workspace",
        "operator",
      ],
    }).notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    // The invoice processing revision the action named or produced.
    revision: integer("revision"),
    outcome: text("outcome", {
      enum: ["started", "succeeded", "refused", "denied", "failed"],
    }).notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>(),
    // Operator actions: why the operator acted (incident, support, security).
    purpose: text("purpose"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    settledAt: timestamp("settled_at", { withTimezone: true, mode: "string" }),
  },
  (table) => [
    index("audit_events_team_created_at_idx").on(table.teamId, table.createdAt),
    index("audit_events_team_target_idx").on(
      table.teamId,
      table.targetType,
      table.targetId,
    ),
    index("audit_events_created_at_idx").on(table.createdAt),
    foreignKey({
      columns: [table.teamId],
      foreignColumns: [teams.id],
      name: "audit_events_team_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.actorUserId],
      foreignColumns: [users.id],
      name: "audit_events_actor_user_id_fkey",
    }).onDelete("set null"),
  ],
);

export const webhookEndpoints = pgTable(
  "webhook_endpoints",
  {
    id: uuid("id").defaultRandom().primaryKey().notNull(),
    teamId: uuid("team_id").notNull(),
    url: text("url").notNull(),
    secretEncrypted: text("secret_encrypted").notNull(),
    // The secret replaced by the last rotation. Deliveries are signed with
    // both until it expires, so consumers can switch without dropping events.
    previousSecretEncrypted: text("previous_secret_encrypted"),
    previousSecretExpiresAt: timestamp("previous_secret_expires_at", {
      withTimezone: true,
      mode: "string",
    }),
    secretRotatedAt: timestamp("secret_rotated_at", {
      withTimezone: true,
      mode: "string",
    }),
    events: text("events").array().notNull(),
    active: boolean("active").default(true).notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("webhook_endpoints_team_id_idx").on(table.teamId),
    unique("webhook_endpoints_team_url_key").on(table.teamId, table.url),
    foreignKey({
      columns: [table.teamId],
      foreignColumns: [teams.id],
      name: "webhook_endpoints_team_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [users.id],
      name: "webhook_endpoints_created_by_fkey",
    }).onDelete("cascade"),
  ],
);

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").defaultRandom().primaryKey().notNull(),
    endpointId: uuid("endpoint_id").notNull(),
    teamId: uuid("team_id").notNull(),
    invoiceId: uuid("invoice_id"),
    event: text("event").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    // Logical event identity, shared by every endpoint that receives the
    // event and stable across worker retries, so consumers can deduplicate.
    eventId: uuid("event_id"),
    // The invoice processing revision this delivery belongs to.
    revision: integer("revision"),
    status: webhookDeliveryStatusEnum().default("queued").notNull(),
    attempts: integer("attempts").default(0).notNull(),
    lastError: text("last_error"),
    // For a failed delivery: whether an explicit retry may succeed.
    retryable: boolean("retryable"),
    deliveredAt: timestamp("delivered_at", {
      withTimezone: true,
      mode: "string",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("webhook_deliveries_endpoint_id_idx").on(table.endpointId),
    index("webhook_deliveries_invoice_id_idx").on(table.invoiceId),
    index("webhook_deliveries_team_id_idx").on(table.teamId),
    index("webhook_deliveries_status_idx").on(table.status),
    // One delivery per endpoint and logical event: rescheduling the same
    // revision can never create a second delivery.
    uniqueIndex("webhook_deliveries_endpoint_event_key")
      .on(table.endpointId, table.eventId)
      .where(sql`${table.eventId} is not null`),
    foreignKey({
      columns: [table.endpointId],
      foreignColumns: [webhookEndpoints.id],
      name: "webhook_deliveries_endpoint_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.teamId],
      foreignColumns: [teams.id],
      name: "webhook_deliveries_team_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.invoiceId],
      foreignColumns: [inbox.id],
      name: "webhook_deliveries_invoice_id_fkey",
    }).onDelete("set null"),
  ],
);

export const webhookDeliveryAttempts = pgTable(
  "webhook_delivery_attempts",
  {
    id: uuid("id").defaultRandom().primaryKey().notNull(),
    deliveryId: uuid("delivery_id").notNull(),
    endpointId: uuid("endpoint_id").notNull(),
    teamId: uuid("team_id").notNull(),
    attempt: integer("attempt").notNull(),
    statusCode: integer("status_code"),
    error: text("error"),
    durationMs: integer("duration_ms").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("webhook_delivery_attempts_delivery_id_idx").on(table.deliveryId),
    index("webhook_delivery_attempts_endpoint_id_idx").on(table.endpointId),
    index("webhook_delivery_attempts_team_id_idx").on(table.teamId),
    unique("webhook_delivery_attempts_delivery_attempt_key").on(
      table.deliveryId,
      table.attempt,
    ),
    foreignKey({
      columns: [table.deliveryId],
      foreignColumns: [webhookDeliveries.id],
      name: "webhook_delivery_attempts_delivery_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.endpointId],
      foreignColumns: [webhookEndpoints.id],
      name: "webhook_delivery_attempts_endpoint_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.teamId],
      foreignColumns: [teams.id],
      name: "webhook_delivery_attempts_team_id_fkey",
    }).onDelete("cascade"),
  ],
);

export const transactionEmbeddings = pgTable(
  "transaction_embeddings",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    transactionId: uuid("transaction_id").notNull(),
    teamId: uuid("team_id").notNull(),
    embedding: vector("embedding", { dimensions: 768 }),
    sourceText: text("source_text").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    model: text("model").notNull().default("gemini-embedding-001"),
  },
  (table) => [
    index("transaction_embeddings_transaction_id_idx").using(
      "btree",
      table.transactionId.asc().nullsLast().op("uuid_ops"),
    ),
    index("transaction_embeddings_team_id_idx").using(
      "btree",
      table.teamId.asc().nullsLast().op("uuid_ops"),
    ),
    // Vector similarity index for fast cosine similarity searches
    index("transaction_embeddings_vector_idx").using(
      "hnsw",
      table.embedding.op("vector_cosine_ops"),
    ),
    foreignKey({
      columns: [table.transactionId],
      foreignColumns: [transactions.id],
      name: "transaction_embeddings_transaction_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.teamId],
      foreignColumns: [teams.id],
      name: "transaction_embeddings_team_id_fkey",
    }).onDelete("cascade"),
    unique("transaction_embeddings_unique").on(table.transactionId),
  ],
);

export const inboxEmbeddings = pgTable(
  "inbox_embeddings",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    inboxId: uuid("inbox_id").notNull(),
    teamId: uuid("team_id").notNull(),
    embedding: vector("embedding", { dimensions: 768 }),
    sourceText: text("source_text").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    model: text("model").notNull().default("gemini-embedding-001"),
  },
  (table) => [
    index("inbox_embeddings_inbox_id_idx").using(
      "btree",
      table.inboxId.asc().nullsLast().op("uuid_ops"),
    ),
    index("inbox_embeddings_team_id_idx").using(
      "btree",
      table.teamId.asc().nullsLast().op("uuid_ops"),
    ),
    // Vector similarity index for fast cosine similarity searches
    index("inbox_embeddings_vector_idx").using(
      "hnsw",
      table.embedding.op("vector_cosine_ops"),
    ),
    foreignKey({
      columns: [table.inboxId],
      foreignColumns: [inbox.id],
      name: "inbox_embeddings_inbox_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.teamId],
      foreignColumns: [teams.id],
      name: "inbox_embeddings_team_id_fkey",
    }).onDelete("cascade"),
    unique("inbox_embeddings_unique").on(table.inboxId),
  ],
);

export const transactionMatchSuggestions = pgTable(
  "transaction_match_suggestions",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),

    // Core relationship
    teamId: uuid("team_id").notNull(),
    inboxId: uuid("inbox_id").notNull(),
    transactionId: uuid("transaction_id").notNull(),

    // Match scores for transparency
    confidenceScore: numericCasted("confidence_score", {
      precision: 4,
      scale: 3,
    }).notNull(),
    amountScore: numericCasted("amount_score", { precision: 4, scale: 3 }),
    currencyScore: numericCasted("currency_score", { precision: 4, scale: 3 }),
    dateScore: numericCasted("date_score", { precision: 4, scale: 3 }),
    embeddingScore: numericCasted("embedding_score", {
      precision: 4,
      scale: 3,
    }),
    nameScore: numericCasted("name_score", { precision: 4, scale: 3 }),

    // Match context
    matchType: text("match_type").notNull(), // 'auto_matched', 'high_confidence', 'suggested'
    matchDetails: jsonb("match_details"),

    // User interaction tracking
    status: text("status").default("pending").notNull(), // 'pending', 'confirmed', 'declined', 'expired', 'unmatched'
    userActionAt: timestamp("user_action_at", {
      withTimezone: true,
      mode: "string",
    }),
    userId: uuid("user_id"),
  },
  (table) => [
    index("transaction_match_suggestions_inbox_id_idx").using(
      "btree",
      table.inboxId.asc().nullsLast().op("uuid_ops"),
    ),
    index("transaction_match_suggestions_transaction_id_idx").using(
      "btree",
      table.transactionId.asc().nullsLast().op("uuid_ops"),
    ),
    index("transaction_match_suggestions_team_id_idx").using(
      "btree",
      table.teamId.asc().nullsLast().op("uuid_ops"),
    ),
    index("transaction_match_suggestions_status_idx").using(
      "btree",
      table.status.asc().nullsLast().op("text_ops"),
    ),
    index("transaction_match_suggestions_confidence_idx").using(
      "btree",
      table.confidenceScore.desc().nullsLast(),
    ),
    index("transaction_match_suggestions_lookup_idx").using(
      "btree",
      table.transactionId.asc().nullsLast().op("uuid_ops"),
      table.teamId.asc().nullsLast().op("uuid_ops"),
      table.status.asc().nullsLast().op("text_ops"),
    ),
    foreignKey({
      columns: [table.inboxId],
      foreignColumns: [inbox.id],
      name: "transaction_match_suggestions_inbox_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.transactionId],
      foreignColumns: [transactions.id],
      name: "transaction_match_suggestions_transaction_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.teamId],
      foreignColumns: [teams.id],
      name: "transaction_match_suggestions_team_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: "transaction_match_suggestions_user_id_fkey",
    }).onDelete("set null"),
    unique("transaction_match_suggestions_unique").on(
      table.inboxId,
      table.transactionId,
    ),
  ],
);

export const documentTagAssignments = pgTable(
  "document_tag_assignments",
  {
    documentId: uuid("document_id").notNull(),
    tagId: uuid("tag_id").notNull(),
    teamId: uuid("team_id").notNull(),
  },
  (table) => [
    index("idx_document_tag_assignments_document_id").using(
      "btree",
      table.documentId.asc().nullsLast().op("uuid_ops"),
    ),
    index("idx_document_tag_assignments_tag_id").using(
      "btree",
      table.tagId.asc().nullsLast().op("uuid_ops"),
    ),
    foreignKey({
      columns: [table.documentId],
      foreignColumns: [documents.id],
      name: "document_tag_assignments_document_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tagId],
      foreignColumns: [documentTags.id],
      name: "document_tag_assignments_tag_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.teamId],
      foreignColumns: [teams.id],
      name: "document_tag_assignments_team_id_fkey",
    }).onDelete("cascade"),
    primaryKey({
      columns: [table.documentId, table.tagId],
      name: "document_tag_assignments_pkey",
    }),
    unique("document_tag_assignments_unique").on(table.documentId, table.tagId),
    pgPolicy("Tags can be handled by a member of the team", {
      as: "permissive",
      for: "all",
      to: ["public"],
      using: sql`(team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user))`,
    }),
  ],
);

export const usersOnTeam = pgTable(
  "users_on_team",
  {
    userId: uuid("user_id").notNull(),
    teamId: uuid("team_id").notNull(),
    id: uuid().defaultRandom().notNull(),
    role: teamRolesEnum(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "string",
    }).defaultNow(),
  },
  (table) => [
    unique("users_on_team_id_key").on(table.id),
    index("users_on_team_team_id_idx").using(
      "btree",
      table.teamId.asc().nullsLast().op("uuid_ops"),
    ),
    index("users_on_team_user_id_idx").using(
      "btree",
      table.userId.asc().nullsLast().op("uuid_ops"),
    ),
    foreignKey({
      columns: [table.teamId],
      foreignColumns: [teams.id],
      name: "users_on_team_team_id_fkey",
    })
      .onUpdate("cascade")
      .onDelete("cascade"),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: "users_on_team_user_id_fkey",
    }).onDelete("cascade"),
    primaryKey({
      columns: [table.userId, table.teamId, table.id],
      name: "members_pkey",
    }),
    pgPolicy("Enable insert for authenticated users only", {
      as: "permissive",
      for: "insert",
      to: ["authenticated"],
      withCheck: sql`true`,
    }),
    pgPolicy("Enable updates for users on team", {
      as: "permissive",
      for: "update",
      to: ["authenticated"],
    }),
    pgPolicy("Select for current user teams", {
      as: "permissive",
      for: "select",
      to: ["authenticated"],
    }),
    pgPolicy("Users on team can be deleted by a member of the team", {
      as: "permissive",
      for: "delete",
      to: ["public"],
    }),
  ],
);

export const transactionCategories = pgTable(
  "transaction_categories",
  {
    id: uuid().defaultRandom().notNull().unique(),
    name: text().notNull(),
    teamId: uuid("team_id").notNull(),
    color: text(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "string",
    }).defaultNow(),
    system: boolean().default(false),
    slug: text(), // Generated in database
    taxRate: numericCasted("tax_rate", { precision: 10, scale: 2 }),
    taxType: text("tax_type"),
    taxReportingCode: text("tax_reporting_code"),
    excluded: boolean("excluded").default(false),
    description: text(),
    parentId: uuid("parent_id"),
  },
  (table) => [
    index("transaction_categories_team_id_idx").using(
      "btree",
      table.teamId.asc().nullsLast().op("uuid_ops"),
    ),
    index("transaction_categories_parent_id_idx").using(
      "btree",
      table.parentId.asc().nullsLast().op("uuid_ops"),
    ),
    foreignKey({
      columns: [table.teamId],
      foreignColumns: [teams.id],
      name: "transaction_categories_team_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.parentId],
      foreignColumns: [table.id],
      name: "transaction_categories_parent_id_fkey",
    }).onDelete("set null"),
    primaryKey({
      columns: [table.teamId, table.slug],
      name: "transaction_categories_pkey",
    }),
    unique("unique_team_slug").on(table.teamId, table.slug),
    pgPolicy("Users on team can manage categories", {
      as: "permissive",
      for: "all",
      to: ["public"],
      using: sql`(team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user))`,
    }),
  ],
);

export const authSessions = pgTable(
  "auth_sessions",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    token: text().notNull(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "date",
    })
      .defaultNow()
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: uuid("user_id").notNull(),
    activeOrganizationId: uuid("active_organization_id"),
  },
  (table) => [
    unique("auth_sessions_token_key").on(table.token),
    index("auth_sessions_user_id_idx").on(table.userId),
    index("auth_sessions_active_organization_id_idx").on(
      table.activeOrganizationId,
    ),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: "auth_sessions_user_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.activeOrganizationId],
      foreignColumns: [teams.id],
      name: "auth_sessions_active_organization_id_fkey",
    }).onDelete("set null"),
  ],
);

export const authAccounts = pgTable(
  "auth_accounts",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: uuid("user_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", {
      withTimezone: true,
      mode: "date",
    }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
      withTimezone: true,
      mode: "date",
    }),
    scope: text(),
    password: text(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "date",
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("auth_accounts_provider_account_key").on(
      table.providerId,
      table.accountId,
    ),
    index("auth_accounts_user_id_idx").on(table.userId),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: "auth_accounts_user_id_fkey",
    }).onDelete("cascade"),
  ],
);

export const authVerifications = pgTable(
  "auth_verifications",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    identifier: text().notNull(),
    value: text().notNull(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "date",
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [index("auth_verifications_identifier_idx").on(table.identifier)],
);

/**
 * Better Auth two-factor plugin state: the encrypted TOTP secret and the
 * encrypted list of unused recovery codes. One row per account.
 */
export const authTwoFactors = pgTable(
  "auth_two_factors",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    secret: text().notNull(),
    backupCodes: text("backup_codes").notNull(),
    userId: uuid("user_id").notNull(),
    verified: boolean().default(true).notNull(),
    failedVerificationCount: integer("failed_verification_count")
      .default(0)
      .notNull(),
    lockedUntil: timestamp("locked_until", {
      withTimezone: true,
      mode: "date",
    }),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "date",
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("auth_two_factors_user_id_key").on(table.userId),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: "auth_two_factors_user_id_fkey",
    }).onDelete("cascade"),
  ],
);

/**
 * Better Auth rate-limit counters, kept in the primary database so the
 * dashboard and API processes share one budget per client and path.
 */
export const authRateLimits = pgTable(
  "auth_rate_limits",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    key: text().notNull(),
    count: integer().notNull(),
    lastRequest: bigint("last_request", { mode: "number" }).notNull(),
  },
  (table) => [
    unique("auth_rate_limits_key_key").on(table.key),
    index("auth_rate_limits_last_request_idx").on(table.lastRequest),
  ],
);

export const shortLinks = pgTable(
  "short_links",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    shortId: text("short_id").notNull(),
    url: text().notNull(),
    type: text("type"),
    size: numericCasted("size", { precision: 10, scale: 2 }),
    mimeType: text("mime_type"),
    fileName: text("file_name"),
    teamId: uuid("team_id").notNull(),
    userId: uuid("user_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("short_links_short_id_idx").using(
      "btree",
      table.shortId.asc().nullsLast().op("text_ops"),
    ),
    index("short_links_team_id_idx").using(
      "btree",
      table.teamId.asc().nullsLast().op("uuid_ops"),
    ),
    index("short_links_user_id_idx").using(
      "btree",
      table.userId.asc().nullsLast().op("uuid_ops"),
    ),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: "short_links_user_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.teamId],
      foreignColumns: [teams.id],
      name: "short_links_team_id_fkey",
    }).onDelete("cascade"),
    unique("short_links_short_id_unique").on(table.shortId),
    pgPolicy("Short links can be created by a member of the team", {
      as: "permissive",
      for: "insert",
      to: ["authenticated"],
      withCheck: sql`(team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user))`,
    }),
    pgPolicy("Short links can be selected by a member of the team", {
      as: "permissive",
      for: "select",
      to: ["authenticated"],
      using: sql`(team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user))`,
    }),
    pgPolicy("Short links can be updated by a member of the team", {
      as: "permissive",
      for: "update",
      to: ["authenticated"],
      using: sql`(team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user))`,
    }),
    pgPolicy("Short links can be deleted by a member of the team", {
      as: "permissive",
      for: "delete",
      to: ["authenticated"],
      using: sql`(team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user))`,
    }),
  ],
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").notNull().defaultRandom().primaryKey(),
    keyEncrypted: text("key_encrypted").notNull(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    userId: uuid("user_id").notNull(),
    teamId: uuid("team_id").notNull(),
    keyHash: text("key_hash"),
    scopes: text("scopes").array().notNull().default(sql`'{}'::text[]`),
    lastUsedAt: timestamp("last_used_at", {
      withTimezone: true,
      mode: "string",
    }),
  },
  (table) => [
    index("api_keys_key_idx").using(
      "btree",
      table.keyHash.asc().nullsLast().op("text_ops"),
    ),
    index("api_keys_user_id_idx").using(
      "btree",
      table.userId.asc().nullsLast().op("uuid_ops"),
    ),
    index("api_keys_team_id_idx").using(
      "btree",
      table.teamId.asc().nullsLast().op("uuid_ops"),
    ),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: "api_keys_user_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.teamId],
      foreignColumns: [teams.id],
      name: "api_keys_team_id_fkey",
    }).onDelete("cascade"),
    unique("api_keys_key_unique").on(table.keyHash),
  ],
);

// Relations
// OAuth Applications
export const oauthApplications = pgTable(
  "oauth_applications",
  {
    id: uuid("id").notNull().defaultRandom().primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    description: text("description"),
    overview: text("overview"),
    developerName: text("developer_name"),
    logoUrl: text("logo_url"),
    website: text("website"),
    installUrl: text("install_url"),
    screenshots: text("screenshots").array().default(sql`'{}'::text[]`),
    redirectUris: text("redirect_uris").array().notNull(),
    clientId: text("client_id").notNull().unique(),
    clientSecret: text("client_secret").notNull(),
    scopes: text("scopes").array().notNull().default(sql`'{}'::text[]`),
    teamId: uuid("team_id").notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    isPublic: boolean("is_public").default(false),
    active: boolean("active").default(true),
    status: text("status", {
      enum: ["draft", "pending", "approved", "rejected"],
    }).default("draft"),
  },
  (table) => [
    index("oauth_applications_team_id_idx").using(
      "btree",
      table.teamId.asc().nullsLast().op("uuid_ops"),
    ),
    index("oauth_applications_client_id_idx").using(
      "btree",
      table.clientId.asc().nullsLast().op("text_ops"),
    ),
    index("oauth_applications_slug_idx").using(
      "btree",
      table.slug.asc().nullsLast().op("text_ops"),
    ),
    foreignKey({
      columns: [table.teamId],
      foreignColumns: [teams.id],
      name: "oauth_applications_team_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [users.id],
      name: "oauth_applications_created_by_fkey",
    }).onDelete("cascade"),
    pgPolicy("OAuth applications can be managed by team members", {
      as: "permissive",
      for: "all",
      to: ["public"],
      using: sql`(team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user))`,
    }),
  ],
);

// OAuth Authorization Codes
export const oauthAuthorizationCodes = pgTable(
  "oauth_authorization_codes",
  {
    id: uuid("id").notNull().defaultRandom().primaryKey(),
    code: text("code").notNull().unique(),
    applicationId: uuid("application_id").notNull(),
    userId: uuid("user_id").notNull(),
    teamId: uuid("team_id").notNull(),
    scopes: text("scopes").array().notNull(),
    redirectUri: text("redirect_uri").notNull(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    used: boolean("used").default(false),
    codeChallenge: text("code_challenge"),
    codeChallengeMethod: text("code_challenge_method"),
  },
  (table) => [
    index("oauth_authorization_codes_code_idx").using(
      "btree",
      table.code.asc().nullsLast().op("text_ops"),
    ),
    index("oauth_authorization_codes_application_id_idx").using(
      "btree",
      table.applicationId.asc().nullsLast().op("uuid_ops"),
    ),
    index("oauth_authorization_codes_user_id_idx").using(
      "btree",
      table.userId.asc().nullsLast().op("uuid_ops"),
    ),
    foreignKey({
      columns: [table.applicationId],
      foreignColumns: [oauthApplications.id],
      name: "oauth_authorization_codes_application_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: "oauth_authorization_codes_user_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.teamId],
      foreignColumns: [teams.id],
      name: "oauth_authorization_codes_team_id_fkey",
    }).onDelete("cascade"),
  ],
);

// OAuth Access Tokens
export const oauthAccessTokens = pgTable(
  "oauth_access_tokens",
  {
    id: uuid("id").notNull().defaultRandom().primaryKey(),
    token: text("token").notNull().unique(),
    refreshToken: text("refresh_token").unique(),
    applicationId: uuid("application_id").notNull(),
    userId: uuid("user_id").notNull(),
    teamId: uuid("team_id").notNull(),
    scopes: text("scopes").array().notNull(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
      withTimezone: true,
      mode: "string",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp("last_used_at", {
      withTimezone: true,
      mode: "string",
    }),
    revoked: boolean("revoked").default(false),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "string" }),
  },
  (table) => [
    index("oauth_access_tokens_token_idx").using(
      "btree",
      table.token.asc().nullsLast().op("text_ops"),
    ),
    index("oauth_access_tokens_refresh_token_idx").using(
      "btree",
      table.refreshToken.asc().nullsLast().op("text_ops"),
    ),
    index("oauth_access_tokens_application_id_idx").using(
      "btree",
      table.applicationId.asc().nullsLast().op("uuid_ops"),
    ),
    index("oauth_access_tokens_user_id_idx").using(
      "btree",
      table.userId.asc().nullsLast().op("uuid_ops"),
    ),
    foreignKey({
      columns: [table.applicationId],
      foreignColumns: [oauthApplications.id],
      name: "oauth_access_tokens_application_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: "oauth_access_tokens_user_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.teamId],
      foreignColumns: [teams.id],
      name: "oauth_access_tokens_team_id_fkey",
    }).onDelete("cascade"),
  ],
);

export const transactionsRelations = relations(
  transactions,
  ({ one, many }) => ({
    user: one(users, {
      fields: [transactions.assignedId],
      references: [users.id],
    }),
    team: one(teams, {
      fields: [transactions.teamId],
      references: [teams.id],
    }),
    bankAccount: one(bankAccounts, {
      fields: [transactions.bankAccountId],
      references: [bankAccounts.id],
    }),
    transactionCategory: one(transactionCategories, {
      fields: [transactions.teamId],
      references: [transactionCategories.teamId],
    }),
    transactionTags: many(transactionTags),
    transactionAttachments: many(transactionAttachments),
    inboxes: many(inbox),
  }),
);

export const usersRelations = relations(users, ({ one, many }) => ({
  transactions: many(transactions),
  trackerEntries: many(trackerEntries),
  bankAccounts: many(bankAccounts),
  invoices: many(invoices),
  trackerReports: many(trackerReports),
  reports: many(reports),
  userInvites: many(userInvites),
  documents: many(documents),
  apps: many(apps),
  apiKeys: many(apiKeys),
  shortLinks: many(shortLinks),
  oauthApplications: many(oauthApplications),
  oauthAuthorizationCodes: many(oauthAuthorizationCodes),
  oauthAccessTokens: many(oauthAccessTokens),
  webhookEndpoints: many(webhookEndpoints),
  team: one(teams, {
    fields: [users.teamId],
    references: [teams.id],
  }),
  usersOnTeams: many(usersOnTeam),
}));

export const shortLinksRelations = relations(shortLinks, ({ one }) => ({
  user: one(users, {
    fields: [shortLinks.userId],
    references: [users.id],
  }),
  team: one(teams, {
    fields: [shortLinks.teamId],
    references: [teams.id],
  }),
}));

export const apiKeysRelations = relations(apiKeys, ({ one }) => ({
  user: one(users, {
    fields: [apiKeys.userId],
    references: [users.id],
  }),
  team: one(teams, {
    fields: [apiKeys.teamId],
    references: [teams.id],
  }),
}));

export const teamsRelations = relations(teams, ({ many }) => ({
  transactions: many(transactions),
  trackerEntries: many(trackerEntries),
  customerTags: many(customerTags),
  inboxAccounts: many(inboxAccounts),
  bankAccounts: many(bankAccounts),
  invoices: many(invoices),
  customers: many(customers),
  tags: many(tags),
  trackerReports: many(trackerReports),
  trackerProjectTags: many(trackerProjectTags),
  reports: many(reports),
  bankConnections: many(bankConnections),
  userInvites: many(userInvites),
  documentTags: many(documentTags),
  transactionTags: many(transactionTags),
  transactionAttachments: many(transactionAttachments),
  documents: many(documents),
  apps: many(apps),
  apiKeys: many(apiKeys),
  shortLinks: many(shortLinks),
  invoiceTemplates: many(invoiceTemplates),
  transactionEnrichments: many(transactionEnrichments),
  users: many(users),
  trackerProjects: many(trackerProjects),
  inboxes: many(inbox),
  documentTagAssignments: many(documentTagAssignments),
  usersOnTeams: many(usersOnTeam),
  transactionCategories: many(transactionCategories),
  webhookEndpoints: many(webhookEndpoints),
  webhookDeliveries: many(webhookDeliveries),
  webhookDeliveryAttempts: many(webhookDeliveryAttempts),
}));

export const bankAccountsRelations = relations(
  bankAccounts,
  ({ one, many }) => ({
    transactions: many(transactions),
    bankConnection: one(bankConnections, {
      fields: [bankAccounts.bankConnectionId],
      references: [bankConnections.id],
    }),
    user: one(users, {
      fields: [bankAccounts.createdBy],
      references: [users.id],
    }),
    team: one(teams, {
      fields: [bankAccounts.teamId],
      references: [teams.id],
    }),
  }),
);

export const transactionCategoriesRelations = relations(
  transactionCategories,
  ({ one, many }) => ({
    transactions: many(transactions),
    transactionEnrichments: many(transactionEnrichments),
    team: one(teams, {
      fields: [transactionCategories.teamId],
      references: [teams.id],
    }),
    parent: one(transactionCategories, {
      fields: [transactionCategories.parentId],
      references: [transactionCategories.id],
      relationName: "parent_child",
    }),
    children: many(transactionCategories, {
      relationName: "parent_child",
    }),
  }),
);

export const trackerEntriesRelations = relations(trackerEntries, ({ one }) => ({
  user: one(users, {
    fields: [trackerEntries.assignedId],
    references: [users.id],
  }),
  trackerProject: one(trackerProjects, {
    fields: [trackerEntries.projectId],
    references: [trackerProjects.id],
  }),
  team: one(teams, {
    fields: [trackerEntries.teamId],
    references: [teams.id],
  }),
}));

export const trackerProjectsRelations = relations(
  trackerProjects,
  ({ one, many }) => ({
    trackerEntries: many(trackerEntries),
    trackerReports: many(trackerReports),
    trackerProjectTags: many(trackerProjectTags),
    customer: one(customers, {
      fields: [trackerProjects.customerId],
      references: [customers.id],
    }),
    team: one(teams, {
      fields: [trackerProjects.teamId],
      references: [teams.id],
    }),
  }),
);

export const customerTagsRelations = relations(customerTags, ({ one }) => ({
  customer: one(customers, {
    fields: [customerTags.customerId],
    references: [customers.id],
  }),
  tag: one(tags, {
    fields: [customerTags.tagId],
    references: [tags.id],
  }),
  team: one(teams, {
    fields: [customerTags.teamId],
    references: [teams.id],
  }),
}));

export const customersRelations = relations(customers, ({ one, many }) => ({
  customerTags: many(customerTags),
  invoices: many(invoices),
  team: one(teams, {
    fields: [customers.teamId],
    references: [teams.id],
  }),
  trackerProjects: many(trackerProjects),
}));

export const tagsRelations = relations(tags, ({ one, many }) => ({
  customerTags: many(customerTags),
  team: one(teams, {
    fields: [tags.teamId],
    references: [teams.id],
  }),
  trackerProjectTags: many(trackerProjectTags),
  transactionTags: many(transactionTags),
}));

export const inboxAccountsRelations = relations(inboxAccounts, ({ one }) => ({
  team: one(teams, {
    fields: [inboxAccounts.teamId],
    references: [teams.id],
  }),
}));

export const bankConnectionsRelations = relations(
  bankConnections,
  ({ one, many }) => ({
    bankAccounts: many(bankAccounts),
    team: one(teams, {
      fields: [bankConnections.teamId],
      references: [teams.id],
    }),
  }),
);

export const invoicesRelations = relations(invoices, ({ one }) => ({
  user: one(users, {
    fields: [invoices.userId],
    references: [users.id],
  }),
  customer: one(customers, {
    fields: [invoices.customerId],
    references: [customers.id],
  }),
  team: one(teams, {
    fields: [invoices.teamId],
    references: [teams.id],
  }),
}));

export const trackerReportsRelations = relations(trackerReports, ({ one }) => ({
  user: one(users, {
    fields: [trackerReports.createdBy],
    references: [users.id],
  }),
  trackerProject: one(trackerProjects, {
    fields: [trackerReports.projectId],
    references: [trackerProjects.id],
  }),
  team: one(teams, {
    fields: [trackerReports.teamId],
    references: [teams.id],
  }),
}));

export const trackerProjectTagsRelations = relations(
  trackerProjectTags,
  ({ one }) => ({
    tag: one(tags, {
      fields: [trackerProjectTags.tagId],
      references: [tags.id],
    }),
    trackerProject: one(trackerProjects, {
      fields: [trackerProjectTags.trackerProjectId],
      references: [trackerProjects.id],
    }),
    team: one(teams, {
      fields: [trackerProjectTags.teamId],
      references: [teams.id],
    }),
  }),
);

export const reportsRelations = relations(reports, ({ one }) => ({
  user: one(users, {
    fields: [reports.createdBy],
    references: [users.id],
  }),
  team: one(teams, {
    fields: [reports.teamId],
    references: [teams.id],
  }),
}));

export const userInvitesRelations = relations(userInvites, ({ one }) => ({
  team: one(teams, {
    fields: [userInvites.teamId],
    references: [teams.id],
  }),
  user: one(users, {
    fields: [userInvites.invitedBy],
    references: [users.id],
  }),
}));

export const documentTagsRelations = relations(
  documentTags,
  ({ one, many }) => ({
    team: one(teams, {
      fields: [documentTags.teamId],
      references: [teams.id],
    }),
    documentTagAssignments: many(documentTagAssignments),
  }),
);

export const transactionTagsRelations = relations(
  transactionTags,
  ({ one }) => ({
    tag: one(tags, {
      fields: [transactionTags.tagId],
      references: [tags.id],
    }),
    team: one(teams, {
      fields: [transactionTags.teamId],
      references: [teams.id],
    }),
    transaction: one(transactions, {
      fields: [transactionTags.transactionId],
      references: [transactions.id],
    }),
  }),
);

export const transactionAttachmentsRelations = relations(
  transactionAttachments,
  ({ one, many }) => ({
    team: one(teams, {
      fields: [transactionAttachments.teamId],
      references: [teams.id],
    }),
    transaction: one(transactions, {
      fields: [transactionAttachments.transactionId],
      references: [transactions.id],
    }),
    inboxes: many(inbox),
  }),
);

export const documentsRelations = relations(documents, ({ one, many }) => ({
  user: one(users, {
    fields: [documents.ownerId],
    references: [users.id],
  }),
  team: one(teams, {
    fields: [documents.teamId],
    references: [teams.id],
  }),
  documentTagAssignments: many(documentTagAssignments),
}));

export const appsRelations = relations(apps, ({ one }) => ({
  user: one(users, {
    fields: [apps.createdBy],
    references: [users.id],
  }),
  team: one(teams, {
    fields: [apps.teamId],
    references: [teams.id],
  }),
}));

export const invoiceTemplatesRelations = relations(
  invoiceTemplates,
  ({ one }) => ({
    team: one(teams, {
      fields: [invoiceTemplates.teamId],
      references: [teams.id],
    }),
  }),
);

export const transactionEnrichmentsRelations = relations(
  transactionEnrichments,
  ({ one }) => ({
    transactionCategory: one(transactionCategories, {
      fields: [transactionEnrichments.teamId],
      references: [transactionCategories.teamId],
    }),
    team: one(teams, {
      fields: [transactionEnrichments.teamId],
      references: [teams.id],
    }),
  }),
);

export const inboxRelations = relations(inbox, ({ one }) => ({
  transactionAttachment: one(transactionAttachments, {
    fields: [inbox.attachmentId],
    references: [transactionAttachments.id],
  }),
  team: one(teams, {
    fields: [inbox.teamId],
    references: [teams.id],
  }),
  transaction: one(transactions, {
    fields: [inbox.transactionId],
    references: [transactions.id],
  }),
}));

export const documentTagAssignmentsRelations = relations(
  documentTagAssignments,
  ({ one }) => ({
    document: one(documents, {
      fields: [documentTagAssignments.documentId],
      references: [documents.id],
    }),
    documentTag: one(documentTags, {
      fields: [documentTagAssignments.tagId],
      references: [documentTags.id],
    }),
    team: one(teams, {
      fields: [documentTagAssignments.teamId],
      references: [teams.id],
    }),
  }),
);

export const usersOnTeamRelations = relations(usersOnTeam, ({ one }) => ({
  team: one(teams, {
    fields: [usersOnTeam.teamId],
    references: [teams.id],
  }),
  user: one(users, {
    fields: [usersOnTeam.userId],
    references: [users.id],
  }),
}));

// OAuth Relations
export const oauthApplicationsRelations = relations(
  oauthApplications,
  ({ one, many }) => ({
    team: one(teams, {
      fields: [oauthApplications.teamId],
      references: [teams.id],
    }),
    createdBy: one(users, {
      fields: [oauthApplications.createdBy],
      references: [users.id],
    }),
    authorizationCodes: many(oauthAuthorizationCodes),
    accessTokens: many(oauthAccessTokens),
  }),
);

export const oauthAuthorizationCodesRelations = relations(
  oauthAuthorizationCodes,
  ({ one }) => ({
    application: one(oauthApplications, {
      fields: [oauthAuthorizationCodes.applicationId],
      references: [oauthApplications.id],
    }),
    user: one(users, {
      fields: [oauthAuthorizationCodes.userId],
      references: [users.id],
    }),
    team: one(teams, {
      fields: [oauthAuthorizationCodes.teamId],
      references: [teams.id],
    }),
  }),
);

export const oauthAccessTokensRelations = relations(
  oauthAccessTokens,
  ({ one }) => ({
    application: one(oauthApplications, {
      fields: [oauthAccessTokens.applicationId],
      references: [oauthApplications.id],
    }),
    user: one(users, {
      fields: [oauthAccessTokens.userId],
      references: [users.id],
    }),
    team: one(teams, {
      fields: [oauthAccessTokens.teamId],
      references: [teams.id],
    }),
  }),
);

export const activities = pgTable(
  "activities",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),

    // Core fields
    teamId: uuid("team_id").notNull(),
    userId: uuid("user_id"),
    type: activityTypeEnum().notNull(),
    priority: smallint().default(5), // 1-3 = notifications, 4-10 = insights only

    // Group related activities together (e.g., same business event across multiple users)
    groupId: uuid("group_id"),

    // Source of the activity
    source: activitySourceEnum().notNull(),

    // All the data
    metadata: jsonb().notNull(),

    // Simple lifecycle (only for notifications)
    status: activityStatusEnum().default("unread").notNull(),

    // Timestamp of last system use (e.g. insight generation, digest inclusion)
    lastUsedAt: timestamp("last_used_at", {
      withTimezone: true,
      mode: "string",
    }),
  },
  (table) => [
    // Optimized indexes
    index("activities_notifications_idx").using(
      "btree",
      table.teamId,
      table.priority,
      table.status,
      table.createdAt.desc(),
    ),
    index("activities_insights_idx").using(
      "btree",
      table.teamId,
      table.type,
      table.source,
      table.createdAt.desc(),
    ),
    index("activities_metadata_gin_idx").using("gin", table.metadata),
    index("activities_group_id_idx").on(table.groupId),
    index("activities_insights_group_idx").using(
      "btree",
      table.teamId,
      table.groupId,
      table.type,
      table.createdAt.desc(),
    ),

    // Foreign keys
    foreignKey({
      columns: [table.teamId],
      foreignColumns: [teams.id],
      name: "activities_team_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: "activities_user_id_fkey",
    }).onDelete("set null"),
  ],
);

export const notificationSettings = pgTable(
  "notification_settings",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    userId: uuid("user_id").notNull(),
    teamId: uuid("team_id").notNull(),
    notificationType: text("notification_type").notNull(),
    channel: text("channel").notNull(), // 'in_app', 'email', 'push'
    enabled: boolean().default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("notification_settings_user_team_type_channel_key").on(
      table.userId,
      table.teamId,
      table.notificationType,
      table.channel,
    ),
    index("notification_settings_user_team_idx").on(table.userId, table.teamId),
    index("notification_settings_type_channel_idx").on(
      table.notificationType,
      table.channel,
    ),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: "notification_settings_user_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.teamId],
      foreignColumns: [teams.id],
      name: "notification_settings_team_id_fkey",
    }).onDelete("cascade"),
    pgPolicy("Users can manage their own notification settings", {
      as: "permissive",
      for: "all",
      to: ["public"],
      using: sql`(user_id = auth.uid())`,
    }),
  ],
);
