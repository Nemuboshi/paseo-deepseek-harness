import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import type { SlashCommand } from "../shared/bridge-protocol.js";
import type { DshBridge } from "./bridge-client.js";
import { emitConfig, hasPlanCommand } from "./provider-config.js";
import type { SessionState } from "./provider-support.js";

export async function fetchCommands(bridge: DshBridge, sessionId: string): Promise<SlashCommand[]> {
  try {
    const { commands } = await bridge.request("session.commands", { sessionId });
    return Array.isArray(commands) ? commands : [];
  } catch {
    return [];
  }
}

export async function refreshCommands(
  session: SessionState,
  emit: (event: ProviderEvent) => void,
): Promise<void> {
  const commands = await fetchCommands(session.bridge, session.nativeId);
  if (session.closed || JSON.stringify(commands) === JSON.stringify(session.commands)) return;
  const hadPlan = hasPlanCommand(session);
  session.commands = commands;
  if (hadPlan !== hasPlanCommand(session)) emitConfig(session, emit);
  emitCommands(session, emit);
}

export function emitCommands(session: SessionState, emit: (event: ProviderEvent) => void): void {
  emit({
    type: "session.commands",
    sessionId: session.paseoId,
    commands: session.commands.map((command) => ({
      name: command.name,
      description: command.description,
      ...(command.argumentHint ? { argumentHint: command.argumentHint } : {}),
    })),
  });
}

