import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveJournalPaths } from "../../src/journal/paths.js";

afterEach(() => vi.unstubAllEnvs());

describe("journal paths", () => {
  it("resolves an explicit agent directory", () => {
    const paths = resolveJournalPaths("./custom-agent");
    expect(paths.agentDirectory).toBe(resolve("./custom-agent"));
    expect(paths.databasePath).toBe(resolve("./custom-agent/ledger/ledger.sqlite"));
    expect(paths.notesDirectory).toBe(resolve("./custom-agent/ledger/notes"));
  });

  it("expands home-relative paths and honors Pi's agent directory", () => {
    expect(resolveJournalPaths("~/custom-agent").agentDirectory).toBe(
      join(homedir(), "custom-agent"),
    );
    vi.stubEnv("PI_CODING_AGENT_DIR", "~/pi-agent");
    expect(resolveJournalPaths().agentDirectory).toBe(join(homedir(), "pi-agent"));
  });
});
