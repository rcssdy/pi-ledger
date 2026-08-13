import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerJournalExtension } from "../src/extension.js";
import { openJournalDatabase } from "../src/journal/database.js";

type Handler = (event: never, context: ExtensionContext) => unknown;
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("journal extension", () => {
  it("records lifecycle facts and regenerates the daily note", async () => {
    const journal = await openJournalDatabase({ agentDirectory: temporaryDirectory() });
    const handlers = new Map<string, Handler>();
    const pi = {
      registerTool: vi.fn(),
      on: vi.fn((event: string, handler: Handler) => handlers.set(event, handler)),
    } as unknown as ExtensionAPI;
    registerJournalExtension(pi, { openJournal: async () => journal });

    const session = SessionManager.inMemory("/work/project");
    const context = { sessionManager: session } as unknown as ExtensionContext;
    await invoke(handlers, "session_start", { type: "session_start", reason: "startup" }, context);
    await invoke(
      handlers,
      "before_agent_start",
      { type: "before_agent_start", prompt: "Expanded request" },
      context,
    );
    session.appendMessage({ role: "user", content: "Raw request", timestamp: 1 });
    await invoke(handlers, "context", { type: "context", messages: [] }, context);
    session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Done" }],
      api: "responses",
      provider: "openai",
      model: "gpt-test",
      usage: emptyUsage(),
      stopReason: "stop",
      timestamp: 2,
    });
    await invoke(handlers, "agent_settled", { type: "agent_settled" }, context);

    const date = journal.listDates()[0]!;
    expect(readFileSync(join(journal.paths.notesDirectory, `${date}.md`), "utf8")).toContain(
      "Expanded request",
    );
    await invoke(
      handlers,
      "session_shutdown",
      { type: "session_shutdown", reason: "quit" },
      context,
    );
  });

  it("exposes ranked journal search through the agent tool", async () => {
    const journal = await openJournalDatabase({ agentDirectory: temporaryDirectory() });
    journal.beginEntry({
      piSessionId: "session-1",
      userEntryId: "user-1",
      cwd: "/work/project",
      request: "Add webhook retries",
      startedAt: "2026-08-12T12:00:00.000Z",
      localDate: "2026-08-12",
      localTime: "12:00",
    });
    journal.settleEntry({
      piSessionId: "session-1",
      userEntryId: "user-1",
      settledAt: "2026-08-12T12:01:00.000Z",
      models: [],
      tools: [],
    });
    let tool: ToolDefinition | undefined;
    const pi = {
      registerTool: vi.fn((definition: ToolDefinition) => {
        tool = definition;
      }),
      on: vi.fn(),
    } as unknown as ExtensionAPI;
    registerJournalExtension(pi, { openJournal: async () => journal });

    const result = await tool!.execute(
      "search-1",
      { query: "webhook" } as never,
      undefined,
      undefined,
      {} as never,
    );
    expect(result.content).toEqual([
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("Add webhook retries"),
      }),
    ]);
    journal.close();
  });
});

async function invoke(
  handlers: ReadonlyMap<string, Handler>,
  eventName: string,
  event: unknown,
  context: ExtensionContext,
): Promise<void> {
  const handler = handlers.get(eventName);
  if (handler === undefined) throw new Error(`Missing handler: ${eventName}`);
  await handler(event as never, context);
}

function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "pi-ledger-extension-"));
  directories.push(directory);
  return directory;
}
