import {
  assignInvoiceSupplierSchema,
  mergeSuppliersSchema,
  revertSupplierChangeSchema,
  supplierInvoiceSchema,
} from "@api/schemas/suppliers";
import {
  adminProcedure,
  createTRPCRouter,
  workspaceProcedure,
} from "@api/trpc/init";
import {
  getInboxRedeliveries,
  getInboxSupplierState,
  getInvoiceSummaries,
  getSupplierWithMembers,
  listSupplierEvents,
  listSuppliers,
  roleAtLeast,
} from "@invoicewise/db/queries";
import {
  SupplierCorrectionError,
  mergeSuppliers,
  reassignInvoiceSupplier,
  revertSupplierChange,
} from "@invoicewise/jobs/suppliers";
import { TRPCError } from "@trpc/server";

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};

/** Every earlier document a stored supplier check cites as evidence. */
const evidenceIds = (checks: unknown) => {
  const record = asRecord(checks);
  const ids = new Set<string>();
  for (const key of ["known", "duplicate", "bankDetails"]) {
    const evidence = asRecord(record[key]).evidence;
    if (!Array.isArray(evidence)) continue;
    for (const item of evidence) {
      const id = asRecord(item).invoiceId;
      if (typeof id === "string") ids.add(id);
    }
  }
  return [...ids];
};

const correctionError = (error: unknown) => {
  if (error instanceof SupplierCorrectionError) {
    return new TRPCError({
      code:
        error.code === "not_found"
          ? "NOT_FOUND"
          : error.code === "conflict"
            ? "CONFLICT"
            : "BAD_REQUEST",
      message: error.message,
    });
  }
  return error;
};

const correcting = async <T>(work: () => Promise<T>) => {
  try {
    return await work();
  } catch (error) {
    throw correctionError(error);
  }
};

export const suppliersRouter = createTRPCRouter({
  list: workspaceProcedure.query(({ ctx: { db, teamId } }) =>
    listSuppliers(db, teamId!),
  ),

  /**
   * An invoice's supplier, its stored supplier-history checks with the
   * documents they cite, its re-deliveries and the supplier's corrections.
   */
  forInvoice: workspaceProcedure
    .input(supplierInvoiceSchema)
    .query(async ({ ctx: { db, teamId, teamRole }, input }) => {
      const state = await getInboxSupplierState(db, {
        teamId: teamId!,
        inboxId: input.inboxId,
      });
      if (!state || state.status === "deleted") return null;
      const supplier = state.supplierId
        ? await getSupplierWithMembers(db, {
            teamId: teamId!,
            supplierId: state.supplierId,
          })
        : null;
      const [evidence, redeliveries, events] = await Promise.all([
        getInvoiceSummaries(db, {
          teamId: teamId!,
          ids: evidenceIds(state.supplierChecks),
        }),
        getInboxRedeliveries(db, {
          teamId: teamId!,
          inboxId: input.inboxId,
        }),
        listSupplierEvents(db, {
          teamId: teamId!,
          supplierIds: supplier
            ? [supplier.id, ...supplier.members.map((member) => member.id)]
            : [],
          inboxId: input.inboxId,
        }),
      ]);
      return {
        supplier,
        resolution: state.supplierResolution,
        checks: state.supplierChecks,
        evidence,
        redeliveries,
        events,
        canCorrect: roleAtLeast(teamRole, "admin"),
      };
    }),

  assignInvoice: adminProcedure
    .input(assignInvoiceSupplierSchema)
    .mutation(({ ctx: { db, teamId, session }, input }) =>
      correcting(() =>
        reassignInvoiceSupplier(db, {
          teamId: teamId!,
          actorId: session.user.id,
          ...input,
        }),
      ),
    ),

  merge: adminProcedure
    .input(mergeSuppliersSchema)
    .mutation(({ ctx: { db, teamId, session }, input }) =>
      correcting(() =>
        mergeSuppliers(db, {
          teamId: teamId!,
          actorId: session.user.id,
          ...input,
        }),
      ),
    ),

  revert: adminProcedure
    .input(revertSupplierChangeSchema)
    .mutation(({ ctx: { db, teamId, session }, input }) =>
      correcting(() =>
        revertSupplierChange(db, {
          teamId: teamId!,
          actorId: session.user.id,
          ...input,
        }),
      ),
    ),
});
