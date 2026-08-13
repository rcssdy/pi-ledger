import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { openLedgerDatabase, type LedgerDatabase } from "../storage/ledger-database.js";
import { LifecycleRecorder } from "./lifecycle-recorder.js";

export interface PiLifecycleOptions {
  openDatabase?: () => Promise<LedgerDatabase>;
}

export function registerLifecycleRecording(
  pi: ExtensionAPI,
  options: PiLifecycleOptions = {},
): void {
  const openDatabase = options.openDatabase ?? openLedgerDatabase;
  let ledger: LedgerDatabase | undefined;
  let recorder: LifecycleRecorder | undefined;
  let disabled = false;
  const pendingPrompts = new Map<string, string>();

  const initialize = async (ctx: ExtensionContext): Promise<LifecycleRecorder | undefined> => {
    if (disabled) return undefined;
    if (recorder !== undefined) return recorder;
    try {
      ledger = await openDatabase();
      recorder = new LifecycleRecorder(ledger.lifecycle);
      recorder.sessionStarted(ctx.sessionManager);
      recorder.agentSettled(ctx.sessionManager);
      return recorder;
    } catch {
      ledger?.close();
      ledger = undefined;
      recorder = undefined;
      disabled = true;
      return undefined;
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    await initialize(ctx);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const active = await initialize(ctx);
    if (active === undefined) return;
    const sessionId = ctx.sessionManager.getSessionId();
    pendingPrompts.set(sessionId, event.prompt);
  });

  pi.on("context", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const prompt = pendingPrompts.get(sessionId);
    pendingPrompts.delete(sessionId);
    safely(() => recorder?.interactionStarted(ctx.sessionManager, prompt));
  });

  pi.on("tool_execution_start", (event, ctx) => {
    safely(() => recorder?.toolStarted(ctx.sessionManager, event.toolCallId));
  });

  pi.on("tool_execution_end", (event, ctx) => {
    safely(() => recorder?.toolEnded(ctx.sessionManager, event.toolCallId));
  });

  pi.on("agent_settled", (_event, ctx) => {
    safely(() => recorder?.agentSettled(ctx.sessionManager));
  });

  pi.on("session_shutdown", (event, ctx) => {
    try {
      recorder?.sessionShutdown(ctx.sessionManager, event.reason);
    } catch {
      // Recording must never prevent Pi from shutting down or replacing a session.
    } finally {
      ledger?.close();
      ledger = undefined;
      recorder = undefined;
      pendingPrompts.delete(ctx.sessionManager.getSessionId());
    }
  });
}

function safely(action: () => void): void {
  try {
    action();
  } catch {
    // Ledger recording is observational and must not break the agent lifecycle.
  }
}
