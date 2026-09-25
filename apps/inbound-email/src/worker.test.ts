import { describe, expect, test } from "bun:test";
import * as entry from "./worker";

describe("worker entry module", () => {
  // workerd refuses to start a main module whose named exports are not
  // handlers ("Incorrect type for map entry …"), so the entry must export
  // nothing but the default email handler.
  test("exports only the default email handler", () => {
    expect(Object.keys(entry)).toEqual(["default"]);
    expect(typeof entry.default.email).toBe("function");
  });
});
