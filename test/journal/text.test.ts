import { describe, expect, it } from "vitest";

import { singleLine, truncateCodePoints } from "../../src/journal/text.js";

describe("journal text", () => {
  it("normalizes one-line text", () => {
    expect(singleLine("  one\n\ttwo  ")).toBe("one two");
  });

  it("truncates by Unicode code point", () => {
    expect(truncateCodePoints("A😀BC", 3)).toBe("A😀…");
    expect(truncateCodePoints("A😀", 2)).toBe("A😀");
  });
});
