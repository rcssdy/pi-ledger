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
                inputTokens: 10_000,
                outputTokens: 1_420,
                cacheReadTokens: 50_000,
                cacheWriteTokens: 10_000,
                totalTokens: 71_420,
                totalCost: 1.61,
              },
              {
                provider: "anthropic",
                model: "claude-sonnet-4-6",
                responses: 1,
                inputTokens: 1_000,
                outputTokens: 71,
                cacheReadTokens: 10_000,
                cacheWriteTokens: 0,
                totalTokens: 11_071,
                totalCost: 0.11,
              },
            ],
            tools: [
              {
                name: "read",
                executions: 8,
                failures: 0,
                inputTokens: 0,
                outputTokens: 0,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                totalTokens: 0,
                totalCost: 0,
              },
              {
                name: "edit",
                executions: 3,
                failures: 0,
                inputTokens: 0,
                outputTokens: 0,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                totalTokens: 0,
                totalCost: 0,
              },
              {
                name: "bash",
                executions: 5,
                failures: 0,
                inputTokens: 0,
                outputTokens: 0,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                totalTokens: 0,
                totalCost: 0,
              },
            ],
          },
          {
            id: 2,
            piSessionId: "019f…",
            userEntryId: "def456",
            sessionFile: "/home/me/.pi/agent/sessions/project/session.jsonl",
            cwd: "/work/pi-ledger",
            request: "Run the focused tests",
            state: "settled",
            startedAt: "2026-08-12T14:45:00.000Z",
            localTime: "14:45",
            models: [
              {
                provider: "openai",
                model: "gpt-5.6-sol",
                responses: 2,
                inputTokens: 1_000,
                outputTokens: 80,
                cacheReadTokens: 7_500,
                cacheWriteTokens: 0,
                totalTokens: 8_580,
                totalCost: 0.19,
              },
            ],
            tools: [
              {
                name: "read",
                executions: 2,
                failures: 1,
                inputTokens: 0,
                outputTokens: 0,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
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

### 14:32–14:45 — Add timezone-aware journal timestamps and tests

**Transcript:** [Open Pi session](<file:///home/me/.pi/agent/sessions/project/session.jsonl>) · Session \`019f…\`

**Requests:** 2
- **14:32** — Add timezone-aware journal timestamps and tests
- **14:45** — Run the focused tests

**Models:** \`openai/gpt-5.6-sol\`, \`anthropic/claude-sonnet-4-6\`

**Usage:** 91,071 tokens (input 12,000 · output 1,571 · cache read 67,500 · cache write 10,000) · $1.91
- \`openai/gpt-5.6-sol\`: 80,000 tokens (input 11,000 · output 1,500 · cache read 57,500 · cache write 10,000) · $1.8 · 6 responses
- \`anthropic/claude-sonnet-4-6\`: 11,071 tokens (input 1,000 · output 71 · cache read 10,000 · cache write 0) · $0.11 · 1 response

**Tools:** \`read\` ×10, 1 failed · \`edit\` ×3 · \`bash\` ×5
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
