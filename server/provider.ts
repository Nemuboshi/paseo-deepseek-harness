import { randomUUID } from "node:crypto";
import {
  negotiateProviderCapabilities,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderRegistration,
  type ProviderStatus,
} from "@getpaseo/plugin/server/provider";
import { slashLine } from "../shared/bridge-protocol.js";
import type { DshBridge, SessionLaunch } from "./bridge-client.js";
import { DEFAULT_PROFILE } from "./dsh-profile.js";
import { describeDshLaunch, resolveDshLaunch, type DshLaunch } from "./dsh-spawn.js";
import type { DshConfigured } from "./dsh-config.js";
import { detectDshVersion } from "./dsh-version.js";
import { PLUGIN_VERSION } from "./plugin-version.js";
import { displayText, toPromptParts } from "./prompt-content.js";
import {
  CAPABILITIES,
  failInput,
  type DetectVersion,
  type SessionState,
} from "./provider-support.js";
import { dispatch, validateAdmission } from "./provider-sessions.js";
import { TimelineProjector } from "./timeline.js";
import { classifyTurnEnd, type TurnTerminal } from "./turn-end.js";
import { objectValue } from "./values.js";
import { matchVersionLine, versionWarningMessage } from "./version-line.js";

interface DshProviderOptions {
  createBridge(launch?: SessionLaunch): Promise<DshBridge>;
  /** Share the daemon-resolved launch with settings RPCs targeting the same provider. */
  observeLaunch?(launch: SessionLaunch["providerLaunch"]): void;
  /**
   * The environment and settings-screen choices, read on every call so a changed
   * setting applies to new sessions. The executable outranks the `launch` Paseo
   * resolves; `status()`, the catalog cache key and `createBridge` use the same values.
   */
  configured?: () => Promise<DshConfigured> | DshConfigured;
  /** The command registered with Paseo; defaults to `dsh` (see `defaultDshCommand`). */
  command?: string;
  /** Detects the local dsh version for the startup compatibility check; defaults to spawning `<exe> --version`. */
  detectDshVersion?: DetectVersion;
}


export function createDshProvider(options: DshProviderOptions): ProviderRegistration {
  return {
    id: "dsh-pi",
    label: "DeepSeek Harness",
    description: "Direct connection to the local DeepSeek Harness (dsh)",
    icon: "dsh.svg",
    getCatalogCacheKey: async (request) => {
      options.observeLaunch?.(request.launch);
      const configured = (await options.configured?.()) ?? {};
      const launch = describeDshLaunch(resolveDshLaunch(configured.executable));
      const scope = request.scope === "workspace" ? request.cwd : "global";
      return JSON.stringify(["dsh-pi", scope, launch, configured.profile ?? DEFAULT_PROFILE]);
    },
    command: [options.command ?? "dsh"],
    async status(request) {
      options.observeLaunch?.(request?.launch);
      return dshStatus(
        resolveDshLaunch((await options.configured?.())?.executable),
        request?.launch?.env,
        options.detectDshVersion ?? detectDshVersion,
      );
    },
    async connect(request) {
      if (!request.versions.includes(1)) throw new Error("Provider protocol version 1 is required");
      const providerLaunch = request.launch;
      options.observeLaunch?.(providerLaunch);
      const createBridge = (launch?: SessionLaunch) =>
        options.createBridge(providerLaunch ? { ...launch, providerLaunch } : launch);
      const bridge = await createBridge();
      const supported = CAPABILITIES.filter(
        (capability) =>
          capability !== "permission" ||
          bridge.initialized.capabilities.approvals ||
          bridge.initialized.capabilities.questions,
      );
      return createConnection(
        bridge,
        createBridge,
        negotiateProviderCapabilities(request.capabilities, supported),
        options.detectDshVersion ?? detectDshVersion,
        providerLaunch?.env,
      );
    },
  };
}

/**
 * Availability of the local dsh for Paseo 0.11+ provider listings. A dsh that
 * does not answer `--version` is unavailable; a version outside the plugin's
 * major.minor line stays available with the same warning the session timeline
 * shows, since only DSH's own handshake can reject a session.
 */
async function dshStatus(
  launch: DshLaunch,
  env: Readonly<Record<string, string>> | undefined,
  detectVersion: DetectVersion,
): Promise<ProviderStatus> {
  const dshVersion = await detectVersion(launch.command, { args: launch.args, ...(env ? { env } : {}) }).catch(() => "");
  if (!dshVersion) {
    return {
      available: false,
      diagnostic:
        `Could not run "${describeDshLaunch(launch)} --version". Install dsh, ` +
        `set the executable in the DeepSeek Harness plugin settings, set PASEO_DSH_EXECUTABLE, ` +
        `then restart the Paseo daemon.`,
    };
  }
  const match = matchVersionLine(PLUGIN_VERSION, dshVersion);
  if (match === "match") return { available: true };
  return { available: true, diagnostic: versionWarningMessage(match, PLUGIN_VERSION, dshVersion) };
}

function createConnection(
  discoveryBridge: DshBridge,
  createBridge: (launch?: SessionLaunch) => Promise<DshBridge>,
  capabilities: readonly string[],
  detectVersion: DetectVersion,
  launchEnv: Readonly<Record<string, string>> | undefined,
): ProviderConnection {
  const listeners = new Set<(event: ProviderEvent) => void>();
  const sessions = new Map<string, SessionState>();
  const pendingOpens = new Set<Promise<void>>();
  const openingBridges = new Set<DshBridge>();
  const bridgeClosures = new WeakMap<DshBridge, Promise<void>>();
  const cleanupErrors: unknown[] = [];
  let closed = false;
  let closePromise: Promise<void> | undefined;
  const closeBridge = (bridge: DshBridge): Promise<void> => {
    let closing = bridgeClosures.get(bridge);
    if (!closing) {
      closing = Promise.resolve().then(() => bridge.close()).catch((error) => {
        cleanupErrors.push(error);
        throw error;
      });
      bridgeClosures.set(bridge, closing);
    }
    return closing;
  };
  const emit = (event: ProviderEvent) => {
    if (closed) return;
    for (const listener of listeners) listener(event);
  };

  return {
    version: 1,
    capabilities,
    async send(input) {
      if (closed) throw new Error("Provider connection is closed");
      validateAdmission(input, sessions, capabilities);
      const operationSession = input.type !== "session.can_stop_runtime" && "sessionId" in input
        ? sessions.get(input.sessionId)
        : undefined;
      if (operationSession) {
        operationSession.pendingOperations += 1;
        operationSession.activityRevision += 1;
      }
      const pending = Promise.resolve().then(async () => {
        if (closed) return;
        await dispatch(input, {
          discoveryBridge, createBridge, sessions, emit, capabilities, detectVersion, launchEnv,
          openingBridges, closeBridge, isClosed: () => closed,
        });
      }).catch((error) => failInput(input, error, emit)).finally(() => {
        if (operationSession) operationSession.pendingOperations -= 1;
      });
      if (input.type === "session.open") {
        pendingOpens.add(pending);
        void pending.then(() => pendingOpens.delete(pending));
      }
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      if (closePromise) return closePromise;
      closed = true;
      const bridges = new Set([discoveryBridge, ...openingBridges]);
      for (const session of sessions.values()) {
        session.closed = true;
        session.releaseBridgeListeners.forEach((release) => release());
        bridges.add(session.bridge);
      }
      sessions.clear();
      listeners.clear();
      closePromise = (async () => {
        await Promise.allSettled([
          ...Array.from(bridges, closeBridge),
          ...pendingOpens,
        ]);
        if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "Could not close DSH bridges");
      })();
      return closePromise;
    },
  };
}
