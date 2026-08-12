import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { applyMigrations, readUserVersion } from "./migrations.js";
import { assertAbsoluteDatabasePath, resolveLedgerPaths, type LedgerPaths } from "./paths.js";

export interface OpenLedgerDatabaseOptions {
  agentDirectory?: string;
}

export interface LedgerDatabaseHealth {
  databasePath: string;
  userVersion: number;
  foreignKeys: boolean;
  journalMode: string;
  synchronous: number;
  busyTimeoutMilliseconds: number;
}

/** Owns the SQLite connection and all database-level setup for one Pi session. */
export class LedgerDatabase {
  readonly paths: LedgerPaths;

  readonly #database: DatabaseSync;
  #closed = false;

  private constructor(database: DatabaseSync, paths: LedgerPaths) {
    this.#database = database;
    this.paths = paths;
  }

  static open(options: OpenLedgerDatabaseOptions = {}): LedgerDatabase {
    const paths = resolveLedgerPaths(options.agentDirectory);
    assertAbsoluteDatabasePath(paths.databasePath);
    mkdirSync(paths.ledgerDirectory, { recursive: true });
    mkdirSync(paths.notesDirectory, { recursive: true });

    const database = new DatabaseSync(paths.databasePath);

    try {
      configureDatabase(database);
      applyMigrations(database);
      return new LedgerDatabase(database, paths);
    } catch (error) {
      database.close();
      throw error;
    }
  }

  health(): LedgerDatabaseHealth {
    this.#assertOpen();

    return {
      databasePath: this.paths.databasePath,
      userVersion: readUserVersion(this.#database),
      foreignKeys: readPragmaNumber(this.#database, "foreign_keys") === 1,
      journalMode: readPragmaString(this.#database, "journal_mode"),
      synchronous: readPragmaNumber(this.#database, "synchronous"),
      busyTimeoutMilliseconds: readPragmaNumber(this.#database, "busy_timeout"),
    };
  }

  close(): void {
    if (this.#closed) return;

    this.#database.close();
    this.#closed = true;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Ledger database is closed");
  }
}

export function openLedgerDatabase(options: OpenLedgerDatabaseOptions = {}): LedgerDatabase {
  return LedgerDatabase.open(options);
}

function configureDatabase(database: DatabaseSync): void {
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
  `);
}

function readPragmaNumber(database: DatabaseSync, pragma: string): number {
  const row = database.prepare(`PRAGMA ${pragma}`).get() as Record<string, number>;
  const value = Object.values(row)[0];
  if (typeof value !== "number") throw new Error(`Expected numeric PRAGMA ${pragma}`);
  return value;
}

function readPragmaString(database: DatabaseSync, pragma: string): string {
  const row = database.prepare(`PRAGMA ${pragma}`).get() as Record<string, string>;
  const value = Object.values(row)[0];
  if (typeof value !== "string") throw new Error(`Expected string PRAGMA ${pragma}`);
  return value;
}
