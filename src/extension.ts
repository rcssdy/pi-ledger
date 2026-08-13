import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { pathToFileURL } from "node:url";
import { Type } from "typebox";

import { DailyNoteWriter } from "./journal/daily-note.js";
import { openJournalDatabase } from "./journal/database.js";
import { JournalRecorder } from "./journal/recorder.js";
import { singleLine, truncateCodePoints } from "./journal/text.js";
import type { Journal, JournalSearchResult, RecordedJournalEntry } from "./journal/types.js";

const RECORDING_OVERRIDE_ENTRY = "pi-ledger-recording";

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
  let initializing: Promise<JournalRecorder | undefined> | undefined;
  let unavailableReason = "unknown error";
  let recordingWarningShown = false;
  let noteWarningShown = false;
  const pendingRequests = new Map<string, string>();

  const initialize = async (): Promise<JournalRecorder | undefined> => {
    if (disabled) return undefined;
    if (recorder !== undefined) return recorder;
    initializing ??= (async () => {
      try {
        journal = await openJournal();
        recorder = new JournalRecorder(journal, { now });
        notes = new DailyNoteWriter(journal, journal.paths.notesDirectory);
        return recorder;
      } catch (error) {
        unavailableReason = error instanceof Error ? error.message : String(error);
        journal?.close();
        journal = undefined;
        recorder = undefined;
        notes = undefined;
        disabled = true;
        return undefined;
      } finally {
        initializing = undefined;
      }
    })();
    return initializing;
  };

  const warnRecording = (ctx: ExtensionContext, error = unavailableReason): void => {
    if (recordingWarningShown) return;
    recordingWarningShown = true;
    ctx.ui.notify(
      `pi-ledger ${disabled ? "stopped recording" : "could not record an entry"}: ${error}`,
      "warning",
    );
  };

  const regenerateNotes = async (ctx: ExtensionContext): Promise<void> => {
    try {
      await notes?.regenerateDirty();
    } catch (error) {
      if (noteWarningShown) return;
      noteWarningShown = true;
      const reason = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`pi-ledger could not update its Markdown notes: ${reason}`, "warning");
    }
  };

  const recordingState = (
    ctx: ExtensionContext,
  ): { enabled: boolean; scope: "default" | "project" | "session" } => {
    const override = sessionRecordingOverride(ctx);
    if (override !== undefined) return { enabled: override, scope: "session" };
    const excluded = journal?.isProjectExcluded(ctx.sessionManager.getCwd()) ?? false;
    return { enabled: !excluded, scope: excluded ? "project" : "default" };
  };

  const updateRecordingStatus = (ctx: ExtensionContext): void => {
    const state = recordingState(ctx);
    ctx.ui.setStatus("pi-ledger", state.enabled ? undefined : `ledger off · ${state.scope}`);
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
        throw new Error(`The local journal is unavailable: ${unavailableReason}`);
      }
      const results = journal.search(parameters);
      return {
        content: [
          {
            type: "text",
            text: formatSearchResults(results, `No journal entries matched: ${parameters.query}`),
          },
        ],
        details: { results },
      };
    },
  });

  pi.registerTool({
    name: "journal_related",
    label: "Find Related Journal Entries",
    description:
      "Find journal entries covering similar request topics to a prior journal entry. Uses local full-text ranking and returns at most 10 entries.",
    promptSnippet: "Find work related to a known Pi journal entry",
    promptGuidelines: [
      "Use journal_related after journal_search when neighbouring work on the same topic may help.",
    ],
    parameters: Type.Object({
      entryId: Type.Integer({ minimum: 1, description: "Ledger entry ID from journal_search" }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, default: 10 })),
    }),
    async execute(_toolCallId, parameters) {
      const active = await initialize();
      if (active === undefined || journal === undefined) {
        throw new Error(`The local journal is unavailable: ${unavailableReason}`);
      }
      const results = journal.related(parameters.entryId, parameters.limit);
      return {
        content: [
          {
            type: "text",
            text: formatSearchResults(
              results,
              `No related journal entries found for entry ${parameters.entryId}`,
            ),
          },
        ],
        details: { results },
      };
    },
  });

  pi.registerCommand("ledger", {
    description: "Show status, control recording, or rebuild Markdown notes",
    handler: async (args, ctx) => {
      if ((await initialize()) === undefined || journal === undefined || notes === undefined) {
        warnRecording(ctx);
        return;
      }
      const parts = args.trim() === "" ? [] : args.trim().toLowerCase().split(/\s+/);
      const [action = "", scope = "session", extra] = parts;
      if (
        extra !== undefined ||
        (action === "rebuild" && parts.length > 1) ||
        (action !== "on" && action !== "off" && action !== "rebuild" && action !== "")
      ) {
        ctx.ui.notify("Usage: /ledger [on|off [session|project]|rebuild]", "warning");
        return;
      }
      if (action === "rebuild") {
        try {
          journal.markAllNotesDirty();
          const paths = await notes.regenerateDirty();
          ctx.ui.notify(
            `Rebuilt ${paths.length} journal ${paths.length === 1 ? "note" : "notes"}`,
            "info",
          );
        } catch (error) {
          ctx.ui.notify(
            `Could not rebuild journal notes: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          );
        }
        return;
      }
      if (action === "on" || action === "off") {
        if (scope === "project") {
          journal.setProjectExcluded(ctx.sessionManager.getCwd(), action === "off");
          pi.appendEntry(RECORDING_OVERRIDE_ENTRY, { enabled: null });
        } else if (scope === "session") {
          pi.appendEntry(RECORDING_OVERRIDE_ENTRY, { enabled: action === "on" });
        } else {
          ctx.ui.notify("Recording scope must be session or project", "warning");
          return;
        }
        updateRecordingStatus(ctx);
      }
      const state = recordingState(ctx);
      ctx.ui.notify(
        `pi-ledger recording is ${state.enabled ? "ON" : "OFF"} for ${ctx.sessionManager.getCwd()} (${state.scope})`,
        "info",
      );
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const active = await initialize();
    if (active === undefined) {
      warnRecording(ctx);
      return;
    }
    try {
      active.agentSettled(ctx.sessionManager);
    } catch (error) {
      warnRecording(ctx, error instanceof Error ? error.message : String(error));
    }
    await regenerateNotes(ctx);
    updateRecordingStatus(ctx);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if ((await initialize()) === undefined) {
      warnRecording(ctx);
      return;
    }
    if (!recordingState(ctx).enabled) return;
    pendingRequests.set(ctx.sessionManager.getSessionId(), event.prompt);
  });

  pi.on("context", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const request = pendingRequests.get(sessionId);
    pendingRequests.delete(sessionId);
    if (!recordingState(ctx).enabled) return;
    try {
      recorder?.entryStarted(ctx.sessionManager, request);
    } catch (error) {
      warnRecording(ctx, error instanceof Error ? error.message : String(error));
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    let entries: readonly RecordedJournalEntry[] = [];
    try {
      entries = recorder?.agentSettled(ctx.sessionManager) ?? [];
    } catch (error) {
      warnRecording(ctx, error instanceof Error ? error.message : String(error));
    }
    if (entries.length > 0) await regenerateNotes(ctx);
  });

  pi.on("session_shutdown", async (event, ctx) => {
    try {
      const entries = recorder?.sessionShutdown(ctx.sessionManager, event.reason) ?? [];
      if (entries.length > 0) await regenerateNotes(ctx);
    } catch (error) {
      warnRecording(ctx, error instanceof Error ? error.message : String(error));
    } finally {
      journal?.close();
      journal = undefined;
      recorder = undefined;
      notes = undefined;
      disabled = false;
      unavailableReason = "unknown error";
      recordingWarningShown = false;
      noteWarningShown = false;
      pendingRequests.clear();
      ctx.ui.setStatus("pi-ledger", undefined);
    }
  });
}

function formatSearchResults(
  results: readonly JournalSearchResult[],
  emptyMessage: string,
): string {
  if (results.length === 0) return emptyMessage;
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
        `Ledger entry: ${result.id}`,
        models ? `Models: ${models}` : undefined,
        tools ? `Tools: ${tools}` : undefined,
        `Transcript: ${transcript} · entry ${truncateCodePoints(result.userEntryId, 200)}`,
      ]
        .filter((line) => line !== undefined)
        .join("\n");
    })
    .join("\n\n");
}

function sessionRecordingOverride(ctx: ExtensionContext): boolean | undefined {
  const entries = ctx.sessionManager.getBranch();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "custom" || entry.customType !== RECORDING_OVERRIDE_ENTRY) continue;
    const enabled = (entry.data as { enabled?: unknown } | undefined)?.enabled;
    return typeof enabled === "boolean" ? enabled : undefined;
  }
  return undefined;
}
