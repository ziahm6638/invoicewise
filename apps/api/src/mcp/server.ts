import { McpServer } from "@effect/ai";
import { BunRuntime, BunSink, BunStream } from "@effect/platform-bun";
import { Effect, Layer, Logger } from "effect";
import { InvoiceMcpHandlersLive, InvoiceMcpToolkit } from "./invoice-tools";

const ServerLive = Layer.effectDiscard(
  McpServer.registerToolkit(InvoiceMcpToolkit),
).pipe(
  Layer.provide(
    McpServer.layerStdio({
      name: "invoicewise",
      version: "1.0.0",
      stdin: BunStream.stdin,
      stdout: BunSink.stdout,
    }),
  ),
  Layer.provide(InvoiceMcpHandlersLive),
  Layer.provideMerge(Logger.remove(Logger.defaultLogger)),
  Layer.provideMerge(Logger.remove(Logger.prettyLoggerDefault)),
);

Layer.launch(ServerLive).pipe(Effect.scoped, BunRuntime.runMain);
