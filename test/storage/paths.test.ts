import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveLedgerPaths } from "../../src/storage/paths.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("ledger paths", () => {
  it("prefers an explicit agent directory", () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/ignored");

    const paths = resolveLedgerPaths("./custom-agent");

    expect(paths.agentDirectory).toBe(resolve("./custom-agent"));
    expect(paths.databasePath).toBe(resolve("./custom-agent/ledger/ledger.sqlite"));
    expect(paths.notesDirectory).toBe(resolve("./custom-agent/ledger/notes"));
  });

  it("expands a home-relative explicit agent directory", () => {
    const paths = resolveLedgerPaths("~/custom-agent");

    expect(paths.agentDirectory).toBe(join(homedir(), "custom-agent"));
  });

  it("honors Pi's agent directory environment variable", () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "~/pi-agent");

    const paths = resolveLedgerPaths();

    expect(paths.agentDirectory).toBe(join(homedir(), "pi-agent"));
    expect(paths.databasePath).toBe(join(homedir(), "pi-agent", "ledger", "ledger.sqlite"));
  });
});
