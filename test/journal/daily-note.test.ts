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
  it("atomically writes a deterministic daily journal", async () => {
    const notesDirectory = mkdtempSync(join(tmpdir(), "pi-ledger-notes-"));
    directories.push(notesDirectory);
    const writer = new DailyNoteWriter(
      {
        listDates: () => ["2026-08-12"],
        listDailyEntries: () => [
          {
            id: 1,
            piSessionId: "session-1",
            userEntryId: "user-1",
            sessionFile: "/sessions/one.jsonl",
            cwd: "/work/pi-ledger",
            request: "Generate #daily [notes]",
            state: "settled",
            startedAt: "2026-08-12T12:01:00.000Z",
            localTime: "12:01",
            models: [
              {
                provider: "openai",
                model: "gpt-test",
                responses: 2,
                totalTokens: 135,
                totalCost: 0.33,
              },
            ],
            tools: [
              {
                name: "read",
                executions: 2,
                failures: 1,
                totalTokens: 5,
                totalCost: 0.01,
              },
            ],
          },
        ],
      },
      notesDirectory,
    );

    const path = await writer.regenerate("2026-08-12");
    expect(path).toBe(join(notesDirectory, "2026-08-12.md"));
    expect(readFileSync(path, "utf8")).toContain("# Daily Journal — 2026-08-12");
    expect(readFileSync(path, "utf8")).toContain(String.raw`Generate \#daily \[notes\]`);
    expect(readFileSync(path, "utf8")).toContain("**Usage:** 140 tokens · $0.34");
    expect(readFileSync(path, "utf8")).toContain("**Tools:** `read` ×2, 1 failed");
    expect(readFileSync(path, "utf8")).toContain("file:///sessions/one.jsonl");
  });
});
