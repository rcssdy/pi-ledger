import { describe, expect, it } from "vitest";

import { truncateCodePoints } from "../../src/journal/text.js";

describe("journal text", () => {
  it("truncates by Unicode code point", () => {
    expect(truncateCodePoints("A😀BC", 3)).toBe("A😀…");
    expect(truncateCodePoints("A😀", 2)).toBe("A😀");
  });
});
