const pino = require("pino");

export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  // Credentials and secrets never reach the log, even when a caller passes
  // a whole request or config object (docs/operations.md#logs).
  redact: {
    paths: [
      "authorization",
      "cookie",
      "password",
      "secret",
      "token",
      "apiKey",
      "accessToken",
      "refreshToken",
      "*.authorization",
      "*.cookie",
      "*.password",
      "*.secret",
      "*.token",
      "*.apiKey",
      "*.accessToken",
      "*.refreshToken",
      "headers.authorization",
      "headers.cookie",
      "req.headers.authorization",
      "req.headers.cookie",
    ],
    censor: "[redacted]",
  },
  // Use pretty printing in development, structured JSON in production
  ...(process.env.NODE_ENV === "development" && {
    transport: {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "HH:MM:ss",
        ignore: "pid,hostname",
        messageFormat: true,
        hideObject: false,
      },
    },
  }),
});

export default logger;
