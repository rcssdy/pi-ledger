import { SessionManager } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { openJournalDatabase } from "../../src/journal/database.js";
import { JournalRecorder } from "../../src/journal/recorder.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const USAGE = {
  input: 10,
  output: 5,
  cacheRead: 2,
  cacheWrite: 1,
  totalTokens: 18,
  cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 },
};

describe("journal recorder", () => {
  it("partitions and aggregates model and tool facts by initiating user entry", async () => {
    const journal = await openJournalDatabase(temporaryDirectory());
    const recorder = new JournalRecorder(journal, {
      now: () => new Date("2026-08-12T12:10:00.000Z"),
    });
    const session = SessionManager.inMemory("/work/project");
    session.appendMessage({ role: "user", content: "Raw request", timestamp: 1 });
    recorder.entryStarted(session, "Expanded request");
    recorder.entryStarted(session);
    session.appendMessage(assistant("gpt-test", "toolUse"));
    session.appendMessage({
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: [{ type: "text", text: "result" }],
      isError: true,
      usage: USAGE,
      timestamp: 3,
    });
    session.appendMessage(assistant("gpt-test", "stop"));

    const recorded = recorder.agentSettled(session);
    expect(recorded).toHaveLength(1);
    expect(journal.listDailyEntries(recorded[0]!.localDate)).toEqual([
      expect.objectContaining({
        request: "Expanded request",
        state: "settled",
        models: [
          expect.objectContaining({
            provider: "openai",
            model: "gpt-test",
            responses: 2,
            totalTokens: 36,
            totalCost: 0.66,
          }),
        ],
        tools: [
          expect.objectContaining({
            name: "read",
            executions: 1,
            failures: 1,
            totalTokens: 18,
          }),
        ],
      }),
    ]);
    journal.close();
  });

  it("keeps pending work across reload and interrupts it at final shutdown", async () => {
    const journal = await openJournalDatabase(temporaryDirectory());
    const recorder = new JournalRecorder(journal, {
      now: () => new Date("2026-08-12T12:10:00.000Z"),
    });
    const session = SessionManager.inMemory("/work/project");
    session.appendMessage({ role: "user", content: "Pending", timestamp: 1 });
    recorder.entryStarted(session, "Pending");
    session.appendMessage(assistant("gpt-test", "toolUse"));

    expect(recorder.agentSettled(session)).toEqual([]);
    expect(recorder.sessionShutdown(session, "reload")).toEqual([]);
    const interrupted = recorder.sessionShutdown(session, "quit");
    expect(interrupted).toHaveLength(1);
    expect(journal.listDailyEntries(interrupted[0]!.localDate)[0]?.state).toBe("interrupted");
    journal.close();
  });
});

function assistant(model: string, stopReason: "toolUse" | "stop") {
  return {
    role: "assistant" as const,
    content:
      stopReason === "toolUse"
        ? [{ type: "toolCall" as const, id: "call-1", name: "read", arguments: {} }]
        : [{ type: "text" as const, text: "Done" }],
    api: "responses",
    provider: "openai",
    model,
    usage: USAGE,
    stopReason,
    timestamp: 2,
  };
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "pi-ledger-recorder-"));
  directories.push(directory);
  return directory;
}
