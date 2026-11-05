import { useSyncExternalStore } from "react";
import { getPaseoClient } from "@getpaseo/plugin/client";
import type { PluginClientContext } from "@getpaseo/plugin/client";

/** One subagent run as the pill shows it. */
interface Run {
  description?: string;
  running: boolean;
}

/**
 * Paseo registers a composer pill for one agent, so the plugin needs an agent id
 * and a workspace id at registration time. The timeline card is the first place
 * the client knows both, so it owns the bootstrap.
 */
let pluginClient: PluginClientContext | undefined;
const booted = new Set<string>();
const stores = new Map<string, Store>();

export function setPillClient(client: PluginClientContext): void {
  pluginClient = client;
}

class Store {
  private readonly runs = new Map<string, Run>();
  private readonly listeners = new Set<() => void>();
  private snapshot: readonly Run[] = [];

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  get = (): readonly Run[] => this.snapshot;

  /** Records one card state and republishes when the visible set changes. */
  put(id: string, run: Run): void {
    const previous = this.runs.get(id);
    if (previous && previous.running === run.running && previous.description === run.description) return;
    this.runs.set(id, run);
    this.snapshot = Object.freeze([...this.runs.values()].filter((item) => item.running));
    for (const listener of [...this.listeners]) listener();
  }
}

function store(agentId: string): Store {
  let value = stores.get(agentId);
  if (!value) {
    value = new Store();
    stores.set(agentId, value);
  }
  return value;
}

function pillText(runs: readonly Run[]): string {
  const count = runs.length;
  return count === 1 ? "1 subagent" : `${count} subagents`;
}

/** Every plugin subagent card in an event, whatever wrapper the host uses. */
function findCards(value: unknown, depth = 0): Array<{ id: string; data: Record<string, unknown> }> {
  if (depth > 4 || typeof value !== "object" || value === null) return [];
  const found: Array<{ id: string; data: Record<string, unknown> }> = [];
  const record = value as Record<string, unknown>;
  if (
    record["type"] === "plugin" &&
    record["kind"] === "subagent-run" &&
    typeof record["id"] === "string" &&
    typeof record["data"] === "object" &&
    record["data"] !== null
  ) {
    found.push({ id: record["id"], data: record["data"] as Record<string, unknown> });
  }
  for (const entry of Object.values(record)) {
    if (typeof entry === "object" && entry !== null) found.push(...findCards(entry, depth + 1));
  }
  return found;
}

function PillContent({ agentId }: { agentId: string }) {
  const runs = useSyncExternalStore(store(agentId).subscribe, store(agentId).get);
  if (runs.length === 0) return null;
  return (
    <>
      {runs.map((run, index) => (
        <div key={index} style={{ padding: "4px 8px" }}>
          {run.description ?? "Subagent"}
        </div>
      ))}
    </>
  );
}

/**
 * Registers the composer pill once per agent, then keeps its label on the running
 * subagent count. A failure stays silent: a status pill must never break a turn.
 */
export function useSubagentPill(agentId: string, hostId: string): void {
  const key = `${hostId}:${agentId}`;
  if (booted.has(key) || !pluginClient) return;
  booted.add(key);
  void boot(pluginClient, agentId, hostId).catch(() => booted.delete(key));
}

async function boot(client: PluginClientContext, agentId: string, hostId: string): Promise<void> {
  const paseo = getPaseoClient(hostId);
  const handle = paseo.agents.ref(agentId);
  const snapshot = handle.current() ?? (await handle.refresh())?.agent ?? null;
  const workspaceId = snapshot?.workspaceId ?? handle.workspaceId;
  if (!workspaceId) return;

  const runs = store(agentId);
  const registration = client.addComposerPill({
    id: "subagent-runs",
    workspaceId,
    agentId,
    button: {
      title: "Subagents",
      icon: "Bot",
      visible: false,
      behavior: { kind: "popover", Content: () => <PillContent agentId={agentId} /> },
    },
  });

  const publish = (): void => {
    const running = runs.get();
    registration.update({
      title: pillText(running),
      visible: running.length > 0,
    });
  };
  runs.subscribe(publish);

  const subscription = handle.timeline.subscribe((event) => {
    for (const card of findCards(event)) {
      runs.put(card.id, {
        description: typeof card.data["description"] === "string" ? card.data["description"] : undefined,
        running: card.data["state"] === "running",
      });
    }
    publish();
  });
  void (subscription as unknown as { ready?: Promise<unknown> }).ready?.catch(() => undefined);
}