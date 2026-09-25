import { invoiceHttp, invoiceReadRequest } from "@api/effect/invoice-http";
import type { Context } from "@api/rest/types";
import {
  deleteInboxResponseSchema,
  deleteInboxSchema,
  getInboxByIdSchema,
  getInboxPreSignedUrlSchema,
  getInboxSchema,
  inboxItemResponseSchema,
  inboxPreSignedUrlResponseSchema,
  inboxResponseSchema,
  updateInboxSchema,
} from "@api/schemas/inbox";
import { validateResponse } from "@api/utils/validate-response";
import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { z } from "@hono/zod-openapi";
import { deleteInbox, updateInbox } from "@invoicewise/db/queries";
import { HTTPException } from "hono/http-exception";
import { withRequiredScope } from "../middleware";

const app = new OpenAPIHono<Context>();
const effectErrorSchema = z.object({
  _tag: z.string(),
  error: z.string(),
});

const forwardToEffect = (request: Request, teamId: string, scopes: string[]) =>
  invoiceHttp.handler(invoiceReadRequest(request, { teamId, scopes }));

app.openapi(
  createRoute({
    method: "get",
    path: "/",
    summary: "List all inbox items",
    operationId: "listInboxItems",
    "x-speakeasy-name-override": "list",
    description: "Retrieve a list of inbox items for the authenticated team.",
    tags: ["Inbox"],
    request: {
      query: getInboxSchema,
    },
    responses: {
      200: {
        description:
          "Retrieve a list of inbox items for the authenticated team.",
        content: {
          "application/json": {
            schema: inboxResponseSchema,
          },
        },
      },
      500: {
        description: "Invoice read failed",
        content: {
          "application/json": { schema: effectErrorSchema },
        },
      },
    },
    middleware: [withRequiredScope("inbox.read")],
  }),
  async (c) => {
    return (await forwardToEffect(
      c.req.raw,
      c.get("teamId"),
      c.get("scopes"),
    )) as never;
  },
);

app.openapi(
  createRoute({
    method: "get",
    path: "/{id}",
    summary: "Retrieve a inbox item",
    operationId: "getInboxItemById",
    "x-speakeasy-name-override": "get",
    description:
      "Retrieve a inbox item by its unique identifier for the authenticated team.",
    tags: ["Inbox"],
    request: {
      params: getInboxByIdSchema.pick({ id: true }),
    },
    responses: {
      200: {
        description: "Retrieve an inbox item by its ID.",
        content: {
          "application/json": {
            schema: inboxItemResponseSchema,
          },
        },
      },
      404: {
        description: "Inbox item not found",
        content: {
          "application/json": { schema: effectErrorSchema },
        },
      },
      500: {
        description: "Invoice read failed",
        content: {
          "application/json": { schema: effectErrorSchema },
        },
      },
    },
    middleware: [withRequiredScope("inbox.read")],
  }),
  async (c) => {
    return (await forwardToEffect(
      c.req.raw,
      c.get("teamId"),
      c.get("scopes"),
    )) as never;
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/{id}/presigned-url",
    summary: "Generate pre-signed URL for inbox attachment",
    operationId: "getInboxPreSignedUrl",
    "x-speakeasy-name-override": "getPreSignedUrl",
    description:
      "Generate a pre-signed URL for accessing an inbox attachment. The URL is valid for 60 seconds and allows secure temporary access to the attachment file.",
    tags: ["Inbox"],
    request: {
      params: getInboxPreSignedUrlSchema.pick({ id: true }),
      query: getInboxPreSignedUrlSchema.pick({ download: true }),
    },
    responses: {
      200: {
        description: "Pre-signed URL generated successfully",
        content: {
          "application/json": {
            schema: inboxPreSignedUrlResponseSchema,
          },
        },
      },
      400: {
        description: "Bad request - Attachment file path not available",
        content: {
          "application/json": {
            schema: effectErrorSchema,
          },
        },
      },
      404: {
        description: "Inbox item not found",
        content: {
          "application/json": {
            schema: effectErrorSchema,
          },
        },
      },
      500: {
        description:
          "Internal server error - Failed to generate pre-signed URL",
        content: {
          "application/json": {
            schema: effectErrorSchema,
          },
        },
      },
    },
    middleware: [withRequiredScope("inbox.read")],
  }),
  async (c) => {
    return (await forwardToEffect(
      c.req.raw,
      c.get("teamId"),
      c.get("scopes"),
    )) as never;
  },
);

app.openapi(
  createRoute({
    method: "delete",
    path: "/{id}",
    summary: "Delete a inbox item",
    operationId: "deleteInboxItem",
    "x-speakeasy-name-override": "delete",
    description:
      "Delete a inbox item by its unique identifier for the authenticated team.",
    tags: ["Inbox"],
    request: {
      params: deleteInboxSchema.pick({ id: true }),
    },
    responses: {
      200: {
        description: "Delete a inbox item by its ID.",
        content: {
          "application/json": {
            schema: deleteInboxResponseSchema,
          },
        },
      },
    },
    middleware: [withRequiredScope("inbox.write")],
  }),
  async (c) => {
    const db = c.get("db");
    const teamId = c.get("teamId");
    const { id } = c.req.valid("param");

    const result = await deleteInbox(db, {
      id,
      teamId,
    });

    if (!result) {
      throw new HTTPException(404, { message: "Inbox item not found" });
    }

    return c.json(validateResponse(result, deleteInboxResponseSchema));
  },
);

app.openapi(
  createRoute({
    method: "patch",
    path: "/{id}",
    summary: "Update a inbox item",
    operationId: "updateInboxItem",
    "x-speakeasy-name-override": "update",
    description:
      "Update fields of an inbox item by its unique identifier for the authenticated team.",
    tags: ["Inbox"],
    request: {
      params: updateInboxSchema.pick({ id: true }),
      body: {
        content: {
          "application/json": {
            schema: updateInboxSchema.omit({ id: true }),
          },
        },
        required: true,
      },
    },
    responses: {
      200: {
        description:
          "Update fields of an inbox item by its unique identifier for the authenticated team.",
        content: {
          "application/json": {
            schema: inboxItemResponseSchema,
          },
        },
      },
    },
    middleware: [withRequiredScope("inbox.write")],
  }),
  async (c) => {
    const db = c.get("db");
    const teamId = c.get("teamId");
    const id = c.req.valid("param").id;
    const body = c.req.valid("json");

    const result = await updateInbox(db, { ...body, id, teamId });

    if (!result) {
      throw new HTTPException(404, { message: "Inbox item not found" });
    }

    return c.json(validateResponse(result, inboxItemResponseSchema));
  },
);

export const inboxRouter = app;
