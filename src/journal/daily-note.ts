import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

import { singleLine, truncateCodePoints } from "./text.js";
import type { DailyJournalEntry } from "./types.js";

const LOCK_STALE_MILLISECONDS = 30_000;

type JournalReader = {
  listDates(): readonly string[];
  listDailyEntries(localDate: string): readonly DailyJournalEntry[];
};

export class DailyNoteWriter {
  readonly #journal: JournalReader;
  readonly #notesDirectory: string;

  constructor(journal: JournalReader, notesDirectory: string) {
    this.#journal = journal;
    this.#notesDirectory = notesDirectory;
  }

  async regenerateAll(): Promise<readonly string[]> {
    const paths: string[] = [];
    for (const localDate of this.#journal.listDates()) paths.push(await this.regenerate(localDate));
    return paths;
  }

  async regenerate(localDate: string): Promise<string> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate)) throw new Error(`Invalid local date: ${localDate}`);
    await mkdir(this.#notesDirectory, { recursive: true, mode: 0o700 });
    const notePath = join(this.#notesDirectory, `${localDate}.md`);
    const lockPath = `${notePath}.lock`;
    const lockToken = await acquireLock(lockPath);
    try {
      const markdown = renderDailyNote(localDate, this.#journal.listDailyEntries(localDate));
      const temporaryPath = `${notePath}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporaryPath, markdown, { encoding: "utf8", mode: 0o600 });
        await rename(temporaryPath, notePath);
        if (process.platform !== "win32") await chmod(notePath, 0o600);
      } finally {
        await rm(temporaryPath, { force: true });
      }
      return notePath;
    } finally {
      await releaseLock(lockPath, lockToken);
    }
  }
}

export function renderDailyNote(localDate: string, entries: readonly DailyJournalEntry[]): string {
  const groups = new Map<string, DailyJournalEntry[]>();
  for (const entry of entries) {
    const project = basename(entry.cwd) || "Unknown project";
    const group = groups.get(project);
    if (group === undefined) groups.set(project, [entry]);
    else group.push(entry);
  }

  const sections = [`# Daily Journal — ${localDate}`];
  for (const project of [...groups.keys()].sort(compareText)) {
    sections.push(`## ${escapeMarkdown(project)}`);
    for (const entry of groups.get(project) ?? []) sections.push(renderEntry(entry));
  }
  return `${sections.join("\n\n")}\n`;
}

function renderEntry(entry: DailyJournalEntry): string {
  const request = singleLine(entry.request);
  const title = truncateCodePoints(request, 100) || "Untitled entry";
  const lines = [`### ${entry.localTime} — ${escapeMarkdown(title)}`];
  if (request !== title)
    lines.push(`**Request:** ${escapeMarkdown(truncateCodePoints(request, 500))}`);
  lines.push(sessionReference(entry));

  if (entry.models.length > 0) {
    lines.push(
      `**Models:** ${entry.models.map((model) => code(`${model.provider}/${model.model}`)).join(", ")}`,
    );
  }

  const modelTokens = entry.models.reduce((sum, model) => sum + model.totalTokens, 0);
  const modelCost = entry.models.reduce((sum, model) => sum + model.totalCost, 0);
  const toolTokens = entry.tools.reduce((sum, tool) => sum + tool.totalTokens, 0);
  const toolCost = entry.tools.reduce((sum, tool) => sum + tool.totalCost, 0);
  if (entry.models.length > 0 || toolTokens > 0 || toolCost > 0) {
    const breakdown = entry.models.map(
      (model) =>
        `- ${code(`${model.provider}/${model.model}`)}: ${formatTokens(model.totalTokens)} · ${formatCost(model.totalCost)} · ${model.responses} ${pluralize("response", model.responses)}`,
    );
    if (toolTokens > 0 || toolCost > 0) {
      breakdown.push(
        `- Tool-reported usage: ${formatTokens(toolTokens)} · ${formatCost(toolCost)}`,
      );
    }
    lines.push(
      [
        `**Usage:** ${formatTokens(modelTokens + toolTokens)} · ${formatCost(modelCost + toolCost)}`,
        ...breakdown,
      ].join("\n"),
    );
  }

  if (entry.tools.length > 0) {
    lines.push(
      `**Tools:** ${entry.tools
        .map((tool) => {
          const failures = tool.failures > 0 ? `, ${tool.failures} failed` : "";
          return `${code(tool.name)} ×${tool.executions}${failures}`;
        })
        .join(" · ")}`,
    );
  }
  if (entry.state === "interrupted") lines.push("**State:** interrupted");
  return lines.join("\n\n");
}

function sessionReference(entry: DailyJournalEntry): string {
  const identity = `Session ${code(entry.piSessionId)} · entry ${code(entry.userEntryId)}`;
  if (entry.sessionFile === undefined) return `**Transcript:** ${identity} (ephemeral session)`;
  return `**Transcript:** [Open Pi session](<${pathToFileURL(entry.sessionFile).href}>) · ${identity}`;
}

function pluralize(unit: string, count: number): string {
  return count === 1 ? unit : `${unit}s`;
}

function formatTokens(tokens: number): string {
  return `${new Intl.NumberFormat("en-US").format(tokens)} tokens`;
}

function formatCost(cost: number): string {
  if (cost === 0) return "$0";
  return `$${cost.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;
}

function code(value: string): string {
  return `\`${value.replaceAll("`", "\\`")}\``;
}

function escapeMarkdown(value: string): string {
  return value
    .replace(/([\\`*_[\]#<>|])/g, "\\$1")
    .replace(/^([-+>])/, "\\$1")
    .replace(/^(\d+)\./, "$1\\.");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function acquireLock(lockPath: string): Promise<string> {
  const token = randomUUID();
  for (let attempt = 0; attempt < 1_200; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(token, "utf8");
      await handle.close();
      return token;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      if (await isStale(lockPath)) {
        await rm(lockPath, { force: true });
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`Timed out waiting for daily-note lock: ${lockPath}`);
}

async function releaseLock(lockPath: string, token: string): Promise<void> {
  try {
    if ((await readFile(lockPath, "utf8")) === token) await rm(lockPath, { force: true });
  } catch {
    // A stale-lock recovery may already have removed the file.
  }
}

async function isStale(path: string): Promise<boolean> {
  try {
    return Date.now() - (await stat(path)).mtimeMs > LOCK_STALE_MILLISECONDS;
  } catch {
    return false;
  }
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
