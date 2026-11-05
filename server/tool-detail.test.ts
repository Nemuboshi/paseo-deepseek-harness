import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProviderToolCallDetail } from "@getpaseo/plugin/server/provider";
import { toolDetail, withOutput } from "./tool-detail.js";

const detail = (name: string, args: Record<string, unknown>) => toolDetail(name, args);

function labelOf(value: ProviderToolCallDetail): string {
  return value.type === "plain_text" ? value.label ?? "" : assert.fail(`expected a plain-text card, got ${value.type}`);
}

function textOf(value: ProviderToolCallDetail): string {
  return value.type === "plain_text" ? value.text ?? "" : assert.fail(`expected a plain-text card, got ${value.type}`);
}

describe("toolDetail", () => {
  it("maps the dsh file, shell and search arguments", () => {
    assert.deepEqual(detail("bash", { command: "pwd", workdir: "/tmp" }), {
      type: "shell",
      command: "pwd",
      cwd: "/tmp",
    });
    assert.equal(detail("pwsh", { command: "Get-Location" }).type, "shell");
    assert.equal(detail("read", { file_path: "/a.ts", offset: 3, limit: 10 }).type, "read");
    assert.equal(detail("read_image", { file_path: "/a.png" }).type, "read");
    assert.equal(detail("write", { file_path: "/b.txt" }).type, "write");
    assert.equal(detail("edit", { file_path: "/c.txt", old_string: "a", new_string: "b" }).type, "edit");
    assert.equal(detail("grep", { pattern: "needle" }).type, "search");
    assert.equal(detail("glob", { pattern: "**/*.ts" }).type, "search");
    assert.equal(detail("web_fetch", { url: "https://example.com" }).type, "fetch");
  });

  it("matches names exactly, never by part of a name", () => {
    // A substring match on "write" used to render this as a file write.
    assert.equal(detail("mcp__notes__write_note", { content: "hello" }).type, "unknown");
    assert.equal(detail("todo_write", { todos: [] }).type, "plain_text");
    assert.equal(detail("read_image", { file_path: "/a.png" }).type, "read");
  });

  it("maps both plan exits to the plan card", () => {
    assert.deepEqual(detail("exit_plan_mode", { plan: "# Plan" }), { type: "plan", text: "# Plan" });
    assert.deepEqual(detail("EXIT_PLAN_MODE", { plan: "# Plan" }), { type: "plan", text: "# Plan" });
  });

  it("gives the subagent tools a readable line", () => {
    assert.deepEqual(detail("subagent", { description: "check layout", prompt: "read only" }), {
      type: "plain_text",
      label: "check layout",
      text: "read only",
      icon: "bot",
    });
    assert.equal(labelOf(detail("send_message", { agent_id: "a1", message: "report" })), "Message a1");
    assert.equal(labelOf(detail("interrupt_agent", { agent_id: "a1" })), "Interrupt subagent");
    assert.equal(labelOf(detail("list_agents", {})), "List subagents");
  });

  it("gives the job tools a readable line", () => {
    const job = detail("job_output", { job_id: "pwsh-1" });
    assert.equal(labelOf(job), "Job pwsh-1");
    assert.equal(labelOf(detail("job_list", {})), "List jobs");
  });

  it("gives the goal tools a readable line", () => {
    const created = detail("create_goal", { objective: "ship" });
    assert.deepEqual(created, { type: "plain_text", label: "Create goal", text: "ship", icon: "sparkles" });
    const updated = detail("update_goal", { goal_id: "g1", action: "edit", objective: "ship it" });
    assert.equal(labelOf(updated), "Update goal (edit)");
    assert.equal(labelOf(detail("get_goal", {})), "Read goal");
  });

  it("lists presented files and the todo checklist", () => {
    const present = detail("present", {
      files: [{ path: "dist/app.exe", description: "installer" }, { path: "out/baseline.md" }],
    });
    assert.equal(labelOf(present), "Present 2 files");
    assert.equal(
      textOf(present),
      "dist/app.exe — installer\nout/baseline.md",
    );

    const todos = detail("todo_write", {
      todos: [
        { content: "one", status: "completed" },
        { content: "two", status: "in_progress" },
        { content: "three", status: "pending" },
      ],
    });
    assert.equal(textOf(todos), "[x] one\n[~] two\n[ ] three");
  });

  it("formats a single-file present in the singular", () => {
    const present = detail("present", { files: [{ path: "a.exe" }] });
    assert.equal(labelOf(present), "Present 1 file");
  });

  it("keeps unknown tools generic with their raw arguments", () => {
    const unknown = detail("mcp__other__do", { a: 1 });
    assert.equal(unknown.type, "unknown");
    if (unknown.type === "unknown") assert.deepEqual(unknown.input, { raw: '{"a":1}' });
  });
});

describe("withOutput", () => {
  it("fills the field each card type shows", () => {
    const shell = withOutput({ type: "shell", command: "pwd" }, "/repo");
    assert.equal(shell.type === "shell" && shell.output, "/repo");
    const read = withOutput({ type: "read", filePath: "/a.ts" }, "line 1");
    assert.equal(read.type === "read" && read.content, "line 1");
    const search = withOutput({ type: "search", query: "x" }, "match");
    assert.equal(search.type === "search" && search.content, "match");
    const fetch = withOutput({ type: "fetch", url: "https://e.com" }, "body");
    assert.equal(fetch.type === "fetch" && fetch.result, "body");
    const unknown = withOutput({ type: "unknown", input: {}, output: {} }, "raw");
    assert.deepEqual(unknown.type === "unknown" && unknown.output, "raw");
  });

  it("appends the output to a plain-text card instead of replacing its text", () => {
    const kept = withOutput({ type: "plain_text", label: "check layout", text: "read only" }, "started s1");
    assert.equal(kept.type === "plain_text" && kept.text, "read only\n\nstarted s1");
    const empty = withOutput({ type: "plain_text", label: "List jobs" }, "");
    assert.deepEqual(empty, { type: "plain_text", label: "List jobs" });
  });

  it("leaves a plan card as it is", () => {
    const plan = withOutput({ type: "plan", text: "# Plan" }, "approved");
    assert.deepEqual(plan, { type: "plan", text: "# Plan" });
  });
});