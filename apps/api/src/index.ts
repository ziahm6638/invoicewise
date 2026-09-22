import { HttpApp, HttpServer } from "@effect/platform";
import { BunHttpServer, BunRuntime } from "@effect/platform-bun";
import { trpcServer } from "@hono/trpc-server";
import { OpenAPIHono } from "@hono/zod-openapi";
import { closeDatabase, db, getConnectionPoolStats } from "@midday/db/client";
import { download, verifySignedUrl } from "@midday/db/storage";
import { Scalar } from "@scalar/hono-api-reference";
import { sql } from "drizzle-orm";
import { Config, Effect } from "effect";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { invoiceHttp } from "./effect/invoice-http";
import { routers } from "./rest/routers";
import type { Context } from "./rest/types";
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

app.get("/health", async (c) => {
  try {
    await checkHealth();

    return c.json({ status: "ok" }, 200);
  } catch (error) {
    return c.json(
      {
        status: "error",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

// Connection pool health check
app.get("/health/pools", async (c) => {
  try {
    const stats = getConnectionPoolStats();

    // Determine health status with proper priority
    let status = "healthy";
    const issues = [];

    // Check for degraded conditions (highest priority)
    if (stats.summary.hasExhaustedPools) {
      status = "degraded";
      issues.push("Connection pools exhausted");
    }

    if (stats.summary.totalWaiting > 0) {
      status = "degraded";
      issues.push(`${stats.summary.totalWaiting} connections waiting`);
    }

    // Only set warning if not already degraded
    if (status !== "degraded" && stats.summary.utilizationPercent >= 80) {
      status = "warning";
      issues.push(
        `High connection usage: ${stats.summary.utilizationPercent}%`,
      );
    }

    const exhaustedPools = Object.values(stats.pools)
      .filter((p) => (p.active || 0) >= (p.total || 0))
      .map((p) => p.name);

    const waitingPools = Object.values(stats.pools)
      .filter((p) => (p.waiting || 0) > 0)
      .map((p) => p.name);

    return c.json({
      status,
      issues,
      exhaustedPools,
      waitingPools,
      ...stats,
    });
  } catch (error) {
    return c.json(
      {
        status: "error",
        error: error instanceof Error ? error.message : "Unknown error",
        timestamp: new Date().toISOString(),
      },
      500,
    );
  }
});

// Database connection test with timing
app.get("/health/db", async (c) => {
  const startTime = Date.now();

  try {
    // Test with a simple query
    const testStart = Date.now();
    await db.execute(sql`SELECT 1 as test`);
    const queryTime = Date.now() - testStart;

    const totalTime = Date.now() - startTime;
    const poolStats = getConnectionPoolStats();

    return c.json({
      status: "healthy",
      timing: {
        connectionTime: `${testStart - startTime}ms`,
        queryTime: `${queryTime}ms`,
        total: `${totalTime}ms`,
      },
      poolSummary: poolStats.summary,
      region: process.env.FLY_REGION,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    const totalTime = Date.now() - startTime;
    const poolStats = getConnectionPoolStats();

    return c.json(
      {
        status: "unhealthy",
        error: error instanceof Error ? error.message : "Unknown error",
        timing: {
          failedAfter: `${totalTime}ms`,
        },
        poolSummary: poolStats.summary,
        timestamp: new Date().toISOString(),
      },
      500,
    );
  }
});

app.get("/storage/*", async (c) => {
  const parts = c.req.path.split("/").filter(Boolean);
  const [, bucket, ...pathParts] = parts;
  const path = pathParts.map(decodeURIComponent).join("/");
  const expires = Number(c.req.query("expires"));
  const providedSignature = c.req.query("signature") ?? "";
  const downloadFile = c.req.query("download") === "1";

  if (
    !bucket ||
    !path ||
    !Number.isFinite(expires) ||
    !verifySignedUrl({
      bucket,
      path,
      expires,
      providedSignature,
      download: downloadFile,
    })
  ) {
    return c.json({ error: "Invalid or expired storage URL" }, 401);
  }

  try {
    const file = await download({ bucket, path });
    const headers: Record<string, string> = {
      "Content-Type": file.type,
      "Content-Length": String(file.size),
    };
    if (downloadFile) {
      headers["Content-Disposition"] =
        `attachment; filename="${pathParts.at(-1)}"`;
    }
    return new Response(file, { headers });
  } catch {
    return c.json({ error: "File not found" }, 404);
  }
});

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
  BunRuntime.runMain,
);
