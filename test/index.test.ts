import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import registerPiLedger, * as entrypoint from "../src/index.js";

describe("pi-ledger extension", () => {
  it("only exposes the extension entrypoint", () => {
    expect(Object.keys(entrypoint)).toEqual(["default"]);
  });

  it("registers lifecycle hooks without visible interface elements", () => {
    const calls = new Set<PropertyKey>();
    const on = vi.fn();
    const pi = new Proxy(
      { on },
      {
        get(target, property) {
          if (property === "on") return target.on;
          return (..._arguments: unknown[]) => calls.add(property);
        },
      },
    ) as unknown as ExtensionAPI;

    expect(() => registerPiLedger(pi)).not.toThrow();
    expect(on.mock.calls.map(([event]) => event)).toEqual([
      "session_start",
      "before_agent_start",
      "context",
      "tool_execution_start",
      "tool_execution_end",
      "agent_settled",
      "session_shutdown",
    ]);
    expect(calls).not.toContain("registerCommand");
    expect(calls).not.toContain("registerShortcut");
    expect(calls).not.toContain("registerMessageRenderer");
    expect(calls).not.toContain("registerEntryRenderer");
    expect(calls).not.toContain("registerMarkdownTransformer");
  });
});
