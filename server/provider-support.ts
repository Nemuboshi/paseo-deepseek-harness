import type { ProviderEvent, ProviderInput, ProviderSessionConfig } from "@getpaseo/plugin/server/provider";
import type {
  InteractionRequest,
  SessionOpenResult,
  SlashCommand,
} from "../shared/bridge-protocol.js";
import type { DshBridge, SessionLaunch } from "./bridge-client.js";
import { refreshCommands } from "./provider-commands.js";
import type { TimelineProjector } from "./timeline.js";
import type { TurnTerminal } from "./turn-end.js";
import { objectValue } from "./values.js";

export const CAPABILITIES = [
  "prompt.message",
  "prompt.command",
  "prompt.image",
  "prompt.steer",
  "session.can_stop_runtime",
  "session.configure",
  "session.list",
  "session.persistence",
  "permission",
  "permission.tool_policy",
  "timeline.plugin",
] as const;
export const PERMISSION_PRESET_SETTING = "permissionPreset";
export const PLAN_MODE_SETTING = "planMode";
// Leave room for the host's ten-second safety-query deadline and IPC overhead.
export const RUNTIME_SAFETY_TIMEOUT_MS = 5_000;

export type DetectVersion = (
  executable: string,
  options?: { args?: readonly string[]; env?: Readonly<Record<string, string | undefined>> },
) => Promise<string>;

/** A prompt or command RPC in flight; it owns any turn DSH starts before the RPC returns. */
export interface Dispatch {
  kind: "prompt" | "command";
  clientMessageId: string;
  sawRunning: boolean;
  /** A terminal DSH reported before the RPC returned. */
  deferred: TurnTerminal | null;
}

export interface SessionState {
  paseoId: string;
  nativeId: string;
  config: ProviderSessionConfig;
  open: SessionOpenResult;
  bridge: DshBridge;
  releaseBridgeListeners: Array<() => void>;
  projector: TimelineProjector;
  activeTurnId: string | null;
  cancelRequested: boolean;
  dispatch: Dispatch | null;
  commands: SlashCommand[];
  /** DSH plan mode, from the latest `plan/mode` event. */
  planMode: boolean;
  pendingInteractions: Map<string, InteractionRequest>;
  lane: Promise<void>;
  /** Includes admitted input still waiting for its dispatch microtask or lane. */
  pendingOperations: number;
  /** Reject a safety snapshot if any input or native activity happened meanwhile. */
  activityRevision: number;
  ready: boolean;
  closed: boolean;
}

export interface DispatchState {
  discoveryBridge: DshBridge;
  createBridge: (launch?: SessionLaunch) => Promise<DshBridge>;
  sessions: Map<string, SessionState>;
  emit(event: ProviderEvent): void;
  capabilities: readonly string[];
  detectVersion: DetectVersion;
  launchEnv: Readonly<Record<string, string>> | undefined;
  openingBridges: Set<DshBridge>;
  closeBridge(bridge: DshBridge): Promise<void>;
  isClosed(): boolean;
}

export function startTurn(
  session: SessionState,
  turnId: string,
  emit: (event: ProviderEvent) => void,
): void {
  session.activeTurnId = turnId;
  session.cancelRequested = false;
  emit({ type: "session.turn", sessionId: session.paseoId, turnId, state: "started" });
}

export function finishTurn(
  session: SessionState,
  terminal: TurnTerminal,
  emit: (event: ProviderEvent) => void,
): void {
  const turnId = session.activeTurnId;
  if (!turnId) return;
  emit({
    type: "session.turn",
    sessionId: session.paseoId,
    turnId,
    state: terminal.state,
    ...(terminal.state === "failed"
      ? { error: terminal.error ?? { message: "DSH turn failed" } }
      : {}),
  });
  session.activeTurnId = null;
  session.cancelRequested = false;
  void refreshCommands(session, emit);
}

export function persistence(sessionId: string) {
  return { version: 1, data: { dshSessionId: sessionId } } as const;
}

export function persistenceId(
  value: Extract<ProviderInput, { type: "session.open" }>["persistence"],
): string | undefined {
  if (!value) return undefined;
  if (value.version !== 1) throw new Error(`Unsupported DSH persistence version ${value.version}`);
  const data = objectValue(value.data);
  const id = data?.dshSessionId;
  if (typeof id !== "string" || !id) throw new Error("Invalid DSH persistence handle");
  return id;
}

export function enqueue(session: SessionState, operation: () => Promise<void>): Promise<void> {
  session.lane = session.lane.then(operation, operation);
  return session.lane;
}

export function requireSession(sessions: Map<string, SessionState>, sessionId: string): SessionState {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Unknown session: ${sessionId}`);
  return session;
}

export function failInput(input: ProviderInput, error: unknown, emit: (event: ProviderEvent) => void): void {
  if (input.type === "session.prompt") {
    emitPromptFailure(input, errorMessage(error), emit);
  } else if ("requestId" in input) {
    emit({
      type: "request.failed",
      requestId: input.requestId,
      error: { message: errorMessage(error) },
    });
  }
}

export function emitPromptResult(
  input: Extract<ProviderInput, { type: "session.prompt" }>,
  result: Extract<ProviderEvent, { type: "session.prompt_result" }>["result"],
  emit: (event: ProviderEvent) => void,
): void {
  emit({
    type: "session.prompt_result",
    sessionId: input.sessionId,
    clientMessageId: input.prompt.clientMessageId,
    result,
  });
}

export function emitPromptFailure(
  input: Extract<ProviderInput, { type: "session.prompt" }>,
  message: string,
  emit: (event: ProviderEvent) => void,
): void {
  emitPromptResult(input, { type: "failed", error: { message } }, emit);
}

export function nullableChange(value: string | null | undefined, current: string | undefined): string | undefined {
  return value === null ? undefined : value ?? current;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function timestamp(value: number): string {
  return new Date(value < 10_000_000_000 ? value * 1_000 : value).toISOString();
}
