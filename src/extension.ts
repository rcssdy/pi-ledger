import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { pathToFileURL } from "node:url";
import { Type } from "typebox";

import { DailyNoteWriter } from "./journal/daily-note.js";
import { openJournalDatabase } from "./journal/database.js";
import { JournalRecorder } from "./journal/recorder.js";
import { singleLine, truncateCodePoints } from "./journal/text.js";
import type { Journal, JournalSearchResult, RecordedJournalEntry } from "./journal/types.js";

export interface JournalExtensionOptions {
  openJournal?: () => Promise<Journal>;
  now?: () => Date;
}

export function registerJournalExtension(
  pi: ExtensionAPI,
  options: JournalExtensionOptions = {},
): void {
  const openJournal = options.openJournal ?? openJournalDatabase;
  const now = options.now ?? (() => new Date());
  let journal: Journal | undefined;
  let recorder: JournalRecorder | undefined;
  let notes: DailyNoteWriter | undefined;
  let disabled = false;
  const pendingRequests = new Map<string, string>();

  const initialize = async (): Promise<JournalRecorder | undefined> => {
    if (disabled) return undefined;
    if (recorder !== undefined) return recorder;
    try {
      journal = await openJournal();
      recorder = new JournalRecorder(journal, { now });
      notes = new DailyNoteWriter(journal, journal.paths.notesDirectory);
      return recorder;
    } catch {
      journal?.close();
      journal = undefined;
      recorder = undefined;
      notes = undefined;
      disabled = true;
      return undefined;
    }
  };

  const regenerateDates = async (entries: readonly RecordedJournalEntry[]): Promise<void> => {
    for (const localDate of new Set(entries.map((entry) => entry.localDate))) {
      try {
        await notes?.regenerate(localDate);
      } catch {
        // SQLite remains authoritative; a later startup or entry can repair the note.
      }
    }
  };

  pi.registerTool({
    name: "journal_search",
    label: "Search Journal",
    description:
      "Search the local pi-ledger journal by request text. Returns at most 20 ranked entries with dates, project paths, model/tool facts, and links to native Pi sessions.",
    promptSnippet: "Search prior Pi journal entries by request text and metadata",
    promptGuidelines: [
      "Use journal_search when earlier Pi work may help answer the current request or when the user asks about prior work.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Words or a quoted phrase to find in prior requests" }),
      after: Type.Optional(
        Type.String({
          description: "Earliest local date, inclusive (YYYY-MM-DD)",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
        }),
      ),
      before: Type.Optional(
        Type.String({
          description: "Latest local date, inclusive (YYYY-MM-DD)",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
        }),
      ),
      cwd: Type.Optional(Type.String({ description: "Working-directory prefix" })),
      model: Type.Optional(Type.String({ description: "Provider/model substring" })),
      tool: Type.Optional(Type.String({ description: "Exact tool name" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, default: 10 })),
    }),
    async execute(_toolCallId, parameters) {
      const active = await initialize();
      if (active === undefined || journal === undefined) {
        throw new Error("The local journal is unavailable in this runtime");
      }
      const results = journal.search(parameters);
      return {
        content: [{ type: "text", text: formatSearchResults(results, parameters.query) }],
        details: { results },
      };
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const active = await initialize();
    if (active === undefined) return;
    await regenerateDates(active.agentSettled(ctx.sessionManager));
    try {
      await notes?.regenerateAll();
    } catch {
      // A later entry can repair its own day.
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if ((await initialize()) === undefined) return;
    pendingRequests.set(ctx.sessionManager.getSessionId(), event.prompt);
  });

  pi.on("context", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const request = pendingRequests.get(sessionId);
    pendingRequests.delete(sessionId);
    safely(() => recorder?.entryStarted(ctx.sessionManager, request));
  });

  pi.on("agent_settled", async (_event, ctx) => {
    let entries: readonly RecordedJournalEntry[] = [];
    safely(() => {
      entries = recorder?.agentSettled(ctx.sessionManager) ?? [];
    });
    await regenerateDates(entries);
  });

  pi.on("session_shutdown", async (event, ctx) => {
    try {
      const entries = recorder?.sessionShutdown(ctx.sessionManager, event.reason) ?? [];
      await regenerateDates(entries);
    } catch {
      // Journal recording must never prevent Pi from shutting down or replacing a session.
    } finally {
      journal?.close();
      journal = undefined;
      recorder = undefined;
      notes = undefined;
      pendingRequests.clear();
    }
  });
}

function formatSearchResults(results: readonly JournalSearchResult[], query: string): string {
  if (results.length === 0) return `No journal entries matched: ${query}`;
  return results
    .map((result) => {
      const models = truncateCodePoints(
        result.models.map((model) => `${model.provider}/${model.model}`).join(", "),
        500,
      );
      const tools = truncateCodePoints(
        result.tools.map((tool) => `${tool.name} ×${tool.executions}`).join(", "),
        500,
      );
      const transcript = truncateCodePoints(
        result.sessionFile
          ? pathToFileURL(result.sessionFile).href
          : `ephemeral session ${result.piSessionId}`,
        500,
      );
      return [
        `## ${result.localDate} ${result.localTime} — ${truncateCodePoints(singleLine(result.request), 200)}`,
        truncateCodePoints(singleLine(result.snippet), 500),
        `Project: ${truncateCodePoints(result.cwd, 300)}`,
        models ? `Models: ${models}` : undefined,
        tools ? `Tools: ${tools}` : undefined,
        `Transcript: ${transcript} · entry ${truncateCodePoints(result.userEntryId, 200)}`,
      ]
        .filter((line) => line !== undefined)
        .join("\n");
    })
    .join("\n\n");
}

function safely(action: () => void): void {
  try {
    action();
  } catch {
    // Recording is observational and must not break the Pi lifecycle.
  }
}
