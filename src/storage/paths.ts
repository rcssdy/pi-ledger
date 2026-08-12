import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface LedgerPaths {
  agentDirectory: string;
  ledgerDirectory: string;
  databasePath: string;
  notesDirectory: string;
}

/** Resolve every path owned by pi-ledger from Pi's agent directory. */
export function resolveLedgerPaths(agentDirectory?: string): LedgerPaths {
  const configuredDirectory = agentDirectory ?? process.env.PI_CODING_AGENT_DIR;
  const resolvedAgentDirectory = configuredDirectory
    ? resolve(configuredDirectory)
    : join(homedir(), ".pi", "agent");
  const ledgerDirectory = join(resolvedAgentDirectory, "ledger");

  return {
    agentDirectory: resolvedAgentDirectory,
    ledgerDirectory,
    databasePath: join(ledgerDirectory, "ledger.sqlite"),
    notesDirectory: join(ledgerDirectory, "notes"),
  };
}

/** SQLite requires an absolute filename when the working directory may change. */
export function assertAbsoluteDatabasePath(databasePath: string): void {
  if (!isAbsolute(databasePath)) {
    throw new Error(`Ledger database path must be absolute: ${databasePath}`);
  }
}
