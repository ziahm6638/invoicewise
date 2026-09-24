import { deleteApiKeySchema, upsertApiKeySchema } from "@api/schemas/api-keys";
import { deliverMail } from "@api/services/mail";
import { adminProcedure, createTRPCRouter } from "@api/trpc/init";
import {
  clampScopesForRole,
  deleteApiKey,
  getApiKeysByTeam,
  upsertApiKey,
} from "@invoicewise/db/queries";
import { ApiKeyCreatedEmail } from "@invoicewise/email/emails/api-key-created";
import { render } from "@invoicewise/email/render";
import { logger } from "@invoicewise/logger";
import { TRPCError } from "@trpc/server";

export const apiKeysRouter = createTRPCRouter({
  get: adminProcedure.query(async ({ ctx: { db, teamId } }) => {
    return getApiKeysByTeam(db, teamId!);
  }),

  upsert: adminProcedure
    .input(upsertApiKeySchema)
    .mutation(
      async ({ ctx: { db, teamId, teamRole, session, geo }, input }) => {
        const { data, key, keyHash } = await upsertApiKey(db, {
          teamId: teamId!,
          userId: session.user.id,
          ...input,
          // A key can never carry scopes above the issuer's role.
          scopes: clampScopesForRole(teamRole, input.scopes),
        });

        // An update matched no row: the key belongs to another workspace.
        if (input.id && !keyHash) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "API key not found",
          });
        }

        if (data) {
          try {
            // We don't need to await this, it will be sent in the background
            deliverMail({
              to: session.user.email!,
              subject: "New API Key Created",
              html: render(
                ApiKeyCreatedEmail({
                  fullName: session.user.full_name!,
                  keyName: input.name,
                  createdAt: data.createdAt,
                  email: session.user.email!,
                  ip: geo.ip!,
                }),
              ),
            }).catch((error) => logger.error(error));
          } catch (error) {
            logger.error(error);
          }
        }

        return {
          key,
          data,
        };
      },
    ),

  delete: adminProcedure
    .input(deleteApiKeySchema)
    .mutation(async ({ ctx: { db, teamId }, input }) => {
      const keyHash = await deleteApiKey(db, {
        teamId: teamId!,
        ...input,
      });

      return keyHash;
    }),
});
