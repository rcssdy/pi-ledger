import { existsSync, mkdtempSync, rmSync } from "node:fs";
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
  it("creates and configures the database under the Pi agent directory", () => {
    const agentDirectory = makeTemporaryDirectory();
    const ledger = openLedgerDatabase({ agentDirectory });

    expect(ledger.paths.databasePath).toBe(join(agentDirectory, "ledger", "ledger.sqlite"));
    expect(ledger.paths.notesDirectory).toBe(join(agentDirectory, "ledger", "notes"));
    expect(existsSync(ledger.paths.databasePath)).toBe(true);
    expect(existsSync(ledger.paths.notesDirectory)).toBe(true);
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

  it("can reopen an already migrated database", () => {
    const agentDirectory = makeTemporaryDirectory();

    openLedgerDatabase({ agentDirectory }).close();
    const reopened = openLedgerDatabase({ agentDirectory });

    expect(reopened.health().userVersion).toBe(1);
    reopened.close();
  });

  it("enforces interaction idempotency and foreign keys", () => {
    const agentDirectory = makeTemporaryDirectory();
    const ledger = openLedgerDatabase({ agentDirectory });
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

    database.close();
  });

  it("keeps the full-text index synchronized", () => {
    const agentDirectory = makeTemporaryDirectory();
    const ledger = openLedgerDatabase({ agentDirectory });
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
      "SELECT interaction_id FROM interaction_fts WHERE interaction_fts MATCH ? ORDER BY rank",
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
