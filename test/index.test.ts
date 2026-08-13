import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import registerPiLedger, * as entrypoint from "../src/index.js";

describe("pi-ledger extension", () => {
  it("only exports its Pi extension entrypoint", () => {
    expect(Object.keys(entrypoint)).toEqual(["default"]);
  });

  it("registers journal recording and one search tool without commands or UI", () => {
    const calls = new Set<PropertyKey>();
    const on = vi.fn();
    const registerTool = vi.fn();
    const pi = new Proxy(
      { on, registerTool },
      {
        get(target, property) {
          if (property === "on" || property === "registerTool") return target[property];
          return (..._arguments: unknown[]) => calls.add(property);
        },
      },
    ) as unknown as ExtensionAPI;

    registerPiLedger(pi);

    expect(registerTool).toHaveBeenCalledOnce();
    expect(registerTool.mock.calls[0]?.[0]).toMatchObject({ name: "journal_search" });
    expect(on.mock.calls.map(([event]) => event)).toEqual([
      "session_start",
      "before_agent_start",
      "context",
      "agent_settled",
      "session_shutdown",
    ]);
    expect(calls).not.toContain("registerCommand");
    expect(calls).not.toContain("registerShortcut");
    expect(calls).not.toContain("registerMessageRenderer");
  });
});
