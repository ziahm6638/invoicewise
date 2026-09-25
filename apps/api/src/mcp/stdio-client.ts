/**
 * A minimal MCP client for the stdio server (`server.ts`), as an MCP host
 * runs it: a child process given only the API URL and a key, spoken to in
 * newline-delimited JSON-RPC. Used by the smoke check and its proofs; it has
 * no repository imports.
 */

type Json = Record<string, any>;

export type McpStdioClient = {
  readonly request: (method: string, params?: Json) => Promise<Json>;
  readonly notify: (method: string, params?: Json) => void;
  readonly close: () => Promise<void>;
};

const SERVER = new URL("./server.ts", import.meta.url).pathname;

export function startMcpStdio(options: {
  apiUrl: string;
  apiKey: string;
  timeoutMs?: number;
}): McpStdioClient {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const child = Bun.spawn(["bun", "--no-env-file", SERVER], {
    cwd: new URL("..", import.meta.url).pathname,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? "/tmp",
      INVOICEWISE_API_URL: options.apiUrl,
      INVOICEWISE_API_KEY: options.apiKey,
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (message: Json) => void; reject: (error: Error) => void }
  >();
  let stderr = "";

  void (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of child.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line) continue;
        const message = JSON.parse(line) as Json;
        if (typeof message.id === "number" && pending.has(message.id)) {
          pending.get(message.id)!.resolve(message);
          pending.delete(message.id);
        }
      }
    }
  })();
  void (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of child.stderr) stderr += decoder.decode(chunk);
  })();
  void child.exited.then((code) => {
    for (const { reject } of pending.values()) {
      reject(new Error(`MCP server exited ${code}: ${stderr.slice(-500)}`));
    }
    pending.clear();
  });

  const send = (message: Json) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    child.stdin.flush();
  };

  return {
    request: (method, params) => {
      const id = nextId++;
      return new Promise<Json>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`MCP ${method} timed out: ${stderr.slice(-500)}`));
        }, timeoutMs);
        pending.set(id, {
          resolve: (message) => {
            clearTimeout(timer);
            resolve(message);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
        send({ id, method, ...(params ? { params } : {}) });
      });
    },
    notify: (method, params) => send({ method, ...(params ? { params } : {}) }),
    close: async () => {
      child.stdin.end();
      child.kill("SIGTERM");
      await child.exited;
    },
  };
}

/** Starts the server and completes the MCP initialize handshake. */
export async function connectMcpStdio(options: {
  apiUrl: string;
  apiKey: string;
  timeoutMs?: number;
}) {
  const client = startMcpStdio(options);
  try {
    const initialized = await client.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "invoicewise-smoke", version: "1" },
    });
    client.notify("notifications/initialized");
    return { client, initialized };
  } catch (error) {
    await client.close();
    throw error;
  }
}
