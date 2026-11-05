import { isAbsolute } from "node:path";
import type {
  DshSessionEvent,
  ModelSelection,
  PromptPart,
  QuestionAnswer,
  QuestionItem,
  SessionOpenParams,
} from "../../shared/bridge-protocol.js";

export function nonempty(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${field} must be a nonempty string`);
  return value;
}
export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function selection(input: unknown): ModelSelection | undefined {
  const value = record(input);
  if (
    typeof value.provider !== "string" ||
    !value.provider ||
    typeof value.model !== "string" ||
    !value.model
  )
    return;
  return {
    provider: value.provider,
    model: value.model,
    ...(typeof value.reasoningEffort === "string"
      ? { reasoningEffort: value.reasoningEffort }
      : {}),
  };
}
/** Restore the durable pending selection, falling back to the last request route. */
export function savedModel(
  events: DshSessionEvent[],
): ModelSelection | undefined {
  let pending: ModelSelection | undefined;
  let used: ModelSelection | undefined;
  for (const event of events) {
    if (event.type === "model/selection")
      pending = selection(event.data) ?? pending;
    if (event.type !== "request/header") continue;
    const header = record(event.data.header);
    const raw = selection(header.config);
    if (raw) {
      used =
        record(header.adapterDefaults).reasoningEffort === true
          ? { provider: raw.provider, model: raw.model }
          : raw;
      if (pending && JSON.stringify(raw) === JSON.stringify(pending))
        pending = undefined;
    }
  }
  return pending ?? used;
}

export function validateAnswers(
  questions: QuestionItem[],
  answers: unknown,
): asserts answers is QuestionAnswer[] {
  if (!Array.isArray(answers) || answers.length !== questions.length)
    throw new Error("Every question requires one answer");
  const seen = new Set<string>();
  for (const candidate of answers) {
    const answer = record(candidate);
    const question = questions.find((item) => item.id === answer.id);
    if (
      !question ||
      typeof answer.id !== "string" ||
      seen.has(answer.id) ||
      !Array.isArray(answer.selected) ||
      answer.selected.some(
        (label: unknown) =>
          typeof label !== "string" ||
          !question.options?.some((option) => option.label === label),
      ) ||
      new Set(answer.selected).size !== answer.selected.length ||
      (!question.multiSelect && answer.selected.length > 1) ||
      (answer.custom !== undefined && typeof answer.custom !== "string") ||
      (!answer.selected.length &&
        !(typeof answer.custom === "string" && answer.custom.trim()))
    )
      throw new Error("Invalid question answer");
    seen.add(answer.id);
  }
}

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export function validateContent(value: unknown): PromptPart[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error("content must be a nonempty array");
  const parts = value.map((raw): PromptPart => {
    const part = record(raw);
    if (part.type === "text" && typeof part.text === "string")
      return { type: "text", text: part.text };
    if (part.type === "image") {
      if (typeof part.mediaType !== "string" || !IMAGE_TYPES.has(part.mediaType))
        throw new Error(`Unsupported image type: ${String(part.mediaType)}`);
      return {
        type: "image",
        mediaType: part.mediaType,
        data: nonempty(part.data, "image data"),
        ...(typeof part.name === "string" ? { name: part.name } : {}),
      };
    }
    if (part.type === "file") {
      const path = nonempty(part.path, "file path");
      if (!isAbsolute(path)) throw new Error("file path must be absolute");
      return {
        type: "file",
        path,
        ...(typeof part.name === "string" ? { name: part.name } : {}),
      };
    }
    throw new Error("Invalid prompt content");
  });
  if (!parts.some((part) => part.type !== "text" || part.text.trim()))
    throw new Error("Prompt content is empty");
  return parts;
}

export function listParams(params: Record<string, unknown>): {
  cwd?: string;
  query?: string;
  limit?: number;
} {
  const result: { cwd?: string; query?: string; limit?: number } = {};
  if (params.cwd !== undefined) result.cwd = nonempty(params.cwd, "cwd");
  if (params.query !== undefined) {
    if (typeof params.query !== "string")
      throw new Error("query must be a string");
    const query = params.query.trim();
    if (query) result.query = query;
  }
  if (params.limit !== undefined) {
    if (
      typeof params.limit !== "number" ||
      !Number.isSafeInteger(params.limit) ||
      params.limit < 1
    )
      throw new Error("limit must be a positive integer");
    result.limit = params.limit;
  }
  return result;
}

export function validateOpen(params: Record<string, unknown>): SessionOpenParams {
  const result: SessionOpenParams = { cwd: nonempty(params.cwd, "cwd") };
  if (params.sessionId !== undefined)
    result.sessionId = nonempty(params.sessionId, "sessionId");
  if (params.preset !== undefined)
    result.preset = nonempty(params.preset, "preset");
  if (params.permissionPreset !== undefined)
    result.permissionPreset = nonempty(
      params.permissionPreset,
      "permissionPreset",
    );
  if (params.resume !== undefined) {
    if (typeof params.resume !== "boolean")
      throw new Error("resume must be boolean");
    result.resume = params.resume;
  }
  if (params.model !== undefined) {
    result.model = validateModel(params.model);
  }
  if (params.systemPrompt !== undefined)
    result.systemPrompt = nonempty(params.systemPrompt, "systemPrompt");
  if (params.preapprovedTools !== undefined) {
    if (
      !Array.isArray(params.preapprovedTools) ||
      params.preapprovedTools.some((tool) => typeof tool !== "string" || !tool)
    )
      throw new Error("preapprovedTools must be an array of tool names");
    result.preapprovedTools = params.preapprovedTools as string[];
  }
  return result;
}
export function validateModel(value: unknown): ModelSelection {
  const model = selection(value);
  const effort = record(value).reasoningEffort;
  if (
    !model ||
    (effort !== undefined && (typeof effort !== "string" || !effort))
  )
    throw new Error("Invalid model selection");
  return model;
}

