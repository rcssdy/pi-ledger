import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

import type {
  AssistantMetadata,
  LifecycleStore,
  ToolMetadata,
  UsageRecord,
} from "../storage/lifecycle-store.js";

export interface LifecycleRecorderOptions {
  now?: () => Date;
}

type ReadonlySessionManager = ExtensionContext["sessionManager"];

interface ToolTiming {
  startedAt: string;
  endedAt?: string;
}

export class LifecycleRecorder {
  readonly #store: LifecycleStore;
  readonly #now: () => Date;
  readonly #toolTimings = new Map<string, ToolTiming>();

  constructor(store: LifecycleStore, options: LifecycleRecorderOptions = {}) {
    this.#store = store;
    this.#now = options.now ?? (() => new Date());
  }

  sessionStarted(sessionManager: ReadonlySessionManager): void {
    const header = sessionManager.getHeader();
    if (header === null) throw new Error("Cannot record a session without a header");
    this.#store.startSession({
      piSessionId: sessionManager.getSessionId(),
      sessionFile: sessionManager.getSessionFile(),
      startedAt: header.timestamp,
    });
  }

  interactionStarted(sessionManager: ReadonlySessionManager, expandedUserRequest?: string): void {
    const userEntry = findLatestUserEntry(sessionManager.getBranch());
    if (userEntry?.type !== "message" || userEntry.message.role !== "user") {
      throw new Error("Cannot start an interaction without a user-message leaf");
    }
    this.#store.beginInteraction(sessionManager.getSessionId(), {
      piLeafEntryId: userEntry.id,
      userRequest: expandedUserRequest ?? userMessageText(userEntry.message.content),
      startedAt: userEntry.timestamp,
    });
  }

  toolStarted(sessionManager: ReadonlySessionManager, toolCallId: string): void {
    this.#toolTimings.set(toolKey(sessionManager.getSessionId(), toolCallId), {
      startedAt: this.#now().toISOString(),
    });
  }

  toolEnded(sessionManager: ReadonlySessionManager, toolCallId: string): void {
    const key = toolKey(sessionManager.getSessionId(), toolCallId);
    const current = this.#toolTimings.get(key);
    this.#toolTimings.set(key, {
      startedAt: current?.startedAt ?? this.#now().toISOString(),
      endedAt: this.#now().toISOString(),
    });
  }

  agentSettled(sessionManager: ReadonlySessionManager): void {
    const piSessionId = sessionManager.getSessionId();
    const branch = sessionManager.getBranch();
    const pending = this.#store.listPendingInteractions(piSessionId);
    const pendingByLeaf = new Map(
      pending.map((interaction) => [interaction.piLeafEntryId, interaction]),
    );
    const activePendingIndexes = branch
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => pendingByLeaf.has(entry.id));

    for (const [position, active] of activePendingIndexes.entries()) {
      const nextIndex = activePendingIndexes[position + 1]?.index ?? branch.length;
      const entries = branch.slice(active.index + 1, nextIndex);
      const assistants = collectAssistants(entries);
      if (!isCompleteInteraction(entries, assistants)) continue;
      this.#store.settleInteraction({
        piSessionId,
        piLeafEntryId: active.entry.id,
        settledAt: this.#now().toISOString(),
        assistants,
        tools: collectTools(entries, piSessionId, this.#toolTimings),
      });
    }

    for (const tool of this.#toolTimings.keys()) {
      if (tool.startsWith(`${piSessionId}\0`)) this.#toolTimings.delete(tool);
    }
  }

  sessionShutdown(
    sessionManager: ReadonlySessionManager,
    reason: "quit" | "reload" | "new" | "resume" | "fork",
  ): void {
    if (reason === "reload") return;
    const piSessionId = sessionManager.getSessionId();
    const endedAt = this.#now().toISOString();
    const branch = sessionManager.getBranch();
    const pending = this.#store.listPendingInteractions(piSessionId);
    const pendingIds = new Set(pending.map((interaction) => interaction.piLeafEntryId));
    const indexes = branch
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => pendingIds.has(entry.id));
    for (const [position, active] of indexes.entries()) {
      const nextIndex = indexes[position + 1]?.index ?? branch.length;
      const entries = branch.slice(active.index + 1, nextIndex);
      this.#store.settleInteraction({
        piSessionId,
        piLeafEntryId: active.entry.id,
        settledAt: endedAt,
        state: "interrupted",
        assistants: collectAssistants(entries),
        tools: collectTools(entries, piSessionId, this.#toolTimings),
      });
    }
    this.#store.interruptPendingInteractions(piSessionId, endedAt);
    this.#store.closeSession(piSessionId, endedAt);
    for (const tool of this.#toolTimings.keys()) {
      if (tool.startsWith(`${piSessionId}\0`)) this.#toolTimings.delete(tool);
    }
  }
}

function findLatestUserEntry(entries: readonly SessionEntry[]): SessionEntry | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type === "message" && entry.message.role === "user") return entry;
  }
  return undefined;
}

function userMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        part.type === "text" &&
        "text" in part &&
        typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("\n");
}

function isCompleteInteraction(
  entries: readonly SessionEntry[],
  assistants: readonly AssistantMetadata[],
): boolean {
  if (assistants.length === 0) return false;
  let lastMessage: SessionEntry | undefined;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]?.type === "message") {
      lastMessage = entries[index];
      break;
    }
  }
  if (lastMessage?.type !== "message") return false;
  if (lastMessage.message.role === "assistant") {
    return lastMessage.message.stopReason !== "toolUse";
  }
  if (lastMessage.message.role !== "toolResult") return false;

  const requested = new Set<string>();
  const completed = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    if (entry.message.role === "assistant") {
      for (const content of entry.message.content) {
        if (content.type === "toolCall") requested.add(content.id);
      }
    } else if (entry.message.role === "toolResult") {
      completed.add(entry.message.toolCallId);
    }
  }
  return requested.size > 0 && [...requested].every((id) => completed.has(id));
}

function collectAssistants(entries: readonly SessionEntry[]): AssistantMetadata[] {
  const assistants: AssistantMetadata[] = [];
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const message = entry.message;
    assistants.push({
      piEntryId: entry.id,
      api: message.api,
      provider: message.provider,
      model: message.model,
      stopReason: message.stopReason,
      errorMessage: message.errorMessage,
      createdAt: entry.timestamp,
      usage: copyUsage(message.usage),
    });
  }
  return assistants;
}

function collectTools(
  entries: readonly SessionEntry[],
  piSessionId: string,
  timings: ReadonlyMap<string, ToolTiming>,
): ToolMetadata[] {
  const tools: ToolMetadata[] = [];
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
    const message = entry.message;
    const timing = timings.get(toolKey(piSessionId, message.toolCallId));
    tools.push({
      piEntryId: entry.id,
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      startedAt: timing?.startedAt,
      endedAt: timing?.endedAt ?? entry.timestamp,
      isError: message.isError,
      usage: message.usage === undefined ? undefined : copyUsage(message.usage),
    });
  }
  return tools;
}

function copyUsage(usage: UsageRecord): UsageRecord {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    cacheWrite1h: usage.cacheWrite1h,
    reasoning: usage.reasoning,
    totalTokens: usage.totalTokens,
    cost: { ...usage.cost },
  };
}

function toolKey(piSessionId: string, toolCallId: string): string {
  return `${piSessionId}\0${toolCallId}`;
}
