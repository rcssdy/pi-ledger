import type { DatabaseSync } from "node:sqlite";

export interface Migration {
  version: number;
  migrate(database: DatabaseSync): void;
}

const SCHEMA = `
CREATE TABLE journal_entries (
  id INTEGER PRIMARY KEY,
  pi_session_id TEXT NOT NULL,
  user_entry_id TEXT NOT NULL,
  session_file TEXT,
  cwd TEXT NOT NULL,
  request TEXT NOT NULL,
  started_at TEXT NOT NULL,
  settled_at TEXT,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'settled', 'interrupted')),
  local_date TEXT NOT NULL,
  local_time TEXT NOT NULL,
  UNIQUE (pi_session_id, user_entry_id)
) STRICT;
CREATE INDEX journal_entries_date_index
  ON journal_entries(local_date, started_at);
CREATE INDEX journal_entries_cwd_index ON journal_entries(cwd);

CREATE TABLE entry_models (
  entry_id INTEGER NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  responses INTEGER NOT NULL CHECK (responses > 0),
  total_tokens INTEGER NOT NULL DEFAULT 0,
  total_cost REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (entry_id, provider, model)
) STRICT, WITHOUT ROWID;
CREATE INDEX entry_models_name_index ON entry_models(provider, model, entry_id);

CREATE TABLE entry_tools (
  entry_id INTEGER NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  executions INTEGER NOT NULL CHECK (executions > 0),
  failures INTEGER NOT NULL DEFAULT 0 CHECK (failures BETWEEN 0 AND executions),
  total_tokens INTEGER NOT NULL DEFAULT 0,
  total_cost REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (entry_id, name)
) STRICT, WITHOUT ROWID;
CREATE INDEX entry_tools_name_index ON entry_tools(name, entry_id);

CREATE VIRTUAL TABLE journal_entries_fts USING fts5(
  request,
  content = 'journal_entries',
  content_rowid = 'id',
  tokenize = 'porter unicode61'
);
CREATE TRIGGER journal_entries_fts_insert AFTER INSERT ON journal_entries BEGIN
  INSERT INTO journal_entries_fts(rowid, request) VALUES (new.id, new.request);
END;
CREATE TRIGGER journal_entries_fts_update AFTER UPDATE OF request ON journal_entries BEGIN
  INSERT INTO journal_entries_fts(journal_entries_fts, rowid, request)
  VALUES ('delete', old.id, old.request);
  INSERT INTO journal_entries_fts(rowid, request) VALUES (new.id, new.request);
END;
CREATE TRIGGER journal_entries_fts_delete AFTER DELETE ON journal_entries BEGIN
  INSERT INTO journal_entries_fts(journal_entries_fts, rowid, request)
  VALUES ('delete', old.id, old.request);
END;
`;

export const migrations: readonly Migration[] = [
  {
    version: 1,
    migrate(database) {
      database.exec(SCHEMA);
    },
  },
  {
    version: 2,
    migrate(database) {
      database.exec(`
        CREATE TABLE dirty_note_dates (
          local_date TEXT PRIMARY KEY,
          revision INTEGER NOT NULL CHECK (revision > 0)
        ) STRICT, WITHOUT ROWID;
        INSERT INTO dirty_note_dates (local_date, revision)
          SELECT DISTINCT local_date, 1 FROM journal_entries WHERE state != 'pending';
      `);
    },
  },
  {
    version: 3,
    migrate(database) {
      database.exec(`
        CREATE TABLE excluded_projects (
          cwd TEXT PRIMARY KEY
        ) STRICT, WITHOUT ROWID;
      `);
    },
  },
];

export function applyMigrations(
  database: DatabaseSync,
  availableMigrations: readonly Migration[] = migrations,
): void {
  validateMigrations(availableMigrations);
  const latestVersion = availableMigrations.at(-1)?.version ?? 0;

  while (true) {
    database.exec("BEGIN IMMEDIATE");
    try {
      const currentVersion = readUserVersion(database);
      if (currentVersion > latestVersion) {
        throw new Error(
          `Journal database version ${currentVersion} is newer than supported version ${latestVersion}`,
        );
      }
      const migration = availableMigrations[currentVersion];
      if (migration === undefined) {
        database.exec("COMMIT");
        return;
      }
      migration.migrate(database);
      database.exec(`PRAGMA user_version = ${migration.version}`);
      database.exec("COMMIT");
    } catch (error) {
      rollback(database, error);
    }
  }
}

export function readUserVersion(database: DatabaseSync): number {
  const row = database.prepare("PRAGMA user_version").get() as { user_version: number };
  return row.user_version;
}

function validateMigrations(availableMigrations: readonly Migration[]): void {
  for (const [index, migration] of availableMigrations.entries()) {
    const expected = index + 1;
    if (!Number.isSafeInteger(migration.version) || migration.version !== expected) {
      throw new Error(
        `Journal migration version ${migration.version} is invalid; expected ${expected}`,
      );
    }
  }
}

function rollback(database: DatabaseSync, migrationError: unknown): never {
  if (database.isTransaction) {
    try {
      database.exec("ROLLBACK");
    } catch (rollbackError) {
      throw new AggregateError(
        [migrationError, rollbackError],
        "Journal migration and rollback both failed",
      );
    }
  }
  throw migrationError;
}
