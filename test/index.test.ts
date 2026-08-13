import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import registerPiLedger from "../src/index.js";

describe("pi-ledger extension", () => {
  it("registers journal recording, search tools, and one command", () => {
    const on = vi.fn();
    const registerTool = vi.fn();
    const registerCommand = vi.fn();
    const pi = { on, registerCommand, registerTool } as unknown as ExtensionAPI;

    registerPiLedger(pi);

    expect(registerTool.mock.calls.map(([tool]) => tool.name)).toEqual([
      "journal_search",
      "journal_related",
    ]);
    expect(registerCommand).toHaveBeenCalledOnce();
    expect(registerCommand).toHaveBeenCalledWith("ledger", expect.any(Object));
    expect(on.mock.calls.map(([event]) => event)).toEqual([
      "session_start",
      "before_agent_start",
      "context",
      "agent_settled",
      "session_shutdown",
    ]);
  });
});
