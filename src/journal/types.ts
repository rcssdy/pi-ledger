export type JournalEntryState = "pending" | "settled" | "interrupted";

export interface JournalPaths {
  agentDirectory: string;
  journalDirectory: string;
  databasePath: string;
  notesDirectory: string;
}

export interface OpenJournalOptions {
  agentDirectory?: string;
}

export interface BeginJournalEntry {
  piSessionId: string;
  userEntryId: string;
  sessionFile?: string;
  cwd: string;
  request: string;
  startedAt: string;
  localDate: string;
  localTime: string;
}

export interface PendingJournalEntry extends BeginJournalEntry {}

export interface ModelFacts {
  provider: string;
  model: string;
  responses: number;
  totalTokens: number;
  totalCost: number;
}

export interface ToolFacts {
  name: string;
  executions: number;
  failures: number;
  totalTokens: number;
  totalCost: number;
}

export interface SettleJournalEntry {
  piSessionId: string;
  userEntryId: string;
  settledAt: string;
  state?: Exclude<JournalEntryState, "pending">;
  models: readonly ModelFacts[];
  tools: readonly ToolFacts[];
}

export interface RecordedJournalEntry {
  id: number;
  localDate: string;
  state: Exclude<JournalEntryState, "pending">;
}

export interface DailyJournalEntry {
  id: number;
  piSessionId: string;
  userEntryId: string;
  sessionFile?: string;
  cwd: string;
  request: string;
  state: Exclude<JournalEntryState, "pending">;
  startedAt: string;
  localTime: string;
  models: readonly ModelFacts[];
  tools: readonly ToolFacts[];
}

export interface JournalSearchQuery {
  query: string;
  after?: string;
  before?: string;
  cwd?: string;
  model?: string;
  tool?: string;
  limit?: number;
}

export interface JournalSearchResult extends DailyJournalEntry {
  localDate: string;
  snippet: string;
  rank: number;
}

/** The complete journal interface used by recording, notes, and search. */
export interface Journal {
  readonly paths: JournalPaths;
  beginEntry(input: BeginJournalEntry): void;
  listPendingEntries(piSessionId: string): readonly PendingJournalEntry[];
  settleEntry(input: SettleJournalEntry): RecordedJournalEntry | undefined;
  interruptPendingEntries(piSessionId: string, settledAt: string): readonly RecordedJournalEntry[];
  listDates(): readonly string[];
  listDailyEntries(localDate: string): readonly DailyJournalEntry[];
  search(query: JournalSearchQuery): readonly JournalSearchResult[];
  close(): void;
}
