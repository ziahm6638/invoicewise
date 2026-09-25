import { HttpApp, HttpServer } from "@effect/platform";
import { BunHttpServer, BunRuntime } from "@effect/platform-bun";
import { trpcServer } from "@hono/trpc-server";
import { OpenAPIHono } from "@hono/zod-openapi";
import { closeDatabase, db } from "@invoicewise/db/client";
import { WorkflowRuntimeLive, runWorkflows } from "@invoicewise/jobs/runner";
import { Scalar } from "@scalar/hono-api-reference";
import { Config, Effect, Logger } from "effect";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { invoiceHttp } from "./effect/invoice-http";
import { registerHealthRoutes } from "./ops/route";
import { routers } from "./rest/routers";
import type { Context } from "./rest/types";
import { exportDownloadResponse } from "./storage/export-route";
import { storageCapabilityResponse } from "./storage/route";
import { createTRPCContext } from "./trpc/init";
import { appRouter } from "./trpc/routers/_app";
import { checkHealth } from "./utils/health";

const allowedOrigins: string[] = [];
const app = new OpenAPIHono<Context>();

app.use(secureHeaders());

app.use(
  "*",
  cors({
    origin: allowedOrigins,
    credentials: true,
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
    allowHeaders: [
      "Authorization",
      "Content-Type",
      "accept-language",
      "x-trpc-source",
      "x-user-locale",
      "x-user-timezone",
      "x-user-country",
    ],
    exposeHeaders: ["Content-Length"],
    maxAge: 86400,
  }),
);

app.use(
  "/trpc/*",
  trpcServer({
    router: appRouter,
    createContext: createTRPCContext,
  }),
);

registerHealthRoutes(app, { db, checkDatabase: checkHealth });

app.get("/storage/*", (c) => storageCapabilityResponse(c.req.raw));
app.get("/exports/:id/download", (c) => exportDownloadResponse(c.req.raw));

app.doc("/openapi", {
  openapi: "3.1.0",
  info: {
    version: "0.0.1",
    title: "InvoiceWise API",
    description:
      "Invoice middleware for extracting and delivering structured invoice data.",
    contact: {
      name: "InvoiceWise Support",
      email: "support@invoicewise.uk",
      url: "https://invoicewise.uk",
    },
    license: {
      name: "AGPL-3.0 license",
      url: "https://github.com/midday-ai/midday/blob/main/LICENSE",
    },
  },
  servers: [
    {
      url: "https://api.invoicewise.uk",
      description: "Production API",
    },
  ],
  security: [
    {
      oauth2: [],
    },
    { token: [] },
  ],
});

// Register security scheme
app.openAPIRegistry.registerComponent("securitySchemes", "token", {
  type: "http",
  scheme: "bearer",
  description: "Default authentication mechanism",
  "x-speakeasy-example": "INVOICEWISE_API_KEY",
});

app.get(
  "/",
  Scalar({ url: "/openapi", pageTitle: "InvoiceWise API", theme: "saturn" }),
);

app.route("/", routers);

const main = Effect.gen(function* () {
  const configuredOrigins = yield* Config.string("ALLOWED_API_ORIGINS").pipe(
    Config.withDefault(""),
    Config.map((value) => value.split(",").filter(Boolean)),
  );
  allowedOrigins.push(...configuredOrigins);

  yield* Effect.addFinalizer(() => Effect.promise(invoiceHttp.dispose));
  yield* Effect.addFinalizer(() => Effect.promise(closeDatabase));
  yield* Effect.forkScoped(
    runWorkflows.pipe(
      Effect.provide(WorkflowRuntimeLive),
      Effect.provide(Logger.json),
    ),
  );

  const server = yield* HttpServer.HttpServer;
  yield* server.serve(
    HttpApp.fromWebHandler((request) => Promise.resolve(app.fetch(request))),
  );
  yield* Effect.never;
});

main.pipe(
  Effect.provide(
    BunHttpServer.layerConfig(
      Config.unwrap({
        port: Config.integer("PORT").pipe(Config.withDefault(3000)),
        hostname: Config.succeed("::"),
      }),
    ),
  ),
  Effect.scoped,
  BunRuntime.runMain({ disablePrettyLogger: true }),
);
