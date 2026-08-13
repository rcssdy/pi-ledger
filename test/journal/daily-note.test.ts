import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DailyNoteWriter } from "../../src/journal/daily-note.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("daily note writer", () => {
  it("writes the exact daily journal format", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-ledger-notes-"));
    const notesDirectory = join(root, "notes");
    directories.push(root);
    const writer = new DailyNoteWriter(
      {
        listDirtyDates: () => [],
        markNoteClean() {},
        listDailyEntries: () => [
          {
            id: 1,
            piSessionId: "019f…",
            userEntryId: "abc123",
            sessionFile: "/home/me/.pi/agent/sessions/project/session.jsonl",
            cwd: "/work/pi-ledger",
            request: "Add timezone-aware journal timestamps and tests",
            state: "settled",
            startedAt: "2026-08-12T14:32:00.000Z",
            localTime: "14:32",
            models: [
              {
                provider: "openai",
                model: "gpt-5.6-sol",
                responses: 4,
                totalTokens: 71_420,
                totalCost: 1.61,
              },
              {
                provider: "anthropic",
                model: "claude-sonnet-4-6",
                responses: 1,
                totalTokens: 11_071,
                totalCost: 0.11,
              },
            ],
            tools: [
              {
                name: "read",
                executions: 8,
                failures: 0,
                totalTokens: 0,
                totalCost: 0,
              },
              {
                name: "edit",
                executions: 3,
                failures: 0,
                totalTokens: 0,
                totalCost: 0,
              },
              {
                name: "bash",
                executions: 5,
                failures: 0,
                totalTokens: 0,
                totalCost: 0,
              },
            ],
          },
        ],
      },
      notesDirectory,
    );

    const path = await writer.regenerate("2026-08-12");
    const markdown = readFileSync(path, "utf8");
    expect(path).toBe(join(notesDirectory, "2026-08-12.md"));
    expect(markdown).toBe(`# Daily Journal — 2026-08-12

## pi-ledger

### 14:32 — Add timezone-aware journal timestamps and tests

**Transcript:** [Open Pi session](<file:///home/me/.pi/agent/sessions/project/session.jsonl>) · Session \`019f…\` · entry \`abc123\`

**Models:** \`openai/gpt-5.6-sol\`, \`anthropic/claude-sonnet-4-6\`

**Usage:** 82,491 tokens · $1.72
- \`openai/gpt-5.6-sol\`: 71,420 tokens · $1.61 · 4 responses
- \`anthropic/claude-sonnet-4-6\`: 11,071 tokens · $0.11 · 1 response

**Tools:** \`read\` ×8 · \`edit\` ×3 · \`bash\` ×5
`);
  });

  it("keeps projects with the same directory name separate", async () => {
    const notesDirectory = mkdtempSync(join(tmpdir(), "pi-ledger-notes-"));
    directories.push(notesDirectory);
    const entries = ["/clients/acme/api", "/personal/api"].map((cwd, index) => ({
      id: index,
      piSessionId: `session-${index}`,
      userEntryId: `user-${index}`,
      cwd,
      request: `Request ${index}`,
      state: "settled" as const,
      startedAt: `2026-08-12T12:0${index}:00.000Z`,
      localTime: `12:0${index}`,
      models: [],
      tools: [],
    }));
    const writer = new DailyNoteWriter(
      { listDirtyDates: () => [], markNoteClean() {}, listDailyEntries: () => entries },
      notesDirectory,
    );

    const markdown = readFileSync(await writer.regenerate("2026-08-12"), "utf8");
    expect(markdown).toContain("## api — /clients/acme/api");
    expect(markdown).toContain("## api — /personal/api");
  });
});
