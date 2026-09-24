/**
 * The open-startup metrics charts read a legacy Supabase dataset that is not
 * part of the InvoiceWise stack. Treat "no dataset configured" as "not
 * published" and never fabricate zero counts; the marketing rewrite in #16 owns
 * replacing these pages with real service metrics.
 */
export function isStatsConfigured() {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY,
  );
}

export const emptyStats = {
  users: null,
  transactions: null,
  bankAccounts: null,
  trackerEntries: null,
  inboxItems: null,
  bankConnections: null,
  trackerProjects: null,
  reports: null,
  vaultObjects: null,
  transactionEnrichments: null,
  invoices: null,
  invoiceCustomers: null,
} as const;
