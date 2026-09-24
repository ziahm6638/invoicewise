import { expect, test } from "bun:test";
import { getInboxEmail, getInboxIdFromEmail } from ".";
import { isAuthenticationError } from "./utils";

test("Get inbox id from email", () => {
  expect(getInboxIdFromEmail("egr34f@inbox.midday.ai")).toMatch("egr34f");
});

test("Get inbox email by id", () => {
  expect(getInboxEmail("egr34f")).toMatch("egr34f@inbox.staging.midday.ai");
});

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
