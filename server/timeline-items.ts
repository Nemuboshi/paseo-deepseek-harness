import type {
  ProviderEvent,
  ProviderTimelineItem,
} from "@getpaseo/plugin/server/provider";
import { attachmentLabel } from "./prompt-content.js";
import { arrayValue, numberValue, objectValue, stringValue } from "./values.js";

export type SessionEvent = Extract<ProviderEvent, { sessionId: string }>;

export function stepKey(turn: number, step: number): string {
  return `${turn}:${step}`;
}

export function assistantItemId(
  type: string,
  turn: number,
  step: number,
  ordinal: number,
  index: number,
): string {
  return `${type}:turn:${turn}:step:${step}:attempt:${ordinal}:${index}`;
}

export function transientItemId(type: string, attemptId: string, index: number): string {
  return `${type}:transient:${attemptId}:${index}`;
}

export function timeline(
  sessionId: string,
  item: ProviderTimelineItem,
  timestamp?: string,
): SessionEvent {
  return { type: "timeline.item", sessionId, item, ...(timestamp ? { timestamp } : {}) };
}

export function userContentText(value: unknown): string {
  if (typeof value === "string") return value;
  return arrayValue(value)
    .map((raw) => {
      const block = objectValue(raw);
      if (block?.type === "text") return stringValue(block.text) ?? "";
      if (block?.type === "image") return attachmentLabel("image");
      if (block?.type === "file") return attachmentLabel("file", stringValue(objectValue(block.attachment)?.name));
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  return arrayValue(value)
    .map((raw) => {
      const block = objectValue(raw);
      if (!block) return "";
      if (typeof block.text === "string") return block.text;
      if (typeof block.content === "string") return block.content;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function stringifyValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

export function toTimestamp(value: unknown): string | undefined {
  const milliseconds = numberValue(value);
  if (milliseconds === undefined) return undefined;
  const date = new Date(milliseconds < 10_000_000_000 ? milliseconds * 1_000 : milliseconds);
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}
