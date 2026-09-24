import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gte,
  inArray,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import type { AnyPgColumn, AnyPgTable } from "drizzle-orm/pg-core";
import { primaryDb } from "./client";
import {
  apps,
  bankAccounts,
  bankConnections,
  documents,
  exchangeRates,
  inbox,
  invoices,
  teams,
  transactionAttachments,
  transactions,
  users,
  usersOnTeam,
} from "./schema";
import {
  signedUrl as createSignedUrl,
  download as downloadFile,
  upload as uploadFile,
} from "./storage";

const tables = {
  apps,
  bank_accounts: bankAccounts,
  bank_connections: bankConnections,
  documents,
  exchange_rates: exchangeRates,
  inbox,
  invoices,
  teams,
  transaction_attachments: transactionAttachments,
  transactions,
  users,
  users_on_team: usersOnTeam,
} satisfies Record<string, AnyPgTable>;

type TableName = keyof typeof tables;
type Row = Record<string, any>;
type Result = { data: any; error: Error | null; count?: number };

function getColumn(table: AnyPgTable, name: string): AnyPgColumn {
  const column = Object.values(getTableColumns(table)).find(
    (candidate) => candidate.name === name,
  );

  if (!column) {
    throw new Error(`Unknown column ${name}`);
  }

  return column;
}

function getColumnKey(table: AnyPgTable, name: string) {
  const entry = Object.entries(getTableColumns(table)).find(
    ([, candidate]) => candidate.name === name,
  );

  if (!entry) {
    throw new Error(`Unknown column ${name}`);
  }

  return entry[0];
}

function toDrizzleRow(table: AnyPgTable, row: Row) {
  return Object.fromEntries(
    Object.entries(row)
      .filter(([, value]) => value !== undefined)
      .map(([name, value]) => [getColumnKey(table, name), value]),
  );
}

function getProjection(table: AnyPgTable, selection = "*") {
  const columns = Object.values(getTableColumns(table));
  const selected =
    selection.trim() === "*"
      ? columns
      : selection
          .split(",")
          .map((name) => getColumn(table, name.trim()))
          .filter(Boolean);

  return Object.fromEntries(selected.map((column) => [column.name, column]));
}

class LegacyQuery implements PromiseLike<Result> {
  private action: "select" | "insert" | "update" | "upsert" | "delete" =
    "select";
  private countRequested = false;
  private filters: any[] = [];
  private input: Row | Row[] | undefined;
  private isSingle = false;
  private orderBy: { column: AnyPgColumn; ascending: boolean } | undefined;
  private selection = "*";
  private shouldThrow = false;
  private upsertOptions:
    | { onConflict?: string; ignoreDuplicates?: boolean }
    | undefined;

  constructor(private table: AnyPgTable) {}

  select(selection = "*", options?: { count?: "exact" }) {
    this.selection = selection;
    this.countRequested = options?.count === "exact";
    return this;
  }

  insert(input: Row | Row[]) {
    this.action = "insert";
    this.input = input;
    return this;
  }

  update(input: Row) {
    this.action = "update";
    this.input = input;
    return this;
  }

  upsert(
    input: Row | Row[],
    options?: { onConflict?: string; ignoreDuplicates?: boolean },
  ) {
    this.action = "upsert";
    this.input = input;
    this.upsertOptions = options;
    return this;
  }

  delete() {
    this.action = "delete";
    return this;
  }

  eq(name: string, value: any) {
    this.filters.push(eq(getColumn(this.table, name), value));
    return this;
  }

  gte(name: string, value: any) {
    this.filters.push(gte(getColumn(this.table, name), value));
    return this;
  }

  in(name: string, values: any[]) {
    this.filters.push(inArray(getColumn(this.table, name), values));
    return this;
  }

  or(expression: string) {
    const conditions = expression.split(",").map((part) => {
      const [name, operator, rawValue] = part.split(".");
      const column = getColumn(this.table, name!);

      if (operator === "lt") return lt(column, Number(rawValue));
      if (operator === "is" && rawValue === "null") return isNull(column);

      throw new Error(`Unsupported legacy filter: ${part}`);
    });

    this.filters.push(or(...conditions));
    return this;
  }

  order(name: string, options?: { ascending?: boolean }) {
    this.orderBy = {
      column: getColumn(this.table, name),
      ascending: options?.ascending ?? true,
    };
    return this;
  }

  single() {
    this.isSingle = true;
    return this;
  }

  throwOnError() {
    this.shouldThrow = true;
    return this;
  }

  // biome-ignore lint/suspicious/noThenProperty: inherited callers await this Supabase-compatible query builder.
  then<TResult1 = Result, TResult2 = never>(
    onfulfilled?: ((value: Result) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  private async execute(): Promise<Result> {
    try {
      const projection = getProjection(this.table, this.selection);
      const where = this.filters.length > 0 ? and(...this.filters) : undefined;
      let rows: Row[] = [];

      if (this.action === "select") {
        let query: any = primaryDb
          .select(projection)
          .from(this.table)
          .where(where);
        if (this.orderBy) {
          query = query.orderBy(
            this.orderBy.ascending
              ? asc(this.orderBy.column)
              : desc(this.orderBy.column),
          );
        }
        rows = await query;
      } else if (this.action === "update") {
        let query: any = primaryDb
          .update(this.table)
          .set(toDrizzleRow(this.table, this.input as Row))
          .where(where);
        if (this.selection) query = query.returning(projection);
        rows = await query;
      } else if (this.action === "delete") {
        let query: any = primaryDb.delete(this.table).where(where);
        if (this.selection) query = query.returning(projection);
        rows = await query;
      } else {
        const values = (
          Array.isArray(this.input) ? this.input : [this.input]
        ).map((row) => toDrizzleRow(this.table, row ?? {}));
        let query: any = primaryDb.insert(this.table).values(values);

        if (this.action === "upsert") {
          const defaultConflict = this.table === apps ? "team_id,app_id" : "id";
          const conflictColumns = (
            this.upsertOptions?.onConflict ?? defaultConflict
          )
            .split(",")
            .map((name) => getColumn(this.table, name.trim()));

          if (this.upsertOptions?.ignoreDuplicates) {
            query = query.onConflictDoNothing({ target: conflictColumns });
          } else {
            const first = values[0] ?? {};
            const conflictKeys = new Set(
              conflictColumns.map((column) =>
                getColumnKey(this.table, column.name),
              ),
            );
            const set = Object.fromEntries(
              Object.keys(first)
                .filter((key) => !conflictKeys.has(key))
                .map((key) => {
                  const column = getTableColumns(this.table)[key];
                  return [key, sql.raw(`excluded."${column!.name}"`)];
                }),
            );
            query = query.onConflictDoUpdate({
              target: conflictColumns,
              set,
            });
          }
        }

        if (this.selection) query = query.returning(projection);
        rows = await query;
      }

      return {
        data: this.isSingle ? (rows[0] ?? null) : rows,
        error: null,
        ...(this.countRequested ? { count: rows.length } : {}),
      };
    } catch (error) {
      const normalized =
        error instanceof Error ? error : new Error(String(error));
      if (this.shouldThrow) throw normalized;
      return { data: null, error: normalized };
    }
  }
}

export type LegacyDatabaseClient = ReturnType<typeof createClient>;

export function createClient() {
  return {
    from(name: TableName) {
      const table = tables[name];
      if (!table) throw new Error(`Unknown table ${name}`);
      return new LegacyQuery(table);
    },
    async rpc(name: string, params: { account_id?: string }) {
      if (name !== "get_all_transactions_by_account" || !params.account_id) {
        return {
          data: null,
          error: new Error(`Unsupported database RPC ${name}`),
        };
      }

      const projection = getProjection(transactions);
      const data = await primaryDb
        .select(projection)
        .from(transactions)
        .where(eq(transactions.bankAccountId, params.account_id));

      return { data, error: null };
    },
    storage: {
      from(bucket: string) {
        return {
          async download(path: string) {
            try {
              return {
                data: await downloadFile({ bucket, path }),
                error: null,
              };
            } catch (error) {
              return {
                data: null,
                error:
                  error instanceof Error ? error : new Error(String(error)),
              };
            }
          },
          async upload(
            path: string,
            file: Blob | Buffer | Uint8Array | ArrayBuffer,
            options?: { contentType?: string; upsert?: boolean },
          ) {
            try {
              return {
                data: await uploadFile({
                  bucket,
                  path,
                  file,
                  contentType: options?.contentType,
                }),
                error: null,
              };
            } catch (error) {
              return {
                data: null,
                error:
                  error instanceof Error ? error : new Error(String(error)),
              };
            }
          },
          async createSignedUrl(
            path: string,
            expireIn: number,
            // Capability URLs are only minted against a workspace document.
            inboxId: string,
            options?: { download?: boolean },
          ) {
            try {
              return {
                data: {
                  signedUrl: await createSignedUrl({
                    bucket,
                    path,
                    expireIn,
                    inboxId,
                    options,
                  }),
                },
                error: null,
              };
            } catch (error) {
              return {
                data: null,
                error:
                  error instanceof Error ? error : new Error(String(error)),
              };
            }
          },
        };
      },
    },
  };
}
