import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import type { JournalPaths } from "./types.js";

/** Resolve every path owned by pi-ledger from Pi's agent directory. */
export function resolveJournalPaths(agentDirectory?: string): JournalPaths {
  const configuredDirectory =
    agentDirectory === undefined ? getAgentDir() : expandTilde(agentDirectory);
  const resolvedAgentDirectory = resolve(configuredDirectory);
  const journalDirectory = join(resolvedAgentDirectory, "ledger");
  const configuredNotesDirectory =
    agentDirectory === undefined ? process.env.PI_LEDGER_NOTES_DIR : undefined;

  return {
    agentDirectory: resolvedAgentDirectory,
    journalDirectory,
    databasePath: join(journalDirectory, "ledger.sqlite"),
    notesDirectory:
      configuredNotesDirectory === undefined
        ? join(journalDirectory, "notes")
        : resolveNotesDirectory(configuredNotesDirectory),
  };
}

function resolveNotesDirectory(path: string): string {
  const expanded = expandTilde(path);
  if (!isAbsolute(expanded)) {
    throw new Error("PI_LEDGER_NOTES_DIR must be an absolute path or start with ~");
  }
  return resolve(expanded);
}

function expandTilde(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return path;
}
