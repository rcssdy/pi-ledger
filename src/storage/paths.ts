import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface LedgerPaths {
  agentDirectory: string;
  ledgerDirectory: string;
  databasePath: string;
  notesDirectory: string;
}

/** Resolve every path owned by pi-ledger from Pi's agent directory. */
export function resolveLedgerPaths(agentDirectory?: string): LedgerPaths {
  const configuredDirectory =
    agentDirectory === undefined ? getAgentDir() : expandTilde(agentDirectory);
  const resolvedAgentDirectory = resolve(configuredDirectory);
  const ledgerDirectory = join(resolvedAgentDirectory, "ledger");

  return {
    agentDirectory: resolvedAgentDirectory,
    ledgerDirectory,
    databasePath: join(ledgerDirectory, "ledger.sqlite"),
    notesDirectory: join(ledgerDirectory, "notes"),
  };
}

function expandTilde(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return join(homedir(), path.slice(2));
  }
  return path;
}
