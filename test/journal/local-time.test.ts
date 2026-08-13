import { describe, expect, it } from "vitest";

import { localTimestamp } from "../../src/journal/local-time.js";

describe("local journal timestamps", () => {
  it("keeps the UTC instant and system-local calendar fields", () => {
    const date = new Date(2026, 7, 12, 14, 32, 5, 123);
    expect(localTimestamp(date)).toEqual({
      occurredAt: date.toISOString(),
      localDate: "2026-08-12",
      localTime: "14:32",
    });
  });

  it("rejects invalid dates", () => {
    expect(() => localTimestamp(new Date(Number.NaN))).toThrow("invalid date");
  });
});
