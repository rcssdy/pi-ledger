import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { JournalPaths } from "./types.js";

/** Resolve every path owned by pi-ledger from Pi's agent directory. */
export function resolveJournalPaths(agentDirectory?: string): JournalPaths {
  const configuredDirectory =
    agentDirectory === undefined ? getAgentDir() : expandTilde(agentDirectory);
  const resolvedAgentDirectory = resolve(configuredDirectory);
  const journalDirectory = join(resolvedAgentDirectory, "ledger");

  return {
    agentDirectory: resolvedAgentDirectory,
    journalDirectory,
    databasePath: join(journalDirectory, "ledger.sqlite"),
    notesDirectory: join(journalDirectory, "notes"),
  };
}

function expandTilde(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return path;
}
