import { describe, expect, test } from "bun:test";
import { formatDate } from "./format";

describe("formatDate", () => {
  test("shows UK day-first dates when the user has no preference", () => {
    expect(formatDate("2026-09-01")).toBe("01/09/2026");
    expect(formatDate("2026-09-24", null)).toBe("24/09/2026");
    // A timestamp in the current year keeps its year and day-first order.
    expect(formatDate(`${new Date().getFullYear()}-03-04T10:00:00Z`)).toBe(
      `04/03/${new Date().getFullYear()}`,
    );
  });

  test("honours an explicit preference", () => {
    expect(formatDate("2026-09-01", "yyyy-MM-dd")).toBe("2026-09-01");
    expect(formatDate("2026-09-01", "d MMM yyyy")).toBe("1 Sep 2026");
  });

  test("keeps a calendar date on its day in any timezone", () => {
    const previous = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      expect(formatDate("2026-09-01")).toBe("01/09/2026");
    } finally {
      process.env.TZ = previous;
    }
  });
});
