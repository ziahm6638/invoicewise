import { expect, test } from "bun:test";
import { isAuthenticationError } from "./utils";

test("HTTP 401/403 statuses are authentication errors", () => {
  expect(isAuthenticationError("Request failed with status code 401")).toBe(
    true,
  );
  expect(isAuthenticationError("HTTP 403: Forbidden")).toBe(true);
});

test("ids that merely contain 401 or 403 are not authentication errors", () => {
  expect(
    isAuthenticationError(
      "Mailbox intake could not store 1 attachment(s): vault/5f4013ab-c403e/inbox/9a401bc2.pdf",
    ),
  ).toBe(false);
});
