import { randomUUID } from "node:crypto";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import type { DshSessionEvent } from "../shared/bridge-protocol.js";
import { emitCommands } from "./provider-commands.js";
import { emitConfig } from "./provider-config.js";
import {
  finishTurn,
  startTurn,
  type SessionState,
} from "./provider-support.js";
import { permissionRequest } from "./provider-interaction.js";
import { classifyTurnEnd, type TurnTerminal } from "./turn-end.js";

export function listenToSessionBridge(
  session: SessionState,
  emit: (event: ProviderEvent) => void,
): Array<() => void> {
  const isCurrentSession = (nativeId: string) =>
    !session.closed && nativeId === session.nativeId;

  return [
    session.bridge.on("session.event", ({ sessionId, event }) => {
      if (!isCurrentSession(sessionId)) return;
      session.activityRevision += 1;
      // The prompt path emits its own bubble with the clientMessageId.
      if (event.type === "user/message" && session.dispatch?.kind === "prompt") return;
      if (event.type === "turn/start") {
        // A turn nobody dispatched from Paseo: a /goal continuation or a queued
        // follow-up that DSH drains without going idle.
        if (!session.activeTurnId && !session.dispatch) {
          startTurn(session, `dsh-auto-${randomUUID()}`, emit);
        }
        return;
      }
      if (event.type === "turn/end") {
        const terminal = classifyTurnEnd(event.data);
        // Failures reach Paseo through session.turn; other abnormal ends become notices.
        if (terminal.state !== "failed") {
          for (const projected of session.projector.projectEvent(event)) emit(projected);
        }
        // DSH can finish before the prompt or command RPC returns.
        if (!session.activeTurnId && session.dispatch) session.dispatch.deferred = terminal;
        else finishTurn(session, terminal, emit);
        return;
      }
      if (event.type === "plan/mode" && typeof event.data.active === "boolean") {
        if (session.planMode !== event.data.active) {
          session.planMode = event.data.active;
          emitConfig(session, emit);
        }
      }
      if (event.type === "permission/preset" && typeof event.data.preset === "string") {
        // Covers /permission and any other DSH-side preset change.
        if (session.open.permissionPreset !== event.data.preset) {
          session.open = { ...session.open, permissionPreset: event.data.preset };
          emitConfig(session, emit);
        }
      }
      const clientMessageId =
        event.type === "command/run" && session.dispatch?.kind === "command"
          ? session.dispatch.clientMessageId
          : undefined;
      for (const projected of session.projector.projectEvent(event, { clientMessageId })) {
        emit(projected);
      }
    }),
    session.bridge.on("session.stream", ({ sessionId, frame }) => {
      if (!isCurrentSession(sessionId)) return;
      session.activityRevision += 1;
      for (const projected of session.projector.projectStream(frame)) emit(projected);
    }),
    session.bridge.on("session.status", ({ sessionId, status }) => {
      if (!isCurrentSession(sessionId)) return;
      session.activityRevision += 1;
      if (status === "running") {
        if (session.dispatch) session.dispatch.sawRunning = true;
        return;
      }
      const terminal: TurnTerminal = { state: session.cancelRequested ? "canceled" : "completed" };
      if (session.activeTurnId) finishTurn(session, terminal, emit);
      else if (session.dispatch?.sawRunning && !session.dispatch.deferred) {
        session.dispatch.deferred = terminal;
      }
    }),
    session.bridge.on("session.usage", ({ sessionId, usage }) => {
      if (!isCurrentSession(sessionId)) return;
      session.activityRevision += 1;
      emit({
        type: "session.usage",
        sessionId: session.paseoId,
        ...(session.activeTurnId ? { turnId: session.activeTurnId } : {}),
        usage,
      });
    }),
    session.bridge.on("interaction.request", (interaction) => {
      if (!isCurrentSession(interaction.sessionId)) return;
      session.activityRevision += 1;
      session.pendingInteractions.set(interaction.requestId, interaction);
      emit({
        type: "session.permission",
        sessionId: session.paseoId,
        request: permissionRequest(interaction),
      });
    }),
    session.bridge.on("interaction.closed", ({ requestId, sessionId }) => {
      if (!isCurrentSession(sessionId) || !session.pendingInteractions.delete(requestId)) return;
      session.activityRevision += 1;
      emit({
        type: "session.permission_resolved",
        sessionId: session.paseoId,
        permissionId: requestId,
      });
    }),
    session.bridge.onFailure((error) => failSession(session, error, emit)),
  ];
}

export function failSession(
  session: SessionState,
  error: Error,
  emit: (event: ProviderEvent) => void,
): void {
  if (session.closed) return;
  session.closed = true;
  session.releaseBridgeListeners.forEach((release) => release());
  for (const permissionId of session.pendingInteractions.keys()) {
    emit({ type: "session.permission_resolved", sessionId: session.paseoId, permissionId });
  }
  session.pendingInteractions.clear();
  for (const projected of session.projector.failRunningTools(error.message)) emit(projected);
  if (session.activeTurnId) {
    emit({
      type: "session.turn",
      sessionId: session.paseoId,
      turnId: session.activeTurnId,
      state: "failed",
      error: { message: error.message },
    });
    session.activeTurnId = null;
  }
  emit({
    type: "session.runtime_failed",
    sessionId: session.paseoId,
    error: { message: error.message },
  });
  void session.bridge.close().catch(() => undefined);
}
