import type { ProviderEvent, ProviderTimelineItem } from "@getpaseo/plugin/server/provider";
import type { DshSessionEvent, DshStreamFrame, JsonObject } from "../shared/bridge-protocol.js";
import {
  CARD_KINDS,
  CARD_VERSION,
  PLUGIN_ID,
  type GoalCard,
} from "../shared/timeline-cards.js";
import { classifyTurnEnd } from "./turn-end.js";
import { arrayValue, numberValue, objectValue, stringValue } from "./values.js";
import {
  assistantItemId,
  contentText,
  type SessionEvent,
  stepKey,
  stringifyValue,
  timeline,
  toTimestamp,
  transientItemId,
  userContentText,
} from "./timeline-items.js";
import { parseArguments, todoStatus, toolDetail, withOutput } from "./tool-detail.js";
export type { SessionEvent };


/** Converts DSH durable events and transient stream frames into Paseo cumulative snapshots. */
export class TimelineProjector {
  private readonly text = new Map<string, string>();
  private readonly compactions = new Map<string, { trigger: "auto" | "manual"; preTokens?: number }>();
  private readonly tools = new Map<string, Extract<ProviderTimelineItem, { type: "tool_call" }>>();
  /** PTC `run_code` calls: the transport itself, whose `tool/ptc-dispatch` children are the real tool calls. */
  private readonly transportCalls = new Set<string>();
  private readonly settledAttempts = new Map<string, number>();
  private readonly settlementOrdinals = new Map<number, number>();
  private readonly liveAttempts = new Map<
    string,
    { turn: number; step: number; ordinal: number }
  >();
  private readonly liveAttemptByStep = new Map<
    string,
    { attemptId: string; ordinal: number }
  >();

  private planActive = false;
  private lastPreset: string | undefined;
  private readonly goals = new Map<string, { objective?: string; maxRounds?: number }>();
  /** Running subagent runs: child session id to its task description. */
  private readonly subagentRuns = new Map<string, string | undefined>();
  /** Ids of `/goal` commands between their `command/run` and `command/done`; dsh prints their result itself. */
  private readonly goalCommands = new Set<string>();

  /**
   * @param paseoSessionId Paseo session id stamped on every projected event.
   * @param pluginCards Whether the host negotiated `timeline.plugin`; when false no cards are emitted.
   */
  constructor(
    private readonly paseoSessionId: string,
    private readonly pluginCards = false,
  ) {}

  /**
   * Records plan mode, permission preset and goal objectives from history that is
   * not replayed, so the first live change is compared against the right value.
   * @param events DSH durable events of the resumed session, oldest first.
   */
  seed(events: readonly DshSessionEvent[]): void {
    for (const event of events) this.projectCards(event);
  }

  projectEvent(
    event: DshSessionEvent,
    options: { clientMessageId?: string } = {},
  ): SessionEvent[] {
    const timestamp = toTimestamp(event.time);
    // A `/goal` command whose `command/done` never arrived is over once any of these later events appears.
    if (["command/run", "user/message", "turn/start", "turn/end"].includes(event.type)) this.goalCommands.clear();
    switch (event.type) {
      case "user/message":
        return [
          ...this.projectCards(event, timestamp),
          ...this.projectUserMessage(event, timestamp),
        ];
      case "plan/mode":
      case "permission/preset":
      case "goal/change":
        return this.projectCards(event, timestamp);
      case "command/run":
        return this.projectCommandRun(event, options.clientMessageId, timestamp);
      case "command/done":
        return this.projectCommandDone(event, timestamp);
      case "turn/end":
        return this.projectTurnEnd(event, timestamp);
      case "compaction/start":
      case "compaction/summary":
      case "compaction/end":
        return this.projectCompaction(event, timestamp);
      case "assistant/message":
      case "assistant/attempt":
        return this.projectAssistantMessage(event, timestamp);
      case "tool/call":
        return this.projectToolCall(event, timestamp);
      case "tool/result":
        return this.projectToolResult(event, timestamp);
      case "tool/ptc-dispatch-start":
        return this.projectPtcDispatchStart(event, timestamp);
      case "tool/ptc-dispatch":
        return this.projectPtcDispatch(event, timestamp);
      case "todo/write":
        return this.projectTodos(event, timestamp);
      default:
        return [];
    }
  }

  projectStream(frame: DshStreamFrame): SessionEvent[] {
    if (frame.type === "start") {
      const key = stepKey(frame.turn, frame.step);
      const ordinal = this.settledAttempts.get(key) ?? 0;
      this.liveAttempts.set(frame.attemptId, { turn: frame.turn, step: frame.step, ordinal });
      this.liveAttemptByStep.set(key, { attemptId: frame.attemptId, ordinal });
      return [];
    }
    if (frame.type !== "chunk") return [];
    const chunk = frame.chunk;
    const kind = stringValue(chunk.type);
    const index = numberValue(chunk.index) ?? frame.index;
    if (kind === "text-delta" || kind === "reasoning-delta") {
      const type = kind === "text-delta" ? "assistant_message" : "reasoning";
      const attempt = this.liveAttempts.get(frame.attemptId);
      const id = attempt
        ? assistantItemId(type, attempt.turn, attempt.step, attempt.ordinal, index)
        : transientItemId(type, frame.attemptId, index);
      const cumulative = (this.text.get(id) ?? "") + (stringValue(chunk.text) ?? "");
      this.text.set(id, cumulative);
      return [timeline(this.paseoSessionId, { type, id, text: cumulative }, toTimestamp(frame.time))];
    }
    if (kind === "tool-call-delta") {
      const callId = stringValue(chunk.id) ?? `tool:${frame.attemptId}:${index}`;
      const existing = this.tools.get(callId);
      const argumentDelta = stringValue(chunk.argumentsDelta) ?? "";
      const argumentsText =
        (existing?.metadata && stringValue(existing.metadata.argumentsText)) ?? "";
      const name = stringValue(chunk.name) ?? existing?.name ?? "tool";
      if (name === "run_code") {
        this.transportCalls.add(callId);
        return [];
      }
      const item: Extract<ProviderTimelineItem, { type: "tool_call" }> = {
        type: "tool_call",
        id: `tool:${callId}`,
        callId,
        name,
        status: "running",
        error: null,
        detail: toolDetail(name, parseArguments(argumentsText + argumentDelta)),
        metadata: { argumentsText: argumentsText + argumentDelta },
      };
      this.tools.set(callId, item);
      return [timeline(this.paseoSessionId, item, toTimestamp(frame.time))];
    }
    return [];
  }

  failRunningTools(message: string): SessionEvent[] {
    return this.settleRunningTools(message);
  }

  private projectCommandRun(
    event: DshSessionEvent,
    clientMessageId: string | undefined,
    timestamp?: string,
  ): SessionEvent[] {
    const data = event.data;
    const commandId = stringValue(data.commandId);
    const name = stringValue(data.name);
    if (!commandId || !name) return [];
    if (name === "goal") this.goalCommands.add(commandId);
    const id = `command:${commandId}`;
    // `args` keeps DSH's raw separator whitespace after the command name.
    const text = `/${name}${stringValue(data.args) ?? ""}`;
    return [
      timeline(
        this.paseoSessionId,
        { type: "user_message", id, messageId: id, text, ...(clientMessageId ? { clientMessageId } : {}) },
        timestamp,
      ),
    ];
  }

  private projectCommandDone(event: DshSessionEvent, timestamp?: string): SessionEvent[] {
    const data = event.data;
    const commandId = stringValue(data.commandId);
    const message = stringValue(data.text);
    if (commandId) this.goalCommands.delete(commandId);
    if (!commandId || !message) return [];
    return [
      this.notice(`command-done:${commandId}`, data.kind === "error" ? "error" : "info", message, timestamp),
    ];
  }

  /** Failures (replay only; live failures travel on session.turn) and abnormal ends. */
  private projectTurnEnd(event: DshSessionEvent, timestamp?: string): SessionEvent[] {
    const terminal = classifyTurnEnd(event.data);
    const projected: SessionEvent[] = [];
    if (terminal.warning) projected.push(this.notice(`turn-end:${event.seq}`, "warning", terminal.warning, timestamp));
    if (terminal.error) {
      projected.push(
        timeline(this.paseoSessionId, { type: "error", id: `turn-error:${event.seq}`, message: terminal.error.message }, timestamp),
      );
    }
    // A turn never emits further tool results: settle whatever is still running
    // so interrupted turns do not leave permanently spinning tool cards.
    projected.push(...this.settleRunningTools(terminal.error?.message ?? terminal.warning ?? "Turn ended", timestamp));
    return projected;
  }

  /** Marks every running tool card failed; used at turn end and bridge failure. */
  private settleRunningTools(message: string, timestamp?: string): SessionEvent[] {
    const events: SessionEvent[] = [];
    for (const [callId, item] of this.tools) {
      if (item.status !== "running") continue;
      const failed: Extract<ProviderTimelineItem, { type: "tool_call" }> = {
        ...item,
        status: "failed",
        error: message,
      };
      this.tools.set(callId, failed);
      events.push(timeline(this.paseoSessionId, failed, timestamp));
    }
    return events;
  }

  private notice(
    id: string,
    level: "info" | "warning" | "error",
    message: string,
    timestamp?: string,
  ): SessionEvent {
    return timeline(this.paseoSessionId, { type: "notification", id, level, message }, timestamp);
  }

  private projectCompaction(event: DshSessionEvent, timestamp?: string): SessionEvent[] {
    const compactionId = stringValue(event.data.compactionId);
    if (!compactionId) return [];
    const id = `compaction:${compactionId}`;
    const known = this.compactions.get(compactionId);
    const trigger = known?.trigger ?? (stringValue(event.data.sourceCommandId) ? "manual" : "auto");
    if (event.type === "compaction/start") {
      this.compactions.set(compactionId, { trigger });
      return [timeline(this.paseoSessionId, { type: "compaction", id, status: "loading", trigger }, timestamp)];
    }
    if (event.type === "compaction/summary") {
      const tokens = numberValue(event.data.shadowedTokenCount);
      if (known && tokens !== undefined) known.preTokens = tokens;
      return [];
    }
    this.compactions.delete(compactionId);
    const preTokens = known?.preTokens;
    const projected = [
      timeline(
        this.paseoSessionId,
        { type: "compaction", id, status: "completed", trigger, ...(preTokens !== undefined ? { preTokens } : {}) },
        timestamp,
      ),
    ];
    const error = stringValue(event.data.error);
    if (error) projected.push(this.notice(`${id}:error`, "error", `Compaction failed: ${error}`, timestamp));
    return projected;
  }

  /** Updates card state for `event` and returns the plugin cards it produces (none when cards are off). */
  private projectCards(event: DshSessionEvent, timestamp?: string): SessionEvent[] {
    const cards: Array<{ id: string; kind: string; data: Record<string, string | number | boolean> }> = [];
    const data = event.data;
    if (event.type === "plan/mode" && typeof data.active === "boolean") {
      if (data.active !== this.planActive) {
        this.planActive = data.active;
        cards.push({ id: `plan-mode:${event.seq}`, kind: CARD_KINDS.planMode, data: { active: data.active } });
      }
    } else if (event.type === "permission/preset" && typeof data.preset === "string") {
      const previous = this.lastPreset;
      this.lastPreset = data.preset;
      if (previous !== undefined && previous !== data.preset) {
        cards.push({ id: `permission-preset:${event.seq}`, kind: CARD_KINDS.permissionPreset, data: { preset: data.preset } });
      }
    } else if (event.type === "goal/change") {
      const card = this.goalChangeCard(data);
      // A change made while a `/goal` command runs is already reported by that command's own output.
      if (card && this.goalCommands.size === 0) cards.push({ id: `goal:${event.seq}`, kind: CARD_KINDS.goal, data: { ...card } });
    } else if (event.type === "user/message") {
      const source = objectValue(data.source);
      const round = numberValue(source?.round);
      const goalId = stringValue(source?.goalId);
      if (source?.kind === "goal" && round !== undefined && round >= 1) {
        const known = goalId ? this.goals.get(goalId) : undefined;
        const card: GoalCard = {
          operation: "continue",
          round,
          ...(known?.maxRounds !== undefined ? { maxRounds: known.maxRounds } : {}),
          ...(known?.objective !== undefined ? { objective: known.objective } : {}),
        };
        cards.push({ id: `goal-continue:${event.seq}`, kind: CARD_KINDS.goal, data: { ...card } });
      }
    }
    if (!this.pluginCards) return [];
    return cards.map((card) =>
      timeline(
        this.paseoSessionId,
        { type: "plugin", id: card.id, pluginId: PLUGIN_ID, kind: card.kind, version: CARD_VERSION, data: card.data },
        timestamp,
      ),
    );
  }

  private goalChangeCard(data: JsonObject): GoalCard | undefined {
    const operation = stringValue(data.operation);
    if (
      operation !== "create" && operation !== "edit" && operation !== "pause" &&
      operation !== "resume" && operation !== "complete" && operation !== "block" &&
      operation !== "clear"
    ) {
      return undefined;
    }
    const goal = objectValue(operation === "clear" ? data.cleared : data.goal);
    const goalId = stringValue(goal?.id);
    if (operation !== "clear" && goalId) {
      this.goals.set(goalId, {
        objective: stringValue(goal?.objective),
        maxRounds: numberValue(goal?.maxGoalRounds),
      });
    }
    const objective = stringValue(goal?.objective) ?? (goalId ? this.goals.get(goalId)?.objective : undefined);
    const reason = operation === "block" ? stringValue(objectValue(goal?.blockedReason)?.message) : undefined;
    return {
      operation,
      ...(objective !== undefined ? { objective } : {}),
      ...(reason !== undefined ? { reason } : {}),
    };
  }

  private projectUserMessage(event: DshSessionEvent, timestamp?: string): SessionEvent[] {
    const data = event.data;
    const source = objectValue(data.source);
    const sender = stringValue(source?.senderSessionId);
    if (source?.kind === "subagent-settled" && sender && this.subagentRuns.has(sender)) {
      const description = this.subagentRuns.get(sender);
      this.subagentRuns.delete(sender);
      return this.subagentCard(sender, "settled", description, timestamp);
    }
    if (source?.kind !== "user") return [];
    const id = stringValue(data.id) ?? `event:${event.seq}`;
    const text = userContentText(data.content);
    if (!text) return [];
    return [timeline(this.paseoSessionId, { type: "user_message", id, messageId: id, text }, timestamp)];
  }

  private projectAssistantMessage(event: DshSessionEvent, timestamp?: string): SessionEvent[] {
    const data = event.data;
    const message = objectValue(data.message) ?? data;
    const messageId = stringValue(message.id) ?? `event:${event.seq}`;
    const turn = numberValue(data.turn) ?? 0;
    const step = numberValue(data.step) ?? 0;
    const ordinal = this.settlementOrdinal(event.seq, turn, step);
    const content = arrayValue(message.content);
    const projected: SessionEvent[] = [];
    content.forEach((raw, index) => {
      const block = objectValue(raw);
      if (!block) return;
      const type = stringValue(block.type);
      if (type === "text" || type === "reasoning") {
        const itemType = type === "text" ? "assistant_message" : "reasoning";
        const id = assistantItemId(itemType, turn, step, ordinal, index);
        const text = stringValue(block.text) ?? "";
        this.text.set(id, text);
        projected.push(
          timeline(
            this.paseoSessionId,
            itemType === "assistant_message"
              ? { type: itemType, id, messageId, text }
              : { type: itemType, id, text },
            timestamp,
          ),
        );
      } else if (type === "tool-call") {
        const callId = stringValue(block.id) ?? stringValue(block.toolCallId) ?? `${messageId}:${index}`;
        const name = stringValue(block.name) ?? "tool";
        projected.push(...this.startTool(callId, name, block.arguments, timestamp));
      }
    });
    // No session.usage here: Paseo replaces `lastUsage` whole, and a per-message
    // reading would overwrite the bridge's complete one with fewer fields.
    return projected;
  }

  private settlementOrdinal(seq: number, turn: number, step: number): number {
    const known = this.settlementOrdinals.get(seq);
    if (known !== undefined) return known;

    const key = stepKey(turn, step);
    const live = this.liveAttemptByStep.get(key);
    const ordinal = live?.ordinal ?? this.settledAttempts.get(key) ?? 0;
    this.settlementOrdinals.set(seq, ordinal);
    this.settledAttempts.set(key, Math.max(this.settledAttempts.get(key) ?? 0, ordinal + 1));
    if (live) {
      this.liveAttemptByStep.delete(key);
      this.liveAttempts.delete(live.attemptId);
    }
    return ordinal;
  }

  private projectToolCall(event: DshSessionEvent, timestamp?: string): SessionEvent[] {
    const callId = stringValue(event.data.callId) ?? `event:${event.seq}`;
    const name = stringValue(event.data.name) ?? "tool";
    return this.startTool(callId, name, event.data.arguments, timestamp);
  }

  /**
   * Starts one tool card. DSH's PTC preset presents only `run_code`, which is the
   * transport for the `tool/ptc-dispatch` sub-calls: a card for it would show the
   * script's raw JSON while hiding the reads, edits and commands it ran.
   */
  private startTool(
    callId: string,
    name: string,
    rawArguments: unknown,
    timestamp?: string,
  ): SessionEvent[] {
    if (name === "run_code") {
      this.transportCalls.add(callId);
      return [];
    }
    const item: Extract<ProviderTimelineItem, { type: "tool_call" }> = {
      type: "tool_call",
      id: `tool:${callId}`,
      callId,
      name,
      status: "running",
      error: null,
      detail: toolDetail(name, parseArguments(rawArguments)),
      metadata: { argumentsText: stringifyValue(rawArguments) },
    };
    this.tools.set(callId, item);
    return [timeline(this.paseoSessionId, item, timestamp)];
  }

  private projectPtcDispatchStart(event: DshSessionEvent, timestamp?: string): SessionEvent[] {
    const callId = stringValue(event.data.subCallId);
    if (!callId) return [];
    return this.startTool(callId, stringValue(event.data.name) ?? "tool", event.data.arguments, timestamp);
  }

  private projectPtcDispatch(event: DshSessionEvent, timestamp?: string): SessionEvent[] {
    const callId = stringValue(event.data.subCallId);
    if (!callId) return [];
    const payload = event.data.content;
    const output = contentText(payload) || stringifyValue(payload);
    const isError = event.data.isError === true;
    const name = stringValue(event.data.name);
    const child = isError ? undefined : /started subagent ([^\s]+)/u.exec(output)?.[1];
    if (child && (name === "subagent" || name === "subagent_fork")) {
      const running = this.tools.get(callId);
      const description = running?.detail.type === "plain_text" ? running.detail.label : undefined;
      this.subagentRuns.set(child, description);
      return [
        ...this.subagentCard(child, "running", description, timestamp),
        ...this.settleTool(callId, name, output, isError, timestamp, event.data.arguments),
      ];
    }
    return this.settleTool(
      callId,
      name,
      output,
      isError,
      timestamp,
      event.data.arguments,
    );
  }

  /**
   * DSH appends the whole checklist on every `todo_write`, in both presets, so one
   * stable id keeps a single todo block that updates instead of a stack of them.
   */
  private projectTodos(event: DshSessionEvent, timestamp?: string): SessionEvent[] {
    const items = arrayValue(event.data.todos).map(objectValue).flatMap((todo) => {
      const text = stringValue(todo?.content) ?? stringValue(todo?.text);
      if (!text) return [];
      const status = todoStatus(todo?.status);
      return [{ text, completed: status === "completed", ...(status ? { status } : {}) }];
    });
    if (items.length === 0) return [];
    return [timeline(this.paseoSessionId, { type: "todo", id: "dsh-todos", items }, timestamp)];
  }

  private projectToolResult(event: DshSessionEvent, timestamp?: string): SessionEvent[] {
    const message = objectValue(event.data.message) ?? event.data;
    // DSH tool messages carry the call id next to the content (`toolCallId`,
    // `source.callId`) with plain text blocks inside; a `tool-result` content
    // block is accepted for layouts that embed it instead.
    const direct = objectValue(message.content);
    const block = direct?.type === "tool-result"
      ? direct
      : arrayValue(message.content)
          .map(objectValue)
          .find((candidate) => candidate?.type === "tool-result");
    const source = objectValue(message.source);
    const callId =
      stringValue(message.toolCallId) ??
      stringValue(message.tool_call_id) ??
      (source?.kind === "tool" ? stringValue(source.callId) : undefined) ??
      stringValue(block?.toolCallId) ??
      stringValue(block?.tool_call_id);
    if (!callId) return [];
    // A `run_code` result repeats what its dispatches already showed, as raw text.
    // DSH may log the same result again after a compaction prune, so keep the id.
    if (this.transportCalls.has(callId)) return [];
    const payload = block?.content ?? message.content;
    const output = contentText(payload) || stringifyValue(payload);
    const isError =
      message.isError === true || event.data.isError === true || block?.isError === true;
    const child = /started subagent ([^\s]+)/u.exec(output)?.[1];
    const name = this.tools.get(callId)?.name;
    if (child && (name === "subagent" || name === "subagent_fork")) {
      const running = this.tools.get(callId);
      const description =
        running?.detail.type === "plain_text" ? running.detail.label : undefined;
      this.subagentRuns.set(child, description);
      return [
        ...this.subagentCard(child, "running", description, timestamp),
        ...this.settleTool(callId, undefined, output, isError, timestamp),
      ];
    }
    return this.settleTool(callId, undefined, output, isError, timestamp);
  }

  /** One card per subagent run, keyed by the child session so a settle updates it in place. */
  private subagentCard(
    childSessionId: string,
    state: "running" | "settled",
    description: string | undefined,
    timestamp?: string,
  ): SessionEvent[] {
    if (!this.pluginCards) return [];
    return [
      timeline(
        this.paseoSessionId,
        {
          type: "plugin",
          id: `subagent-run:${childSessionId}`,
          pluginId: PLUGIN_ID,
          kind: CARD_KINDS.subagentRun,
          version: CARD_VERSION,
          data: { childSessionId, state, ...(description ? { description } : {}) },
        },
        timestamp,
      ),
    ];
  }

  private settleTool(
    callId: string,
    name: string | undefined,
    output: string,
    isError: boolean,
    timestamp?: string,
    rawArguments?: unknown,
  ): SessionEvent[] {
    const existing = this.tools.get(callId) ?? {
      type: "tool_call" as const,
      id: `tool:${callId}`,
      callId,
      name: name ?? "tool",
      status: "running" as const,
      error: null,
      detail: toolDetail(name ?? "tool", parseArguments(rawArguments)),
    };
    const detail = withOutput(existing.detail, output);
    const item: Extract<ProviderTimelineItem, { type: "tool_call" }> = isError
      ? { ...existing, detail, status: "failed", error: output || "Tool failed" }
      : { ...existing, detail, status: "completed", error: null };
    this.tools.set(callId, item);
    return [timeline(this.paseoSessionId, item, timestamp)];
  }
}

