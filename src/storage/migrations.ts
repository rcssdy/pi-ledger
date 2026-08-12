import type { DatabaseSync } from "node:sqlite";

export interface Migration {
  version: number;
  migrate(database: DatabaseSync): void;
}

const INITIAL_SCHEMA = `
CREATE TABLE repositories (
  id INTEGER PRIMARY KEY,
  git_common_directory TEXT NOT NULL UNIQUE,
  project_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE worktrees (
  id INTEGER PRIMARY KEY,
  repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (repository_id, path)
) STRICT;

CREATE INDEX worktrees_repository_id_index ON worktrees(repository_id);

CREATE TABLE sessions (
  id INTEGER PRIMARY KEY,
  pi_session_id TEXT NOT NULL UNIQUE,
  session_file TEXT,
  worktree_id INTEGER REFERENCES worktrees(id) ON DELETE SET NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  state TEXT NOT NULL DEFAULT 'active'
    CHECK (state IN ('active', 'closed', 'interrupted')),
  initial_branch TEXT,
  initial_head_sha TEXT,
  final_head_sha TEXT
) STRICT;

CREATE INDEX sessions_worktree_id_index ON sessions(worktree_id);

CREATE TABLE interactions (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  pi_leaf_entry_id TEXT NOT NULL,
  user_request TEXT NOT NULL,
  summary TEXT,
  outcome TEXT,
  remaining_work TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(remaining_work) AND json_type(remaining_work) = 'array'),
  intent TEXT,
  completion_condition TEXT,
  started_at TEXT NOT NULL,
  settled_at TEXT,
  state TEXT NOT NULL DEFAULT 'settled'
    CHECK (state IN ('settled', 'interrupted')),
  UNIQUE (session_id, pi_leaf_entry_id),
  UNIQUE (id, session_id)
) STRICT;

CREATE INDEX interactions_started_at_index ON interactions(started_at);
CREATE INDEX interactions_outcome_index ON interactions(outcome);

CREATE VIRTUAL TABLE interaction_fts USING fts5(
  user_request,
  summary,
  outcome,
  remaining_work,
  content = 'interactions',
  content_rowid = 'id',
  tokenize = 'porter unicode61'
);

CREATE TRIGGER interactions_fts_insert AFTER INSERT ON interactions BEGIN
  INSERT INTO interaction_fts(rowid, user_request, summary, outcome, remaining_work)
  VALUES (new.id, new.user_request, new.summary, new.outcome, new.remaining_work);
END;

CREATE TRIGGER interactions_fts_update AFTER UPDATE ON interactions BEGIN
  INSERT INTO interaction_fts(
    interaction_fts,
    rowid,
    user_request,
    summary,
    outcome,
    remaining_work
  ) VALUES (
    'delete',
    old.id,
    old.user_request,
    old.summary,
    old.outcome,
    old.remaining_work
  );
  INSERT INTO interaction_fts(rowid, user_request, summary, outcome, remaining_work)
  VALUES (new.id, new.user_request, new.summary, new.outcome, new.remaining_work);
END;

CREATE TRIGGER interactions_fts_delete AFTER DELETE ON interactions BEGIN
  INSERT INTO interaction_fts(
    interaction_fts,
    rowid,
    user_request,
    summary,
    outcome,
    remaining_work
  ) VALUES (
    'delete',
    old.id,
    old.user_request,
    old.summary,
    old.outcome,
    old.remaining_work
  );
END;

CREATE TABLE git_observations (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  interaction_id INTEGER,
  phase TEXT NOT NULL CHECK (
    phase IN ('session_start', 'before_work', 'after_work', 'session_shutdown')
  ),
  observed_at TEXT NOT NULL,
  worktree_path TEXT,
  git_common_directory TEXT,
  branch TEXT,
  detached INTEGER CHECK (detached IN (0, 1)),
  head_sha TEXT,
  upstream_branch TEXT,
  origin_remote TEXT,
  upstream_remote TEXT,
  ambiguous INTEGER NOT NULL DEFAULT 0 CHECK (ambiguous IN (0, 1)),
  ambiguity_reason TEXT,
  FOREIGN KEY (interaction_id, session_id)
    REFERENCES interactions(id, session_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX git_observations_session_id_index ON git_observations(session_id);
CREATE INDEX git_observations_interaction_index
  ON git_observations(interaction_id, session_id);

CREATE TABLE changed_files (
  id INTEGER PRIMARY KEY,
  observation_id INTEGER NOT NULL REFERENCES git_observations(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  index_status TEXT,
  worktree_status TEXT,
  original_path TEXT,
  UNIQUE (observation_id, path)
) STRICT;

CREATE TABLE commits (
  id INTEGER PRIMARY KEY,
  repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  sha TEXT NOT NULL,
  parent_shas TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(parent_shas) AND json_type(parent_shas) = 'array'),
  subject TEXT,
  authored_at TEXT,
  committed_at TEXT,
  UNIQUE (repository_id, sha)
) STRICT;

CREATE TABLE interaction_commits (
  interaction_id INTEGER NOT NULL REFERENCES interactions(id) ON DELETE CASCADE,
  commit_id INTEGER NOT NULL REFERENCES commits(id) ON DELETE CASCADE,
  relationship TEXT NOT NULL CHECK (relationship IN ('observed', 'ambiguous')),
  reason TEXT,
  PRIMARY KEY (interaction_id, commit_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX interaction_commits_commit_id_index ON interaction_commits(commit_id);

CREATE TABLE pull_requests (
  id INTEGER PRIMARY KEY,
  host TEXT NOT NULL DEFAULT 'github.com',
  base_owner TEXT NOT NULL,
  base_repository TEXT NOT NULL,
  number INTEGER NOT NULL,
  url TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open', 'closed', 'merged')),
  is_draft INTEGER NOT NULL DEFAULT 0 CHECK (is_draft IN (0, 1)),
  head_owner TEXT NOT NULL,
  head_repository TEXT NOT NULL,
  head_ref TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  base_ref TEXT,
  review_decision TEXT,
  check_summary TEXT CHECK (check_summary IS NULL OR json_valid(check_summary)),
  created_at TEXT NOT NULL,
  merged_at TEXT,
  closed_at TEXT,
  github_updated_at TEXT,
  refreshed_at TEXT NOT NULL,
  UNIQUE (host, base_owner, base_repository, number)
) STRICT;

CREATE TABLE pull_request_observations (
  id INTEGER PRIMARY KEY,
  pull_request_id INTEGER NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
  observed_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open', 'closed', 'merged')),
  is_draft INTEGER NOT NULL CHECK (is_draft IN (0, 1)),
  head_sha TEXT NOT NULL,
  review_decision TEXT,
  check_summary TEXT CHECK (check_summary IS NULL OR json_valid(check_summary)),
  UNIQUE (pull_request_id, observed_at)
) STRICT;

CREATE TABLE interaction_pull_requests (
  interaction_id INTEGER NOT NULL REFERENCES interactions(id) ON DELETE CASCADE,
  pull_request_id INTEGER NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
  evidence TEXT NOT NULL CHECK (
    evidence IN ('explicit', 'contributed', 'created_during', 'contextual', 'ambiguous')
  ),
  detail TEXT,
  PRIMARY KEY (interaction_id, pull_request_id, evidence)
) STRICT, WITHOUT ROWID;

CREATE INDEX interaction_pull_requests_pull_request_id_index
  ON interaction_pull_requests(pull_request_id);

CREATE TABLE goals (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  pi_entry_id TEXT NOT NULL,
  pi_parent_entry_id TEXT,
  intent TEXT,
  closes_when TEXT,
  state TEXT NOT NULL CHECK (state IN ('active', 'claimed_complete', 'abandoned')),
  reason TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (session_id, pi_entry_id)
) STRICT;

CREATE TABLE model_usage (
  id INTEGER PRIMARY KEY,
  interaction_id INTEGER NOT NULL REFERENCES interactions(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  input_cost REAL NOT NULL DEFAULT 0,
  output_cost REAL NOT NULL DEFAULT 0,
  cache_read_cost REAL NOT NULL DEFAULT 0,
  cache_write_cost REAL NOT NULL DEFAULT 0,
  total_cost REAL NOT NULL DEFAULT 0
) STRICT;

CREATE INDEX model_usage_interaction_id_index ON model_usage(interaction_id);
`;

export const migrations: readonly Migration[] = [
  {
    version: 1,
    migrate(database) {
      database.exec(INITIAL_SCHEMA);
    },
  },
];

/** Apply all newer migrations, committing each version atomically. */
export function applyMigrations(
  database: DatabaseSync,
  availableMigrations: readonly Migration[] = migrations,
): void {
  validateMigrations(availableMigrations);
  const latestVersion = availableMigrations.at(-1)?.version ?? 0;

  while (true) {
    database.exec("BEGIN IMMEDIATE");
    try {
      // Read the version only after taking the write lock. Another Pi process
      // may have migrated the shared ledger while this connection was waiting.
      const currentVersion = readUserVersion(database);
      if (currentVersion > latestVersion) {
        throw new Error(
          `Ledger database version ${currentVersion} is newer than supported version ${latestVersion}`,
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
      rollbackMigration(database, error);
    }
  }
}

export function readUserVersion(database: DatabaseSync): number {
  const row = database.prepare("PRAGMA user_version").get() as { user_version: number };
  return row.user_version;
}

function validateMigrations(availableMigrations: readonly Migration[]): void {
  for (const [index, migration] of availableMigrations.entries()) {
    const expectedVersion = index + 1;
    if (!Number.isSafeInteger(migration.version) || migration.version !== expectedVersion) {
      throw new Error(
        `Ledger migration version ${migration.version} is invalid; expected ${expectedVersion}`,
      );
    }
  }
}

function rollbackMigration(database: DatabaseSync, migrationError: unknown): never {
  if (database.isTransaction) {
    try {
      database.exec("ROLLBACK");
    } catch (rollbackError) {
      throw new AggregateError(
        [migrationError, rollbackError],
        "Ledger migration and rollback both failed",
      );
    }
  }
  throw migrationError;
}
