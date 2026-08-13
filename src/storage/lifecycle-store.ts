import type { DatabaseSync } from "node:sqlite";

export interface SessionRecordInput {
  piSessionId: string;
  sessionFile?: string;
  startedAt: string;
}

export interface PendingInteractionRecord {
  piLeafEntryId: string;
  userRequest: string;
  startedAt: string;
}

export interface UsageRecord {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
  reasoning?: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export interface AssistantMetadata {
  piEntryId: string;
  api: string;
  provider: string;
  model: string;
  stopReason: string;
  errorMessage?: string;
  createdAt: string;
  usage: UsageRecord;
}

export interface ToolMetadata {
  piEntryId: string;
  toolCallId: string;
  toolName: string;
  startedAt?: string;
  endedAt: string;
  isError: boolean;
  usage?: UsageRecord;
}

export interface SettledInteractionInput {
  piSessionId: string;
  piLeafEntryId: string;
  settledAt: string;
  state?: "settled" | "interrupted";
  assistants: readonly AssistantMetadata[];
  tools: readonly ToolMetadata[];
}

export interface LifecycleStore {
  startSession(input: SessionRecordInput): void;
  beginInteraction(piSessionId: string, interaction: PendingInteractionRecord): void;
  listPendingInteractions(piSessionId: string): readonly PendingInteractionRecord[];
  settleInteraction(input: SettledInteractionInput): void;
  interruptPendingInteractions(piSessionId: string, settledAt: string): void;
  closeSession(piSessionId: string, endedAt: string): void;
}

export class SqliteLifecycleStore implements LifecycleStore {
  readonly #database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.#database = database;
  }

  startSession(input: SessionRecordInput): void {
    this.#database
      .prepare(`
        INSERT INTO sessions (pi_session_id, session_file, started_at, state)
        VALUES (?, ?, ?, 'active')
        ON CONFLICT (pi_session_id) DO UPDATE SET
          session_file = excluded.session_file,
          ended_at = NULL,
          state = 'active'
      `)
      .run(input.piSessionId, input.sessionFile ?? null, input.startedAt);
  }

  beginInteraction(piSessionId: string, interaction: PendingInteractionRecord): void {
    this.#database
      .prepare(`
        INSERT INTO pending_interactions (
          session_id,
          pi_leaf_entry_id,
          user_request,
          started_at
        )
        SELECT id, ?, ?, ? FROM sessions WHERE pi_session_id = ?
        ON CONFLICT (session_id, pi_leaf_entry_id) DO UPDATE SET
          user_request = excluded.user_request
      `)
      .run(interaction.piLeafEntryId, interaction.userRequest, interaction.startedAt, piSessionId);
  }

  listPendingInteractions(piSessionId: string): readonly PendingInteractionRecord[] {
    return this.#database
      .prepare(`
        SELECT
          pending.pi_leaf_entry_id AS piLeafEntryId,
          pending.user_request AS userRequest,
          pending.started_at AS startedAt
        FROM pending_interactions pending
        JOIN sessions session ON session.id = pending.session_id
        WHERE session.pi_session_id = ?
        ORDER BY pending.started_at, pending.pi_leaf_entry_id
      `)
      .all(piSessionId) as unknown as PendingInteractionRecord[];
  }

  settleInteraction(input: SettledInteractionInput): void {
    this.#transaction(() => {
      const sessionId = this.#sessionId(input.piSessionId);
      const pending = this.#database
        .prepare(`
          SELECT user_request AS userRequest, started_at AS startedAt
          FROM pending_interactions
          WHERE session_id = ? AND pi_leaf_entry_id = ?
        `)
        .get(sessionId, input.piLeafEntryId) as
        | { userRequest: string; startedAt: string }
        | undefined;
      if (pending === undefined) return;

      this.#database
        .prepare(`
          INSERT INTO interactions (
            session_id,
            pi_leaf_entry_id,
            user_request,
            started_at,
            settled_at,
            state
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT (session_id, pi_leaf_entry_id) DO UPDATE SET
            user_request = excluded.user_request,
            settled_at = excluded.settled_at,
            state = excluded.state
        `)
        .run(
          sessionId,
          input.piLeafEntryId,
          pending.userRequest,
          pending.startedAt,
          input.settledAt,
          input.state ?? "settled",
        );
      const interactionId = this.#interactionId(sessionId, input.piLeafEntryId);
      for (const assistant of input.assistants) {
        this.#upsertAssistant(interactionId, assistant);
        this.#upsertUsage(
          interactionId,
          "assistant",
          assistant.piEntryId,
          assistant.provider,
          assistant.model,
          assistant.usage,
        );
      }
      for (const tool of input.tools) {
        this.#upsertTool(interactionId, tool);
        if (tool.usage !== undefined) {
          this.#upsertUsage(interactionId, "tool", tool.piEntryId, null, null, tool.usage);
        }
      }
      this.#deletePending(sessionId, input.piLeafEntryId);
    });
  }

  interruptPendingInteractions(piSessionId: string, settledAt: string): void {
    this.#transaction(() => {
      const sessionId = this.#sessionId(piSessionId);
      const pending = this.listPendingInteractions(piSessionId);
      const insert = this.#database.prepare(`
        INSERT INTO interactions (
          session_id,
          pi_leaf_entry_id,
          user_request,
          started_at,
          settled_at,
          state
        ) VALUES (?, ?, ?, ?, ?, 'interrupted')
        ON CONFLICT (session_id, pi_leaf_entry_id) DO NOTHING
      `);
      for (const interaction of pending) {
        insert.run(
          sessionId,
          interaction.piLeafEntryId,
          interaction.userRequest,
          interaction.startedAt,
          settledAt,
        );
      }
      this.#database
        .prepare("DELETE FROM pending_interactions WHERE session_id = ?")
        .run(sessionId);
    });
  }

  closeSession(piSessionId: string, endedAt: string): void {
    this.#database
      .prepare(`
        UPDATE sessions
        SET ended_at = ?, state = 'closed'
        WHERE pi_session_id = ?
      `)
      .run(endedAt, piSessionId);
  }

  #upsertAssistant(interactionId: number, assistant: AssistantMetadata): void {
    this.#database
      .prepare(`
        INSERT INTO assistant_messages (
          interaction_id,
          pi_entry_id,
          api,
          provider,
          model,
          stop_reason,
          error_message,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (interaction_id, pi_entry_id) DO UPDATE SET
          api = excluded.api,
          provider = excluded.provider,
          model = excluded.model,
          stop_reason = excluded.stop_reason,
          error_message = excluded.error_message,
          created_at = excluded.created_at
      `)
      .run(
        interactionId,
        assistant.piEntryId,
        assistant.api,
        assistant.provider,
        assistant.model,
        assistant.stopReason,
        assistant.errorMessage ?? null,
        assistant.createdAt,
      );
  }

  #upsertTool(interactionId: number, tool: ToolMetadata): void {
    this.#database
      .prepare(`
        INSERT INTO tool_executions (
          interaction_id,
          pi_entry_id,
          tool_call_id,
          tool_name,
          started_at,
          ended_at,
          is_error
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (interaction_id, pi_entry_id) DO UPDATE SET
          tool_call_id = excluded.tool_call_id,
          tool_name = excluded.tool_name,
          started_at = COALESCE(excluded.started_at, tool_executions.started_at),
          ended_at = excluded.ended_at,
          is_error = excluded.is_error
      `)
      .run(
        interactionId,
        tool.piEntryId,
        tool.toolCallId,
        tool.toolName,
        tool.startedAt ?? null,
        tool.endedAt,
        tool.isError ? 1 : 0,
      );
  }

  #upsertUsage(
    interactionId: number,
    sourceKind: "assistant" | "tool",
    sourceId: string,
    provider: string | null,
    model: string | null,
    usage: UsageRecord,
  ): void {
    this.#database
      .prepare(`
        INSERT INTO model_usage (
          interaction_id,
          source_kind,
          source_id,
          provider,
          model,
          input_tokens,
          output_tokens,
          cache_read_tokens,
          cache_write_tokens,
          cache_write_1h_tokens,
          reasoning_tokens,
          total_tokens,
          input_cost,
          output_cost,
          cache_read_cost,
          cache_write_cost,
          total_cost
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (interaction_id, source_kind, source_id) DO UPDATE SET
          provider = excluded.provider,
          model = excluded.model,
          input_tokens = excluded.input_tokens,
          output_tokens = excluded.output_tokens,
          cache_read_tokens = excluded.cache_read_tokens,
          cache_write_tokens = excluded.cache_write_tokens,
          cache_write_1h_tokens = excluded.cache_write_1h_tokens,
          reasoning_tokens = excluded.reasoning_tokens,
          total_tokens = excluded.total_tokens,
          input_cost = excluded.input_cost,
          output_cost = excluded.output_cost,
          cache_read_cost = excluded.cache_read_cost,
          cache_write_cost = excluded.cache_write_cost,
          total_cost = excluded.total_cost
      `)
      .run(
        interactionId,
        sourceKind,
        sourceId,
        provider,
        model,
        usage.input,
        usage.output,
        usage.cacheRead,
        usage.cacheWrite,
        usage.cacheWrite1h ?? null,
        usage.reasoning ?? null,
        usage.totalTokens,
        usage.cost.input,
        usage.cost.output,
        usage.cost.cacheRead,
        usage.cost.cacheWrite,
        usage.cost.total,
      );
  }

  #sessionId(piSessionId: string): number {
    const row = this.#database
      .prepare("SELECT id FROM sessions WHERE pi_session_id = ?")
      .get(piSessionId) as { id: number } | undefined;
    if (row === undefined) throw new Error(`Unknown Pi session: ${piSessionId}`);
    return row.id;
  }

  #interactionId(sessionId: number, piLeafEntryId: string): number {
    const row = this.#database
      .prepare("SELECT id FROM interactions WHERE session_id = ? AND pi_leaf_entry_id = ?")
      .get(sessionId, piLeafEntryId) as { id: number } | undefined;
    if (row === undefined) throw new Error(`Unknown interaction leaf: ${piLeafEntryId}`);
    return row.id;
  }

  #deletePending(sessionId: number, piLeafEntryId: string): void {
    this.#database
      .prepare("DELETE FROM pending_interactions WHERE session_id = ? AND pi_leaf_entry_id = ?")
      .run(sessionId, piLeafEntryId);
  }

  #transaction(action: () => void): void {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      action();
      this.#database.exec("COMMIT");
    } catch (error) {
      if (this.#database.isTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }
}
