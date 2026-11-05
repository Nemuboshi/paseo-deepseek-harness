import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path, { dirname, join, resolve } from "node:path";
import type { BridgeInitializeResult } from "../shared/bridge-protocol.js";
import type { BridgeMcpServer } from "./bridge-client.js";
import { spawnDsh, type DshLaunch } from "./dsh-spawn.js";

export const MAX_STDERR = 16_384;

/** The profile the plugin launches unless `PASEO_DSH_PROFILE` or the plugin setting names another one. */
export const DEFAULT_PROFILE = "paseo";
/** The official DSH profile template the default profile is created from. */
export const DEFAULT_PROFILE_TEMPLATE = "web";
/**
 * Rows of the web template that serve a browser-facing surface. The bridge is
 * this profile's surface, so the launcher disables them in every bridge patch.
 * `api-remotes` forwards `approval/request` and `user-questions/request` to
 * browser clients ahead of the bridge; with no browser attached those requests
 * would wait forever, so it is disabled with the rest.
 */
export const DISABLED_SURFACE_ROWS = ["web-startup", "webserver", "web-runtime", "connection", "api-remotes"] as const;

/** The DSH home, resolved the same way as `@deepseek-ai/dsh-home-paths`. */
export function resolveDshHome(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const configured = env.DSH_HOME;
  const home = configured !== undefined && configured.trim().length > 0 ? configured : path.join(homedir(), ".dsh");
  if (home === "~") return homedir();
  if (home.startsWith("~/") || home.startsWith("~\\")) return path.resolve(homedir(), home.slice(2));
  return path.resolve(home);
}

/** The bridge patch: surface rows disabled, session overrides, then the bridge itself. */
export function createBridgePatch(options: {
  profile: string;
  bridgePath: string;
  sessionsRoot?: string;
  mcpServers?: readonly BridgeMcpServer[];
}): unknown[] {
  return [
    ...DISABLED_SURFACE_ROWS.map((id) => ({ id, disabled: true })),
    ...(options.sessionsRoot
      ? [{ id: "session-persistence-jsonl", config: { root: options.sessionsRoot } }]
      : []),
    {
      insert: [
        ...(options.mcpServers ?? []).map((server) => ({
          id: `paseo-mcp-${server.serverName}`,
          name: "@deepseek-ai/dsh-mcp-client",
          config: server,
        })),
        { id: "paseo-dsh-bridge", name: options.bridgePath, config: { profile: options.profile } },
      ],
    },
  ];
}

/**
 * Make sure the profile directory exists before DSH is started with it. The
 * default profile is created once from the official web template; a missing
 * profile chosen through `PASEO_DSH_PROFILE` is reported instead.
 */
export async function ensureDshProfile(options: {
  executable: string;
  args?: readonly string[];
  profile: string;
  env: Readonly<Record<string, string | undefined>>;
  timeoutMs?: number;
}): Promise<void> {
  const directory = path.join(resolveDshHome(options.env), "profiles", options.profile);
  if (await isDirectory(directory)) return;
  if (options.profile !== DEFAULT_PROFILE) {
    throw new Error(
      `DSH profile "${options.profile}" does not exist at ${directory}. ` +
        `Create it with \`dsh --profile ${options.profile} --from-default-profile ${DEFAULT_PROFILE_TEMPLATE} --dump-config\`, ` +
        `or clear the profile in the DeepSeek Harness plugin settings and unset PASEO_DSH_PROFILE to use the "${DEFAULT_PROFILE}" profile.`,
    );
  }
  // Concurrent first launches share one creation run.
  let creation = profileCreations.get(directory);
  if (!creation) {
    creation = runProfileInit(
      options.executable,
      options.args ?? [],
      options.profile,
      options.env,
      options.timeoutMs ?? 60_000,
    ).finally(
      () => profileCreations.delete(directory),
    );
    profileCreations.set(directory, creation);
  }
  await creation;
  if (!(await isDirectory(directory))) {
    throw new Error(`DSH did not create the "${options.profile}" profile at ${directory}`);
  }
}

const profileCreations = new Map<string, Promise<void>>();

async function isDirectory(directory: string): Promise<boolean> {
  try {
    return (await stat(directory)).isDirectory();
  } catch {
    return false;
  }
}

function runProfileInit(
  executable: string,
  leadingArgs: readonly string[],
  profile: string,
  env: Readonly<Record<string, string | undefined>>,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawnDsh(
      executable,
      [...leadingArgs, "--profile", profile, "--from-default-profile", DEFAULT_PROFILE_TEMPLATE, "--dump-config"],
      { env, stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-MAX_STDERR);
    });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Creating the DSH "${profile}" profile timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `Creating the DSH "${profile}" profile failed ${signal ? `from ${signal}` : `with code ${String(code)}`}` +
              (stderr.trim() ? `: ${stderr.trim()}` : ""),
          ),
        );
    });
  });
}


export function dumpedRowIds(dump: string): Set<string> {
  const ids = new Set<string>();
  for (const match of dump.matchAll(/(?:^|[\s{,\-])["']?id["']?\s*:\s*["']?([A-Za-z0-9_.@/-]+)["']?/gm)) {
    ids.add(match[1]!);
  }
  return ids;
}

/** The surface rows the launcher disables that the dumped configuration does not contain. */
export function missingSurfaceRows(dump: string): string[] {
  const present = dumpedRowIds(dump);
  return DISABLED_SURFACE_ROWS.filter((row) => !present.has(row));
}

/**
 * Fail loudly when the profile no longer has a row the launcher disables.
 * Disabling an absent row has no effect, so a renamed row would leave the
 * browser surface running beside the bridge. Returns normally when the dump
 * cannot be obtained or is empty: the guard has no evidence then, and the real
 * launch reports its own errors.
 */
export async function assertSurfaceRowsPresent(options: {
  launch: DshLaunch;
  profile: string;
  env: Readonly<Record<string, string | undefined>>;
  dshVersionOf: (launch: DshLaunch) => Promise<string>;
  dump?: (launch: DshLaunch, profile: string, env: Readonly<Record<string, string | undefined>>) => Promise<string>;
}): Promise<void> {
  const dump = await (options.dump ?? dumpProfileConfig)(options.launch, options.profile, options.env).catch(() => "");
  if (!dump.trim()) return;
  const missing = missingSurfaceRows(dump);
  if (missing.length === 0) return;
  const version = (await options.dshVersionOf(options.launch).catch(() => "")) || "unknown";
  throw new Error(
    `DSH ${version} profile "${options.profile}" has no ${missing.map((row) => `"${row}"`).join(", ")} row. ` +
      `The plugin disables ${DISABLED_SURFACE_ROWS.join(", ")} to keep the web surface from running beside the bridge, ` +
      `so this dsh does not match the plugin. Install the dsh line this plugin release supports, ` +
      `or recreate the profile from the web template.`,
  );
}

/** `dsh --profile <profile> --dump-config` stdout; rejects when dsh fails or exceeds the timeout. */
function dumpProfileConfig(
  launch: DshLaunch,
  profile: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawnDsh(launch.command, [...launch.args, "--profile", profile, "--dump-config"], {
      env,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = (stdout + chunk).slice(-1_048_576);
    });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("dsh --dump-config timed out"));
    }, 20_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve(stdout);
      else reject(new Error(`dsh --dump-config exited with code ${String(code)}`));
    });
  });
}

/** Names of host services or methods the bridge needs that the handshake reported missing. */
export function assertBridgeHandshake(initialized: BridgeInitializeResult, dshVersion: string): void {
  if (initialized.protocolVersion !== 1) {
    throw new Error(`Unsupported DSH bridge protocol ${initialized.protocolVersion}`);
  }
  const missing = initialized.missing ?? [];
  if (missing.length === 0) return;
  throw new Error(
    `DSH ${dshVersion || "unknown"} does not provide what the bridge depends on: ${missing.join(", ")}. ` +
      `This dsh does not match the plugin; install the dsh line this plugin release supports.`,
  );
}

