import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { LifecycleRecorder } from "../../src/lifecycle/lifecycle-recorder.js";
import type {
  LifecycleStore,
  PendingInteractionRecord,
  SessionRecordInput,
  SettledInteractionInput,
} from "../../src/storage/lifecycle-store.js";

const USAGE = {
  input: 10,
  output: 5,
  cacheRead: 2,
  cacheWrite: 1,
  cacheWrite1h: 1,
  reasoning: 3,
  totalTokens: 18,
  cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 },
};

describe("LifecycleRecorder", () => {
  it("partitions assistant, tool, and usage metadata by initiating user leaf", () => {
    const store = new MemoryLifecycleStore();
    let tick = 0;
    const recorder = new LifecycleRecorder(store, {
      now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)),
    });
    const session = SessionManager.inMemory("/worktree");
    recorder.sessionStarted(session);

    const firstLeaf = session.appendMessage({
      role: "user",
      content: "First request",
      timestamp: 1,
    });
    recorder.interactionStarted(session, "Expanded first request");
    session.appendMessage(assistantMessage("assistant-one", "toolUse"));
    recorder.toolStarted(session, "call-one");
    recorder.toolEnded(session, "call-one");
    session.appendMessage({
      role: "toolResult",
      toolCallId: "call-one",
      toolName: "read",
      content: [{ type: "text", text: "result" }],
      isError: false,
      usage: USAGE,
      timestamp: 3,
    });
    session.appendMessage(assistantMessage("assistant-two", "stop"));

    const secondLeaf = session.appendMessage({
      role: "user",
      content: "Second request",
      timestamp: 5,
    });
    recorder.interactionStarted(session, "Expanded second request");
    session.appendMessage(assistantMessage("assistant-three", "stop"));

    recorder.agentSettled(session);

    expect(store.settlements).toHaveLength(2);
    expect(store.settlements[0]).toMatchObject({
      piLeafEntryId: firstLeaf,
      assistants: [
        { model: "assistant-one", provider: "test-provider" },
        { model: "assistant-two", provider: "test-provider" },
      ],
      tools: [
        {
          toolCallId: "call-one",
          toolName: "read",
          isError: false,
          usage: USAGE,
        },
      ],
    });
    expect(store.settlements[1]).toMatchObject({
      piLeafEntryId: secondLeaf,
      assistants: [{ model: "assistant-three" }],
      tools: [],
    });
  });

  it("preserves available metadata when shutdown interrupts active work", () => {
    const store = new MemoryLifecycleStore();
    const recorder = new LifecycleRecorder(store, {
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    const session = SessionManager.inMemory("/worktree");
    recorder.sessionStarted(session);
    const leaf = session.appendMessage({ role: "user", content: "Pending", timestamp: 1 });
    recorder.interactionStarted(session, "Pending");
    session.appendMessage(assistantMessage("partial", "toolUse"));

    recorder.sessionShutdown(session, "quit");

    expect(store.settlements).toEqual([
      expect.objectContaining({
        piLeafEntryId: leaf,
        state: "interrupted",
        assistants: [expect.objectContaining({ model: "partial", usage: USAGE })],
      }),
    ]);
  });

  it("leaves incomplete work pending during reload and interrupts it on final shutdown", () => {
    const store = new MemoryLifecycleStore();
    const recorder = new LifecycleRecorder(store, {
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    const session = SessionManager.inMemory("/worktree");
    recorder.sessionStarted(session);
    session.appendMessage({ role: "user", content: "Pending", timestamp: 1 });
    recorder.interactionStarted(session, "Pending");
    session.appendMessage(assistantMessage("incomplete-tool-call", "toolUse"));

    recorder.agentSettled(session);
    expect(store.settlements).toEqual([]);
    recorder.sessionShutdown(session, "reload");
    expect(store.interrupted).toEqual([]);
    expect(store.closed).toEqual([]);

    recorder.sessionShutdown(session, "quit");
    expect(store.interrupted).toEqual([session.getSessionId()]);
    expect(store.closed).toEqual([session.getSessionId()]);
  });

  it("uses the session header timestamp and idempotent user leaf identity", () => {
    const store = new MemoryLifecycleStore();
    const recorder = new LifecycleRecorder(store);
    const session = SessionManager.inMemory("/worktree");
    recorder.sessionStarted(session);
    const leaf = session.appendMessage({ role: "user", content: "Request", timestamp: 1 });

    recorder.interactionStarted(session, "Expanded request");
    recorder.interactionStarted(session, "Expanded request again");

    expect(store.sessions[0]).toMatchObject({
      piSessionId: session.getSessionId(),
      startedAt: session.getHeader()!.timestamp,
    });
    expect(store.pending).toEqual([
      {
        piLeafEntryId: leaf,
        userRequest: "Expanded request again",
        startedAt: expect.any(String),
      },
    ]);
  });
});

function assistantMessage(model: string, stopReason: "toolUse" | "stop") {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text: model }],
    api: "test-api",
    provider: "test-provider",
    model,
    usage: USAGE,
    stopReason,
    timestamp: 2,
  };
}

class MemoryLifecycleStore implements LifecycleStore {
  sessions: SessionRecordInput[] = [];
  pending: PendingInteractionRecord[] = [];
  settlements: SettledInteractionInput[] = [];
  interrupted: string[] = [];
  closed: string[] = [];

  startSession(input: SessionRecordInput): void {
    this.sessions.push(input);
  }

  beginInteraction(_piSessionId: string, interaction: PendingInteractionRecord): void {
    const existing = this.pending.find(
      (candidate) => candidate.piLeafEntryId === interaction.piLeafEntryId,
    );
    if (existing === undefined) this.pending.push(interaction);
    else existing.userRequest = interaction.userRequest;
  }

  listPendingInteractions(_piSessionId: string): readonly PendingInteractionRecord[] {
    return this.pending;
  }

  settleInteraction(input: SettledInteractionInput): void {
    this.settlements.push(input);
    this.pending = this.pending.filter(
      (interaction) => interaction.piLeafEntryId !== input.piLeafEntryId,
    );
  }

  interruptPendingInteractions(piSessionId: string): void {
    this.interrupted.push(piSessionId);
    this.pending = [];
  }

  closeSession(piSessionId: string): void {
    this.closed.push(piSessionId);
  }
}
