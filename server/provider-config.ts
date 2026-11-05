import type {
  ProviderCatalog,
  ProviderConfigState,
  ProviderEvent,
} from "@getpaseo/plugin/server/provider";
import type { BridgeCatalog, ModelSelection } from "../shared/bridge-protocol.js";
import {
  PERMISSION_PRESET_SETTING,
  PLAN_MODE_SETTING,
  type SessionState,
} from "./provider-support.js";

export const catalogs = new WeakMap<BridgeCatalog, ProviderCatalog>();

/** Paseo view of a bridge catalog; a bridge's catalog never changes, so it is built once. */
export function catalog(source: BridgeCatalog): ProviderCatalog {
  let mapped = catalogs.get(source);
  if (!mapped) catalogs.set(source, (mapped = buildCatalog(source)));
  return mapped;
}

export function buildCatalog(source: BridgeCatalog): ProviderCatalog {
  const nameCounts = new Map<string, number>();
  for (const model of source.models) nameCounts.set(model.name, (nameCounts.get(model.name) ?? 0) + 1);
  return {
    models: source.models.map((model) => ({
      id: model.id,
      // The provider goes in the description; the label names it only to tell same-named models apart.
      label: nameCounts.get(model.name)! > 1 ? `${model.name} (${model.providerName})` : model.name,
      description: model.providerName,
      metadata: { provider: model.provider, model: model.model },
      thinkingOptions: model.reasoningEfforts?.map((effort) => ({
        id: effort.id,
        label: effort.name,
        description: effort.description,
        isDefault: effort.id === source.defaultModel?.reasoningEffort,
      })),
      defaultThinkingOptionId:
        model.provider === source.defaultModel?.provider && model.model === source.defaultModel.model
          ? source.defaultModel.reasoningEffort
          : undefined,
    })),
    modes: source.presets.map((preset) => ({
      id: preset.id,
      label: preset.name ?? preset.id,
      description: preset.description,
    })),
    defaultModel: source.models.find(
      (model) =>
        source.defaultModel &&
        model.provider === source.defaultModel.provider &&
        model.model === source.defaultModel.model,
    )?.id,
    defaultMode: source.defaultPreset,
  };
}

export function configState(session: SessionState, source: BridgeCatalog): ProviderConfigState {
  const available = catalog(source);
  const thinking = session.open.model?.reasoningEffort ?? session.config.thinkingOption;
  const selectedModelId = modelId(source, session.open.model) ?? session.config.model;
  return {
    model: selectedModelId,
    mode: session.open.preset ?? session.config.mode,
    thinkingOption: thinking,
    models: available.models,
    modes: available.modes,
    thinkingOptions:
      source.models
        .find((model) => model.id === selectedModelId)
        ?.reasoningEfforts?.map((effort) => ({
          id: effort.id,
          label: effort.name,
          description: effort.description,
          isDefault: effort.id === thinking,
        })) ?? [],
    settings: [
      ...(source.permissionPresets?.length
        ? [
            {
              type: "select" as const,
              id: PERMISSION_PRESET_SETTING,
              label: "Permissions",
              description: "DSH permission and sandbox preset for this session",
              value: session.open.permissionPreset ?? source.defaultPermissionPreset ?? null,
              options: source.permissionPresets.map((preset) => ({
                label: preset.name,
                value: preset.id,
              })),
            },
          ]
        : []),
      ...(hasPlanCommand(session)
        ? [
            {
              type: "toggle" as const,
              id: PLAN_MODE_SETTING,
              label: "Plan mode",
              description: "DSH plan mode: explore and propose a plan before editing",
              value: session.planMode,
            },
          ]
        : []),
    ],
  };
}

export function modelId(source: BridgeCatalog, selection?: ModelSelection): string | undefined {
  return source.models.find(
    (model) =>
      selection &&
      model.provider === selection.provider &&
      model.model === selection.model,
  )?.id;
}

export function validateSettings(settings: Readonly<Record<string, unknown>>): void {
  const unsupported = Object.keys(settings).filter(
    (key) => key !== PERMISSION_PRESET_SETTING && key !== PLAN_MODE_SETTING,
  );
  if (unsupported.length > 0) {
    throw new Error(`DSH does not support session settings: ${unsupported.join(", ")}`);
  }
  const value = settings[PERMISSION_PRESET_SETTING];
  if (value !== undefined && typeof value !== "string") {
    throw new Error("DSH permissionPreset must be a string");
  }
  const plan = settings[PLAN_MODE_SETTING];
  if (plan !== undefined && typeof plan !== "boolean") {
    throw new Error("DSH planMode must be a boolean");
  }
}

export function selectedPermissionPreset(
  settings: Readonly<Record<string, unknown>>,
  source: BridgeCatalog,
): string | undefined {
  const value = settings[PERMISSION_PRESET_SETTING];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("DSH permissionPreset must be a string");
  if (!source.permissionPresets?.some((preset) => preset.id === value)) {
    throw new Error(`Unknown DSH permission preset: ${value}`);
  }
  return value;
}

export function selectModel(
  source: BridgeCatalog,
  modelId?: string,
  reasoningEffort?: string,
): ModelSelection | undefined {
  const model = source.models.find((candidate) => candidate.id === modelId);
  const base = model
    ? { provider: model.provider, model: model.model }
    : source.defaultModel;
  return base ? { ...base, ...(reasoningEffort ? { reasoningEffort } : {}) } : undefined;
}

export function emitConfig(session: SessionState, emit: (event: ProviderEvent) => void): void {
  emit({
    type: "session.config",
    sessionId: session.paseoId,
    config: configState(session, session.bridge.initialized.catalog),
  });
}

export function hasPlanCommand(session: SessionState): boolean {
  return session.commands.some((command) => command.name === "plan" && command.kind === "command");
}

export function latestPlanMode(events: readonly { type: string; data: Record<string, unknown> }[]): boolean {
  const last = events.findLast((event) => event.type === "plan/mode");
  return last?.data.active === true;
}

/** Toggle plan mode through DSH's own `/plan` command, which records `plan/mode`. */
export async function setPlanMode(session: SessionState, active: boolean): Promise<void> {
  const result = await session.bridge.request("session.command", {
    sessionId: session.nativeId,
    name: "plan",
    arguments: active ? "" : "off",
  });
  if (result.kind === "error") throw new Error(result.text ?? "DSH /plan failed");
  // Entry can be queued until the next step; reflect the requested state now.
  session.planMode = active;
}
