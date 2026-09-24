import { describe, expect, test } from "bun:test";
import { documentBindingIssue, isValidDocumentBinding } from "./inbox";

const TEAM = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

describe("document binding validator", () => {
  test("accepts workspace document paths", () => {
    expect(
      isValidDocumentBinding({
        teamId: TEAM,
        filePath: [
          TEAM,
          "inbox",
          "33333333-3333-4333-8333-333333333333",
          "a.pdf",
        ],
      }),
    ).toBe(true);

    // Legacy mailbox rows have no object id segment but stay in the namespace.
    expect(
      isValidDocumentBinding({
        teamId: TEAM,
        filePath: [TEAM, "inbox", "invoice.pdf"],
      }),
    ).toBe(true);
  });

  test("rejects another workspace, other namespaces and ambiguity", () => {
    const cases: {
      label: string;
      binding: Parameters<typeof documentBindingIssue>[0];
    }[] = [
      {
        label: "no workspace",
        binding: { teamId: null, filePath: [TEAM, "inbox", "a.pdf"] },
      },
      { label: "no path", binding: { teamId: TEAM, filePath: null } },
      { label: "empty path", binding: { teamId: TEAM, filePath: [] } },
      {
        label: "foreign workspace prefix",
        binding: { teamId: TEAM, filePath: [OTHER, "inbox", "a.pdf"] },
      },
      {
        label: "asset namespace",
        binding: {
          teamId: TEAM,
          filePath: [TEAM, "assets", "logo", "4444", "logo.png"],
        },
      },
      {
        label: "no namespace",
        binding: { teamId: TEAM, filePath: [TEAM, "invoice.pdf"] },
      },
      {
        label: "traversal segment",
        binding: { teamId: TEAM, filePath: [TEAM, "inbox", "..", "a.pdf"] },
      },
      {
        label: "separator inside a segment",
        binding: { teamId: TEAM, filePath: [TEAM, "inbox", "a/b.pdf"] },
      },
      {
        label: "empty segment",
        binding: { teamId: TEAM, filePath: [TEAM, "inbox", "", "a.pdf"] },
      },
    ];

    for (const testCase of cases) {
      expect(
        `${testCase.label}: ${documentBindingIssue(testCase.binding)}`,
      ).not.toBe(`${testCase.label}: null`);
    }
  });
});
