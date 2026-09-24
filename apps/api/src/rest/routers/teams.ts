import type { Context } from "@api/rest/types";
import {
  getTeamByIdSchema,
  teamMembersResponseSchema,
  teamResponseSchema,
  teamsResponseSchema,
  updateTeamByIdSchema,
} from "@api/schemas/team";
import type { Session } from "@api/utils/auth";
import { validateResponse } from "@api/utils/validate-response";
import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { primaryDb } from "@invoicewise/db/client";
import {
  canManageWorkspaceSettings,
  getTeamById,
  getTeamMembers,
  getTeamRole,
  getTeamsByUserId,
  updateTeamById,
} from "@invoicewise/db/queries";
import { HTTPException } from "hono/http-exception";
import { withRequiredScope } from "../middleware";

const app = new OpenAPIHono<Context>();

/**
 * API keys and OAuth tokens are bound to the workspace they were issued for,
 * even when their user belongs to several workspaces. Only a browser session
 * may act across the user's workspaces.
 */
const isCredentialRequest = (session: Session) =>
  (session.authType ?? "session") !== "session";

const credentialAllowsTeam = (session: Session, teamId: string) =>
  !isCredentialRequest(session) || session.teamId === teamId;

app.openapi(
  createRoute({
    method: "get",
    path: "/",
    summary: "List all teams",
    operationId: "listTeams",
    "x-speakeasy-name-override": "list",
    description: "Retrieve a list of teams for the authenticated user.",
    tags: ["Teams"],
    responses: {
      200: {
        description: "Retrieve a list of teams for the authenticated user.",
        content: {
          "application/json": {
            schema: teamsResponseSchema,
          },
        },
      },
    },
    middleware: [withRequiredScope("teams.read")],
  }),
  async (c) => {
    const db = c.get("db");
    const session = c.get("session");

    // A credential only ever sees the workspace it was issued for.
    if (isCredentialRequest(session)) {
      const team = session.teamId
        ? await getTeamById(primaryDb, session.teamId)
        : undefined;

      return c.json(
        validateResponse({ data: team ? [team] : [] }, teamsResponseSchema),
      );
    }

    const result = await getTeamsByUserId(db, session.user.id);

    return c.json(validateResponse({ data: result }, teamsResponseSchema));
  },
);

app.openapi(
  createRoute({
    method: "get",
    path: "/{id}",
    summary: "Retrieve a team",
    operationId: "getTeamById",
    "x-speakeasy-name-override": "get",
    description: "Retrieve a team by its ID for the authenticated team.",
    tags: ["Teams"],
    request: {
      params: getTeamByIdSchema,
    },
    responses: {
      200: {
        description: "Team details",
        content: {
          "application/json": {
            schema: teamResponseSchema,
          },
        },
      },
    },
    middleware: [withRequiredScope("teams.read")],
  }),
  async (c) => {
    const db = c.get("db");
    const session = c.get("session");
    const teamId = c.req.param("id");

    // Fresh primary read; credentials cannot leave their workspace.
    if (!credentialAllowsTeam(session, teamId)) {
      throw new HTTPException(404, { message: "Team not found" });
    }

    const role = await getTeamRole(primaryDb, teamId, session.user.id);

    if (!role) {
      throw new HTTPException(404, { message: "Team not found" });
    }

    const result = await getTeamById(primaryDb, teamId);

    if (!result) {
      throw new HTTPException(404, { message: "Team not found" });
    }

    return c.json(validateResponse(result, teamResponseSchema));
  },
);

app.openapi(
  createRoute({
    method: "patch",
    path: "/{id}",
    summary: "Update a team",
    operationId: "updateTeamById",
    "x-speakeasy-name-override": "update",
    description:
      "Update a team for the authenticated workspace. If there’s no change, returns it as it is.",
    tags: ["Teams"],
    request: {
      params: getTeamByIdSchema,
      body: {
        content: {
          "application/json": {
            schema: updateTeamByIdSchema,
          },
        },
      },
    },
    responses: {
      200: {
        description: "Team updated",
        content: {
          "application/json": {
            schema: teamResponseSchema,
          },
        },
      },
    },
    middleware: [withRequiredScope("teams.write")],
  }),
  async (c) => {
    const db = c.get("db");
    const session = c.get("session");
    const teamId = c.req.param("id");
    const params = c.req.valid("json");

    if (!credentialAllowsTeam(session, teamId)) {
      throw new HTTPException(404, { message: "Team not found" });
    }

    // Workspace settings are owner/admin only, resolved fresh for the team
    // named in the path rather than the caller's active workspace.
    const role = await getTeamRole(primaryDb, teamId, session.user.id);

    if (!role) {
      throw new HTTPException(404, { message: "Team not found" });
    }

    if (!canManageWorkspaceSettings(role)) {
      throw new HTTPException(403, {
        message: "Requires the admin role in this workspace",
      });
    }

    const result = await updateTeamById(db, {
      id: teamId,
      data: params,
    });

    return c.json(validateResponse(result, teamResponseSchema));
  },
);

app.openapi(
  createRoute({
    method: "get",
    path: "/{id}/members",
    summary: "List all team members",
    operationId: "listTeamMembers",
    "x-speakeasy-name-override": "members",
    description: "List all team members for the authenticated team.",
    tags: ["Teams"],
    request: {
      params: getTeamByIdSchema,
    },
    responses: {
      200: {
        description: "Team members",
        content: {
          "application/json": {
            schema: teamMembersResponseSchema,
          },
        },
      },
    },
    middleware: [withRequiredScope("teams.read")],
  }),
  async (c) => {
    const db = c.get("db");
    const session = c.get("session");
    const teamId = c.req.param("id");

    // Fresh primary read; credentials cannot leave their workspace.
    if (!credentialAllowsTeam(session, teamId)) {
      throw new HTTPException(404, { message: "Team not found" });
    }

    const role = await getTeamRole(primaryDb, teamId, session.user.id);

    if (!role) {
      throw new HTTPException(404, { message: "Team not found" });
    }

    const result = await getTeamMembers(db, teamId);

    return c.json(
      validateResponse({ data: result }, teamMembersResponseSchema),
    );
  },
);

export const teamsRouter = app;
