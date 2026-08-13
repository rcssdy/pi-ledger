import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

import { isLocalDate } from "./local-time.js";
import { singleLine, truncateCodePoints } from "./text.js";
import type {
  DailyJournalEntry,
  DirtyJournalDate,
  ModelFacts,
  TokenFacts,
  ToolFacts,
} from "./types.js";

const LOCK_STALE_MILLISECONDS = 30_000;

type JournalReader = {
  listDirtyDates(): readonly DirtyJournalDate[];
  markNoteClean(localDate: string, revision: number): void;
  listDailyEntries(localDate: string): readonly DailyJournalEntry[];
};

export class DailyNoteWriter {
  readonly #journal: JournalReader;
  readonly #notesDirectory: string;

  constructor(journal: JournalReader, notesDirectory: string) {
    this.#journal = journal;
    this.#notesDirectory = notesDirectory;
  }

  async regenerateDirty(): Promise<readonly string[]> {
    const paths: string[] = [];
    for (const { localDate, revision } of this.#journal.listDirtyDates()) {
      paths.push(await this.regenerate(localDate));
      this.#journal.markNoteClean(localDate, revision);
    }
    return paths;
  }

  async regenerate(localDate: string): Promise<string> {
    if (!isLocalDate(localDate)) throw new Error(`Invalid local date: ${localDate}`);
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
    const group = groups.get(entry.cwd);
    if (group === undefined) groups.set(entry.cwd, [entry]);
    else group.push(entry);
  }

  const sections = [`# Daily Journal — ${localDate}`];
  const projects = [...groups.keys()].map((cwd) => ({
    cwd,
    name: basename(cwd) || "Unknown project",
  }));
  const nameCounts = new Map<string, number>();
  for (const { name } of projects) nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  for (const project of projects.sort(
    (left, right) => compareText(left.name, right.name) || compareText(left.cwd, right.cwd),
  )) {
    const title =
      (nameCounts.get(project.name) ?? 0) > 1 ? `${project.name} — ${project.cwd}` : project.name;
    sections.push(`## ${escapeMarkdown(title)}`);
    const sessions = new Map<string, DailyJournalEntry[]>();
    for (const entry of groups.get(project.cwd) ?? []) {
      const session = sessions.get(entry.piSessionId);
      if (session === undefined) sessions.set(entry.piSessionId, [entry]);
      else session.push(entry);
    }
    for (const session of sessions.values()) sections.push(renderSession(session));
  }
  return `${sections.join("\n\n")}\n`;
}

function renderSession(entries: readonly DailyJournalEntry[]): string {
  const first = entries[0];
  if (first === undefined) return "";
  const last = entries.at(-1) ?? first;
  const request = singleLine(first.request);
  const title = truncateCodePoints(request, 100) || "Untitled entry";
  const time =
    first.localTime === last.localTime ? first.localTime : `${first.localTime}–${last.localTime}`;
  const lines = [`### ${time} — ${escapeMarkdown(title)}`, sessionReference(first)];

  lines.push(
    [
      `**Requests:** ${entries.length}`,
      ...entries.map((entry) => {
        const text = truncateCodePoints(singleLine(entry.request), 500) || "Untitled request";
        return `- **${entry.localTime}** — ${escapeMarkdown(text)}`;
      }),
    ].join("\n"),
  );

  const models = new Map<string, ModelFacts>();
  const tools = new Map<string, ToolFacts>();
  for (const entry of entries) {
    for (const model of entry.models) {
      const key = `${model.provider}\0${model.model}`;
      const total = models.get(key);
      if (total === undefined) models.set(key, { ...model });
      else {
        total.responses += model.responses;
        addTokens(total, model);
        total.totalCost += model.totalCost;
      }
    }
    for (const tool of entry.tools) {
      const total = tools.get(tool.name);
      if (total === undefined) tools.set(tool.name, { ...tool });
      else {
        total.executions += tool.executions;
        total.failures += tool.failures;
        addTokens(total, tool);
        total.totalCost += tool.totalCost;
      }
    }
  }
  const modelFacts = [...models.values()];
  const toolFacts = [...tools.values()];

  if (modelFacts.length > 0) {
    lines.push(
      `**Models:** ${modelFacts.map((model) => code(`${model.provider}/${model.model}`)).join(", ")}`,
    );
  }

  const usage = aggregateTokens([...modelFacts, ...toolFacts]);
  const modelCost = modelFacts.reduce((sum, model) => sum + model.totalCost, 0);
  const toolTokens = toolFacts.reduce((sum, tool) => sum + tool.totalTokens, 0);
  const toolCost = toolFacts.reduce((sum, tool) => sum + tool.totalCost, 0);
  if (modelFacts.length > 0 || toolTokens > 0 || toolCost > 0) {
    const breakdown = modelFacts.map(
      (model) =>
        `- ${code(`${model.provider}/${model.model}`)}: ${formatTokenFacts(model)} · ${formatCost(model.totalCost)} · ${model.responses} ${pluralize("response", model.responses)}`,
    );
    if (toolTokens > 0 || toolCost > 0) {
      breakdown.push(
        `- Tool-reported usage: ${formatTokenFacts(aggregateTokens(toolFacts))} · ${formatCost(toolCost)}`,
      );
    }
    lines.push(
      [
        `**Usage:** ${formatTokenFacts(usage)} · ${formatCost(modelCost + toolCost)}`,
        ...breakdown,
      ].join("\n"),
    );
  }

  if (toolFacts.length > 0) {
    lines.push(
      `**Tools:** ${toolFacts
        .map((tool) => {
          const failures = tool.failures > 0 ? `, ${tool.failures} failed` : "";
          return `${code(tool.name)} ×${tool.executions}${failures}`;
        })
        .join(" · ")}`,
    );
  }
  const interruptions = entries.filter((entry) => entry.state === "interrupted").length;
  if (interruptions > 0)
    lines.push(`**State:** ${interruptions} interrupted ${pluralize("request", interruptions)}`);
  return lines.join("\n\n");
}

function aggregateTokens(facts: readonly TokenFacts[]): TokenFacts {
  const total: TokenFacts = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
  };
  for (const fact of facts) addTokens(total, fact);
  return total;
}

function addTokens(total: TokenFacts, fact: TokenFacts): void {
  total.inputTokens += fact.inputTokens;
  total.outputTokens += fact.outputTokens;
  total.cacheReadTokens += fact.cacheReadTokens;
  total.cacheWriteTokens += fact.cacheWriteTokens;
  total.totalTokens += fact.totalTokens;
}

function formatTokenFacts(facts: TokenFacts): string {
  const breakdown = [
    ["input", facts.inputTokens],
    ["output", facts.outputTokens],
    ["cache read", facts.cacheReadTokens],
    ["cache write", facts.cacheWriteTokens],
  ] as const;
  return `${formatTokens(facts.totalTokens)} (${breakdown
    .map(([label, tokens]) => `${label} ${formatNumber(tokens)}`)
    .join(" · ")})`;
}

function sessionReference(entry: DailyJournalEntry): string {
  const identity = `Session ${code(entry.piSessionId)}`;
  if (entry.sessionFile === undefined) return `**Transcript:** ${identity} (ephemeral session)`;
  return `**Transcript:** [Open Pi session](<${pathToFileURL(entry.sessionFile).href}>) · ${identity}`;
}

function pluralize(unit: string, count: number): string {
  return count === 1 ? unit : `${unit}s`;
}

function formatTokens(tokens: number): string {
  return `${formatNumber(tokens)} tokens`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
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
