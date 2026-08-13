import { chmodSync, mkdirSync } from "node:fs";

import type { DatabaseSync } from "node:sqlite";

import { SqliteLifecycleStore, type LifecycleStore } from "./lifecycle-store.js";
import { applyMigrations, readUserVersion } from "./migrations.js";
import { resolveLedgerPaths, type LedgerPaths } from "./paths.js";

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

export interface LedgerDatabase {
  readonly paths: LedgerPaths;
  readonly lifecycle: LifecycleStore;
  health(): LedgerDatabaseHealth;
  close(): void;
}

class SqliteLedgerDatabase implements LedgerDatabase {
  readonly paths: LedgerPaths;
  readonly lifecycle: LifecycleStore;

  readonly #database: DatabaseSync;
  #closed = false;

  constructor(database: DatabaseSync, paths: LedgerPaths) {
    this.#database = database;
    this.paths = paths;
    this.lifecycle = new SqliteLifecycleStore(database);
  }

  health(): LedgerDatabaseHealth {
    this.#assertOpen();
    return readHealth(this.#database, this.paths.databasePath);
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

/** Lazily load SQLite so an unsupported runtime can disable only ledger recording. */
export async function openLedgerDatabase(
  options: OpenLedgerDatabaseOptions = {},
): Promise<LedgerDatabase> {
  const paths = resolveLedgerPaths(options.agentDirectory);
  secureDirectory(paths.ledgerDirectory);
  secureDirectory(paths.notesDirectory);

  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(paths.databasePath, {
    enableForeignKeyConstraints: true,
  });

  try {
    secureDatabaseFile(paths.databasePath);
    configureDatabase(database);
    verifyDatabaseConfiguration(database, paths.databasePath);
    verifyFts5Available(database);
    applyMigrations(database);
    return new SqliteLedgerDatabase(database, paths);
  } catch (error) {
    database.close();
    throw error;
  }
}

function configureDatabase(database: DatabaseSync): void {
  database.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
  `);
}

function verifyDatabaseConfiguration(database: DatabaseSync, databasePath: string): void {
  const health = readHealth(database, databasePath);
  const problems: string[] = [];

  if (!health.foreignKeys) problems.push("foreign_keys is not ON");
  if (health.journalMode.toLowerCase() !== "wal") problems.push("journal_mode is not WAL");
  if (health.synchronous !== 1) problems.push("synchronous is not NORMAL");
  if (health.busyTimeoutMilliseconds !== 5000) problems.push("busy_timeout is not 5000");

  if (problems.length > 0) {
    throw new Error(`Ledger SQLite configuration failed: ${problems.join(", ")}`);
  }
}

function verifyFts5Available(database: DatabaseSync): void {
  try {
    database.exec(`
      CREATE VIRTUAL TABLE temp.pi_ledger_fts5_probe USING fts5(value);
      DROP TABLE temp.pi_ledger_fts5_probe;
    `);
  } catch (cause) {
    throw new Error("pi-ledger requires a Node SQLite build with FTS5 enabled", { cause });
  }
}

function readHealth(database: DatabaseSync, databasePath: string): LedgerDatabaseHealth {
  return {
    databasePath,
    userVersion: readUserVersion(database),
    foreignKeys: readPragmaNumber(database, "foreign_keys") === 1,
    journalMode: readPragmaString(database, "journal_mode"),
    synchronous: readPragmaNumber(database, "synchronous"),
    busyTimeoutMilliseconds: readPragmaNumber(database, "busy_timeout"),
  };
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

function secureDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(path, 0o700);
}

function secureDatabaseFile(path: string): void {
  if (process.platform !== "win32") chmodSync(path, 0o600);
}
