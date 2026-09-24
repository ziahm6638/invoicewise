import { describe, expect, test } from "bun:test";
import { clampScopesForRole } from "@invoicewise/db/queries";
import { scopesToName } from "./scopes";

describe("scopesToName", () => {
  test("keys saved from the All access preset keep their label", () => {
    const saved = clampScopesForRole("owner", ["apis.all"]);
    expect(scopesToName(saved).preset).toBe("all_access");
    expect(scopesToName(["apis.all"]).preset).toBe("all_access");
  });

  test("keys saved from the Read Only preset keep their label", () => {
    const saved = clampScopesForRole("owner", ["apis.read"]);
    expect(scopesToName(saved).preset).toBe("read_only");
    expect(scopesToName(["apis.read"]).preset).toBe("read_only");
  });

  test("partial grants are restricted", () => {
    expect(scopesToName(["inbox.read"]).preset).toBe("restricted");
    expect(
      scopesToName(["inbox.read", "teams.read", "inbox.write"]).preset,
    ).toBe("restricted");
  });
});
