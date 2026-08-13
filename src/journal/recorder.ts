import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

import { localTimestamp } from "./local-time.js";
import type {
  BeginJournalEntry,
  ModelFacts,
  PendingJournalEntry,
  RecordedJournalEntry,
  SettleJournalEntry,
  ToolFacts,
} from "./types.js";

type ReadonlySessionManager = ExtensionContext["sessionManager"];

type JournalWriter = {
  beginEntry(input: BeginJournalEntry): void;
  listPendingEntries(piSessionId: string): readonly PendingJournalEntry[];
  settleEntry(input: SettleJournalEntry): RecordedJournalEntry | undefined;
  interruptPendingEntries(piSessionId: string, settledAt: string): readonly RecordedJournalEntry[];
};

export interface JournalRecorderOptions {
  now?: () => Date;
}

export class JournalRecorder {
  readonly #journal: JournalWriter;
  readonly #now: () => Date;

  constructor(journal: JournalWriter, options: JournalRecorderOptions = {}) {
    this.#journal = journal;
    this.#now = options.now ?? (() => new Date());
  }

  entryStarted(sessionManager: ReadonlySessionManager, expandedRequest?: string): void {
    const userEntry = findLatestUserEntry(sessionManager.getBranch());
    if (userEntry?.type !== "message" || userEntry.message.role !== "user") {
      throw new Error("Cannot start a journal entry without a user-message leaf");
    }
    const piSessionId = sessionManager.getSessionId();
    if (
      expandedRequest === undefined &&
      this.#journal
        .listPendingEntries(piSessionId)
        .some((pending) => pending.userEntryId === userEntry.id)
    ) {
      return;
    }
    const header = sessionManager.getHeader();
    if (header === null) throw new Error("Cannot record a session without a header");
    const timestamp = localTimestamp(parseTimestamp(userEntry.timestamp));
    this.#journal.beginEntry({
      piSessionId,
      userEntryId: userEntry.id,
      sessionFile: sessionManager.getSessionFile(),
      cwd: header.cwd,
      request: expandedRequest ?? userMessageText(userEntry.message.content),
      startedAt: timestamp.occurredAt,
      localDate: timestamp.localDate,
      localTime: timestamp.localTime,
    });
  }

  agentSettled(sessionManager: ReadonlySessionManager): readonly RecordedJournalEntry[] {
    return this.#settleVisibleEntries(sessionManager, false);
  }

  sessionShutdown(
    sessionManager: ReadonlySessionManager,
    reason: "quit" | "reload" | "new" | "resume" | "fork",
  ): readonly RecordedJournalEntry[] {
    if (reason === "reload") return [];
    const settledAt = this.#now().toISOString();
    const recorded = this.#settleVisibleEntries(sessionManager, true, settledAt);
    return [
      ...recorded,
      ...this.#journal.interruptPendingEntries(sessionManager.getSessionId(), settledAt),
    ];
  }

  #settleVisibleEntries(
    sessionManager: ReadonlySessionManager,
    interrupt: boolean,
    settledAt = this.#now().toISOString(),
  ): RecordedJournalEntry[] {
    const piSessionId = sessionManager.getSessionId();
    const branch = sessionManager.getBranch();
    const pendingIds = new Set(
      this.#journal.listPendingEntries(piSessionId).map((entry) => entry.userEntryId),
    );
    const indexes = branch
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => pendingIds.has(entry.id));
    const recorded: RecordedJournalEntry[] = [];

    for (const [position, active] of indexes.entries()) {
      const nextIndex = indexes[position + 1]?.index ?? branch.length;
      const entries = branch.slice(active.index + 1, nextIndex);
      const models = collectModels(entries);
      if (!interrupt && !isCompleteEntry(entries, models.length)) continue;
      const result = this.#journal.settleEntry({
        piSessionId,
        userEntryId: active.entry.id,
        settledAt,
        state: interrupt ? "interrupted" : "settled",
        models,
        tools: collectTools(entries),
      });
      if (result !== undefined) recorded.push(result);
    }
    return recorded;
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

function collectModels(entries: readonly SessionEntry[]): ModelFacts[] {
  const models = new Map<string, ModelFacts>();
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const message = entry.message;
    const key = `${message.provider}\0${message.model}`;
    const current = models.get(key) ?? {
      provider: message.provider,
      model: message.model,
      responses: 0,
      totalTokens: 0,
      totalCost: 0,
    };
    current.responses += 1;
    current.totalTokens += message.usage.totalTokens;
    current.totalCost += message.usage.cost.total;
    models.set(key, current);
  }
  return [...models.values()];
}

function collectTools(entries: readonly SessionEntry[]): ToolFacts[] {
  const tools = new Map<string, ToolFacts>();
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
    const message = entry.message;
    const current = tools.get(message.toolName) ?? {
      name: message.toolName,
      executions: 0,
      failures: 0,
      totalTokens: 0,
      totalCost: 0,
    };
    current.executions += 1;
    current.failures += message.isError ? 1 : 0;
    current.totalTokens += message.usage?.totalTokens ?? 0;
    current.totalCost += message.usage?.cost.total ?? 0;
    tools.set(message.toolName, current);
  }
  return [...tools.values()];
}

function isCompleteEntry(entries: readonly SessionEntry[], modelCount: number): boolean {
  if (modelCount === 0) return false;
  let lastMessage: SessionEntry | undefined;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]?.type === "message") {
      lastMessage = entries[index];
      break;
    }
  }
  if (lastMessage?.type !== "message") return false;
  if (lastMessage.message.role === "assistant") return lastMessage.message.stopReason !== "toolUse";
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

function parseTimestamp(timestamp: string): Date {
  const date = new Date(timestamp);
  if (Number.isNaN(date.valueOf()))
    throw new Error(`Invalid journal entry timestamp: ${timestamp}`);
  return date;
}
