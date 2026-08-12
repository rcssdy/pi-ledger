import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { openLedgerDatabase } from "../../src/storage/ledger-database.js";
import { applyMigrations, type Migration } from "../../src/storage/migrations.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("ledger database", () => {
  it("creates and configures the database under the Pi agent directory", async () => {
    const agentDirectory = makeTemporaryDirectory();
    const ledger = await openLedgerDatabase({ agentDirectory });

    expect(ledger.paths.databasePath).toBe(join(agentDirectory, "ledger", "ledger.sqlite"));
    expect(ledger.paths.notesDirectory).toBe(join(agentDirectory, "ledger", "notes"));
    expect(existsSync(ledger.paths.databasePath)).toBe(true);
    expect(existsSync(ledger.paths.notesDirectory)).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(ledger.paths.ledgerDirectory).mode & 0o777).toBe(0o700);
      expect(statSync(ledger.paths.databasePath).mode & 0o777).toBe(0o600);
    }
    expect(ledger.health()).toEqual({
      databasePath: ledger.paths.databasePath,
      userVersion: 1,
      foreignKeys: true,
      journalMode: "wal",
      synchronous: 1,
      busyTimeoutMilliseconds: 5000,
    });

    ledger.close();
    ledger.close();
  });

  it("can reopen an already migrated database", async () => {
    const agentDirectory = makeTemporaryDirectory();

    (await openLedgerDatabase({ agentDirectory })).close();
    const reopened = await openLedgerDatabase({ agentDirectory });

    expect(reopened.health().userVersion).toBe(1);
    reopened.close();
  });

  it("enforces interaction idempotency and foreign keys", async () => {
    const agentDirectory = makeTemporaryDirectory();
    const ledger = await openLedgerDatabase({ agentDirectory });
    const databasePath = ledger.paths.databasePath;
    ledger.close();

    const database = openConfiguredDatabase(databasePath);
    database
      .prepare("INSERT INTO sessions (pi_session_id, started_at) VALUES (?, ?)")
      .run("session-1", "2026-08-12T12:00:00.000Z");
    const session = database
      .prepare("SELECT id FROM sessions WHERE pi_session_id = ?")
      .get("session-1") as { id: number };
    const insertInteraction = database.prepare(`
      INSERT INTO interactions (
        session_id,
        pi_leaf_entry_id,
        user_request,
        started_at
      ) VALUES (?, ?, ?, ?)
    `);

    insertInteraction.run(session.id, "leaf-1", "Add webhook retries", "2026-08-12T12:01:00.000Z");

    expect(() =>
      insertInteraction.run(session.id, "leaf-1", "Duplicate retry", "2026-08-12T12:02:00.000Z"),
    ).toThrow(/UNIQUE constraint failed/);
    expect(() =>
      insertInteraction.run(999_999, "leaf-2", "Missing session", "2026-08-12T12:03:00.000Z"),
    ).toThrow(/FOREIGN KEY constraint failed/);

    database
      .prepare("INSERT INTO sessions (pi_session_id, started_at) VALUES (?, ?)")
      .run("session-2", "2026-08-12T12:04:00.000Z");
    const secondSession = database
      .prepare("SELECT id FROM sessions WHERE pi_session_id = ?")
      .get("session-2") as { id: number };
    expect(() =>
      database
        .prepare(`
          INSERT INTO git_observations (
            session_id,
            interaction_id,
            phase,
            observed_at
          ) VALUES (?, ?, ?, ?)
        `)
        .run(secondSession.id, 1, "after_work", "2026-08-12T12:05:00.000Z"),
    ).toThrow(/FOREIGN KEY constraint failed/);

    database.close();
  });

  it("keeps the full-text index synchronized", async () => {
    const agentDirectory = makeTemporaryDirectory();
    const ledger = await openLedgerDatabase({ agentDirectory });
    const databasePath = ledger.paths.databasePath;
    ledger.close();

    const database = openConfiguredDatabase(databasePath);
    database
      .prepare("INSERT INTO sessions (pi_session_id, started_at) VALUES (?, ?)")
      .run("session-1", "2026-08-12T12:00:00.000Z");
    database
      .prepare(`
        INSERT INTO interactions (
          session_id,
          pi_leaf_entry_id,
          user_request,
          summary,
          started_at
        ) VALUES (
          (SELECT id FROM sessions WHERE pi_session_id = ?),
          ?,
          ?,
          ?,
          ?
        )
      `)
      .run(
        "session-1",
        "leaf-1",
        "Add webhook retries",
        "Implemented exponential backoff",
        "2026-08-12T12:01:00.000Z",
      );

    expect(searchInteractionIds(database, "webhook")).toEqual([1]);
    expect(searchInteractionIds(database, "retry")).toEqual([1]);
    expect(searchInteractionIds(database, "exponential")).toEqual([1]);

    database
      .prepare("UPDATE interactions SET user_request = ?, summary = ? WHERE id = 1")
      .run("Improve failed deliveries", "Added delivery scheduling");

    expect(searchInteractionIds(database, "webhook")).toEqual([]);
    expect(searchInteractionIds(database, "scheduling")).toEqual([1]);

    database.prepare("DELETE FROM interactions WHERE id = 1").run();
    expect(searchInteractionIds(database, "scheduling")).toEqual([]);

    database.close();
  });

  it("allows a reused worktree path to belong to a newly initialized repository", async () => {
    const agentDirectory = makeTemporaryDirectory();
    const ledger = await openLedgerDatabase({ agentDirectory });
    const databasePath = ledger.paths.databasePath;
    ledger.close();

    const database = openConfiguredDatabase(databasePath);
    const insertRepository = database.prepare(`
      INSERT INTO repositories (
        git_common_directory,
        project_name,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?)
    `);
    const now = "2026-08-12T12:00:00.000Z";
    insertRepository.run("/code/.git-one", "code", now, now);
    insertRepository.run("/code/.git-two", "code", now, now);
    const insertWorktree = database.prepare(`
      INSERT INTO worktrees (repository_id, path, created_at, updated_at)
      VALUES (?, ?, ?, ?)
    `);

    expect(() => insertWorktree.run(1, "/code", now, now)).not.toThrow();
    expect(() => insertWorktree.run(2, "/code", now, now)).not.toThrow();

    database.close();
  });

  it("indexes child foreign keys used for joins and cascades", async () => {
    const agentDirectory = makeTemporaryDirectory();
    const ledger = await openLedgerDatabase({ agentDirectory });
    const databasePath = ledger.paths.databasePath;
    ledger.close();

    const database = openConfiguredDatabase(databasePath);
    const rows = database
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'index'")
      .all() as Array<{ name: string }>;
    const indexNames = rows.map((row) => row.name);

    expect(indexNames).toEqual(
      expect.arrayContaining([
        "worktrees_repository_id_index",
        "sessions_worktree_id_index",
        "git_observations_session_id_index",
        "git_observations_interaction_index",
        "interaction_commits_commit_id_index",
        "interaction_pull_requests_pull_request_id_index",
        "model_usage_interaction_id_index",
      ]),
    );

    database.close();
  });

  it("rejects gaps in the migration sequence", () => {
    const database = new DatabaseSync(":memory:");
    const migrationsWithGap: readonly Migration[] = [
      { version: 1, migrate() {} },
      { version: 3, migrate() {} },
    ];

    expect(() => applyMigrations(database, migrationsWithGap)).toThrow(
      "Ledger migration version 3 is invalid; expected 2",
    );
    expect(readUserVersion(database)).toBe(0);
    database.close();
  });

  it("rejects a database created by a newer ledger version", () => {
    const database = new DatabaseSync(":memory:");
    database.exec("PRAGMA user_version = 2");

    expect(() => applyMigrations(database, [{ version: 1, migrate() {} }])).toThrow(
      "Ledger database version 2 is newer than supported version 1",
    );
    expect(database.isTransaction).toBe(false);
    database.close();
  });

  it("rolls back a failed migration without advancing its version", () => {
    const database = new DatabaseSync(":memory:");
    const testMigrations: readonly Migration[] = [
      {
        version: 1,
        migrate(connection) {
          connection.exec("CREATE TABLE stable (id INTEGER PRIMARY KEY)");
        },
      },
      {
        version: 2,
        migrate(connection) {
          connection.exec("CREATE TABLE rolled_back (id INTEGER PRIMARY KEY)");
          throw new Error("migration failed");
        },
      },
    ];

    expect(() => applyMigrations(database, testMigrations)).toThrow("migration failed");
    expect(readUserVersion(database)).toBe(1);
    expect(tableExists(database, "stable")).toBe(true);
    expect(tableExists(database, "rolled_back")).toBe(false);

    database.close();
  });
});

function makeTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "pi-ledger-"));
  temporaryDirectories.push(directory);
  return directory;
}

function openConfiguredDatabase(path: string): DatabaseSync {
  const database = new DatabaseSync(path);
  database.exec("PRAGMA foreign_keys = ON");
  return database;
}

function searchInteractionIds(database: DatabaseSync, query: string): number[] {
  const rows = database
    .prepare(
      "SELECT rowid AS interaction_id FROM interaction_fts WHERE interaction_fts MATCH ? ORDER BY rank",
    )
    .all(query) as Array<{ interaction_id: number }>;
  return rows.map((row) => row.interaction_id);
}

function readUserVersion(database: DatabaseSync): number {
  const row = database.prepare("PRAGMA user_version").get() as { user_version: number };
  return row.user_version;
}

function tableExists(database: DatabaseSync, table: string): boolean {
  const row = database
    .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?")
    .get(table);
  return row !== undefined;
}
