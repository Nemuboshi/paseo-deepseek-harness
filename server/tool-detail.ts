import type { ProviderToolCallDetail } from "@getpaseo/plugin/server/provider";
import type { JsonObject } from "../shared/bridge-protocol.js";
import { stringifyValue } from "./timeline-items.js";
import { arrayValue, numberValue, objectValue, stringValue } from "./values.js";

export function toolDetail(name: string, args: JsonObject): ProviderToolCallDetail {
  const normalized = name.toLowerCase();

  // DSH's built-in tools are matched by exact name. Substring patterns get the
  // common ones wrong (`todo_write` is not a file write, `read_image` is not a
  // text read), and they would also claim unrelated MCP tools.
  if (normalized === "bash" || normalized === "pwsh") {
    // An empty command during streaming keeps the card from showing the raw
    // half-parsed JSON; the final frame fills it in.
    return {
      type: "shell",
      command: stringValue(args.command) ?? "",
      cwd: stringValue(args.workdir),
    };
  }
  if (normalized === "read" || normalized === "read_image") {
    return {
      type: "read",
      filePath: stringValue(args.file_path) ?? "",
      offset: numberValue(args.offset),
      limit: numberValue(args.limit),
    };
  }
  if (normalized === "write") {
    return {
      type: "write",
      filePath: stringValue(args.file_path) ?? "",
      content: stringValue(args.content),
    };
  }
  if (normalized === "edit") {
    return {
      type: "edit",
      filePath: stringValue(args.file_path) ?? "",
      oldString: stringValue(args.old_string),
      newString: stringValue(args.new_string),
    };
  }
  if (normalized === "grep") {
    return { type: "search", query: stringValue(args.pattern) ?? "", toolName: "grep" };
  }
  if (normalized === "glob") {
    return { type: "search", query: stringValue(args.pattern) ?? "", toolName: "glob" };
  }
  if (normalized === "web_fetch") {
    return { type: "fetch", url: stringValue(args.url) ?? "" };
  }
  // Both the native schema and PTC's dispatch call it with the plan markdown.
  if (normalized === "exit_plan_mode") {
    return { type: "plan", text: stringValue(args.plan) ?? "" };
  }

  // DSH's subagent, job, goal and presentation tools have no dedicated Paseo
  // card; a plain-text card still shows their arguments and output, where the
  // generic detail would dump the whole argument object as JSON.
  if (normalized === "subagent") {
    return plainText(stringValue(args.description) ?? "Subagent", stringValue(args.prompt), "bot");
  }
  if (normalized === "list_agents") return plainText("List subagents", undefined, "bot");
  if (normalized === "send_message") {
    return plainText(`Message ${stringValue(args.agent_id) ?? "subagent"}`, stringValue(args.message), "bot");
  }
  if (normalized === "interrupt_agent") {
    return plainText("Interrupt subagent", stringValue(args.agent_id), "bot");
  }
  if (normalized === "skill") {
    return plainText(`Skill ${stringValue(args.name) ?? ""}`.trim(), undefined, "sparkles");
  }
  if (normalized === "todo_write") return plainText("Update todos", todoChecklist(args.todos), "pencil");
  if (normalized === "job_output") {
    return plainText(`Job ${stringValue(args.job_id) ?? ""}`.trim(), undefined, "square_terminal");
  }
  if (normalized === "job_list") return plainText("List jobs", undefined, "square_terminal");
  if (normalized === "working_directory") return plainText("Working directory", undefined, "square_terminal");
  if (normalized === "present") {
    const files = presentedFiles(args.files);
    return plainText(
      `Present ${files.length} file${files.length === 1 ? "" : "s"}`,
      files.map((file) => `${file.path}${file.description ? ` — ${file.description}` : ""}`).join("\n") || undefined,
      "eye",
    );
  }
  if (normalized === "create_goal") return plainText("Create goal", stringValue(args.objective), "sparkles");
  if (normalized === "update_goal") {
    const action = stringValue(args.action);
    return plainText(`Update goal${action ? ` (${action})` : ""}`, stringValue(args.objective), "sparkles");
  }
  if (normalized === "get_goal") return plainText("Read goal", undefined, "sparkles");

  // Everything else, including MCP tools, keeps a generic detail carrying the
  // raw arguments. Guessing a card type from the name would render MCP tools as
  // file operations.
  return { type: "unknown", input: { raw: stringifyValue(args) }, output: {} };
}

export function withOutput(detail: ProviderToolCallDetail, output: string): ProviderToolCallDetail {
  switch (detail.type) {
    case "shell":
      return { ...detail, output };
    case "read":
      return { ...detail, content: output };
    case "search":
      return { ...detail, content: output };
    case "fetch":
      return { ...detail, result: output };
    case "plain_text": {
      // Keep the arguments the card was built from; the output is appended.
      const text = [detail.text, output].filter(Boolean).join("\n\n");
      return text ? { ...detail, text } : detail;
    }
    case "unknown":
      return { ...detail, output };
    default:
      return detail;
  }
}

export function parseArguments(value: unknown): JsonObject {
  if (objectValue(value)) return objectValue(value)!;
  if (typeof value !== "string") return {};
  try {
    return objectValue(JSON.parse(value)) ?? { value };
  } catch {
    return { value };
  }
}

type PlainTextIcon = Extract<ProviderToolCallDetail, { type: "plain_text" }>["icon"];

/** A tool with no dedicated Paseo card: one readable line plus its content. */
function plainText(label: string, text: string | undefined, icon: PlainTextIcon): ProviderToolCallDetail {
  return { type: "plain_text", label, ...(text ? { text } : {}), icon };
}

const TODO_STATUSES = ["pending", "in_progress", "completed"] as const;

export function todoStatus(value: unknown): (typeof TODO_STATUSES)[number] | undefined {
  const status = stringValue(value);
  return TODO_STATUSES.find((candidate) => candidate === status);
}

function todoChecklist(value: unknown): string | undefined {
  const lines = arrayValue(value).map(objectValue).flatMap((todo) => {
    const text = stringValue(todo?.content) ?? stringValue(todo?.text);
    if (!text) return [];
    const status = todoStatus(todo?.status);
    return [`${status === "completed" ? "[x]" : status === "in_progress" ? "[~]" : "[ ]"} ${text}`];
  });
  return lines.length > 0 ? lines.join("\n") : undefined;
}

function presentedFiles(value: unknown): Array<{ path: string; description?: string }> {
  return arrayValue(value).map(objectValue).flatMap((file) => {
    const path = stringValue(file?.path);
    if (!path) return [];
    const description = stringValue(file?.description);
    return [{ path, ...(description ? { description } : {}) }];
  });
}

/** User message text with markers for image and file blocks. */
