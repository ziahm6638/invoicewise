import {
  authorizeOAuthApplicationSchema,
  createOAuthApplicationSchema,
  deleteOAuthApplicationSchema,
  getApplicationInfoSchema,
  getOAuthApplicationSchema,
  regenerateClientSecretSchema,
  updateApprovalStatusSchema,
  updateOAuthApplicationSchema,
} from "@api/schemas/oauth-applications";
import { revokeUserApplicationAccessSchema } from "@api/schemas/oauth-flow";
import { resend } from "@api/services/resend";
import {
  adminProcedure,
  createTRPCRouter,
  protectedProcedure,
  workspaceProcedure,
} from "@api/trpc/init";
import { primaryDb } from "@invoicewise/db/client";
import {
  clampScopesForRole,
  createAuthorizationCode,
  createOAuthApplication,
  deleteOAuthApplication,
  getOAuthApplicationByClientId,
  getOAuthApplicationById,
  getOAuthApplicationsByTeam,
  getTeamRole,
  getUserAuthorizedApplications,
  hasUserEverAuthorizedApp,
  regenerateClientSecret,
  revokeUserApplicationTokens,
  scopesWithinRole,
  updateOAuthApplication,
  updateOAuthApplicationstatus,
} from "@invoicewise/db/queries";
import { isScope, scopesWithinApplication } from "@invoicewise/db/utils/scopes";
import { AppInstalledEmail } from "@invoicewise/email/emails/app-installed";
import { AppReviewRequestEmail } from "@invoicewise/email/emails/app-review-request";
import { render } from "@invoicewise/email/render";

export const oauthApplicationsRouter = createTRPCRouter({
  list: workspaceProcedure.query(async ({ ctx }) => {
    const { db, teamId } = ctx;

    const applications = await getOAuthApplicationsByTeam(db, teamId!);

    return {
      data: applications,
    };
  }),

  getApplicationInfo: protectedProcedure
    .input(getApplicationInfoSchema)
    .query(async ({ ctx, input }) => {
      const { db } = ctx;
      const { clientId, redirectUri, scope, state } = input;

      // Validate client_id
      const application = await getOAuthApplicationByClientId(db, clientId);
      if (!application || !application.active) {
        throw new Error("Invalid client_id");
      }

      // Validate redirect_uri
      if (!application.redirectUris.includes(redirectUri)) {
        throw new Error("Invalid redirect_uri");
      }

      // Validate scopes against the registered set, normalized so an
      // application that registered an alias covers its concrete scopes.
      const requestedScopes = scope.split(" ").filter(Boolean);

      if (!scopesWithinApplication(application.scopes, requestedScopes)) {
        throw new Error(`Invalid scopes: ${requestedScopes.join(", ")}`);
      }

      // Return application info for consent screen
      return {
        id: application.id,
        name: application.name,
        description: application.description,
        overview: application.overview,
        developerName: application.developerName,
        logoUrl: application.logoUrl,
        website: application.website,
        installUrl: application.installUrl,
        screenshots: application.screenshots,
        clientId: application.clientId,
        // Validated above, so this only narrows the type for the client.
        scopes: requestedScopes.filter(isScope),
        redirectUri: redirectUri,
        state,
        status: application.status,
      };
    }),

  authorize: protectedProcedure
    .input(authorizeOAuthApplicationSchema)
    .mutation(async ({ ctx, input }) => {
      const { db, session } = ctx;
      const {
        clientId,
        decision,
        scopes,
        redirectUri,
        state,
        codeChallenge,
        teamId,
      } = input;

      // Validate client_id first (needed for both allow and deny)
      const application = await getOAuthApplicationByClientId(db, clientId);
      if (!application || !application.active) {
        throw new Error("Invalid client_id");
      }

      // Validate scopes against the application's registered set (prevent
      // privilege escalation); comparison is normalized set inclusion.
      if (!scopesWithinApplication(application.scopes, scopes)) {
        throw new Error(`Invalid scopes: ${scopes.join(", ")}`);
      }

      const redirectUrl = new URL(redirectUri);

      // Handle denial early - no need to check team membership for denial
      if (decision === "deny") {
        redirectUrl.searchParams.set("error", "access_denied");
        redirectUrl.searchParams.set("error_description", "User denied access");
        if (state) {
          redirectUrl.searchParams.set("state", state);
        }
        return { redirect_url: redirectUrl.toString() };
      }

      // Only validate team membership for "allow" decisions
      const role = await getTeamRole(primaryDb, teamId, session.user.id);

      if (!role) {
        throw new Error("User is not a member of the specified team");
      }

      // A granted token can never carry scopes above the authorizing actor's
      // current role, so a member cannot hand a write scope to an app.
      // Aliases expand and duplicates collapse, so the decision is set
      // membership rather than a length comparison.
      if (!scopesWithinRole(role, scopes)) {
        throw new Error(
          "Requested scopes exceed your permissions in this workspace",
        );
      }

      const grantedScopes = clampScopesForRole(role, scopes);

      // Enforce PKCE for public clients
      if (application.isPublic && !codeChallenge) {
        throw new Error("PKCE is required for public clients");
      }

      // Create authorization code
      const authCode = await createAuthorizationCode(db, {
        applicationId: application.id,
        userId: session.user.id,
        teamId,
        scopes: grantedScopes,
        redirectUri,
        codeChallenge,
      });

      if (!authCode) {
        throw new Error("Failed to create authorization code");
      }

      // Send app installation email only if this is the first time authorizing this app
      try {
        // Check if user has ever authorized this application for this team (including expired tokens)
        const hasAuthorizedBefore = await hasUserEverAuthorizedApp(
          db,
          session.user.id,
          teamId,
          application.id,
        );

        if (!hasAuthorizedBefore) {
          // Get team information
          const userTeam = await db.query.teams.findFirst({
            where: (teams, { eq }) => eq(teams.id, teamId),
            columns: { id: true, name: true },
          });

          if (userTeam && session.user.email) {
            const html = await render(
              AppInstalledEmail({
                email: session.user.email,
                teamName: userTeam.name!,
                appName: application.name,
              }),
            );

            await resend.emails.send({
              from: "InvoiceWise <middaybot@midday.ai>",
              to: session.user.email,
              subject: "An app has been added to your team",
              html,
            });
          }
        }
      } catch (error) {
        // Log error but don't fail the OAuth flow
        console.error("Failed to send app installation email:", error);
      }

      // Build success redirect URL
      redirectUrl.searchParams.set("code", authCode.code);
      if (state) {
        redirectUrl.searchParams.set("state", state);
      }

      return { redirect_url: redirectUrl.toString() };
    }),

  create: adminProcedure
    .input(createOAuthApplicationSchema)
    .mutation(async ({ ctx, input }) => {
      const { db, teamId, session } = ctx;

      const application = await createOAuthApplication(db, {
        ...input,
        teamId: teamId!,
        createdBy: session.user.id,
      });

      return application;
    }),

  get: workspaceProcedure
    .input(getOAuthApplicationSchema)
    .query(async ({ ctx, input }) => {
      const { db, teamId } = ctx;

      const application = await getOAuthApplicationById(db, input.id, teamId!);

      if (!application) {
        throw new Error("OAuth application not found");
      }

      return application;
    }),

  update: adminProcedure
    .input(updateOAuthApplicationSchema)
    .mutation(async ({ ctx, input }) => {
      const { db, teamId } = ctx;
      const { id, ...updateData } = input;

      const application = await updateOAuthApplication(db, {
        ...updateData,
        id,
        teamId: teamId!,
      });

      if (!application) {
        throw new Error("OAuth application not found");
      }

      return application;
    }),

  delete: adminProcedure
    .input(deleteOAuthApplicationSchema)
    .mutation(async ({ ctx, input }) => {
      const { db, teamId } = ctx;

      const result = await deleteOAuthApplication(db, {
        id: input.id,
        teamId: teamId!,
      });

      if (!result) {
        throw new Error("OAuth application not found");
      }

      return { success: true };
    }),

  regenerateSecret: adminProcedure
    .input(regenerateClientSecretSchema)
    .mutation(async ({ ctx, input }) => {
      const { db, teamId } = ctx;

      const result = await regenerateClientSecret(db, input.id, teamId!);

      if (!result) {
        throw new Error("OAuth application not found");
      }

      return result;
    }),

  authorized: workspaceProcedure.query(async ({ ctx }) => {
    const { db, teamId, session } = ctx;

    const applications = await getUserAuthorizedApplications(
      db,
      session.user.id,
      teamId!,
    );

    return {
      data: applications,
    };
  }),

  revokeAccess: protectedProcedure
    .input(revokeUserApplicationAccessSchema)
    .mutation(async ({ ctx, input }) => {
      const { db, session } = ctx;

      await revokeUserApplicationTokens(
        db,
        session.user.id,
        input.applicationId,
      );

      return { success: true };
    }),

  updateApprovalStatus: adminProcedure
    .input(updateApprovalStatusSchema)
    .mutation(async ({ ctx, input }) => {
      const { db, teamId, session } = ctx;

      // Get full application details before updating
      const application = await getOAuthApplicationById(db, input.id, teamId!);

      if (!application) {
        throw new Error("OAuth application not found");
      }

      const result = await updateOAuthApplicationstatus(db, {
        id: input.id,
        teamId: teamId!,
        status: input.status,
      });

      if (!result) {
        throw new Error("OAuth application not found");
      }

      // Send email notification when status changes to "pending"
      if (input.status === "pending") {
        try {
          // Get team information
          const currentTeam = await db.query.teams.findFirst({
            where: (teams, { eq }) => eq(teams.id, teamId!),
            columns: { id: true, name: true },
          });

          if (currentTeam && session.user.email) {
            const html = await render(
              AppReviewRequestEmail({
                applicationName: application.name,
                developerName: application.developerName || undefined,
                teamName: currentTeam.name!,
                userEmail: session.user.email,
              }),
            );

            await resend.emails.send({
              from: "InvoiceWise <middaybot@midday.ai>",
              to: "pontus@midday.ai",
              subject: `Application Review Request - ${application.name}`,
              html,
            });
          }
        } catch (error) {
          // Log error but don't fail the mutation
          console.error("Failed to send application review request:", error);
        }
      }

      return result;
    }),
});
