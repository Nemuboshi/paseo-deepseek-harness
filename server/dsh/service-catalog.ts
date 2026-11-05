import type { BridgeCatalog } from "../../shared/bridge-protocol.js";
import type { HostContext } from "./host.js";
import { selection } from "./service-params.js";

/** Model, preset and permission catalog for the bridge handshake. */
export async function readCatalog(ctx: HostContext): Promise<BridgeCatalog> {
    const llm = ctx.get("llm");
    const presets = ctx.get("agentPresets");
    const permission = ctx.get("permissionPresets");
    const models: BridgeCatalog["models"] = [];
    const defaultModel = selection(
      ctx.get("agentDefaultModel")?.currentSelection(),
    );
    for (const provider of llm.listProviders()) {
      try {
        for (const model of await llm.listModels(provider.id)) {
          let reasoningEfforts: BridgeCatalog["models"][number]["reasoningEfforts"];
          try {
            reasoningEfforts = (
              await llm.resolveModelInfo?.(provider.id, model.id)
            )?.reasoning?.efforts;
          } catch {
            /* Optional capability discovery may be unavailable for this route. */
          }
          models.push({
            id: `${provider.id}/${model.id}`,
            provider: provider.id,
            model: model.id,
            name: model.name ?? model.id,
            providerName: provider.name ?? provider.id,
            reasoningEfforts,
          });
        }
      } catch {
        /* One unconfigured provider must not hide the other configured routes. */
      }
    }
    if (
      defaultModel &&
      !models.some(
        (model) =>
          model.provider === defaultModel.provider &&
          model.model === defaultModel.model,
      )
    ) {
      models.push({
        id: `${defaultModel.provider}/${defaultModel.model}`,
        ...defaultModel,
        name: defaultModel.model,
        providerName: defaultModel.provider,
      });
    }
    return {
      models,
      presets: (await presets.list())
        .filter((preset) => !preset.broken)
        .map((preset) => ({
          id: preset.id,
          name: preset.name,
          description: preset.description,
        })),
      defaultModel,
      defaultPreset: presets.defaultId,
      ...(permission && ctx.get("commands")
        ? {
            permissionPresets: permission.names.map((id) => {
              const option = permission.optionOf(id);
              return {
                id,
                name: option.name,
                ...(option.description
                  ? { description: option.description }
                  : {}),
              };
            }),
            defaultPermissionPreset: permission.defaultPreset,
          }
        : {}),
    };
  }
