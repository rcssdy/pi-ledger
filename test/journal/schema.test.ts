import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { applyMigrations, readUserVersion, type Migration } from "../../src/journal/schema.js";

describe("journal schema migrations", () => {
  it("rejects gaps and databases from newer versions", () => {
    const database = new DatabaseSync(":memory:");
    const withGap: readonly Migration[] = [
      { version: 1, migrate() {} },
      { version: 3, migrate() {} },
    ];
    expect(() => applyMigrations(database, withGap)).toThrow("expected 2");

    database.exec("PRAGMA user_version = 2");
    expect(() => applyMigrations(database, [{ version: 1, migrate() {} }])).toThrow(
      "newer than supported",
    );
    database.close();
  });

  it("rolls back a failed migration without advancing its version", () => {
    const database = new DatabaseSync(":memory:");
    const migrations: readonly Migration[] = [
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
    expect(() => applyMigrations(database, migrations)).toThrow("migration failed");
    expect(readUserVersion(database)).toBe(1);
    expect(
      database.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'rolled_back'").get(),
    ).toBeUndefined();
    database.close();
  });
});
