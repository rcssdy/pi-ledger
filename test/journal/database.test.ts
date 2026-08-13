import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { openJournalDatabase } from "../../src/journal/database.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { force: true, recursive: true });
});

describe("journal database", () => {
  it("records, aggregates, renders, and reopens journal facts", async () => {
    const agentDirectory = temporaryDirectory();
    const journal = await openJournalDatabase({ agentDirectory });
    expect(existsSync(journal.paths.databasePath)).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(journal.paths.journalDirectory).mode & 0o777).toBe(0o700);
      expect(statSync(journal.paths.databasePath).mode & 0o777).toBe(0o600);
    }

    journal.beginEntry(entry("Add webhook retries"));
    expect(journal.listPendingEntries("session-1")).toEqual([
      expect.objectContaining({ userEntryId: "user-1", request: "Add webhook retries" }),
    ]);
    journal.settleEntry({
      piSessionId: "session-1",
      userEntryId: "user-1",
      settledAt: "2026-08-12T12:02:00.000Z",
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
          executions: 3,
          failures: 1,
          totalTokens: 5,
          totalCost: 0.01,
        },
      ],
    });

    expect(journal.listDirtyDates()).toEqual([{ localDate: "2026-08-12", revision: 1 }]);
    journal.settleEntry({
      piSessionId: "session-1",
      userEntryId: "user-1",
      settledAt: "2026-08-12T12:03:00.000Z",
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
          executions: 3,
          failures: 1,
          totalTokens: 5,
          totalCost: 0.01,
        },
      ],
    });
    expect(journal.listDirtyDates()).toEqual([{ localDate: "2026-08-12", revision: 2 }]);
    journal.markNoteClean("2026-08-12", 1);
    expect(journal.listDirtyDates()).toEqual([{ localDate: "2026-08-12", revision: 2 }]);
    expect(journal.listDailyEntries("2026-08-12")).toEqual([
      expect.objectContaining({
        piSessionId: "session-1",
        userEntryId: "user-1",
        request: "Add webhook retries",
        models: [expect.objectContaining({ model: "gpt-test", responses: 2 })],
        tools: [expect.objectContaining({ name: "read", executions: 3, failures: 1 })],
      }),
    ]);

    journal.close();
    journal.close();
    const reopened = await openJournalDatabase({ agentDirectory });
    expect(reopened.listDirtyDates()).toEqual([{ localDate: "2026-08-12", revision: 2 }]);
    reopened.markNoteClean("2026-08-12", 2);
    expect(reopened.listDirtyDates()).toEqual([]);
    reopened.markAllNotesDirty();
    expect(reopened.listDirtyDates()).toEqual([{ localDate: "2026-08-12", revision: 1 }]);
    reopened.close();
  });

  it("provides ranked full-text search with metadata filters", async () => {
    const journal = await openJournalDatabase({ agentDirectory: temporaryDirectory() });
    record(journal, entry("Add webhook retries"));
    record(
      journal,
      {
        ...entry("Improve delivery scheduling"),
        userEntryId: "user-2",
        cwd: "/work/other",
        localDate: "2026-08-13",
        localTime: "09:00",
      },
      "anthropic",
      "claude-test",
      "edit",
    );
    record(journal, {
      ...entry("Improve webhook retry diagnostics"),
      userEntryId: "user-3",
      cwd: "/work/diagnostics",
    });

    expect(journal.search({ query: "retry" })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          request: "Add webhook retries",
          snippet: expect.stringContaining("«"),
        }),
      ]),
    );
    expect(
      journal.search({ query: "delivery", model: "anthropic/claude", tool: "edit" }),
    ).toHaveLength(1);
    expect(journal.search({ query: "delivery", cwd: "/work/project" })).toEqual([]);
    expect(journal.search({ query: "delivery", after: "2026-08-14" })).toEqual([]);
    expect(journal.search({ query: '"delivery scheduling"' })).toHaveLength(1);
    expect(journal.search({ query: "' OR 1=1 --" })).toEqual([]);
    expect(journal.search({ query: "webhook scheduling" })).toHaveLength(3);
    expect(journal.related(1)).toEqual([
      expect.objectContaining({ request: "Improve webhook retry diagnostics" }),
    ]);
    expect(() => journal.search({ query: "delivery", after: "2026-99-99" })).toThrow(
      "Invalid local date",
    );
    journal.close();
  });

  it("persists project recording exclusions", async () => {
    const journal = await openJournalDatabase({ agentDirectory: temporaryDirectory() });
    expect(journal.isProjectExcluded("/work/project")).toBe(false);
    journal.setProjectExcluded("/work/project", true);
    expect(journal.isProjectExcluded("/work/project")).toBe(true);
    journal.setProjectExcluded("/work/project", false);
    expect(journal.isProjectExcluded("/work/project")).toBe(false);
    journal.close();
  });

  it("marks every remaining pending entry interrupted", async () => {
    const journal = await openJournalDatabase({ agentDirectory: temporaryDirectory() });
    journal.beginEntry(entry("First pending"));
    journal.beginEntry({ ...entry("Second pending"), userEntryId: "user-2" });

    expect(journal.interruptPendingEntries("session-1", "2026-08-12T12:05:00.000Z")).toHaveLength(
      2,
    );
    expect(journal.listPendingEntries("session-1")).toEqual([]);
    expect(journal.listDailyEntries("2026-08-12").map((item) => item.state)).toEqual([
      "interrupted",
      "interrupted",
    ]);
    journal.close();
  });
});

function entry(request: string) {
  return {
    piSessionId: "session-1",
    userEntryId: "user-1",
    sessionFile: "/sessions/one.jsonl",
    cwd: "/work/project",
    request,
    startedAt: "2026-08-12T12:01:00.000Z",
    localDate: "2026-08-12",
    localTime: "12:01",
  };
}

function record(
  journal: Awaited<ReturnType<typeof openJournalDatabase>>,
  input: ReturnType<typeof entry>,
  provider = "openai",
  model = "gpt-test",
  tool = "read",
): void {
  journal.beginEntry(input);
  journal.settleEntry({
    piSessionId: input.piSessionId,
    userEntryId: input.userEntryId,
    settledAt: input.startedAt,
    models: [{ provider, model, responses: 1, totalTokens: 10, totalCost: 0.1 }],
    tools: [{ name: tool, executions: 1, failures: 0, totalTokens: 0, totalCost: 0 }],
  });
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "pi-ledger-"));
  directories.push(directory);
  return directory;
}
