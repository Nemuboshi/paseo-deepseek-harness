import { randomUUID } from "node:crypto";
import {
  requireProviderCapabilities,
  type ProviderEvent,
  type ProviderInput,
  type ProviderSessionConfig,
} from "@getpaseo/plugin/server/provider";
import { slashLine, type PromptPart, type SlashCommand } from "../shared/bridge-protocol.js";
import { displayText, toPromptParts } from "./prompt-content.js";
import { LIST_SESSIONS_TIMEOUT_MS, type BridgeMcpServer, type DshBridge } from "./bridge-client.js";
import { emitCommands, fetchCommands, refreshCommands } from "./provider-commands.js";
import {
  emitConfig,
  latestPlanMode,
  modelId,
  selectedPermissionPreset,
  selectModel,
  setPlanMode,
  validateSettings,
  catalog,
} from "./provider-config.js";
import { permissionRequest, questionAnswers } from "./provider-interaction.js";
import { listenToSessionBridge } from "./provider-listeners.js";
import {
  PLAN_MODE_SETTING,
  RUNTIME_SAFETY_TIMEOUT_MS,
  emitPromptFailure,
  emitPromptResult,
  errorMessage,
  nullableChange,
  enqueue,
  finishTurn,
  persistence,
  persistenceId,
  timestamp,
  requireSession,
  startTurn,
  type Dispatch,
  type DispatchState,
  type SessionState,
} from "./provider-support.js";
import { PLUGIN_VERSION } from "./plugin-version.js";
import { TimelineProjector } from "./timeline.js";
import { matchVersionLine, versionWarningMessage } from "./version-line.js";

export async function dispatch(input: ProviderInput, state: DispatchState): Promise<void> {
  switch (input.type) {
    case "catalog":
      state.emit({
        type: "catalog",
        requestId: input.requestId,
        catalog: catalog(state.discoveryBridge.initialized.catalog),
      });
      return;
    case "sessions":
      await listSessions(input, state);
      return;
    case "session.open":
      await openSession(input, state);
      return;
    case "session.prompt":
      await enqueue(requireSession(state.sessions, input.sessionId), () => promptSession(input, state));
      return;
    case "session.interrupt":
      await interruptSession(input, state);
      return;
    case "session.permission":
      await respondToPermission(input, state);
      return;
    case "session.configure":
      await enqueue(requireSession(state.sessions, input.sessionId), () => configureSession(input, state));
      return;
    case "session.can_stop_runtime":
      await canStopRuntime(input, state);
      return;
    case "session.close":
      await closeSession(input, state);
      return;
    case "session.archive":
    case "session.unarchive":
    case "session.revert":
      state.emit({
        type: "request.failed",
        requestId: input.requestId,
        error: { message: `${input.type} is not supported` },
      });
  }
}

export async function listSessions(
  input: Extract<ProviderInput, { type: "sessions" }>,
  state: DispatchState,
): Promise<void> {
  const query = input.query?.trim().toLowerCase();
  // Filtering and truncation run in the bridge so title folds only cover the
  // rows Paseo will actually show; the local filters stay as a second net.
  const result = await state.discoveryBridge.request(
    "session.list",
    {
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(query ? { query } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    },
    LIST_SESSIONS_TIMEOUT_MS,
  );
  const rows = result.sessions
    .filter((session): session is typeof session & { cwd: string } => Boolean(session.cwd))
    .filter((session) => !input.cwd || session.cwd === input.cwd)
    .filter(
      (session) =>
        !query || session.title?.toLowerCase().includes(query) || session.id.toLowerCase().includes(query),
    )
    .sort((left, right) => right.createdAt - left.createdAt);
  const sessions = (input.limit === undefined ? rows : rows.slice(0, input.limit))
    .map((session) => ({
      persistence: persistence(session.id),
      cwd: session.cwd ?? "",
      title: session.title,
      description: session.agentPreset ? `preset: ${session.agentPreset}` : undefined,
      updatedAt: timestamp(session.createdAt),
    }));
  state.emit({ type: "sessions", requestId: input.requestId, sessions });
}

export async function openSession(
  input: Extract<ProviderInput, { type: "session.open" }>,
  state: DispatchState,
): Promise<void> {
  validateSessionConfig(input.config);
  const nativeId = persistenceId(input.persistence);
  const bridge = await state.createBridge({
    env: input.config.env,
    ephemeral: !input.config.persist,
    mcpServers: bridgeMcpServers(input.config.mcpServers),
  });
  state.openingBridges.add(bridge);
  let session: SessionState | undefined;
  try {
    if (state.isClosed()) return;
    // Resume from DSH's durable model and preset. Paseo fills catalog defaults into
    // open config, so forwarding them would accidentally overwrite native history.
    const selection = nativeId
      ? undefined
      : selectModel(bridge.initialized.catalog, input.config.model, input.config.thinkingOption);
    const permissionPreset = nativeId
      ? undefined
      : selectedPermissionPreset(input.config.settings, bridge.initialized.catalog);
    const opened = await bridge.request("session.open", {
      ...(nativeId ? { sessionId: nativeId, resume: true } : {}),
      cwd: input.config.cwd,
      ...(selection ? { model: selection } : {}),
      ...(!nativeId && input.config.mode ? { preset: input.config.mode } : {}),
      ...(permissionPreset ? { permissionPreset } : {}),
      ...(input.config.systemPrompt?.trim() ? { systemPrompt: input.config.systemPrompt } : {}),
      ...(input.config.toolPolicy
        ? { preapprovedTools: preapprovedTools(input.config) }
        : {}),
    });
    if (state.isClosed()) return;
    const title = nativeId ? undefined : input.config.title?.trim();
    const [commands] = await Promise.all([
      fetchCommands(bridge, opened.sessionId),
      title ? bridge.request("session.rename", { sessionId: opened.sessionId, title }) : undefined,
    ]);
    if (state.isClosed()) return;
    session = {
      paseoId: input.sessionId,
      nativeId: opened.sessionId,
      config: input.config,
      open: opened,
      bridge,
      releaseBridgeListeners: [],
      projector: new TimelineProjector(input.sessionId, state.capabilities.includes("timeline.plugin")),
      activeTurnId: null,
      cancelRequested: false,
      dispatch: null,
      commands,
      planMode: latestPlanMode(opened.events),
      pendingInteractions: new Map(),
      lane: Promise.resolve(),
      pendingOperations: 0,
      activityRevision: 0,
      ready: false,
      closed: false,
    };
    state.sessions.set(input.sessionId, session);
    session.releaseBridgeListeners = listenToSessionBridge(session, state.emit);
    if (!nativeId && input.config.settings[PLAN_MODE_SETTING] === true) {
      await setPlanMode(session, true);
    }
  } catch (error) {
    if (session) {
      session.closed = true;
      session.releaseBridgeListeners.forEach((release) => release());
      state.sessions.delete(input.sessionId);
    }
    await state.closeBridge(bridge);
    throw error;
  } finally {
    state.openingBridges.delete(bridge);
    if (state.isClosed()) await state.closeBridge(bridge);
  }
  if (state.isClosed()) return;
  state.emit({
    type: "session.opened",
    requestId: input.requestId,
    sessionId: input.sessionId,
    capabilities: state.capabilities,
    restoration: "core",
    // A non-persistent session lives in the bridge's temporary store.
    ...(input.config.persist ? { persistence: persistence(session.nativeId) } : {}),
    cwd: session.open.cwd,
  });
  emitConfig(session, state.emit);
  emitCommands(session, state.emit);
  if (input.history === "replay") {
    for (const event of session.open.events) {
      for (const projected of session.projector.projectEvent(event)) state.emit(projected);
    }
  } else {
    session.projector.seed(session.open.events);
  }
  await warnOnDshVersionMismatch(session, state);
  if (state.isClosed() || session.closed) return;
  session.ready = true;
  state.emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
}

/**
 * Compares the detected local dsh version against the plugin's own line
 * (`PLUGIN_VERSION`'s major.minor) and, on a mismatch or an unconfirmed
 * result, posts a timeline warning and logs the same message to stderr.
 * Never blocks the session: DSH's own handshake is what can fail startup.
 */
export async function warnOnDshVersionMismatch(session: SessionState, state: DispatchState): Promise<void> {
  const dshVersion = await state.detectVersion(session.bridge.executable, {
    args: session.bridge.args ?? [],
    ...(state.launchEnv ? { env: state.launchEnv } : {}),
  }).catch(() => "");
  const status = matchVersionLine(PLUGIN_VERSION, dshVersion);
  if (status === "match") return;
  const message = versionWarningMessage(status, PLUGIN_VERSION, dshVersion);
  console.error(`[paseo-deepseek-harness] ${message}`);
  state.emit({
    type: "timeline.item",
    sessionId: session.paseoId,
    item: { type: "notification", id: `dsh-version:${session.paseoId}`, level: "warning", message },
  });
}

export async function promptSession(
  input: Extract<ProviderInput, { type: "session.prompt" }>,
  state: DispatchState,
): Promise<void> {
  const session = requireSession(state.sessions, input.sessionId);
  if (input.prompt.delivery === "steer") {
    if (!session.activeTurnId) {
      emitPromptFailure(input, "There is no active DSH turn to steer", state.emit);
      return;
    }
    if (input.prompt.input.type !== "message") {
      emitPromptFailure(input, "DSH cannot steer with a command", state.emit);
      return;
    }
    await session.bridge.request("session.steer", {
      sessionId: session.nativeId,
      content: toPromptParts(input.prompt.input.content),
    });
    emitPromptResult(input, { type: "steer", turnId: session.activeTurnId }, state.emit);
    return;
  }
  if (session.activeTurnId || session.dispatch) {
    emitPromptFailure(input, "A DSH turn is already running", state.emit);
    return;
  }
  const prompt = input.prompt.input;
  let content: PromptPart[];
  if (prompt.type === "command") {
    const kind = session.commands.find((candidate) => candidate.name === prompt.name)?.kind;
    if (kind !== "skill") return runCommand(session, input, prompt, state.emit);
    // DSH loads a skill body when a user message starts with `/<skill>`.
    content = [{ type: "text", text: slashLine(prompt.name, prompt.arguments) }];
  } else {
    content = toPromptParts(prompt.content);
  }
  const dispatch = beginDispatch(session, "prompt", input.prompt.clientMessageId);
  try {
    const result = await session.bridge.request("session.prompt", { sessionId: session.nativeId, content });
    state.emit({
      type: "timeline.item",
      sessionId: session.paseoId,
      item: {
        type: "user_message",
        id: result.messageId,
        messageId: result.messageId,
        clientMessageId: input.prompt.clientMessageId,
        text: displayText(content),
      },
    });
    acceptTurn(session, input, dispatch, result.messageId, state.emit);
  } catch (error) {
    emitPromptFailure(input, errorMessage(error), state.emit);
  } finally {
    session.dispatch = null;
  }
}

export async function runCommand(
  session: SessionState,
  input: Extract<ProviderInput, { type: "session.prompt" }>,
  command: { name: string; arguments: string },
  emit: (event: ProviderEvent) => void,
): Promise<void> {
  const dispatch = beginDispatch(session, "command", input.prompt.clientMessageId);
  try {
    // DSH records command/run and command/done; the projector renders both.
    const result = await session.bridge.request("session.command", {
      sessionId: session.nativeId,
      name: command.name,
      arguments: command.arguments,
    });
    if (result.running || dispatch.sawRunning) {
      // The command woke the agent (/goal, /plan): report it as this prompt's turn;
      // finishing the turn refreshes the command list.
      acceptTurn(session, input, dispatch, `dsh-command-${input.prompt.clientMessageId}`, emit);
      return;
    }
    emitPromptResult(input, { type: "completed" }, emit);
  } catch (error) {
    emitPromptFailure(input, errorMessage(error), emit);
    return;
  } finally {
    session.dispatch = null;
  }
  await refreshCommands(session, emit);
}

export function beginDispatch(session: SessionState, kind: Dispatch["kind"], clientMessageId: string): Dispatch {
  session.dispatch = { kind, clientMessageId, sawRunning: false, deferred: null };
  return session.dispatch;
}

/** Report the dispatch as a Paseo turn, settling a terminal DSH sent before the RPC returned. */
export function acceptTurn(
  session: SessionState,
  input: Extract<ProviderInput, { type: "session.prompt" }>,
  dispatch: Dispatch,
  turnId: string,
  emit: (event: ProviderEvent) => void,
): void {
  emitPromptResult(input, { type: "turn", turnId }, emit);
  startTurn(session, turnId, emit);
  if (dispatch.deferred) finishTurn(session, dispatch.deferred, emit);
}


export async function interruptSession(
  input: Extract<ProviderInput, { type: "session.interrupt" }>,
  state: DispatchState,
): Promise<void> {
  const session = requireSession(state.sessions, input.sessionId);
  session.cancelRequested = true;
  await session.bridge.request("session.cancel", { sessionId: session.nativeId });
  state.emit({ type: "request.completed", requestId: input.requestId });
}

export async function configureSession(
  input: Extract<ProviderInput, { type: "session.configure" }>,
  state: DispatchState,
): Promise<void> {
  const session = requireSession(state.sessions, input.sessionId);
  if (session.activeTurnId || session.dispatch) {
    state.emit({
      type: "request.failed",
      requestId: input.requestId,
      error: { message: "Wait for the active DSH turn before changing configuration" },
    });
    return;
  }
  validateSettings(input.changes.settings ?? {});
  const source = session.bridge.initialized.catalog;
  const currentModel = modelId(source, session.open.model) ?? session.config.model;
  const currentMode = session.open.preset ?? session.config.mode;
  const currentThinking = session.open.model?.reasoningEffort ?? session.config.thinkingOption;
  const next: ProviderSessionConfig = {
    ...session.config,
    model: nullableChange(input.changes.model, currentModel),
    mode: nullableChange(input.changes.mode, currentMode),
    thinkingOption: nullableChange(input.changes.thinkingOption, currentThinking),
    settings: input.changes.settings
      ? { ...session.config.settings, ...input.changes.settings }
      : session.config.settings,
  };
  const modelChanged =
    input.changes.model !== undefined || input.changes.thinkingOption !== undefined;
  const selection = modelChanged
    ? selectModel(source, next.model, next.thinkingOption)
    : undefined;
  const preset = input.changes.mode === null
    ? source.defaultPreset
    : input.changes.mode;
  const permissionPreset = selectedPermissionPreset(
    input.changes.settings ?? {},
    source,
  );
  const planMode = input.changes.settings?.[PLAN_MODE_SETTING];
  if (typeof planMode === "boolean" && planMode !== session.planMode) {
    await setPlanMode(session, planMode);
  }
  const configured = await session.bridge.request("session.configure", {
    sessionId: session.nativeId,
    ...(selection ? { model: selection } : {}),
    ...(preset ? { preset } : {}),
    ...(permissionPreset ? { permissionPreset } : {}),
  });
  session.config = next;
  session.open = {
    ...session.open,
    model: configured.model,
    preset: configured.preset,
    permissionPreset: configured.permissionPreset,
  };
  emitConfig(session, state.emit);
  state.emit({ type: "request.completed", requestId: input.requestId });
}

export async function respondToPermission(
  input: Extract<ProviderInput, { type: "session.permission" }>,
  state: DispatchState,
): Promise<void> {
  const session = requireSession(state.sessions, input.sessionId);
  const interaction = session.pendingInteractions.get(input.permissionId);
  if (!interaction) throw new Error(`Unknown DSH interaction: ${input.permissionId}`);
  const params = interaction.kind === "questions" && input.response.behavior === "allow"
    ? { requestId: input.permissionId, answers: questionAnswers(interaction.questions ?? [], input.response) }
    : {
        requestId: input.permissionId,
        outcome: input.response.behavior === "allow" ? "allowed-once" as const : "rejected" as const,
      };
  await session.bridge.request("interaction.respond", params);
  if (session.pendingInteractions.delete(input.permissionId)) {
    state.emit({
      type: "session.permission_resolved",
      sessionId: session.paseoId,
      permissionId: input.permissionId,
    });
  }
}

export async function canStopRuntime(
  input: Extract<ProviderInput, { type: "session.can_stop_runtime" }>,
  state: DispatchState,
): Promise<void> {
  const session = requireSession(state.sessions, input.sessionId);
  if (!isProviderSessionIdle(session)) {
    state.emit({
      type: "session.can_stop_runtime",
      requestId: input.requestId,
      sessionId: input.sessionId,
      canStop: false,
    });
    return;
  }
  const revision = session.activityRevision;
  const result = await session.bridge.request(
    "session.can_stop_runtime",
    { sessionId: session.nativeId },
    RUNTIME_SAFETY_TIMEOUT_MS,
  );
  if (typeof result?.canStop !== "boolean") {
    throw new Error("Invalid DSH runtime safety response");
  }
  const canStop =
    result.canStop &&
    state.sessions.get(input.sessionId) === session &&
    session.activityRevision === revision &&
    isProviderSessionIdle(session);
  state.emit({
    type: "session.can_stop_runtime",
    requestId: input.requestId,
    sessionId: input.sessionId,
    canStop,
  });
}

export function isProviderSessionIdle(session: SessionState): boolean {
  return (
    session.ready &&
    !session.closed &&
    session.config.persist &&
    !session.activeTurnId &&
    !session.dispatch &&
    session.pendingInteractions.size === 0 &&
    session.pendingOperations === 0
  );
}

export async function closeSession(
  input: Extract<ProviderInput, { type: "session.close" }>,
  state: DispatchState,
): Promise<void> {
  const session = requireSession(state.sessions, input.sessionId);
  for (const permissionId of session.pendingInteractions.keys()) {
    state.emit({ type: "session.permission_resolved", sessionId: session.paseoId, permissionId });
  }
  session.pendingInteractions.clear();
  session.closed = true;
  session.releaseBridgeListeners.forEach((release) => release());
  try {
    await session.bridge.request("session.close", { sessionId: session.nativeId });
  } finally {
    try {
      await session.bridge.close();
    } finally {
      state.sessions.delete(input.sessionId);
      if (session.activeTurnId) finishTurn(session, { state: "canceled" }, state.emit);
      state.emit({ type: "session.closed", sessionId: input.sessionId });
    }
  }
  state.emit({ type: "request.completed", requestId: input.requestId });
}

export function validateAdmission(
  input: ProviderInput,
  sessions: Map<string, SessionState>,
  capabilities: readonly string[],
): void {
  requireProviderCapabilities(capabilities, input);
  if (input.type === "session.open") {
    if (sessions.has(input.sessionId)) throw new Error(`Session already exists: ${input.sessionId}`);
    return;
  }
  if (input.type === "session.can_stop_runtime") return;
  if ("sessionId" in input && !sessions.has(input.sessionId)) {
    throw new Error(`Unknown session: ${input.sessionId}`);
  }
}

export function validateSessionConfig(config: ProviderSessionConfig): void {
  validateSettings(config.settings);
  const unsupported: string[] = [];
  if (config.providerOptions && Object.keys(config.providerOptions).length > 0) {
    unsupported.push("providerOptions");
  }
  if (unsupported.length > 0) {
    throw new Error(`DSH does not support session config: ${unsupported.join(", ")}`);
  }
}

export const MCP_SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/u;

/** Map Paseo MCP servers to dsh-mcp-client entries. */
export function bridgeMcpServers(servers: ProviderSessionConfig["mcpServers"]): BridgeMcpServer[] {
  return Object.entries(servers).map(([name, server]): BridgeMcpServer => {
    if (!MCP_SERVER_NAME.test(name)) {
      throw new Error(`DSH MCP server names must match ${String(MCP_SERVER_NAME)}: ${name}`);
    }
    if (server.type === "sse") {
      throw new Error(`DSH supports stdio and streamable HTTP MCP servers, not SSE: ${name}`);
    }
    return server.type === "stdio"
      ? {
          serverName: name,
          transport: "stdio",
          command: server.command,
          ...(server.args ? { args: server.args } : {}),
          ...(server.env ? { env: server.env } : {}),
        }
      : {
          serverName: name,
          transport: "streamable-http",
          url: server.url,
          ...(server.headers ? { headers: server.headers } : {}),
        };
  });
}

/** DSH names MCP tools `mcp__<server>__<tool>`. */
export function preapprovedTools(config: ProviderSessionConfig): string[] {
  return (config.toolPolicy?.preapproved ?? []).map((grant) => {
    if (!Object.hasOwn(config.mcpServers, grant.server)) {
      throw new Error(`Tool policy names MCP server '${grant.server}' that is not configured`);
    }
    return `mcp__${grant.server}__${grant.tool}`;
  });
}
