import { updateDeliveryPolicySchema } from "@api/schemas/delivery-rules";
import { createTRPCRouter, workspaceProcedure } from "@api/trpc/init";
import { listDeliveryPolicyVersions } from "@invoicewise/db/queries";
import { InvoiceActionError } from "@invoicewise/jobs/delivery";
import {
  loadDeliveryPolicy,
  policyQuestions,
  saveDeliveryPolicy,
} from "@invoicewise/jobs/delivery-rules";
import { TRPCError } from "@trpc/server";

const ACTION_ERROR_CODE = {
  not_found: "NOT_FOUND",
  conflict: "CONFLICT",
  invalid: "BAD_REQUEST",
  forbidden: "FORBIDDEN",
} as const;

/**
 * The workspace's delivery rules (docs/delivery.md#delivery-rules). Every
 * member can read them; `update` saves a new version and needs an owner or
 * admin, which `saveDeliveryPolicy` enforces.
 */
export const deliveryRulesRouter = createTRPCRouter({
  get: workspaceProcedure.query(async ({ ctx: { db, teamId } }) => {
    const [current, versions, questions] = await Promise.all([
      loadDeliveryPolicy(db, teamId!),
      listDeliveryPolicyVersions(db, teamId!),
      policyQuestions(db, teamId!),
    ]);
    return {
      current,
      versions: versions.map((version) => ({
        id: version.id,
        version: version.version,
        createdAt: version.createdAt,
        createdBy: version.createdBy?.id ? version.createdBy : null,
      })),
      questions,
    };
  }),

  update: workspaceProcedure
    .input(updateDeliveryPolicySchema)
    .mutation(async ({ ctx: { db, teamId, teamRole, session }, input }) =>
      saveDeliveryPolicy(db, {
        teamId: teamId!,
        actorId: session.user.id,
        teamRole: teamRole ?? null,
        expectedVersion: input.expectedVersion,
        settings: input.policy,
      }).catch((error) => {
        throw error instanceof InvoiceActionError
          ? new TRPCError({
              code: ACTION_ERROR_CODE[error.code],
              message: error.message,
            })
          : error;
      }),
    ),
});
