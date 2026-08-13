import { chmodSync, mkdirSync } from "node:fs";
import type { DatabaseSync, StatementSync } from "node:sqlite";

import { resolveJournalPaths } from "./paths.js";
import { applyMigrations } from "./schema.js";
import { isLocalDate } from "./local-time.js";
import type {
  BeginJournalEntry,
  DailyJournalEntry,
  DirtyJournalDate,
  Journal,
  JournalPaths,
  JournalSearchQuery,
  JournalSearchResult,
  ModelFacts,
  PendingJournalEntry,
  RecordedJournalEntry,
  SettleJournalEntry,
  ToolFacts,
} from "./types.js";

interface EntryRow {
  id: number;
  piSessionId: string;
  userEntryId: string;
  sessionFile: string | null;
  cwd: string;
  request: string;
  state: "settled" | "interrupted";
  startedAt: string;
  localDate: string;
  localTime: string;
}

export class JournalDatabase implements Journal {
  readonly paths: JournalPaths;
  readonly #database: DatabaseSync;
  readonly #models: StatementSync;
  readonly #tools: StatementSync;
  #closed = false;

  constructor(database: DatabaseSync, paths: JournalPaths) {
    this.#database = database;
    this.paths = paths;
    this.#models = database.prepare(`
      SELECT provider, model, responses,
        input_tokens AS inputTokens, output_tokens AS outputTokens,
        cache_read_tokens AS cacheReadTokens, cache_write_tokens AS cacheWriteTokens,
        total_tokens AS totalTokens, total_cost AS totalCost
      FROM entry_models WHERE entry_id = ? ORDER BY provider, model
    `);
    this.#tools = database.prepare(`
      SELECT name, executions, failures,
        input_tokens AS inputTokens, output_tokens AS outputTokens,
        cache_read_tokens AS cacheReadTokens, cache_write_tokens AS cacheWriteTokens,
        total_tokens AS totalTokens, total_cost AS totalCost
      FROM entry_tools WHERE entry_id = ? ORDER BY name
    `);
  }

  beginEntry(input: BeginJournalEntry): void {
    this.#database
      .prepare(`
        INSERT INTO journal_entries (
          pi_session_id, user_entry_id, session_file, cwd, request,
          started_at, state, local_date, local_time
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
        ON CONFLICT (pi_session_id, user_entry_id) DO UPDATE SET
          session_file = excluded.session_file,
          cwd = excluded.cwd,
          request = excluded.request,
          local_date = excluded.local_date,
          local_time = excluded.local_time
      `)
      .run(
        input.piSessionId,
        input.userEntryId,
        input.sessionFile ?? null,
        input.cwd,
        input.request,
        input.startedAt,
        input.localDate,
        input.localTime,
      );
  }

  listPendingEntries(piSessionId: string): readonly PendingJournalEntry[] {
    return this.#database
      .prepare(`
        SELECT
          pi_session_id AS piSessionId,
          user_entry_id AS userEntryId,
          session_file AS sessionFile,
          cwd,
          request,
          started_at AS startedAt,
          local_date AS localDate,
          local_time AS localTime
        FROM journal_entries
        WHERE pi_session_id = ? AND state = 'pending'
        ORDER BY started_at, user_entry_id
      `)
      .all(piSessionId)
      .map((value) => {
        const row = value as unknown as PendingJournalEntry & { sessionFile: string | null };
        return { ...row, sessionFile: row.sessionFile ?? undefined };
      });
  }

  settleEntry(input: SettleJournalEntry): RecordedJournalEntry | undefined {
    return this.#transaction(() => {
      const row = this.#database
        .prepare(`
          SELECT id, local_date AS localDate
          FROM journal_entries
          WHERE pi_session_id = ? AND user_entry_id = ?
        `)
        .get(input.piSessionId, input.userEntryId) as { id: number; localDate: string } | undefined;
      if (row === undefined) return;

      const state = input.state ?? "settled";
      this.#database
        .prepare("UPDATE journal_entries SET settled_at = ?, state = ? WHERE id = ?")
        .run(input.settledAt, state, row.id);
      this.#database.prepare("DELETE FROM entry_models WHERE entry_id = ?").run(row.id);
      this.#database.prepare("DELETE FROM entry_tools WHERE entry_id = ?").run(row.id);

      const insertModel = this.#database.prepare(`
        INSERT INTO entry_models (
          entry_id, provider, model, responses, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, total_tokens, total_cost
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const model of input.models) {
        insertModel.run(
          row.id,
          model.provider,
          model.model,
          model.responses,
          model.inputTokens,
          model.outputTokens,
          model.cacheReadTokens,
          model.cacheWriteTokens,
          model.totalTokens,
          model.totalCost,
        );
      }

      const insertTool = this.#database.prepare(`
        INSERT INTO entry_tools (
          entry_id, name, executions, failures, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, total_tokens, total_cost
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const tool of input.tools) {
        insertTool.run(
          row.id,
          tool.name,
          tool.executions,
          tool.failures,
          tool.inputTokens,
          tool.outputTokens,
          tool.cacheReadTokens,
          tool.cacheWriteTokens,
          tool.totalTokens,
          tool.totalCost,
        );
      }
      this.#markNoteDirty(row.localDate);
      return { id: row.id, localDate: row.localDate, state };
    });
  }

  interruptPendingEntries(piSessionId: string, settledAt: string): readonly RecordedJournalEntry[] {
    return this.#transaction(() => {
      const rows = this.#database
        .prepare(`
          SELECT id, local_date AS localDate FROM journal_entries
          WHERE pi_session_id = ? AND state = 'pending'
        `)
        .all(piSessionId) as unknown as Array<{ id: number; localDate: string }>;
      this.#database
        .prepare(`
          UPDATE journal_entries SET settled_at = ?, state = 'interrupted'
          WHERE pi_session_id = ? AND state = 'pending'
        `)
        .run(settledAt, piSessionId);
      for (const localDate of new Set(rows.map((row) => row.localDate))) {
        this.#markNoteDirty(localDate);
      }
      return rows.map((row) => ({
        id: row.id,
        localDate: row.localDate,
        state: "interrupted" as const,
      }));
    });
  }

  listDirtyDates(): readonly DirtyJournalDate[] {
    return this.#database
      .prepare("SELECT local_date AS localDate, revision FROM dirty_note_dates ORDER BY local_date")
      .all() as unknown as DirtyJournalDate[];
  }

  isProjectExcluded(cwd: string): boolean {
    return (
      this.#database.prepare("SELECT 1 FROM excluded_projects WHERE cwd = ?").get(cwd) !== undefined
    );
  }

  setProjectExcluded(cwd: string, excluded: boolean): void {
    this.#database
      .prepare(
        excluded
          ? "INSERT OR IGNORE INTO excluded_projects (cwd) VALUES (?)"
          : "DELETE FROM excluded_projects WHERE cwd = ?",
      )
      .run(cwd);
  }

  markAllNotesDirty(): void {
    this.#database.exec(`
      INSERT INTO dirty_note_dates (local_date, revision)
        SELECT DISTINCT local_date, 1 FROM journal_entries WHERE state != 'pending'
        ON CONFLICT (local_date) DO UPDATE SET revision = revision + 1
    `);
  }

  markNoteClean(localDate: string, revision: number): void {
    this.#database
      .prepare("DELETE FROM dirty_note_dates WHERE local_date = ? AND revision = ?")
      .run(localDate, revision);
  }

  listDailyEntries(localDate: string): readonly DailyJournalEntry[] {
    const rows = this.#database
      .prepare(`
        SELECT
          id,
          pi_session_id AS piSessionId,
          user_entry_id AS userEntryId,
          session_file AS sessionFile,
          cwd,
          request,
          state,
          started_at AS startedAt,
          local_date AS localDate,
          local_time AS localTime
        FROM journal_entries
        WHERE local_date = ? AND state != 'pending'
        ORDER BY started_at, id
      `)
      .all(localDate) as unknown as EntryRow[];
    return rows.map((row) => this.#hydrate(row));
  }

  search(query: JournalSearchQuery): readonly JournalSearchResult[] {
    if (query.after !== undefined && !isLocalDate(query.after)) {
      throw new Error(`Invalid local date: ${query.after}`);
    }
    if (query.before !== undefined && !isLocalDate(query.before)) {
      throw new Error(`Invalid local date: ${query.before}`);
    }
    const terms = toFtsTerms(query.query);
    if (terms.length === 0) return [];
    const results = this.#search(query, terms.join(" AND "));
    return results.length === 0 && terms.length > 1
      ? this.#search(query, terms.join(" OR "))
      : results;
  }

  related(entryId: number, limit = 10): readonly JournalSearchResult[] {
    const row = this.#database
      .prepare("SELECT request FROM journal_entries WHERE id = ? AND state != 'pending'")
      .get(entryId) as { request: string } | undefined;
    if (row === undefined) throw new Error(`Journal entry ${entryId} was not found`);
    const query = topTerms(row.request, 6);
    if (query === "") return [];
    const cappedLimit = Math.min(Math.max(limit, 1), 10);
    return this.#search({ query, limit: cappedLimit }, toFtsTerms(query).join(" OR "), entryId);
  }

  #search(
    query: JournalSearchQuery,
    match: string,
    excludedEntryId?: number,
  ): readonly JournalSearchResult[] {
    const limit = Math.min(Math.max(query.limit ?? 10, 1), 20);
    const conditions = ["journal_entries_fts MATCH ?", "entry.state != 'pending'"];
    const parameters: Array<string | number> = [match];

    if (excludedEntryId !== undefined) {
      conditions.push("entry.id != ?");
      parameters.push(excludedEntryId);
    }

    if (query.after !== undefined) {
      conditions.push("entry.local_date >= ?");
      parameters.push(query.after);
    }
    if (query.before !== undefined) {
      conditions.push("entry.local_date <= ?");
      parameters.push(query.before);
    }
    if (query.cwd !== undefined) {
      conditions.push("entry.cwd LIKE ? ESCAPE '\\'");
      parameters.push(`${escapeLike(query.cwd)}%`);
    }
    if (query.model !== undefined) {
      conditions.push(`EXISTS (
        SELECT 1 FROM entry_models model
        WHERE model.entry_id = entry.id
          AND (model.provider || '/' || model.model) LIKE ? ESCAPE '\\'
      )`);
      parameters.push(`%${escapeLike(query.model)}%`);
    }
    if (query.tool !== undefined) {
      conditions.push(`EXISTS (
        SELECT 1 FROM entry_tools tool
        WHERE tool.entry_id = entry.id AND tool.name = ? COLLATE NOCASE
      )`);
      parameters.push(query.tool);
    }
    parameters.push(limit);

    const rows = this.#database
      .prepare(`
        SELECT
          entry.id,
          entry.pi_session_id AS piSessionId,
          entry.user_entry_id AS userEntryId,
          entry.session_file AS sessionFile,
          entry.cwd,
          entry.request,
          entry.state,
          entry.started_at AS startedAt,
          entry.local_date AS localDate,
          entry.local_time AS localTime,
          snippet(journal_entries_fts, 0, '«', '»', ' … ', 16) AS snippet,
          bm25(journal_entries_fts) AS rank
        FROM journal_entries_fts
        JOIN journal_entries entry ON entry.id = journal_entries_fts.rowid
        WHERE ${conditions.join(" AND ")}
        ORDER BY rank, entry.started_at DESC
        LIMIT ?
      `)
      .all(...parameters) as unknown as Array<EntryRow & { snippet: string; rank: number }>;

    return rows.map((row) => ({ ...this.#hydrate(row), snippet: row.snippet, rank: row.rank }));
  }

  close(): void {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }

  #hydrate(row: EntryRow): DailyJournalEntry & { localDate: string } {
    return {
      id: row.id,
      piSessionId: row.piSessionId,
      userEntryId: row.userEntryId,
      sessionFile: row.sessionFile ?? undefined,
      cwd: row.cwd,
      request: row.request,
      state: row.state,
      startedAt: row.startedAt,
      localDate: row.localDate,
      localTime: row.localTime,
      models: this.#models.all(row.id) as unknown as ModelFacts[],
      tools: this.#tools.all(row.id) as unknown as ToolFacts[],
    };
  }

  #transaction<Result>(action: () => Result): Result {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.#database.isTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #markNoteDirty(localDate: string): void {
    this.#database
      .prepare(`
        INSERT INTO dirty_note_dates (local_date, revision) VALUES (?, 1)
        ON CONFLICT (local_date) DO UPDATE SET revision = revision + 1
      `)
      .run(localDate);
  }
}

/** Open the private journal database, creating and migrating it when necessary. */
export async function openJournalDatabase(agentDirectory?: string): Promise<JournalDatabase> {
  const paths = resolveJournalPaths(agentDirectory);
  secureDirectory(paths.journalDirectory);

  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(paths.databasePath, { enableForeignKeyConstraints: true });
  try {
    if (process.platform !== "win32") chmodSync(paths.databasePath, 0o600);
    database.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
    `);
    applyMigrations(database);
    return new JournalDatabase(database, paths);
  } catch (error) {
    database.close();
    throw error;
  }
}

function toFtsTerms(input: string): string[] {
  const terms: string[] = [];
  for (const match of input.matchAll(/"([^"]+)"|([\p{L}\p{N}_-]+)/gu)) {
    const value = (match[1] ?? match[2])?.trim();
    if (value) terms.push(`"${value.replaceAll('"', '""')}"`);
  }
  return terms;
}

const STOP_WORDS = new Set(
  "also been code could from have into just like make more need only should some than that their them then there they this tool used user using want were what when where which will with would your".split(
    " ",
  ),
);

function topTerms(text: string, limit: number): string {
  const counts = new Map<string, number>();
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []) {
    if (word.length < 4 || STOP_WORDS.has(word)) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return [...counts]
    .sort(
      ([left, leftCount], [right, rightCount]) =>
        rightCount - leftCount || compareText(left, right),
    )
    .slice(0, limit)
    .map(([word]) => word)
    .join(" ");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function secureDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(path, 0o700);
}
