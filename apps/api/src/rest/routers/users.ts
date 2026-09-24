import { auth } from "@api/auth";
import type { Context } from "@api/rest/types";
import { updateUserSchema, userSchema } from "@api/schemas/users";
import { validateResponse } from "@api/utils/validate-response";
import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { primaryDb } from "@invoicewise/db/client";
import { getTeamRole, getUserById, updateUser } from "@invoicewise/db/queries";
import { HTTPException } from "hono/http-exception";
import { withRequiredScope } from "../middleware";

const app = new OpenAPIHono<Context>();

app.openapi(
  createRoute({
    method: "get",
    path: "/me",
    summary: "Retrieve the current user",
    operationId: "getCurrentUser",
    "x-speakeasy-name-override": "get",
    description: "Retrieve the current user for the authenticated team.",
    tags: ["Users"],
    responses: {
      200: {
        description: "Retrieve the current user for the authenticated team.",
        content: {
          "application/json": {
            schema: userSchema,
          },
        },
      },
    },
    middleware: [withRequiredScope("users.read")],
  }),
  async (c) => {
    const db = c.get("db");
    const session = c.get("session");

    const result = await getUserById(db, session.user.id);

    return c.json(validateResponse(result, userSchema));
  },
);

app.openapi(
  createRoute({
    method: "patch",
    path: "/me",
    summary: "Update the current user",
    operationId: "updateCurrentUser",
    "x-speakeasy-name-override": "update",
    description: "Update the current user for the authenticated team.",
    tags: ["Users"],
    request: {
      body: {
        content: {
          "application/json": {
            schema: updateUserSchema,
          },
        },
      },
    },
    responses: {
      200: {
        description: "The updated user",
        content: {
          "application/json": {
            schema: userSchema,
          },
        },
      },
    },
    middleware: [withRequiredScope("users.write")],
  }),
  async (c) => {
    const db = c.get("db");
    const session = c.get("session");
    const body = c.req.valid("json");

    if (body.teamId) {
      // Switching the active workspace is a browser-session action. A
      // credential stays bound to the workspace it was issued for.
      if ((session.authType ?? "session") !== "session") {
        throw new HTTPException(403, {
          message: "Credentials cannot switch the active workspace",
        });
      }

      // Fresh primary read rather than a replica-eligible membership lookup.
      const role = await getTeamRole(primaryDb, body.teamId, session.user.id);

      if (!role) {
        throw new HTTPException(403, { message: "Team not found" });
      }

      await auth.api.setActiveOrganization({
        body: { organizationId: body.teamId },
        headers: c.req.raw.headers,
      });
    }

    const result = await updateUser(db, {
      id: session.user.id,
      ...body,
    });

    return c.json(validateResponse(result, userSchema));
  },
);

export const usersRouter = app;
