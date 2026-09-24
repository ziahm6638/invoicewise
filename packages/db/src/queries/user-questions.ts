import type { Database, DatabaseWithPrimary } from "@invoicewise/db/client";
import { userQuestions } from "@invoicewise/db/schema";
import { and, asc, desc, eq } from "drizzle-orm";

export type UserQuestionType = "boolean" | "choice" | "score";

export type UserQuestionInput = {
  question: string;
  type: UserQuestionType;
  options?: string[] | null;
  context?: string | null;
  enabled: boolean;
};

const DEFAULT_QUESTIONS = [
  {
    questionKey: "likely_duplicate",
    label: "Likely duplicate",
    question:
      "Is `currentInvoice` likely a duplicate of any entry in `previousInvoices`?",
    context:
      "Answer yes when the supplier and invoice number match, or when supplier, date, and gross amount strongly indicate the same invoice.",
  },
  {
    questionKey: "vat_calculation_correct",
    label: "VAT calculation correct",
    question:
      "Is the VAT calculation on `currentInvoice` arithmetically correct, so net amount plus VAT amount equals gross amount?",
    context:
      "Allow normal currency rounding. Answer no when the amounts do not reconcile.",
  },
  {
    questionKey: "known_supplier",
    label: "Known supplier",
    question:
      "Does `currentInvoice.supplierName` identify a supplier present in `previousInvoices`?",
    context:
      "Allow ordinary legal-name variations. Answer no when no previous invoice is from this supplier.",
  },
  {
    questionKey: "bank_details_consistent",
    label: "Bank details consistent",
    question:
      "Are `currentInvoice.bankDetails` consistent with bank details on previous invoices from the same supplier?",
    context:
      "Answer no when material bank identifiers differ from a previous invoice from this supplier.",
  },
] as const;

const latestOnly = <T extends { questionKey: string }>(rows: T[]) => {
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.questionKey)) return false;
    seen.add(row.questionKey);
    return true;
  });
};

export async function ensureDefaultUserQuestions(db: Database, teamId: string) {
  await db
    .insert(userQuestions)
    .values(
      DEFAULT_QUESTIONS.map((question) => ({
        ...question,
        teamId,
        version: 1,
        type: "boolean" as const,
        enabled: true,
        isDefault: true,
      })),
    )
    .onConflictDoNothing({
      target: [
        userQuestions.teamId,
        userQuestions.questionKey,
        userQuestions.version,
      ],
    });
}

export async function getUserQuestions(db: Database, teamId: string) {
  await ensureDefaultUserQuestions(db, teamId);
  const readDb = (db as DatabaseWithPrimary).usePrimaryOnly?.() ?? db;
  const rows = await readDb
    .select()
    .from(userQuestions)
    .where(eq(userQuestions.teamId, teamId))
    .orderBy(asc(userQuestions.questionKey), desc(userQuestions.version));

  return latestOnly(rows).filter((question) => !question.deletedAt);
}

export async function getUserQuestionVersions(
  db: Database,
  params: { teamId: string; questionKey: string },
) {
  return db
    .select()
    .from(userQuestions)
    .where(
      and(
        eq(userQuestions.teamId, params.teamId),
        eq(userQuestions.questionKey, params.questionKey),
      ),
    )
    .orderBy(desc(userQuestions.version));
}

async function getLatestUserQuestion(
  db: Database,
  params: { teamId: string; questionKey: string },
) {
  const [question] = await db
    .select()
    .from(userQuestions)
    .where(
      and(
        eq(userQuestions.teamId, params.teamId),
        eq(userQuestions.questionKey, params.questionKey),
      ),
    )
    .orderBy(desc(userQuestions.version))
    .limit(1);
  return question;
}

export async function createUserQuestion(
  db: Database,
  params: UserQuestionInput & { teamId: string; userId: string },
) {
  const questionKey = crypto.randomUUID();
  const [question] = await db
    .insert(userQuestions)
    .values({
      ...params,
      questionKey,
      version: 1,
      label: params.question,
      options: params.options ?? null,
      context: params.context ?? null,
      isDefault: false,
      createdBy: params.userId,
    })
    .returning();
  return question;
}

export async function updateUserQuestion(
  db: Database,
  params: UserQuestionInput & {
    teamId: string;
    userId: string;
    questionKey: string;
  },
) {
  const current = await getLatestUserQuestion(db, params);
  if (!current || current.deletedAt) return null;
  if (
    current.isDefault &&
    (params.question !== current.question ||
      params.type !== current.type ||
      JSON.stringify(params.options ?? null) !==
        JSON.stringify(current.options ?? null) ||
      (params.context ?? null) !== current.context)
  ) {
    throw new Error("Default questions can only be enabled or disabled");
  }

  const [question] = await db
    .insert(userQuestions)
    .values({
      questionKey: current.questionKey,
      teamId: current.teamId,
      version: current.version + 1,
      label: current.isDefault ? current.label : params.question,
      question: params.question,
      type: params.type,
      options: params.options ?? null,
      context: params.context ?? null,
      enabled: params.enabled,
      isDefault: current.isDefault,
      createdBy: params.userId,
    })
    .returning();
  return question;
}

export async function deleteUserQuestion(
  db: Database,
  params: { teamId: string; userId: string; questionKey: string },
) {
  const current = await getLatestUserQuestion(db, params);
  if (!current || current.deletedAt) return null;
  if (current.isDefault) {
    throw new Error("Default questions cannot be deleted");
  }

  const [question] = await db
    .insert(userQuestions)
    .values({
      questionKey: current.questionKey,
      teamId: current.teamId,
      version: current.version + 1,
      label: current.label,
      question: current.question,
      type: current.type,
      options: current.options,
      context: current.context,
      enabled: false,
      isDefault: false,
      deletedAt: new Date().toISOString(),
      createdBy: params.userId,
    })
    .returning();
  return question;
}
