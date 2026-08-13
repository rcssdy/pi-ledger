import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { registerLifecycleRecording } from "../../src/lifecycle/pi-lifecycle.js";
import type { LedgerDatabase } from "../../src/storage/ledger-database.js";
import type {
  LifecycleStore,
  PendingInteractionRecord,
  SessionRecordInput,
  SettledInteractionInput,
} from "../../src/storage/lifecycle-store.js";

type Handler = (event: never, context: ExtensionContext) => unknown;

describe("Pi lifecycle recording adapter", () => {
  it("records a complete interaction and closes the ledger at shutdown", async () => {
    const handlers = new Map<string, Handler>();
    const pi = {
      on: vi.fn((event: string, handler: Handler) => handlers.set(event, handler)),
    } as unknown as ExtensionAPI;
    const store = new RecordingStore();
    const close = vi.fn();
    const ledger = fakeLedger(store, close);
    registerLifecycleRecording(pi, { openDatabase: async () => ledger });

    const session = SessionManager.inMemory("/worktree");
    const context = { sessionManager: session } as unknown as ExtensionContext;
    await invoke(handlers, "session_start", { type: "session_start", reason: "startup" }, context);

    await invoke(
      handlers,
      "before_agent_start",
      { type: "before_agent_start", prompt: "Expanded request" },
      context,
    );
    const userLeaf = session.appendMessage({ role: "user", content: "Request", timestamp: 1 });
    await invoke(handlers, "context", { type: "context", messages: [] }, context);
    session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Done" }],
      api: "test-api",
      provider: "test-provider",
      model: "test-model",
      usage: emptyUsage(),
      stopReason: "stop",
      timestamp: 2,
    });
    const followUpLeaf = session.appendMessage({
      role: "user",
      content: "Queued follow-up",
      timestamp: 3,
    });
    await invoke(handlers, "context", { type: "context", messages: [] }, context);
    session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Follow-up done" }],
      api: "test-api",
      provider: "test-provider",
      model: "test-model",
      usage: emptyUsage(),
      stopReason: "stop",
      timestamp: 4,
    });
    await invoke(handlers, "agent_settled", { type: "agent_settled" }, context);
    await invoke(
      handlers,
      "session_shutdown",
      { type: "session_shutdown", reason: "quit" },
      context,
    );

    expect(store.sessions).toHaveLength(1);
    expect(store.settlements).toEqual([
      expect.objectContaining({
        piLeafEntryId: userLeaf,
        assistants: [expect.objectContaining({ provider: "test-provider", model: "test-model" })],
      }),
      expect.objectContaining({
        piLeafEntryId: followUpLeaf,
        assistants: [expect.objectContaining({ provider: "test-provider", model: "test-model" })],
      }),
    ]);
    expect(store.closed).toEqual([session.getSessionId()]);
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes resources on reload without interrupting the logical session", async () => {
    const handlers = new Map<string, Handler>();
    const pi = {
      on: vi.fn((event: string, handler: Handler) => handlers.set(event, handler)),
    } as unknown as ExtensionAPI;
    const store = new RecordingStore();
    const close = vi.fn();
    registerLifecycleRecording(pi, {
      openDatabase: async () => fakeLedger(store, close),
    });
    const session = SessionManager.inMemory("/worktree");
    const context = { sessionManager: session } as unknown as ExtensionContext;

    await invoke(handlers, "session_start", { type: "session_start", reason: "startup" }, context);
    await invoke(
      handlers,
      "before_agent_start",
      { type: "before_agent_start", prompt: "Pending" },
      context,
    );
    session.appendMessage({ role: "user", content: "Pending", timestamp: 1 });
    await invoke(handlers, "context", { type: "context", messages: [] }, context);
    await invoke(
      handlers,
      "session_shutdown",
      { type: "session_shutdown", reason: "reload" },
      context,
    );

    expect(store.interrupted).toEqual([]);
    expect(store.closed).toEqual([]);
    expect(close).toHaveBeenCalledOnce();
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

function fakeLedger(store: LifecycleStore, close: () => void): LedgerDatabase {
  return {
    lifecycle: store,
    paths: {
      agentDirectory: "/agent",
      ledgerDirectory: "/agent/ledger",
      databasePath: "/agent/ledger/ledger.sqlite",
      notesDirectory: "/agent/ledger/notes",
    },
    health() {
      return {
        databasePath: "/agent/ledger/ledger.sqlite",
        userVersion: 2,
        foreignKeys: true,
        journalMode: "wal",
        synchronous: 1,
        busyTimeoutMilliseconds: 5_000,
      };
    },
    close,
  };
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

class RecordingStore implements LifecycleStore {
  sessions: SessionRecordInput[] = [];
  pending: PendingInteractionRecord[] = [];
  settlements: SettledInteractionInput[] = [];
  interrupted: string[] = [];
  closed: string[] = [];

  startSession(input: SessionRecordInput): void {
    this.sessions.push(input);
  }

  beginInteraction(_piSessionId: string, interaction: PendingInteractionRecord): void {
    this.pending.push(interaction);
  }

  listPendingInteractions(): readonly PendingInteractionRecord[] {
    return this.pending;
  }

  settleInteraction(input: SettledInteractionInput): void {
    this.settlements.push(input);
    this.pending = this.pending.filter((pending) => pending.piLeafEntryId !== input.piLeafEntryId);
  }

  interruptPendingInteractions(piSessionId: string): void {
    this.interrupted.push(piSessionId);
  }

  closeSession(piSessionId: string): void {
    this.closed.push(piSessionId);
  }
}
