import { type Socket, createServer } from "node:net";

/**
 * Loopback SMTP trap for tests and release verification. Never used by
 * product code.
 *
 * It speaks just enough SMTP for nodemailer over a plain connection: a
 * greeting, EHLO without STARTTLS, AUTH PLAIN/LOGIN (any credentials are
 * accepted), MAIL FROM, RCPT TO, DATA and QUIT. Every connection and accepted
 * message is recorded so a caller can prove how much mail was attempted and
 * what it carried, without anything leaving the machine.
 */
export type SmtpTrapMessage = {
  /** The SMTP_USER the client authenticated as, if it authenticated. */
  authUser: string | null;
  envelopeFrom: string;
  recipients: string[];
  /** Decoded `From`, `To` and `Subject` headers. */
  from: string;
  to: string;
  subject: string;
  raw: string;
};

export type SmtpTrap = {
  host: "127.0.0.1";
  port: number;
  /** Connections accepted since start (or the last reset). */
  readonly connections: number;
  readonly messages: SmtpTrapMessage[];
  reset: () => void;
  stop: () => Promise<void>;
};

const decodeWord = (charset: string, encoding: string, text: string) => {
  const bytes =
    encoding.toUpperCase() === "B"
      ? Buffer.from(text, "base64")
      : Buffer.from(
          text
            .replaceAll("_", " ")
            .replace(/=([0-9A-F]{2})/gi, (_match, hex: string) =>
              String.fromCharCode(Number.parseInt(hex, 16)),
            ),
          "latin1",
        );

  return bytes.toString(/^utf-?8$/i.test(charset) ? "utf8" : "latin1");
};

/** Decodes RFC 2047 encoded words, which nodemailer uses for non-ASCII text. */
const decodeHeader = (value: string) =>
  value
    .replace(/\?=\s+=\?/g, "?==?")
    .replace(
      /=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi,
      (_match, charset, encoding, text) => decodeWord(charset, encoding, text),
    );

const parseHeaders = (raw: string) => {
  const [head = ""] = raw.split(/\r?\n\r?\n/, 1);
  const headers = new Map<string, string>();

  for (const line of head.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator > 0) {
      headers.set(
        line.slice(0, separator).trim().toLowerCase(),
        decodeHeader(line.slice(separator + 1).trim()),
      );
    }
  }

  return headers;
};

const addressOf = (argument: string) =>
  argument.replace(/^[^:]*:\s*/, "").replace(/^<|>.*$/g, "");

const decodeBase64 = (value: string) =>
  Buffer.from(value.trim(), "base64").toString("utf8");

export async function startSmtpTrap(): Promise<SmtpTrap> {
  const messages: SmtpTrapMessage[] = [];
  const sockets = new Set<Socket>();
  let connections = 0;

  const server = createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.setEncoding("utf8");

    let buffer = "";
    let mode: "command" | "data" | "auth-plain" | "auth-user" | "auth-pass" =
      "command";
    let authUser: string | null = null;
    let envelopeFrom = "";
    let recipients: string[] = [];
    let dataLines: string[] = [];

    const reply = (line: string) => socket.write(`${line}\r\n`);

    const handle = (line: string) => {
      if (mode === "data") {
        if (line === ".") {
          const raw = dataLines.join("\r\n");
          const headers = parseHeaders(raw);
          messages.push({
            authUser,
            envelopeFrom,
            recipients,
            from: headers.get("from") ?? "",
            to: headers.get("to") ?? "",
            subject: headers.get("subject") ?? "",
            raw,
          });
          mode = "command";
          envelopeFrom = "";
          recipients = [];
          dataLines = [];
          reply("250 2.0.0 Ok: queued by trap");
        } else {
          dataLines.push(line.startsWith("..") ? line.slice(1) : line);
        }
        return;
      }

      if (mode === "auth-plain") {
        authUser = decodeBase64(line).split("\u0000")[1] ?? null;
        mode = "command";
        reply("235 2.7.0 Authentication successful");
        return;
      }

      if (mode === "auth-user") {
        authUser = decodeBase64(line);
        mode = "auth-pass";
        reply("334 UGFzc3dvcmQ6");
        return;
      }

      if (mode === "auth-pass") {
        mode = "command";
        reply("235 2.7.0 Authentication successful");
        return;
      }

      const [verb = "", ...rest] = line.split(" ");
      const argument = rest.join(" ");

      switch (verb.toUpperCase()) {
        case "EHLO":
          reply("250-127.0.0.1 smtp trap");
          reply("250-AUTH PLAIN LOGIN");
          reply("250 8BITMIME");
          return;
        case "HELO":
          reply("250 127.0.0.1 smtp trap");
          return;
        case "AUTH": {
          const [mechanism = "", initial] = argument.split(" ");
          if (mechanism.toUpperCase() === "PLAIN") {
            if (initial) {
              authUser = decodeBase64(initial).split("\u0000")[1] ?? null;
              reply("235 2.7.0 Authentication successful");
            } else {
              mode = "auth-plain";
              reply("334 ");
            }
            return;
          }
          if (mechanism.toUpperCase() === "LOGIN") {
            if (initial) {
              authUser = decodeBase64(initial);
              mode = "auth-pass";
              reply("334 UGFzc3dvcmQ6");
            } else {
              mode = "auth-user";
              reply("334 VXNlcm5hbWU6");
            }
            return;
          }
          reply("504 5.5.4 Unrecognized authentication type");
          return;
        }
        case "MAIL":
          envelopeFrom = addressOf(argument);
          recipients = [];
          reply("250 2.1.0 Ok");
          return;
        case "RCPT":
          recipients.push(addressOf(argument));
          reply("250 2.1.5 Ok");
          return;
        case "DATA":
          mode = "data";
          reply("354 End data with <CR><LF>.<CR><LF>");
          return;
        case "RSET":
          envelopeFrom = "";
          recipients = [];
          reply("250 2.0.0 Ok");
          return;
        case "NOOP":
          reply("250 2.0.0 Ok");
          return;
        case "QUIT":
          reply("221 2.0.0 Bye");
          socket.end();
          return;
        default:
          reply("502 5.5.2 Command not recognized");
      }
    };

    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf("\r\n");
      while (index !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        handle(line);
        index = buffer.indexOf("\r\n");
      }
    });

    reply("220 127.0.0.1 ESMTP smtp trap");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("SMTP trap did not bind a loopback port");
  }

  return {
    host: "127.0.0.1",
    port: address.port,
    get connections() {
      return connections;
    },
    messages,
    reset: () => {
      connections = 0;
      messages.length = 0;
    },
    stop: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
