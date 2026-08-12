import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import registerPiLedger from "../src/index.js";

describe("pi-ledger extension", () => {
  it("loads without registering visible interface elements", () => {
    const calls = new Set<PropertyKey>();
    const pi = new Proxy(
      {},
      {
        get:
          (_target, property) =>
          (..._arguments: unknown[]) =>
            calls.add(property),
      },
    ) as ExtensionAPI;

    expect(() => registerPiLedger(pi)).not.toThrow();
    expect(calls).not.toContain("registerCommand");
    expect(calls).not.toContain("registerShortcut");
    expect(calls).not.toContain("registerMessageRenderer");
    expect(calls).not.toContain("registerEntryRenderer");
    expect(calls).not.toContain("registerMarkdownTransformer");
  });
});
