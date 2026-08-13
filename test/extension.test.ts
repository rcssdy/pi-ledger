import type {
  ExtensionAPI,
  ExtensionContext,
  RegisteredCommand,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
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
    const journal = await openJournalDatabase(temporaryDirectory());
    const handlers = new Map<string, Handler>();
    const pi = {
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      on: vi.fn((event: string, handler: Handler) => handlers.set(event, handler)),
    } as unknown as ExtensionAPI;
    registerJournalExtension(pi, { openJournal: async () => journal });

    const session = SessionManager.inMemory("/work/project");
    const context = {
      sessionManager: session,
      ui: { notify: vi.fn(), setStatus: vi.fn() },
    } as unknown as ExtensionContext;
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

    const note = readdirSync(journal.paths.notesDirectory)[0]!;
    expect(readFileSync(join(journal.paths.notesDirectory, note), "utf8")).toContain(
      "Expanded request",
    );
    expect(journal.listDirtyDates()).toEqual([]);
    await invoke(
      handlers,
      "session_shutdown",
      { type: "session_shutdown", reason: "quit" },
      context,
    );
  });

  it("exposes ranked journal search through the agent tool", async () => {
    const journal = await openJournalDatabase(temporaryDirectory());
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
      models: [
        {
          provider: "openai",
          model: "gpt-test",
          responses: 1,
          inputTokens: 4,
          outputTokens: 2,
          cacheReadTokens: 3,
          cacheWriteTokens: 1,
          totalTokens: 10,
          totalCost: 0.1,
        },
      ],
      tools: [],
    });
    const tools = new Map<string, ToolDefinition>();
    const pi = {
      registerTool: vi.fn((definition: ToolDefinition) => {
        tools.set(definition.name, definition);
      }),
      registerCommand: vi.fn(),
      on: vi.fn(),
    } as unknown as ExtensionAPI;
    registerJournalExtension(pi, { openJournal: async () => journal });

    const result = await tools
      .get("journal_search")!
      .execute("search-1", { query: "webhook" } as never, undefined, undefined, {} as never);
    expect(result.content).toEqual([
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("Add webhook retries"),
      }),
    ]);
    expect(result.content[0]).toEqual(
      expect.objectContaining({ text: expect.stringContaining("input 4 · output 2") }),
    );
    journal.close();
  });

  it("opens once and warns once when recording is unavailable", async () => {
    const handlers = new Map<string, Handler>();
    const notify = vi.fn();
    const openJournal = vi.fn(async () => {
      throw new Error("SQLite is unavailable");
    });
    const pi = {
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      on: vi.fn((event: string, handler: Handler) => handlers.set(event, handler)),
    } as unknown as ExtensionAPI;
    registerJournalExtension(pi, { openJournal });

    const context = {
      sessionManager: SessionManager.inMemory("/work/project"),
      ui: { notify },
    } as unknown as ExtensionContext;
    await Promise.all([
      invoke(handlers, "session_start", { type: "session_start", reason: "startup" }, context),
      invoke(
        handlers,
        "before_agent_start",
        { type: "before_agent_start", prompt: "Request" },
        context,
      ),
    ]);

    expect(openJournal).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith(
      "pi-ledger stopped recording: SQLite is unavailable",
      "warning",
    );
  });

  it("controls recording by project and session through one command", async () => {
    const journal = await openJournalDatabase(temporaryDirectory());
    const session = SessionManager.inMemory("/work/project");
    const handlers = new Map<string, Handler>();
    let command: Omit<RegisteredCommand, "name" | "sourceInfo"> | undefined;
    const setStatus = vi.fn();
    const notify = vi.fn();
    const pi = {
      registerTool: vi.fn(),
      registerCommand: vi.fn(
        (_name: string, definition: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
          command = definition;
        },
      ),
      appendEntry: vi.fn((customType: string, data: unknown) =>
        session.appendCustomEntry(customType, data),
      ),
      on: vi.fn((event: string, handler: Handler) => handlers.set(event, handler)),
    } as unknown as ExtensionAPI;
    registerJournalExtension(pi, { openJournal: async () => journal });
    const context = {
      sessionManager: session,
      ui: { notify, setStatus },
    } as unknown as ExtensionContext;

    await command!.handler("off project", context as never);
    expect(journal.isProjectExcluded("/work/project")).toBe(true);
    expect(setStatus).toHaveBeenLastCalledWith("pi-ledger", "ledger off · project");
    await invoke(
      handlers,
      "before_agent_start",
      { type: "before_agent_start", prompt: "Disabled request" },
      context,
    );
    session.appendMessage({ role: "user", content: "Disabled request", timestamp: 1 });
    await invoke(handlers, "context", { type: "context", messages: [] }, context);
    expect(journal.search({ query: "disabled" })).toEqual([]);

    await command!.handler("on", context as never);
    expect(setStatus).toHaveBeenLastCalledWith("pi-ledger", undefined);
    expect(notify).toHaveBeenLastCalledWith(
      `pi-ledger recording is ON for /work/project (session)\nNotes: ${journal.paths.notesDirectory}`,
      "info",
    );
    await invoke(
      handlers,
      "before_agent_start",
      { type: "before_agent_start", prompt: "Enabled request" },
      context,
    );
    session.appendMessage({ role: "user", content: "Enabled request", timestamp: 2 });
    await invoke(handlers, "context", { type: "context", messages: [] }, context);
    session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Done" }],
      api: "responses",
      provider: "openai",
      model: "gpt-test",
      usage: emptyUsage(),
      stopReason: "stop",
      timestamp: 3,
    });
    await invoke(handlers, "agent_settled", { type: "agent_settled" }, context);
    expect(journal.search({ query: "enabled" })).toHaveLength(1);
    const notePath = join(
      journal.paths.notesDirectory,
      readdirSync(journal.paths.notesDirectory)[0]!,
    );
    rmSync(notePath);
    await command!.handler("rebuild", context as never);
    expect(existsSync(notePath)).toBe(true);
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
