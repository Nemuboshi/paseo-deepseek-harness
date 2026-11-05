import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { detectDshVersion } from "./dsh-version.js";
import {
  DEFAULT_PROFILE,
  MAX_STDERR,
  assertBridgeHandshake,
  assertSurfaceRowsPresent,
  createBridgePatch,
  ensureDshProfile,
} from "./dsh-profile.js";
import { describeDshLaunch, resolveDshLaunch, spawnDsh, type DshLaunch } from "./dsh-spawn.js";
import type { ProviderLaunch } from "@getpaseo/plugin/server/provider";
import type {
  BridgeInitializeResult,
  BridgeMethods,
  BridgeNotifications,
  RpcNotification,
  RpcResponse,
} from "../shared/bridge-protocol.js";

type Method = keyof BridgeMethods;
type Notification = keyof BridgeNotifications;

/**
 * Default deadline for one bridge request. `session.list` title folds decode a
 * whole session log per row, so callers list large histories with a wider
 * deadline instead of raising this for every method.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** Deadline for listing sessions: a cold title fold costs seconds per hundred sessions. */
export const LIST_SESSIONS_TIMEOUT_MS = 120_000;

export interface DshBridge {
  readonly initialized: BridgeInitializeResult;
  /** The resolved `dsh` executable this bridge was launched with (see `resolveDshLaunch`). */
  readonly executable: string;
  /** Arguments that precede dsh's own arguments, from Paseo's resolved `command`. */
  readonly args?: readonly string[];
  request<Name extends Method>(
    method: Name,
    params: BridgeMethods[Name]["params"],
    timeoutMs?: number,
  ): Promise<BridgeMethods[Name]["result"]>;
  on<Name extends Notification>(
    method: Name,
    listener: (params: BridgeNotifications[Name]) => void,
  ): () => void;
  onFailure(listener: (error: Error) => void): () => void;
  close(): Promise<void>;
}

/** An MCP server mounted through `@deepseek-ai/dsh-mcp-client` for one bridge process. */
export type BridgeMcpServer =
  | {
      serverName: string;
      transport: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
    }
  | {
      serverName: string;
      transport: "streamable-http";
      url: string;
      headers?: Record<string, string>;
    };

/** Per-session launch choices; each Paseo session owns its bridge process. */
export interface SessionLaunch {
  env?: Readonly<Record<string, string>>;
  /** Store sessions under the bridge's temporary directory, removed on close. */
  ephemeral?: boolean;
  mcpServers?: readonly BridgeMcpServer[];
  /** The `launch` Paseo resolved for the provider connection: command, leading arguments and the complete daemon environment. */
  providerLaunch?: ProviderLaunch;
}

export interface LaunchBridgeOptions extends SessionLaunch {
  /** The configured executable (`PASEO_DSH_EXECUTABLE`, else the plugin setting); it takes precedence over `providerLaunch.command`. */
  executable?: string;
  profile?: string;
  bridgeSource: string;
  startupTimeoutMs?: number;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
}

export async function launchDshBridge(options: LaunchBridgeOptions): Promise<DshBridge> {
  const profile = options.profile?.trim() || DEFAULT_PROFILE;
  const launch = resolveDshLaunch(options.executable, options.providerLaunch);
  const env = { ...(options.providerLaunch?.env ?? process.env), ...options.env };
  await ensureDshProfile({ executable: launch.command, args: launch.args, profile, env });
  await assertSurfaceRowsPresent({
    launch,
    profile,
    env,
    dshVersionOf: (target) => detectDshVersion(target.command, { args: target.args, env }),
  });
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-deepseek-harness-"));
  const bridgePath = path.join(directory, "dsh-bridge.mjs");
  const patchPath = path.join(directory, "patch.json");
  await writeFile(bridgePath, options.bridgeSource, { mode: 0o600 });
  await writeFile(
    patchPath,
    JSON.stringify(
      createBridgePatch({
        profile,
        bridgePath,
        sessionsRoot: options.ephemeral ? path.join(directory, "sessions") : undefined,
        mcpServers: options.mcpServers,
      }),
    ),
    { mode: 0o600 },
  );

  const child = spawnDsh(launch.command, [...launch.args, "--profile", profile, "--patch", patchPath], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const client = new JsonlBridgeClient(child, directory, launch);
  try {
    await client.waitUntilReady(options.startupTimeoutMs ?? 15_000);
    client.initialized = await client.request("bridge.initialize", {});
    if (client.initialized.protocolVersion !== 1 || (client.initialized.missing?.length ?? 0) > 0) {
      const version = await detectDshVersion(launch.command, { args: launch.args, env }).catch(() => "");
      assertBridgeHandshake(client.initialized, version);
    }
    return client;
  } catch (error) {
    await client.close();
    throw error;
  }
}

/**
 * Parse one stdout line from the bridge process. `undefined` means the line is
 * not a protocol message: dsh also writes its own logs to stdout (for example
 * the model-catalog line the deepseek-account provider emits), and such a line
 * must not fail the bridge.
 */
export function parseBridgeLine(line: string): RpcResponse | RpcNotification | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as RpcResponse | RpcNotification)
    : undefined;
}

class JsonlBridgeClient implements DshBridge {
  initialized!: BridgeInitializeResult;
  readonly executable: string;
  readonly args: readonly string[];
  private nextId = 1;
  private readonly pending = new Map<string | number, PendingRequest>();
  private readonly notifications = new Map<string, Set<(params: never) => void>>();
  private readonly failures = new Set<(error: Error) => void>();
  private ready = false;
  private terminalError: Error | null = null;
  private stderr = "";
  private closing = false;
  private closePromise: Promise<void> | null = null;
  private readonly exited: Promise<void>;
  private resolveExited!: () => void;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly temporaryDirectory: string,
    launch: DshLaunch,
  ) {
    this.executable = launch.command;
    this.args = launch.args;
    this.exited = new Promise((resolve) => {
      this.resolveExited = resolve;
    });
    createInterface({ input: child.stdout }).on("line", (line) => this.acceptLine(line));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-MAX_STDERR);
    });
    child.once("error", (error) => {
      this.fail(error);
      this.resolveExited();
    });
    child.once("exit", (code, signal) => {
      const suffix = this.stderr.trim() ? `: ${this.stderr.trim()}` : "";
      this.fail(
        new Error(
          `DSH bridge exited ${signal ? `from ${signal}` : `with code ${String(code)}`}${suffix}`,
        ),
      );
      this.resolveExited();
    });
    child.once("close", () => this.resolveExited());
  }

  async waitUntilReady(timeoutMs: number): Promise<void> {
    if (this.ready) return;
    if (this.terminalError) throw this.terminalError;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        releaseReady();
        releaseFailure();
        reject(new Error(`DSH bridge did not become ready within ${timeoutMs}ms`));
      }, timeoutMs);
      const releaseReady = this.on("bridge.ready", () => {
        clearTimeout(timeout);
        releaseReady();
        releaseFailure();
        resolve();
      });
      const releaseFailure = this.onFailure((error) => {
        clearTimeout(timeout);
        releaseReady();
        releaseFailure();
        reject(error);
      });
    });
  }

  request<Name extends Method>(
    method: Name,
    params: BridgeMethods[Name]["params"],
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<BridgeMethods[Name]["result"]> {
    if (this.terminalError) return Promise.reject(this.terminalError);
    if (this.closing && method !== "bridge.shutdown") {
      return Promise.reject(new Error("DSH bridge is closing"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`DSH bridge request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
      this.child.stdin.write(payload, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (pending) clearTimeout(pending.timeout);
        this.pending.delete(id);
        reject(error);
      });
    }) as Promise<BridgeMethods[Name]["result"]>;
  }

  on<Name extends Notification>(
    method: Name,
    listener: (params: BridgeNotifications[Name]) => void,
  ): () => void {
    const listeners = this.notifications.get(method) ?? new Set();
    listeners.add(listener as (params: never) => void);
    this.notifications.set(method, listeners);
    return () => listeners.delete(listener as (params: never) => void);
  }

  onFailure(listener: (error: Error) => void): () => void {
    this.failures.add(listener);
    if (this.terminalError) queueMicrotask(() => listener(this.terminalError!));
    return () => this.failures.delete(listener);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      if (!this.terminalError) {
        await Promise.race([
          this.request("bridge.shutdown", {}).catch(() => undefined),
          delay(500),
        ]);
      }
      if (this.child.exitCode === null && this.child.signalCode === null) {
        this.child.kill("SIGTERM");
        await Promise.race([this.exited, delay(1_000)]);
      }
      if (this.child.exitCode === null && this.child.signalCode === null) {
        this.child.kill("SIGKILL");
        await Promise.race([this.exited, delay(1_000)]);
      }
      await rm(this.temporaryDirectory, { recursive: true, force: true });
    })();
    return this.closePromise;
  }

  private acceptLine(line: string): void {
    if (!line.trim()) return;
    const message = parseBridgeLine(line);
    if (message === undefined) {
      // stdout carries the protocol, but dsh writes its own logs there too.
      // Forward the line to stderr and keep the bridge alive instead of
      // failing every provider snapshot on one log line.
      process.stderr.write(`[paseo-deepseek-harness] ignored dsh stdout: ${line.slice(0, 2000)}\n`);
      return;
    }
    if ("id" in message) {
      if (message.id === null) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if ("error" in message) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
      return;
    }
    if (message.method === "bridge.ready") this.ready = true;
    for (const listener of this.notifications.get(message.method) ?? []) {
      listener(message.params as never);
    }
  }

  private fail(error: Error): void {
    if (this.terminalError) return;
    this.terminalError = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    if (!this.closing) for (const listener of this.failures) listener(error);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
